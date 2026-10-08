/**
 * One texture image re-encoded the way a compressed download carries it, run
 * in a worker.
 *
 * The compress worker writes these bytes into the file; the preview worker
 * hands them to the viewport. Both come through here, so what the preview
 * shows is exactly what Download writes. Nothing here knows about glTF: the
 * caller says what the image is used as.
 */

export type TextureMode = 'keep' | 'webp' | 'jpeg' | 'etc1s' | 'uastc';

/** The Download panel's texture choices — all that encoding one image needs. */
export interface TextureSettings {
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
}

/** What an image is used as, which KTX2 encodes differently. */
export interface TextureUse {
  /** Colour, rather than data: normal, metal/rough and occlusion maps are linear. */
  srgb: boolean;
  normal: boolean;
}

export interface Encoded {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  note?: string;
}

/** Image formats a worker can decode, through createImageBitmap. */
const DECODABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);

/** Basis Universal's cap on source texels, which keeps its 32-bit wasm heap from running out. */
const KTX2_MAX_TEXELS = 12 * 1024 * 1024;

/** Pixels exactly as stored: no premultiplying, no colour management. */
const BITMAP_OPTIONS: ImageBitmapOptions = {
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
};

/** Why an image of this type cannot be re-encoded here, or null when it can. */
export function undecodableReason(mimeType: string): string | null {
  if (DECODABLE.has(mimeType)) return null;
  return mimeType === 'image/ktx2' ? 'already KTX2' : `${mimeType || 'unknown format'} is not decodable here`;
}

/**
 * One image's new bytes; a string saying why it was left alone; or null when
 * there was nothing to do to it.
 */
export async function encodeTexture(
  image: Uint8Array<ArrayBuffer>,
  mimeType: string,
  use: TextureUse,
  settings: TextureSettings,
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
        bytes: await encodeKtx2(bitmap, use, settings),
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
): Promise<Uint8Array<ArrayBuffer> | string> {
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
  use: TextureUse,
  settings: TextureSettings,
): Promise<Uint8Array<ArrayBuffer>> {
  const { encodeToKTX2 } = await import('ktx2-encoder');

  // Colour maps are sRGB; normal, metal/rough and occlusion data is linear, and
  // encoding it as colour would bend the values it stores.
  const { srgb, normal } = use;
  const uastc = settings.textures === 'uastc' || (normal && settings.uastcNormals);
  const own = settings.textures === 'uastc';

  const data = readPixels(bitmap);
  const { width, height } = bitmap;
  const bytes = await encodeToKTX2(new Uint8Array(0), {
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
  // A copy on a buffer of its own, which a worker can hand over whole.
  return new Uint8Array(bytes);
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
