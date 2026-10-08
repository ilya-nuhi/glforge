/**
 * Compressed export, run in a worker.
 *
 * Everything else in the app edits the glTF JSON and leaves the binary alone;
 * this is the one place that decodes and re-encodes. glTF-Transform reads the
 * file as a plain download would write it, the geometry and texture encoders
 * run over that, and a fresh file comes back: a .glb, a .zip holding a .gltf
 * and its files, or one .gltf with everything inline. There is one worker per
 * export, so cancelling is a terminate() and the encoders' wasm memory goes
 * with it.
 */

import {
  Format,
  GLB_BUFFER,
  ImageUtils,
  PropertyType,
  WebIO,
  type Document,
  type GLTF,
  type ILogger,
  type JSONDocument,
  type Texture,
} from '@gltf-transform/core';
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  EXTTextureWebP,
  KHRDracoMeshCompression,
  KHRTextureBasisu,
} from '@gltf-transform/extensions';
import {
  dedup,
  dequantize,
  draco,
  getTextureColorSpace,
  listTextureSlots,
  prune,
  quantize,
  reorder,
  unpartition,
} from '@gltf-transform/functions';
import { precisionPercent, quantizationBits, type Precision } from './precision';

export type GeometryMode = 'keep' | 'draco' | 'meshopt' | 'none';
export type TextureMode = 'keep' | 'webp' | 'jpeg' | 'etc1s' | 'uastc';
/** What the worker writes: one .glb, a .gltf zipped with its files, or one self-contained .gltf. */
export type OutputFormat = 'glb' | 'gltf-zip' | 'gltf-embedded';

export interface CompressSettings {
  /** The file that comes out; `keep` is the opened file's own kind. */
  format: 'keep' | OutputFormat;
  geometry: GeometryMode;
  /** Quantization grid for Draco and meshopt alike; Original is lossless. */
  precision: Precision;
  /** 1–100: Custom's place on the precision scale. */
  customPrecision: number;
  meshoptLevel: 'medium' | 'high';
  /**
   * Meshopt only: quantize positions as well. Smaller, but a quantized mesh
   * needs a scale and offset on the node drawing it to come back to size.
   */
  quantizePositions: boolean;
  textures: TextureMode;
  /** 1–100, for WebP and JPEG. */
  imageQuality: number;
  /** 1–255, ETC1S's quality level. */
  etc1sQuality: number;
  /** 0–4, UASTC's quality level. */
  uastcLevel: number;
  /** UASTC: rate-distortion optimisation, which lets zstd squeeze it much further. */
  uastcRdo: boolean;
  /** ETC1S: encode normal maps as UASTC instead, since ETC1S mangles them. */
  uastcNormals: boolean;
  /** The longest side a texture is scaled down to; 0 leaves sizes alone. */
  maxSize: number;
  /** Drop meshes, materials, textures and skins nothing in the file uses. */
  prune: boolean;
}

export interface CompressSource {
  json: object;
  /** A .glb's binary chunk: what a buffer without a URI refers to. */
  bin: Uint8Array<ArrayBuffer> | null;
  /** Every external buffer and image, keyed by the URI the JSON spells it with. */
  resources: Record<string, Uint8Array<ArrayBuffer>>;
}

export interface CompressRequest {
  source: CompressSource;
  settings: CompressSettings;
  /** `settings.format` resolved against the opened file. */
  output: OutputFormat;
  /** What the .gltf and its .bin are called, inside a .zip or not. */
  basename: string;
}

export interface CompressReport {
  /** What happened to the geometry, in words. */
  geometry: string;
  /** Textures re-encoded or resized. */
  textures: number;
  /** Textures left as they were, and why. */
  skipped: { name: string; reason: string }[];
  warnings: string[];
}

export type CompressReply =
  | { type: 'progress'; text: string }
  | { type: 'done'; bytes: Uint8Array; report: CompressReport }
  | { type: 'error'; message: string };

const DRACO = KHRDracoMeshCompression.EXTENSION_NAME;
const MESHOPT = EXTMeshoptCompression.EXTENSION_NAME;

/**
 * The attributes a precision applies to. Joint indices, and any custom
 * attribute an app may use for integer IDs, stay exactly as they are.
 */
const LOSSY_ATTRIBUTES = /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+|WEIGHTS_\d+)$/;

/** Image formats a worker can decode, through createImageBitmap. */
const DECODABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);

/** Basis Universal's cap on source texels, which keeps its 32-bit wasm heap from running out. */
const KTX2_MAX_TEXELS = 12 * 1024 * 1024;

/** Pixels exactly as stored: no premultiplying, no colour management. */
const BITMAP_OPTIONS: ImageBitmapOptions = {
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
};

self.addEventListener('message', (event: MessageEvent<CompressRequest>) => {
  compress(event.data).then(
    ({ bytes, report }) => reply({ type: 'done', bytes, report }, [bytes.buffer]),
    (error: unknown) => reply({ type: 'error', message: messageOf(error) }),
  );
});

function reply(message: CompressReply, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

function progress(text: string): void {
  reply({ type: 'progress', text });
}

/** glTF-Transform's warnings, kept for the report rather than lost in the console. */
class CollectingLogger implements ILogger {
  readonly warnings: string[] = [];
  debug(): void {}
  info(): void {}
  warn(text: string): void {
    this.warnings.push(text);
  }
  error(text: string): void {
    this.warnings.push(text);
  }
}

async function compress({
  source,
  settings,
  output,
  basename,
}: CompressRequest): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const logger = new CollectingLogger();
  const io = new WebIO().setLogger(logger).registerExtensions(ALL_EXTENSIONS);
  const jsonDoc: JSONDocument = {
    json: source.json as GLTF.IGLTF,
    resources: { ...source.resources },
  };
  if (source.bin) jsonDoc.resources[GLB_BUFFER] = source.bin;

  // Reading a compressed file needs its decoder, and whatever compression the
  // result carries is encoded as it is written — so both ends are known now.
  const used = new Set(jsonDoc.json.extensionsUsed ?? []);
  const keep = settings.geometry === 'keep';
  progress('Loading encoders…');
  const codecs = await loadCodecs({
    dracoDecoder: used.has(DRACO),
    dracoEncoder: settings.geometry === 'draco' || (keep && used.has(DRACO)),
    meshoptDecoder: used.has(MESHOPT),
    meshoptEncoder: settings.geometry === 'meshopt' || (keep && used.has(MESHOPT)),
  });
  io.registerDependencies(codecs);

  progress('Reading the file…');
  const doc = await io.readJSON(jsonDoc);
  const report: CompressReport = { geometry: '', textures: 0, skipped: [], warnings: [] };

  // Loose ends first, so no encoder spends time on what is about to be dropped.
  // Nodes are never pruned — an empty one may well be an anchor on purpose —
  // and materials that differ only in name are two materials.
  if (settings.prune) {
    progress('Dropping unused data…');
    await doc.transform(
      prune({
        propertyTypes: [
          PropertyType.MESH,
          PropertyType.MATERIAL,
          PropertyType.TEXTURE,
          PropertyType.SKIN,
          PropertyType.ACCESSOR,
        ],
        keepLeaves: true,
        keepAttributes: true,
        keepIndices: true,
        keepSolidTextures: true,
        keepExtras: true,
      }),
      dedup({
        propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE, PropertyType.MATERIAL],
        keepUniqueNames: true,
      }),
    );
  }

  await compressTextures(doc, settings, report);
  report.geometry = await compressGeometry(doc, settings, used, codecs['meshopt.encoder']);

  // Quantizing leaves the accessors it replaced behind, and deletes in the app
  // leave geometry nothing points at: neither belongs in the output. A .glb
  // holds one buffer, so a .gltf split over several .bin files is merged.
  await doc.transform(
    prune({
      propertyTypes: [PropertyType.ACCESSOR],
      keepAttributes: true,
      keepIndices: true,
      keepLeaves: true,
    }),
    unpartition(),
  );
  if (doc.getRoot().listBuffers().length === 0) doc.createBuffer();

  progress(report.geometry.startsWith('Draco') ? 'Encoding Draco and writing…' : 'Writing…');
  const bytes = await writeOutput(io, doc, output, basename);
  report.warnings.push(...new Set(logger.warnings));
  return { bytes, report };
}

// ---------------------------------------------------------------------------
// Writing

async function writeOutput(
  io: WebIO,
  doc: Document,
  output: OutputFormat,
  basename: string,
): Promise<Uint8Array> {
  if (output === 'glb') return io.writeBinary(doc);

  nameFiles(doc, basename);
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLTF, basename });
  const encoder = new TextEncoder();

  if (output === 'gltf-embedded') {
    for (const buffer of json.buffers ?? []) {
      const data = buffer.uri === undefined ? undefined : resources[buffer.uri];
      if (data) buffer.uri = `data:application/octet-stream;base64,${toBase64(data)}`;
    }
    for (const image of json.images ?? []) {
      const { uri } = image;
      const data = uri === undefined ? undefined : resources[uri];
      if (!data || uri === undefined) continue;
      const mimeType = image.mimeType ?? ImageUtils.extensionToMimeType(uri.split('.').pop() ?? '');
      image.uri = `data:${mimeType};base64,${toBase64(data)}`;
    }
    return encoder.encode(JSON.stringify(json));
  }

  // Textures are compressed already, so they are stored rather than deflated
  // again; the JSON and the .bin still gain from it.
  progress('Zipping…');
  const { zipSync } = await import('fflate');
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    [`${basename}.gltf`]: encoder.encode(JSON.stringify(json, null, 2)),
  };
  for (const [uri, data] of Object.entries(resources)) {
    files[decodePath(uri)] = uri.toLowerCase().endsWith('.bin') ? data : [data, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

/**
 * Gives the .bin and every texture a file name before a .gltf is written.
 * glTF-Transform would call textures after their slot (`baseColor_1.png`);
 * here a texture keeps the path a .gltf gave it, or is named after itself, and
 * its extension follows its format now — a PNG turned KTX2 is a .ktx2.
 */
function nameFiles(doc: Document, basename: string): void {
  const root = doc.getRoot();
  for (const buffer of root.listBuffers()) buffer.setURI(encodePath(`${basename}.bin`));

  const taken = new Set([`${basename}.gltf`, `${basename}.bin`].map((path) => path.toLowerCase()));
  root.listTextures().forEach((texture, index) => {
    const extension = ImageUtils.mimeTypeToExtension(texture.getMimeType()) || 'bin';
    const from = safePath(decodePath(texture.getURI()));
    const stem = from
      ? from.replace(/\.[^./]*$/, '')
      : safeSegment(texture.getName()) || `texture_${index}`;
    let path = `${stem}.${extension}`;
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${stem}_${n}.${extension}`;
    taken.add(path.toLowerCase());
    texture.setURI(encodePath(path));
  });
}

/**
 * A relative path that stays inside the folder it is unpacked into: no empty,
 * `.` or `..` segments, and no characters a file system refuses.
 */
function safePath(path: string): string {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(safeSegment)
    .filter(Boolean)
    .join('/');
}

function safeSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
}

/** A path as a URI: each segment percent-encoded, the slashes kept. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function decodePath(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    // A lone '%' from a hand-edited file: take it literally.
    return uri;
  }
}

function toBase64(bytes: Uint8Array): string {
  // In slices: one String.fromCharCode call over megabytes would overflow the stack.
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Codecs, loaded only when this export needs them

interface CodecNeeds {
  dracoDecoder: boolean;
  dracoEncoder: boolean;
  meshoptDecoder: boolean;
  meshoptEncoder: boolean;
}

async function loadCodecs(need: CodecNeeds): Promise<Record<string, unknown>> {
  const codecs: Record<string, unknown> = {};
  if (need.meshoptDecoder) {
    const { MeshoptDecoder } = await import('meshoptimizer/decoder');
    await MeshoptDecoder.ready;
    codecs['meshopt.decoder'] = MeshoptDecoder;
  }
  if (need.meshoptEncoder) {
    const { MeshoptEncoder } = await import('meshoptimizer/encoder');
    await MeshoptEncoder.ready;
    codecs['meshopt.encoder'] = MeshoptEncoder;
  }
  // The draco3dgltf builds are Emscripten modules that would otherwise go
  // looking for their .wasm on disk; handing them the bytes skips all that.
  if (need.dracoDecoder) {
    const [{ default: create }, { default: wasmUrl }] = await Promise.all([
      import('draco3dgltf/draco_decoder_gltf_nodejs.js'),
      import('draco3dgltf/draco_decoder_gltf.wasm?url'),
    ]);
    codecs['draco3d.decoder'] = await create({ wasmBinary: await fetchBytes(wasmUrl) });
  }
  if (need.dracoEncoder) {
    const [{ default: create }, { default: wasmUrl }] = await Promise.all([
      import('draco3dgltf/draco_encoder_gltf_nodejs.js'),
      import('draco3dgltf/draco_encoder.wasm?url'),
    ]);
    codecs['draco3d.encoder'] = await create({ wasmBinary: await fetchBytes(wasmUrl) });
  }
  return codecs;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  return response.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Geometry

async function compressGeometry(
  doc: Document,
  settings: CompressSettings,
  used: Set<string>,
  meshoptEncoder: unknown,
): Promise<string> {
  const had = used.has(DRACO) ? 'Draco' : used.has(MESHOPT) ? 'meshopt' : null;
  // Null at 100%: nothing is quantized, and the geometry comes out exact.
  const bits = quantizationBits(precisionPercent(settings.precision, settings.customPrecision));

  switch (settings.geometry) {
    case 'keep':
      return had ? `${had}, re-encoded as it was` : 'uncompressed, as it was';

    case 'none':
      disposeExtension(doc, DRACO);
      disposeExtension(doc, MESHOPT);
      return had ? `${had} removed` : 'uncompressed, as it was';

    case 'draco':
      disposeExtension(doc, MESHOPT);
      progress('Preparing meshes for Draco…');
      // Draco only quantizes float attributes. Data an earlier tool already
      // stored as integers — meshopt and gltfpack output, or this panel's own —
      // would go through at the precision it had, whatever the slider says,
      // so it is turned back into floats first. Not at lossless: there Draco
      // keeps those integers exactly, and far smaller than floats.
      if (bits) await doc.transform(dequantize({ pattern: LOSSY_ATTRIBUTES }));
      // Zero bits is Draco's lossless mode: attributes are stored as they are.
      await doc.transform(
        draco({
          method: 'edgebreaker',
          quantizePosition: bits?.position ?? 0,
          quantizeNormal: bits?.normal ?? 0,
          quantizeTexcoord: bits?.texcoord ?? 0,
          quantizeColor: bits?.color ?? 0,
          quantizeGeneric: bits?.generic ?? 0,
        }),
      );
      return bits ? `Draco, ${bits.position}-bit positions` : 'Draco, lossless';

    case 'meshopt': {
      disposeExtension(doc, DRACO);
      progress('Preparing meshes for meshopt…');
      // glTF-Transform's own meshopt() always quantizes positions, which puts a
      // dequantizing transform on every node drawing a mesh (and adds a node
      // under any that has children). The same steps are spelled out here so
      // positions can be left as floats instead, keeping the file's nodes as
      // they are.
      await doc.transform(reorder({ encoder: meshoptEncoder, target: 'size' }));

      // Meshopt's own coding is lossless; only quantizing and Level High's
      // filters lose anything, so Original skips both.
      if (!bits) {
        doc
          .createExtension(EXTMeshoptCompression)
          .setRequired(true)
          .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
        return 'meshopt, lossless';
      }

      const high = settings.meshoptLevel === 'high';
      const skip = settings.quantizePositions ? '' : '(?!POSITION$)';
      const pattern = high
        ? new RegExp(`^${skip}(POSITION|TEXCOORD|JOINTS|WEIGHTS|COLOR)(_\\d+)?$`)
        : new RegExp(`^${skip}.*$`);
      const patternTargets = high
        ? new RegExp(`^${skip}(POSITION|TEXCOORD|JOINTS|WEIGHTS|COLOR|NORMAL|TANGENT)(_\\d+)?$`)
        : pattern;
      await doc.transform(
        quantize({
          pattern,
          patternTargets,
          quantizePosition: bits.position,
          quantizeNormal: high ? Math.min(bits.normal, 8) : bits.normal,
          quantizeTexcoord: bits.texcoord,
          quantizeColor: bits.color,
          quantizeGeneric: bits.generic,
          // The default cleanup would prune materials the user chose to keep.
          cleanup: false,
        }),
      );
      doc
        .createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({
          method: high
            ? EXTMeshoptCompression.EncoderMethod.FILTER
            : EXTMeshoptCompression.EncoderMethod.QUANTIZE,
        });
      return 'meshopt';
    }
  }
}

function disposeExtension(doc: Document, name: string): void {
  for (const extension of doc.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === name) extension.dispose();
  }
}

// ---------------------------------------------------------------------------
// Textures

interface Encoded {
  bytes: Uint8Array;
  mimeType: string;
  note?: string;
}

async function compressTextures(
  doc: Document,
  settings: CompressSettings,
  report: CompressReport,
): Promise<void> {
  if (settings.textures === 'keep' && settings.maxSize === 0) return;

  const textures = doc.getRoot().listTextures();
  for (const [index, texture] of textures.entries()) {
    const name = texture.getName() || texture.getURI() || `Texture ${index}`;
    progress(`Textures ${index + 1}/${textures.length} · ${name}`);

    const image = texture.getImage();
    const mimeType = texture.getMimeType();
    if (!image) {
      report.skipped.push({ name, reason: 'no image data' });
      continue;
    }
    if (!DECODABLE.has(mimeType)) {
      const reason =
        mimeType === 'image/ktx2' ? 'already KTX2' : `${mimeType || 'unknown format'} is not decodable here`;
      report.skipped.push({ name, reason });
      continue;
    }

    try {
      const encoded = await encodeTexture(texture, image, mimeType, settings);
      if (encoded === null) continue;
      if (typeof encoded === 'string') {
        report.skipped.push({ name, reason: encoded });
        continue;
      }
      texture.setImage(encoded.bytes).setMimeType(encoded.mimeType);
      if (encoded.note) report.warnings.push(`${name}: ${encoded.note}`);
      report.textures++;
    } catch (error) {
      report.skipped.push({ name, reason: messageOf(error) });
    }
  }

  // Declare the texture extensions the result actually needs, and no others: a
  // leftover required extension makes loaders without it refuse the file.
  const mimeTypes = new Set(textures.map((texture) => texture.getMimeType()));
  if (mimeTypes.has('image/webp')) doc.createExtension(EXTTextureWebP).setRequired(true);
  else disposeExtension(doc, EXTTextureWebP.EXTENSION_NAME);
  if (mimeTypes.has('image/ktx2')) doc.createExtension(KHRTextureBasisu).setRequired(true);
  else disposeExtension(doc, KHRTextureBasisu.EXTENSION_NAME);
}

/**
 * One texture's new bytes; a string saying why it was left alone; or null when
 * there was nothing to do to it.
 */
async function encodeTexture(
  texture: Texture,
  image: Uint8Array<ArrayBuffer>,
  mimeType: string,
  settings: CompressSettings,
): Promise<Encoded | string | null> {
  const mode = settings.textures;
  const ktx2 = mode === 'etc1s' || mode === 'uastc';

  const original = await createImageBitmap(new Blob([image], { type: mimeType }), BITMAP_OPTIONS);
  const size = targetSize(original.width, original.height, settings.maxSize, ktx2);
  const resized = size.width !== original.width || size.height !== original.height;
  if (mode === 'keep' && !resized) {
    original.close();
    return null;
  }

  const bitmap = resized ? await resize(original, size.width, size.height) : original;
  try {
    if (ktx2) {
      return {
        bytes: await encodeKtx2(bitmap, texture, settings),
        mimeType: 'image/ktx2',
        note: size.note,
      };
    }

    // Resizing alone keeps the format; a browser cannot write AVIF, so that one
    // falls back to PNG.
    const type =
      mode === 'webp'
        ? 'image/webp'
        : mode === 'jpeg'
          ? 'image/jpeg'
          : mimeType === 'image/avif'
            ? 'image/png'
            : mimeType;
    const quality = mode === 'keep' ? 0.9 : settings.imageQuality / 100;
    const encoded = await encodeImage(bitmap, type, quality);
    if (typeof encoded === 'string') return encoded;
    // Re-encoding at a lower quality can still come out bigger — a small PNG
    // of flat colour, say. Only a resize is worth that.
    if (!resized && encoded.byteLength >= image.byteLength) {
      return 'the original is already smaller';
    }
    return { bytes: encoded, mimeType: type };
  } finally {
    bitmap.close();
    if (bitmap !== original) original.close();
  }
}

/**
 * The size a texture comes out at: within the size limit, and for KTX2 within
 * the encoder's texel cap and a multiple of 4 on both sides, as
 * KHR_texture_basisu requires.
 */
function targetSize(
  width: number,
  height: number,
  maxSize: number,
  ktx2: boolean,
): { width: number; height: number; note?: string } {
  const scale = maxSize > 0 ? Math.min(1, maxSize / Math.max(width, height)) : 1;
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  if (!ktx2) return { width: w, height: h };

  let capped = false;
  while (w * h > KTX2_MAX_TEXELS) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    capped = true;
  }
  w = Math.max(4, Math.round(w / 4) * 4);
  h = Math.max(4, Math.round(h / 4) * 4);
  const note = capped
    ? `scaled to ${w}×${h} to fit the KTX2 encoder's 12-megapixel limit`
    : undefined;
  return { width: w, height: h, note };
}

async function resize(source: ImageBitmap, width: number, height: number): Promise<ImageBitmap> {
  const scaled = await createImageBitmap(source, {
    ...BITMAP_OPTIONS,
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  });
  if (scaled.width === width && scaled.height === height) return scaled;

  // A browser that ignores the resize options still gets a scaled copy.
  scaled.close();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas available to resize with');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return canvas.transferToImageBitmap();
}

/** Bytes in a web image format, or why they could not be had. */
async function encodeImage(
  bitmap: ImageBitmap,
  type: string,
  quality: number,
): Promise<Uint8Array | string> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas available to encode with');
  context.drawImage(bitmap, 0, 0);

  if (type === 'image/jpeg') {
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return 'it has transparency, which JPEG cannot store';
    }
  }

  const blob = await canvas.convertToBlob({ type, quality });
  // An unsupported type quietly comes back as PNG — Safari, asked for WebP.
  if (blob.type !== type) return `this browser cannot write ${type.replace('image/', '').toUpperCase()}`;
  return new Uint8Array(await blob.arrayBuffer());
}

async function encodeKtx2(
  bitmap: ImageBitmap,
  texture: Texture,
  settings: CompressSettings,
): Promise<Uint8Array> {
  const { encodeToKTX2 } = await import('ktx2-encoder');

  // Colour maps are sRGB; normal, metal/rough and occlusion data is linear, and
  // encoding it as colour would bend the values it stores.
  const srgb = getTextureColorSpace(texture) === 'srgb';
  const normal = listTextureSlots(texture).some((slot) => /normal/i.test(slot));
  const uastc = settings.textures === 'uastc' || (normal && settings.uastcNormals);
  const own = settings.textures === 'uastc';

  const data = readPixels(bitmap);
  const { width, height } = bitmap;
  return encodeToKTX2(new Uint8Array(0), {
    // The pixels are decoded (and resized) already, so hand them straight over.
    imageDecoder: async () => ({ data, width, height }),
    isUASTC: uastc,
    generateMipmap: true,
    isPerceptual: srgb,
    isSetKTX2SRGBTransferFunc: srgb,
    isNormalMap: normal,
    ...(uastc
      ? {
          // A normal map riding along with ETC1S gets UASTC's middle setting.
          uastcLDRQualityLevel: own ? settings.uastcLevel : 2,
          enableRDO: own && settings.uastcRdo,
          needSupercompression: true,
        }
      : { qualityLevel: settings.etc1sQuality, compressionLevel: 2 }),
  });
}

let gl: WebGL2RenderingContext | null | undefined;

/**
 * RGBA8 pixels, top row first, exactly as the image stores them. A 2D canvas
 * premultiplies alpha and loses colour under nearly transparent pixels, so a
 * WebGL texture is read back instead where there is one.
 */
function readPixels(bitmap: ImageBitmap): Uint8Array {
  const { width, height } = bitmap;
  gl ??= new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false });
  if (gl) {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return pixels;
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no canvas available to read pixels with');
  context.drawImage(bitmap, 0, 0);
  return new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
