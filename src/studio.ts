/**
 * Reading a scene exported from the studio: a folder (or the unzipped export)
 * holding `___main.json` — the scene tree — and `___meta.json`, which lists the
 * assets the tree refers to, each in a folder named after its UUID.
 *
 * The tree is turned into what this app has: lights, shapes and empty nodes
 * become the scene's own objects, each model node becomes a model opened at the
 * place the studio had it, and the studio's camera becomes the view. Scripts,
 * fog and the background have no counterpart here and are left behind.
 *
 * Free of three.js, like scene.ts and transform.ts: this runs before the
 * preview has loaded.
 */
import type { PickedFile } from './files';
import { baseName } from './resources';
import {
  createSceneObject,
  SCENE_OBJECT_KINDS,
  type EnvironmentSettings,
  type SceneObject,
  type SceneObjectKind,
} from './scene';
import { SHADOW_MAP_SIZES } from './shadow';
import { eulerToQuaternion, toRadians, type Quat, type Trs, type Vec3 } from './transform';
import type { CameraView } from './viewer';

const MAIN_FILE = '___main.json';
const META_FILE = '___meta.json';

/** One model node of the studio scene: the file to open, and where it goes. */
export interface StudioModel {
  /** The node's name in the studio, which tells instances of one file apart. */
  name: string;
  file: PickedFile;
  /** The rest of the model's asset folder: its buffers and textures. */
  sidecars: PickedFile[];
  /** Where the studio has it, in world space: models here are not parented. */
  placement: Trs;
  hidden: boolean;
}

export interface StudioScene {
  name: string;
  objects: SceneObject[];
  /** Scene objects to hide once the preview has them. */
  hiddenObjects: number[];
  models: StudioModel[];
  camera: CameraView | null;
  environment: EnvironmentSettings | null;
  /** What could not be brought along, for the message that follows the import. */
  notes: string[];
}

interface StudioVec {
  x?: number;
  y?: number;
  z?: number;
}

type StudioComponents = Record<string, Record<string, unknown> | undefined>;

interface StudioNode {
  name?: string;
  type?: string;
  children?: StudioNode[];
  components?: StudioComponents;
}

/** Whether what was dropped or picked is a studio scene export rather than loose models. */
export function isStudioScene(picked: readonly PickedFile[]): boolean {
  return picked.some((item) => baseName(item.path) === MAIN_FILE);
}

export async function readStudioScene(picked: readonly PickedFile[]): Promise<StudioScene> {
  const main = picked.find((item) => baseName(item.path) === MAIN_FILE);
  if (!main) throw new Error(`no ${MAIN_FILE} in what was picked`);
  // Everything the export holds sits beside the scene file.
  const root = main.path.slice(0, main.path.length - MAIN_FILE.length);
  const tree = JSON.parse(await main.file.text()) as {
    name?: string;
    root?: StudioNode;
    settings?: Record<string, unknown>;
  };
  if (!tree.root || typeof tree.root !== 'object') throw new Error(`${MAIN_FILE} holds no scene`);

  const meta = picked.find((item) => item.path === root + META_FILE);
  const zipPaths = new Map<string, string[]>();
  if (meta) {
    try {
      const parsed = JSON.parse(await meta.file.text()) as {
        assets?: { uuid?: string; assetsZipPaths?: string[] }[];
      };
      for (const asset of parsed.assets ?? []) {
        if (typeof asset.uuid === 'string' && Array.isArray(asset.assetsZipPaths)) {
          zipPaths.set(asset.uuid, asset.assetsZipPaths);
        }
      }
    } catch {
      // The asset folders are named after their UUIDs anyway; the tree is enough.
    }
  }

  /** An asset's files: those the meta lists for it, and whatever sits in its folder. */
  const assetFiles = (uuid: string): PickedFile[] => {
    const listed = new Set((zipPaths.get(uuid) ?? []).map((path) => root + path));
    const folder = `${root}${uuid}/`;
    return picked.filter((item) => listed.has(item.path) || item.path.startsWith(folder));
  };

  const scene: StudioScene = {
    name: typeof tree.name === 'string' ? tree.name : 'Scene',
    objects: [],
    hiddenObjects: [],
    models: [],
    camera: null,
    environment: readEnvironment(tree.settings),
    notes: [],
  };
  let nextId = 1;
  /** The scripts attached anywhere, by id: one used on several nodes counts once. */
  const scripts = new Set<string>();
  const noteScripts = (components: StudioComponents): void => {
    for (const id of Object.keys(asRecord(components.scripts?.scripts))) scripts.add(id);
  };
  const missing = new Set<string>();
  const takenModelNames = new Set<string>();

  const walk = (node: StudioNode, parent: number | null, parentWorld: Trs): void => {
    const components = node.components ?? {};
    noteScripts(components);
    const transform = asRecord(components.node3D);
    const local = readTrs(transform);
    const world = composeTrs(parentWorld, local);
    const hidden = transform.visible === false;
    const name = typeof node.name === 'string' ? node.name : '';
    const children = Array.isArray(node.children) ? node.children : [];
    const type = node.type ?? '';

    if (type === 'model') {
      const model = asRecord(components.model);
      const uuid = typeof model.modelUUID === 'string' ? model.modelUUID : '';
      const files = assetFiles(uuid);
      const wanted = typeof model.modelPath === 'string' ? baseName(model.modelPath) : '';
      const modelFiles = files.filter((item) => /\.(glb|gltf)$/i.test(item.path));
      const file = modelFiles.find((item) => baseName(item.path) === wanted) ?? modelFiles[0];
      if (file) {
        scene.models.push({
          name: uniqueName(name || baseName(file.path), takenModelNames),
          file,
          sidecars: files.filter((item) => item !== file),
          placement: world,
          hidden,
        });
      } else {
        missing.add(name || wanted || uuid);
      }
      // A model's children in the studio follow it; here they hang off the
      // scene, at the same place in the world.
      for (const child of children) walk(child, parent, world);
      return;
    }

    if (type === 'perspectiveCamera' || type === 'orthographicCamera') {
      scene.camera ??= cameraView(world, asRecord(components[type]));
      // A camera has no row here, so whatever hangs off it hangs off the scene.
      for (const child of children) walk(child, parent, world);
      return;
    }

    const kind = KIND_OF_TYPE[type] ?? 'group';
    const label = name || SCENE_OBJECT_KINDS[kind].name;
    // The children of a plane were placed in the studio plane's own frame, which
    // flattening it would turn: such a plane goes inside a group that keeps it.
    const holder =
      kind === 'plane' && children.length > 0 ? createSceneObject('group', nextId++, label, parent) : null;
    const object = createSceneObject(kind, nextId++, label, holder?.id ?? parent);
    applyProps(object, components, type);
    if (holder) {
      holder.trs = local;
      object.trs = standPlane();
      scene.objects.push(holder);
    } else {
      object.trs = kind === 'plane' ? flattenPlane(local) : local;
    }
    scene.objects.push(object);
    if (hidden) scene.hiddenObjects.push((holder ?? object).id);

    for (const child of children) walk(child, (holder ?? object).id, world);
  };

  const identity: Trs = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  // The root is the scene itself: its children are the top level.
  noteScripts(tree.root.components ?? {});
  for (const child of tree.root.children ?? []) walk(child, null, identity);

  if (missing.size > 0) scene.notes.push(`Missing model files for ${[...missing].join(', ')}.`);
  if (scripts.size > 0) {
    const count = scripts.size;
    scene.notes.push(`${count} script${count === 1 ? '' : 's'} left out — scripts only run in the studio.`);
  }
  return scene;
}

/** Studio node types and the scene object each becomes; anything else is an empty group. */
const KIND_OF_TYPE: Record<string, SceneObjectKind> = {
  node3D: 'group',
  group: 'group',
  directionalLight: 'directional',
  ambientLight: 'ambient',
  hemisphereLight: 'hemisphere',
  pointLight: 'point',
  spotLight: 'spot',
  plane: 'plane',
  box: 'box',
  cube: 'box',
  sphere: 'sphere',
  cylinder: 'cylinder',
  cone: 'cone',
};

/** Whatever the studio's components say about the object that this app's kind of it has. */
function applyProps(object: SceneObject, components: StudioComponents, type: string): void {
  // Light settings sit on the generic `light` component and again on the
  // specific one, which wins.
  const light = { ...asRecord(components.light), ...asRecord(components[type]) };
  const mesh = asRecord(components.mesh);
  const kind = object.kind;
  const props = SCENE_OBJECT_KINDS[kind].props;

  if ('color' in props && isColor(light.color)) object.color = light.color.toLowerCase();
  if ('groundColor' in props && isColor(light.groundColor)) object.groundColor = light.groundColor.toLowerCase();
  if ('intensity' in props && isNumber(light.intensity)) object.intensity = Math.max(0, light.intensity);
  if ('distance' in props && isNumber(light.distance)) object.distance = Math.max(0, light.distance);
  if ('decay' in props && isNumber(light.decay)) object.decay = Math.max(0, light.decay);
  if ('penumbra' in props && isNumber(light.penumbra)) object.penumbra = clamp01(light.penumbra);
  if ('angle' in props && isNumber(light.angle)) {
    // Radians as three.js takes them, unless it can only be degrees.
    object.angle = light.angle > Math.PI / 2 ? toRadians(light.angle) : light.angle;
  }
  if ('target' in props && light.target && typeof light.target === 'object') {
    object.target = vec(light.target as StudioVec, [0, 0, 0]);
  }
  if (categoryIsLight(kind)) {
    if ('castShadow' in props && typeof light.castShadow === 'boolean') object.castShadow = light.castShadow;
    if ('shadowBias' in props && isNumber(light.bias)) object.shadowBias = light.bias;
    if ('shadowMapSize' in props && isNumber(light.shadowMapSize) && SHADOW_MAP_SIZES.includes(light.shadowMapSize)) {
      object.shadowMapSize = light.shadowMapSize;
    }
  } else {
    if ('castShadow' in props && typeof mesh.castShadow === 'boolean') object.castShadow = mesh.castShadow;
    if ('receiveShadow' in props && typeof mesh.receiveShadow === 'boolean') {
      object.receiveShadow = mesh.receiveShadow;
    }
    if ('color' in props && isColor(mesh.color)) object.color = mesh.color.toLowerCase();
  }
}

function categoryIsLight(kind: SceneObjectKind): boolean {
  return SCENE_OBJECT_KINDS[kind].category === 'light';
}

/**
 * The studio's environment is a map it was given, or none. With none, the room
 * this app lights materials with by default would make the models brighter
 * than the studio shows them.
 */
function readEnvironment(settings: Record<string, unknown> | undefined): EnvironmentSettings | null {
  if (!settings || typeof settings !== 'object') return null;
  const intensity = isNumber(settings.environmentIntensity) ? Math.max(0, settings.environmentIntensity) : 1;
  return { mode: settings.environment ? 'room' : 'none', intensity };
}

/** A node3D component's transform; the studio keeps rotation as XYZ Euler angles in degrees. */
function readTrs(transform: Record<string, unknown>): Trs {
  const rotation = vec(transform.rotation as StudioVec, [0, 0, 0]);
  return {
    translation: vec(transform.position as StudioVec, [0, 0, 0]),
    rotation: eulerToQuaternion(rotation.map(toRadians) as Vec3),
    scale: vec(transform.scale as StudioVec, [1, 1, 1]),
  };
}

/**
 * The studio's plane is three.js's, standing in XY; this app's lies flat in XZ
 * (it is three.js's turned -90° about X). The same surface lands in the same
 * place when the turn is undone in the rotation and Y and Z swap in the scale.
 */
function flattenPlane(trs: Trs): Trs {
  const [x, y, z] = trs.scale;
  return {
    translation: [...trs.translation],
    rotation: multiply(trs.rotation, QUARTER_X),
    scale: [x, z, y],
  };
}

/** This app's plane stood back up into XY, for a plane inside a group that holds the studio's transform. */
function standPlane(): Trs {
  return { translation: [0, 0, 0], rotation: [...QUARTER_X], scale: [1, 1, 1] };
}

/** +90° about X. */
const QUARTER_X: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/**
 * A child's transform taken into its parent's space. Exact unless a parent is
 * both rotated and scaled unevenly, which no TRS can hold anyway.
 */
function composeTrs(parent: Trs, child: Trs): Trs {
  const scaled: Vec3 = [
    child.translation[0] * parent.scale[0],
    child.translation[1] * parent.scale[1],
    child.translation[2] * parent.scale[2],
  ];
  const moved = rotate(parent.rotation, scaled);
  return {
    translation: [
      parent.translation[0] + moved[0],
      parent.translation[1] + moved[1],
      parent.translation[2] + moved[2],
    ],
    rotation: multiply(parent.rotation, child.rotation),
    scale: [
      parent.scale[0] * child.scale[0],
      parent.scale[1] * child.scale[1],
      parent.scale[2] * child.scale[2],
    ],
  };
}

/**
 * The view from the studio's camera. Orbiting needs a point to turn about: where
 * the camera looks down onto the ground, or a little way ahead when it looks level.
 */
function cameraView(world: Trs, camera: Record<string, unknown>): CameraView {
  const position = world.translation;
  const forward = rotate(world.rotation, [0, 0, -1]);
  const far = isNumber(camera.far) && camera.far > 0 ? camera.far : 1000;
  let distance = 10;
  if (forward[1] < -0.05) {
    const toGround = position[1] / -forward[1];
    if (toGround > 0 && toGround < far) distance = toGround;
  }
  return {
    position: [...position],
    target: [
      position[0] + forward[0] * distance,
      position[1] + forward[1] * distance,
      position[2] + forward[2] * distance,
    ],
  };
}

function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v + 2w(q×v) + 2q×(q×v), without building a matrix.
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Model rows are told apart by these names, so two instances never share one. */
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let count = 2; taken.has(name); count++) name = `${base} ${count}`;
  taken.add(name);
  return name;
}

function vec(value: StudioVec | undefined, fallback: Vec3): Vec3 {
  if (!value || typeof value !== 'object') return [...fallback];
  return [
    isNumber(value.x) ? value.x : fallback[0],
    isNumber(value.y) ? value.y : fallback[1],
    isNumber(value.z) ? value.z : fallback[2],
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
