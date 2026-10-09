/**
 * The studio's scene export, both ways: a folder (or the unzipped export)
 * holding `___main.json` — the scene tree — and `___meta.json`, which lists the
 * assets the tree refers to, each in a folder named after its UUID.
 *
 * Read, the tree is turned into what this app has: lights, shapes and empty
 * nodes become the scene's own objects, each model node becomes a model opened
 * at the place the studio had it, and the studio's camera becomes the view.
 * Scripts, fog and the background have no counterpart here and are left behind.
 *
 * Written, the same goes the other way, as a zip the studio's scene import
 * takes: every model goes as an asset of its own, a .gltf with its .bin and
 * textures, and the view goes as the scene's camera.
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
import {
  DEFAULT_TRS,
  decomposeMatrix,
  eulerToQuaternion,
  quaternionToEuler,
  toDegrees,
  toRadians,
  type Quat,
  type Trs,
  type Vec3,
} from './transform';
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
  /** Where the studio project keeps the file, when the export says. */
  projectPath: string | null;
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
  const projectPaths = new Map<string, string[]>();
  if (meta) {
    try {
      const parsed = JSON.parse(await meta.file.text()) as {
        assets?: { uuid?: string; assets?: string[]; assetsZipPaths?: string[] }[];
      };
      for (const asset of parsed.assets ?? []) {
        if (typeof asset.uuid !== 'string') continue;
        if (Array.isArray(asset.assetsZipPaths)) zipPaths.set(asset.uuid, asset.assetsZipPaths);
        if (Array.isArray(asset.assets)) projectPaths.set(asset.uuid, asset.assets);
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
        // The meta has where the file is now; the node, where it was when placed.
        const projectPath =
          projectPaths.get(uuid)?.find((path) => baseName(path) === baseName(file.path)) ??
          (typeof model.modelPath === 'string' && baseName(model.modelPath) === baseName(file.path)
            ? model.modelPath
            : null);
        scene.models.push({
          name: uniqueName(name || baseName(file.path), takenModelNames),
          file,
          sidecars: files.filter((item) => item !== file),
          projectPath,
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
    const fit = SHAPE_FIT[kind];
    // The children of a shape drawn differently here were placed in the studio
    // shape's own frame, which fitting it would change: such a shape goes
    // inside a group that keeps that frame.
    const holder = fit && children.length > 0 ? createSceneObject('group', nextId++, label, parent) : null;
    const object = createSceneObject(kind, nextId++, label, holder?.id ?? parent);
    applyProps(object, components, type);
    if (holder) {
      holder.trs = local;
      object.trs = fitFromStudio(DEFAULT_TRS, fit!);
      scene.objects.push(holder);
    } else {
      object.trs = fit ? fitFromStudio(local, fit) : local;
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

/** The studio node type each scene object goes out as. */
const TYPE_OF_KIND: Record<SceneObjectKind, string> = {
  group: 'node3D',
  box: 'box',
  sphere: 'sphere',
  cylinder: 'cylinder',
  cone: 'cone',
  plane: 'plane',
  ambient: 'ambientLight',
  directional: 'directionalLight',
  hemisphere: 'hemisphereLight',
  point: 'pointLight',
  spot: 'spotLight',
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
 * How one of the studio's shapes is made into this app's: the studio draws
 * three.js's own at size 1, so its sphere, cylinder and cone are twice as wide
 * as these, which have a radius of 0.5; and its plane stands in XY, where this
 * app's lies flat in XZ. A box is the same in both.
 *
 * A turn is always a quarter turn about X, which swaps Y and Z in any scale it
 * is moved past.
 */
type ShapeFit = { turn: Quat } | { scale: Vec3 };

const SHAPE_FIT: Partial<Record<SceneObjectKind, ShapeFit>> = {
  sphere: { scale: [0.5, 0.5, 0.5] },
  cylinder: { scale: [0.5, 1, 0.5] },
  cone: { scale: [0.5, 1, 0.5] },
  // -90° about X.
  plane: { turn: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
};

/** The studio's transform for a shape this app draws at `trs`: the same surface, in the same place. */
function fitToStudio(trs: Trs, fit: ShapeFit): Trs {
  return applyFit(trs, fit, false);
}

/** This app's transform for a shape the studio draws at `trs`: the same surface, in the same place. */
function fitFromStudio(trs: Trs, fit: ShapeFit): Trs {
  return applyFit(trs, fit, true);
}

function applyFit(trs: Trs, fit: ShapeFit, undo: boolean): Trs {
  if ('turn' in fit) {
    const [x, y, z] = trs.scale;
    const [tx, ty, tz, tw] = fit.turn;
    return {
      translation: [...trs.translation],
      rotation: multiply(trs.rotation, undo ? [-tx, -ty, -tz, tw] : fit.turn),
      scale: [x, z, y],
    };
  }
  return {
    translation: [...trs.translation],
    rotation: [...trs.rotation],
    scale: trs.scale.map((value, axis) => (undo ? value / fit.scale[axis] : value * fit.scale[axis])) as Vec3,
  };
}

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

// ---------------------------------------------------------------------------
// Writing a scene for the studio

/**
 * A model's files as the studio keeps them: an asset of its own, which every
 * node placing those files shares.
 */
export interface StudioAsset {
  uuid: string;
  /** Where each file lands in the studio project, the .gltf first. */
  paths: string[];
  /** The files themselves, in the order of `paths`. */
  files: Uint8Array[];
}

/** Where a model's files go in the studio project. */
export interface StudioAssetPlace {
  /** The project folder they go in. */
  folder: string;
  /** What the .gltf — and so its .bin — is called, extension aside. */
  stem: string;
}

export interface StudioExportModel {
  /** What its node is called. */
  name: string;
  /** Where it sits in the scene; models here hang off the scene itself. */
  placement: Trs;
  hidden: boolean;
  asset: StudioAsset;
}

export interface StudioExport {
  name: string;
  objects: readonly SceneObject[];
  /** The scene objects hidden in the preview, which the studio has hidden too. */
  hiddenObjects: ReadonlySet<number>;
  models: readonly StudioExportModel[];
  camera: CameraView | null;
  environment: EnvironmentSettings;
}

/** A node of the tree as it is written: everything the studio's own nodes carry. */
interface StudioTreeNode {
  id: string;
  name: string;
  type: string;
  components: Record<string, unknown>;
  children: StudioTreeNode[];
}

/** Where the studio's own projects keep models. */
const MODELS_FOLDER = 'assets/models';

/** The preview's field of view, so the studio's camera frames the scene the way the view did. */
const CAMERA_FOV = 50;

/** Looked at from a little way off, for a scene that has never been on screen. */
const FALLBACK_VIEW: CameraView = { position: [0, 2, 5], target: [0, 0, 0] };

/**
 * Where a model's files go in the studio project: back where they came from,
 * for a model the studio exported, so importing them there again offers to
 * replace the originals; else a folder of their own under assets/models.
 * `taken` holds the .gltf paths handed out already, lower-cased, so two
 * different sets of files never land on one another.
 */
export function studioAssetPlace(projectPath: string | null, name: string, taken: Set<string>): StudioAssetPlace {
  const claim = (place: StudioAssetPlace): boolean => {
    const path = `${place.folder}/${place.stem}.gltf`.toLowerCase();
    if (taken.has(path)) return false;
    taken.add(path);
    return true;
  };
  if (projectPath) {
    const at = projectPath.replace(/\\/g, '/');
    const place = {
      folder: at.slice(0, Math.max(at.lastIndexOf('/'), 0)) || MODELS_FOLDER,
      stem: baseName(at).replace(/\.(glb|gltf)$/i, '') || 'model',
    };
    if (claim(place)) return place;
  }
  const stem = plainFileName(name) || 'model';
  for (let count = 1; ; count++) {
    const place = { folder: `${MODELS_FOLDER}/${count === 1 ? stem : `${stem}_${count}`}`, stem };
    if (claim(place)) return place;
  }
}

/**
 * Makes a model's written files an asset of the studio's. The studio unpacks
 * an asset's files into its folder by name alone, and reads the paths a .gltf
 * gives them unencoded — so each file it refers to sits right beside it, under
 * a name that needs no encoding and is not taken twice.
 *
 * `written` is the .gltf, called `${place.stem}.gltf`, and every file it
 * refers to, keyed by the path the .gltf spells it with.
 */
export function studioAsset(written: ReadonlyMap<string, Uint8Array>, place: StudioAssetPlace): StudioAsset {
  const gltfName = `${place.stem}.gltf`;
  const gltf = written.get(gltfName);
  if (!gltf) throw new Error(`${gltfName} was not written`);
  const json = JSON.parse(new TextDecoder().decode(gltf)) as {
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
  };

  const taken = new Set([gltfName.toLowerCase()]);
  const renamed = new Map<string, string>();
  // The .bin first, as the studio lists a model's files, then the textures.
  const others = [...written.keys()].filter((path) => path !== gltfName);
  others.sort((a, b) => Number(!/\.bin$/i.test(a)) - Number(!/\.bin$/i.test(b)));
  for (const path of others) {
    const name = plainFileName(baseName(path)) || 'file';
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let free = name;
    for (let count = 2; taken.has(free.toLowerCase()); count++) free = `${stem}_${count}${extension}`;
    taken.add(free.toLowerCase());
    renamed.set(path, free);
  }
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (typeof entry.uri !== 'string' || entry.uri.startsWith('data:')) continue;
    const name = renamed.get(decodeUri(entry.uri));
    if (name) entry.uri = name;
  }

  const paths = [gltfName, ...renamed.values()].map((name) => `${place.folder}/${name}`);
  const files = [
    new TextEncoder().encode(JSON.stringify(json, null, 2)),
    ...others.map((path) => written.get(path)!),
  ];
  return { uuid: crypto.randomUUID(), paths, files };
}

/**
 * A zip the studio imports as a scene: the tree, the list of assets, and each
 * asset's files in a folder named after it — along with what could not be
 * carried over, for the message that follows the export.
 */
export async function writeStudioScene(scene: StudioExport): Promise<{ zip: Uint8Array; notes: string[] }> {
  const id = crypto.randomUUID();
  const children = [
    ...objectNodes(scene.objects, scene.hiddenObjects),
    cameraNode(scene.camera ?? FALLBACK_VIEW),
    ...scene.models.map(modelNode),
  ];
  const main = {
    name: scene.name,
    id,
    type: '3D',
    root: { id: 'ROOT', name: 'ROOT', type: 'root', components: {}, children },
    settings: sceneSettings(scene.environment),
  };

  const assets = [...new Set(scene.models.map((model) => model.asset))];
  const zipPath = (asset: StudioAsset, path: string) => `${asset.uuid}/${baseName(path)}`;
  const meta = {
    type: 'scene',
    main: `assets/.core/scenes3d/${id}.gsscene`,
    assets: assets.map((asset, index) => ({
      uuid: asset.uuid,
      type: 'gltf',
      assets: asset.paths,
      assetsZipPaths: asset.paths.map((path) => zipPath(asset, path)),
      index,
    })),
    stuffs: [],
  };

  const encoder = new TextEncoder();
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    [MAIN_FILE]: encoder.encode(JSON.stringify(main)),
    [META_FILE]: encoder.encode(JSON.stringify(meta)),
  };
  for (const asset of assets) {
    asset.paths.forEach((path, index) => {
      const bytes = asset.files[index];
      // Images are compressed already, so they are stored rather than deflated again.
      entries[zipPath(asset, path)] = /\.(gltf|bin)$/i.test(path) ? bytes : [bytes, { level: 0 }];
    });
  }
  const { zipSync } = await import('fflate');
  return { zip: zipSync(entries, { level: 6 }), notes: exportNotes(scene) };
}

/** The scene's own objects as a tree of studio nodes, each under the one it hangs off. */
function objectNodes(objects: readonly SceneObject[], hidden: ReadonlySet<number>): StudioTreeNode[] {
  const byParent = new Map<number | null, SceneObject[]>();
  for (const object of objects) {
    const siblings = byParent.get(object.parent);
    if (siblings) siblings.push(object);
    else byParent.set(object.parent, [object]);
  }

  const build = (object: SceneObject): StudioTreeNode => {
    const children = (byParent.get(object.id) ?? []).map(build);
    const visible = !hidden.has(object.id);
    const type = TYPE_OF_KIND[object.kind];
    const components = objectComponents(object);
    const fit = SHAPE_FIT[object.kind];
    if (!fit) return studioNode(type, object.name, object.trs, visible, components, children);
    if (children.length === 0) {
      return studioNode(type, object.name, fitToStudio(object.trs, fit), visible, components);
    }
    // Its children were placed in this shape's frame, which the studio's shape
    // does not share: a group keeps that frame, and holds the shape and them.
    const shape = studioNode(type, object.name, fitToStudio(DEFAULT_TRS, fit), true, components);
    return studioNode('node3D', object.name, object.trs, visible, {}, [shape, ...children]);
  };
  return (byParent.get(null) ?? []).map(build);
}

/** What a studio node of the object's type carries besides its transform, as the studio's own defaults spell it. */
function objectComponents(object: SceneObject): Record<string, unknown> {
  const color = object.color ?? '#ffffff';
  const intensity = object.intensity ?? 1;
  const castShadow = object.castShadow ?? false;
  const target = { ...studioVec(object.target ?? [0, 0, 0]), linked: false };
  const light = { light: { type: 'light', color, intensity } };
  switch (object.kind) {
    case 'group':
      return {};
    case 'box':
    case 'sphere':
    case 'cylinder':
    case 'cone':
    case 'plane':
      // The studio's default material: shapes keep their shadows, not their colours.
      return {
        mesh: {
          type: 'mesh',
          geometry: 'default',
          material: 'default',
          castShadow,
          receiveShadow: object.receiveShadow ?? false,
        },
      };
    case 'ambient':
      return light;
    case 'directional':
      return {
        ...light,
        directionalLight: {
          type: 'directionalLight',
          color,
          intensity,
          target,
          debug: false,
          castShadow,
          bias: object.shadowBias ?? 0,
          shadowMapSize: object.shadowMapSize ?? 1024,
          // The studio's default: its shadow covers a fixed square, where the
          // preview's is fitted to what casts.
          shadowAreaSize: 20,
        },
      };
    case 'hemisphere':
      return {
        hemisphereLight: {
          type: 'hemisphereLight',
          color,
          groundColor: object.groundColor ?? '#ffffff',
          intensity,
        },
      };
    case 'point':
      return {
        ...light,
        pointLight: {
          type: 'pointLight',
          color,
          intensity,
          distance: object.distance ?? 0,
          decay: object.decay ?? 2,
          debug: false,
          castShadow,
        },
      };
    case 'spot':
      return {
        ...light,
        spotLight: {
          type: 'spotLight',
          color,
          target,
          intensity,
          distance: object.distance ?? 0,
          decay: object.decay ?? 2,
          angle: object.angle ?? Math.PI / 3,
          penumbra: object.penumbra ?? 0,
          debug: false,
          castShadow,
          shadowMapSize: object.shadowMapSize ?? 1024,
        },
      };
  }
}

/** The view as the scene's camera: where it was, looking where it looked. */
function cameraNode(view: CameraView): StudioTreeNode {
  return studioNode('perspectiveCamera', 'Camera', lookFrom(view.position, view.target), true, {
    perspectiveCamera: {
      type: 'perspectiveCamera',
      fov: CAMERA_FOV,
      aspect: 2,
      near: 0.1,
      far: 2000,
      debug: false,
    },
  });
}

function modelNode(model: StudioExportModel): StudioTreeNode {
  const { uuid, paths } = model.asset;
  return studioNode('model', model.name, model.placement, !model.hidden, {
    model: {
      type: 'model',
      stuffs: null,
      stuffsDataId: '',
      modelUUID: uuid,
      modelPath: paths[0],
      animations: {},
      morphs: [],
    },
    modelTree: { type: 'modelTree', modelUUID: uuid, modelData: {} },
  });
}

function studioNode(
  type: string,
  name: string,
  trs: Trs,
  visible: boolean,
  components: Record<string, unknown>,
  children: StudioTreeNode[] = [],
): StudioTreeNode {
  return {
    id: crypto.randomUUID(),
    name,
    type,
    components: { node3D: node3D(name, trs, visible), ...components },
    children,
  };
}

/** A node3D component: the transform, with the rotation as the studio keeps it — XYZ Euler angles in degrees. */
function node3D(label: string, trs: Trs, visible: boolean): Record<string, unknown> {
  const [x, y, z] = trs.scale;
  const rotation = quaternionToEuler(trs.rotation).map((angle) => tidy(toDegrees(angle)));
  return {
    type: 'node3D',
    label,
    visible,
    position: { ...studioVec(trs.translation), linked: false },
    scale: { x, y, z, linked: x === y && y === z },
    rotation: { ...studioVec(rotation), linked: false },
    renderOrder: 0,
    optionalLoad: false,
    optionalLoadID: '',
    optionalLoadValue: '',
  };
}

/** A new studio scene's settings, with this scene's environment strength. */
function sceneSettings(environment: EnvironmentSettings): Record<string, unknown> {
  return {
    type: 'scene',
    backgroundType: 'solid',
    backgroundColor1: '#FFFFFF',
    backgroundColor2: '#FFFFFF',
    backgroundImage: null,
    backgroundVideo: null,
    skyboxImage: null,
    fog: false,
    fogType: 'linear',
    fogColor: '#FF0000',
    fogNear: 10,
    fogFar: 20,
    fogDensity: 0.02,
    // The studio's environment is a map from its assets; the room has none.
    environment: null,
    environmentIntensity: environment.mode === 'room' ? environment.intensity : 1,
    hdrFile: null,
    cubemap: null,
    optionalLoad: false,
    optionalLoadID: '',
    optionalLoadValue: '',
    render: {
      type: 'default',
      canvas: {
        id: '',
        zIndex: 0,
        autoScale: false,
        visible: true,
        width: 800,
        height: 800,
        transparentBackground: false,
      },
    },
  };
}

function exportNotes(scene: StudioExport): string[] {
  const notes: string[] = [];
  const coloured = scene.objects.some(
    (object) => SCENE_OBJECT_KINDS[object.kind].category === 'mesh' && (object.color ?? '#ffffff') !== '#ffffff',
  );
  if (coloured) notes.push("Shapes go with the studio's default material — their colours stay behind.");
  if (scene.environment.mode === 'room') {
    notes.push('The room lighting stays behind: give the scene an environment map in the studio to match it.');
  }
  return notes;
}

/**
 * The transform of a camera at `eye` looking at `target` with +Y up, the way
 * three.js's lookAt turns one: it looks down its own -Z.
 */
function lookFrom(eye: Vec3, target: Vec3): Trs {
  let z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]) ?? [0, 0, 1];
  let x = normalize(cross([0, 1, 0], z));
  if (!x) {
    // Straight up or down: three.js nudges the view off the axis the same way.
    z = normalize([z[0], z[1], z[2] + 0.0001])!;
    x = normalize(cross([0, 1, 0], z))!;
  }
  const y = cross(z, x);
  const { rotation } = decomposeMatrix([...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1]);
  return { translation: [...eye], rotation, scale: [1, 1, 1] };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** The vector at length 1, or null when it has no direction. */
function normalize(v: Vec3): Vec3 | null {
  const length = Math.hypot(...v);
  return length < 1e-9 ? null : [v[0] / length, v[1] / length, v[2] / length];
}

function studioVec([x, y, z]: readonly number[]): { x: number; y: number; z: number } {
  return { x, y, z };
}

/** An angle without the float dust a round trip through a quaternion leaves on it, and never -0. */
function tidy(degrees: number): number {
  return Math.round(degrees * 1e9) / 1e9 || 0;
}

/**
 * A file name that reads the same encoded or not — which is how the studio
 * reads the ones a .gltf gives — and that every file system takes.
 */
function plainFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
}

function decodeUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    // A lone '%' from a hand-edited file: take it literally.
    return uri;
  }
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
