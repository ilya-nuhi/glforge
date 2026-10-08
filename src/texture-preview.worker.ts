/**
 * The Download panel's texture preview, run in a worker.
 *
 * Each image a material shows is re-encoded exactly as a compressed download
 * would carry it, and sent back the moment it is done, so the viewport changes
 * texture by texture rather than all at the end. There is one worker per
 * preview, so a newer choice cancels it with a terminate().
 */

import {
  encodeTexture,
  undecodableReason,
  type TextureSettings,
  type TextureUse,
} from './texture-encode';

export interface PreviewImage extends TextureUse {
  /** Its index in the file's `images`. */
  image: number;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

export interface PreviewRequest {
  images: PreviewImage[];
  settings: TextureSettings;
}

export type PreviewReply =
  | {
      type: 'image';
      image: number;
      /** The bytes a download would carry; null where it would keep the image as it is. */
      encoded: { bytes: Uint8Array<ArrayBuffer>; mimeType: string } | null;
      /** Why it would be kept, when it would be. */
      skipped: string | null;
      before: number;
      after: number;
    }
  | { type: 'done' };

self.addEventListener('message', (event: MessageEvent<PreviewRequest>) => {
  void preview(event.data);
});

async function preview({ images, settings }: PreviewRequest): Promise<void> {
  for (const { image, bytes, mimeType, srgb, normal } of images) {
    const before = bytes.byteLength;
    let encoded: Awaited<ReturnType<typeof encodeTexture>>;
    try {
      encoded = undecodableReason(mimeType) ?? (await encodeTexture(bytes, mimeType, { srgb, normal }, settings));
    } catch (error) {
      encoded = error instanceof Error ? error.message : String(error);
    }
    if (encoded === null || typeof encoded === 'string') {
      reply({ type: 'image', image, encoded: null, skipped: encoded, before, after: before });
      continue;
    }
    const after = encoded.bytes.byteLength;
    reply(
      {
        type: 'image',
        image,
        encoded: { bytes: encoded.bytes, mimeType: encoded.mimeType },
        skipped: null,
        before,
        after,
      },
      [encoded.bytes.buffer],
    );
  }
  reply({ type: 'done' });
}

function reply(message: PreviewReply, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}
