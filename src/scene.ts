/**
 * Objects that belong to the scene rather than to any file: the lights the
 * models are seen under, and the shapes and groups added with the outliner's
 * "+" — the three.js editor's Add menu.
 *
 * They are the scene's the way a model's placement is: kept with the session,
 * never written into a download. glTF could hold three of the five lights, but
 * ambient and hemisphere lights have no glTF form at all, and a light that
 * quietly turned up inside whichever file happened to be active would be a
 * worse surprise than one that stays out of all of them.
 *
 * Free of three.js, like transform.ts: the outliner and the panel describe these
 * before the preview has loaded, and the viewer builds its objects from here.
 */
import { SHADOW_MAP_SIZES } from './shadow';
import { DEFAULT_TRS, type Trs, type Vec3 } from './transform';

export type SceneObjectKind =
  | 'group'
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'plane'
  | 'ambient'
  | 'directional'
  | 'hemisphere'
  | 'point'
  | 'spot';

export type SceneObjectCategory = 'group' | 'mesh' | 'light';

/** What a kind can be set to. Each kind carries only the ones it uses. */
export interface SceneObjectProps {
  /** A shape's surface, or a light's colour, as `#rrggbb`. */
  color?: string;
  /** A hemisphere light's colour from below. */
  groundColor?: string;
  intensity?: number;
  /** How far a point or spot light reaches; 0 is without limit. */
  distance?: number;
  /** How fast a point or spot light falls off with distance; 2 is physically correct. */
  decay?: number;
  /** A spot light's cone, from its axis to its edge, in radians as three.js takes it. */
  angle?: number;
  /** How much of a spot light's cone fades out towards its edge, 0 to 1. */
  penumbra?: number;
  /** The point a directional or spot light shines towards, in world space. */
  target?: Vec3;
  /** Whether a shape, or a light with a direction, throws a shadow. */
  castShadow?: boolean;
  /** Whether shadows fall on a shape. */
  receiveShadow?: boolean;
  /** How dark a light's shadow is, 0 to 1. */
  shadowIntensity?: number;
  /** Added to the depth a light's shadow map is compared against; tiny, either sign. */
  shadowBias?: number;
  /** How far along the surface normal the map is looked up, in world units. */
  shadowNormalBias?: number;
  /** How far a light's shadow edge is blurred, in texels of its map. */
  shadowRadius?: number;
  /** A side of the light's shadow map, in texels. */
  shadowMapSize?: number;
}

export interface SceneObject extends SceneObjectProps {
  /** Stable for as long as the object exists, a reload included. */
  id: number;
  kind: SceneObjectKind;
  name: string;
  /** The scene object this one hangs off, or null for the scene itself. */
  parent: number | null;
  /** Where it sits, relative to its parent. */
  trs: Trs;
}

/** How the scene is lit besides its lights: the image-based light every material reflects. */
export interface EnvironmentSettings {
  mode: 'room' | 'none';
  intensity: number;
}

/** What the preview always had, so a scene nobody has touched looks the way it did. */
export const DEFAULT_ENVIRONMENT: EnvironmentSettings = { mode: 'room', intensity: 0.9 };

interface KindSpec {
  /** What the "+" menu and the panel call it. */
  label: string;
  /** What a new one is named — the three.js class name, the way the editor names them. */
  name: string;
  category: SceneObjectCategory;
  /**
   * Where a new one starts. Shapes start at the origin, as the editor's do;
   * lights start away from it, so that they shine on it.
   */
  position: Vec3;
  props: SceneObjectProps;
}

const WHITE = '#ffffff';

/**
 * A solid shape throws a shadow and takes one; a plane, being a floor, only
 * takes one — and so does not stretch a directional light's shadow map over its
 * whole extent, which is fitted to what casts.
 */
const SOLID_SHADOW: SceneObjectProps = { castShadow: true, receiveShadow: true };
const FLOOR_SHADOW: SceneObjectProps = { castShadow: false, receiveShadow: true };

/**
 * What a light's shadow is drawn with: three.js's own settings, casting from the
 * start so that a shape, or a model told to cast, shows its shadow without a
 * second trip to the light. The map is twice three.js's 512 a side, which shows
 * its texels on a model filling the view; a point light draws six faces into one
 * map, so it keeps the 512.
 */
const LIGHT_SHADOW: SceneObjectProps = {
  castShadow: true,
  shadowIntensity: 1,
  shadowBias: 0,
  shadowNormalBias: 0,
  shadowRadius: 1,
  shadowMapSize: 1024,
};

export const SCENE_OBJECT_KINDS: Record<SceneObjectKind, KindSpec> = {
  group: { label: 'Group', name: 'Group', category: 'group', position: [0, 0, 0], props: {} },
  box: {
    label: 'Box',
    name: 'Box',
    category: 'mesh',
    position: [0, 0, 0],
    props: { color: WHITE, ...SOLID_SHADOW },
  },
  sphere: {
    label: 'Sphere',
    name: 'Sphere',
    category: 'mesh',
    position: [0, 0, 0],
    props: { color: WHITE, ...SOLID_SHADOW },
  },
  cylinder: {
    label: 'Cylinder',
    name: 'Cylinder',
    category: 'mesh',
    position: [0, 0, 0],
    props: { color: WHITE, ...SOLID_SHADOW },
  },
  cone: {
    label: 'Cone',
    name: 'Cone',
    category: 'mesh',
    position: [0, 0, 0],
    props: { color: WHITE, ...SOLID_SHADOW },
  },
  plane: {
    label: 'Plane',
    name: 'Plane',
    category: 'mesh',
    position: [0, 0, 0],
    props: { color: WHITE, ...FLOOR_SHADOW },
  },
  ambient: {
    label: 'Ambient light',
    name: 'AmbientLight',
    category: 'light',
    position: [0, 0, 0],
    props: { color: WHITE, intensity: 0.5 },
  },
  // The key light the preview always had, so a scene nobody has touched is lit
  // the way it was.
  directional: {
    label: 'Directional light',
    name: 'DirectionalLight',
    category: 'light',
    position: [4, 6, 5],
    props: { color: WHITE, intensity: 1.3, target: [0, 0, 0], ...LIGHT_SHADOW },
  },
  hemisphere: {
    label: 'Hemisphere light',
    name: 'HemisphereLight',
    category: 'light',
    position: [0, 1, 0],
    props: { color: WHITE, groundColor: '#444444', intensity: 1 },
  },
  // Point and spot lights fall off with the square of distance, so their
  // intensities are sized to land about as bright as the key light on an object
  // at the origin.
  point: {
    label: 'Point light',
    name: 'PointLight',
    category: 'light',
    position: [1, 2, 1],
    props: { color: WHITE, intensity: 5, distance: 0, decay: 2, ...LIGHT_SHADOW, shadowMapSize: 512 },
  },
  spot: {
    label: 'Spot light',
    name: 'SpotLight',
    category: 'light',
    position: [2, 4, 2],
    props: {
      color: WHITE,
      intensity: 20,
      distance: 0,
      decay: 2,
      angle: Math.PI / 6,
      penumbra: 0.2,
      target: [0, 0, 0],
      ...LIGHT_SHADOW,
    },
  },
};

/** What the "+" menu offers, in the order and under the headings it lists them. */
export const ADD_MENU: { heading: string | null; kinds: SceneObjectKind[] }[] = [
  { heading: null, kinds: ['group'] },
  { heading: 'Mesh', kinds: ['box', 'sphere', 'cylinder', 'cone', 'plane'] },
  { heading: 'Light', kinds: ['ambient', 'directional', 'hemisphere', 'point', 'spot'] },
];

export function categoryOf(kind: SceneObjectKind): SceneObjectCategory {
  return SCENE_OBJECT_KINDS[kind].category;
}

/**
 * Whether it has a place worth moving. An ambient light lights everything the
 * same from nowhere in particular, so it has no transform to show.
 */
export function hasTransform(kind: SceneObjectKind): boolean {
  return kind !== 'ambient';
}

export function createSceneObject(
  kind: SceneObjectKind,
  id: number,
  name: string,
  parent: number | null,
): SceneObject {
  const spec = SCENE_OBJECT_KINDS[kind];
  return {
    id,
    kind,
    name,
    parent,
    trs: {
      translation: [...spec.position],
      rotation: [...DEFAULT_TRS.rotation],
      scale: [...DEFAULT_TRS.scale],
    },
    // A copy, so no two lights share one target array.
    ...structuredClone(spec.props),
  };
}

/** What a new scene holds: a light to see by, and one to lift the shadows. */
export function defaultSceneObjects(): SceneObject[] {
  return [
    createSceneObject('directional', 1, SCENE_OBJECT_KINDS.directional.name, null),
    createSceneObject('ambient', 2, SCENE_OBJECT_KINDS.ambient.name, null),
  ];
}

/** Every object under this one, however deep, not counting itself. */
export function descendantsOf(objects: readonly SceneObject[], id: number): Set<number> {
  const found = new Set<number>();
  const pending = [id];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    for (const object of objects) {
      if (object.parent !== parent || found.has(object.id) || object.id === id) continue;
      found.add(object.id);
      pending.push(object.id);
    }
  }
  return found;
}

/**
 * Objects read back from storage, or null when they no longer read as a list of
 * them. Whatever one object has lost is filled in from its kind; one that cannot
 * be made sense of at all is left out, and so is a parent that is not there.
 */
export function restoreSceneObjects(value: unknown): SceneObject[] | null {
  if (!Array.isArray(value)) return null;
  const restored: SceneObject[] = [];
  const ids = new Set<number>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const stored = item as Partial<SceneObject>;
    const kind = stored.kind;
    if (typeof kind !== 'string' || !(kind in SCENE_OBJECT_KINDS)) continue;
    if (typeof stored.id !== 'number' || !Number.isInteger(stored.id) || ids.has(stored.id)) continue;

    const object = createSceneObject(
      kind,
      stored.id,
      typeof stored.name === 'string' ? stored.name : SCENE_OBJECT_KINDS[kind].name,
      typeof stored.parent === 'number' ? stored.parent : null,
    );
    if (stored.trs && isTrs(stored.trs)) object.trs = stored.trs;
    // Only what the kind has: a colour stored on a group is not a group's.
    for (const key of Object.keys(SCENE_OBJECT_KINDS[kind].props) as (keyof SceneObjectProps)[]) {
      const kept = stored[key];
      if (key === 'target') {
        if (isVec3(kept)) object.target = [...kept];
        continue;
      }
      if (key === 'shadowMapSize') {
        // Only a size the panel offers: a map is drawn at it, and a wild one costs memory.
        if (typeof kept === 'number' && SHADOW_MAP_SIZES.includes(kept)) object.shadowMapSize = kept;
        continue;
      }
      if (typeof kept === typeof object[key] && (typeof kept !== 'number' || Number.isFinite(kept))) {
        (object as unknown as Record<string, unknown>)[key] = kept;
      }
    }
    ids.add(object.id);
    restored.push(object);
  }

  // A parent that went missing, or a loop, leaves the object at the top.
  for (const object of restored) {
    if (object.parent !== null && !ids.has(object.parent)) object.parent = null;
  }
  for (const object of restored) {
    const seen = new Set<number>([object.id]);
    for (let at = object.parent; at !== null; ) {
      if (seen.has(at)) {
        object.parent = null;
        break;
      }
      seen.add(at);
      at = restored.find((other) => other.id === at)?.parent ?? null;
    }
  }
  return restored;
}

export function restoreEnvironment(value: unknown): EnvironmentSettings {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<EnvironmentSettings>;
  return {
    mode: stored.mode === 'none' ? 'none' : 'room',
    intensity:
      typeof stored.intensity === 'number' && Number.isFinite(stored.intensity) && stored.intensity >= 0
        ? stored.intensity
        : DEFAULT_ENVIRONMENT.intensity,
  };
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function isTrs(trs: Trs): boolean {
  const numbers = (value: unknown, length: number) =>
    Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  return numbers(trs.translation, 3) && numbers(trs.rotation, 4) && numbers(trs.scale, 3);
}
