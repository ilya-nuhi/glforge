/**
 * The Tools tab's Download panel: how the one Download writes the file.
 *
 * With every choice left as it is, Download is the plain one — the file as
 * edited, in its own format, its data copied byte for byte — and none of this
 * runs. Any choice made here turns it into a re-encode: it starts from exactly
 * what the plain Download would write — every rename, move, delete, trim and
 * added image — and hands that to a worker, which returns a compressed .glb.
 * Nothing about the open document changes either way.
 */

import {
  CHUNK_BIN,
  buildGlb,
  embedGlbImages,
  listExternalResources,
  withDataUriImages,
  type GlbChunk,
  type GltfJson,
  type ImageBytes,
} from './gltf';
import { formatBytes } from './folder';
import { precisionPercent, quantizationBits, type Precision } from './precision';
import { buildResourceLookup, resolveResource } from './resources';
import type {
  CompressReply,
  CompressReport,
  CompressRequest,
  CompressSettings,
  CompressSource,
  OutputFormat,
  TextureMode,
} from './compress.worker';

/** What compressing needs from an open model. */
export interface CompressModel {
  fileName: string;
  isGlb: boolean;
  /** Its sidecars, which a .gltf's external references are read from. */
  resources: Map<string, File>;
}

export interface CompressionHooks<M extends CompressModel> {
  /** Bytes for the images the user added, which the output has to carry. */
  readAddedImages: (model: M) => Promise<Map<number, ImageBytes>>;
  /**
   * The document and chunks the plain Download writes — trims already turned
   * into keyframes — which is where a compressed one starts from too.
   */
  prepare: (model: M) => Promise<{ json: GltfJson; chunks: GlbChunk[] }>;
  /** A choice changed, so what Download does — and what its button says — may have. */
  changed: () => void;
  flash: (message: string) => void;
}

/** What the rest of the app asks of the panel. */
export interface Compression<M extends CompressModel> {
  /**
   * Whether the choices ask this model for a re-encode or another kind of
   * file; if not, Download is the plain one.
   */
  active: (model: M) => boolean;
  /** What the Download button says for this model, or null for the plain one. */
  label: (model: M) => string | null;
  /** Downloads the model rewritten with the panel's choices. */
  download: (model: M) => Promise<void>;
}

/**
 * A key of its own, apart from the one the separate Compress button used: a
 * choice saved for that button must not quietly start re-encoding every
 * Download, and Ctrl+S with it.
 */
const SETTINGS_KEY = 'glforge:download';

const DEFAULTS: CompressSettings = {
  format: 'keep',
  geometry: 'keep',
  precision: 'medium',
  customPrecision: 75,
  meshoptLevel: 'medium',
  quantizePositions: false,
  textures: 'keep',
  imageQuality: 80,
  etc1sQuality: 128,
  uastcLevel: 2,
  uastcRdo: false,
  uastcNormals: true,
  maxSize: 0,
  prune: false,
};

/** Whether the choices ask for anything but the file as it is. */
function wantsReencode(settings: CompressSettings): boolean {
  return settings.geometry !== 'keep' || settings.textures !== 'keep' || settings.maxSize !== 0 || settings.prune;
}

/**
 * The kind of file a download comes out as. As is means the opened file's own
 * kind — and a .gltf that is rewritten brings its .bin and textures along, in
 * a .zip, since they are not the files beside it any more.
 */
function resolveOutput(settings: CompressSettings, model: CompressModel): OutputFormat {
  if (settings.format !== 'keep') return settings.format;
  return model.isGlb ? 'glb' : 'gltf-zip';
}

/** Whether a download has to go through the worker: a re-encode, or another kind of file. */
function needsWorker(settings: CompressSettings, model: CompressModel): boolean {
  if (wantsReencode(settings)) return true;
  return settings.format !== 'keep' && !(settings.format === 'glb' && model.isGlb);
}

const OUTPUT_FILE: Record<OutputFormat, { extension: string; type: string }> = {
  glb: { extension: 'glb', type: 'model/gltf-binary' },
  'gltf-zip': { extension: 'zip', type: 'application/zip' },
  'gltf-embedded': { extension: 'gltf', type: 'model/gltf+json' },
};

/** The name a download goes out under, extension aside: the file's own. */
function baseNameOf(model: CompressModel): string {
  return model.fileName.replace(/\.(glb|gltf)$/i, '') || 'model';
}

/** The quality slider means something different for each texture format. */
const QUALITY: Record<
  Exclude<TextureMode, 'keep'>,
  { key: 'imageQuality' | 'etc1sQuality' | 'uastcLevel'; min: number; max: number; label: string }
> = {
  webp: { key: 'imageQuality', min: 1, max: 100, label: 'Quality' },
  jpeg: { key: 'imageQuality', min: 1, max: 100, label: 'Quality' },
  etc1s: { key: 'etc1sQuality', min: 1, max: 255, label: 'Quality' },
  uastc: { key: 'uastcLevel', min: 0, max: 4, label: 'Level' },
};

/** How many skipped textures the status lists by name before summing up the rest. */
const LISTED_SKIPS = 6;

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

export function initCompression<M extends CompressModel>(hooks: CompressionHooks<M>): Compression<M> {
  const panel = $('#compress-panel');
  const format = $<HTMLSelectElement>('#compress-format');
  const geometry = $<HTMLSelectElement>('#compress-geometry');
  const precision = $<HTMLSelectElement>('#compress-precision');
  const precisionSlider = $<HTMLInputElement>('#compress-precision-slider');
  const precisionValue = $('#compress-precision-value');
  const bitsNote = $('#compress-bits');
  const meshoptLevel = $<HTMLSelectElement>('#compress-meshopt-level');
  const quantizePositions = $<HTMLInputElement>('#compress-quantize-positions');
  const textures = $<HTMLSelectElement>('#compress-textures');
  const quality = $<HTMLInputElement>('#compress-quality');
  const qualityLabel = $('#compress-quality-label');
  const qualityValue = $('#compress-quality-value');
  const rdo = $<HTMLInputElement>('#compress-rdo');
  const uastcNormals = $<HTMLInputElement>('#compress-uastc-normals');
  const maxSize = $<HTMLSelectElement>('#compress-max-size');
  const pruneBox = $<HTMLInputElement>('#compress-prune');
  // The one Download button: the app starts it, the panel holds it while it works.
  const startBtn = $<HTMLButtonElement>('#export-btn');
  const cancelBtn = $<HTMLButtonElement>('#compress-cancel-btn');
  const status = $('#compress-status');
  const hint = $('#compress-hint');

  const settings = loadSettings();
  let job: { worker: Worker; fileName: string; before: number } | null = null;

  function render(): void {
    format.value = settings.format;
    geometry.value = settings.geometry;
    precision.value = settings.precision;
    meshoptLevel.value = settings.meshoptLevel;
    quantizePositions.checked = settings.quantizePositions;
    textures.value = settings.textures;
    rdo.checked = settings.uastcRdo;
    uastcNormals.checked = settings.uastcNormals;
    maxSize.value = String(settings.maxSize);
    pruneBox.checked = settings.prune;

    // Rows that only mean something for one choice appear with it.
    const shown: Record<string, boolean> = {
      precision: settings.geometry === 'draco' || settings.geometry === 'meshopt',
      meshopt: settings.geometry === 'meshopt',
      quality: settings.textures !== 'keep',
      uastc: settings.textures === 'uastc',
      etc1s: settings.textures === 'etc1s',
    };
    for (const row of panel.querySelectorAll<HTMLElement>('[data-compress]')) {
      row.hidden = !shown[row.dataset.compress ?? ''];
    }

    // The slider shows where the choice sits on the scale — a preset's own
    // percentage, or Custom's.
    const percent = precisionPercent(settings.precision, settings.customPrecision);
    precisionSlider.value = String(percent);
    precisionValue.textContent = `${percent}%`;
    bitsNote.textContent = describeBits(settings);
    // Lossless means nothing is quantized or filtered, so these have no say.
    const lossless = quantizationBits(percent) === null;
    meshoptLevel.disabled = lossless;
    quantizePositions.disabled = lossless;

    if (settings.textures !== 'keep') {
      const scale = QUALITY[settings.textures];
      quality.min = String(scale.min);
      quality.max = String(scale.max);
      quality.value = String(settings[scale.key]);
      qualityLabel.textContent = scale.label;
      qualityValue.textContent = String(settings[scale.key]);
    }

    hint.textContent = describe(settings);
    hooks.changed();
  }

  function update(): void {
    settings.format = format.value as CompressSettings['format'];
    settings.geometry = geometry.value as CompressSettings['geometry'];
    // Custom picked from the list starts from wherever the slider already is,
    // rather than jumping back to an older custom value.
    const picked = precision.value as Precision;
    if (picked === 'custom' && settings.precision !== 'custom') {
      settings.customPrecision = precisionPercent(settings.precision, settings.customPrecision);
    }
    settings.precision = picked;
    settings.meshoptLevel = meshoptLevel.value as CompressSettings['meshoptLevel'];
    settings.quantizePositions = quantizePositions.checked;
    settings.textures = textures.value as TextureMode;
    settings.uastcRdo = rdo.checked;
    settings.uastcNormals = uastcNormals.checked;
    settings.maxSize = Number(maxSize.value) || 0;
    settings.prune = pruneBox.checked;
    saveSettings(settings);
    render();
  }

  for (const control of [
    format,
    geometry,
    precision,
    meshoptLevel,
    quantizePositions,
    textures,
    rdo,
    uastcNormals,
    maxSize,
    pruneBox,
  ]) {
    control.addEventListener('change', update);
  }

  // Touching the slider makes the precision Custom, whatever it was.
  precisionSlider.addEventListener('input', () => {
    settings.precision = 'custom';
    settings.customPrecision = Number(precisionSlider.value);
    render();
  });
  precisionSlider.addEventListener('change', () => saveSettings(settings));

  // Each format keeps its own value, so trying another and coming back does
  // not lose the one that was set.
  quality.addEventListener('input', () => {
    if (settings.textures === 'keep') return;
    const { key } = QUALITY[settings.textures];
    settings[key] = Number(quality.value);
    qualityValue.textContent = quality.value;
  });
  quality.addEventListener('change', () => saveSettings(settings));

  function setBusy(busy: boolean): void {
    startBtn.disabled = busy;
    cancelBtn.hidden = !busy;
  }

  function showStatus(lines: string[]): void {
    status.textContent = lines.join('\n');
    status.hidden = lines.length === 0;
  }

  function finish(lines: string[]): void {
    job?.worker.terminate();
    job = null;
    setBusy(false);
    showStatus(lines);
  }

  async function start(model: M): Promise<void> {
    if (job) return;
    setBusy(true);
    showStatus(['Preparing…']);
    let prepared: { source: CompressSource; before: number; transfer: ArrayBuffer[] };
    try {
      prepared = await prepareSource(model, await hooks.prepare(model), await hooks.readAddedImages(model));
    } catch (error) {
      finish([`Could not compress: ${messageOf(error)}`]);
      return;
    }

    // The worker is its own bundle, fetched on first use: glTF-Transform and
    // the encoders never weigh on the page until someone compresses.
    const worker = new Worker(new URL('./compress.worker.ts', import.meta.url), { type: 'module' });
    const current = { worker, fileName: model.fileName, before: prepared.before };
    job = current;
    const output = resolveOutput(settings, model);
    const basename = baseNameOf(model);

    worker.addEventListener('message', (event: MessageEvent<CompressReply>) => {
      if (job !== current) return;
      const reply = event.data;
      if (reply.type === 'progress') {
        showStatus([reply.text]);
      } else if (reply.type === 'error') {
        finish([`Could not compress: ${reply.message}`]);
      } else {
        const file = OUTPUT_FILE[output];
        const name = `${basename}.${file.extension}`;
        const blob = new Blob([reply.bytes as Uint8Array<ArrayBuffer>], { type: file.type });
        download(blob, name);
        finish(summarize(reply.report, current.before, blob.size));
        hooks.flash(`Downloaded ${name} — ${sizeChange(current.before, blob.size)}`);
        for (const warning of reply.report.warnings) console.warn(`[compress] ${warning}`);
      }
    });
    worker.addEventListener('error', (event) => {
      if (job !== current) return;
      finish([`Could not compress: ${event.message || 'the compressor failed to load'}`]);
    });

    const request: CompressRequest = {
      source: prepared.source,
      settings: { ...settings },
      output,
      basename,
    };
    worker.postMessage(request, prepared.transfer);
  }

  cancelBtn.addEventListener('click', () => {
    if (job) finish(['Cancelled.']);
  });

  render();
  return {
    active: (model) => needsWorker(settings, model),
    label: (model) => {
      if (!needsWorker(settings, model)) return null;
      const { extension } = OUTPUT_FILE[resolveOutput(settings, model)];
      return wantsReencode(settings) ? `Download compressed .${extension}` : `Download .${extension}`;
    },
    download: (model) => start(model),
  };
}

/**
 * The file as the plain Download would write it — `file`, with its trims
 * already keyframes — split into its JSON and the bytes it refers to. A .glb's
 * added images are folded into its binary chunk,
 * a .gltf's become data URIs, and anything still external is read from the
 * files supplied with the model.
 */
async function prepareSource(
  model: CompressModel,
  file: { json: GltfJson; chunks: GlbChunk[] },
  added: Map<number, ImageBytes>,
): Promise<{ source: CompressSource; before: number; transfer: ArrayBuffer[] }> {
  let json: GltfJson;
  let bin: Uint8Array<ArrayBuffer> | null = null;
  let before: number;
  if (model.isGlb) {
    const embedded = embedGlbImages(file.json, file.chunks, added);
    json = embedded.json;
    bin = embedded.chunks.find((chunk) => chunk.type === CHUNK_BIN)?.data ?? null;
    before = buildGlb(embedded.json, embedded.chunks).size;
  } else {
    json = withDataUriImages(file.json, added);
    before = new Blob([JSON.stringify(json)]).size;
  }

  const lookup = buildResourceLookup(model.resources);
  const { buffers, images } = listExternalResources(json);
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  const missing: string[] = [];
  for (const uri of [...buffers, ...images]) {
    const file = resolveResource(lookup, uri);
    if (!file) {
      missing.push(uri);
      continue;
    }
    resources[uri] = new Uint8Array(await file.arrayBuffer());
    before += file.size;
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not supplied — add ${
        missing.length === 1 ? 'it' : 'them'
      } on the Files tab`,
    );
  }

  // The sidecar bytes were read for this alone, so they can move to the
  // worker; the binary chunk is shared with the preview and is copied.
  const transfer = Object.values(resources).map((bytes) => bytes.buffer);
  return { source: { json, bin, resources }, before, transfer };
}

function summarize(report: CompressReport, before: number, after: number): string[] {
  const lines = [`${formatBytes(before)} → ${formatBytes(after)} (${sizeChange(before, after)})`];
  lines.push(`Geometry: ${report.geometry}`);
  if (report.textures > 0 || report.skipped.length > 0) {
    const parts = [`${report.textures} re-encoded`];
    if (report.skipped.length > 0) parts.push(`${report.skipped.length} left as they were`);
    lines.push(`Textures: ${parts.join(', ')}`);
  }
  for (const { name, reason } of report.skipped.slice(0, LISTED_SKIPS)) {
    lines.push(`· ${name}: ${reason}`);
  }
  if (report.skipped.length > LISTED_SKIPS) {
    lines.push(`· and ${report.skipped.length - LISTED_SKIPS} more`);
  }
  if (report.warnings.length > 0) {
    lines.push(
      `${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'} in the console`,
    );
  }
  return lines;
}

function sizeChange(before: number, after: number): string {
  if (before <= 0) return formatBytes(after);
  const percent = Math.round((1 - after / before) * 100);
  return percent >= 0 ? `−${percent}%` : `+${-percent}%`;
}

/** What the precision works out to for the chosen encoder, in bits. */
function describeBits(settings: CompressSettings): string {
  const bits = quantizationBits(precisionPercent(settings.precision, settings.customPrecision));
  const meshopt = settings.geometry === 'meshopt';
  if (!bits) {
    return meshopt
      ? 'Lossless: nothing is quantized or filtered, so Level and Positions do not apply.'
      : 'Lossless: every vertex comes out exactly as it was.';
  }
  const position =
    meshopt && !settings.quantizePositions ? 'float' : `${bits.position}`;
  // Level High stores normals through an 8-bit filter, whatever the grid.
  const normal = meshopt && settings.meshoptLevel === 'high' ? Math.min(bits.normal, 8) : bits.normal;
  return `Bits: position ${position} · normal ${normal} · UV ${bits.texcoord} · colour ${bits.color}`;
}

/** A sentence or two on what the current choices mean for whoever loads the file. */
function describe(settings: CompressSettings): string {
  if (!wantsReencode(settings) && settings.format === 'keep') {
    return 'Everything as is: Download writes the file exactly as edited, in its own format, with its data copied byte for byte. Choose anything above to rewrite it instead.';
  }
  const sentences: string[] = [];
  if (!wantsReencode(settings)) {
    sentences.push('Nothing is compressed; only the kind of file changes.');
  }
  switch (settings.geometry) {
    case 'draco':
      sentences.push('Draco gives the smallest geometry; loaders need its decoder (DRACOLoader).');
      break;
    case 'meshopt':
      sentences.push(
        'Meshopt decodes fast and shrinks further under gzip or brotli; loaders need its decoder (setMeshoptDecoder).',
      );
      if (
        settings.quantizePositions &&
        quantizationBits(precisionPercent(settings.precision, settings.customPrecision))
      ) {
        sentences.push(
          'Quantized positions put a scale and offset on every node drawing a mesh, and a new child under any that has children.',
        );
      }
      break;
    case 'none':
      sentences.push('Draco or meshopt already in the file is decoded, for loaders without either.');
      break;
    case 'keep':
      break;
  }
  switch (settings.textures) {
    case 'webp':
      sentences.push('WebP is smaller to download but still full size in video memory.');
      break;
    case 'jpeg':
      sentences.push('JPEG needs no extension; textures with transparency stay as they are.');
      break;
    case 'etc1s':
      sentences.push(
        'KTX2 stays compressed in video memory (KTX2Loader). ETC1S is the smallest, at some loss of detail.',
      );
      break;
    case 'uastc':
      sentences.push(
        'KTX2 stays compressed in video memory (KTX2Loader). UASTC keeps far more detail than ETC1S and is bigger; RDO trades a little of it for size.',
      );
      break;
    case 'keep':
      break;
  }
  sentences.push(FORMAT_SENTENCES[settings.format]);
  sentences.push('The open file is not changed.');
  return sentences.join(' ');
}

const FORMAT_SENTENCES: Record<CompressSettings['format'], string> = {
  keep: 'A .glb stays one .glb; a .gltf comes as a .zip with its .bin and textures.',
  glb: 'One .glb, with everything inside it.',
  'gltf-zip': 'A .zip holding the .gltf, its .bin and every texture as a file of its own.',
  'gltf-embedded':
    'One .gltf with its data and textures written inline as base64 — about a third bigger than a .glb.',
};

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** What a saved setting may be, so a stale value never leaves a picker blank. */
const VALID: { [K in keyof CompressSettings]: (value: unknown) => boolean } = {
  format: (v) => ['keep', 'glb', 'gltf-zip', 'gltf-embedded'].includes(v as string),
  geometry: (v) => ['keep', 'draco', 'meshopt', 'none'].includes(v as string),
  precision: (v) => ['original', 'high', 'medium', 'low', 'custom'].includes(v as string),
  customPrecision: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100,
  meshoptLevel: (v) => ['medium', 'high'].includes(v as string),
  quantizePositions: (v) => typeof v === 'boolean',
  textures: (v) => ['keep', 'webp', 'jpeg', 'etc1s', 'uastc'].includes(v as string),
  imageQuality: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100,
  etc1sQuality: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 255,
  uastcLevel: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4,
  uastcRdo: (v) => typeof v === 'boolean',
  uastcNormals: (v) => typeof v === 'boolean',
  maxSize: (v) => [0, 4096, 2048, 1024, 512, 256].includes(v as number),
  prune: (v) => typeof v === 'boolean',
};

/** Saved choices over the defaults, ignoring anything that no longer fits. */
function loadSettings(): CompressSettings {
  const settings = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    for (const key of Object.keys(DEFAULTS) as (keyof CompressSettings)[]) {
      if (VALID[key](saved[key])) Object.assign(settings, { [key]: saved[key] });
    }
  } catch {
    // Unreadable or blocked storage just means the defaults.
  }
  return settings;
}

function saveSettings(settings: CompressSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private-mode storage failures are not worth surfacing.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
