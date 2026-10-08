/**
 * 3D preview built on three.js, lazy-loaded so the base app stays tiny.
 *
 * Its whole job is answering "which name belongs to which object": every
 * three.js object is mapped back to the glTF JSON index it came from, using
 * GLTFLoader's `parser.associations` rather than names (names are neither
 * unique nor stable — the loader itself renames instanced meshes and strips
 * characters from the rest).
 *
 * Several files can share the scene, the way the three.js editor imports model
 * after model into one scene. Each is loaded, hidden and dropped on its own, and
 * every index this class takes or hands out is qualified by the model it belongs
 * to — node 3 of one file has nothing to do with node 3 of another.
 *
 * The scene itself belongs to none of them. Each model hangs off it in a group
 * of its own, and that group can be moved like any object in the editor — which
 * is how models that all arrive at the origin get out of each other's way. Where
 * a model sits is the scene's business, never written into its file.
 *
 * The scene has objects of its own as well — its lights, and the shapes and
 * groups added to it — which the app describes and this class only builds. They
 * are addressed by their own ids, apart from any model's indices.
 */
import {
  AmbientLight,
  BasicShadowMap,
  Box3,
  Box3Helper,
  BoxGeometry,
  ClampToEdgeWrapping,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DirectionalLightHelper,
  DoubleSide,
  FrontSide,
  GridHelper,
  Group,
  HemisphereLight,
  HemisphereLightHelper,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  LinearSRGBColorSpace,
  LoadingManager,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  MirroredRepeatWrapping,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  NeutralToneMapping,
  NoColorSpace,
  Object3D,
  PCFShadowMap,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  PointLightHelper,
  RawShaderMaterial,
  Raycaster,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SphereGeometry,
  SpotLight,
  SpotLightHelper,
  Texture,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
  type BufferGeometry,
  type InstancedMesh,
  type Light,
  type LightShadow,
  type MagnificationTextureFilter,
  type Material,
  type MinificationTextureFilter,
  type ShadowMapType,
  type Wrapping,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationPlayer, type ClipInfo, type ClipRange, type PlaybackState } from './animation';
import type { CompressionUse, GltfJson, GltfMaterial } from './gltf';
import {
  MAP_SLOTS,
  materialLook,
  materialType,
  type MapSlot,
  type MaterialLook,
  type MaterialType,
} from './material';
import { baseName, buildResourceLookup, normalizeUri } from './resources';
import { MAP_SLOT_NAMES, textureLook, type TextureLook } from './texture';
import {
  categoryOf,
  hasTransform,
  type EnvironmentSettings,
  type SceneObject,
  type SceneObjectKind,
} from './scene';
import { DEFAULT_SHADOWS, readShadowFlags, type ShadowFlags, type ShadowSettings, type ShadowType } from './shadow';

export type { ClipInfo, PlaybackState } from './animation';

/** Categories that map to something in the 3D scene. */
export type TargetKind = 'node' | 'mesh' | 'material';
/** Categories whose visibility can be toggled. Materials are a cross-cutting
 * filter rather than a scene-graph object, so they only ever get highlighted. */
const HIDE_KINDS = ['node', 'mesh'] as const;
export type HideKind = (typeof HIDE_KINDS)[number];

const KINDS: TargetKind[] = ['node', 'mesh', 'material'];

/**
 * A pointer into one model's glTF JSON: which node/mesh/material an object came
 * from. Naming no index at all, it points at the model as a whole.
 */
export interface SelectionRef {
  /** Which open model the indices belong to. */
  model: number;
  node?: number;
  mesh?: number;
  material?: number;
}

export interface LoadRequest {
  /**
   * GLB bytes, or glTF JSON *text*. Never the live JSON object: GLTFLoader
   * writes `isBone`/`isSkinnedMesh` into the node and mesh defs it is handed,
   * which would end up in the file the user downloads.
   */
  source: ArrayBuffer | string;
  /** Sidecar files supplied by the user, for external URIs. */
  resources: Map<string, File>;
  /** Image URIs from the JSON; missing ones are faked so geometry still shows. */
  imageUris: string[];
  compression: CompressionUse;
  /**
   * Keep the camera and whatever is hidden, for reloads that only mean to
   * change what the model looks like (a newly assigned texture, added files).
   */
  keepView?: boolean;
  /**
   * Where the model sits in the scene, null for where its file has it. Left out,
   * whatever the scene already had for it stays.
   */
  placement?: NodeTrs | null;
  /** The stretch of each clip that plays, by animation index; null plays all of it. */
  clipRanges?: (ClipRange | null)[];
}

export interface LoadResult {
  /** Indices that actually exist in the 3D scene, per category. */
  renderable: Record<TargetKind, Set<number>>;
  /** Indices that exist but have no geometry (empties, cameras, lights). */
  geometryless: Set<number>;
  /** Image URIs replaced with a placeholder because the file wasn't supplied. */
  substitutedImages: string[];
  objectCount: number;
  warnings: string[];
}

/** Why one of the scene's own objects is not on screen. */
export interface ObjectHiddenState {
  reason: 'self' | 'ancestor' | null;
  /** The object whose own toggle is responsible, when reason is 'ancestor'. */
  byObject?: number;
}

/** Why something is not on screen, so the UI can explain it. */
export interface HiddenState {
  /** 'model' when the whole file it is in has been hidden. */
  reason: 'self' | 'ancestor' | 'mesh' | 'model' | null;
  /** The node whose own toggle is responsible, when reason is 'ancestor'. */
  byNode?: number;
  /** The mesh whose own toggle is responsible, when reason is 'mesh'. */
  byMesh?: number;
}

/** The viewport read-out's numbers, in the three.js editor's terms. */
export interface SceneStats {
  /** Visible objects in the scene — the wrapper groups themselves excluded. */
  objects: number;
  vertices: number;
  triangles: number;
  /** Milliseconds the last frame spent inside `renderer.render`. */
  renderTime: number;
}

/** What the gizmo is doing to whatever it is attached to. */
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** A node's local transform, in the shape glTF stores it. */
export interface NodeTrs {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

/** Where something sits in the world, for read-only display. */
export interface Placement {
  origin: [number, number, number];
  size: [number, number, number];
  instances: number;
}

/** Where the camera is looking from, and at what — enough to restore a view. */
export interface CameraView {
  position: [number, number, number];
  target: [number, number, number];
}

export interface ViewerCallbacks {
  /** User clicked an object in the viewport (null = clicked empty space). */
  onPick(ref: SelectionRef | null): void;
  /** A frame was drawn, so the read-out's render time has moved on. */
  onRender(): void;
  /** The gizmo moved a node of a model; its document has to follow. */
  onTransform(model: number, node: number, trs: NodeTrs): void;
  /** The gizmo moved a model as a whole, which only the scene records. */
  onPlace(model: number, trs: NodeTrs): void;
  /** User clicked one of the scene's own objects in the viewport. */
  onPickObject(id: number): void;
  /** The gizmo moved one of the scene's own objects. */
  onObjectTransform(id: number, trs: NodeTrs): void;
  /** A model's playback moved on or changed, so the controls have to follow. */
  onAnimation(model: number): void;
}

/** Everything the scene holds for one file. */
interface LoadedModel {
  /**
   * The file's scene hangs off this, so the model can be hidden, dropped or moved
   * whole. Its transform is the model's placement in the scene.
   */
  group: Group;
  objects: Record<TargetKind, Map<number, Object3D[]>>;
  /** The live material instances behind each glTF material index. */
  materialsByIndex: Map<number, Material[]>;
  /**
   * Instances drawn on geometry without tangents. The loader flips the Y of
   * their normal scales, which a scale set later has to do again.
   */
  flippedNormals: Set<Material>;
  /** Retained so textures can be assigned without re-parsing the whole file. */
  parser: GLTF['parser'];
  textureCount: number;
  /** Texture copies this class made, and is therefore responsible for. */
  ownedTextures: Set<Texture>;
  tracked: Object3D[];
  blobUrls: string[];
  /** The file's own pose, before the scene placed it anywhere. */
  localBox: Box3;
  /** The same, where the model sits in the scene: what the grid is fitted to. */
  box: Box3;
  /** Plays the file's animations; null when it has none. */
  player: AnimationPlayer | null;
  /**
   * Transforms typed in while a clip held the model posed. A clip saves the pose
   * it finds when it starts and puts that back when it stops, so these go back
   * on top the moment it does.
   */
  restEdits: Map<number, NodeTrs>;
  /** Morph weights set while a clip held the model, by node, for the same reason. */
  restWeights: Map<number, number[]>;
}

type HiddenSets = Record<HideKind, Set<number>>;

type LightHelper = DirectionalLightHelper | HemisphereLightHelper | PointLightHelper | SpotLightHelper;

/** What the scene holds for one of its own objects. */
interface SceneEntry {
  kind: SceneObjectKind;
  /** The scene object it hangs off, as the app last said; null for the scene. */
  parent: number | null;
  object: Object3D;
  /** How a light is drawn in the viewport, since a light itself is invisible. */
  helper: LightHelper | null;
  /**
   * What a click on a light hits. A helper is a few thin lines, which are hard
   * to hit — and a click meant for whatever is behind its rays should not land
   * on the light — so an invisible ball around the light answers instead.
   */
  picker: Mesh | null;
}

// The three.js editor outlines the selection in yellow; hover uses the UI accent.
const SELECT_COLOR = 0xffff00;
const HOVER_COLOR = 0x0088ff;

/**
 * What the floor is fitted to when nothing in the scene has a size — only
 * lights, or nothing yet: the editor's plain grid around the origin, 10 wide.
 */
const EMPTY_SCENE_BOX = new Box3(new Vector3(-2, 0, -2), new Vector3(2, 0, 2));
/** Light helpers are sized to the floor, so they stay findable at any scale. */
const HELPER_SCALE = 0.04;

/** A light as any of them is, with the shadow only the directional, point and spot ones have. */
type LightWithShadow = Light & { shadow?: LightShadow };

/** The renderer's shadow map filters, by the name the scene keeps them under. */
const SHADOW_MAP_TYPES: Record<ShadowType, ShadowMapType> = {
  basic: BasicShadowMap,
  pcf: PCFShadowMap,
  pcfsoft: PCFSoftShadowMap,
  vsm: VSMShadowMap,
};

export class Viewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  /** Every model's group hangs off this, so picking has one thing to test. */
  private readonly root = new Group();
  private readonly selectionBox: Box3Helper;
  private readonly hoverBox: Box3Helper;
  private readonly raycaster = new Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly gizmo: TransformControls;
  private gizmoEnabled = true;
  /**
   * What the gizmo is attached to, so its moves can be attributed: a node of a
   * model, or — with a null node — the model as a whole.
   */
  private gizmoTarget: { model: number; node: number | null } | null = null;
  /** The scene object the gizmo is attached to, when it is one of those instead. */
  private gizmoObject: number | null = null;
  private grid: GridHelper | null = null;
  private gridVisible = true;
  private envTexture: Texture | null = null;

  private readonly models = new Map<number, LoadedModel>();
  /** Which group belongs to which model, for resolving a hit to its file. */
  private readonly modelByGroup = new Map<Object3D, number>();
  /**
   * Bumped by every load and unload of a model, so a load that finishes after
   * it was superseded — or after its model was closed — knows to bow out.
   */
  private readonly generations = new Map<number, number>();
  /**
   * What is hidden in each model. Kept apart from the loaded scene, so it lives
   * through a keepView reload — and a delete landing while one is in flight can
   * still renumber it.
   */
  private readonly hidden = new Map<number, HiddenSets>();
  /** Models hidden whole, from the outliner's model rows or by Isolate. */
  private readonly hiddenModels = new Set<number>();
  /**
   * Where each model that has been moved as a whole sits in the scene. Kept
   * apart from the loaded scene for the same reason `hidden` is: a reload puts
   * the model back where it was, not where its file has it.
   */
  private readonly placements = new Map<number, NodeTrs>();
  private readonly refByObject = new Map<Object3D, SelectionRef>();

  /** The scene's own objects hang off this, apart from every model's group. */
  private readonly objectsRoot = new Group();
  /** Light helpers and their pickers: drawn, and picked, but in nothing's box. */
  private readonly helpersRoot = new Group();
  private readonly sceneObjects = new Map<number, SceneEntry>();
  /** Which scene object a three.js object — or a light's picker — stands for. */
  private readonly idByObject = new Map<Object3D, number>();
  /** Scene objects hidden in the preview, kept by id like a model's hidden sets. */
  private readonly hiddenObjects = new Set<number>();
  private readonly pickerMaterial = new MeshBasicMaterial({ visible: false });
  /** How big light helpers are drawn, following the floor. */
  private helperSize = 10 * HELPER_SCALE;

  private placeholderUrl: string | null = null;
  /**
   * Every model and every shape at once: what the grid and the depth range are
   * fitted to.
   */
  private sceneBox = new Box3();
  /** The scene's own shapes alone, as the floor was last fitted to them. */
  private objectsBox = new Box3();
  private selection: SelectionRef | null = null;
  /** The scene object picked, when the selection is one of those rather than a model's. */
  private selectedObject: number | null = null;
  /**
   * Everything selected besides the one above, from a Ctrl or Shift click in
   * the outliner: each has a box of the same yellow, but no gizmo.
   */
  private extraRefs: SelectionRef[] = [];
  private extraObjects: number[] = [];
  /** Grown as more are selected at once, and kept for the next time. */
  private readonly extraBoxes: Box3Helper[] = [];
  private pointerDownAt: Vector2 | null = null;
  /** Counting geometry walks the scene, so it is cached until the scene moves. */
  private counts: Omit<SceneStats, 'renderTime'> | null = null;
  private renderTime = 0;
  private frameRequested = false;
  private disposed = false;
  /** Whether a clip that reaches its end starts over — the same for every model. */
  private animationLoop = true;
  /** How fast clips play, and which way — the same for every model, like looping. */
  private animationSpeed = 1;
  private animationReverse = false;
  /** When the last frame that moved playback on ran; null while nothing plays. */
  private lastTick: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ViewerCallbacks,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearAlpha(0);
    this.renderer.toneMapping = NeutralToneMapping;
    // As a new scene has it; setShadows brings it in step with the scene's own.
    this.renderer.shadowMap.enabled = DEFAULT_SHADOWS.enabled;
    this.renderer.shadowMap.type = SHADOW_MAP_TYPES[DEFAULT_SHADOWS.type];
    this.container.append(this.renderer.domElement);

    this.camera = new PerspectiveCamera(50, 1, 0.01, 1000);
    this.camera.position.set(3, 2.5, 4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());

    const environment = new RoomEnvironment();
    const pmrem = new PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(environment, 0.04).texture;
    pmrem.dispose();
    disposeSubtree(environment);
    // Lit by the app from here on: the environment through setEnvironment, the
    // lights as scene objects of their own through syncObjects.
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.9;

    this.selectionBox = new Box3Helper(new Box3(), new Color(SELECT_COLOR));
    this.hoverBox = new Box3Helper(new Box3(), new Color(HOVER_COLOR));
    for (const helper of [this.selectionBox, this.hoverBox]) {
      helper.visible = false;
      // Helpers must never intercept clicks or inflate a bounding box.
      helper.raycast = () => {};
      this.scene.add(helper);
    }

    this.scene.add(this.root, this.objectsRoot, this.helpersRoot);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('world');
    // Orbiting while dragging an axis would fight the drag.
    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = event.value !== true;
      // A model moved whole takes the grid with it, once it has been let go —
      // refitting on every step of the drag would have the floor chase it. A
      // shape of the scene's own does the same.
      const target = this.gizmoTarget;
      if (event.value !== true && target?.node === null) this.placeBox(target.model);
      if (event.value !== true && this.gizmoObject !== null) this.updateGrid();
    });
    this.gizmo.addEventListener('objectChange', () => this.reportTransform());
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.scene.add(this.gizmo.getHelper());
    // A floor from the start, for a scene that has nothing with a size in it yet.
    this.updateGrid();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      // A press that starts on a gizmo axis belongs to the gizmo, and must not
      // also count as a click that picks whatever is behind it.
      this.pointerDownAt = this.gizmo.axis === null
        ? new Vector2(event.clientX, event.clientY)
        : null;
    });
    canvas.addEventListener('pointerup', (event) => {
      const down = this.pointerDownAt;
      this.pointerDownAt = null;
      // Ignore the pointerup that ends an orbit drag.
      if (!down || down.distanceTo(new Vector2(event.clientX, event.clientY)) > 5) return;
      this.pick(event);
    });
    canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());
    // On-demand rendering means a restored context stays blank until asked.
    canvas.addEventListener('webglcontextrestored', () => this.invalidate());
  }

  // -------------------------------------------------------------------------
  // Loading

  /**
   * Loads one model into the scene, in place of whatever that model showed
   * before. Every other model is left exactly as it is.
   */
  async load(id: number, request: LoadRequest): Promise<LoadResult> {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    const stale = (): boolean => this.disposed || this.generations.get(id) !== generation;

    // Taken before dropModel(), which is what drops it.
    const keptView =
      request.keepView === true && this.models.size > 0
        ? { position: this.camera.position.clone(), target: this.controls.target.clone() }
        : null;
    // A keepView reload shows the same model differently, so a clip that was on
    // carries on where it was — as long as the file still has the same clips.
    const previousPlayer = this.models.get(id)?.player;
    const keptPlayback =
      request.keepView === true && previousPlayer
        ? { clips: previousPlayer.list().length, state: previousPlayer.state() }
        : null;

    // What is hidden is kept through a keepView load rather than copied aside,
    // so a delete landing while this one is in flight can still renumber it. A
    // fresh look at a model starts with all of it on show.
    if (request.keepView !== true) {
      this.hidden.delete(id);
      this.hiddenModels.delete(id);
    }
    // Stored now and read once the file is in, so a placement typed in while
    // this load runs is the one it ends up with.
    if (request.placement !== undefined) this.storePlacement(id, request.placement);
    this.dropModel(id);

    const substitutedImages: string[] = [];
    const lookup = buildResourceLookup(request.resources);
    const imageKeys = new Set(request.imageUris.map(normalizeUri));
    const resolved = new Map<string, string>();
    const blobUrls: string[] = [];
    const revoke = (): void => {
      for (const url of blobUrls) URL.revokeObjectURL(url);
      blobUrls.length = 0;
    };

    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      // A load can still be in flight after dispose() or an unload; minting
      // blob URLs then would outlive the revoke that already ran.
      if (stale()) return url;
      // data:/blob: URLs are the loader's own embedded resources — including the
      // blob URLs it mints for bufferView-backed images. Never touch them.
      if (/^(data:|blob:|https?:|\/\/)/i.test(url)) return url;

      const key = normalizeUri(url);
      const cached = resolved.get(key);
      if (cached !== undefined) return cached;

      const file = lookup.get(key) ?? lookup.get(baseName(key));
      if (file) {
        // One stable blob URL per URI: a fresh one per call would leak and
        // defeat the loader's in-flight request de-duplication.
        const blobUrl = URL.createObjectURL(file);
        blobUrls.push(blobUrl);
        resolved.set(key, blobUrl);
        return blobUrl;
      }
      // A .ktx2 container cannot be faked with a PNG, so leave it to fail softly.
      if (imageKeys.has(key) && !key.endsWith('.ktx2')) {
        substitutedImages.push(url);
        const placeholder = this.placeholderImage();
        resolved.set(key, placeholder);
        return placeholder;
      }
      return url;
    });

    const loader = new GLTFLoader(manager);
    const warnings: string[] = [];
    const cleanups: (() => void)[] = [];

    let gltf: GLTF;
    try {
      if (request.compression.draco) {
        const { DRACOLoader, DRACO_GLTF_CONFIG } = await import(
          'three/addons/loaders/DRACOLoader.js'
        );
        const draco = new DRACOLoader(manager);
        draco.setDecoderPath(DRACO_GLTF_CONFIG);
        loader.setDRACOLoader(draco);
        cleanups.push(() => draco.dispose());
      }
      if (request.compression.meshopt) {
        const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
        loader.setMeshoptDecoder(MeshoptDecoder);
      }
      if (request.compression.ktx2) {
        const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
        const ktx2 = new KTX2Loader(manager);
        ktx2.detectSupport(this.renderer);
        loader.setKTX2Loader(ktx2);
        cleanups.push(() => ktx2.dispose());
      }

      gltf = await new Promise<GLTF>((resolve, reject) => {
        loader.parse(request.source, '', resolve, (error) => reject(asError(error)));
      });
    } catch (error) {
      revoke();
      throw error;
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
    if (stale()) {
      revoke();
      throw new Error('Preview was closed while loading.');
    }

    const sceneRoot = gltf.scene ?? gltf.scenes[0];
    if (!sceneRoot) {
      revoke();
      throw new Error('This file has no scene to preview.');
    }

    rebuildKeptTypes(gltf, sceneRoot);
    const group = new Group();
    group.add(sceneRoot);
    this.root.add(group);
    this.modelByGroup.set(group, id);

    const model: LoadedModel = {
      group,
      objects: { node: new Map(), mesh: new Map(), material: new Map() },
      materialsByIndex: new Map(),
      flippedNormals: new Set(),
      parser: gltf.parser,
      textureCount: (gltf.parser.json as { textures?: unknown[] }).textures?.length ?? 0,
      ownedTextures: new Set(),
      tracked: [],
      blobUrls,
      localBox: new Box3(),
      box: new Box3(),
      player: null,
      restEdits: new Map(),
      restWeights: new Map(),
    };
    this.models.set(id, model);
    this.buildMaps(id, model, gltf);
    this.applyShadowFlags(model, gltf);
    this.applyKeptAnisotropy(model);
    // Measured while the group still stands where the file has it, so the box
    // can follow the model wherever the scene puts it without measuring again.
    model.localBox = new Box3().setFromObject(group);
    const placement = this.placements.get(id);
    if (placement) applyTrs(group, placement);
    model.box = model.localBox.clone().applyMatrix4(group.matrix);
    this.counts = null;
    this.updateGrid();

    // Made after the box, so the grid and the depth range fit the file's own
    // pose rather than wherever a kept clip is about to put it.
    if (gltf.animations.length > 0) {
      const player = new AnimationPlayer(sceneRoot, gltf.animations, () =>
        this.applyRestEdits(model),
      );
      player.setLoop(this.animationLoop);
      player.setSpeed(this.animationSpeed);
      player.setReverse(this.animationReverse);
      // Before a kept clip is put back, so it lands inside its trim.
      request.clipRanges?.forEach((range, clip) => {
        if (range) player.setRange(clip, range);
      });
      model.player = player;
      const kept = keptPlayback?.state;
      if (kept && kept.clip !== null && keptPlayback.clips === gltf.animations.length) {
        player.seek(kept.clip, kept.time);
        if (kept.playing) player.play(kept.clip);
      }
    }
    // Puts whatever was hidden before a keepView reload back out of sight.
    this.applyVisibility();

    if (keptView) {
      this.camera.position.copy(keptView.position);
      this.controls.target.copy(keptView.target);
      this.controls.update();
      this.invalidate();
    } else {
      this.frameAll();
    }

    if (model.objects.mesh.size === 0) {
      warnings.push('This file has no renderable geometry, so there is nothing to show.');
    }

    return {
      renderable: {
        node: new Set(model.objects.node.keys()),
        mesh: new Set(model.objects.mesh.keys()),
        material: new Set(model.objects.material.keys()),
      },
      geometryless: this.findGeometrylessNodes(model),
      substitutedImages,
      objectCount: model.tracked.length,
      warnings,
    };
  }

  /** Takes a model out of the scene for good: its file has been closed. */
  unload(id: number): void {
    // Whatever load of it is still running must not put it back.
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.dropModel(id);
    this.hidden.delete(id);
    this.hiddenModels.delete(id);
    this.placements.delete(id);
    this.updateGrid();
    this.invalidate();
  }

  /** Whether a model has something in the scene right now. */
  hasModel(id: number): boolean {
    return this.models.has(id);
  }

  /**
   * Maps every three.js object back to its glTF indices. One object can carry
   * several: a node whose mesh has a single primitive becomes one Mesh that is
   * simultaneously the node, the mesh and a material user. Conversely one index
   * can map to many objects, since the loader clones reused nodes and meshes.
   */
  private buildMaps(id: number, model: LoadedModel, gltf: GLTF): void {
    const associations = gltf.parser.associations;
    const materialIndexOf = (material: Material): number | undefined =>
      associations.get(material)?.materials;

    model.group.traverse((object) => {
      const association = associations.get(object);
      const ref: SelectionRef = { model: id };

      if (association?.nodes !== undefined) ref.node = association.nodes;
      if (association?.meshes !== undefined) ref.mesh = association.meshes;

      const mesh = object as Mesh;
      if (mesh.isMesh) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const index = materialIndexOf(material);
          if (index === undefined) continue;
          if (ref.material === undefined) ref.material = index;
          push(model.objects.material, index, object);
          // The loader clones a material per geometry variant (vertex colours,
          // flat shading…), so one index can own several live instances.
          const instances = model.materialsByIndex.get(index);
          if (!instances) model.materialsByIndex.set(index, [material]);
          else if (!instances.includes(material)) instances.push(material);
          // Such geometry always gets a clone of its own, so the instance
          // is flipped for every mesh it is on.
          if (mesh.geometry.attributes.tangent === undefined) model.flippedNormals.add(material);
        }
      }

      if (ref.node === undefined && ref.mesh === undefined && ref.material === undefined) return;
      if (ref.node !== undefined) push(model.objects.node, ref.node, object);
      if (ref.mesh !== undefined) push(model.objects.mesh, ref.mesh, object);
      this.refByObject.set(object, ref);
      model.tracked.push(object);
    });
  }

  /** Nodes present in the scene but carrying no drawable geometry. */
  private findGeometrylessNodes(model: LoadedModel): Set<number> {
    const result = new Set<number>();
    for (const [index, objects] of model.objects.node) {
      const hasGeometry = objects.some((object) => {
        let found = false;
        object.traverse((child) => {
          if (isDrawable(child)) found = true;
        });
        return found;
      });
      if (!hasGeometry) result.add(index);
    }
    return result;
  }

  /** Takes a model's scene out and frees it. What is hidden in it is kept. */
  private dropModel(id: number): void {
    const model = this.models.get(id);
    if (!model) return;
    this.root.remove(model.group);
    this.modelByGroup.delete(model.group);
    model.player?.dispose();
    disposeSubtree(model.group);
    // Already disposed with the materials that held them, by disposeSubtree().
    model.ownedTextures.clear();
    for (const object of model.tracked) this.refByObject.delete(object);
    for (const url of model.blobUrls) URL.revokeObjectURL(url);
    model.blobUrls.length = 0;
    this.models.delete(id);

    if (this.gizmoTarget?.model === id) {
      this.gizmo.detach();
      this.gizmoTarget = null;
    }
    this.counts = null;
    // The selection may point into it; its box goes until the model is back.
    this.refreshSelectionBox();
    this.hoverBox.visible = false;
  }

  // -------------------------------------------------------------------------
  // Materials

  /**
   * Sets a material's colours, amounts and alpha on every live instance of it,
   * the way the loader would have built them from the edited JSON. A change of
   * type is not among them: that is another three.js class, and needs a reload.
   */
  setMaterialLook(id: number, materialIndex: number, look: MaterialLook): void {
    const model = this.models.get(id);
    const materials = model?.materialsByIndex.get(materialIndex);
    if (!model || !materials) return;
    for (const material of materials) applyLook(material, look, model.flippedNormals.has(material));
    this.invalidate();
  }

  /**
   * Points one of a material's map slots at a texture, or clears it with null.
   *
   * Returns false when the change cannot be shown without re-parsing the file —
   * a texture the loader has never seen, a material that is not in the scene,
   * or one that is not yet the type with that slot — so the caller can fall
   * back to a reload.
   */
  async setMaterialMap(
    id: number,
    materialIndex: number,
    slot: MapSlot,
    textureIndex: number | null,
  ): Promise<boolean> {
    const model = this.models.get(id);
    const materials = model?.materialsByIndex.get(materialIndex);
    if (!model || !materials || materials.length === 0) return false;
    const spec = MAP_SLOTS[slot];
    // A clearcoat map on a material still loaded as Standard, say: the panel
    // offers it once the type has changed, and the reload that brings the
    // physical material in may not have landed yet.
    if (!materials.every((material) => spec.maps.every((key) => key in material))) return false;

    let texture: Texture | null = null;
    if (textureIndex !== null) {
      if (textureIndex >= model.textureCount) return false;
      let loaded: Texture | null;
      try {
        // The parser applies the sampler, flipY and any KTX2 transcoding, which
        // is why the texture is fetched through it rather than loaded here.
        loaded = (await model.parser.getDependency('texture', textureIndex)) as Texture | null;
      } catch {
        return false;
      }
      // An image the loader could not decode resolves to null rather than
      // rejecting, and a reload is the only thing that can explain that on
      // screen — it substitutes a placeholder for images it cannot get.
      if (loaded === null) return false;
      // The model may have been reloaded or closed while the texture decoded.
      if (this.disposed || this.models.get(id) !== model) return false;

      // Colour space belongs to the slot, not the image, and the parser hands
      // out one shared instance per texture — so each slot gets its own view of
      // it. The copy shares the decoded image, so it costs no extra memory.
      texture = loaded.clone();
      texture.colorSpace = spec.srgb ? SRGBColorSpace : NoColorSpace;
      texture.needsUpdate = true;
      model.ownedTextures.add(texture);
    }

    // A factor the texture needed lifting (emissive black, clearcoat 0) comes
    // with the look the caller sets next, straight from the JSON.
    for (const material of materials) this.applyMap(model, material, spec.maps, texture);
    this.invalidate();
    return true;
  }

  private applyMap(
    model: LoadedModel,
    material: Material,
    keys: readonly string[],
    texture: Texture | null,
  ): void {
    const maps = material as unknown as Record<string, Texture | null>;
    // One texture can feed two maps (metalness and roughness), so each is
    // looked at once, however many of the keys held it.
    const replaced = new Set<Texture>();
    for (const key of keys) {
      const previous = maps[key];
      if (previous) replaced.add(previous);
      maps[key] = texture;
    }

    // Adding or removing a map changes the shader, not just a uniform.
    material.needsUpdate = true;
    for (const previous of replaced) {
      if (previous !== texture && model.ownedTextures.delete(previous)) previous.dispose();
    }
  }

  /**
   * Sets how one of a material's map slots samples its texture — wrap,
   * filtering, anisotropy, UV set and transform — the way the loader would have
   * set it up from the edited JSON.
   */
  setTextureLook(id: number, materialIndex: number, slot: MapSlot, look: TextureLook): void {
    const model = this.models.get(id);
    if (!model) return;
    this.applyTextureLook(model, materialIndex, slot, look);
    this.invalidate();
  }

  private applyTextureLook(model: LoadedModel, materialIndex: number, slot: MapSlot, look: TextureLook): void {
    const materials = model.materialsByIndex.get(materialIndex);
    if (!materials) return;
    const spec = MAP_SLOTS[slot];
    // The loader hands one texture to every map with the same image and
    // sampler, and a transform or UV set is one slot's alone — so the slot gets
    // a copy of its own first, the way an assigned texture does. Instances of
    // the one material share it, as they share everything else.
    const copies = new Map<Texture, Texture>();
    for (const material of materials) {
      const maps = material as unknown as Record<string, Texture | null | undefined>;
      for (const key of spec.maps) {
        const current = maps[key];
        if (!current?.isTexture) continue;
        let own = model.ownedTextures.has(current) ? current : copies.get(current);
        if (!own) {
          own = current.clone();
          own.colorSpace = spec.srgb ? SRGBColorSpace : NoColorSpace;
          model.ownedTextures.add(own);
          copies.set(current, own);
        }
        // Which UV set a map reads is compiled into the shader.
        if (own !== current || own.channel !== look.channel) material.needsUpdate = true;
        maps[key] = own;
        setUpTexture(own, look);
      }
    }
  }

  /**
   * Anisotropy has no glTF form: the file keeps it in its samplers' extras,
   * which the loader does not read. So it is put on here, as an edit puts it on.
   */
  private applyKeptAnisotropy(model: LoadedModel): void {
    const json = model.parser.json as GltfJson;
    (json.materials ?? []).forEach((definition, index) => {
      for (const slot of MAP_SLOT_NAMES) {
        const look = textureLook(json, definition, slot);
        if (look && look.anisotropy > 1) this.applyTextureLook(model, index, slot, look);
      }
    });
  }

  // -------------------------------------------------------------------------
  // The scene's own objects

  /**
   * Makes the scene's own objects match the app's list: new ones are made, gone
   * ones dropped, and every one set to what the list says — parent, place and
   * properties. The list is short, so setting all of it is simpler than applying
   * each change on its own, and it cannot miss one.
   */
  syncObjects(specs: readonly SceneObject[]): void {
    const wanted = new Set(specs.map((spec) => spec.id));
    for (const id of [...this.sceneObjects.keys()]) {
      if (!wanted.has(id)) this.dropObject(id);
    }
    for (const spec of specs) {
      let entry = this.sceneObjects.get(spec.id);
      if (entry && entry.kind !== spec.kind) {
        this.dropObject(spec.id);
        entry = undefined;
      }
      entry ??= this.makeObject(spec);
      entry.parent = spec.parent;
      applyObjectProps(entry.object, spec);
    }
    // In list order, so siblings end up in the order the outliner shows them:
    // adding an object that already has a parent moves it to the end.
    for (const spec of specs) {
      const parent = spec.parent === null ? undefined : this.sceneObjects.get(spec.parent);
      (parent?.object ?? this.objectsRoot).add(this.sceneObjects.get(spec.id)!.object);
    }
    this.counts = null;
    // A shape added, moved or resized changes what the floor has to cover — but
    // a colour dragged across the picker changes nothing the floor cares about.
    if (!new Box3().setFromObject(this.objectsRoot).equals(this.objectsBox)) this.updateGrid();
    this.applyVisibility();
  }

  private makeObject(spec: SceneObject): SceneEntry {
    const object = buildObject(spec.kind);
    const entry: SceneEntry = { kind: spec.kind, parent: spec.parent, object, helper: null, picker: null };
    this.sceneObjects.set(spec.id, entry);
    this.idByObject.set(object, spec.id);
    this.addHelper(spec.id, entry);
    return entry;
  }

  private dropObject(id: number): void {
    const entry = this.sceneObjects.get(id);
    if (!entry) return;
    entry.object.removeFromParent();
    this.removeHelper(entry);
    // Its own geometry only: whatever hangs off it is a scene object of its own,
    // and is either dropped too or given a new parent.
    if (isDrawable(entry.object)) {
      entry.object.geometry.dispose();
      disposeMaterialOf(entry.object.material);
    }
    if ((entry.object as Light).isLight) (entry.object as Light).dispose();
    this.idByObject.delete(entry.object);
    this.sceneObjects.delete(id);
    this.hiddenObjects.delete(id);
  }

  /** Draws a light, which is otherwise invisible, the way the editor draws one. */
  private addHelper(id: number, entry: SceneEntry): void {
    const size = this.helperSize;
    let helper: LightHelper;
    switch (entry.kind) {
      case 'directional':
        helper = new DirectionalLightHelper(entry.object as DirectionalLight, size);
        break;
      case 'hemisphere':
        helper = new HemisphereLightHelper(entry.object as HemisphereLight, size);
        break;
      case 'point':
        helper = new PointLightHelper(entry.object as PointLight, size);
        break;
      case 'spot':
        helper = new SpotLightHelper(entry.object as SpotLight);
        break;
      default:
        // An ambient light is everywhere at once: there is nothing to draw.
        return;
    }
    helper.traverse((part) => {
      part.raycast = () => {};
    });
    // The picker follows the light by sharing its world matrix, the way the
    // helpers themselves do.
    const picker = new Mesh(new SphereGeometry(size * 1.2, 8, 4), this.pickerMaterial);
    picker.matrixAutoUpdate = false;
    picker.matrix = entry.object.matrixWorld;
    this.idByObject.set(picker, id);
    this.helpersRoot.add(helper, picker);
    entry.helper = helper;
    entry.picker = picker;
  }

  private removeHelper(entry: SceneEntry): void {
    if (entry.helper) {
      this.helpersRoot.remove(entry.helper);
      entry.helper.dispose();
      entry.helper = null;
    }
    if (entry.picker) {
      this.helpersRoot.remove(entry.picker);
      entry.picker.geometry.dispose();
      this.idByObject.delete(entry.picker);
      entry.picker = null;
    }
  }

  /** Redraws every light's helper at a new size, once the floor has changed enough to notice. */
  private setHelperSize(size: number): void {
    if (Math.abs(size - this.helperSize) <= this.helperSize * 0.01) return;
    this.helperSize = size;
    for (const [id, entry] of this.sceneObjects) {
      if (!entry.helper) continue;
      this.removeHelper(entry);
      this.addHelper(id, entry);
    }
  }

  /**
   * Brings the selected light's helper up to date with it, just before a frame
   * is drawn. Helpers read their light's world matrix, which only the frame
   * itself brings up to date, so this is the one place they are sure to be right.
   *
   * Only the light that is selected is drawn: a helper is a debugging aid, and
   * several of them over the models are clutter. Its picker goes with it, since
   * an invisible thing to click in the middle of the view would take clicks meant
   * for whatever is behind it.
   */
  private updateHelpers(): void {
    for (const [id, entry] of this.sceneObjects) {
      if (!entry.helper || !entry.picker) continue;
      const shown = id === this.selectedObject && isWorldVisible(entry.object);
      entry.helper.visible = shown;
      entry.picker.visible = shown;
      if (!shown) continue;
      entry.helper.update();
      entry.picker.matrixWorldNeedsUpdate = true;
      if (entry.helper instanceof SpotLightHelper) this.fitCone(entry.helper, entry.object as SpotLight);
    }
  }

  /**
   * A spot light with no range of its own is drawn 1000 units long, which is
   * either the whole screen or nothing at all. It is drawn as far as the point it
   * is aimed at instead.
   */
  private fitCone(helper: SpotLightHelper, light: SpotLight): void {
    const from = new Vector3().setFromMatrixPosition(light.matrixWorld);
    const to = new Vector3().setFromMatrixPosition(light.target.matrixWorld);
    const length = light.distance || from.distanceTo(to) || this.helperSize * 4;
    const width = length * Math.tan(light.angle);
    helper.cone.scale.set(width, width, length);
  }

  /** The room reflected in every material, on or off, and how strongly. */
  setEnvironment(settings: EnvironmentSettings): void {
    this.scene.environment = settings.mode === 'room' ? this.envTexture : null;
    this.scene.environmentIntensity = settings.intensity;
    this.invalidate();
  }

  /** How shadows are drawn, or that they are not: the editor's Project settings. */
  setShadows(settings: ShadowSettings): void {
    const { shadowMap } = this.renderer;
    const type = SHADOW_MAP_TYPES[settings.type];
    if (shadowMap.enabled === settings.enabled && shadowMap.type === type) return;
    shadowMap.enabled = settings.enabled;
    shadowMap.type = type;
    // Both are compiled into every lit material's shader, and nothing else would
    // rebuild it: the editor makes a whole new renderer for this.
    this.scene.traverse((object) => {
      if (!isDrawable(object)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.needsUpdate = true;
      }
    });
    this.invalidate();
  }

  /** Sets a node's shadow flags, ticked in its panel. */
  setNodeShadow(id: number, node: number, flags: ShadowFlags): void {
    const objects = this.models.get(id)?.objects.node.get(node);
    if (!objects) return;
    for (const object of objects) this.applyNodeShadow(object, flags);
    this.invalidate();
  }

  /**
   * Gives every node of a freshly loaded model the flags its extras carry —
   * what code loading the file would do with `userData.castShadow`. Read from
   * the JSON the loader parsed rather than from `userData`, which a mesh's
   * extras are merged into as well.
   */
  private applyShadowFlags(model: LoadedModel, gltf: GLTF): void {
    const definitions = (gltf.parser.json as { nodes?: { extras?: Record<string, unknown> }[] }).nodes ?? [];
    for (const [index, objects] of model.objects.node) {
      const flags = readShadowFlags(definitions[index]?.extras);
      if (!flags.cast && !flags.receive) continue;
      for (const object of objects) this.applyNodeShadow(object, flags);
    }
  }

  /**
   * Sets the flags on what a node draws: itself, or the primitives the loader
   * hung under it for a mesh with several — never the nodes under it, which
   * carry flags of their own.
   */
  private applyNodeShadow(object: Object3D, flags: ShadowFlags, own = true): void {
    if (!own && this.refByObject.get(object)?.node !== undefined) return;
    if (isDrawable(object)) {
      object.castShadow = flags.cast;
      object.receiveShadow = flags.receive;
    }
    for (const child of object.children) this.applyNodeShadow(child, flags, false);
  }

  /**
   * Fits each casting light's shadow camera to the scene, just before a frame.
   * three.js draws a directional light's shadow inside a fixed 10-unit box, and
   * a point or spot light's out to 500 units: the one clips a big model and
   * spends its whole map on a small one, the other cannot reach a big scene's
   * floor. So the map is fitted to what casts — the models on show, and the
   * scene's own casting shapes — and its depth to everything a shadow could
   * fall on.
   */
  private fitShadowCameras(): void {
    if (!this.renderer.shadowMap.enabled) return;
    let casters: Box3 | null = null;
    for (const entry of this.sceneObjects.values()) {
      const light = entry.object as LightWithShadow;
      if (!light.isLight || !light.castShadow || !light.shadow || !isWorldVisible(light)) continue;
      casters ??= this.castersBox();
      if (casters.isEmpty()) return;
      // The frame brings world matrices up to date after this; the light may
      // have moved since the last one.
      light.updateWorldMatrix(true, false);
      if (entry.kind === 'directional') {
        fitDirectionalShadow(light as DirectionalLight, casters, this.sceneBox);
      } else {
        fitPerspectiveShadow(light as SpotLight | PointLight, casters, this.sceneBox);
      }
    }
  }

  /** What throws shadows, as far as the scene knows: the models on show, and the shapes told to cast. */
  private castersBox(): Box3 {
    const box = new Box3();
    for (const model of this.models.values()) {
      if (model.group.visible) box.union(model.box);
    }
    for (const entry of this.sceneObjects.values()) {
      const shape = entry.object;
      if (!isDrawable(shape) || !shape.castShadow || !isWorldVisible(shape)) continue;
      shape.updateWorldMatrix(true, false);
      box.union(drawableBox(shape));
    }
    return box;
  }

  selectObject(id: number | null): void {
    this.selection = null;
    this.selectedObject = id;
    this.refreshSelectionBox();
    this.updateGizmo();
  }

  highlightObject(id: number | null): void {
    this.showBox(this.hoverBox, id === null ? null : this.objectBox(id, true));
  }

  frameObject(id: number): void {
    const box = this.objectBox(id, false);
    if (box) this.fit(box, false);
  }

  isObjectHidden(id: number): boolean {
    return this.hiddenObjects.has(id);
  }

  setObjectHidden(id: number, hidden: boolean): void {
    if (hidden) this.hiddenObjects.add(id);
    else this.hiddenObjects.delete(id);
    this.applyVisibility();
  }

  /** Why a scene object is off screen: hidden itself, or under a group that is. */
  objectHiddenState(id: number): ObjectHiddenState {
    if (this.hiddenObjects.has(id)) return { reason: 'self' };
    const seen = new Set<number>([id]);
    for (let at = this.sceneObjects.get(id)?.parent ?? null; at !== null && !seen.has(at); ) {
      if (this.hiddenObjects.has(at)) return { reason: 'ancestor', byObject: at };
      seen.add(at);
      at = this.sceneObjects.get(at)?.parent ?? null;
    }
    return { reason: null };
  }

  /**
   * Shows one scene object on its own: every model goes, and every other shape.
   * The lights stay, since the object is still to be seen by them.
   */
  isolateObject(id: number): void {
    this.isolateMany([], [id]);
  }

  /** Hides the scene's own shapes — never its lights — all but the ones kept. */
  private hideShapesExcept(keep: Set<Object3D>): void {
    for (const [id, entry] of this.sceneObjects) {
      if (categoryOf(entry.kind) === 'mesh' && !keep.has(entry.object)) this.hiddenObjects.add(id);
    }
  }

  /**
   * What a scene object takes up in the world: its shapes, or — for a light, or
   * a group with nothing drawn in it — a small box where it sits. An ambient
   * light sits nowhere, and has no box at all.
   */
  private objectBox(id: number, visibleOnly: boolean): Box3 | null {
    const entry = this.sceneObjects.get(id);
    if (!entry || entry.kind === 'ambient') return null;
    if (visibleOnly && !isWorldVisible(entry.object)) return null;
    entry.object.updateWorldMatrix(true, true);
    const box = new Box3();
    entry.object.traverse((object) => {
      if (isDrawable(object) && (!visibleOnly || isWorldVisible(object))) box.union(drawableBox(object));
    });
    if (!box.isEmpty()) return box;
    const position = entry.object.getWorldPosition(new Vector3());
    return new Box3().setFromCenterAndSize(position, new Vector3().setScalar(this.helperSize * 2.4));
  }

  // -------------------------------------------------------------------------
  // Visibility

  /** A model's hidden sets, made on first use. */
  private hiddenOf(id: number): HiddenSets {
    let sets = this.hidden.get(id);
    if (!sets) {
      sets = { node: new Set(), mesh: new Set() };
      this.hidden.set(id, sets);
    }
    return sets;
  }

  isHidden(id: number, kind: HideKind, index: number): boolean {
    return this.hidden.get(id)?.[kind].has(index) ?? false;
  }

  setHidden(id: number, kind: HideKind, index: number, hidden: boolean): void {
    if (hidden) this.hiddenOf(id)[kind].add(index);
    else this.hidden.get(id)?.[kind].delete(index);
    this.applyVisibility();
  }

  toggleHidden(id: number, kind: HideKind, index: number): boolean {
    const next = !this.isHidden(id, kind, index);
    this.setHidden(id, kind, index, next);
    return next;
  }

  isModelHidden(id: number): boolean {
    return this.hiddenModels.has(id);
  }

  /** Hides or shows a whole file at once, leaving its own toggles as they were. */
  setModelHidden(id: number, hidden: boolean): void {
    if (hidden) this.hiddenModels.add(id);
    else this.hiddenModels.delete(id);
    this.applyVisibility();
  }

  /**
   * Follows a delete that renumbered a model's document, ahead of the reload
   * showing it: whatever was hidden stays hidden under its new index, and
   * whatever went is forgotten. `map` is old index → new, -1 for gone.
   */
  renumber(id: number, kind: HideKind, map: number[]): void {
    const sets = this.hidden.get(id);
    if (!sets) return;
    const hidden = [...sets[kind]];
    sets[kind].clear();
    for (const index of hidden) {
      const next = map[index];
      if (next !== undefined && next !== -1) sets[kind].add(next);
    }
  }

  anyHidden(): boolean {
    if (this.hiddenModels.size > 0 || this.hiddenObjects.size > 0) return true;
    for (const sets of this.hidden.values()) {
      if (HIDE_KINDS.some((kind) => sets[kind].size > 0)) return true;
    }
    return false;
  }

  showAll(): void {
    this.hiddenModels.clear();
    this.hidden.clear();
    this.hiddenObjects.clear();
    this.applyVisibility();
  }

  /**
   * Hides everything that is neither an ancestor nor a descendant of the target,
   * every other model outright, and the scene's own shapes — though not its
   * lights, which the target is still seen by. Implemented as a bulk edit of the
   * same hidden sets, so "Show all" undoes it.
   */
  isolate(ref: SelectionRef): void {
    this.isolateMany([ref], []);
  }

  /**
   * Isolate for several things at once — parts of models and scene objects
   * alike: what is kept is everything any of them needs to be seen.
   */
  isolateMany(refs: readonly SelectionRef[], objects: readonly number[]): void {
    const keep = new Set<Object3D>();
    const keepWith = (target: Object3D): void => {
      target.traverse((object) => keep.add(object));
      for (let parent = target.parent; parent; parent = parent.parent) keep.add(parent);
    };
    for (const ref of refs) for (const target of this.objectsForRef(ref)) keepWith(target);
    for (const id of objects) {
      const entry = this.sceneObjects.get(id);
      if (entry) keepWith(entry.object);
    }
    if (keep.size === 0) return;

    const shown = new Set(refs.map((ref) => ref.model));
    this.hiddenModels.clear();
    this.hidden.clear();
    this.hiddenObjects.clear();
    for (const [id, model] of this.models) {
      if (!shown.has(id)) {
        this.hiddenModels.add(id);
        continue;
      }
      const sets = this.hiddenOf(id);
      for (const [index, nodeObjects] of model.objects.node) {
        if (!nodeObjects.some((object) => keep.has(object))) sets.node.add(index);
      }
    }
    this.hideShapesExcept(keep);
    this.applyVisibility();
  }

  private applyVisibility(): void {
    for (const [id, entry] of this.sceneObjects) entry.object.visible = !this.hiddenObjects.has(id);
    for (const [id, model] of this.models) {
      model.group.visible = !this.hiddenModels.has(id);
      const sets = this.hidden.get(id);
      for (const object of model.tracked) {
        const ref = this.refByObject.get(object);
        if (!ref) continue;
        object.visible = !HIDE_KINDS.some(
          (kind) => ref[kind] !== undefined && sets?.[kind].has(ref[kind]) === true,
        );
      }
    }
    this.refreshSelectionBox();
    this.hoverBox.visible = false;
    // Something hidden cannot be dragged, so the gizmo goes with it.
    this.updateGizmo();
    // Hiding something takes it out of the counts, the way the editor's do.
    this.counts = null;
    this.invalidate();
  }

  /**
   * Why an entry is off screen. Hiding a node hides its whole subtree, so a row
   * can read "visible" while being invisible — this is what lets the UI say so.
   */
  hiddenState(id: number, kind: TargetKind, index: number): HiddenState {
    // The outermost cause first, so revealing it is what the eye offers.
    if (this.hiddenModels.has(id)) return { reason: 'model' };
    const sets = this.hidden.get(id);
    if (kind !== 'material' && sets?.[kind].has(index)) return { reason: 'self' };

    const objects = this.models.get(id)?.objects[kind].get(index);
    if (!sets || !objects || objects.length === 0) return { reason: null };
    if (objects.some((object) => isWorldVisible(object))) return { reason: null };

    for (const object of objects) {
      // The object may be hidden by the other axis: one three.js object is
      // often both a node and a mesh, so a mesh row can be hidden by "its" node.
      const own = this.refByObject.get(object);
      if (kind !== 'mesh' && own?.mesh !== undefined && sets.mesh.has(own.mesh)) {
        return { reason: 'mesh', byMesh: own.mesh };
      }
      for (let parent: Object3D | null = object; parent; parent = parent.parent) {
        const ref = this.refByObject.get(parent);
        if (ref?.node !== undefined && sets.node.has(ref.node)) {
          return { reason: 'ancestor', byNode: ref.node };
        }
        if (parent !== object && ref?.mesh !== undefined && sets.mesh.has(ref.mesh)) {
          return { reason: 'mesh', byMesh: ref.mesh };
        }
      }
    }
    return { reason: 'ancestor' };
  }

  // -------------------------------------------------------------------------
  // Selection

  select(ref: SelectionRef | null): void {
    this.selection = ref;
    this.selectedObject = null;
    this.refreshSelectionBox();
    this.updateGizmo();
  }

  /** What is selected besides the one thing `select` or `selectObject` was given. */
  setExtraSelection(refs: readonly SelectionRef[], objects: readonly number[]): void {
    this.extraRefs = refs.map((ref) => ({ ...ref }));
    this.extraObjects = [...objects];
    this.refreshSelectionBox();
  }

  // -------------------------------------------------------------------------
  // Moving things

  setGizmoEnabled(enabled: boolean): void {
    this.gizmoEnabled = enabled;
    this.updateGizmo();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
    this.invalidate();
  }

  setGizmoSpace(space: 'local' | 'world'): void {
    this.gizmo.setSpace(space);
    this.invalidate();
  }

  /** Whether the gizmo currently has something to move. */
  canTransform(): boolean {
    return this.gizmoTarget !== null || this.gizmoObject !== null;
  }

  /**
   * Attaches the gizmo to whatever is selected, when it can be moved. A node
   * moves within its file. A model as a whole moves within the scene: its group
   * is the object the scene holds it by, the way the three.js editor holds an
   * imported file, and a clip posing what is inside it is no obstacle to that.
   * The scene's own objects move within the scene too, all but an ambient light,
   * which is everywhere at once.
   *
   * Nothing else is movable. A mesh or a material is shared data, and only the
   * node that uses it has a place in the scene. A node a clip is posing is not
   * movable either, since what a drag reports would be the clip's pose rather
   * than the file's.
   */
  private updateGizmo(): void {
    const ref = this.selection;
    const model = ref ? this.models.get(ref.model) : undefined;
    const picked = this.selectedObject === null ? undefined : this.sceneObjects.get(this.selectedObject);
    let target: Object3D | undefined;
    let node: number | null = null;
    if (picked) {
      if (hasTransform(picked.kind)) target = picked.object;
    } else if (ref && model) {
      if (isWholeModel(ref)) {
        target = model.group;
      } else if (ref.node !== undefined && !this.isPosed(ref.model)) {
        target = model.objects.node.get(ref.node)?.[0];
        node = ref.node;
      }
    }

    this.gizmoTarget = null;
    this.gizmoObject = null;
    if (!this.gizmoEnabled || !target || !isWorldVisible(target)) {
      this.gizmo.detach();
    } else {
      if (picked) this.gizmoObject = this.selectedObject;
      else if (ref) this.gizmoTarget = { model: ref.model, node };
      this.gizmo.attach(target);
    }
    this.invalidate();
  }

  /**
   * Hands the dragged node's new local transform back to the document — or, for
   * a model dragged whole, its new place in the scene back to the app, and for
   * one of the scene's own objects, its new place relative to its parent.
   */
  private reportTransform(): void {
    const target = this.gizmoTarget;
    const object = this.gizmo.object;
    if (object === undefined) return;

    const trs = readTrs(object);

    if (this.gizmoObject !== null) {
      this.refreshSelectionBox();
      this.callbacks.onObjectTransform(this.gizmoObject, trs);
      return;
    }
    if (target === null) return;

    if (target.node === null) {
      this.placements.set(target.model, trs);
      this.refreshSelectionBox();
      this.callbacks.onPlace(target.model, trs);
      return;
    }

    // A node the loader had to clone shows up as several objects; they are all
    // the same node in the file, so they all move together.
    for (const other of this.models.get(target.model)?.objects.node.get(target.node) ?? []) {
      if (other !== object) applyTrs(other, trs);
    }

    this.refreshSelectionBox();
    this.callbacks.onTransform(target.model, target.node, trs);
  }

  /** Applies a transform typed into the properties panel. */
  setNodeTransform(id: number, node: number, trs: NodeTrs): void {
    const model = this.models.get(id);
    const objects = model?.objects.node.get(node);
    if (!model || !objects || objects.length === 0) return;
    for (const object of objects) applyTrs(object, trs);
    if (model.player?.isPosed()) {
      // The clip keeps the pose on screen while it holds it; the edit is what
      // the model comes back to once it lets go.
      model.restEdits.set(node, copyTrs(trs));
      model.player.refresh();
    }
    this.refreshSelectionBox();
    this.invalidate();
  }

  /**
   * Puts a model somewhere in the scene — typed into the properties panel, or
   * brought back from a stored session — or, with null, back where its file has
   * it. A model not in the scene yet takes it up once it is.
   */
  setModelPlacement(id: number, trs: NodeTrs | null): void {
    this.storePlacement(id, trs);
    const model = this.models.get(id);
    if (!model) return;
    applyTrs(model.group, this.placements.get(id) ?? IDENTITY_TRS);
    this.placeBox(id);
    this.refreshSelectionBox();
    this.invalidate();
  }

  private storePlacement(id: number, trs: NodeTrs | null): void {
    if (trs === null) this.placements.delete(id);
    else this.placements.set(id, copyTrs(trs));
  }

  /** Follows a model to where the scene has put it: its box, and the grid under all of them. */
  private placeBox(id: number): void {
    const model = this.models.get(id);
    if (!model) return;
    model.box = model.localBox.clone().applyMatrix4(model.group.matrix);
    this.updateGrid();
  }

  /** Puts back what was typed in while a clip held the model, now it has let go. */
  private applyRestEdits(model: LoadedModel): void {
    for (const [node, trs] of model.restEdits) {
      for (const object of model.objects.node.get(node) ?? []) applyTrs(object, trs);
    }
    model.restEdits.clear();
    for (const [node, weights] of model.restWeights) {
      for (const mesh of this.morphMeshes(model, node)) applyWeights(mesh, weights);
    }
    model.restWeights.clear();
  }

  /**
   * Draws a node with these morph target weights — its own, or those of the
   * mesh it shows. As with a transform typed in, a clip holding the model keeps
   * its own weights on screen while it does, and these are what it comes back to.
   */
  setMorphWeights(id: number, node: number, weights: readonly number[]): void {
    const model = this.models.get(id);
    if (!model) return;
    for (const mesh of this.morphMeshes(model, node)) applyWeights(mesh, weights);
    if (model.player?.isPosed()) {
      model.restWeights.set(node, [...weights]);
      model.player.refresh();
    }
    this.invalidate();
  }

  /**
   * The morphable meshes a node draws: the node itself when its mesh has one
   * primitive, else the primitives under it — never a child node, which draws a
   * mesh of its own.
   */
  private morphMeshes(model: LoadedModel, node: number): Mesh[] {
    const meshes: Mesh[] = [];
    const walk = (object: Object3D): void => {
      if (isMorphable(object)) meshes.push(object);
      for (const child of object.children) {
        if (this.refByObject.get(child)?.node === undefined) walk(child);
      }
    };
    // The loader clones a node drawn more than once; every copy is that node.
    for (const object of model.objects.node.get(node) ?? []) walk(object);
    return meshes;
  }

  /** Where something ended up in world space, for the read-only rows. */
  placementOf(ref: SelectionRef): Placement | null {
    const objects = this.objectsForRef(ref);
    if (objects.length === 0) return null;

    const origin = objects[0].getWorldPosition(new Vector3());
    const box = this.boxForRef(ref, false);
    const size = box && !box.isEmpty() ? box.getSize(new Vector3()) : new Vector3();
    return {
      origin: [origin.x, origin.y, origin.z],
      size: [size.x, size.y, size.z],
      instances: objects.length,
    };
  }

  highlight(ref: SelectionRef | null): void {
    this.updateBox(this.hoverBox, ref);
  }

  private updateBox(helper: Box3Helper, ref: SelectionRef | null): void {
    this.showBox(helper, ref ? this.boxForRef(ref, true) : null);
  }

  /** The yellow box, around whichever kind of thing is selected. */
  private refreshSelectionBox(): void {
    if (this.selectedObject !== null) this.showBox(this.selectionBox, this.objectBox(this.selectedObject, true));
    else this.updateBox(this.selectionBox, this.selection);

    const boxes = [
      ...this.extraObjects.map((id) => this.objectBox(id, true)),
      ...this.extraRefs.map((ref) => this.boxForRef(ref, true)),
    ].filter((box): box is Box3 => box !== null && !box.isEmpty());
    while (this.extraBoxes.length < boxes.length) {
      const helper = new Box3Helper(new Box3(), new Color(SELECT_COLOR));
      helper.visible = false;
      helper.raycast = () => {};
      this.scene.add(helper);
      this.extraBoxes.push(helper);
    }
    this.extraBoxes.forEach((helper, index) => {
      const box = boxes[index];
      if (box) helper.box.copy(box);
      helper.visible = box !== undefined;
    });
    this.invalidate();
  }

  private showBox(helper: Box3Helper, box: Box3 | null): void {
    if (!box || box.isEmpty()) {
      helper.visible = false;
    } else {
      helper.box.copy(box);
      helper.visible = true;
    }
    this.invalidate();
  }

  private boxForRef(ref: SelectionRef, visibleOnly: boolean): Box3 | null {
    let objects = this.objectsForRef(ref);
    if (visibleOnly) objects = objects.filter((object) => isWorldVisible(object));
    if (objects.length === 0) return null;
    const box = new Box3();
    for (const object of objects) box.union(new Box3().setFromObject(object));
    return box.isEmpty() ? null : box;
  }

  /**
   * Most specific first: a node pins one instance, a material spans many. A
   * reference naming nothing inside its model stands for the model's group.
   */
  private objectsForRef(ref: SelectionRef): Object3D[] {
    const model = this.models.get(ref.model);
    if (!model) return [];
    for (const kind of KINDS) {
      const index = ref[kind];
      if (index === undefined) continue;
      const objects = model.objects[kind].get(index);
      if (objects && objects.length > 0) return objects;
    }
    return isWholeModel(ref) ? [model.group] : [];
  }

  hasObjects(id: number, kind: TargetKind, index: number): boolean {
    const objects = this.models.get(id)?.objects[kind].get(index);
    return objects !== undefined && objects.length > 0;
  }

  private pick(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const pointer = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);

    // Raycaster does not test `visible`, so hidden geometry would swallow clicks.
    // Models, the scene's own shapes and its lights' pickers are all tested at
    // once, so whichever is nearest wins.
    const hits = this.raycaster.intersectObjects([this.root, this.objectsRoot, this.helpersRoot], true);
    for (const hit of hits) {
      if (!isWorldVisible(hit.object)) continue;
      const object = this.idByObject.get(hit.object);
      if (object !== undefined) {
        this.callbacks.onPickObject(object);
        return;
      }
      const ref = this.resolveRef(hit.object);
      if (ref) {
        this.callbacks.onPick(ref);
        return;
      }
    }
    this.callbacks.onPick(null);
  }

  /** Builds the fullest picture for a hit: its own indices plus the nearest node above. */
  private resolveRef(object: Object3D): SelectionRef | null {
    const own = this.refByObject.get(object);
    const model = own?.model ?? this.modelOf(object);
    if (model === undefined) return null;

    const ref: SelectionRef = { ...own, model };
    if (ref.node === undefined) {
      for (let parent = object.parent; parent; parent = parent.parent) {
        const parentRef = this.refByObject.get(parent);
        if (parentRef?.node !== undefined) {
          ref.node = parentRef.node;
          break;
        }
      }
    }
    // Geometry nothing in its file claims still belongs to that file, so a click
    // on it picks the model rather than nothing.
    return ref;
  }

  /** The model whose group an object sits in. */
  private modelOf(object: Object3D): number | undefined {
    for (let current: Object3D | null = object; current; current = current.parent) {
      const id = this.modelByGroup.get(current);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Animation

  /** A model's clips, in its file's order; empty when it has none or is not in. */
  animations(id: number): ClipInfo[] {
    return this.models.get(id)?.player?.list() ?? [];
  }

  /** Where a model's playback stands, or null when it has nothing to play. */
  playback(id: number): PlaybackState | null {
    return this.models.get(id)?.player?.state() ?? null;
  }

  /** Whether a clip holds a model in anything but the pose its file gives it. */
  isPosed(id: number): boolean {
    return this.models.get(id)?.player?.isPosed() === true;
  }

  playAnimation(id: number, clip: number): void {
    this.changePlayback(id, (player) => player.play(clip));
  }

  pauseAnimation(id: number): void {
    this.changePlayback(id, (player) => player.pause());
  }

  /** Stops a model's clip, which puts it back in the pose its file gives it. */
  stopAnimation(id: number): void {
    this.changePlayback(id, (player) => player.stop());
  }

  /** Holds a model at one instant of a clip, the way dragging a timeline does. */
  seekAnimation(id: number, clip: number, time: number): void {
    this.changePlayback(id, (player) => player.seek(clip, time));
  }

  setAnimationLoop(loop: boolean): void {
    this.animationLoop = loop;
    for (const [id, model] of this.models) {
      if (!model.player) continue;
      model.player.setLoop(loop);
      this.callbacks.onAnimation(id);
    }
  }

  /** Clip seconds per real second, for every model's clips. */
  setAnimationSpeed(speed: number): void {
    this.animationSpeed = speed;
    for (const model of this.models.values()) model.player?.setSpeed(speed);
  }

  /** Plays every model's clips from the end towards the start, or the right way round again. */
  setAnimationReverse(reverse: boolean): void {
    this.animationReverse = reverse;
    for (const model of this.models.values()) model.player?.setReverse(reverse);
  }

  /** Plays only a stretch of one of a model's clips — its trim — or all of it with `null`. */
  setClipRange(id: number, clip: number, range: ClipRange | null): void {
    this.changePlayback(id, (player) => player.setRange(clip, range));
  }

  /** Makes one change to a model's playback, and brings what follows the pose along. */
  private changePlayback(id: number, change: (player: AnimationPlayer) => void): void {
    const model = this.models.get(id);
    if (!model?.player) return;
    change(model.player);
    this.followPose(id, model);
    // Starting or stopping a clip is what gives the gizmo its node back, or
    // takes it away.
    this.updateGizmo();
    this.invalidate();
    this.callbacks.onAnimation(id);
  }

  /** The selection box is fitted to the pose on screen, so it moves with it. */
  private followPose(id: number, model: LoadedModel): void {
    if (this.selection?.model !== id) return;
    // Boxes are read from world matrices, which otherwise only catch up with
    // the pose when the frame is drawn.
    model.group.updateMatrixWorld();
    this.refreshSelectionBox();
  }

  /**
   * Moves every playing clip on to this frame. Returns whether any is still
   * playing, which is what keeps frames coming: the loop runs only while
   * something is actually moving.
   */
  private advanceAnimations(now: number): boolean {
    const seconds = this.lastTick === null ? 0 : (now - this.lastTick) / 1000;
    let playing = false;
    for (const [id, model] of this.models) {
      const player = model.player;
      if (!player?.advance(seconds)) continue;
      if (player.isPlaying()) playing = true;
      this.followPose(id, model);
      this.callbacks.onAnimation(id);
    }
    // Starting from null means the first frame of playback moves by nothing,
    // rather than by however long nothing was playing.
    this.lastTick = playing ? now : null;
    return playing;
  }

  // -------------------------------------------------------------------------
  // Camera & scene furniture

  frameAll(): void {
    this.fit(this.visibleBox(), true);
  }

  frame(ref: SelectionRef): void {
    const box = this.boxForRef(ref, false) ?? this.positionBoxForRef(ref);
    if (box) this.fit(box, false);
  }

  /** Frames several things at once: the box around all of them. */
  frameMany(refs: readonly SelectionRef[], objects: readonly number[]): void {
    const all = new Box3();
    for (const ref of refs) {
      const box = this.boxForRef(ref, false) ?? this.positionBoxForRef(ref);
      if (box) all.union(box);
    }
    for (const id of objects) {
      const box = this.objectBox(id, false);
      if (box) all.union(box);
    }
    if (!all.isEmpty()) this.fit(all, false);
  }

  /** The current view, for storing across a reload. */
  view(): CameraView {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }

  /**
   * Puts the camera back where a stored view had it. The depth range is derived
   * the way `fit` does rather than stored, since it belongs to the scene's scale
   * and not to the view.
   */
  setView(view: CameraView): void {
    if (![...view.position, ...view.target].every(Number.isFinite)) return;
    this.camera.position.fromArray(view.position);
    this.controls.target.fromArray(view.target);

    const size = this.sceneBox.isEmpty()
      ? new Vector3(1, 1, 1)
      : this.sceneBox.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = this.camera.position.distanceTo(this.controls.target) || maxDim;
    this.camera.near = Math.max(maxDim / 1000, 1e-5);
    this.camera.far = Math.max(distance * 20, maxDim * 100);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Bounding boxes ignore visibility, so framing has to filter explicitly. */
  private visibleBox(): Box3 {
    const box = new Box3();
    for (const model of this.models.values()) {
      for (const object of model.tracked) {
        if (!isDrawable(object) || !isWorldVisible(object)) continue;
        box.union(new Box3().setFromObject(object));
      }
    }
    // The scene's own shapes are framed too. traverseVisible stops at anything
    // hidden, so what is under a hidden group is left out with it.
    this.objectsRoot.updateWorldMatrix(true, true);
    this.objectsRoot.traverseVisible((object) => {
      if (isDrawable(object)) box.union(drawableBox(object));
    });
    return box.isEmpty() ? this.sceneBox : box;
  }

  /** Empties, cameras and lights have no geometry — frame where they sit. */
  private positionBoxForRef(ref: SelectionRef): Box3 | null {
    const objects = this.objectsForRef(ref);
    if (objects.length === 0) return null;
    const box = new Box3();
    const position = new Vector3();
    for (const object of objects) box.expandByPoint(object.getWorldPosition(position));
    if (box.isEmpty()) return null;
    const modelBox = this.models.get(ref.model)?.box ?? this.sceneBox;
    const modelSize = modelBox.isEmpty() ? 1 : modelBox.getSize(new Vector3()).length();
    box.expandByScalar(Math.max(modelSize * 0.03, 1e-3));
    return box;
  }

  private fit(box: Box3, resetDirection: boolean): void {
    if (box.isEmpty()) return;
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    const direction = resetDirection
      ? new Vector3(1, 0.75, 1)
      : this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(1, 0.75, 1);
    direction.normalize();

    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.6;
    this.camera.position.copy(center).addScaledVector(direction, distance);
    // Depth range has to track model scale, which ranges from millimetres to kilometres.
    this.camera.near = Math.max(maxDim / 1000, 1e-5);
    this.camera.far = Math.max(distance * 20, maxDim * 100);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.invalidate();
  }

  private updateGrid(): void {
    this.sceneBox = new Box3();
    for (const model of this.models.values()) this.sceneBox.union(model.box);
    // The scene's own shapes take up room as well; its lights take up none.
    this.objectsBox = new Box3().setFromObject(this.objectsRoot);
    this.sceneBox.union(this.objectsBox);

    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      disposeMaterialOf(this.grid.material);
      this.grid = null;
    }

    // A fixed-size grid is invisible around a 5000-unit model and swamps a
    // 0.01-unit one, so it tracks the bounding box — of every model at once.
    const fitted = this.sceneBox.isEmpty() ? EMPTY_SCENE_BOX : this.sceneBox;
    const size = fitted.getSize(new Vector3());
    const extent = Math.max(size.x, size.z, size.y * 0.5, 1e-3) * 2.5;
    const grid = new GridHelper(extent, 20, 0x4a4a4a, 0x2c2c2c);
    const center = fitted.getCenter(new Vector3());
    grid.position.set(center.x, fitted.min.y, center.z);
    grid.raycast = () => {};
    // A reload rebuilds the helper; keep whatever the toolbar last asked for.
    grid.visible = this.gridVisible;
    this.grid = grid;
    this.scene.add(grid);
    this.setHelperSize(extent * HELPER_SCALE);
    this.invalidate();
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    if (this.grid) this.grid.visible = visible;
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Rendering & teardown

  /** What the viewport read-out shows: how much is on screen, and how fast. */
  stats(): SceneStats {
    if (!this.counts) {
      let objects = 0;
      let vertices = 0;
      let triangles = 0;
      const count = (object: Object3D): void => {
        objects++;
        if (!isDrawable(object)) return;
        const position = object.geometry.attributes.position;
        if (!position) return;
        // EXT_mesh_gpu_instancing draws one geometry once per instance.
        const instanced = object as InstancedMesh;
        const copies = instanced.isInstancedMesh ? instanced.count : 1;
        vertices += position.count * copies;
        if (!isTriangleMesh(object)) return;
        const indices = object.geometry.index?.count ?? position.count;
        triangles += (indices / 3) * copies;
      };
      for (const model of this.models.values()) {
        // traverseVisible only reads each object's own flag, so a hidden
        // model's contents would otherwise still be counted.
        if (!model.group.visible) continue;
        // Children, not the group itself: that group is our own, not the file's.
        for (const child of model.group.children) child.traverseVisible(count);
      }
      // The scene's own objects count as well, lights included, as in the editor.
      for (const child of this.objectsRoot.children) child.traverseVisible(count);
      this.counts = { objects, vertices, triangles };
    }
    return { ...this.counts, renderTime: this.renderTime };
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Resizing the drawing buffer blanks it, and ResizeObserver runs after the
    // frame's animation callbacks but before paint: deferring to the next frame
    // would let the browser paint one empty canvas per step of a sidebar drag.
    // Drawing here fills the new buffer in time for this frame's paint.
    this.render();
  }

  /**
   * Renders on demand rather than on a permanent loop: this page is mostly a
   * text editor, and a background render loop would burn battery and compete
   * with typing. A playing clip asks for its frames one at a time, the same way.
   */
  invalidate(): void {
    if (this.disposed || this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame((now) => this.renderFrame(now));
  }

  private renderFrame(now: number): void {
    this.frameRequested = false;
    const playing = this.advanceAnimations(now);
    this.render();
    if (playing) this.invalidate();
  }

  /** The draw itself, callable outside an animation frame (see `resize`). */
  private render(): void {
    if (this.disposed) return;
    // The pane can be collapsed; a later resize will invalidate again.
    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) return;
    const moving = this.controls.update();
    this.updateHelpers();
    this.fitShadowCameras();
    const start = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.renderTime = performance.now() - start;
    this.callbacks.onRender();
    // Damping keeps moving the camera for a few frames after input stops.
    if (moving) this.invalidate();
  }

  private placeholderImage(): string {
    if (this.placeholderUrl) return this.placeholderUrl;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = '#9aa4ab';
      context.fillRect(0, 0, 2, 2);
    }
    this.placeholderUrl = canvas.toDataURL('image/png');
    return this.placeholderUrl;
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    for (const id of [...this.models.keys()]) this.dropModel(id);
    for (const id of [...this.sceneObjects.keys()]) this.dropObject(id);
    this.pickerMaterial.dispose();
    if (this.grid) {
      this.grid.geometry.dispose();
      disposeMaterialOf(this.grid.material);
      this.grid = null;
    }
    for (const helper of [this.selectionBox, this.hoverBox, ...this.extraBoxes]) {
      helper.geometry.dispose();
      disposeMaterialOf(helper.material);
    }
    this.envTexture?.dispose();
    this.envTexture = null;
    this.scene.remove(this.gizmo.getHelper());
    this.gizmo.disconnect();
    this.gizmo.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

// ---------------------------------------------------------------------------
// Helpers

function push<T>(map: Map<number, T[]>, key: number, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const IDENTITY_TRS: NodeTrs = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function applyTrs(object: Object3D, trs: NodeTrs): void {
  object.position.fromArray(trs.translation);
  object.quaternion.fromArray(trs.rotation);
  object.scale.fromArray(trs.scale);
  object.updateMatrix();
}

function readTrs(object: Object3D): NodeTrs {
  return {
    translation: object.position.toArray() as [number, number, number],
    rotation: object.quaternion.toArray() as [number, number, number, number],
    scale: object.scale.toArray() as [number, number, number],
  };
}

function copyTrs(trs: NodeTrs): NodeTrs {
  return { translation: [...trs.translation], rotation: [...trs.rotation], scale: [...trs.scale] };
}

/** A mesh with morph targets to blend. */
function isMorphable(object: Object3D): object is Mesh {
  const mesh = object as Mesh;
  return mesh.isMesh === true && (mesh.morphTargetInfluences?.length ?? 0) > 0;
}

/** One weight per target, in the file's order; a target with none given is not applied. */
function applyWeights(mesh: Mesh, weights: readonly number[]): void {
  const influences = mesh.morphTargetInfluences ?? [];
  for (let target = 0; target < influences.length; target++) influences[target] = weights[target] ?? 0;
}

/**
 * The three.js object for a kind of scene object. Shapes are unit-sized — a 1 m
 * box, and a sphere, cylinder and cone that fit inside one — so they sit
 * together at the origin at the size of each other.
 */
function buildObject(kind: SceneObjectKind): Object3D {
  switch (kind) {
    case 'group':
      return new Group();
    case 'box':
      return shape(new BoxGeometry(1, 1, 1));
    case 'sphere':
      return shape(new SphereGeometry(0.5, 32, 16));
    case 'cylinder':
      return shape(new CylinderGeometry(0.5, 0.5, 1, 32));
    case 'cone':
      return shape(new ConeGeometry(0.5, 1, 32));
    case 'plane':
      // Lying flat and facing up, the way a floor does; three.js stands its
      // plane on edge, facing the camera it was made for.
      return shape(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    case 'ambient':
      return new AmbientLight();
    case 'directional':
      // In three.js a directional light shines from where it is towards its
      // target, which is kept in world space outside the scene graph: moving a
      // group the light is in leaves what it is aimed at where it was.
      return new DirectionalLight();
    case 'hemisphere':
      return new HemisphereLight();
    case 'point':
      return new PointLight();
    case 'spot':
      return new SpotLight();
  }
}

function shape(geometry: BufferGeometry): Mesh {
  return new Mesh(geometry, new MeshStandardMaterial());
}

/** Sets a scene object's three.js counterpart to what the app's description of it says. */
function applyObjectProps(object: Object3D, spec: SceneObject): void {
  object.name = spec.name;
  applyTrs(object, spec.trs);
  if (isDrawable(object)) {
    if (spec.color !== undefined) (object.material as MeshStandardMaterial).color.set(spec.color);
    if (spec.castShadow !== undefined) object.castShadow = spec.castShadow;
    if (spec.receiveShadow !== undefined) object.receiveShadow = spec.receiveShadow;
    return;
  }
  const light = object as Light;
  if (!light.isLight) return;
  if (spec.color !== undefined) light.color.set(spec.color);
  if (spec.intensity !== undefined) light.intensity = spec.intensity;
  if (spec.groundColor !== undefined) (light as HemisphereLight).groundColor.set(spec.groundColor);
  // A point light has the distance and decay a spot light has; only a spot has a cone.
  const spot = light as SpotLight;
  if (spec.distance !== undefined) spot.distance = spec.distance;
  if (spec.decay !== undefined) spot.decay = spec.decay;
  if (spec.angle !== undefined) spot.angle = spec.angle;
  if (spec.penumbra !== undefined) spot.penumbra = spec.penumbra;
  if (spec.target !== undefined) {
    // The target is in no scene graph, so its world matrix is its own to bring
    // up to date — and the renderer reads it for the light's direction.
    spot.target.position.fromArray(spec.target);
    spot.target.updateMatrixWorld();
  }
  if (spec.castShadow !== undefined) light.castShadow = spec.castShadow;
  const { shadow } = light as LightWithShadow;
  if (!shadow) return;
  if (spec.shadowIntensity !== undefined) shadow.intensity = spec.shadowIntensity;
  if (spec.shadowBias !== undefined) shadow.bias = spec.shadowBias;
  if (spec.shadowNormalBias !== undefined) shadow.normalBias = spec.shadowNormalBias;
  if (spec.shadowRadius !== undefined) shadow.radius = spec.shadowRadius;
  if (spec.shadowMapSize !== undefined && shadow.mapSize.x !== spec.shadowMapSize) {
    shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
    // The map was made at the old size; dropped, the next frame makes one at the new.
    shadow.dispose();
    shadow.map = null;
    shadow.mapPass = null;
  }
}

const _lightSpace = new Matrix4();
const _from = new Vector3();
const _to = new Vector3();
const _corner = new Vector3();
const _size = new Vector3();
const _seenCasters = new Box3();
const _seenReceivers = new Box3();

/**
 * Fits a directional light's orthographic shadow camera: its sides to the
 * casters as its map sees them, its depth from the nearest caster to the
 * farthest thing a shadow could fall on. A little padding keeps a caster on the
 * very edge from being cut in half. Nothing is set unless it changed, so a
 * still scene costs nothing here.
 */
function fitDirectionalShadow(light: DirectionalLight, casters: Box3, receivers: Box3): void {
  _from.setFromMatrixPosition(light.matrixWorld);
  _to.setFromMatrixPosition(light.target.matrixWorld);
  // Aimed at itself, the light has no direction, and its shadow camera nothing to look along.
  if (_from.distanceToSquared(_to) < 1e-12) return;
  // The frame the shadow camera will look from — the light's place, facing its
  // target the way a camera does — so a corner lands where the map sees it.
  _lightSpace.identity().lookAt(_from, _to, Object3D.DEFAULT_UP).setPosition(_from).invert();
  seenBox(casters, _lightSpace, _seenCasters);
  const pad = Math.max(_seenCasters.getSize(_size).length() * 0.05, 1e-4);
  // In front of a camera is -z, so the nearest caster has the greatest z.
  const near = -_seenCasters.max.z - pad;
  let far = -_seenCasters.min.z + pad;
  if (!receivers.isEmpty()) far = Math.max(far, -seenBox(receivers, _lightSpace, _seenReceivers).min.z + pad);
  const camera = light.shadow.camera;
  const left = _seenCasters.min.x - pad;
  const right = _seenCasters.max.x + pad;
  const bottom = _seenCasters.min.y - pad;
  const top = _seenCasters.max.y + pad;
  if (
    camera.left === left &&
    camera.right === right &&
    camera.bottom === bottom &&
    camera.top === top &&
    camera.near === near &&
    camera.far === far
  ) {
    return;
  }
  camera.left = left;
  camera.right = right;
  camera.bottom = bottom;
  camera.top = top;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}

/**
 * Fits a spot or point light's perspective shadow camera in depth alone — its
 * width is the cone, or the cube's six faces: near just short of the nearest
 * caster, far just past the farthest thing a shadow could fall on. A light with
 * a range keeps that as its far, the way three.js has it.
 */
function fitPerspectiveShadow(light: SpotLight | PointLight, casters: Box3, receivers: Box3): void {
  _from.setFromMatrixPosition(light.matrixWorld);
  let farthest = farthestCorner(casters, _from);
  if (!receivers.isEmpty()) farthest = Math.max(farthest, farthestCorner(receivers, _from));
  const far = light.distance > 0 ? light.distance : farthest * 1.05 + 1e-3;
  // A perspective depth buffer spends most of its precision just past the near
  // plane, so that goes as far out as the nearest caster allows.
  const near = Math.max(casters.distanceToPoint(_from) * 0.9, far / 5000);
  const camera = light.shadow.camera;
  if (camera.near === near && camera.far === far) return;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}

/** A box's eight corners seen through a matrix, as a box in that frame. */
function seenBox(box: Box3, matrix: Matrix4, out: Box3): Box3 {
  out.makeEmpty();
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    out.expandByPoint(_corner.applyMatrix4(matrix));
  }
  return out;
}

/** How far the farthest corner of a box is from a point. */
function farthestCorner(box: Box3, from: Vector3): number {
  let farthest = 0;
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    farthest = Math.max(farthest, _corner.distanceTo(from));
  }
  return farthest;
}

/** One drawable's own box, without its children's; its world matrix must be current. */
function drawableBox(object: Mesh): Box3 {
  if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
  return object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld);
}

/** A reference naming nothing inside its model: the model as a whole. */
function isWholeModel(ref: SelectionRef): boolean {
  return ref.node === undefined && ref.mesh === undefined && ref.material === undefined;
}

function isWorldVisible(object: Object3D): boolean {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(String(error));
}

function disposeMaterialOf(material: Material | Material[]): void {
  for (const single of Array.isArray(material) ? material : [material]) {
    for (const value of Object.values(single as unknown as Record<string, unknown>)) {
      if (value instanceof Texture) value.dispose();
    }
    single.dispose();
  }
}

/** The types glTF has no form for, which the file keeps in extras. */
const KEPT_TYPES: Partial<Record<MaterialType, () => Material>> = {
  MeshDepthMaterial: () => new MeshDepthMaterial(),
  MeshNormalMaterial: () => new MeshNormalMaterial(),
  MeshLambertMaterial: () => new MeshLambertMaterial(),
  MeshMatcapMaterial: () => new MeshMatcapMaterial(),
  MeshPhongMaterial: () => new MeshPhongMaterial(),
  MeshToonMaterial: () => new MeshToonMaterial(),
  RawShaderMaterial: () => new RawShaderMaterial(),
  ShaderMaterial: () => new ShaderMaterial(),
  ShadowMaterial: () => new ShadowMaterial(),
};

/** What a rebuilt material takes from the one the loader made, where it has it too. */
const KEPT_KEYS = ['name', 'userData', 'map', 'normalMap', 'aoMap', 'emissiveMap', 'vertexColors', 'flatShading'];

/**
 * The loader builds a material whose type is kept in extras as the standard
 * material under it, so each is rebuilt here as the type it names: its maps
 * carried over, and its values from the JSON the way an edit sets them. Its
 * association goes with it, which is how every other part of this class finds
 * a material's index.
 */
function rebuildKeptTypes(gltf: GLTF, root: Object3D): void {
  const definitions = (gltf.parser.json as { materials?: GltfMaterial[] }).materials ?? [];
  const associations = gltf.parser.associations;
  // The loader shares one instance between meshes, so the rebuild is shared too.
  const rebuilt = new Map<Material, Material>();

  const rebuild = (material: Material, flippedNormals: boolean): Material => {
    const done = rebuilt.get(material);
    if (done) return done;
    const index = associations.get(material)?.materials;
    const definition = index === undefined ? undefined : definitions[index];
    const make = definition ? KEPT_TYPES[materialType(definition)] : undefined;
    if (index === undefined || !definition || !make) return material;

    const next = make();
    const source = material as unknown as Record<string, unknown>;
    const target = next as unknown as Record<string, unknown>;
    for (const key of KEPT_KEYS) {
      if (key in target && source[key] !== undefined) target[key] = source[key];
    }
    applyLook(next, materialLook(definition), flippedNormals);
    associations.set(next, { materials: index });
    rebuilt.set(material, next);
    return next;
  };

  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    // As the loader has it: geometry without tangents flips the normal map's Y.
    const flipped = mesh.geometry.attributes.tangent === undefined;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => rebuild(material, flipped))
      : rebuild(mesh.material, flipped);
  });
  // The materials alone: their textures live on in the rebuilt ones.
  for (const material of rebuilt.keys()) material.dispose();
}

/**
 * Sets what a material edit changed on one live instance. Each property is only
 * set where the instance has one by that name, so the one look serves every
 * type alike — a Basic material simply has no roughness, nor Phong a metalness.
 */
function applyLook(material: Material, look: MaterialLook, flippedNormals: boolean): void {
  const target = material as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(look.props)) {
    if (!(key in target)) continue;
    const current = target[key];
    if (current instanceof Color && Array.isArray(value)) {
      current.setRGB(value[0], value[1], value[2], LinearSRGBColorSpace);
    } else if (current instanceof Vector2 && typeof value === 'number') {
      // Normal scales: the loader flips Y where the shader derives tangents.
      current.set(value, flippedNormals ? -value : value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      // The iridescence thickness range, which the material keeps as an array.
      current.splice(0, current.length, ...value);
    } else if (typeof current === 'number' && typeof value === 'number') {
      // Clearcoat, sheen, transmission and the like switch shader features on
      // as they leave zero; their setters see to the recompile. Depth packing
      // is a define, which nothing recompiles by itself.
      if (key === 'depthPacking' && current !== value) material.needsUpdate = true;
      target[key] = value;
    } else if (typeof current === 'string' && typeof value === 'string' && current !== value) {
      // A shader material's source: a new program to compile.
      target[key] = value;
      material.needsUpdate = true;
    }
  }

  const side = look.doubleSided ? DoubleSide : FrontSide;
  const transparent = look.alphaMode === 'BLEND';
  // Both are baked into the shader, which nothing else would rebuild.
  if (material.side !== side || material.transparent !== transparent) material.needsUpdate = true;
  material.side = side;
  material.transparent = transparent;
  // As the loader has it: blended surfaces leave depth alone (three.js #17706).
  material.depthWrite = !transparent;
  material.alphaTest = look.alphaMode === 'MASK' ? look.alphaCutoff : 0;
}

/** glTF's sampler codes as three.js constants, the way GLTFLoader reads them. */
const WRAPPINGS: Record<number, Wrapping> = {
  33071: ClampToEdgeWrapping,
  33648: MirroredRepeatWrapping,
  10497: RepeatWrapping,
};

const MAG_FILTERS: Record<number, MagnificationTextureFilter> = {
  9728: NearestFilter,
  9729: LinearFilter,
};

const MIN_FILTERS: Record<number, MinificationTextureFilter> = {
  9728: NearestFilter,
  9729: LinearFilter,
  9984: NearestMipmapNearestFilter,
  9985: LinearMipmapNearestFilter,
  9986: NearestMipmapLinearFilter,
  9987: LinearMipmapLinearFilter,
};

/** Sets up one texture the way the loader would from a slot's look. */
function setUpTexture(texture: Texture, look: TextureLook): void {
  const wrapS = WRAPPINGS[look.wrapS] ?? RepeatWrapping;
  const wrapT = WRAPPINGS[look.wrapT] ?? RepeatWrapping;
  const magFilter = MAG_FILTERS[look.magFilter] ?? LinearFilter;
  const minFilter = MIN_FILTERS[look.minFilter] ?? LinearMipmapLinearFilter;
  // Sampling is set when the image is uploaded, so only a real change uploads it again.
  if (
    texture.wrapS !== wrapS ||
    texture.wrapT !== wrapT ||
    texture.magFilter !== magFilter ||
    texture.minFilter !== minFilter ||
    texture.anisotropy !== look.anisotropy
  ) {
    texture.wrapS = wrapS;
    texture.wrapT = wrapT;
    texture.magFilter = magFilter;
    texture.minFilter = minFilter;
    texture.anisotropy = look.anisotropy;
    // As the loader has it: mipmaps for the filters that read them, and never
    // for a compressed texture, which brings its own.
    const compressed = (texture as Texture & { isCompressedTexture?: boolean }).isCompressedTexture === true;
    texture.generateMipmaps = !compressed && minFilter !== NearestFilter && minFilter !== LinearFilter;
    texture.needsUpdate = true;
  }
  texture.channel = look.channel;
  texture.offset.set(look.offset[0], look.offset[1]);
  texture.repeat.set(look.repeat[0], look.repeat[1]);
  texture.rotation = look.rotation;
  // The loader turns textures about the corner; a centre is already in the offset.
  texture.center.set(0, 0);
}

/**
 * Meshes are not the only drawables: glTF primitive modes 0-3 become Points,
 * Line, LineLoop and LineSegments, none of which set `isMesh`.
 */
function isDrawable(object: Object3D): object is Mesh {
  const candidate = object as Mesh & { isPoints?: boolean; isLine?: boolean };
  return candidate.isMesh === true || candidate.isPoints === true || candidate.isLine === true;
}

/** Points and lines are drawables too, but only meshes are made of triangles. */
function isTriangleMesh(object: Object3D): boolean {
  return (object as Mesh).isMesh === true;
}

function disposeSubtree(root: Object3D): void {
  root.traverse((object) => {
    if (!isDrawable(object)) return;
    object.geometry.dispose();
    disposeMaterialOf(object.material);
  });
}
