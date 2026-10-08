/**
 * Trimming animations: cutting a clip down to a stretch of itself.
 *
 * While the file is edited a trim is only a range kept on the animation — the
 * preview plays that stretch and nothing else — so it can be dragged about
 * freely and costs nothing. It becomes keyframes on download. Each sampler is
 * cut at the range's two ends: the keys between them are kept, each end gets a
 * key of its own sampled exactly where it falls (so the motion is the same, not
 * snapped to the nearest key), and the whole is moved to start at 0.
 *
 * The keyframes are new data, written after everything the file already had:
 * onto the end of a .glb's binary chunk, or into a buffer of its own embedded
 * in a .gltf, whose .bin is left as it is. The keys the file had stay behind
 * unreferenced — the same way a delete leaves geometry — since nothing here
 * rewrites data it did not make. Keys stored packed (meshopt) or sparse are
 * read through that; the new ones are written as plain floats.
 *
 * Like remove.ts it is free of the DOM and of three.js.
 */
import {
  toBase64,
  type GltfAccessor,
  type GltfAnimation,
  type GltfAnimationSampler,
  type GltfBufferView,
  type GltfJson,
} from './gltf';

/** A stretch of a clip, in the seconds of its own timeline. */
export interface TrimRange {
  start: number;
  end: number;
}

/** Where a trim is kept on an animation while the file is edited. Never downloaded. */
const TRIM_KEY = 'glforgeTrim';

/** Keys closer than this to a cut are taken as the cut, so no two keys share a time. */
const EPSILON = 1e-5;

const FLOAT = 5126;
const MESHOPT = 'EXT_meshopt_compression';

const COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

// ---------------------------------------------------------------------------
// The range kept on an animation

export function getTrim(animation: GltfAnimation): TrimRange | null {
  const trim = animation.extras?.[TRIM_KEY] as Partial<TrimRange> | undefined;
  if (typeof trim?.start !== 'number' || typeof trim.end !== 'number') return null;
  if (!Number.isFinite(trim.start) || !Number.isFinite(trim.end) || trim.end <= trim.start) return null;
  return { start: trim.start, end: trim.end };
}

/** Keeps a range on the animation, or takes it off with `null`. */
export function setTrim(animation: GltfAnimation, range: TrimRange | null): void {
  if (range) {
    animation.extras = { ...animation.extras, [TRIM_KEY]: { start: range.start, end: range.end } };
    return;
  }
  if (!animation.extras || !(TRIM_KEY in animation.extras)) return;
  const rest = { ...animation.extras };
  delete rest[TRIM_KEY];
  if (Object.keys(rest).length > 0) animation.extras = rest;
  else delete animation.extras;
}

export function hasTrims(json: GltfJson): boolean {
  return (json.animations ?? []).some((animation) => getTrim(animation) !== null);
}

/** A clip's length as its file states it: the last key time any of its channels reaches. */
export function animationLength(json: GltfJson, animation: GltfAnimation): number | null {
  let length: number | null = null;
  for (const channel of animation.channels ?? []) {
    const sampler = animation.samplers?.[channel.sampler ?? -1];
    const max = json.accessors?.[sampler?.input ?? -1]?.max?.[0];
    if (typeof max === 'number' && Number.isFinite(max)) length = Math.max(length ?? 0, max);
  }
  return length;
}

/**
 * Why an animation's keyframes cannot be cut, or null when they can. Only what
 * the document shows is checked here; a data file that was never supplied is
 * found out on download.
 */
export function trimBlocker(json: GltfJson, animation: GltfAnimation): string | null {
  for (const sampler of animation.samplers ?? []) {
    for (const index of [sampler.input, sampler.output]) {
      if (!json.accessors?.[index ?? -1]) return 'some of its keyframes are missing from the file';
    }
  }
  return null;
}

/** A buffer view packed with EXT_meshopt_compression, which has to be unpacked before it is read. */
export interface MeshoptView {
  /** The buffer view, which the unpacked bytes stand in for. */
  view: number;
  /** Where the packed bytes are. */
  buffer: number;
  byteOffset: number;
  byteLength: number;
  byteStride: number;
  count: number;
  mode: string;
  filter?: string;
}

/** The buffer views a download reads to write the trimmed keyframes. */
function trimmedViews(json: GltfJson): Set<number> {
  const views = new Set<number>();
  for (const animation of json.animations ?? []) {
    if (!getTrim(animation)) continue;
    for (const sampler of animation.samplers ?? []) {
      for (const index of [sampler.input, sampler.output]) {
        const accessor = json.accessors?.[index ?? -1];
        if (!accessor) continue;
        const sparse = accessor.sparse as SparseData | undefined;
        for (const view of [accessor.bufferView, sparse?.indices?.bufferView, sparse?.values?.bufferView]) {
          if (typeof view === 'number') views.add(view);
        }
      }
    }
  }
  return views;
}

/** The buffers a download has to read to write the trimmed keyframes, packed or not. */
export function trimmedBuffers(json: GltfJson): number[] {
  const buffers = new Set<number>();
  for (const index of trimmedViews(json)) {
    const view = json.bufferViews?.[index];
    if (!view) continue;
    const packed = view.extensions?.[MESHOPT] as { buffer?: number } | undefined;
    buffers.add(packed ? (packed.buffer ?? 0) : (view.buffer ?? 0));
  }
  return [...buffers];
}

/** The meshopt-packed views among those, for the caller to unpack before baking. */
export function meshoptViews(json: GltfJson): MeshoptView[] {
  const packed: MeshoptView[] = [];
  for (const index of trimmedViews(json)) {
    const ext = json.bufferViews?.[index]?.extensions?.[MESHOPT] as Partial<MeshoptView> | undefined;
    if (!ext || typeof ext.count !== 'number' || typeof ext.byteStride !== 'number') continue;
    packed.push({
      view: index,
      buffer: ext.buffer ?? 0,
      byteOffset: ext.byteOffset ?? 0,
      byteLength: ext.byteLength ?? 0,
      byteStride: ext.byteStride,
      count: ext.count,
      mode: ext.mode ?? 'ATTRIBUTES',
      filter: ext.filter,
    });
  }
  return packed;
}

/** An accessor's sparse substitution, as glTF lays it out. */
interface SparseData {
  count?: number;
  indices?: { bufferView?: number; byteOffset?: number; componentType?: number };
  values?: { bufferView?: number; byteOffset?: number };
}

// ---------------------------------------------------------------------------
// Download

/**
 * Writes every trim into keyframes, and returns the document to download: one
 * with no trim ranges left on it. `bin` is a .glb's binary chunk when the new
 * data can go onto its end; the chunk that has to replace it comes back, or
 * null when the data went into an embedded buffer instead. `unpacked` holds the
 * meshopt-packed views already unpacked, by view. Throws, naming the animation,
 * when one cannot be read.
 */
export function bakeTrims(
  json: GltfJson,
  bytesOf: (buffer: number) => Uint8Array | null,
  bin: Uint8Array | null,
  unpacked: Map<number, Uint8Array> = new Map(),
): { json: GltfJson; bin: Uint8Array<ArrayBuffer> | null } {
  const animations = json.animations ?? [];
  if (!animations.some((animation) => getTrim(animation) !== null)) return { json, bin: null };

  const out: GltfJson = { ...json, animations: animations.map((animation) => ({ ...animation })) };
  const accessors = [...(json.accessors ?? [])];
  const bufferViews = [...(json.bufferViews ?? [])];
  const packer = new Packer();
  const written: GltfBufferView[] = [];
  const reads = new Map<number, Float32Array>();
  const views = viewReader(json, bytesOf, unpacked);
  const read = (index: number): Float32Array => {
    let data = reads.get(index);
    if (!data) {
      data = readAccessor(json, index, views);
      reads.set(index, data);
    }
    return data;
  };
  const write = (data: Float32Array, type: string, bounds: boolean): number => {
    const view: GltfBufferView = {
      buffer: -1,
      byteOffset: packer.add(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
      byteLength: data.byteLength,
    };
    written.push(view);
    bufferViews.push(view);
    const accessor: GltfAccessor = {
      bufferView: bufferViews.length - 1,
      componentType: FLOAT,
      count: data.length / COMPONENTS[type],
      type,
    };
    // Key times must say their range; they only ever go up.
    if (bounds) {
      accessor.min = [data[0]];
      accessor.max = [data[data.length - 1]];
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  out.animations!.forEach((animation, index) => {
    const trim = getTrim(animation);
    if (!trim) return;
    setTrim(animation, null);
    try {
      animation.samplers = cutAnimation(json, animation, trim, read, write);
    } catch (error) {
      const name = animation.name ? `"${animation.name}"` : `animation ${index}`;
      throw new Error(`could not trim ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  if (packer.length === 0) return { json: out, bin: null };
  out.accessors = accessors;
  out.bufferViews = bufferViews;
  const buffers = [...(json.buffers ?? [])];
  const data = packer.join();

  if (bin && buffers[0] && buffers[0].uri === undefined) {
    // Onto the end of the .glb's own binary chunk, 4-byte aligned.
    const base = bin.byteLength + ((4 - (bin.byteLength % 4)) % 4);
    const merged = new Uint8Array(base + data.byteLength);
    merged.set(bin, 0);
    merged.set(data, base);
    for (const view of written) {
      view.buffer = 0;
      view.byteOffset = base + (view.byteOffset ?? 0);
    }
    buffers[0] = { ...buffers[0], byteLength: merged.byteLength };
    out.buffers = buffers;
    return { json: out, bin: merged };
  }

  // A buffer of its own, embedded, so the files the .gltf already refers to are
  // left exactly as they are.
  const buffer = buffers.length;
  buffers.push({ byteLength: data.byteLength, uri: `data:application/octet-stream;base64,${toBase64(data)}` });
  for (const view of written) view.buffer = buffer;
  out.buffers = buffers;
  return { json: out, bin: null };
}

/** An animation's samplers, cut to the range. Several samplers sharing key times share them again. */
function cutAnimation(
  json: GltfJson,
  animation: GltfAnimation,
  trim: TrimRange,
  read: (accessor: number) => Float32Array,
  write: (data: Float32Array, type: string, bounds: boolean) => number,
): GltfAnimationSampler[] {
  const samplers = animation.samplers ?? [];
  // The range as the file can honour it: nothing before 0, nothing past the last key.
  let length = 0;
  for (const sampler of samplers) {
    const times = read(requireIndex(sampler.input, 'key times'));
    if (times.length > 0) length = Math.max(length, times[times.length - 1]);
  }
  const start = Math.max(0, trim.start);
  const end = Math.min(trim.end, length);
  if (end - start <= EPSILON) throw new Error('the range left nothing to keep');
  // A range covering the whole clip changes nothing worth writing.
  if (start <= EPSILON && end >= length - EPSILON) return samplers;

  const rotation = new Set<number>();
  for (const channel of animation.channels ?? []) {
    if (channel.target?.path === 'rotation' && typeof channel.sampler === 'number') rotation.add(channel.sampler);
  }

  const inputs = new Map<number, number>();
  return samplers.map((sampler, index) => {
    const input = requireIndex(sampler.input, 'key times');
    const output = requireIndex(sampler.output, 'key values');
    const type = json.accessors?.[output]?.type ?? '';
    if (!COMPONENTS[type]) throw new Error(`its key values have an unknown type (${type || 'none'})`);
    const cut = cutTrack(
      {
        times: read(input),
        values: read(output),
        interpolation: sampler.interpolation ?? 'LINEAR',
        rotation: rotation.has(index),
      },
      start,
      end,
    );
    let times = inputs.get(input);
    if (times === undefined) {
      times = write(cut.times, 'SCALAR', true);
      inputs.set(input, times);
    }
    return { ...sampler, input: times, output: write(cut.values, type, false) };
  });
}

function requireIndex(index: number | undefined, what: string): number {
  if (typeof index !== 'number') throw new Error(`a sampler has no ${what}`);
  return index;
}

// ---------------------------------------------------------------------------
// Cutting one sampler

interface Track {
  times: Float32Array;
  values: Float32Array;
  interpolation: string;
  /** Quaternions, which interpolate along the sphere rather than straight. */
  rotation: boolean;
}

/** A key as a cubic spline sees it; LINEAR and STEP keys use only the value. */
interface Key {
  value: ArrayLike<number>;
  /** Slopes, in units per second, arriving at and leaving the key. */
  in: ArrayLike<number>;
  out: ArrayLike<number>;
}

/**
 * The track between `start` and `end`, moved to start at 0. The keys inside
 * the range are kept as they are; each end gets a key sampled where it falls.
 * A cubic key keeps its slopes, and one sampled mid-curve takes the curve's own
 * slope there — a cubic is fixed by its ends' values and slopes, so the pieces
 * trace exactly the curve the whole did. Where the file holds a value still
 * (before its first key, after its last) the slopes are 0, which holds it still
 * the same way.
 */
export function cutTrack(track: Track, start: number, end: number): { times: Float32Array; values: Float32Array } {
  const { times, values } = track;
  const count = times.length;
  if (count === 0) throw new Error('a sampler has no keys');
  const cubic = track.interpolation === 'CUBICSPLINE';
  const perKey = values.length / count;
  if (!Number.isInteger(perKey) || perKey === 0 || (cubic && perKey % 3 !== 0)) {
    throw new Error('a sampler has key values that do not match its key times');
  }
  const width = cubic ? perKey / 3 : perKey;
  const still = new Float32Array(width);
  const key = (index: number): Key => {
    const at = index * perKey;
    return cubic
      ? {
          in: values.subarray(at, at + width),
          value: values.subarray(at + width, at + 2 * width),
          out: values.subarray(at + 2 * width, at + 3 * width),
        }
      : { value: values.subarray(at, at + width), in: still, out: still };
  };

  const outTimes: number[] = [];
  const outValues: number[] = [];
  const push = (time: number, point: Key): void => {
    outTimes.push(time - start);
    if (cubic) outValues.push(...Array.from(point.in), ...Array.from(point.value), ...Array.from(point.out));
    else outValues.push(...Array.from(point.value));
  };

  push(start, pointAt(track, key, count, width, still, start, 'start'));
  const last = Math.fround(end - start);
  for (let index = 0; index < count; index++) {
    const time = times[index];
    if (time <= start + EPSILON || time >= end - EPSILON) continue;
    // Key times are stored as 32-bit floats, and they must go strictly up.
    const shifted = Math.fround(time - start);
    if (shifted <= Math.fround(outTimes[outTimes.length - 1]) || shifted >= last) continue;
    const kept = key(index);
    // The first key's arrival and the last key's departure only ever meant the
    // file holding still, so they hold still here too.
    push(time, {
      value: kept.value,
      in: index > 0 ? kept.in : still,
      out: index < count - 1 ? kept.out : still,
    });
  }
  push(end, pointAt(track, key, count, width, still, end, 'end'));

  return { times: Float32Array.from(outTimes), values: Float32Array.from(outValues) };
}

/** The key a cut at `time` gets: the file's own when one is there, else one sampled. */
function pointAt(
  track: Track,
  key: (index: number) => Key,
  count: number,
  width: number,
  still: Float32Array,
  time: number,
  side: 'start' | 'end',
): Key {
  const { times } = track;
  // Only the slope inside the range matters: a start's leaving, an end's arriving.
  const onKey = (index: number): Key => {
    const own = key(index);
    return side === 'start'
      ? { value: own.value, in: still, out: index < count - 1 ? own.out : still }
      : { value: own.value, in: index > 0 ? own.in : still, out: still };
  };
  const near = nearestKey(times, time);
  if (Math.abs(times[near] - time) <= EPSILON) return onKey(near);
  if (time < times[0]) return { value: key(0).value, in: still, out: still };
  if (time > times[count - 1]) return { value: key(count - 1).value, in: still, out: still };

  const at = segmentAt(times, time);
  const from = key(at);
  const to = key(at + 1);
  const span = times[at + 1] - times[at];
  const s = (time - times[at]) / span;

  if (track.interpolation === 'STEP') return { value: from.value, in: still, out: still };
  if (track.interpolation !== 'CUBICSPLINE') {
    const value = track.rotation && width === 4 ? slerp(from.value, to.value, s) : lerp(from.value, to.value, s);
    return { value, in: still, out: still };
  }

  // The glTF cubic: p(s) = h00·v0 + h10·Δ·b0 + h01·v1 + h11·Δ·a1, tangents per second.
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  const value: number[] = [];
  const slope: number[] = [];
  for (let c = 0; c < width; c++) {
    const v0 = from.value[c];
    const b0 = from.out[c] * span;
    const v1 = to.value[c];
    const a1 = to.in[c] * span;
    value.push(h00 * v0 + h10 * b0 + h01 * v1 + h11 * a1);
    slope.push((d00 * v0 + d10 * b0 + d01 * v1 + d11 * a1) / span);
  }
  return { value: track.rotation && width === 4 ? normalize(value) : value, in: slope, out: slope };
}

/** The key nearest `time`. */
function nearestKey(times: Float32Array, time: number): number {
  const at = segmentAt(times, time);
  if (at + 1 < times.length && Math.abs(times[at + 1] - time) < Math.abs(times[at] - time)) return at + 1;
  return at;
}

/** The last key at or before `time`, kept one short of the end so a segment follows it. */
function segmentAt(times: Float32Array, time: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (times[mid] <= time) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, Math.min(low, times.length - 2));
}

function lerp(a: ArrayLike<number>, b: ArrayLike<number>, s: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < a.length; c++) out.push(a[c] + (b[c] - a[c]) * s);
  return out;
}

/** The shorter way round the sphere, as three.js plays a rotation. */
function slerp(a: ArrayLike<number>, b: ArrayLike<number>, s: number): number[] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  if (dot > 0.9995) {
    return normalize([0, 1, 2, 3].map((c) => a[c] + (sign * b[c] - a[c]) * s));
  }
  const theta = Math.acos(dot);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - s) * theta) / sin;
  const wb = (sign * Math.sin(s * theta)) / sin;
  return normalize([0, 1, 2, 3].map((c) => a[c] * wa + b[c] * wb));
}

function normalize(q: number[]): number[] {
  const length = Math.hypot(...q);
  return length > 0 ? q.map((c) => c / length) : q;
}

// ---------------------------------------------------------------------------
// Reading and packing keyframe data

/** A buffer view's bytes: where they start and end, and how far apart its elements are. */
interface ViewBytes {
  bytes: Uint8Array;
  start: number;
  end: number;
  /** 0 for tightly packed. */
  stride: number;
}

/**
 * Finds the bytes behind a buffer view: in its buffer, or — for one packed with
 * meshopt — in the unpacked copy the caller made, which stands for the view.
 */
function viewReader(
  json: GltfJson,
  bytesOf: (buffer: number) => Uint8Array | null,
  unpacked: Map<number, Uint8Array>,
): (index: number) => ViewBytes {
  const missing = (buffer: number): Error => {
    const uri = json.buffers?.[buffer]?.uri;
    return new Error(
      uri && !uri.startsWith('data:')
        ? `its keyframes are in ${uri}, which was not supplied`
        : 'its keyframe data could not be read',
    );
  };
  return (index) => {
    const view = json.bufferViews?.[index];
    if (!view) throw new Error(`buffer view ${index} is missing`);
    const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : 0;
    const packed = view.extensions?.[MESHOPT] as { buffer?: number } | undefined;
    if (packed) {
      const bytes = unpacked.get(index);
      if (!bytes) throw missing(packed.buffer ?? 0);
      return { bytes, start: 0, end: bytes.byteLength, stride };
    }
    const bytes = bytesOf(view.buffer ?? 0);
    if (!bytes) throw missing(view.buffer ?? 0);
    const start = view.byteOffset ?? 0;
    const end = Math.min(bytes.byteLength, start + (view.byteLength ?? bytes.byteLength - start));
    return { bytes, start, end, stride };
  };
}

/** An accessor's values as floats, normalized integers scaled the way a loader reads them. */
function readAccessor(json: GltfJson, index: number, views: (view: number) => ViewBytes): Float32Array {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`accessor ${index} is missing`);
  const components = COMPONENTS[accessor.type ?? ''];
  if (!components) throw new Error(`accessor ${index} has an unknown type`);
  const readComponent = componentReader(accessor.componentType ?? 0, accessor.normalized === true);
  if (!readComponent.size) throw new Error(`accessor ${index} has an unknown component type`);
  const count = accessor.count ?? 0;
  // An accessor without a buffer view starts as all zeros, which is legal.
  const out = new Float32Array(count * components);
  if (accessor.bufferView !== undefined) {
    const view = views(accessor.bufferView);
    readElements(out, view, view.start + (accessor.byteOffset ?? 0), count, components, readComponent, view.stride);
  }

  // Sparse data replaces some of those elements, by index.
  const sparse = accessor.sparse as SparseData | undefined;
  const replaced = sparse?.count ?? 0;
  if (sparse && replaced > 0) {
    const { indices, values } = sparse;
    if (typeof indices?.bufferView !== 'number' || typeof values?.bufferView !== 'number') {
      throw new Error('its sparse keyframes are incomplete');
    }
    const indexReader = componentReader(indices.componentType ?? 0, false);
    if (!indexReader.size) throw new Error('its sparse keyframes have an unknown index type');
    const at = new Float32Array(replaced);
    const indexView = views(indices.bufferView);
    readElements(at, indexView, indexView.start + (indices.byteOffset ?? 0), replaced, 1, indexReader, 0);
    const swapped = new Float32Array(replaced * components);
    const valueView = views(values.bufferView);
    readElements(swapped, valueView, valueView.start + (values.byteOffset ?? 0), replaced, components, readComponent, 0);
    for (let entry = 0; entry < replaced; entry++) {
      const element = at[entry];
      if (element < 0 || element >= count) continue;
      out.set(swapped.subarray(entry * components, (entry + 1) * components), element * components);
    }
  }
  return out;
}

/** Reads `count` elements of `components` each into `out`, starting at byte `first`. */
function readElements(
  out: Float32Array,
  view: ViewBytes,
  first: number,
  count: number,
  components: number,
  reader: ReturnType<typeof componentReader>,
  stride: number,
): void {
  const elementSize = reader.size * components;
  const step = stride > 0 ? stride : elementSize;
  if (count > 0 && first + step * (count - 1) + elementSize > view.end) {
    throw new Error('its keyframe data runs past the end of its buffer');
  }
  const data = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength);
  for (let element = 0; element < count; element++) {
    const at = first + element * step;
    for (let c = 0; c < components; c++) out[element * components + c] = reader.read(data, at + c * reader.size);
  }
}

function componentReader(
  type: number,
  normalized: boolean,
): { size: number; read: (data: DataView, at: number) => number } {
  switch (type) {
    case FLOAT:
      return { size: 4, read: (data, at) => data.getFloat32(at, true) };
    case 5120:
      return { size: 1, read: (data, at) => (normalized ? Math.max(data.getInt8(at) / 127, -1) : data.getInt8(at)) };
    case 5121:
      return { size: 1, read: (data, at) => (normalized ? data.getUint8(at) / 255 : data.getUint8(at)) };
    case 5122:
      return {
        size: 2,
        read: (data, at) => (normalized ? Math.max(data.getInt16(at, true) / 32767, -1) : data.getInt16(at, true)),
      };
    case 5123:
      return {
        size: 2,
        read: (data, at) => (normalized ? data.getUint16(at, true) / 65535 : data.getUint16(at, true)),
      };
    case 5125:
      return { size: 4, read: (data, at) => data.getUint32(at, true) };
    default:
      return { size: 0, read: () => 0 };
  }
}

/** Byte blocks laid end to end, each starting on a 4-byte boundary as glTF wants. */
class Packer {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  /** Adds a block, returning where it starts. */
  add(bytes: Uint8Array): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const at = this.length;
    // Copied: the block may be a view into data that is still being read.
    this.parts.push(bytes.slice());
    this.length += bytes.byteLength;
    return at;
  }

  join(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}
