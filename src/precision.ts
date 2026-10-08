/**
 * Geometry precision as one percentage, shared by the Compress panel and its
 * worker.
 *
 * Draco and meshopt both quantize: each vertex attribute is snapped to a grid
 * of so many bits. The panel shows that as a single 1–100% scale rather than
 * five bit counts, where 100% means no grid at all — the geometry comes out
 * exactly as it went in.
 */

export type Precision = 'original' | 'high' | 'medium' | 'low' | 'custom';

/** Where each named precision sits on the scale. */
export const PRECISION_PERCENT: Record<Exclude<Precision, 'custom'>, number> = {
  original: 100,
  high: 90,
  medium: 75,
  low: 50,
};

export interface QuantizationBits {
  position: number;
  normal: number;
  texcoord: number;
  color: number;
  generic: number;
}

type BitKey = keyof QuantizationBits;

/**
 * Bits at a few points on the scale, with everything between interpolated.
 * Low, Medium and High are the anchors at 50, 75 and 90 (Medium is
 * glTF-Transform's own default). Nothing goes outside 8–16 bits, which is what
 * meshopt's quantization accepts.
 */
const ANCHORS: [number, QuantizationBits][] = [
  [1, { position: 8, normal: 8, texcoord: 8, color: 8, generic: 8 }],
  [50, { position: 12, normal: 8, texcoord: 10, color: 8, generic: 10 }],
  [75, { position: 14, normal: 10, texcoord: 12, color: 8, generic: 12 }],
  [90, { position: 16, normal: 12, texcoord: 14, color: 10, generic: 14 }],
  [99, { position: 16, normal: 16, texcoord: 16, color: 16, generic: 16 }],
];

/** The percentage a precision stands for; Custom's is its own. */
export function precisionPercent(precision: Precision, custom: number): number {
  return precision === 'custom' ? custom : PRECISION_PERCENT[precision];
}

/** Bits per kind of attribute at a percentage, or null at 100%: lossless. */
export function quantizationBits(percent: number): QuantizationBits | null {
  if (percent >= 100) return null;
  const p = Math.min(Math.max(percent, ANCHORS[0][0]), ANCHORS[ANCHORS.length - 1][0]);
  let i = 0;
  while (i < ANCHORS.length - 2 && p > ANCHORS[i + 1][0]) i++;
  const [from, low] = ANCHORS[i];
  const [to, high] = ANCHORS[i + 1];
  const t = (p - from) / (to - from);
  const bits = {} as QuantizationBits;
  for (const key of Object.keys(low) as BitKey[]) {
    bits[key] = Math.round(low[key] + (high[key] - low[key]) * t);
  }
  return bits;
}
