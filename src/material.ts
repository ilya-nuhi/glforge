/**
 * Materials the way the three.js editor shows them, stored the only way a glTF
 * can store them.
 *
 * glTF has a single material model — metallic-roughness PBR — and GLTFLoader
 * turns it into one of three three.js types, depending on the extensions the
 * material carries:
 *
 * - `KHR_materials_unlit` → MeshBasicMaterial
 * - any of the extensions that need the physical shader (clearcoat, sheen,
 *   transmission, IOR…) → MeshPhysicalMaterial
 * - neither → MeshStandardMaterial
 *
 * So a material's type is read off its extensions and changed by adding or
 * removing them, and every parameter the panel offers is one key somewhere in
 * the material's JSON — which is what gets downloaded.
 *
 * The editor's other types (Lambert, Phong, Toon…) have no glTF form at all.
 * They are kept in the material's extras instead — `extras.threeMaterial`, with
 * the type's name and any value only it has, like Phong's shininess or a shader
 * material's source — over a plain metallic-roughness material, which is what
 * any other viewer shows.
 * GLTFLoader hands extras over as `material.userData`, so code loading the file
 * can rebuild the type from there; the preview does just that.
 *
 * Nothing here touches three.js: `materialLook` says what the loader would build
 * from the JSON, in its property names, and the viewer applies that.
 */
import type { GltfJson, GltfMaterial, TextureInfo } from './gltf';

export type Rgb = [number, number, number];

export type MaterialType =
  | 'MeshBasicMaterial'
  | 'MeshDepthMaterial'
  | 'MeshNormalMaterial'
  | 'MeshLambertMaterial'
  | 'MeshMatcapMaterial'
  | 'MeshPhongMaterial'
  | 'MeshToonMaterial'
  | 'MeshStandardMaterial'
  | 'MeshPhysicalMaterial'
  | 'RawShaderMaterial'
  | 'ShaderMaterial'
  | 'ShadowMaterial';

/** The editor's mesh material types, in the order it lists them. */
export const MATERIAL_TYPES: MaterialType[] = [
  'MeshBasicMaterial',
  'MeshDepthMaterial',
  'MeshNormalMaterial',
  'MeshLambertMaterial',
  'MeshMatcapMaterial',
  'MeshPhongMaterial',
  'MeshToonMaterial',
  'MeshStandardMaterial',
  'MeshPhysicalMaterial',
  'RawShaderMaterial',
  'ShaderMaterial',
  'ShadowMaterial',
];

/** The types glTF itself can hold. Every other one is kept in extras. */
const GLTF_TYPES: MaterialType[] = ['MeshBasicMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial'];

export function isGltfType(type: MaterialType): boolean {
  return GLTF_TYPES.includes(type);
}

/** The key in a material's extras that holds a type glTF has no form for. */
export const THREE_EXTRAS = 'threeMaterial';

/** Where a value kept in `extras.threeMaterial` lives, for `holder`. */
const EXTRAS = 'extras';

/**
 * Values only one of the extras types has, kept beside its name. A type change
 * drops the ones the new type does not have, the way Standard drops clearcoat.
 */
const EXTRAS_PARAMS: Record<string, { label: string; types: MaterialType[] }> = {
  specular: { label: 'specular', types: ['MeshPhongMaterial'] },
  shininess: { label: 'shininess', types: ['MeshPhongMaterial'] },
  depthPacking: { label: 'depth packing', types: ['MeshDepthMaterial'] },
  color: { label: 'shadow colour', types: ['ShadowMaterial'] },
  vertexShader: { label: 'vertex shader', types: ['ShaderMaterial', 'RawShaderMaterial'] },
  fragmentShader: { label: 'fragment shader', types: ['ShaderMaterial', 'RawShaderMaterial'] },
};

/** MeshPhongMaterial's own specular, 0x111111, as the linear colour it renders with. */
const PHONG_SPECULAR: Rgb = [0.005605, 0.005605, 0.005605];

/** ShaderMaterial's own shaders: position through the matrices three.js provides, in red. */
const SHADER_VERTEX = 'void main() {\n\tgl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );\n}\n';
const SHADER_FRAGMENT = 'void main() {\n\tgl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );\n}\n';

/**
 * RawShaderMaterial gets no prelude at all, so its shaders declare what they use
 * — the uniforms and attribute the editor adds, and the float precision a GLSL
 * ES 1.0 fragment shader cannot compile without.
 */
const RAW_VERTEX =
  'uniform mat4 projectionMatrix;\nuniform mat4 modelViewMatrix;\n\nattribute vec3 position;\n\n' + SHADER_VERTEX;
const RAW_FRAGMENT = 'precision highp float;\n\n' + SHADER_FRAGMENT;

/** The source a shader material starts with, for whichever of the two it is. */
function defaultShader(material: GltfMaterial, stage: 'vertex' | 'fragment'): string {
  const raw = materialType(material) === 'RawShaderMaterial';
  if (stage === 'vertex') return raw ? RAW_VERTEX : SHADER_VERTEX;
  return raw ? RAW_FRAGMENT : SHADER_FRAGMENT;
}

/** three.js's depth packings, by the constant names code loading the file would look up. */
const DEPTH_PACKINGS: Record<string, number> = { BasicDepthPacking: 3200, RGBADepthPacking: 3201 };

const UNLIT = 'KHR_materials_unlit';
const EMISSIVE_STRENGTH = 'KHR_materials_emissive_strength';
const CLEARCOAT = 'KHR_materials_clearcoat';
const DISPERSION = 'KHR_materials_dispersion';
const IOR = 'KHR_materials_ior';
const IRIDESCENCE = 'KHR_materials_iridescence';
const SHEEN = 'KHR_materials_sheen';
const SPECULAR = 'KHR_materials_specular';
const TRANSMISSION = 'KHR_materials_transmission';
const VOLUME = 'KHR_materials_volume';
const ANISOTROPY = 'KHR_materials_anisotropy';

/** Extensions GLTFLoader answers with a MeshPhysicalMaterial. */
const PHYSICAL_EXTENSIONS = [
  CLEARCOAT,
  DISPERSION,
  IOR,
  IRIDESCENCE,
  SHEEN,
  SPECULAR,
  TRANSMISSION,
  VOLUME,
  ANISOTROPY,
  'EXT_materials_bump',
];

/** Every material extension this module adds and removes, and so keeps declared. */
const MANAGED_EXTENSIONS = [UNLIT, EMISSIVE_STRENGTH, ...PHYSICAL_EXTENSIONS];

/** What each physical extension is called when a type change has to drop it. */
const EXTENSION_LABELS: Record<string, string> = {
  [CLEARCOAT]: 'clearcoat',
  [DISPERSION]: 'dispersion',
  [IOR]: 'IOR',
  [IRIDESCENCE]: 'iridescence',
  [SHEEN]: 'sheen',
  [SPECULAR]: 'specular',
  [TRANSMISSION]: 'transmission',
  [VOLUME]: 'volume',
  [ANISOTROPY]: 'anisotropy',
  EXT_materials_bump: 'bump',
};

// ---------------------------------------------------------------------------
// Type

export function materialType(material: GltfMaterial): MaterialType {
  // A type kept in extras is the one asked for; the glTF under it is its fallback.
  const kept = threeExtras(material)?.type;
  if (typeof kept === 'string' && MATERIAL_TYPES.includes(kept as MaterialType) && !isGltfType(kept as MaterialType)) {
    return kept as MaterialType;
  }
  const extensions = material.extensions ?? {};
  // The loader checks unlit first, and ignores everything physical under it.
  if (extensions[UNLIT] !== undefined) return 'MeshBasicMaterial';
  return isPhysical(material) ? 'MeshPhysicalMaterial' : 'MeshStandardMaterial';
}

function isPhysical(material: GltfMaterial): boolean {
  const extensions = material.extensions;
  return extensions !== undefined && PHYSICAL_EXTENSIONS.some((name) => extensions[name] !== undefined);
}

/** The material's `extras.threeMaterial`, when it is an object. */
function threeExtras(material: GltfMaterial): Record<string, unknown> | undefined {
  const value = material.extras?.[THREE_EXTRAS];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Makes a material load as another three.js type. Returns what had to be
 * dropped for it, so the caller can say so.
 *
 * Basic keeps everything else the material had: the unlit extension's own spec
 * asks for the PBR properties to stay, as the fallback for viewers that do not
 * know it — and it makes Physical → Basic → Physical lossless. Standard is the
 * only one with something to lose, since a physical extension is exactly what
 * would make it load as Physical again.
 *
 * The types glTF has no form for sit on a Standard material, which is what
 * everything but code reading the extras will draw — so they lose what Standard
 * does, plus whatever only the previous extras type had.
 */
export function setMaterialType(json: GltfJson, material: GltfMaterial, type: MaterialType): string[] {
  const dropped = setThreeType(material, type);
  dropped.push(...setGltfType(material, isGltfType(type) ? type : 'MeshStandardMaterial'));
  // ShadowMaterial is transparent unless told otherwise — it is only the shadow
  // — and Blend is how glTF says transparent.
  if (type === 'ShadowMaterial' && material.alphaMode !== 'BLEND') {
    material.alphaMode = 'BLEND';
    delete material.alphaCutoff;
  }
  syncExtensionsUsed(json);
  return dropped;
}

/** Writes an extras type, or clears it for one of glTF's own. */
function setThreeType(material: GltfMaterial, type: MaterialType): string[] {
  const dropped: string[] = [];
  const next: Record<string, unknown> = {};
  if (!isGltfType(type)) next.type = type;
  for (const [key, value] of Object.entries(threeExtras(material) ?? {})) {
    if (key === 'type') continue;
    const param = EXTRAS_PARAMS[key];
    if (!param || param.types.includes(type)) next[key] = value;
    else dropped.push(param.label);
  }

  if (next.type !== undefined) {
    material.extras = { ...material.extras, [THREE_EXTRAS]: next };
  } else if (material.extras && THREE_EXTRAS in material.extras) {
    delete material.extras[THREE_EXTRAS];
    if (Object.keys(material.extras).length === 0) delete material.extras;
  }
  return dropped;
}

function setGltfType(material: GltfMaterial, type: MaterialType): string[] {
  const dropped: string[] = [];
  const extensions = (material.extensions ??= {});
  if (type === 'MeshBasicMaterial') {
    extensions[UNLIT] = {};
  } else {
    delete extensions[UNLIT];
    if (type === 'MeshStandardMaterial') {
      for (const name of PHYSICAL_EXTENSIONS) {
        if (extensions[name] === undefined) continue;
        // An empty IOR is only there to make the material physical: nothing is lost.
        if (!(name === IOR && Object.keys(extensions[name] as object).length === 0)) {
          dropped.push(EXTENSION_LABELS[name] ?? name);
        }
        delete extensions[name];
      }
    } else if (!isPhysical(material)) {
      // IOR 1.5 is what the standard shader assumes anyway, so declaring it
      // changes nothing about the look — it only asks for the physical shader.
      extensions[IOR] = {};
    }
  }
  if (Object.keys(extensions).length === 0) delete material.extensions;
  return dropped;
}

/**
 * Keeps `extensionsUsed` saying which material extensions the file uses. The
 * loader only honours KHR_materials_unlit when it is declared there, and an
 * extension declared but used by nothing is flagged by validators. Extensions
 * this module never writes are left exactly as they were.
 */
function syncExtensionsUsed(json: GltfJson): void {
  const used = new Set<string>();
  for (const material of json.materials ?? []) {
    for (const name of Object.keys(material.extensions ?? {})) used.add(name);
  }
  const declared = json.extensionsUsed ?? [];
  const next = declared.filter((name) => !MANAGED_EXTENSIONS.includes(name) || used.has(name));
  for (const name of MANAGED_EXTENSIONS) {
    if (used.has(name) && !next.includes(name)) next.push(name);
  }
  const changed = next.length !== declared.length || next.some((name, at) => name !== declared[at]);
  if (changed) {
    if (next.length > 0) json.extensionsUsed = next;
    else delete json.extensionsUsed;
  }
  // Required is a subset of used: an extension that is gone is not required either.
  if (json.extensionsRequired) {
    const required = json.extensionsRequired.filter((name) => !MANAGED_EXTENSIONS.includes(name) || used.has(name));
    if (required.length !== json.extensionsRequired.length) {
      if (required.length > 0) json.extensionsRequired = required;
      else delete json.extensionsRequired;
    }
  }
}

// ---------------------------------------------------------------------------
// Where a value lives
//
// On the material itself, on its pbrMetallicRoughness, or inside one of its
// extensions. A value equal to what the format assumes is left out rather than
// written, and a holder left empty goes with it — so a slider dragged away and
// back leaves the file as it found it.

/** `material`, `pbr`, `extras`, or the name of the extension that holds the value. */
type Place = string;

function holder(material: GltfMaterial, at: Place, create: true): Record<string, unknown>;
function holder(material: GltfMaterial, at: Place, create: false): Record<string, unknown> | undefined;
function holder(material: GltfMaterial, at: Place, create: boolean): Record<string, unknown> | undefined {
  if (at === 'material') return material as unknown as Record<string, unknown>;
  if (at === EXTRAS) {
    if (!create) return threeExtras(material);
    const extras = (material.extras ??= {});
    if (!threeExtras(material)) extras[THREE_EXTRAS] = {};
    return extras[THREE_EXTRAS] as Record<string, unknown>;
  }
  if (at === 'pbr') {
    const pbr = create ? (material.pbrMetallicRoughness ??= {}) : material.pbrMetallicRoughness;
    return pbr as unknown as Record<string, unknown> | undefined;
  }
  if (create) {
    const extensions = (material.extensions ??= {});
    extensions[at] ??= {};
    return extensions[at] as Record<string, unknown>;
  }
  return material.extensions?.[at] as Record<string, unknown> | undefined;
}

/**
 * Drops a holder that has nothing left in it. Unlit is empty by nature, so it
 * stays — and the extras always hold their type's name while it is in use.
 */
function tidy(material: GltfMaterial, at: Place): void {
  if (at === 'material' || at === UNLIT || at === EXTRAS) return;
  if (at === 'pbr') {
    if (material.pbrMetallicRoughness && Object.keys(material.pbrMetallicRoughness).length === 0) {
      delete material.pbrMetallicRoughness;
    }
    return;
  }
  const extensions = material.extensions;
  const extension = extensions?.[at] as object | undefined;
  if (extensions && extension && Object.keys(extension).length === 0) delete extensions[at];
  if (extensions && Object.keys(extensions).length === 0) delete material.extensions;
}

/**
 * A physical material whose last extension just emptied out would load as
 * Standard, which nobody asked for: an empty IOR keeps it what it was.
 */
function keepPhysical(material: GltfMaterial, wasPhysical: boolean): void {
  if (wasPhysical && materialType(material) !== 'MeshBasicMaterial' && !isPhysical(material)) {
    (material.extensions ??= {})[IOR] = {};
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, at) => value === b[at]);
  }
  return a === b;
}

function writeKey(json: GltfJson, material: GltfMaterial, at: Place, key: string, value: unknown, fallback: unknown): void {
  const wasPhysical = isPhysical(material);
  if (sameValue(value, fallback)) {
    const host = holder(material, at, false);
    if (host && key in host) {
      delete host[key];
      tidy(material, at);
    }
  } else {
    holder(material, at, true)[key] = value;
  }
  keepPhysical(material, wasPhysical);
  syncExtensionsUsed(json);
}

function readNumber(material: GltfMaterial, at: Place, key: string, fallback: number): number {
  const value = holder(material, at, false)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readRgb(material: GltfMaterial, at: Place, key: string, fallback: Rgb): Rgb {
  const value = holder(material, at, false)?.[key];
  return isNumbers(value, 3) ? [value[0], value[1], value[2]] : [...fallback];
}

function isNumbers(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length >= length && value.slice(0, length).every((n) => typeof n === 'number');
}

/** Linear colour channels are stored to six places: plenty, and a diff stays readable. */
function tidyNumber(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Texture slots

export type MapSlot =
  | 'baseColor'
  | 'metallicRoughness'
  | 'normal'
  | 'occlusion'
  | 'emissive'
  | 'clearcoat'
  | 'clearcoatRoughness'
  | 'clearcoatNormal'
  | 'sheenColor'
  | 'sheenRoughness'
  | 'transmission'
  | 'thickness'
  | 'specular'
  | 'specularColor'
  | 'iridescence'
  | 'iridescenceThickness'
  | 'anisotropy';

export interface MapSlotSpec {
  slot: MapSlot;
  label: string;
  hint: string;
  at: Place;
  key: string;
  /** The three.js material properties the texture is bound to. */
  maps: string[];
  /** Colour textures are sRGB; every data texture is read as it is. */
  srgb: boolean;
  /**
   * The factor the texture is multiplied by. When that is zero (or black) the
   * texture could not show at all, so binding one lifts it to one (or white).
   */
  lift?: { at: Place; key: string; zero: number | Rgb; one: number | Rgb; message: string };
}

export const MAP_SLOTS: Record<MapSlot, MapSlotSpec> = {
  baseColor: {
    slot: 'baseColor',
    label: 'Map',
    hint: 'Colour, and alpha when the material is blended or masked.',
    at: 'pbr',
    key: 'baseColorTexture',
    maps: ['map'],
    srgb: true,
  },
  metallicRoughness: {
    slot: 'metallicRoughness',
    label: 'Metal/rough',
    hint: 'Roughness in green, metalness in blue — one texture for both.',
    at: 'pbr',
    key: 'metallicRoughnessTexture',
    maps: ['metalnessMap', 'roughnessMap'],
    srgb: false,
  },
  normal: {
    slot: 'normal',
    label: 'Normal map',
    hint: 'Tangent-space normal map.',
    at: 'material',
    key: 'normalTexture',
    maps: ['normalMap'],
    srgb: false,
  },
  occlusion: {
    slot: 'occlusion',
    label: 'AO map',
    hint: 'Ambient occlusion, read from red.',
    at: 'material',
    key: 'occlusionTexture',
    maps: ['aoMap'],
    srgb: false,
  },
  emissive: {
    slot: 'emissive',
    label: 'Emissive map',
    hint: 'Light the surface gives off by itself, multiplied by the emissive colour.',
    at: 'material',
    key: 'emissiveTexture',
    maps: ['emissiveMap'],
    srgb: true,
    lift: {
      at: 'material',
      key: 'emissiveFactor',
      zero: [0, 0, 0],
      one: [1, 1, 1],
      message: 'Emissive colour set to white, so the texture is visible.',
    },
  },
  clearcoat: {
    slot: 'clearcoat',
    label: 'Map',
    hint: 'Clearcoat amount, read from red.',
    at: CLEARCOAT,
    key: 'clearcoatTexture',
    maps: ['clearcoatMap'],
    srgb: false,
    lift: { at: CLEARCOAT, key: 'clearcoatFactor', zero: 0, one: 1, message: 'Clearcoat set to 1, so the texture is visible.' },
  },
  clearcoatRoughness: {
    slot: 'clearcoatRoughness',
    label: 'Rough. map',
    hint: 'Clearcoat roughness, read from green.',
    at: CLEARCOAT,
    key: 'clearcoatRoughnessTexture',
    maps: ['clearcoatRoughnessMap'],
    srgb: false,
    lift: {
      at: CLEARCOAT,
      key: 'clearcoatRoughnessFactor',
      zero: 0,
      one: 1,
      message: 'Clearcoat roughness set to 1, so the texture is visible.',
    },
  },
  clearcoatNormal: {
    slot: 'clearcoatNormal',
    label: 'Normal map',
    hint: 'A normal map for the clearcoat layer alone.',
    at: CLEARCOAT,
    key: 'clearcoatNormalTexture',
    maps: ['clearcoatNormalMap'],
    srgb: false,
  },
  sheenColor: {
    slot: 'sheenColor',
    label: 'Color map',
    hint: 'Sheen colour, multiplied by the sheen colour above.',
    at: SHEEN,
    key: 'sheenColorTexture',
    maps: ['sheenColorMap'],
    srgb: true,
    lift: { at: SHEEN, key: 'sheenColorFactor', zero: [0, 0, 0], one: [1, 1, 1], message: 'Sheen colour set to white, so the texture is visible.' },
  },
  sheenRoughness: {
    slot: 'sheenRoughness',
    label: 'Rough. map',
    hint: 'Sheen roughness, read from alpha.',
    at: SHEEN,
    key: 'sheenRoughnessTexture',
    maps: ['sheenRoughnessMap'],
    srgb: false,
    lift: { at: SHEEN, key: 'sheenRoughnessFactor', zero: 0, one: 1, message: 'Sheen roughness set to 1, so the texture is visible.' },
  },
  transmission: {
    slot: 'transmission',
    label: 'Map',
    hint: 'How much light passes through, read from red.',
    at: TRANSMISSION,
    key: 'transmissionTexture',
    maps: ['transmissionMap'],
    srgb: false,
    lift: { at: TRANSMISSION, key: 'transmissionFactor', zero: 0, one: 1, message: 'Transmission set to 1, so the texture is visible.' },
  },
  thickness: {
    slot: 'thickness',
    label: 'Thick. map',
    hint: 'Volume thickness, read from green.',
    at: VOLUME,
    key: 'thicknessTexture',
    maps: ['thicknessMap'],
    srgb: false,
    lift: { at: VOLUME, key: 'thicknessFactor', zero: 0, one: 1, message: 'Thickness set to 1, so the texture is visible.' },
  },
  specular: {
    slot: 'specular',
    label: 'Int. map',
    hint: 'Specular intensity, read from alpha.',
    at: SPECULAR,
    key: 'specularTexture',
    maps: ['specularIntensityMap'],
    srgb: false,
    lift: { at: SPECULAR, key: 'specularFactor', zero: 0, one: 1, message: 'Specular intensity set to 1, so the texture is visible.' },
  },
  specularColor: {
    slot: 'specularColor',
    label: 'Color map',
    hint: 'Specular colour, multiplied by the specular colour above.',
    at: SPECULAR,
    key: 'specularColorTexture',
    maps: ['specularColorMap'],
    srgb: true,
    lift: {
      at: SPECULAR,
      key: 'specularColorFactor',
      zero: [0, 0, 0],
      one: [1, 1, 1],
      message: 'Specular colour set to white, so the texture is visible.',
    },
  },
  iridescence: {
    slot: 'iridescence',
    label: 'Map',
    hint: 'Iridescence amount, read from red.',
    at: IRIDESCENCE,
    key: 'iridescenceTexture',
    maps: ['iridescenceMap'],
    srgb: false,
    lift: { at: IRIDESCENCE, key: 'iridescenceFactor', zero: 0, one: 1, message: 'Iridescence set to 1, so the texture is visible.' },
  },
  iridescenceThickness: {
    slot: 'iridescenceThickness',
    label: 'Thick. map',
    hint: 'Thin-film thickness between the minimum and maximum, read from green.',
    at: IRIDESCENCE,
    key: 'iridescenceThicknessTexture',
    maps: ['iridescenceThicknessMap'],
    srgb: false,
  },
  anisotropy: {
    slot: 'anisotropy',
    label: 'Map',
    hint: 'Direction in red and green, strength in blue.',
    at: ANISOTROPY,
    key: 'anisotropyTexture',
    maps: ['anisotropyMap'],
    srgb: false,
    lift: { at: ANISOTROPY, key: 'anisotropyStrength', zero: 0, one: 1, message: 'Anisotropy set to 1, so the texture is visible.' },
  },
};

export function getMaterialTexture(material: GltfMaterial, slot: MapSlot): TextureInfo | undefined {
  const spec = MAP_SLOTS[slot];
  const info = holder(material, spec.at, false)?.[spec.key] as TextureInfo | undefined;
  return info && typeof info.index === 'number' ? info : undefined;
}

/**
 * Points a slot at a texture, or clears it with `null`. Any extra keys the slot
 * already carried (`texCoord`, `scale`, a KHR_texture_transform) are kept, so
 * re-pointing a slot at a different image does not quietly drop its settings.
 * Returns what else had to change for the texture to show, if anything did.
 */
export function setMaterialTexture(
  json: GltfJson,
  material: GltfMaterial,
  slot: MapSlot,
  index: number | null,
): { lifted: string | null } {
  const spec = MAP_SLOTS[slot];
  const wasPhysical = isPhysical(material);
  let lifted: string | null = null;
  if (index === null) {
    const host = holder(material, spec.at, false);
    if (host) {
      delete host[spec.key];
      tidy(material, spec.at);
    }
  } else {
    const host = holder(material, spec.at, true);
    host[spec.key] = { ...(host[spec.key] as TextureInfo | undefined), index };
    const lift = spec.lift;
    if (lift) {
      const current = holder(material, lift.at, false)?.[lift.key] ?? lift.zero;
      const isZero = Array.isArray(current) ? current.every((channel) => channel === 0) : current === 0;
      if (isZero) {
        holder(material, lift.at, true)[lift.key] = Array.isArray(lift.one) ? [...lift.one] : lift.one;
        lifted = lift.message;
      }
    }
  }
  keepPhysical(material, wasPhysical);
  syncExtensionsUsed(json);
  return { lifted };
}

// ---------------------------------------------------------------------------
// Parameters

interface ParamBase {
  id: string;
  label: string;
  hint: string;
  /** Only some parameters are there for a given material — alpha test under Mask, say. */
  shown?: (material: GltfMaterial) => boolean;
}

export interface NumberParam extends ParamBase {
  kind: 'number';
  step: number;
  min?: number;
  max?: number;
  /** Stored in radians, typed in degrees. */
  degrees?: boolean;
  get(material: GltfMaterial): number;
  set(json: GltfJson, material: GltfMaterial, value: number): void;
}

export interface ColorParam extends ParamBase {
  kind: 'color';
  /** Linear RGB, the way glTF stores colour factors. */
  get(material: GltfMaterial): Rgb;
  set(json: GltfJson, material: GltfMaterial, value: Rgb): void;
}

export interface ChoiceParam extends ParamBase {
  kind: 'choice';
  options: [value: string, text: string][];
  get(material: GltfMaterial): string;
  set(json: GltfJson, material: GltfMaterial, value: string): void;
  /** Other rows depend on it, so the panel is rebuilt when it changes. */
  rebuilds?: boolean;
}

export interface TextParam extends ParamBase {
  kind: 'text';
  get(material: GltfMaterial): string;
  set(json: GltfJson, material: GltfMaterial, value: string): void;
}

export type MaterialParam = NumberParam | ColorParam | ChoiceParam | TextParam;

function numberParam(
  id: string,
  label: string,
  hint: string,
  at: Place,
  key: string,
  fallback: number,
  range: { step: number; min?: number; max?: number; degrees?: boolean },
): NumberParam {
  return {
    id,
    label,
    hint,
    kind: 'number',
    ...range,
    get: (material) => readNumber(material, at, key, fallback),
    set: (json, material, value) => writeKey(json, material, at, key, value, fallback),
  };
}

function colorParam(id: string, label: string, hint: string, at: Place, key: string, fallback: Rgb): ColorParam {
  return {
    id,
    label,
    hint,
    kind: 'color',
    get: (material) => readRgb(material, at, key, fallback),
    set: (json, material, value) => writeKey(json, material, at, key, value.map(tidyNumber), fallback),
  };
}

/** A number kept on a texture reference: a normal map's scale, an AO map's strength. */
function textureAmount(id: string, label: string, hint: string, slot: MapSlot, key: 'scale' | 'strength'): NumberParam {
  return {
    id,
    label,
    hint,
    kind: 'number',
    step: 0.01,
    ...(key === 'strength' ? { min: 0, max: 1 } : {}),
    // It is part of the texture reference, so there is none without a texture.
    shown: (material) => getMaterialTexture(material, slot) !== undefined,
    get: (material) => getMaterialTexture(material, slot)?.[key] ?? 1,
    set: (_json, material, value) => {
      const info = getMaterialTexture(material, slot);
      if (!info) return;
      if (value === 1) delete info[key];
      else info[key] = value;
    },
  };
}

function baseColorFactor(material: GltfMaterial): [number, number, number, number] {
  const factor = material.pbrMetallicRoughness?.baseColorFactor;
  return isNumbers(factor, 4) ? [factor[0], factor[1], factor[2], factor[3]] : [1, 1, 1, 1];
}

const color: ColorParam = {
  id: 'color',
  label: 'Color',
  hint: 'The base colour, multiplied into the map. pbrMetallicRoughness.baseColorFactor',
  kind: 'color',
  get: (material) => baseColorFactor(material).slice(0, 3) as Rgb,
  set: (json, material, value) => {
    const alpha = baseColorFactor(material)[3];
    writeKey(json, material, 'pbr', 'baseColorFactor', [...value.map(tidyNumber), alpha], [1, 1, 1, 1]);
  },
};

const opacity: NumberParam = {
  id: 'opacity',
  label: 'Opacity',
  hint: 'Alpha of the base colour; only Blend and Mask read it. pbrMetallicRoughness.baseColorFactor[3]',
  kind: 'number',
  step: 0.01,
  min: 0,
  max: 1,
  get: (material) => baseColorFactor(material)[3],
  set: (json, material, value) => {
    const [r, g, b] = baseColorFactor(material);
    writeKey(json, material, 'pbr', 'baseColorFactor', [r, g, b, value], [1, 1, 1, 1]);
  },
};

const side: ChoiceParam = {
  id: 'side',
  label: 'Side',
  hint: 'Whether the back of each face is drawn too. doubleSided',
  kind: 'choice',
  options: [
    ['front', 'Front'],
    ['double', 'Double'],
  ],
  get: (material) => (material.doubleSided === true ? 'double' : 'front'),
  set: (_json, material, value) => {
    if (value === 'double') material.doubleSided = true;
    else delete material.doubleSided;
  },
};

export type AlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

function alphaModeOf(material: GltfMaterial): AlphaMode {
  return material.alphaMode === 'MASK' || material.alphaMode === 'BLEND' ? material.alphaMode : 'OPAQUE';
}

const alphaMode: ChoiceParam = {
  id: 'alphaMode',
  label: 'Alpha mode',
  hint: 'Opaque ignores alpha, Mask cuts it off at the alpha test (alphaTest), Blend draws it see-through (transparent). alphaMode',
  kind: 'choice',
  options: [
    ['OPAQUE', 'Opaque'],
    ['MASK', 'Mask'],
    ['BLEND', 'Blend'],
  ],
  rebuilds: true,
  get: alphaModeOf,
  set: (_json, material, value) => {
    if (value === 'MASK' || value === 'BLEND') material.alphaMode = value;
    else delete material.alphaMode;
    // A cutoff only means something to Mask, and validators flag it anywhere else.
    if (value !== 'MASK') delete material.alphaCutoff;
  },
};

const alphaTest: NumberParam = {
  ...numberParam(
    'alphaTest',
    'Alpha test',
    'Pixels with less alpha than this are not drawn. alphaCutoff',
    'material',
    'alphaCutoff',
    0.5,
    { step: 0.01, min: 0, max: 1 },
  ),
  shown: (material) => alphaModeOf(material) === 'MASK',
};

const emissive = colorParam(
  'emissive',
  'Emissive',
  'Light the surface gives off by itself. emissiveFactor',
  'material',
  'emissiveFactor',
  [0, 0, 0],
);
const emissiveIntensity = numberParam(
  'emissiveIntensity',
  'Emissive int.',
  'Brightens the emissive colour past 1. KHR_materials_emissive_strength',
  EMISSIVE_STRENGTH,
  'emissiveStrength',
  1,
  { step: 0.05, min: 0 },
);
const roughness = numberParam(
  'roughness',
  'Roughness',
  'pbrMetallicRoughness.roughnessFactor',
  'pbr',
  'roughnessFactor',
  1,
  { step: 0.01, min: 0, max: 1 },
);
const metalness = numberParam(
  'metalness',
  'Metalness',
  'pbrMetallicRoughness.metallicFactor',
  'pbr',
  'metallicFactor',
  1,
  { step: 0.01, min: 0, max: 1 },
);
const ior = numberParam('ior', 'IOR', 'Index of refraction. KHR_materials_ior', IOR, 'ior', 1.5, {
  step: 0.01,
  min: 1,
  max: 2.333,
});
const phongSpecular = colorParam(
  'specular',
  'Specular',
  'Colour of the shine. glTF has no Phong, so it is kept in extras.threeMaterial.specular',
  EXTRAS,
  'specular',
  PHONG_SPECULAR,
);
const phongShininess = numberParam(
  'shininess',
  'Shininess',
  'How tight the shine is. glTF has no Phong, so it is kept in extras.threeMaterial.shininess',
  EXTRAS,
  'shininess',
  30,
  { step: 1, min: 0 },
);
const shadowColor = colorParam(
  'shadowColor',
  'Color',
  'Colour of the shadow it catches. glTF has no shadow material, so it is kept in extras.threeMaterial.color',
  EXTRAS,
  'color',
  [0, 0, 0],
);

const depthPacking: ChoiceParam = {
  id: 'depthPacking',
  label: 'Depth packing',
  hint: 'Basic writes depth as grey; RGBA packs it into all four channels. Kept in extras.threeMaterial.depthPacking',
  kind: 'choice',
  options: [
    ['BasicDepthPacking', 'Basic'],
    ['RGBADepthPacking', 'RGBA'],
  ],
  get: (material) => (threeExtras(material)?.depthPacking === 'RGBADepthPacking' ? 'RGBADepthPacking' : 'BasicDepthPacking'),
  set: (json, material, value) => writeKey(json, material, EXTRAS, 'depthPacking', value, 'BasicDepthPacking'),
};

function shaderParam(stage: 'vertex' | 'fragment'): TextParam {
  const key = `${stage}Shader`;
  return {
    id: key,
    label: stage === 'vertex' ? 'Vertex' : 'Fragment',
    hint: `The ${stage} shader's GLSL source, applied when the field loses focus. Kept in extras.threeMaterial.${key}`,
    kind: 'text',
    get: (material) => {
      const value = threeExtras(material)?.[key];
      return typeof value === 'string' ? value : defaultShader(material, stage);
    },
    set: (json, material, value) => writeKey(json, material, EXTRAS, key, value, defaultShader(material, stage)),
  };
}
const vertexShader = shaderParam('vertex');
const fragmentShader = shaderParam('fragment');

const normalScale = textureAmount('normalScale', 'Normal scale', 'normalTexture.scale', 'normal', 'scale');
const aoIntensity = textureAmount('aoMapIntensity', 'AO intensity', 'occlusionTexture.strength', 'occlusion', 'strength');

// ---------------------------------------------------------------------------
// The panel's layout

/** One row of the panel, shown for its section's types unless it narrows them. */
export type PanelItem = ({ param: MaterialParam } | { map: MapSlotSpec }) & { types?: MaterialType[] };

export interface MaterialSection {
  id: string;
  /** Null for the rows every type starts with, which have no heading. */
  title: string | null;
  types: MaterialType[];
  /** The extensions it edits, so it can open by itself when the material uses one. */
  extensions: string[];
  items: PanelItem[];
}

const STANDARD: MaterialType[] = ['MeshStandardMaterial', 'MeshPhysicalMaterial'];
const ALL: MaterialType[] = [...MATERIAL_TYPES];
const PHYSICAL: MaterialType[] = ['MeshPhysicalMaterial'];
const PHONG: MaterialType[] = ['MeshPhongMaterial'];
/** The types the scene's lights shade, which take emissive and AO too. */
const LIT: MaterialType[] = ['MeshLambertMaterial', 'MeshPhongMaterial', 'MeshToonMaterial', ...STANDARD];
/** Every type with a colour and a colour map: Depth and Normal draw what they measure. */
const COLORED: MaterialType[] = ['MeshBasicMaterial', 'MeshMatcapMaterial', ...LIT];
/** Every type that bends its shading with a normal map. */
const NORMAL_MAPPED: MaterialType[] = ['MeshNormalMaterial', 'MeshMatcapMaterial', ...LIT];
/** Depth reads the colour map too, for its alpha alone. */
const MAPPED: MaterialType[] = [...COLORED, 'MeshDepthMaterial'];
const SHADER: MaterialType[] = ['RawShaderMaterial', 'ShaderMaterial'];

const p = (param: MaterialParam, types?: MaterialType[]): PanelItem => ({ param, types });
const m = (slot: MapSlot, types?: MaterialType[]): PanelItem => ({ map: MAP_SLOTS[slot], types });

/**
 * What each type shows, in the editor's order: colours and amounts first, then
 * maps, then how it is drawn. Basic is only what KHR_materials_unlit reads —
 * the base colour, its alpha, and the two sides. The extras types show what
 * they have of glTF's own keys, which is where they keep those values too.
 */
export const MATERIAL_SECTIONS: MaterialSection[] = [
  {
    id: 'surface',
    title: null,
    types: ALL,
    extensions: [],
    items: [
      // The editor leads with the program, since for these it is everything.
      p(vertexShader, SHADER),
      p(fragmentShader, SHADER),
      p(color, COLORED),
      p(shadowColor, ['ShadowMaterial']),
      p(phongSpecular, PHONG),
      p(phongShininess, PHONG),
      p(emissive, LIT),
      p(emissiveIntensity, LIT),
      p(roughness, STANDARD),
      p(metalness, STANDARD),
      p(ior, PHYSICAL),
      p(depthPacking, ['MeshDepthMaterial']),
      m('baseColor', MAPPED),
      m('emissive', LIT),
      m('metallicRoughness', STANDARD),
      m('normal', NORMAL_MAPPED),
      p(normalScale, NORMAL_MAPPED),
      m('occlusion', LIT),
      p(aoIntensity, LIT),
    ],
  },
  {
    id: 'clearcoat',
    title: 'Clearcoat',
    types: PHYSICAL,
    extensions: [CLEARCOAT],
    items: [
      p(numberParam('clearcoat', 'Clearcoat', 'A clear lacquer layer on top. clearcoatFactor', CLEARCOAT, 'clearcoatFactor', 0, {
        step: 0.01,
        min: 0,
        max: 1,
      })),
      p(numberParam('clearcoatRoughness', 'Roughness', 'clearcoatRoughnessFactor', CLEARCOAT, 'clearcoatRoughnessFactor', 0, {
        step: 0.01,
        min: 0,
        max: 1,
      })),
      m('clearcoat'),
      m('clearcoatRoughness'),
      m('clearcoatNormal'),
      p(textureAmount('clearcoatNormalScale', 'Normal scale', 'clearcoatNormalTexture.scale', 'clearcoatNormal', 'scale')),
    ],
  },
  {
    id: 'sheen',
    title: 'Sheen',
    types: PHYSICAL,
    extensions: [SHEEN],
    items: [
      p(colorParam('sheenColor', 'Color', 'Velvet-like rim colour; black is no sheen. sheenColorFactor', SHEEN, 'sheenColorFactor', [0, 0, 0])),
      p(numberParam('sheenRoughness', 'Roughness', 'sheenRoughnessFactor', SHEEN, 'sheenRoughnessFactor', 0, {
        step: 0.01,
        min: 0,
        max: 1,
      })),
      m('sheenColor'),
      m('sheenRoughness'),
    ],
  },
  {
    id: 'transmission',
    title: 'Transmission',
    types: PHYSICAL,
    extensions: [TRANSMISSION, VOLUME, DISPERSION],
    items: [
      p(numberParam('transmission', 'Transmission', 'Glass-like see-through. KHR_materials_transmission', TRANSMISSION, 'transmissionFactor', 0, {
        step: 0.01,
        min: 0,
        max: 1,
      })),
      m('transmission'),
      p(numberParam('thickness', 'Thickness', 'How thick the volume is, in scene units; 0 is a thin wall. KHR_materials_volume', VOLUME, 'thicknessFactor', 0, {
        step: 0.01,
        min: 0,
      })),
      m('thickness'),
      p(colorParam('attenuationColor', 'Atten. color', 'The colour light turns inside the volume. attenuationColor', VOLUME, 'attenuationColor', [1, 1, 1])),
      p(numberParam(
        'attenuationDistance',
        'Atten. dist.',
        'How far light travels before it becomes the attenuation colour; 0 is never. attenuationDistance',
        VOLUME,
        'attenuationDistance',
        0,
        { step: 0.01, min: 0 },
      )),
      p(numberParam('dispersion', 'Dispersion', 'Splits light into colours as it refracts. KHR_materials_dispersion', DISPERSION, 'dispersion', 0, {
        step: 0.01,
        min: 0,
        max: 10,
      })),
    ],
  },
  {
    id: 'specular',
    title: 'Specular',
    types: PHYSICAL,
    extensions: [SPECULAR],
    items: [
      p(numberParam('specularIntensity', 'Intensity', 'Strength of the non-metal reflection. specularFactor', SPECULAR, 'specularFactor', 1, {
        step: 0.01,
        min: 0,
        max: 1,
      })),
      p(colorParam('specularColor', 'Color', 'Tint of the non-metal reflection. specularColorFactor', SPECULAR, 'specularColorFactor', [1, 1, 1])),
      m('specular'),
      m('specularColor'),
    ],
  },
  {
    id: 'iridescence',
    title: 'Iridescence',
    types: PHYSICAL,
    extensions: [IRIDESCENCE],
    items: [
      p(numberParam('iridescence', 'Iridescence', 'Soap-bubble thin-film colours. iridescenceFactor', IRIDESCENCE, 'iridescenceFactor', 0, {
        step: 0.01,
        min: 0,
        max: 1,
      })),
      p(numberParam('iridescenceIOR', 'IOR', 'Index of refraction of the thin film. iridescenceIor', IRIDESCENCE, 'iridescenceIor', 1.3, {
        step: 0.01,
        min: 1,
        max: 5,
      })),
      p(numberParam('iridescenceThicknessMin', 'Thick. min', 'Thin-film thickness in nanometres, where the map is black. iridescenceThicknessMinimum', IRIDESCENCE, 'iridescenceThicknessMinimum', 100, {
        step: 1,
        min: 0,
      })),
      p(numberParam('iridescenceThicknessMax', 'Thick. max', 'Thin-film thickness in nanometres, where the map is white — or everywhere, without one. iridescenceThicknessMaximum', IRIDESCENCE, 'iridescenceThicknessMaximum', 400, {
        step: 1,
        min: 0,
      })),
      m('iridescence'),
      m('iridescenceThickness'),
    ],
  },
  {
    id: 'anisotropy',
    title: 'Anisotropy',
    types: PHYSICAL,
    extensions: [ANISOTROPY],
    items: [
      p(numberParam('anisotropy', 'Strength', 'Stretches highlights along one direction, like brushed metal. anisotropyStrength', ANISOTROPY, 'anisotropyStrength', 0, {
        step: 0.01,
        min: 0,
        max: 1,
      })),
      p(numberParam('anisotropyRotation', 'Rotation', 'Which way highlights stretch, in degrees. anisotropyRotation', ANISOTROPY, 'anisotropyRotation', 0, {
        step: 1,
        degrees: true,
      })),
      m('anisotropy'),
    ],
  },
  {
    id: 'rendering',
    title: null,
    types: ALL,
    extensions: [],
    items: [p(side), p(alphaMode), p(opacity), p(alphaTest)],
  },
];

/** The rows one section shows for a material of a given type. */
export function sectionItems(section: MaterialSection, type: MaterialType): PanelItem[] {
  if (!section.types.includes(type)) return [];
  return section.items.filter((item) => (item.types ?? section.types).includes(type));
}

/** Whether a section's extensions are in the material, so it opens without being asked. */
export function sectionInUse(section: MaterialSection, material: GltfMaterial): boolean {
  return section.extensions.some((name) => material.extensions?.[name] !== undefined);
}

// ---------------------------------------------------------------------------
// What the preview shows

/** A material as GLTFLoader would build it, in three.js property names. */
export interface MaterialLook {
  /**
   * Set on the live material wherever it has a property by that name. Colours
   * are linear RGB; a normal scale is one number, applied to both axes; shader
   * source is a string.
   */
  props: Record<string, number | number[] | string>;
  doubleSided: boolean;
  alphaMode: AlphaMode;
  alphaCutoff: number;
}

/**
 * Mirrors GLTFLoader's loadMaterial and its extension plugins, defaults and
 * all, so a value changed in the panel lands on the preview exactly as a reload
 * would put it there — without the reload.
 */
export function materialLook(material: GltfMaterial): MaterialLook {
  const extensions = material.extensions ?? {};
  const ext = (name: string): Record<string, unknown> | undefined =>
    extensions[name] as Record<string, unknown> | undefined;
  const num = (host: Record<string, unknown> | undefined, key: string, fallback: number): number => {
    const value = host?.[key];
    return typeof value === 'number' ? value : fallback;
  };
  const rgb = (host: Record<string, unknown> | undefined, key: string, fallback: Rgb): number[] => {
    const value = host?.[key];
    return isNumbers(value, 3) ? value.slice(0, 3) : fallback;
  };

  const base = baseColorFactor(material);
  const pbr = material.pbrMetallicRoughness as unknown as Record<string, unknown> | undefined;
  const props: Record<string, number | number[] | string> = {
    color: base.slice(0, 3),
    opacity: base[3],
    metalness: num(pbr, 'metallicFactor', 1),
    roughness: num(pbr, 'roughnessFactor', 1),
    emissive: rgb(material as unknown as Record<string, unknown>, 'emissiveFactor', [0, 0, 0]),
    emissiveIntensity: num(ext(EMISSIVE_STRENGTH), 'emissiveStrength', 1),
    normalScale: material.normalTexture?.scale ?? 1,
    aoMapIntensity: material.occlusionTexture?.strength ?? 1,
  };

  if (materialType(material) === 'MeshPhysicalMaterial') {
    const clearcoat = ext(CLEARCOAT);
    const sheen = ext(SHEEN);
    const volume = ext(VOLUME);
    const specular = ext(SPECULAR);
    const iridescence = ext(IRIDESCENCE);
    const anisotropy = ext(ANISOTROPY);
    const refraction = num(ext(IOR), 'ior', 1.5);
    const coatNormal = clearcoat?.clearcoatNormalTexture as TextureInfo | undefined;
    Object.assign(props, {
      // The loader's stand-in for glTF's "infinitely dense" IOR of 0.
      ior: refraction === 0 ? 1000 : refraction,
      clearcoat: num(clearcoat, 'clearcoatFactor', 0),
      clearcoatRoughness: num(clearcoat, 'clearcoatRoughnessFactor', 0),
      clearcoatNormalScale: coatNormal?.scale ?? 1,
      // glTF sheen has no strength: it is on, and its colour says how much.
      sheen: sheen ? 1 : 0,
      sheenColor: rgb(sheen, 'sheenColorFactor', [0, 0, 0]),
      sheenRoughness: sheen ? num(sheen, 'sheenRoughnessFactor', 0) : 1,
      transmission: num(ext(TRANSMISSION), 'transmissionFactor', 0),
      thickness: num(volume, 'thicknessFactor', 0),
      attenuationDistance: num(volume, 'attenuationDistance', 0) || Infinity,
      attenuationColor: rgb(volume, 'attenuationColor', [1, 1, 1]),
      specularIntensity: num(specular, 'specularFactor', 1),
      specularColor: rgb(specular, 'specularColorFactor', [1, 1, 1]),
      iridescence: num(iridescence, 'iridescenceFactor', 0),
      iridescenceIOR: num(iridescence, 'iridescenceIor', 1.3),
      iridescenceThicknessRange: [
        num(iridescence, 'iridescenceThicknessMinimum', 100),
        num(iridescence, 'iridescenceThicknessMaximum', 400),
      ],
      anisotropy: num(anisotropy, 'anisotropyStrength', 0),
      anisotropyRotation: num(anisotropy, 'anisotropyRotation', 0),
      dispersion: num(ext(DISPERSION), 'dispersion', 0),
    });
  } else {
    const three = threeExtras(material);
    const type = materialType(material);
    if (type === 'MeshPhongMaterial') {
      Object.assign(props, {
        specular: rgb(three, 'specular', PHONG_SPECULAR),
        shininess: num(three, 'shininess', 30),
      });
    } else if (type === 'ShadowMaterial') {
      // Its colour is the shadow's, not the base colour the glTF under it has.
      props.color = rgb(three, 'color', [0, 0, 0]);
    } else if (type === 'MeshDepthMaterial') {
      props.depthPacking = DEPTH_PACKINGS[String(three?.depthPacking)] ?? DEPTH_PACKINGS.BasicDepthPacking;
    } else if (type === 'ShaderMaterial' || type === 'RawShaderMaterial') {
      props.vertexShader = vertexShader.get(material);
      props.fragmentShader = fragmentShader.get(material);
    }
  }

  return {
    props,
    doubleSided: material.doubleSided === true,
    alphaMode: alphaModeOf(material),
    alphaCutoff: typeof material.alphaCutoff === 'number' ? material.alphaCutoff : 0.5,
  };
}

// ---------------------------------------------------------------------------
// Colour pickers
//
// glTF colour factors are linear, and a colour input speaks sRGB hex — the same
// conversion three.js makes between a hex colour and what it renders with.

export function linearToHex(rgb: readonly number[]): string {
  return (
    '#' +
    rgb
      .slice(0, 3)
      .map((channel) => {
        const clamped = Math.min(Math.max(channel, 0), 1);
        const srgb = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
        return Math.round(srgb * 255)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}

export function hexToLinear(hex: string): Rgb {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [16, 8, 0].map((shift) => {
    const srgb = ((value >> shift) & 0xff) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
}
