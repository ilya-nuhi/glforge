/**
 * 3D preview built on three.js, lazy-loaded so the base app stays tiny.
 *
 * Its whole job is answering "which name belongs to which object": every
 * three.js object is mapped back to the glTF JSON index it came from, using
 * GLTFLoader's `parser.associations` rather than names (names are neither
 * unique nor stable — the loader itself renames instanced meshes and strips
 * characters from the rest).
 */
import {
  Box3,
  Box3Helper,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  LoadingManager,
  Mesh,
  NeutralToneMapping,
  NoColorSpace,
  Object3D,
  PMREMGenerator,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type InstancedMesh,
  type Material,
  type MeshStandardMaterial,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { CompressionUse, MapSlot } from './gltf';
import { baseName, buildResourceLookup, normalizeUri } from './resources';

/** Categories that map to something in the 3D scene. */
export type TargetKind = 'node' | 'mesh' | 'material';
/** Categories whose visibility can be toggled. Materials are a cross-cutting
 * filter rather than a scene-graph object, so they only ever get highlighted. */
const HIDE_KINDS = ['node', 'mesh'] as const;
export type HideKind = (typeof HIDE_KINDS)[number];

const KINDS: TargetKind[] = ['node', 'mesh', 'material'];

/** A pointer into the glTF JSON: which node/mesh/material an object came from. */
export interface SelectionRef {
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

/** Why something is not on screen, so the UI can explain it. */
export interface HiddenState {
  reason: 'self' | 'ancestor' | 'mesh' | null;
  /** The node whose own toggle is responsible, when reason is 'ancestor'. */
  byNode?: number;
  /** The mesh whose own toggle is responsible, when reason is 'mesh'. */
  byMesh?: number;
}

/** The viewport read-out's numbers, in the three.js editor's terms. */
export interface SceneStats {
  /** Visible objects in the scene — the wrapper group itself excluded. */
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
  /** The gizmo moved a node; the document has to follow. */
  onTransform(node: number, trs: NodeTrs): void;
}

// The three.js editor outlines the selection in yellow; hover uses the UI accent.
const SELECT_COLOR = 0xffff00;
const HOVER_COLOR = 0x0088ff;

export class Viewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  /** Everything loaded from the file hangs off this, so clearing is trivial. */
  private readonly root = new Group();
  private readonly selectionBox: Box3Helper;
  private readonly hoverBox: Box3Helper;
  private readonly raycaster = new Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly gizmo: TransformControls;
  private gizmoEnabled = true;
  /** The node the gizmo is attached to, so its moves can be attributed. */
  private gizmoNode: number | null = null;
  private grid: GridHelper | null = null;
  private gridVisible = true;
  private envTexture: Texture | null = null;

  private readonly objects: Record<TargetKind, Map<number, Object3D[]>> = {
    node: new Map(),
    mesh: new Map(),
    material: new Map(),
  };
  private readonly refByObject = new Map<Object3D, SelectionRef>();
  /** The live material instances behind each glTF material index. */
  private readonly materialsByIndex = new Map<number, Material[]>();
  /** Retained so textures can be assigned without re-parsing the whole file. */
  private parser: GLTF['parser'] | null = null;
  private textureCount = 0;
  /** Texture copies this class made, and is therefore responsible for. */
  private readonly ownedTextures = new Set<Texture>();
  private tracked: Object3D[] = [];
  private readonly hidden: Record<HideKind, Set<number>> = {
    node: new Set(),
    mesh: new Set(),
  };

  private blobUrls: string[] = [];
  private placeholderUrl: string | null = null;
  private modelBox = new Box3();
  private selection: SelectionRef | null = null;
  private pointerDownAt: Vector2 | null = null;
  /** Counting geometry walks the scene, so it is cached until the scene moves. */
  private counts: Omit<SceneStats, 'renderTime'> | null = null;
  private renderTime = 0;
  private frameRequested = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ViewerCallbacks,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearAlpha(0);
    this.renderer.toneMapping = NeutralToneMapping;
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
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.9;

    const key = new DirectionalLight(0xffffff, 1.3);
    key.position.set(4, 6, 5);
    this.scene.add(key);

    this.selectionBox = new Box3Helper(new Box3(), new Color(SELECT_COLOR));
    this.hoverBox = new Box3Helper(new Box3(), new Color(HOVER_COLOR));
    for (const helper of [this.selectionBox, this.hoverBox]) {
      helper.visible = false;
      // Helpers must never intercept clicks or inflate a bounding box.
      helper.raycast = () => {};
      this.scene.add(helper);
    }

    this.scene.add(this.root);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('world');
    // Orbiting while dragging an axis would fight the drag.
    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = event.value !== true;
    });
    this.gizmo.addEventListener('objectChange', () => this.reportTransform());
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.scene.add(this.gizmo.getHelper());

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

  async load(request: LoadRequest): Promise<LoadResult> {
    // Taken before clearModel(), which is what drops both.
    const keptView =
      request.keepView === true && this.tracked.length > 0
        ? { position: this.camera.position.clone(), target: this.controls.target.clone() }
        : null;
    const keptHidden =
      request.keepView === true
        ? { node: new Set(this.hidden.node), mesh: new Set(this.hidden.mesh) }
        : null;

    this.clearModel();

    const substitutedImages: string[] = [];
    const lookup = buildResourceLookup(request.resources);
    const imageKeys = new Set(request.imageUris.map(normalizeUri));
    const resolved = new Map<string, string>();

    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      // A load can still be in flight after dispose(); minting blob URLs then
      // would outlive the revoke that already ran.
      if (this.disposed) return url;
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
        this.blobUrls.push(blobUrl);
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

    let gltf: GLTF;
    try {
      gltf = await new Promise<GLTF>((resolve, reject) => {
        loader.parse(request.source, '', resolve, (error) => reject(asError(error)));
      });
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
    if (this.disposed) {
      this.revokeBlobUrls();
      throw new Error('Preview was closed while loading.');
    }

    const sceneRoot = gltf.scene ?? gltf.scenes[0];
    if (!sceneRoot) throw new Error('This file has no scene to preview.');
    this.root.add(sceneRoot);

    this.parser = gltf.parser;
    this.textureCount = (gltf.parser.json as { textures?: unknown[] }).textures?.length ?? 0;
    this.buildMaps(gltf);
    this.counts = null;
    this.modelBox = new Box3().setFromObject(this.root);
    this.updateGrid();

    if (keptHidden) {
      for (const kind of HIDE_KINDS) {
        for (const index of keptHidden[kind]) this.hidden[kind].add(index);
      }
      this.applyVisibility();
    }
    if (keptView) {
      this.camera.position.copy(keptView.position);
      this.controls.target.copy(keptView.target);
      this.controls.update();
      this.invalidate();
    } else {
      this.frameAll();
    }

    if (this.objects.mesh.size === 0) {
      warnings.push('This file has no renderable geometry, so there is nothing to show.');
    }

    return {
      renderable: {
        node: new Set(this.objects.node.keys()),
        mesh: new Set(this.objects.mesh.keys()),
        material: new Set(this.objects.material.keys()),
      },
      geometryless: this.findGeometrylessNodes(),
      substitutedImages,
      objectCount: this.tracked.length,
      warnings,
    };
  }

  /**
   * Maps every three.js object back to its glTF indices. One object can carry
   * several: a node whose mesh has a single primitive becomes one Mesh that is
   * simultaneously the node, the mesh and a material user. Conversely one index
   * can map to many objects, since the loader clones reused nodes and meshes.
   */
  private buildMaps(gltf: GLTF): void {
    const associations = gltf.parser.associations;
    const materialIndexOf = (material: Material): number | undefined =>
      associations.get(material)?.materials;

    this.root.traverse((object) => {
      const association = associations.get(object);
      const ref: SelectionRef = {};

      if (association?.nodes !== undefined) ref.node = association.nodes;
      if (association?.meshes !== undefined) ref.mesh = association.meshes;

      const mesh = object as Mesh;
      if (mesh.isMesh) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const index = materialIndexOf(material);
          if (index === undefined) continue;
          if (ref.material === undefined) ref.material = index;
          push(this.objects.material, index, object);
          // The loader clones a material per geometry variant (vertex colours,
          // flat shading…), so one index can own several live instances.
          const instances = this.materialsByIndex.get(index);
          if (!instances) this.materialsByIndex.set(index, [material]);
          else if (!instances.includes(material)) instances.push(material);
        }
      }

      if (ref.node === undefined && ref.mesh === undefined && ref.material === undefined) return;
      if (ref.node !== undefined) push(this.objects.node, ref.node, object);
      if (ref.mesh !== undefined) push(this.objects.mesh, ref.mesh, object);
      this.refByObject.set(object, ref);
      this.tracked.push(object);
    });
  }

  /** Nodes present in the scene but carrying no drawable geometry. */
  private findGeometrylessNodes(): Set<number> {
    const result = new Set<number>();
    for (const [index, objects] of this.objects.node) {
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

  private clearModel(): void {
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      disposeSubtree(child);
    }
    this.gizmo.detach();
    this.gizmoNode = null;
    for (const kind of KINDS) this.objects[kind].clear();
    for (const kind of HIDE_KINDS) this.hidden[kind].clear();
    this.materialsByIndex.clear();
    // Already disposed with the materials that held them, by disposeSubtree().
    this.ownedTextures.clear();
    this.parser = null;
    this.textureCount = 0;
    this.refByObject.clear();
    this.tracked = [];
    this.counts = null;
    this.selection = null;
    this.selectionBox.visible = false;
    this.hoverBox.visible = false;
    this.revokeBlobUrls();
  }

  // -------------------------------------------------------------------------
  // Material textures

  /**
   * Points one of a material's map slots at a texture, or clears it with null.
   *
   * Returns false when the change cannot be shown without re-parsing the file —
   * a texture the loader has never seen, or a material that is not in the scene
   * — so the caller can fall back to a reload.
   */
  async setMaterialMap(
    materialIndex: number,
    slot: MapSlot,
    textureIndex: number | null,
  ): Promise<boolean> {
    const materials = this.materialsByIndex.get(materialIndex);
    if (!materials || materials.length === 0) return false;

    let texture: Texture | null = null;
    if (textureIndex !== null) {
      if (!this.parser || textureIndex >= this.textureCount) return false;
      let loaded: Texture | null;
      try {
        // The parser applies the sampler, flipY and any KTX2 transcoding, which
        // is why the texture is fetched through it rather than loaded here.
        loaded = (await this.parser.getDependency('texture', textureIndex)) as Texture | null;
      } catch {
        return false;
      }
      // An image the loader could not decode resolves to null rather than
      // rejecting, and a reload is the only thing that can explain that on
      // screen — it substitutes a placeholder for images it cannot get.
      if (loaded === null) return false;
      if (this.disposed) return false;

      // Colour space belongs to the slot, not the image, and the parser hands
      // out one shared instance per texture — so each slot gets its own view of
      // it. The copy shares the decoded image, so it costs no extra memory.
      texture = loaded.clone();
      texture.colorSpace =
        slot === 'baseColor' || slot === 'emissive' ? SRGBColorSpace : NoColorSpace;
      texture.needsUpdate = true;
      this.ownedTextures.add(texture);
    }

    for (const material of materials) this.applyMap(material, slot, texture);
    this.invalidate();
    return true;
  }

  private applyMap(material: Material, slot: MapSlot, texture: Texture | null): void {
    const standard = material as MeshStandardMaterial;
    const replaced: (Texture | null)[] = [];

    switch (slot) {
      case 'baseColor':
        replaced.push(standard.map);
        standard.map = texture;
        break;
      case 'metallicRoughness':
        replaced.push(standard.metalnessMap, standard.roughnessMap);
        standard.metalnessMap = texture;
        standard.roughnessMap = texture;
        break;
      case 'normal':
        replaced.push(standard.normalMap);
        standard.normalMap = texture;
        break;
      case 'occlusion':
        replaced.push(standard.aoMap);
        standard.aoMap = texture;
        break;
      case 'emissive':
        replaced.push(standard.emissiveMap);
        standard.emissiveMap = texture;
        // Mirrors the emissiveFactor the JSON side sets, and for the same
        // reason: emissive black multiplied by the texture stays black.
        if (texture && standard.emissive?.getHex() === 0) standard.emissive.setHex(0xffffff);
        break;
    }

    // Adding or removing a map changes the shader, not just a uniform.
    material.needsUpdate = true;
    for (const previous of replaced) {
      if (previous && this.ownedTextures.delete(previous)) previous.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Visibility

  isHidden(kind: HideKind, index: number): boolean {
    return this.hidden[kind].has(index);
  }

  setHidden(kind: HideKind, index: number, hidden: boolean): void {
    if (hidden) this.hidden[kind].add(index);
    else this.hidden[kind].delete(index);
    this.applyVisibility();
  }

  toggleHidden(kind: HideKind, index: number): boolean {
    const next = !this.isHidden(kind, index);
    this.setHidden(kind, index, next);
    return next;
  }

  anyHidden(): boolean {
    return HIDE_KINDS.some((kind) => this.hidden[kind].size > 0);
  }

  showAll(): void {
    for (const kind of HIDE_KINDS) this.hidden[kind].clear();
    this.applyVisibility();
  }

  /**
   * Hides everything that is neither an ancestor nor a descendant of the target.
   * Implemented as a bulk edit of the same hidden set, so "Show all" undoes it.
   */
  isolate(ref: SelectionRef): void {
    const targets = this.objectsForRef(ref);
    if (targets.length === 0) return;

    const keep = new Set<Object3D>();
    for (const target of targets) {
      target.traverse((object) => keep.add(object));
      for (let parent = target.parent; parent; parent = parent.parent) keep.add(parent);
    }

    for (const kind of HIDE_KINDS) this.hidden[kind].clear();
    for (const [index, objects] of this.objects.node) {
      if (!objects.some((object) => keep.has(object))) this.hidden.node.add(index);
    }
    this.applyVisibility();
  }

  private applyVisibility(): void {
    for (const object of this.tracked) {
      const ref = this.refByObject.get(object);
      if (!ref) continue;
      object.visible = !HIDE_KINDS.some(
        (kind) => ref[kind] !== undefined && this.hidden[kind].has(ref[kind]),
      );
    }
    this.updateBox(this.selectionBox, this.selection);
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
  hiddenState(kind: TargetKind, index: number): HiddenState {
    if (kind !== 'material' && this.hidden[kind].has(index)) return { reason: 'self' };

    const objects = this.objects[kind].get(index);
    if (!objects || objects.length === 0) return { reason: null };
    if (objects.some((object) => isWorldVisible(object))) return { reason: null };

    for (const object of objects) {
      // The object may be hidden by the other axis: one three.js object is
      // often both a node and a mesh, so a mesh row can be hidden by "its" node.
      const own = this.refByObject.get(object);
      if (kind !== 'mesh' && own?.mesh !== undefined && this.hidden.mesh.has(own.mesh)) {
        return { reason: 'mesh', byMesh: own.mesh };
      }
      for (let parent: Object3D | null = object; parent; parent = parent.parent) {
        const ref = this.refByObject.get(parent);
        if (ref?.node !== undefined && this.hidden.node.has(ref.node)) {
          return { reason: 'ancestor', byNode: ref.node };
        }
        if (parent !== object && ref?.mesh !== undefined && this.hidden.mesh.has(ref.mesh)) {
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
    this.updateBox(this.selectionBox, ref);
    this.updateGizmo();
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
    return this.gizmoNode !== null;
  }

  /**
   * Attaches the gizmo to the selected node, if there is one. Nothing else is
   * movable: a mesh or a material is shared data, and only the node that uses
   * it has a place in the scene.
   */
  private updateGizmo(): void {
    const node = this.selection?.node;
    const target = node === undefined ? undefined : this.objects.node.get(node)?.[0];

    if (!this.gizmoEnabled || target === undefined || !isWorldVisible(target)) {
      this.gizmoNode = null;
      this.gizmo.detach();
    } else {
      this.gizmoNode = node ?? null;
      this.gizmo.attach(target);
    }
    this.invalidate();
  }

  /** Hands the dragged node's new local transform back to the document. */
  private reportTransform(): void {
    const node = this.gizmoNode;
    const object = this.gizmo.object;
    if (node === null || object === undefined) return;

    const trs: NodeTrs = {
      translation: object.position.toArray() as [number, number, number],
      rotation: object.quaternion.toArray() as [number, number, number, number],
      scale: object.scale.toArray() as [number, number, number],
    };

    // A node the loader had to clone shows up as several objects; they are all
    // the same node in the file, so they all move together.
    for (const other of this.objects.node.get(node) ?? []) {
      if (other !== object) applyTrs(other, trs);
    }

    this.updateBox(this.selectionBox, this.selection);
    this.callbacks.onTransform(node, trs);
  }

  /** Applies a transform typed into the properties panel. */
  setNodeTransform(node: number, trs: NodeTrs): void {
    const objects = this.objects.node.get(node);
    if (!objects || objects.length === 0) return;
    for (const object of objects) applyTrs(object, trs);
    this.updateBox(this.selectionBox, this.selection);
    this.invalidate();
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
    const box = ref ? this.boxForRef(ref, true) : null;
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

  /** Most specific first: a node pins one instance, a material spans many. */
  private objectsForRef(ref: SelectionRef): Object3D[] {
    for (const kind of KINDS) {
      const index = ref[kind];
      if (index === undefined) continue;
      const objects = this.objects[kind].get(index);
      if (objects && objects.length > 0) return objects;
    }
    return [];
  }

  hasObjects(kind: TargetKind, index: number): boolean {
    const objects = this.objects[kind].get(index);
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
    for (const hit of this.raycaster.intersectObject(this.root, true)) {
      if (!isWorldVisible(hit.object)) continue;
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
    const ref: SelectionRef = { ...this.refByObject.get(object) };
    if (ref.node === undefined) {
      for (let parent = object.parent; parent; parent = parent.parent) {
        const parentRef = this.refByObject.get(parent);
        if (parentRef?.node !== undefined) {
          ref.node = parentRef.node;
          break;
        }
      }
    }
    return ref.node !== undefined || ref.mesh !== undefined || ref.material !== undefined
      ? ref
      : null;
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

  /** The current view, for storing across a reload. */
  view(): CameraView {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }

  /**
   * Puts the camera back where a stored view had it. The depth range is derived
   * the way `fit` does rather than stored, since it belongs to the model's scale
   * and not to the view.
   */
  setView(view: CameraView): void {
    if (![...view.position, ...view.target].every(Number.isFinite)) return;
    this.camera.position.fromArray(view.position);
    this.controls.target.fromArray(view.target);

    const size = this.modelBox.isEmpty()
      ? new Vector3(1, 1, 1)
      : this.modelBox.getSize(new Vector3());
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
    for (const object of this.tracked) {
      if (!isDrawable(object) || !isWorldVisible(object)) continue;
      box.union(new Box3().setFromObject(object));
    }
    return box.isEmpty() ? this.modelBox : box;
  }

  /** Empties, cameras and lights have no geometry — frame where they sit. */
  private positionBoxForRef(ref: SelectionRef): Box3 | null {
    const objects = this.objectsForRef(ref);
    if (objects.length === 0) return null;
    const box = new Box3();
    const position = new Vector3();
    for (const object of objects) box.expandByPoint(object.getWorldPosition(position));
    if (box.isEmpty()) return null;
    const modelSize = this.modelBox.isEmpty()
      ? 1
      : this.modelBox.getSize(new Vector3()).length();
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
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      disposeMaterialOf(this.grid.material);
      this.grid = null;
    }
    if (this.modelBox.isEmpty()) return;

    // A fixed-size grid is invisible around a 5000-unit model and swamps a
    // 0.01-unit one, so it tracks the bounding box.
    const size = this.modelBox.getSize(new Vector3());
    const extent = Math.max(size.x, size.z, size.y * 0.5, 1e-3) * 2.5;
    const grid = new GridHelper(extent, 20, 0x4a4a4a, 0x2c2c2c);
    const center = this.modelBox.getCenter(new Vector3());
    grid.position.set(center.x, this.modelBox.min.y, center.z);
    grid.raycast = () => {};
    // A reload rebuilds the helper; keep whatever the toolbar last asked for.
    grid.visible = this.gridVisible;
    this.grid = grid;
    this.scene.add(grid);
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
      // Children, not `root` itself: that group is our own, not part of the file.
      for (const child of this.root.children) {
        child.traverseVisible((object) => {
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
        });
      }
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
    this.invalidate();
  }

  /**
   * Renders on demand rather than on a permanent loop: this page is mostly a
   * text editor, and a background render loop would burn battery and compete
   * with typing.
   */
  invalidate(): void {
    if (this.disposed || this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => this.renderFrame());
  }

  private renderFrame(): void {
    this.frameRequested = false;
    if (this.disposed) return;
    // The pane can be collapsed; a later resize will invalidate again.
    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) return;
    const moving = this.controls.update();
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

  private revokeBlobUrls(): void {
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.clearModel();
    if (this.grid) {
      this.grid.geometry.dispose();
      disposeMaterialOf(this.grid.material);
      this.grid = null;
    }
    for (const helper of [this.selectionBox, this.hoverBox]) {
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

function applyTrs(object: Object3D, trs: NodeTrs): void {
  object.position.fromArray(trs.translation);
  object.quaternion.fromArray(trs.rotation);
  object.scale.fromArray(trs.scale);
  object.updateMatrix();
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
