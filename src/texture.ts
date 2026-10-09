/**
 * How a material's texture is sampled — the three.js editor's texture dialog —
 * stored the only way a glTF can store it.
 *
 * three.js keeps all of it on one Texture. glTF splits it three ways:
 *
 * - wrap and filtering are the texture's sampler, so they hold for every map
 *   that uses the texture — and a sampler can be shared by other textures too
 * - the UV set and the UV transform belong to the map slot: `texCoord` and
 *   KHR_texture_transform on the material's reference to the texture
 * - colour space belongs to the slot as well, but glTF fixes it: colour maps
 *   are sRGB and data maps linear
 *
 * The editor's texture has three things glTF has no form for. Anisotropy is kept
 * in the sampler's extras, the way material.ts keeps Phong's shininess; GLTFLoader
 * does not read it, so the preview puts it on itself. A rotation centre is folded
 * into the offset — which is what makes every viewer turn the texture about it.
 * And flipY, which GLTFLoader always sets false (glTF's V runs down the image)
 * and three.js ignores for image bitmaps and KTX2 anyway, is folded into the
 * transform as V turned over. Both are remembered in the transform's extras so
 * the dialog can show them again.
 *
 * Nothing here touches three.js: `textureLook` says what the loader would set
 * on a slot's texture, and the viewer applies that.
 */
import type { GltfJson, GltfMaterial, GltfTexture, TextureInfo } from './gltf';
import { MAP_SLOTS, getMaterialTexture, type MapSlot } from './material';

// WebGL's own codes, which glTF samplers store.
const NEAREST = 9728;
export const LINEAR = 9729;
const NEAREST_MIPMAP_NEAREST = 9984;
const LINEAR_MIPMAP_NEAREST = 9985;
const NEAREST_MIPMAP_LINEAR = 9986;
const LINEAR_MIPMAP_LINEAR = 9987;
const REPEAT = 10497;
export const CLAMP_TO_EDGE = 33071;
export const MIRRORED_REPEAT = 33648;

export const WRAP_OPTIONS: [code: number, text: string][] = [
  [REPEAT, 'Repeat'],
  [CLAMP_TO_EDGE, 'Clamp to edge'],
  [MIRRORED_REPEAT, 'Mirrored repeat'],
];

export const MAG_FILTER_OPTIONS: [code: number, text: string][] = [
  [NEAREST, 'Nearest'],
  [LINEAR, 'Linear'],
];

export const MIN_FILTER_OPTIONS: [code: number, text: string][] = [
  [NEAREST, 'Nearest'],
  [LINEAR, 'Linear'],
  [NEAREST_MIPMAP_NEAREST, 'Nearest mipmap nearest'],
  [LINEAR_MIPMAP_NEAREST, 'Linear mipmap nearest'],
  [NEAREST_MIPMAP_LINEAR, 'Nearest mipmap linear'],
  [LINEAR_MIPMAP_LINEAR, 'Linear mipmap linear'],
];

/** The UV sets three.js can read a map from: TEXCOORD_0 to TEXCOORD_3. */
export const UV_SETS = 4;

/** Every map slot, for walking all of a material's textures. */
export const MAP_SLOT_NAMES = Object.keys(MAP_SLOTS) as MapSlot[];

const TRANSFORM = 'KHR_texture_transform';

/** The key in a sampler's extras that holds its anisotropy. */
export const ANISOTROPY_EXTRAS = 'anisotropy';

interface GltfSampler {
  magFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
  name?: string;
  extensions?: Record<string, unknown>;
  extras?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sampler

export interface SamplerSettings {
  wrapS: number;
  wrapT: number;
  magFilter: number;
  minFilter: number;
  anisotropy: number;
}

/**
 * What GLTFLoader uses for whatever a sampler leaves out. Wrap is the format's
 * own default; filtering is left to the viewer, and this is the loader's choice.
 */
const SAMPLER_DEFAULTS: SamplerSettings = {
  wrapS: REPEAT,
  wrapT: REPEAT,
  magFilter: LINEAR,
  minFilter: LINEAR_MIPMAP_LINEAR,
  anisotropy: 1,
};

const CODES: Record<Exclude<keyof SamplerSettings, 'anisotropy'>, number[]> = {
  wrapS: WRAP_OPTIONS.map(([code]) => code),
  wrapT: WRAP_OPTIONS.map(([code]) => code),
  magFilter: MAG_FILTER_OPTIONS.map(([code]) => code),
  minFilter: MIN_FILTER_OPTIONS.map(([code]) => code),
};

function samplers(json: GltfJson): GltfSampler[] {
  return (json.samplers ?? []) as GltfSampler[];
}

function samplerOf(json: GltfJson, texture: GltfTexture | undefined): GltfSampler | undefined {
  const index = texture?.sampler;
  return typeof index === 'number' ? samplers(json)[index] : undefined;
}

/** A texture's wrap and filtering, with the loader's defaults filled in. */
export function readSampler(json: GltfJson, textureIndex: number): SamplerSettings {
  const sampler = samplerOf(json, json.textures?.[textureIndex]);
  const code = (key: keyof typeof CODES): number => {
    const value = sampler?.[key];
    // The loader falls back on its default for a code it does not know, too.
    return typeof value === 'number' && CODES[key].includes(value) ? value : SAMPLER_DEFAULTS[key];
  };
  const anisotropy = sampler?.extras?.[ANISOTROPY_EXTRAS];
  return {
    wrapS: code('wrapS'),
    wrapT: code('wrapT'),
    magFilter: code('magFilter'),
    minFilter: code('minFilter'),
    anisotropy: typeof anisotropy === 'number' && anisotropy >= 1 ? anisotropy : 1,
  };
}

/**
 * Changes one of a texture's sampler values. A sampler other textures use as
 * well is never changed under them: the texture is pointed at a sampler that
 * already says what it needs, or a new one. One it has to itself is changed
 * where it is, so a file gains no more samplers than it has to.
 */
export function setSamplerValue(
  json: GltfJson,
  textureIndex: number,
  key: keyof SamplerSettings,
  value: number,
): void {
  const texture = json.textures?.[textureIndex];
  if (!texture) return;
  const current = samplerOf(json, texture);
  const next: GltfSampler = structuredClone(current ?? {});
  putSamplerValue(next, key, value);
  if (canonical(next) === canonical(current ?? {})) return;

  const list = samplers(json);
  const index = texture.sampler;
  const alone =
    current !== undefined && (json.textures ?? []).every((other) => other === texture || other.sampler !== index);
  if (alone && typeof index === 'number') {
    // Back to all defaults, and last in the list: as if it had never been added.
    if (Object.keys(next).length === 0 && index === list.length - 1) {
      list.pop();
      delete texture.sampler;
      if (list.length === 0) delete json.samplers;
    } else {
      list[index] = next;
    }
    return;
  }

  const same = list.findIndex((sampler) => canonical(sampler) === canonical(next));
  if (same !== -1) {
    texture.sampler = same;
  } else {
    json.samplers = [...list, next];
    texture.sampler = list.length;
  }
}

/** A value equal to what the loader assumes is left out, as material.ts leaves its defaults out. */
function putSamplerValue(sampler: GltfSampler, key: keyof SamplerSettings, value: number): void {
  if (key === 'anisotropy') {
    if (value > 1) {
      sampler.extras = { ...sampler.extras, [ANISOTROPY_EXTRAS]: value };
    } else if (sampler.extras) {
      delete sampler.extras[ANISOTROPY_EXTRAS];
      if (Object.keys(sampler.extras).length === 0) delete sampler.extras;
    }
    return;
  }
  if (value === SAMPLER_DEFAULTS[key]) delete sampler[key];
  else sampler[key] = value;
}

/** JSON with its keys sorted, so two samplers compare by what they say rather than how. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// UV set and transform

export interface UvTransform {
  /** Which TEXCOORD_n the slot reads. */
  texCoord: number;
  offset: [number, number];
  repeat: [number, number];
  /** Radians, as three.js and glTF both keep it. */
  rotation: number;
  /** What the texture turns and scales about, in UV units. */
  center: [number, number];
  /** The image upside down: V read from the other edge, after the transform. */
  flipY: boolean;
}

function transformOf(info: TextureInfo | undefined): Record<string, unknown> | undefined {
  const value = info?.extensions?.[TRANSFORM];
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function pair(value: unknown, fallback: [number, number]): [number, number] {
  return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number'
    ? [value[0], value[1]]
    : [fallback[0], fallback[1]];
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The UV set a slot reads: the transform's override wins, as it does in the loader. */
function texCoordOf(info: TextureInfo | undefined): number {
  return number(transformOf(info)?.texCoord, number(info?.texCoord, 0));
}

/**
 * What turning and scaling about `center` adds to the offset, compared with
 * doing it about the corner — three.js's Matrix3.setUvTransform, less the part
 * a centre at the corner would give too.
 */
function pivotShift(center: [number, number], repeat: [number, number], rotation: number): [number, number] {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [
    center[0] - repeat[0] * (cos * center[0] + sin * center[1]),
    center[1] - repeat[1] * (-sin * center[0] + cos * center[1]),
  ];
}

/**
 * A slot's UV set and transform, in the editor's terms: the offset as typed,
 * before the centre's part, and the repeat before the flip's.
 */
export function readUvTransform(material: GltfMaterial, slot: MapSlot): UvTransform {
  const info = getMaterialTexture(material, slot);
  const transform = transformOf(info);
  const stored = pair(transform?.offset, [0, 0]);
  const repeat = pair(transform?.scale, [1, 1]);
  const rotation = number(transform?.rotation, 0);
  const extras = transform?.extras as Record<string, unknown> | undefined;
  const center = pair(extras?.center, [0, 0]);
  const flipY = extras?.flipY === true;
  if (flipY) {
    stored[1] = 1 - stored[1];
    repeat[1] = -repeat[1];
  }
  const shift = pivotShift(center, repeat, rotation);
  return {
    texCoord: texCoordOf(info),
    offset: [stored[0] - shift[0], stored[1] - shift[1]],
    repeat,
    rotation,
    center,
    flipY,
  };
}

/**
 * Writes a slot's UV set and transform. The offset stored is the one that turns
 * the texture about the centre, and a flip is stored as the transform doing it,
 * so every viewer shows what the dialog did; with nothing left to transform,
 * the extension goes altogether.
 */
export function setUvTransform(json: GltfJson, material: GltfMaterial, slot: MapSlot, uv: UvTransform): void {
  const info = getMaterialTexture(material, slot);
  if (!info) return;

  if (uv.texCoord === 0) delete info.texCoord;
  else info.texCoord = uv.texCoord;

  const transform: Record<string, unknown> = { ...transformOf(info) };
  // The slot's own texCoord says it now, for viewers without the extension too.
  delete transform.texCoord;
  const shift = pivotShift(uv.center, uv.repeat, uv.rotation);
  const offset: [number, number] = [uv.offset[0] + shift[0], uv.offset[1] + shift[1]];
  const repeat: [number, number] = [uv.repeat[0], uv.repeat[1]];
  // three.js reads the transformed V as is (Matrix3.setUvTransform), so V
  // turned over last — 1 - v — is offset.y to 1 - y and scale.y negated.
  if (uv.flipY) {
    offset[1] = 1 - offset[1];
    repeat[1] = -repeat[1];
  }
  putTransformValue(transform, 'offset', offset.map(tidy), [0, 0]);
  putTransformValue(transform, 'scale', repeat.map(tidy), [1, 1]);
  putTransformValue(transform, 'rotation', tidy(uv.rotation), 0);

  const extras: Record<string, unknown> = { ...(transform.extras as Record<string, unknown> | undefined) };
  // A centre only means something to a rotation or a repeat — the flip's own scale aside.
  const moves = uv.repeat.some((value) => tidy(value) !== 1) || tidy(uv.rotation) !== 0;
  if (moves && (uv.center[0] !== 0 || uv.center[1] !== 0)) extras.center = uv.center.map(tidy);
  else delete extras.center;
  if (uv.flipY) extras.flipY = true;
  else delete extras.flipY;
  if (Object.keys(extras).length > 0) transform.extras = extras;
  else delete transform.extras;

  const extensions = { ...info.extensions };
  if (Object.keys(transform).length > 0) extensions[TRANSFORM] = transform;
  else delete extensions[TRANSFORM];
  if (Object.keys(extensions).length > 0) info.extensions = extensions;
  else delete info.extensions;

  syncTransformUsed(json);
}

function putTransformValue(
  transform: Record<string, unknown>,
  key: string,
  value: number | number[],
  fallback: number | number[],
): void {
  const same =
    Array.isArray(value) && Array.isArray(fallback)
      ? value.every((entry, at) => entry === fallback[at])
      : value === fallback;
  if (same) delete transform[key];
  else transform[key] = value;
}

/** Transforms are stored to six places, like material colours: plenty, and a diff stays readable. */
function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Keeps KHR_texture_transform declared exactly while something uses it. The
 * loader only honours it when it is declared, and validators flag it declared
 * and unused.
 */
function syncTransformUsed(json: GltfJson): void {
  const used = (json.materials ?? []).some(usesTransform);
  const declared = json.extensionsUsed ?? [];
  if (used && !declared.includes(TRANSFORM)) {
    json.extensionsUsed = [...declared, TRANSFORM];
  } else if (!used && declared.includes(TRANSFORM)) {
    const next = declared.filter((name) => name !== TRANSFORM);
    if (next.length > 0) json.extensionsUsed = next;
    else delete json.extensionsUsed;
    const required = json.extensionsRequired?.filter((name) => name !== TRANSFORM);
    if (required && required.length > 0) json.extensionsRequired = required;
    else delete json.extensionsRequired;
  }
}

/** Anywhere in a material: its extensions hold textures of their own, some of which no slot here names. */
function usesTransform(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const extensions = record.extensions as Record<string, unknown> | undefined;
  if (extensions && typeof extensions === 'object' && extensions[TRANSFORM] !== undefined) return true;
  return Object.values(record).some(usesTransform);
}

// ---------------------------------------------------------------------------
// What the preview shows

/** A slot's texture as GLTFLoader would set it up, sampler codes and all. */
export interface TextureLook extends SamplerSettings {
  channel: number;
  /** As the loader sets them: the stored offset, turned about the corner. */
  offset: [number, number];
  repeat: [number, number];
  rotation: number;
}

export function textureLook(json: GltfJson, material: GltfMaterial, slot: MapSlot): TextureLook | null {
  const info = getMaterialTexture(material, slot);
  if (!info) return null;
  // The loader ignores the transform of a file that does not declare it.
  const transform = json.extensionsUsed?.includes(TRANSFORM) ? transformOf(info) : undefined;
  return {
    ...readSampler(json, info.index),
    channel: transform ? texCoordOf(info) : number(info.texCoord, 0),
    offset: pair(transform?.offset, [0, 0]),
    repeat: pair(transform?.scale, [1, 1]),
    rotation: number(transform?.rotation, 0),
  };
}

/** The extensions that point a texture at an image of their own, in the order GLTFLoader tries them. */
const IMAGE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'];

/**
 * The image a texture shows. An extension's image wins over the plain `source`,
 * as it does in the loader, which every browser it runs in can decode.
 */
export function textureImage(json: GltfJson, textureIndex: number): number | undefined {
  const texture = json.textures?.[textureIndex];
  for (const name of IMAGE_EXTENSIONS) {
    const source = (texture?.extensions?.[name] as { source?: unknown } | undefined)?.source;
    if (typeof source === 'number') return source;
  }
  return texture?.source;
}

/** Every map slot, in every material, that shows a texture. */
export function textureUsers(json: GltfJson, textureIndex: number): { material: number; slot: MapSlot }[] {
  const users: { material: number; slot: MapSlot }[] = [];
  (json.materials ?? []).forEach((material, index) => {
    for (const slot of MAP_SLOT_NAMES) {
      if (getMaterialTexture(material, slot)?.index === textureIndex) users.push({ material: index, slot });
    }
  });
  return users;
}
