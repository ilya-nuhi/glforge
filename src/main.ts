import {
  CHUNK_BIN,
  assertGltf2,
  buildGlb,
  detectCompression,
  embedGlbImages,
  imageBufferRange,
  listExternalResources,
  parseGlb,
  parseGltfText,
  withSingleScene,
  type GlbChunk,
  type GltfAnimation,
  type GltfImage,
  type GltfJson,
  type GltfMaterial,
  type GltfMesh,
  type GltfNode,
  type GltfTexture,
  type ImageBytes,
  type NamedEntry,
  type TextureInfo,
} from './gltf';
import {
  MATERIAL_SECTIONS,
  MATERIAL_TYPES,
  THREE_EXTRAS,
  getMaterialTexture,
  hexToLinear,
  linearToHex,
  materialLook,
  materialType,
  sectionInUse,
  sectionItems,
  setMaterialTexture,
  setMaterialType,
  type MapSlot,
  type MapSlotSpec,
  type MaterialParam,
  type MaterialSection,
  type MaterialType,
} from './material';
import { collectDroppedFiles, pickedFromList, type PickedFile } from './files';
import { isStudioScene, readStudioScene, type StudioScene } from './studio';
import {
  ANISOTROPY_EXTRAS,
  CLAMP_TO_EDGE,
  LINEAR,
  MAG_FILTER_OPTIONS,
  MIN_FILTER_OPTIONS,
  MIRRORED_REPEAT,
  UV_SETS,
  WRAP_OPTIONS,
  readSampler,
  readUvTransform,
  setSamplerValue,
  setUvTransform,
  textureLook,
  textureUsers,
  type SamplerSettings,
  type UvTransform,
} from './texture';
import {
  DEFAULT_TRS,
  captureNodeTransform,
  eulerToQuaternion,
  quaternionToEuler,
  readNodeTransform,
  restoreNodeTransform,
  sameTransform,
  toDegrees,
  toRadians,
  writeNodeTransform,
  type NodeTransformKeys,
  type Trs,
  type Vec3,
} from './transform';
import { iconSvg, typeIcon, type IconName } from './icons';
import {
  baseName,
  buildResourceLookup,
  findMissing,
  normalizeUri,
  resolveResource,
} from './resources';
import {
  buildFolderRows,
  filesUnder,
  formatBytes,
  type FileRole,
  type FolderFile,
  type FolderRow,
} from './folder';
import {
  MAX_SESSION_BYTES,
  clearSession,
  forgetModel,
  isQuotaError,
  loadSession,
  markSession,
  saveDoc,
  saveSource,
  saveScenes,
  saveView,
  sourceSize,
  storedSessionName,
  type ScenesRecord,
  type Session,
  type SourceRecord,
  type StoredModel,
  type ViewRecord,
} from './session';
import {
  appendAnimation,
  removeAnimation,
  removeMesh,
  removeNodes,
  type Collection,
  type Removal,
} from './remove';
import {
  animationLength,
  bakeTrims,
  getTrim,
  hasTrims,
  meshoptViews,
  setTrim,
  trimBlocker,
  trimmedBuffers,
  type TrimRange,
} from './keyframes';
import {
  ADD_MENU,
  DEFAULT_ENVIRONMENT,
  SCENE_OBJECT_KINDS,
  categoryOf,
  createSceneObject,
  defaultSceneObjects,
  descendantsOf,
  hasTransform,
  restoreEnvironment,
  restoreSceneObjects,
  type EnvironmentSettings,
  type SceneObject,
  type SceneObjectKind,
  type SceneObjectProps,
} from './scene';
import {
  DEFAULT_SHADOWS,
  SHADOW_MAP_SIZES,
  SHADOW_TYPES,
  isShadowFlags,
  readShadowFlags,
  restoreShadows,
  sameShadowFlags,
  writeShadowFlags,
  type ShadowFlags,
  type ShadowSettings,
} from './shadow';
import {
  animatesWeights,
  morphTargetCount,
  morphTargetNames,
  nodesDrawing,
  readWeights,
  restoreWeights,
  weightsHolder,
  writeWeight,
} from './morph';
import { buildHierarchy, meshMaterials, type EntryUse } from './tree';
import type {
  CameraView,
  ClipInfo,
  GizmoMode,
  HiddenState,
  NodeTrs,
  SelectionRef,
  TargetKind,
  Viewer,
} from './viewer';
import { initCompression, type Compression } from './compress';
import './style.css';

/**
 * The glTF collections that carry names, for counting what a file holds and for
 * pairing a restored document against the file's own names. Rows are built from
 * the scene hierarchy alone, so nothing here needs an icon or a 3D target.
 */
interface Category {
  label: string;
  singular: string;
  /** Which collection it is, for the ones a delete can renumber. */
  collection?: Collection;
  list: (json: GltfJson) => NamedEntry[];
}

const CATEGORIES: Category[] = [
  { label: 'Scenes', singular: 'Scene', list: (j) => j.scenes ?? [] },
  { label: 'Nodes', singular: 'Node', collection: 'nodes', list: (j) => j.nodes ?? [] },
  { label: 'Meshes', singular: 'Mesh', collection: 'meshes', list: (j) => j.meshes ?? [] },
  { label: 'Skins', singular: 'Skin', collection: 'skins', list: (j) => j.skins ?? [] },
  { label: 'Materials', singular: 'Material', list: (j) => j.materials ?? [] },
  { label: 'Textures', singular: 'Texture', list: (j) => j.textures ?? [] },
  { label: 'Images', singular: 'Image', list: (j) => j.images ?? [] },
  {
    label: 'Animations',
    singular: 'Animation',
    collection: 'animations',
    list: (j) => j.animations ?? [],
  },
  { label: 'Cameras', singular: 'Camera', list: (j) => j.cameras ?? [] },
  {
    label: 'Lights',
    singular: 'Light',
    list: (j) => j.extensions?.KHR_lights_punctual?.lights ?? [],
  },
  {
    label: 'Material variants',
    singular: 'Material variant',
    list: (j) => j.extensions?.KHR_materials_variants?.variants ?? [],
  },
];

type SidebarTab = 'scene' | 'animations' | 'files' | 'tools';

const SIDEBAR_TABS: SidebarTab[] = ['scene', 'animations', 'files', 'tools'];

/** A row of the Files tab's tree, paired with the element drawing it. */
interface FileTreeRow extends FolderRow {
  el: HTMLLIElement;
}

/** A row of the Animations tab: one of the active model's animations. */
interface ClipRow {
  /** Its index in the document, which is its clip's index in the preview. */
  index: number;
  entry: GltfAnimation;
  el: HTMLLIElement;
  name: HTMLElement;
  play: HTMLButtonElement;
  length: HTMLElement;
}

/**
 * One open file. Several can share the scene at once — the way the three.js
 * editor imports model after model — so everything that belongs to a file
 * rather than to the app lives here, and every edit knows which file it is in.
 */
interface Model {
  /** Stable while it is open and across a reload, since it is its session stamp. */
  id: number;
  /** The name it was opened under. */
  fileName: string;
  /**
   * The node it was in a studio scene it came in with, which tells apart the
   * instances of one file the scene places; null for a file opened on its own.
   */
  sceneName: string | null;
  /** Where it sat in what was dropped, for the Files tab. */
  path: string;
  /** Its size in bytes, or -1 when a restored session did not record one. */
  size: number;
  json: GltfJson;
  glbChunks: GlbChunk[];
  isGlb: boolean;
  /** Pristine bytes/text, kept so the preview never sees the edited document. */
  sourceBuffer: ArrayBuffer | null;
  sourceText: string | null;
  wasPretty: boolean;
  /** Its sidecars, keyed by the path each was dropped at. */
  resources: Map<string, File>;
  /** Images the user added from disk, so export can fold them into the file. */
  addedImages: Map<number, File>;
  /** Cached preview URLs for images, keyed by image index (null = not showable). */
  imageUrls: Map<number, string | null>;
  /** Edits beyond names, which the preview and the export both have to reflect. */
  mapEdits: number;
  /**
   * Materials whose type, colours or amounts were changed. A set rather than a
   * count, since a slider dragged across the panel is one change, not a hundred.
   */
  editedMaterials: Set<number>;
  /** Nodes the user has moved, holding what the file said before they did. */
  movedNodes: Map<number, NodeTransformKeys>;
  /** Nodes whose shadow flags were changed, holding what the file said before. */
  shadowEdits: Map<number, ShadowFlags>;
  /**
   * Meshes whose morph target weights were changed — on the mesh, or on a node
   * drawing it. A set, as with materials: a slider dragged is one change.
   */
  morphedMeshes: Set<number>;
  /** Objects, mesh data and animations deleted since the file was opened. */
  deletedCount: number;
  /** Animations copied since the file was opened. */
  copiedAnimations: number;
  /**
   * Where each entry sat in the file as opened, for the collections a delete has
   * renumbered — current index → the file's own. A restored session pairs names
   * by it, and a reset finds its way back by it. A collection missing here is
   * still numbered the way the file numbers it.
   */
  origins: Origins;
  /** The file's scene on show: what its outliner row holds and the preview loads. */
  sceneIndex: number;
  /**
   * Where it sits in the scene, once it has been moved as a whole; null where
   * its file has it. The scene's, not the file's: none of it is downloaded.
   */
  placement: NodeTrs | null;
  /**
   * The names the file itself carried, once the rows have been rebuilt or the
   * document was restored mid-edit: rows take their "original" from here, so a
   * rename still shows as a change and still reverts to what the file said.
   */
  originalNames: Map<NamedEntry, { name: string; had: boolean }> | null;
  preview: PreviewState;
  /** Too big to keep across a reload, so a reload is the one thing that loses it. */
  unkept: boolean;
}

/** Where a model's 3D preview has got to. */
interface PreviewState {
  /** Guards against a stale load's result overwriting a newer one. */
  token: number;
  busy: boolean;
  /** The load running now is one the viewport stays usable through. */
  quiet: boolean;
  /** A reload asked for while one was in flight, so it is not silently dropped. */
  pending: ViewerOptions | null;
  /** What stopped the last load drawing it, if anything did. */
  problem: { message: string; missing: string[]; pickers: boolean } | null;
  /** The animation picked for it in the Animations tab, by index. */
  clip: number;
}

interface Row {
  /** The file the row is in: every index below is an index into its document. */
  model: Model;
  entry: NamedEntry;
  label: string;
  /** Index within its own glTF collection. */
  index: number;
  target?: { kind: TargetKind; index: number };
  /** Mesh data named beside the row, if the object draws any. */
  mesh?: EntryUse;
  /** Materials named beside the row, matched by the filter along with it. */
  materials: EntryUse[];
  /** A row that stands for the file itself: there is no name in it to edit. */
  fixed: boolean;
  /** The name field is sized to its text, since something follows it. */
  fitted: boolean;
  depth: number;
  hasChildren: boolean;
  original: string;
  /** Whether the entry carried a `name` key at all, so `""` round-trips. */
  hadName: boolean;
  /** Whether the row matches the current text filter, independent of collapse. */
  filtered: boolean;
  el: HTMLLIElement;
  input: HTMLInputElement;
  discloseBtn: HTMLButtonElement | null;
  eyeBtn: HTMLButtonElement | null;
  locateBtn: HTMLButtonElement | null;
  revertBtn: HTMLButtonElement;
}

/**
 * A row for one of the scene's own objects — a light, a shape, a group. It is in
 * no file, so it has no index, no original name to revert to, and nothing named
 * beside it; otherwise it is walked, picked, renamed and hidden like any row.
 */
interface ObjectRow {
  object: SceneObject;
  depth: number;
  hasChildren: boolean;
  filtered: boolean;
  el: HTMLLIElement;
  input: HTMLInputElement;
  discloseBtn: HTMLButtonElement | null;
  eyeBtn: HTMLButtonElement;
}

/** Anything in the outliner below the Scene row: part of a file, or the scene's own. */
type OutlinerRow = Row | ObjectRow;

/** One thing that can be selected: something in a model, or one of the scene's own objects. */
type SelectionItem = { ref: SelectionRef; object?: undefined } | { object: number; ref?: undefined };

function isObjectRow(row: OutlinerRow): row is ObjectRow {
  return 'object' in row;
}

interface RowSpec {
  model: Model;
  entry: NamedEntry;
  label: string;
  icon: IconName;
  index: number;
  depth: number;
  hasChildren: boolean;
  target?: { kind: TargetKind; index: number };
  /** Mesh data named beside the row, the way the editor's outliner does. */
  mesh?: EntryUse;
  /** Materials named beside the row, the way the editor's outliner does. */
  materials?: EntryUse[];
  /** The file's own row: shown, walked, framed and moved, but never renamed. */
  fixed?: boolean;
}

/**
 * A material named beside a mesh row — a chip when the mesh has one material, an
 * option of its dropdown when it has several. Both have to follow a rename and
 * to say when their material is the selection, so both are described by what
 * they do rather than by which element they are.
 */
interface AsideLabel {
  /** The model whose mesh or material it names. */
  model: number;
  /** What it names: the row's mesh data, or one of that mesh's materials. */
  kind: 'mesh' | 'material';
  index: number;
  /** The mesh it belongs to, so only that mesh's labels mark its selection. */
  mesh: number;
  /** The object whose row it is on, when that row is one. */
  node?: number;
  /** Repaint after a rename. */
  paint: (value: string) => void;
  /** Show whether this material is what is selected. */
  mark: (selected: boolean) => void;
}

/** A name field in the properties panel, kept in sync with its row. */
interface PropField {
  model: Model;
  entry: NamedEntry;
  input: HTMLInputElement;
  original: string;
}

/** How a preview load should behave, for reloads that only change materials. */
interface ViewerOptions {
  /** Keep the camera where it is and whatever is hidden hidden. */
  keepView?: boolean;
  /** Skip the blocking overlay: the viewport is still usable meanwhile. */
  quiet?: boolean;
}

type TrsPart = 'translation' | 'rotation' | 'scale';

/** A "visible" checkbox in the properties panel, repainted from the viewer. */
interface PropToggle {
  model: Model;
  /** Null for the model as a whole. */
  kind: TargetKind | null;
  index: number;
  input: HTMLInputElement;
}

/** Current index → the index in the file as opened, per renumbered collection. */
type Origins = Partial<Record<Collection, number[]>>;

const $ =<T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const menubar = $('#menubar');
const menubarFile = $('#menubar-file');
const sceneSwitch = $<HTMLSelectElement>('#scene-switch');
const sceneNameInput = $<HTMLInputElement>('#scene-name-input');
const sceneRenameBtn = $<HTMLButtonElement>('#scene-rename-btn');
const sceneNewBtn = $<HTMLButtonElement>('#scene-new-btn');
const sceneDeleteBtn = $<HTMLButtonElement>('#scene-delete-btn');
const dropzone = $('#dropzone');
const fileInput = $<HTMLInputElement>('#file-input');
const folderInput = $<HTMLInputElement>('#folder-input');
const imageInput = $<HTMLInputElement>('#image-input');
const browseBtn = $('#browse-btn');
const browseFolderBtn = $('#browse-folder-btn');
const errorBanner = $('#error-banner');
const fileNameEl = $('#file-name');
const fileStatsEl = $('#file-stats');
const gltfNote = $('#gltf-note');
const viewport = $('#viewport');
const viewportInfo = $('#viewport-info');
const viewerOverlay = $('#viewer-overlay');
const viewerMessage = $('#viewer-message');
const viewerActions = $('#viewer-actions');
const missingList = $<HTMLUListElement>('#missing-list');
const resourceInput = $<HTMLInputElement>('#resource-input');
const resourceFolderInput = $<HTMLInputElement>('#resource-folder-input');
const addFilesBtn = $('#add-files-btn');
const addFolderBtn = $('#add-folder-btn');
const sceneRow = $('#scene-row');
const sceneSelect = $<HTMLSelectElement>('#scene-select');
/** The Animations, Files and Tools tabs are about one model: these say which, and switch it. */
const modelPickers = [
  { row: $('#animations-model-row'), select: $<HTMLSelectElement>('#animations-model-select') },
  { row: $('#files-model-row'), select: $<HTMLSelectElement>('#files-model-select') },
  { row: $('#tools-model-row'), select: $<HTMLSelectElement>('#tools-model-select') },
];
const toolbar = $('#toolbar');
const frameBtn = $('#frame-btn');
const isolateBtn = $<HTMLButtonElement>('#isolate-btn');
const showAllBtn = $<HTMLButtonElement>('#show-all-btn');
const gridBtn = $<HTMLButtonElement>('#grid-btn');
const gizmoButtons: Record<GizmoMode, HTMLButtonElement> = {
  translate: $<HTMLButtonElement>('#move-btn'),
  rotate: $<HTMLButtonElement>('#rotate-btn'),
  scale: $<HTMLButtonElement>('#scale-btn'),
};
const spaceBtn = $<HTMLButtonElement>('#space-btn');
const playbackPanel = $('#playback-panel');
const playBtn = $<HTMLButtonElement>('#play-btn');
const stopBtn = $<HTMLButtonElement>('#stop-btn');
const reverseBtn = $<HTMLButtonElement>('#reverse-btn');
const clipScrubber = $<HTMLInputElement>('#clip-scrubber');
const clipTime = $('#clip-time');
const loopBtn = $<HTMLButtonElement>('#loop-btn');
const speedField = $('#speed-field');
/** Dragged or typed like the transform numbers; put in place at start-up. */
const speedInput = numberField(1, 0.01, 'Playback speed', (value) => setAnimationSpeed(value));
const animationsSummary = $('#animations-summary');
const clipListEl = $('#clip-list');
const clipPanel = $('#clip-panel');
const resizer = $('#resizer');
const sidebar = $('#sidebar');
const tabsEl = $('#tabs');
const outlinerEl = $('#outliner');
const fileTreeEl = $('#file-tree');
const filesSummary = $('#files-summary');
const filesAddBtn = $('#files-add-btn');
const filesAddFolderBtn = $('#files-add-folder-btn');
const missingPanel = $('#missing-panel');
const missingFilesEl = $<HTMLUListElement>('#missing-files');
const previewPanel = $('#image-preview-panel');
const previewHost = $('#image-preview');
const previewName = $('#preview-name');
const previewMeta = $('#preview-meta');
const propertiesEl = $('#properties');
const multiNote = $('#multi-note');
const searchInput = $<HTMLInputElement>('#search-input');
const addBtn = $<HTMLButtonElement>('#add-btn');
const addOptions = $('#add-options');
const menubarAdd = $('#menubar-add');
const findInput = $<HTMLInputElement>('#find-input');
const replaceInput = $<HTMLInputElement>('#replace-input');
const regexToggle = $<HTMLInputElement>('#regex-toggle');
const replaceBtn = $<HTMLButtonElement>('#replace-btn');
const resetBtn = $('#reset-btn');
const resetAllBtn = $('#reset-all-btn');
const closeBtn = $('#close-btn');
const exportBtn = $<HTMLButtonElement>('#export-btn');
/** The Download panel, once it is set up; it decides whether Download re-encodes. */
let compression: Compression<Model> | null = null;
const flash = $('#flash');

const SIDEBAR_KEY = 'glforge:sidebar-width';
const GITHUB_URL = 'https://github.com/ilya-nuhi/glforge';
/** What the outliner says before there is a scene to show. */
const EMPTY_OUTLINER = 'No file open. Drop one in, or add an object with +.';

// ---------------------------------------------------------------------------
// State

/** Every open file, in the order it was opened — which is the outliner's order. */
let models: Model[] = [];
/**
 * The file the Files and Tools tabs, the scene picker and Ctrl+S are about:
 * the one the selection is in, or else the one picked or opened last.
 */
let activeModel: Model | null = null;
/** Hands out model ids, which double as session stamps: unique, and in order. */
let lastModelId = 0;

/**
 * The scene's own objects — its lights, and the shapes and groups added to it —
 * in the order the outliner lists them. None is in any file.
 */
let sceneObjects: SceneObject[] = defaultSceneObjects();
/** The room every material reflects, besides the lights. */
let environment: EnvironmentSettings = { ...DEFAULT_ENVIRONMENT };
/** Whether shadows are drawn at all, and with which filter. */
let shadows: ShadowSettings = { ...DEFAULT_SHADOWS };
/**
 * Whether the scene has been worked on for its own sake: something added to it,
 * or changed in it. Such a scene stays on screen with no model open and is kept
 * across a reload on its own; one that was only ever a backdrop for the models
 * goes when they do.
 */
let sceneStarted = false;

/**
 * One of the scenes there are to work in. Only one is on show at a time, and
 * it is the app's own state above — its models, objects and lighting; every
 * other one is shelved, holding all of that until it is switched back to.
 */
interface SceneEntry {
  id: number;
  name: string;
  /** Null for the scene on show. */
  shelved: {
    models: Model[];
    /** What the scene was left at, in the form the session keeps it in. */
    view: ViewRecord | null;
    /** Its Ctrl+Z history, which waits with it. */
    history: History;
  } | null;
}

const FIRST_SCENE_NAME = 'Scene 1';
/** In the order the scene picker lists them. */
let sceneList: SceneEntry[] = [{ id: 1, name: FIRST_SCENE_NAME, shelved: null }];
let activeSceneId = 1;
/** The scene object picked, when that is what the selection is rather than something in a model. */
let pickedObject: number | null = null;
/** What the panel shows of the picked scene object, so a rename or the gizmo can write into it. */
let propObject: {
  id: number;
  name: HTMLInputElement;
  fields: Record<TrsPart, HTMLInputElement[]> | null;
  visible: HTMLInputElement;
} | null = null;

/** Every row below the Scene row, in the order they are shown: the scene's objects, then each model's. */
let rows: OutlinerRow[] = [];
/** One entry can own several rows: a mesh used by two nodes appears twice. */
let rowsByEntry = new Map<NamedEntry, Row[]>();
let rowsByTarget = new Map<string, Row[]>();
/** Material names printed beside mesh rows, keyed by the entry they show. */
let asideLabels = new Map<NamedEntry, AsideLabel[]>();
let noteGroups: { el: HTMLElement; rows: Row[] }[] = [];
let collapsedRows = new Set<number>();
let allCollapsed = false;

let propFields: PropField[] = [];
let propToggles: PropToggle[] = [];
/** Which properties tab is showing, kept across selections when it still fits. */
let propTab: TargetKind = 'node';
/** Which of a whole model's tabs is showing: the model itself, or every morph target in it. */
let modelTab: 'model' | 'morphs' = 'model';
/** What the properties panel was last built from, so typing never rebuilds it. */
let propSignature = '';

/** Which material slot an "Add image…" file picker was opened for. */
let pendingSlot: { model: Model; material: number; slot: MapSlot } | null = null;
let gizmoMode: GizmoMode = 'translate';
let gizmoSpace: 'local' | 'world' = 'world';
let gizmoEnabled = true;
/**
 * The transform fields on screen, so the gizmo can write into them live: a
 * node's, or — with a null node — where the model as a whole sits.
 */
let propTransform: {
  model: Model;
  node: number | null;
  fields: Record<TrsPart, HTMLInputElement[]>;
  reset: HTMLButtonElement;
} | null = null;

let viewer: Viewer | null = null;
/** The viewer being made; every model's first load waits on the same one. */
let viewerReady: Promise<Viewer> | null = null;
/** Bumped by Close all, so a viewer still being made then is not kept. */
let viewerEpoch = 0;
/**
 * A reload is bringing models back: every load keeps the camera, and the one
 * that finishes last puts back the view that was stored.
 */
let restoring = false;
let selection: SelectionRef | null = null;
/**
 * What else is selected, besides `selection` or `pickedObject` — rows added
 * with Ctrl+click or Shift+click. The panel and the gizmo stay with the one
 * picked last; Delete, Isolate and Frame take all of them.
 */
let extraPicks: SelectionItem[] = [];
/** Where a Shift+click range starts: the row last clicked on its own, or with Ctrl. */
let selectAnchor: SelectionItem | null = null;
/**
 * The outliner's Scene row: the one scene every model is in, which belongs to
 * none of them. Picking it selects no model, so it is tracked apart.
 */
let sceneRootEl: HTMLLIElement | null = null;
let sceneSelected = false;
let sceneCollapsed = false;
/** Which model the Files tab's "Add files…" is adding to; null lets the files choose. */
let resourceTarget: Model | null = null;
let fileTreeRows: FileTreeRow[] = [];
/** Collapsed folders in the Files tab, by path so a rebuild keeps them shut. */
let collapsedFolders = new Set<string>();
/** The picked row in the Files tab, by path, so a rebuild keeps it picked. */
let selectedFilePath: string | null = null;
/** The image on show under the tree, and the URL drawing it. */
let previewFile: { path: string; file: File; url: string } | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let gridVisible = true;
/** Whether a clip starts over at its end — one setting for every model, like the grid. */
let animationLoop = true;
/** Clip seconds per real second, and which way they run — for every model, like looping. */
let animationSpeed = 1;
let animationReverse = false;
/** The active model's clips, as the preview last listed them: what there is to play. */
let previewClips: ClipInfo[] = [];
/** What the playback buttons last said, so a frame of playback repaints only what moved. */
let playbackShows: { playing: boolean; posed: boolean } | null = null;
/** A drag on the scrubber, and whether playback picks up again once it ends. */
let scrubbing: { model: Model; resume: boolean; done: AbortController } | null = null;
/** The Animations tab's rows, for the active model's animations. */
let clipRows: ClipRow[] = [];
/** The Animations tab's name field — kept apart, since the properties panel resets its own. */
let clipFields: PropField[] = [];
/** What the Animations tab's rows last showed, so a frame of playback repaints only what moved. */
let clipShows: { clip: number; playing: number | null } | null = null;
/** What the Animations tab's panel was last built for, so a repaint never rebuilds it under the caret. */
let clipPanelFor: { model: Model; entry: GltfAnimation; duration: number | undefined } | null = null;
/** The panel's trim controls, repainted in place so a drag across them is never rebuilt away. */
let clipTrim: {
  model: Model;
  index: number;
  length: HTMLElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
  whole: HTMLButtonElement;
  here: HTMLButtonElement[];
  /** Says why the clip cannot be trimmed, when it cannot. */
  note: HTMLElement;
} | null = null;

/** Whether the open models are being kept across a reload at all. */
let sessionOn = false;
/** Set once a write has failed, which is what brings the unload guard back. */
let sessionBroken = false;
/** Models whose document has changed since it was last written. */
let dirtyDocs = new Set<Model>();
let docSaveTimer: ReturnType<typeof setTimeout> | undefined;
let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
/** A camera read back from storage, applied once the preview has loaded. */
let pendingView: CameraView | null = null;
/** Which sidebar tab is showing, so a reload comes back to it. */
let sidebarTab: SidebarTab = 'scene';

const targetKey = (model: Model, kind: TargetKind, index: number) =>
  `${model.id}:${kind}:${index}`;
/** The key a model's root row is found under. */
const rootKey = (id: number) => `${id}:root`;

/** How a list of the open models names one: its file, and the scene node it is when that says more. */
function modelLabel(model: Model): string {
  return model.sceneName === null || model.sceneName === model.fileName
    ? model.fileName
    : `${model.sceneName} (${model.fileName})`;
}

function modelById(id: number | undefined): Model | undefined {
  return id === undefined ? undefined : models.find((model) => model.id === id);
}

// ---------------------------------------------------------------------------
// Loading a file

/**
 * Opens every model in what was dropped or picked, alongside whatever is open
 * already: files are added to the scene, never swapped for what is there.
 */
async function openFiles(picked: PickedFile[]): Promise<void> {
  // A studio export holds its models too, but they are only half of it.
  if (isStudioScene(picked)) {
    await importStudioScene(picked);
    return;
  }
  hideError();
  const files =picked.filter((item) => /\.(glb|gltf)$/i.test(item.file.name));
  const sidecars = picked.filter((item) => !files.includes(item));

  if (files.length === 0) {
    // Files dropped while a model is open are treated as its missing resources.
    if (models.length > 0 && sidecars.length > 0) {
      addResources(sidecars);
      return;
    }
    showError('Drop a .glb or .gltf file, or a folder containing one.');
    return;
  }

  const opened: Model[] = [];
  const failed: string[] = [];
  for (const item of files) {
    try {
      opened.push(await readModel(item, sidecarsFor(item, files, sidecars)));
    } catch (error) {
      failed.push(`${item.file.name}: ${messageOf(error)}`);
    }
  }
  if (failed.length > 0) showError(`Could not read ${failed.join('; ')}`);
  if (opened.length === 0) return;
  addModels(opened);
}

/** Puts models that have been read into the scene, beside whatever is in it already. */
function addModels(opened: Model[]): void {
  checkpointModels(opened);
  const adding = models.length > 0;
  models.push(...opened);
  activeModel = opened[0];
  // A model added to others is picked, so the outliner, the tabs and — once it
  // has loaded — the viewport all say which one just arrived.
  if (adding) selection = { model: opened[0].id };
  renderActiveModel();
  buildEditor();
  dropzone.hidden = true;
  toolbar.hidden = false;
  viewportInfo.hidden = false;
  setTab('scene');
  for (const model of opened) void startViewer(model);
  keepModels(opened);
  if (models.length > opened.length) {
    showFlash(
      opened.length === 1
        ? `Added ${opened[0].fileName} to the scene`
        : `Added ${opened.length} models to the scene`,
    );
  }
}

/** Reads one model file into a model of its own. Nothing is shown yet. */
async function readModel(item: PickedFile, sidecars: PickedFile[]): Promise<Model> {
  const file = item.file;
  const isGlb = /\.glb$/i.test(file.name);
  let json: GltfJson;
  let glbChunks: GlbChunk[] = [];
  let sourceBuffer: ArrayBuffer | null = null;
  let sourceText: string | null = null;
  if (isGlb) {
    sourceBuffer = await file.arrayBuffer();
    const parsed = parseGlb(sourceBuffer);
    json = parsed.json;
    glbChunks = parsed.otherChunks;
  } else {
    sourceText = await file.text();
    json = parseGltfText(sourceText);
  }
  assertGltf2(json);

  return createModel({
    id: nextModelId(),
    fileName: file.name,
    // The path it was dropped at, so the Files tab can show it where it sat.
    path: item.path,
    size: file.size,
    json,
    glbChunks,
    isGlb,
    sourceBuffer,
    sourceText,
    wasPretty: sourceText?.includes('\n') ?? false,
    // Keyed by the path each file was dropped at, so a URI like
    // `textures/wood.png` finds the file that actually sat there.
    resources: new Map(sidecars.map((sidecar) => [sidecar.path, sidecar.file])),
  });
}

/**
 * Opens a scene exported from the studio as a scene of its own, named after it:
 * its lights, shapes and groups as the scene's own objects, every model node as
 * a model at the place the studio had it, and the view from its camera. The
 * scene on show is shelved for it, unless it is still empty.
 */
async function importStudioScene(picked: PickedFile[]): Promise<void> {
  hideError();
  // The same folder picked again would otherwise not fire a change.
  folderInput.value = '';
  let studio: StudioScene;
  try {
    studio = await readStudioScene(picked);
  } catch (error) {
    showError(`Could not read the studio scene: ${messageOf(error)}`);
    return;
  }

  const opened: { model: Model; hidden: boolean }[] = [];
  const failed: string[] = [];
  for (const entry of studio.models) {
    try {
      const model = await readModel(entry.file, entry.sidecars);
      model.sceneName = entry.name;
      model.placement = entry.placement;
      opened.push({ model, hidden: entry.hidden });
    } catch (error) {
      failed.push(`${entry.name}: ${messageOf(error)}`);
    }
  }

  if (sceneIsEmpty()) {
    // An empty scene has nothing to shelve: it becomes the studio's.
    resetWorkspace();
    activeScene().name = uniqueSceneName(studio.name, activeScene());
    renderSceneBar();
  } else {
    createScene(studio.name);
  }
  sceneObjects = studio.objects;
  if (studio.environment) environment = studio.environment;
  sceneStarted = true;
  pendingView = studio.camera;

  if (opened.length > 0) {
    // As a reload does: every model keeps the camera while it comes in, and the
    // studio's view — or, with none, all of them framed — follows the last one.
    restoring = true;
    addModels(opened.map(({ model }) => model));
  } else {
    noteSceneEdit();
    showScene();
    setTab('scene');
    buildEditor();
    updateMenus();
  }
  // The scene's name and objects, which the model writes above may have gone
  // out before.
  saveSceneList();
  // An import is where the scene starts: Ctrl+Z does not take it apart.
  resetHistory();

  const epoch = viewerEpoch;
  ensureViewer()
    .then((created) => {
      if (epoch !== viewerEpoch) return;
      for (const id of studio.hiddenObjects) created.setObjectHidden(id, true);
      for (const { model, hidden } of opened) if (hidden) created.setModelHidden(model.id, true);
      refreshVisibilityState();
    })
    .catch(() => {
      // The loads report a preview that could not start.
    });

  if (failed.length > 0) showError(`Could not read ${failed.join('; ')}`);
  const lights = studio.objects.filter((object) => categoryOf(object.kind) === 'light').length;
  showFlash(
    [
      `Imported ${studio.name}: ${plural(opened.length, 'model')}, ${plural(studio.objects.length, 'object')} (${plural(lights, 'light')}).`,
      ...studio.notes,
    ].join(' '),
  );
}

type ModelFile = Pick<
  Model,
  | 'id'
  | 'fileName'
  | 'path'
  | 'size'
  | 'json'
  | 'glbChunks'
  | 'isGlb'
  | 'sourceBuffer'
  | 'sourceText'
  | 'wasPretty'
  | 'resources'
>;

/** A model for a file, with nothing done to it yet. */
function createModel(file: ModelFile): Model {
  return {
    ...file,
    sceneName: null,
    addedImages: new Map(),
    imageUrls: new Map(),
    mapEdits: 0,
    editedMaterials: new Set(),
    movedNodes: new Map(),
    shadowEdits: new Map(),
    morphedMeshes: new Set(),
    deletedCount: 0,
    copiedAnimations: 0,
    origins: {},
    sceneIndex: sceneIndexFor(file.json),
    placement: null,
    originalNames: null,
    preview: { token: 0, busy: false, quiet: false, pending: null, problem: null, clip: 0 },
    unkept: false,
  };
}

function nextModelId(): number {
  // Two files dropped together open within the same millisecond.
  lastModelId = Math.max(Date.now(), lastModelId + 1);
  return lastModelId;
}

/** The scene to show: the one asked for when the file has it, else its default. */
function sceneIndexFor(json: GltfJson, preferred?: number): number {
  const count = json.scenes?.length ?? 0;
  if (preferred !== undefined && Number.isInteger(preferred) && preferred >= 0 && preferred < count) {
    return preferred;
  }
  const fallback = json.scene ?? 0;
  return fallback >= 0 && fallback < Math.max(count, 1) ? fallback : 0;
}

/**
 * The files dropped along with a model that are its own: whatever sat in its
 * folder or below it. A folder of variants shares one set of textures, while two
 * model folders dropped together keep theirs apart. A file under no model's
 * folder at all — a `textures` folder beside a `models` one — goes to every
 * model, since there is no telling which of them it is for.
 */
function sidecarsFor(item: PickedFile, files: PickedFile[], sidecars: PickedFile[]): PickedFile[] {
  const own = folderOf(item.path);
  const folders = files.map((file) => folderOf(file.path));
  return sidecars.filter(
    (sidecar) =>
      sidecar.path.startsWith(own) || !folders.some((folder) => sidecar.path.startsWith(folder)),
  );
}

/** The folder a dropped path sits in, with its trailing slash; '' at the top. */
function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/**
 * Everything that names the active model or acts on it: the Tools tab's File
 * panel, the Files tab, the scene picker, the model pickers and the menubar.
 */
function renderActiveModel(): void {
  const model = activeModel;
  fileNameEl.textContent = model?.fileName ?? '—';
  renderDownload();
  paintMenubarFile();

  for (const picker of modelPickers) {
    picker.row.hidden = models.length <= 1;
    picker.select.textContent = '';
    for (const open of models) {
      const option = document.createElement('option');
      option.value = String(open.id);
      option.textContent = modelLabel(open);
      picker.select.append(option);
    }
    if (model) picker.select.value = String(model.id);
  }

  updateSceneSelect();
  renderPlayback();
  updateFileStats();
  renderFiles();
  scheduleViewSave();
}

/** The menubar's right end: the active file, and which scene it is in once there are several. */
function paintMenubarFile(): void {
  const model = activeModel;
  const file = !model
    ? 'No file open'
    : models.length > 1
      ? `${model.fileName} · ${models.length} models`
      : model.fileName;
  menubarFile.textContent = sceneList.length > 1 ? `${activeScene().name} — ${file}` : file;
}

/**
 * What the one Download will write for the active model: the file as it is,
 * or — once the Download panel asks for a re-encode or another kind of file —
 * whatever the panel says.
 */
function renderDownload(): void {
  const model = activeModel;
  const rewritten = model ? (compression?.label(model) ?? null) : null;
  exportBtn.textContent = !model
    ? 'Download'
    : (rewritten ?? (model.isGlb ? 'Download .glb' : 'Download .gltf'));
  // A rewritten .gltf carries its files with it, so its references are not kept.
  gltfNote.hidden = !model || model.isGlb || rewritten !== null;
}

/** Makes a model the one the tabs are about, if it is not already. */
function setActiveModel(model: Model | null): void {
  if (model === activeModel) return;
  activeModel = model;
  renderActiveModel();
}

// ---------------------------------------------------------------------------
// Row list

function getName(entry: NamedEntry): string {
  return typeof entry.name === 'string' ? entry.name : '';
}

/**
 * Writes a name into the document and mirrors it onto every other row and
 * properties field showing the same entry. The original shape is preserved: an
 * entry that genuinely had `"name": ""` keeps the key, one that never had a
 * name does not gain an empty one.
 */
function setEntryName(entry: NamedEntry, value: string, source?: HTMLInputElement): void {
  const siblings = rowsByEntry.get(entry) ?? [];
  const hadName = siblings[0]?.hadName ?? keptOriginal(entry)?.had ?? typeof entry.name === 'string';
  if (value === '' && !hadName) delete entry.name;
  else entry.name = value;

  for (const row of siblings) {
    // Never rewrite the input being typed into: it would reset the caret.
    if (row.input !== source) row.input.value = value;
    // Whatever a field shows now is what the document holds, so nothing about
    // it is rejected any more.
    row.input.classList.remove('invalid');
    updateRowState(row);
    if (row.fitted) fitNameField(row.input);
  }
  for (const field of [...propFields, ...clipFields]) {
    if (field.entry !== entry) continue;
    if (field.input !== source) field.input.value = value;
    field.input.classList.remove('invalid');
    field.input.classList.toggle('modified', value !== field.original);
  }
  // A material is named beside every mesh that uses it, not just on a row.
  for (const label of asideLabels.get(entry) ?? []) label.paint(value);
  // A scene is named in the toolbar's picker as well, when there is one — and
  // the picker lists the active model's scenes.
  const scene = activeModel?.json.scenes?.indexOf(entry) ?? -1;
  const option = sceneRow.hidden ? undefined : sceneSelect.options[scene];
  if (option) option.textContent = value || `Scene ${scene}`;
  // An animation is named in the Animations tab's list, which is the active model's.
  const clipRow = clipRows.find((row) => row.entry === entry);
  if (clipRow) {
    paintClipName(clipRow);
    paintAnimationsSummary();
  }
}

/**
 * The other material already carrying this name, if any. Downstream of the file
 * a material is usually looked up by name, so two of them answering to one name
 * is a rename the app refuses to make. Comparison is exact: glTF names are, and
 * two names differing in case are two names. Only the materials of the same
 * file count: two files are free to share material names.
 */
function materialNameClash(model: Model, entry: NamedEntry, value: string): NamedEntry | null {
  const materials = model.json.materials;
  // An unnamed material is not a name being taken, and only materials collide.
  if (!materials || value === '' || !materials.includes(entry)) return null;
  return materials.find((other) => other !== entry && getName(other) === value) ?? null;
}

/**
 * Writes what was typed into a name field, unless it would give two materials
 * the same name. A rejected name stays in the field, marked, and never reaches
 * the document — so the file keeps the name it had while the user fixes theirs.
 */
function applyNameEdit(model: Model, entry: NamedEntry, input: HTMLInputElement): void {
  const clash = materialNameClash(model, entry, input.value);
  if (clash) {
    input.classList.add('invalid');
    input.title = `Material ${model.json.materials!.indexOf(clash)} is already named "${input.value}"`;
    return;
  }
  setEntryName(entry, input.value, input);
  noteEdit(model);
}

/** Leaving a field with a rejected name in it puts the document's name back. */
function settleNameEdit(model: Model, entry: NamedEntry, input: HTMLInputElement): void {
  if (!input.classList.contains('invalid')) return;
  const kept = getName(entry);
  const typed = input.value;
  setEntryName(entry, kept);
  noteEdit(model);
  showFlash(`"${typed}" is another material's name — kept "${kept || '(unnamed)'}"`);
}

/** Which entry a name field stands for, wherever in the UI it is, and whose it is. */
function entryForInput(input: HTMLInputElement): { model: Model; entry: NamedEntry } | undefined {
  for (const row of rows) {
    if (!isObjectRow(row) && row.input === input) return row;
  }
  return propFields.find((field) => field.input === input);
}

function buildEditor(): void {
  // The rows are about to go, and with them what each knew about the name the
  // file gave its entry. Kept, a rebuild — a scene switch, a delete — does not
  // quietly turn every rename into the file's own name. Collapsed rows are
  // carried by entry too, since the positions they were kept by move.
  keepOriginals();
  const collapsed = collapsedEntries();

  outlinerEl.textContent = '';
  rows = [];
  rowsByEntry = new Map();
  rowsByTarget = new Map();
  asideLabels = new Map();
  noteGroups = [];
  collapsedRows = new Set();
  allCollapsed = allCollapsed && collapsed.size > 0;

  buildOutliner();
  restoreCollapsed(collapsed);

  updateFileStats();
  // Added images become files of their own, so the folder view moves with the
  // document as well as with what has been dropped in.
  renderFiles();
  // A delete can take an animation with it, and a reset brings a new document.
  renderAnimationTab();

  applyFilter();
  updateStatus();
  refreshVisibilityState();
  // Re-attach the selection to the freshly built rows, or clear the panel. A
  // multiple selection keeps whatever of it is still there.
  propSignature = '';
  const kept = allPicks().flatMap((pick) => livePick(pick) ?? []);
  if (kept.length > 0) selectPicks(kept[0], kept.slice(1));
  else if (selection) selectTarget(selection);
  else if (pickedObject !== null) selectObject(pickedObject);
  else renderProperties();
  updateMenus();
}

/**
 * Moves what the rows know about the names the file gave their entries into
 * their model's `originalNames`, which is where the next build's rows look.
 */
function keepOriginals(): void {
  for (const row of rows) {
    if (isObjectRow(row) || row.fixed) continue;
    const kept = (row.model.originalNames ??= new Map());
    if (!kept.has(row.entry)) kept.set(row.entry, { name: row.original, had: row.hadName });
  }
}

/**
 * What a model names outside the outliner, with no row to remember the file's
 * name for it: its scenes, renamed in the model's panel, and its animations,
 * renamed in their own tab.
 */
function rowlessEntries(model: Model): NamedEntry[] {
  return [...(model.json.scenes ?? []), ...(model.json.animations ?? [])];
}

/**
 * Keeps the names a model's rowless entries carry in `originalNames`, the first
 * time they are seen. The first build of a model comes before any rename — so
 * what is kept is the file's.
 */
function keepRowlessOriginals(model: Model): void {
  const entries = rowlessEntries(model);
  if (entries.length === 0) return;
  const kept = (model.originalNames ??= new Map());
  for (const entry of entries) {
    if (!kept.has(entry)) kept.set(entry, { name: getName(entry), had: typeof entry.name === 'string' });
  }
}

/** The name the file gave an entry without a row of its own, if one was kept. */
function keptOriginal(entry: NamedEntry): { name: string; had: boolean } | undefined {
  for (const model of models) {
    const kept = model.originalNames?.get(entry);
    if (kept) return kept;
  }
  return undefined;
}

/** How many of these entries carry a name other than the file's. */
function renamedCount(model: Model, entries: NamedEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    const kept = model.originalNames?.get(entry);
    if (kept && getName(entry) !== kept.name) count++;
  }
  return count;
}

/**
 * One tree for every open model, the way the three.js editor's outliner holds
 * every file imported into it: a single Scene at the root, belonging to none of
 * them, with each model under it as an object of its own.
 */
function buildOutliner(): void {
  if (models.length === 0 && !sceneStarted) return;
  const list = document.createElement('ul');
  outlinerEl.append(list);
  addSceneRootRow(list);
  buildObjectRows(list);
  for (const model of models) buildModelRows(list, model);
}

/**
 * The scene's own objects, first under the Scene row the way a new scene's
 * lights are, nested by parent. A parent that is not there any more puts an
 * object back at the top rather than losing it.
 */
function buildObjectRows(list: HTMLUListElement): void {
  const ids = new Set(sceneObjects.map((object) => object.id));
  const children = new Map<number | null, SceneObject[]>();
  for (const object of sceneObjects) {
    const parent = object.parent !== null && ids.has(object.parent) ? object.parent : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(object);
    else children.set(parent, [object]);
  }
  const walk = (parent: number | null, depth: number): void => {
    for (const object of children.get(parent) ?? []) {
      addObjectRow(list, object, depth, children.has(object.id));
      walk(object.id, depth + 1);
    }
  };
  walk(null, 1);
}

function addObjectRow(
  list: HTMLUListElement,
  object: SceneObject,
  depth: number,
  hasChildren: boolean,
): ObjectRow {
  const el = document.createElement('li');
  el.className = 'row scene-object';
  el.dataset.row = String(rows.length);

  const main = document.createElement('div');
  main.className = 'row-main';
  main.style.setProperty('--depth', String(Math.min(depth, 12)));

  let discloseBtn: HTMLButtonElement | null = null;
  if (hasChildren) {
    discloseBtn = document.createElement('button');
    discloseBtn.type = 'button';
    discloseBtn.className = 'row-btn disclose';
    discloseBtn.dataset.action = 'disclose';
    discloseBtn.setAttribute('aria-expanded', 'true');
    discloseBtn.title = 'Collapse';
    main.append(discloseBtn);
  } else {
    main.append(placeholderSlot('slot-disclose'));
  }
  main.append(typeIcon(objectIcon(object.kind)));

  const input = document.createElement('input');
  input.type = 'text';
  input.value = object.name;
  input.placeholder = '(unnamed)';
  input.spellcheck = false;
  input.readOnly = true;
  input.setAttribute('aria-label', `${SCENE_OBJECT_KINDS[object.kind].label} name`);
  main.append(input);

  const eyeBtn = document.createElement('button');
  eyeBtn.type = 'button';
  eyeBtn.className = 'row-btn eye';
  eyeBtn.dataset.action = 'toggle-visibility';
  eyeBtn.innerHTML = iconSvg('eye');

  const locateBtn = document.createElement('button');
  locateBtn.type = 'button';
  locateBtn.className = 'row-btn locate';
  locateBtn.dataset.action = 'locate';
  locateBtn.innerHTML = iconSvg('locate');
  // An ambient light is everywhere at once, so there is nowhere to frame.
  locateBtn.hidden = object.kind === 'ambient';
  locateBtn.title = categoryOf(object.kind) === 'mesh' ? 'Frame in the 3D view' : 'Frame where it sits';

  el.append(placeholderSlot('row-index'), eyeBtn, main, locateBtn, placeholderSlot('slot-revert'));
  list.append(el);

  const row: ObjectRow = { object, depth, hasChildren, filtered: true, el, input, discloseBtn, eyeBtn };
  input.addEventListener('input', () => setObjectName(object, input.value, input));
  input.addEventListener('focus', () => selectObject(object.id));
  input.addEventListener('blur', () => {
    input.readOnly = true;
  });
  rows.push(row);
  return row;
}

function objectIcon(kind: SceneObjectKind): IconName {
  switch (kind) {
    case 'group':
      return 'nodeEmpty';
    case 'ambient':
      return 'lightAmbient';
    case 'directional':
      return 'lightDirectional';
    case 'hemisphere':
      return 'lightHemisphere';
    case 'point':
      return 'nodeLight';
    case 'spot':
      return 'lightSpot';
    default:
      return 'nodeMesh';
  }
}

function buildModelRows(list: HTMLUListElement, model: Model): void {
  const items = buildHierarchy(model.json, model.sceneIndex);
  // The file's own scenes have no row — the model's row is the file — and its
  // animations are in a tab of their own, so the names the file gave them are
  // kept here, where the rows keep theirs.
  keepRowlessOriginals(model);

  // A model is one object in the scene, named after its file the way the editor
  // names an imported one. Picking it picks the model: it is moved, hidden and
  // framed whole from here. The file's own scene — what three.js loads as
  // `gltf.scene` — is renamed in the model's panel instead, since a row called
  // "Scene" per file is exactly what one shared scene is not.
  addRow(list, {
    model,
    entry: { name: model.sceneName ?? (baseName(model.path) || model.fileName) },
    label: 'Model',
    icon: 'fileModel',
    index: 0,
    depth: 1,
    hasChildren: items.length > 0,
    fixed: true,
  });
  if (items.length === 0 && models.length === 1) {
    outlinerEl.append(emptyState('This file has no scene contents.'));
    return;
  }

  let currentGroup: { el: HTMLElement; rows: Row[] } | null = null;
  // Everything hangs off the model's row, the leftovers below the group note
  // included: they are in the file, just not in the scene it has on show.
  const rootDepth = 2;

  for (const item of items) {
    if (item.groupNote) {
      const note = document.createElement('li');
      note.className = 'group-note';
      note.textContent = item.groupNote;
      list.append(note);
      currentGroup = { el: note, rows: [] };
      noteGroups.push(currentGroup);
    }
    const row = addRow(list, {
      model,
      entry: item.entry,
      label: item.label,
      icon: item.icon,
      index: item.target?.index ?? 0,
      depth: item.depth + rootDepth,
      hasChildren: item.hasChildren,
      target: item.target,
      mesh: item.mesh,
      materials: item.materials,
    });
    currentGroup?.rows.push(row);
  }
}

function addRow(list: HTMLUListElement, spec: RowSpec): Row {
  const el = document.createElement('li');
  el.className = spec.fixed ? 'row fixed' : 'row';
  el.dataset.row = String(rows.length);

  const indexEl = document.createElement('span');
  indexEl.className = 'row-index';
  // The file has no index in the document, so its row shows none.
  indexEl.textContent = spec.fixed ? '' : String(spec.index);

  const main = document.createElement('div');
  main.className = 'row-main';
  main.style.setProperty('--depth', String(Math.min(spec.depth, 12)));

  let discloseBtn: HTMLButtonElement | null = null;
  if (spec.hasChildren) {
    // The glyph is drawn in CSS ('−' / '+'), the way the editor's opener is.
    discloseBtn = document.createElement('button');
    discloseBtn.type = 'button';
    discloseBtn.className = 'row-btn disclose';
    discloseBtn.dataset.action = 'disclose';
    discloseBtn.setAttribute('aria-expanded', 'true');
    discloseBtn.title = 'Collapse';
    main.append(discloseBtn);
  } else {
    main.append(placeholderSlot('slot-disclose'));
  }
  main.append(typeIcon(spec.icon));

  const input = document.createElement('input');
  input.type = 'text';
  input.value = getName(spec.entry);
  input.placeholder = '(unnamed)';
  input.spellcheck = false;
  // A name is a label until the row is picked a second time; see beginRename.
  input.readOnly = true;
  input.setAttribute('aria-label', spec.fixed ? spec.label : `${spec.label} ${spec.index} name`);
  main.append(input);

  // Whose materials the row is naming: the mesh it draws, or the mesh it is.
  const owner = spec.mesh?.index ?? (spec.target?.kind === 'mesh' ? spec.target.index : undefined);
  const morphed = owner !== undefined && morphTargetCount(spec.model.json.meshes?.[owner]) > 0;
  let fitted = false;
  if (owner !== undefined && (spec.mesh || (spec.materials?.length ?? 0) > 0 || morphed)) {
    // The name field stops where its text does, so what follows sits beside the
    // name rather than out at the edge of the row.
    main.classList.add('has-aside');
    const node = spec.target?.kind === 'node' ? spec.target.index : undefined;
    main.append(rowAside(spec.model, spec.mesh, spec.materials ?? [], owner, node));
    fitted = true;
  }
  if (fitted) fitNameField(input);

  // A model's row stands for the whole model in the scene, so it can be hidden
  // and framed like the objects in it.
  const root = spec.fixed === true;
  let eyeBtn: HTMLButtonElement | null = null;
  let locateBtn: HTMLButtonElement | null = null;
  if (spec.target || root) {
    if (spec.target?.kind !== 'material') {
      eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      eyeBtn.className = 'row-btn eye';
      eyeBtn.dataset.action = 'toggle-visibility';
      eyeBtn.innerHTML = iconSvg('eye');
      eyeBtn.hidden = true;
    }
    locateBtn = document.createElement('button');
    locateBtn.type = 'button';
    locateBtn.className = 'row-btn locate';
    locateBtn.dataset.action = 'locate';
    locateBtn.innerHTML = iconSvg('locate');
    locateBtn.title = 'Frame in the 3D view';
    locateBtn.hidden = true;
  }

  const revertBtn = document.createElement('button');
  revertBtn.type = 'button';
  revertBtn.className = 'row-btn revert';
  revertBtn.dataset.action = 'revert';
  revertBtn.innerHTML = iconSvg('revert');
  revertBtn.hidden = true;

  el.append(
    indexEl,
    eyeBtn ?? placeholderSlot('slot-eye'),
    main,
    locateBtn ?? placeholderSlot('slot-locate'),
    revertBtn,
  );
  list.append(el);

  // Normally the name in the document *is* the original; a restored session is
  // the exception, and brings the file's own names with it.
  const pristine = spec.model.originalNames?.get(spec.entry);

  const row: Row = {
    model: spec.model,
    entry: spec.entry,
    label: spec.label,
    index: spec.index,
    target: spec.target,
    mesh: spec.mesh,
    materials: spec.materials ?? [],
    fixed: spec.fixed === true,
    fitted,
    depth: spec.depth,
    hasChildren: spec.hasChildren,
    original: pristine?.name ?? getName(spec.entry),
    hadName: pristine?.had ?? typeof spec.entry.name === 'string',
    filtered: true,
    el,
    input,
    discloseBtn,
    eyeBtn,
    locateBtn,
    revertBtn,
  };

  input.addEventListener('input', () => {
    applyNameEdit(row.model, row.entry, input);
    // Rejected or not, the field is showing what was typed, so it resizes.
    if (row.fitted) fitNameField(input);
  });
  // Reaching a name is a selection: the properties panel and the 3D view follow.
  input.addEventListener('focus', () => selectTarget(refFor(row)));
  // Leaving the field ends the rename, so the row is a row again next time.
  input.addEventListener('blur', () => {
    input.readOnly = true;
    settleNameEdit(row.model, row.entry, input);
  });

  // Only a restored row can already differ from the file, so the usual path
  // pays nothing for this.
  if (row.original !== input.value) updateRowState(row);

  rows.push(row);
  const siblings = rowsByEntry.get(spec.entry);
  if (siblings) siblings.push(row);
  else rowsByEntry.set(spec.entry, [row]);

  if (root) addKeyedRow(rootKey(spec.model.id), row);
  if (spec.target) addKeyedRow(targetKey(spec.model, spec.target.kind, spec.target.index), row);
  // An object's row stands in for its mesh data as well, since that has no row
  // of its own: selecting the mesh has to light something up in here.
  if (spec.mesh) addKeyedRow(targetKey(spec.model, 'mesh', spec.mesh.index), row);
  return row;
}

function addKeyedRow(key: string, row: Row): void {
  const targeted = rowsByTarget.get(key);
  if (targeted) targeted.push(row);
  else rowsByTarget.set(key, [row]);
}

/**
 * The Scene at the top of the tree. It is not a row of `rows`: those are all
 * about something in a file, and the scene is in none of them. It has no name
 * to edit and nothing to hide, but it can be picked, framed and folded shut.
 */
function addSceneRootRow(list: HTMLUListElement): void {
  const el = document.createElement('li');
  el.className = 'row fixed scene-root';

  const main = document.createElement('div');
  main.className = 'row-main';
  main.style.setProperty('--depth', '0');

  const discloseBtn = document.createElement('button');
  discloseBtn.type = 'button';
  discloseBtn.className = 'row-btn disclose';
  discloseBtn.dataset.action = 'disclose';
  const name = document.createElement('span');
  name.className = 'row-label';
  name.textContent = activeScene().name;
  main.append(discloseBtn, typeIcon('scene'), name);

  const locateBtn = document.createElement('button');
  locateBtn.type = 'button';
  locateBtn.className = 'row-btn locate';
  locateBtn.dataset.action = 'locate';
  locateBtn.innerHTML = iconSvg('locate');
  locateBtn.title = 'Frame everything in the 3D view';

  el.append(
    placeholderSlot('row-index'),
    placeholderSlot('slot-eye'),
    main,
    locateBtn,
    placeholderSlot('slot-revert'),
  );
  list.append(el);
  sceneRootEl = el;
  paintSceneRoot();
}

/** Whether the Scene row reads as picked, and as shut. */
function paintSceneRoot(): void {
  const el = sceneRootEl;
  if (!el) return;
  el.classList.toggle('selected', sceneSelected);
  el.classList.toggle('collapsed', sceneCollapsed);
  const discloseBtn = el.querySelector<HTMLButtonElement>('.disclose');
  discloseBtn?.setAttribute('aria-expanded', String(!sceneCollapsed));
  if (discloseBtn) discloseBtn.title = sceneCollapsed ? 'Expand' : 'Collapse';
}

/** Picks the scene itself: no model, so the panel describes all of them. */
function selectSceneRoot(): void {
  selectTarget(null);
  sceneSelected = true;
  paintSceneRoot();
  renderProperties();
}

function handleSceneRootClick(target: HTMLElement): void {
  switch (target.closest<HTMLButtonElement>('button[data-action]')?.dataset.action) {
    case 'disclose':
      sceneCollapsed = !sceneCollapsed;
      paintSceneRoot();
      applyRowVisibility();
      break;
    case 'locate':
      selectSceneRoot();
      viewer?.frameAll();
      break;
    default:
      selectSceneRoot();
  }
}

/**
 * What a row draws, printed just after its own name the way the three.js
 * editor's outliner prints an object's geometry and material after its name:
 * the mesh data, then that mesh's materials. One material is a chip; several are
 * a dropdown, since a mesh with eight primitives would otherwise bury the name.
 * Picking any of them shows its properties, which is where mesh data and
 * materials live now that neither has a row of its own. A material picked on an
 * object's row is that object's material tab; `node` is that object.
 */
function rowAside(
  model: Model,
  mesh: EntryUse | undefined,
  materials: EntryUse[],
  owner: number,
  node: number | undefined,
): HTMLElement {
  const aside = document.createElement('span');
  aside.className = 'row-aside';

  // A row that *is* mesh data — mesh nothing in the file draws — has no chip for
  // it: the row's own name is the mesh, and it names its materials.
  if (mesh) aside.append(meshChip(model, mesh, materials.length > 0));
  if (morphTargetCount(model.json.meshes?.[owner]) > 0) aside.append(morphChip(model, owner));
  if (materials.length === 1) aside.append(materialChip(model, materials[0], owner, node));
  else if (materials.length > 1) {
    // The icon is the chip's; a native dropdown cannot carry one in its options.
    aside.append(typeIcon('material'), materialPicker(model, materials, owner, node));
  }
  return aside;
}

/**
 * That the object draws mesh data, as the symbol for it alone: the mesh usually
 * carries the object's own name over again, and printing it twice on one row
 * says nothing. Its name is in the tooltip, and one click away in the panel.
 */
function meshChip(model: Model, use: EntryUse, hasMaterials: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-chip glyph';
  button.dataset.action = 'select-mesh';
  button.dataset.mesh = String(use.index);
  // A mesh with no material at all reads differently from one that has some.
  button.append(typeIcon(hasMaterials ? 'meshData' : 'meshDataPlain'));

  registerAside(use.entry, {
    model: model.id,
    kind: 'mesh',
    index: use.index,
    mesh: use.index,
    paint: (value) => {
      button.title = `Mesh ${use.index}: ${value || `Mesh ${use.index}`} — show its properties`;
      button.setAttribute('aria-label', button.title);
    },
    mark: (selected) => button.classList.toggle('selected', selected),
  });
  return button;
}

/**
 * That the mesh a row draws — or is — has morph targets, and how many. A click
 * shows them, on the object's tab or the mesh's; hovering names them.
 */
function morphChip(model: Model, mesh: number): HTMLButtonElement {
  const names = morphTargetNames(model.json.meshes?.[mesh]).map((name, target) => name ?? `Target ${target}`);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-chip morph-chip';
  button.dataset.action = 'show-morphs';
  const count = document.createElement('span');
  count.className = 'row-chip-name';
  count.textContent = String(names.length);
  button.append(typeIcon('morph'), count);
  button.title = `${plural(names.length, 'morph target')}: ${names.join(', ')} — show them`;
  button.setAttribute('aria-label', button.title);
  return button;
}

function materialChip(model: Model, use: EntryUse, mesh: number, node: number | undefined): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-chip';
  button.dataset.action = 'select-material';
  button.dataset.material = String(use.index);

  const name = document.createElement('span');
  name.className = 'row-chip-name';
  button.append(typeIcon('material'), name);

  registerAside(use.entry, {
    model: model.id,
    kind: 'material',
    index: use.index,
    mesh,
    node,
    paint: (value) => {
      name.textContent = materialLabel(value, use.index);
      name.classList.toggle('unnamed', value === '');
      button.title = `Material ${use.index}: ${materialLabel(value, use.index)} — show its properties`;
      button.setAttribute('aria-label', button.title);
    },
    mark: (selected) => button.classList.toggle('selected', selected),
  });
  return button;
}

function materialPicker(model: Model, uses: EntryUse[], mesh: number, node: number | undefined): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'row-chip';
  select.title = `${uses.length} materials — pick one to show its properties`;
  select.setAttribute('aria-label', select.title);

  // What the closed dropdown says until one is picked: the count is the point.
  const summary = document.createElement('option');
  summary.value = '';
  summary.textContent = `${uses.length} materials`;
  select.append(summary);

  for (const use of uses) {
    const option = document.createElement('option');
    option.value = String(use.index);
    select.append(option);
    registerAside(use.entry, {
      model: model.id,
      kind: 'material',
      index: use.index,
      mesh,
      node,
      paint: (value) => {
        option.textContent = materialLabel(value, use.index);
      },
      // Picked elsewhere — from the panel, say — the dropdown shows it too.
      mark: (selected) => {
        if (selected) select.value = option.value;
        else if (select.value === option.value) select.value = '';
      },
    });
  }

  select.addEventListener('change', () => {
    if (select.value === '') return;
    propTab = 'material';
    selectTarget(asideRef(model, node, mesh, Number(select.value)));
  });
  return select;
}

/**
 * What picking a mesh's material selects: the material within that mesh, and
 * within the object drawing it when there is one, so the object stays picked
 * and only the tab changes.
 */
function asideRef(model: Model, node: number | undefined, mesh: number, material: number): SelectionRef {
  return node === undefined ? { model: model.id, mesh, material } : { model: model.id, node, mesh, material };
}

/** The row font, read from a live field once: every row name field shares it. */
let rowFont = '';
let textMeasure: CanvasRenderingContext2D | null = null;

/**
 * Sizes a name field to its own text. Only rows that print something after the
 * name need this — everywhere else a field spanning the row is the bigger, and
 * so the better, target to click.
 */
function fitNameField(input: HTMLInputElement): void {
  if (!textMeasure) textMeasure = document.createElement('canvas').getContext('2d');
  if (!textMeasure) return;
  if (rowFont === '') {
    const style = getComputedStyle(input);
    // A field built before its stylesheet applies would measure as nothing.
    if (style.fontSize === '' || style.fontFamily === '') return;
    rowFont = `${style.fontSize} ${style.fontFamily}`;
  }
  textMeasure.font = rowFont;
  const text = input.value || input.placeholder;
  // Padding and borders, plus a pixel of slack for the italic placeholder.
  input.style.width = `${Math.ceil(textMeasure.measureText(text).width) + 13}px`;
}

function registerAside(entry: NamedEntry, label: AsideLabel): void {
  label.paint(getName(entry));
  const labels = asideLabels.get(entry);
  if (labels) labels.push(label);
  else asideLabels.set(entry, [label]);
}

/** An unnamed material still has to be pointed at, so it goes by its index. */
function materialLabel(value: string, index: number): string {
  return value || `Material ${index}`;
}

/**
 * Marks what the panel is showing among the things named beside rows. Neither
 * mesh data nor a material has a row of its own to light up, so their chips and
 * dropdowns are what say where the selection went.
 */
function paintAsideSelection(): void {
  for (const labels of asideLabels.values()) {
    for (const label of labels) label.mark(asideIsShowing(label));
  }
}

/**
 * Whether a label names what the panel is showing. A mesh and its material are
 * selected together, so the two chips cannot both be it — which one is lit
 * follows the tab on show.
 */
function asideIsShowing(label: AsideLabel): boolean {
  if (!selection || selection.model !== label.model) return false;
  // An object's mesh and material are lit on its own row, not on every other
  // object's that draws the same mesh.
  if (selection.node !== undefined && selection.node !== label.node) return false;
  if (label.kind === 'mesh') return propTab === 'mesh' && selection.mesh === label.index;
  if (propTab !== 'material' || selection.material !== label.index) return false;
  // A material shown within a mesh is lit on that mesh alone: other meshes using
  // it are not what was picked. Shown on its own — from the Names tab — it is
  // lit wherever it is named.
  return selection.mesh === undefined || selection.mesh === label.mesh;
}

function placeholderSlot(modifier: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `row-slot ${modifier}`;
  return span;
}

function updateRowState(row: Row): void {
  const modified = row.input.value !== row.original;
  row.el.classList.toggle('modified', modified);
  row.revertBtn.hidden = !modified;
  row.revertBtn.title = `Revert to "${row.original || '(unnamed)'}"`;
  row.input.title = modified ? `Original: ${row.original || '(unnamed)'}` : '';
}

function modifiedCount(model: Model): number {
  let count = 0;
  for (const entryRows of rowsByEntry.values()) {
    if (entryRows[0].model !== model) continue;
    // The document, not the field: a rejected name is in a field but not in the
    // file, and the count is about what would be downloaded.
    if (getName(entryRows[0].entry) !== entryRows[0].original) count++;
  }
  // Scenes and animations are named outside the outliner, with no row to count them by.
  return count + renamedCount(model, rowlessEntries(model));
}

/**
 * Every edit to a model ends here: the read-out is refreshed, and the model's
 * stored document is kept in step.
 */
function noteEdit(model: Model): void {
  recordModelEdit(model);
  updateFileStats();
  scheduleDocSave(model);
}

/** The File panel's "Contents" row: what the active file holds, and what was renamed. */
function updateFileStats(): void {
  const model = activeModel;
  if (!model) {
    fileStatsEl.textContent = '—';
    return;
  }
  // Counts describe the file, so they are the same in either list.
  const parts: string[] = [];
  for (const category of CATEGORIES) {
    const count = category.list(model.json).length;
    if (count > 0) parts.push(`${count} ${count === 1 ? category.singular : category.label}`);
  }
  const modified = modifiedCount(model);
  if (modified > 0) parts.push(`${modified} renamed`);
  const { mapEdits, editedMaterials, movedNodes, shadowEdits, morphedMeshes, deletedCount, copiedAnimations } = model;
  if (mapEdits > 0) parts.push(`${mapEdits} texture change${mapEdits === 1 ? '' : 's'}`);
  if (editedMaterials.size > 0) {
    parts.push(`${editedMaterials.size} material${editedMaterials.size === 1 ? '' : 's'} edited`);
  }  if (movedNodes.size > 0) parts.push(`${movedNodes.size} moved`);
  if (shadowEdits.size > 0) parts.push(`${shadowEdits.size} shadow change${shadowEdits.size === 1 ? '' : 's'}`);
  if (morphedMeshes.size > 0) parts.push(`${morphedMeshes.size} morph change${morphedMeshes.size === 1 ? '' : 's'}`);
  if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
  if (copiedAnimations > 0) parts.push(`${copiedAnimations} copied`);
  const trimmed = trimmedCount(model);
  if (trimmed > 0) parts.push(`${trimmed} trimmed`);
  fileStatsEl.textContent = parts.join(' · ') || '—';
}

/** How many of a model's animations play only a stretch of themselves. */
function trimmedCount(model: Model): number {
  return (model.json.animations ?? []).filter((animation) => getTrim(animation) !== null).length;
}

/**
 * The viewport's bottom-left read-out: the same scene statistics the three.js
 * editor shows. Labels never change, so the lines are built once and only the
 * numbers are rewritten — the render time is rewritten every frame.
 */
const statusFields = {
  objects: statusLine('objects'),
  vertices: statusLine('vertices'),
  triangles: statusLine('triangles'),
  renderTime: statusLine('render time'),
};

/** One line of that read-out; the cell it returns is where the number goes. */
function statusLine(label: string): HTMLElement {
  const line = document.createElement('div');
  const key = document.createElement('span');
  key.textContent = label;
  const value = document.createElement('b');
  value.textContent = '—';
  line.append(key, value);
  viewportInfo.append(line);
  return value;
}

function updateStatus(): void {
  const stats = viewer?.stats();
  statusFields.objects.textContent = stats ? formatCount(stats.objects) : '—';
  statusFields.vertices.textContent = stats ? formatCount(stats.vertices) : '—';
  statusFields.triangles.textContent = stats ? formatCount(stats.triangles) : '—';
  statusFields.renderTime.textContent = stats ? `${stats.renderTime.toFixed(2)} ms` : '—';
}

/** Thousands separators, so six-figure vertex counts stay readable. */
function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function showFlash(message: string): void {
  flash.textContent = message;
  flash.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash.textContent = '';
    flash.hidden = true;
  }, 4000);
}

// ---------------------------------------------------------------------------
// Files tab
//
// What the model was opened from, as the folder it arrived as: the .glb/.gltf
// itself plus every sidecar dropped alongside it, each saying what the document
// uses it for. A .glb usually arrives alone; a .gltf brings its .bin and its
// textures, and this is where you can see which of them actually turned up.

/** Every file that came in with the active model, and what its document does with it. */
function folderFiles(): FolderFile[] {
  const model = activeModel;
  if (!model) return [];
  const { json, resources } = model;

  // Which supplied file each declared URI resolves to. Going through the same
  // lookup the preview uses is the point: a file listed as used here is one the
  // preview really found, spelling differences and all.
  const lookup = buildResourceLookup(resources);
  const { buffers, images } = listExternalResources(json);
  const uses = new Map<File, { uris: string[]; role: FileRole }>();
  for (const [uris, role] of [
    [buffers, 'buffer'],
    [images, 'image'],
  ] as [string[], FileRole][]) {
    for (const uri of uris) {
      const file = resolveResource(lookup, uri);
      if (!file) continue;
      const use = uses.get(file);
      if (!use) {
        uses.set(file, { uris: [uri], role });
        continue;
      }
      use.uris.push(uri);
      // One file serving both: 'buffer' is the role worth showing, being the
      // one the preview cannot do without.
      if (role === 'buffer') use.role = 'buffer';
    }
  }
  const added = new Set(model.addedImages.values());

  const files: FolderFile[] = [];
  if (model.path !== '') {
    files.push({ path: model.path, size: model.size, role: 'model', usedAs: [] });
  }
  for (const [path, file] of resources) {
    const use = uses.get(file);
    files.push({
      path,
      size: file.size,
      // An image the user brought in is used, but saying so would hide the more
      // interesting fact that it is not part of the file yet.
      role: added.has(file) ? 'added' : use?.role ?? 'unused',
      usedAs: use?.uris ?? [],
    });
  }
  return files;
}

const FILE_ICONS: Record<FileRole, IconName> = {
  model: 'fileModel',
  buffer: 'fileData',
  image: 'image',
  added: 'image',
  unused: 'file',
};

function fileTitle(file: FolderFile): string {
  switch (file.role) {
    case 'model':
      return 'The open file';
    case 'added':
      return activeModel?.isGlb
        ? 'Added from disk — the downloaded .glb carries its bytes'
        : 'Added from disk — save it next to the downloaded .gltf';
    case 'unused':
      return 'Supplied, but this model does not refer to it';
    default:
      return `Used as ${file.usedAs.join(', ')}`;
  }
}

function renderFiles(): void {
  fileTreeEl.textContent = '';
  fileTreeRows = [];

  const files = folderFiles();
  if (files.length === 0) {
    filesSummary.textContent = '—';
    fileTreeEl.append(emptyState('No file open.'));
    clearFileSelection();
    renderMissingFiles();
    return;
  }

  const list = document.createElement('ul');
  for (const row of buildFolderRows(files)) fileTreeRows.push(addFileRow(list, row));
  fileTreeEl.append(list);
  applyFileVisibility();

  // Every element is new, so the pick and the preview are re-attached — or
  // dropped, when what they pointed at is not in the folder any more. The file
  // is compared, not just the path: one can be replaced at the path of another.
  if (previewFile && activeModel?.resources.get(previewFile.path) !== previewFile.file) {
    clearFilePreview();
  }
  if (selectedFilePath !== null && !fileTreeRows.some((row) => row.path === selectedFilePath)) {
    selectedFilePath = null;
  }
  markFileSelection();

  // The size is the folder's, model included; 'unused' is only ever about the
  // files supplied alongside it.
  const total = files.reduce((sum, file) => sum + Math.max(file.size, 0), 0);
  const unused = files.filter((file) => file.role === 'unused').length;
  const parts = [plural(files.length, 'file')];
  if (total > 0) parts.push(formatBytes(total));
  if (unused > 0) parts.push(`${unused} unused`);
  filesSummary.textContent = parts.join(' · ');

  renderMissingFiles();
}

function addFileRow(list: HTMLUListElement, spec: FolderRow): FileTreeRow {
  const el = document.createElement('li');
  el.className = 'file-row';

  const main = document.createElement('div');
  main.className = 'file-main';
  main.style.setProperty('--depth', String(Math.min(spec.depth, 12)));

  let disclose: HTMLButtonElement | null = null;
  if (spec.file === null) {
    el.classList.add('folder');
    disclose = document.createElement('button');
    disclose.type = 'button';
    // The glyph is drawn in CSS the way the outliner's opener is.
    disclose.className = 'row-btn disclose';
    disclose.addEventListener('click', (event) => {
      // The row is pickable as a whole, so the opener has to keep its click.
      event.stopPropagation();
      toggleFolder(spec.path);
    });
    main.append(disclose, typeIcon('folder'));
  } else {
    el.classList.add(spec.file.role);
    main.append(placeholderSlot('slot-disclose'), typeIcon(FILE_ICONS[spec.file.role]));
  }

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = spec.label;
  main.append(name);

  // Only the two states worth a word get one; the glyph carries the rest.
  if (spec.file?.role === 'added' || spec.file?.role === 'unused') {
    const tag = document.createElement('span');
    tag.className = 'file-tag';
    tag.textContent = spec.file.role;
    main.append(tag);
  }

  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = spec.file
    ? formatBytes(spec.file.size)
    : [plural(spec.fileCount, 'file'), spec.totalSize > 0 ? formatBytes(spec.totalSize) : '']
        .filter((part) => part !== '')
        .join(' · ');

  // The file behind the row, which is what makes it previewable and removable.
  // The model has none: only its bytes were kept, not the File it came from.
  const file = spec.file === null ? undefined : activeModel?.resources.get(spec.path);
  const showable = file !== undefined && isDisplayableFile(file);
  if (showable) el.classList.add('previewable');

  const notes = [spec.path];
  if (spec.file) notes.push(fileTitle(spec.file));
  if (showable) notes.push('Click to see it');
  else if (file && isImageFile(file)) notes.push('Compressed texture — no preview in a browser');
  el.title = notes.join('\n');

  // Every row is a tab stop, so Delete has something to act on without a click.
  el.tabIndex = 0;
  el.addEventListener('click', () => activateFileRow(spec.path));

  el.append(main, size, spec.file?.role === 'model' ? fileSlot() : removeButton(spec));
  list.append(el);

  // A folder shut before the last rebuild stays shut.
  const collapsed = spec.file === null && collapsedFolders.has(spec.path);
  el.classList.toggle('collapsed', collapsed);
  if (disclose) {
    disclose.setAttribute('aria-expanded', String(!collapsed));
    disclose.title = collapsed ? 'Expand' : 'Collapse';
  }
  return { ...spec, el };
}

function fileSlot(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'file-slot';
  return span;
}

/**
 * Un-supplies the row: the file stops standing in for whatever URI it covered.
 * Kept as a hover button as well as the Delete key, since a control nobody can
 * see is a control nobody uses.
 */
function removeButton(spec: FolderRow): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-btn remove';
  button.innerHTML = iconSvg('remove');
  button.title =
    spec.file === null
      ? `Remove the ${plural(spec.fileCount, 'file')} in this folder`
      : 'Remove this file';
  button.addEventListener('click', (event) => {
    // The row is pickable as a whole; removing it is not also picking it.
    event.stopPropagation();
    removeFileRow(spec.path);
  });
  return button;
}

/** Formats a browser will decode in an `<img>`; KTX2/basis/DDS are not among them. */
function isDisplayableFile(file: File): boolean {
  // The extension is checked first: a texture folder always has them, while
  // some file managers hand over a wrong MIME type or none at all.
  if (/\.(png|jpe?g|webp|avif|gif|bmp)$/i.test(file.name)) return true;
  return /^image\/(png|jpeg|webp|avif|gif|bmp)$/.test(file.type);
}

/** Clicking a row, or pressing Enter on it. */
function activateFileRow(path: string): void {
  const row = fileTreeRows.find((candidate) => candidate.path === path);
  if (!row) return;

  if (row.file === null) {
    toggleFolder(path);
    selectFileRow(path);
    return;
  }
  // Clicking what is already open puts it away again, the way clicking the
  // active gizmo mode does.
  if (selectedFilePath === path) {
    clearFileSelection();
    return;
  }
  selectFileRow(path);

  const file = activeModel?.resources.get(path);
  if (file && isDisplayableFile(file)) showFilePreview(path, file);
  else clearFilePreview();
}

function selectFileRow(path: string): void {
  selectedFilePath = path;
  markFileSelection();
}

function clearFileSelection(): void {
  selectedFilePath = null;
  clearFilePreview();
  markFileSelection();
}

function markFileSelection(): void {
  for (const row of fileTreeRows) {
    row.el.classList.toggle('selected', row.path === selectedFilePath);
  }
}

/**
 * Shows an image file at something like full size, straight from the bytes on
 * the user's disk — the document need not refer to it at all, which is what
 * makes it useful for the textures nothing is bound to yet.
 */
function showFilePreview(path: string, file: File): void {
  clearFilePreview();
  const current = { path, file, url: URL.createObjectURL(file) };
  previewFile = current;

  previewPanel.hidden = false;
  previewHost.textContent = '';
  previewHost.classList.remove('failed');
  previewName.textContent = path;
  previewMeta.textContent = formatBytes(file.size);

  const img = document.createElement('img');
  img.alt = baseName(path);
  // Decoding is asynchronous, and the panel may have moved on by the time it
  // finishes — so both handlers check they are still the current one.
  img.addEventListener('load', () => {
    if (previewFile !== current) return;
    previewMeta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${formatBytes(file.size)}`;
  });
  img.addEventListener('error', () => {
    if (previewFile !== current) return;
    previewHost.classList.add('failed');
    previewMeta.textContent = `${formatBytes(file.size)} · could not be decoded`;
  });
  img.src = current.url;
  previewHost.append(img);
}

function clearFilePreview(): void {
  if (previewFile) URL.revokeObjectURL(previewFile.url);
  previewFile = null;
  previewHost.textContent = '';
  previewHost.classList.remove('failed');
  previewPanel.hidden = true;
}

/** Delete on a row, or its × button. A folder takes everything under it. */
function removeFileRow(path: string): void {
  const position = fileTreeRows.findIndex((row) => row.path === path);
  if (position < 0) return;
  const row = fileTreeRows[position];

  const model = activeModel;
  if (!model) return;
  if (row.file?.role === 'model') {
    deleteModel(model);
    return;
  }

  let paths: string[];
  let label: string;
  if (row.file !== null) {
    paths = [path];
    label = row.label;
  } else {
    // The model is not one of the supplied files, so a folder holding it gives
    // up everything except the model.
    paths = filesUnder(fileTreeRows, position)
      .filter((file) => file.role !== 'model')
      .map((file) => file.path);
    label = `${plural(paths.length, 'file')} in ${row.label}`;
  }

  if (paths.length === 0) {
    showFlash('Nothing to remove there');
    return;
  }
  removeFiles(model, paths, label, position);
}

/**
 * Forgets supplied files. Nothing on disk is touched: they simply stop being
 * available, exactly as if they had never been dropped in — so a URI one of
 * them covered moves straight to "Not supplied", and dropping it back in undoes
 * this completely.
 */
function removeFiles(model: Model, paths: string[], label: string, focusAt: number): void {
  const removed: string[] = [];
  for (const path of paths) {
    const file = model.resources.get(path);
    if (file === undefined) continue;
    model.resources.delete(path);
    removed.push(path);
    // An image brought in from disk is held twice; forgetting it in one place
    // only would leave the export embedding bytes the tab says are gone.
    for (const [index, added] of model.addedImages) {
      if (added === file) model.addedImages.delete(index);
    }
  }
  if (removed.length === 0) return;

  if (previewFile && removed.includes(previewFile.path)) clearFilePreview();
  selectedFilePath = null;
  // A thumbnail may have been drawn from a file that is no longer there.
  releaseImageUrls(model);
  propSignature = '';
  renderProperties();
  renderFiles();
  focusFileRowAt(focusAt);
  // The stored session keeps the supplied files, so it has to lose them too.
  void saveSourceRecord(model);
  // The preview was built with them; without the .bin it now says so.
  void startViewer(model, { keepView: true });
  showFlash(`Removed ${label} — nothing on your disk was touched`);
}

/** Keeps the keyboard where it was, so Delete can be pressed twice running. */
function focusFileRowAt(position: number): void {
  const at = Math.min(position, fileTreeRows.length - 1);
  for (const step of [1, -1]) {
    for (let index = at; index >= 0 && index < fileTreeRows.length; index += step) {
      if (fileTreeRows[index].el.hidden) continue;
      fileTreeRows[index].el.focus();
      return;
    }
  }
}

function moveFileFocus(from: FileTreeRow, step: number): void {
  const start = fileTreeRows.indexOf(from);
  for (let index = start + step; index >= 0 && index < fileTreeRows.length; index += step) {
    if (fileTreeRows[index].el.hidden) continue;
    fileTreeRows[index].el.focus();
    return;
  }
}

function toggleFolder(path: string): void {
  if (collapsedFolders.has(path)) collapsedFolders.delete(path);
  else collapsedFolders.add(path);
  const collapsed = collapsedFolders.has(path);

  for (const row of fileTreeRows) {
    if (row.file !== null || row.path !== path) continue;
    row.el.classList.toggle('collapsed', collapsed);
    const disclose = row.el.querySelector<HTMLButtonElement>('.disclose');
    disclose?.setAttribute('aria-expanded', String(!collapsed));
    if (disclose) disclose.title = collapsed ? 'Expand' : 'Collapse';
  }
  applyFileVisibility();
}

/** A collapsed folder hides the run of deeper rows that follows it. */
function applyFileVisibility(): void {
  let floor = Infinity;
  for (const row of fileTreeRows) {
    const hidden = row.depth > floor;
    if (!hidden) {
      floor = row.file === null && collapsedFolders.has(row.path) ? row.depth : Infinity;
    }
    row.el.hidden = hidden;
  }
}

/** The URIs the active model's document declares that nothing supplied covers. */
function renderMissingFiles(): void {
  const model = activeModel;
  missingFilesEl.textContent = '';
  if (!model) {
    missingPanel.hidden = true;
    return;
  }

  const lookup = buildResourceLookup(model.resources);
  const { buffers, images } = listExternalResources(model.json);
  const missing = [
    ...findMissing(buffers, lookup).map((uri) => ({ uri, required: true })),
    ...findMissing(images, lookup).map((uri) => ({ uri, required: false })),
  ];
  missingPanel.hidden = missing.length === 0;

  for (const { uri, required } of missing) {
    const item = document.createElement('li');
    item.textContent = uri;
    item.classList.toggle('required', required);
    item.title = required
      ? 'Needed before the preview can draw anything'
      : 'Optional — the preview shows a placeholder without it';
    missingFilesEl.append(item);
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Filtering, collapsing, replace, export

function applyFilter(): void {
  const query = searchInput.value.trim().toLowerCase();
  for (const row of rows) {
    if (isObjectRow(row)) {
      row.filtered = query === '' || row.object.name.toLowerCase().includes(query);
      continue;
    }
    row.filtered =
      query === '' ||
      row.input.value.toLowerCase().includes(query) ||
      row.original.toLowerCase().includes(query) ||
      // Mesh data and materials have no rows here any more, so the row naming
      // them answers for them.
      (row.mesh !== undefined && getName(row.mesh.entry).toLowerCase().includes(query)) ||
      row.materials.some((use) => getName(use.entry).toLowerCase().includes(query)) ||
      rowMorphNames(row).some((name) => name.toLowerCase().includes(query));
  }
  applyRowVisibility();
}

/** The morph target names of the mesh a row draws, or is: a filter finds the row by them too. */
function rowMorphNames(row: Row): string[] {
  const mesh = row.mesh?.entry ?? (row.target?.kind === 'mesh' ? row.entry : undefined);
  return morphTargetNames(mesh as GltfMesh | undefined).filter((name): name is string => name !== null);
}

/**
 * Visibility combines the text filter with tree collapsing. A collapsed row
 * hides the following run of deeper rows; while a filter is active, collapsing
 * is ignored so matches are never buried.
 */
function applyRowVisibility(): void {
  const filtering = searchInput.value.trim() !== '';
  // The Scene row is not one of `rows`, so shutting it is a floor below them all.
  let floor = sceneCollapsed && !filtering ? -1 : Infinity;

  rows.forEach((row, position) => {
    let hiddenByCollapse = false;
    if (!filtering) {
      hiddenByCollapse = row.depth > floor;
      if (!hiddenByCollapse) floor = collapsedRows.has(position) ? row.depth : Infinity;
    }
    row.el.hidden = hiddenByCollapse || !row.filtered;
  });

  // With several files open, a match is never shown without the file it is in:
  // a model's row stays on screen while anything under it does.
  if (filtering && models.length > 1) {
    const matched = new Set(
      rows.flatMap((row) => (isObjectRow(row) || row.el.hidden ? [] : [row.model])),
    );
    for (const row of rows) {
      if (!isObjectRow(row) && row.fixed && matched.has(row.model)) row.el.hidden = false;
    }
  }

  for (const group of noteGroups) {
    group.el.hidden = group.rows.every((row) => row.el.hidden);
  }
}

function toggleDisclosure(position: number, row: OutlinerRow): void {
  if (collapsedRows.has(position)) collapsedRows.delete(position);
  else collapsedRows.add(position);
  paintDisclosure(row, !collapsedRows.has(position));
  applyRowVisibility();
}

function paintDisclosure(row: OutlinerRow, expanded: boolean): void {
  row.discloseBtn?.setAttribute('aria-expanded', String(expanded));
  row.el.classList.toggle('collapsed', !expanded);
  if (row.discloseBtn) row.discloseBtn.title = expanded ? 'Collapse' : 'Expand';
}

function setAllCollapsed(collapse: boolean): void {
  collapsedRows = new Set();
  rows.forEach((row, position) => {
    if (!row.hasChildren) return;
    if (collapse) collapsedRows.add(position);
    paintDisclosure(row, !collapse);
  });
  allCollapsed = collapse;
  applyRowVisibility();
  updateMenus();
}

type CollapseKey = NamedEntry | Model | SceneObject;

/** What a row stands for across a rebuild; a file's own row, which has no entry, as its model. */
function collapseKey(row: OutlinerRow): CollapseKey {
  if (isObjectRow(row)) return row.object;
  return row.fixed ? row.model : row.entry;
}

/** What the collapsed rows stand for. */
function collapsedEntries(): Set<CollapseKey> {
  const entries = new Set<CollapseKey>();
  for (const position of collapsedRows) {
    const row = rows[position];
    if (row) entries.add(collapseKey(row));
  }
  return entries;
}

/** Shuts the freshly built rows that were shut before the rebuild. */
function restoreCollapsed(entries: Set<CollapseKey>): void {
  if (entries.size === 0) return;
  rows.forEach((row, position) => {
    if (!row.hasChildren || !entries.has(collapseKey(row))) return;
    collapsedRows.add(position);
    paintDisclosure(row, false);
  });
}

function replaceAll(): void {
  const find = findInput.value;
  if (find === '') return;
  const replacement = replaceInput.value;

  let replacer: (value: string) => string;
  if (regexToggle.checked) {
    try {
      const pattern = new RegExp(find, 'g');
      replacer = (value) => value.replace(pattern, replacement);
    } catch {
      findInput.classList.add('invalid');
      showFlash('Invalid regular expression');
      return;
    }
  } else {
    replacer = (value) => value.split(find).join(replacement);
  }
  findInput.classList.remove('invalid');

  const undo: { model: Model; entry: NamedEntry; value: string }[] = [];
  const done = new Set<NamedEntry>();
  let clashes = 0;
  for (const row of rows) {
    // Respect the filter; skip the file itself, and the scene's own objects,
    // which no file holds.
    if (isObjectRow(row) || !row.filtered || row.fixed) continue;
    // The same entry can own several rows; replacing twice would compound.
    if (done.has(row.entry)) continue;
    done.add(row.entry);

    const current = row.input.value;
    const next = replacer(current);
    if (next === current) continue;
    // Replacing across a whole file is the easiest way to collide two material
    // names, so the ones that would are left alone and counted.
    if (materialNameClash(row.model, row.entry, next)) {
      clashes++;
      continue;
    }
    undo.push({ model: row.model, entry: row.entry, value: current });
    setEntryName(row.entry, next);
  }
  // Scenes have no rows, so they answer to the filter by their names alone.
  const query = searchInput.value.trim().toLowerCase();
  for (const model of models) {
    for (const scene of model.json.scenes ?? []) {
      const current = getName(scene);
      if (query !== '' && !current.toLowerCase().includes(query)) continue;
      const next = replacer(current);
      if (next === current) continue;
      undo.push({ model, entry: scene, value: current });
      setEntryName(scene, next);
    }
  }
  for (const model of new Set(undo.map((step) => step.model))) noteEdit(model);
  updateFileStats();
  updateMenus();
  const skipped =
    clashes > 0
      ? ` — ${clashes} material${clashes === 1 ? '' : 's'} left alone, the name is taken`
      : '';
  showFlash(
    undo.length > 0
      ? `Replaced in ${undo.length} name${undo.length === 1 ? '' : 's'} — Ctrl+Z to undo${skipped}`
      : clashes > 0
        ? `No name changed${skipped}`
        : 'No matches',
  );
}

/**
 * The one Download — the button, File → Download and Ctrl+S alike. The file as
 * it is, unless the Download panel asks for a re-encode, which it then runs.
 */
async function exportModel(model: Model | null = activeModel): Promise<void> {
  if (!model) return;
  if (compression?.active(model)) {
    await compression.download(model);
    return;
  }
  const { isGlb, addedImages } = model;
  try {
    // Trims are ranges while the file is edited; the download gets them as keyframes.
    const { json, chunks } = await withBakedTrims(model);
    let blob: Blob;
    if (isGlb) {
      // A .glb is meant to be one file, so images added from disk are folded
      // into it rather than left pointing at the user's own folders.
      const embedded = embedGlbImages(json, chunks, await readAddedImages(model));
      blob = buildGlb(embedded.json, embedded.chunks);
    } else {
      blob = new Blob([JSON.stringify(json, null, model.wasPretty ? 2 : undefined)], {
        type: 'model/gltf+json',
      });
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exportBaseName(model)}.${isGlb ? 'glb' : 'gltf'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // A .gltf keeps its references, so added images stay separate files.
    if (!isGlb && addedImages.size > 0) {
      const names = [...addedImages.keys()]
        .map((index) => json.images?.[index]?.uri)
        .filter((uri): uri is string => typeof uri === 'string');
      showFlash(
        `Save the added image${names.length === 1 ? '' : 's'} next to the .gltf: ${names.join(', ')}`,
      );
    }
  } catch (error) {
    showFlash(`Export failed: ${messageOf(error)}`);
  }
}

/**
 * The document and chunks to download, with every trim written as keyframes.
 * The keyframes have to be read first: from the .glb's binary chunk, from an
 * embedded buffer, or from a .bin the user supplied.
 */
async function withBakedTrims(model: Model): Promise<{ json: GltfJson; chunks: GlbChunk[] }> {
  const { json, glbChunks } = model;
  if (!hasTrims(json)) return { json, chunks: glbChunks };
  const binAt = model.isGlb ? glbChunks.findIndex((chunk) => chunk.type === CHUNK_BIN) : -1;
  const bin = binAt >= 0 && json.buffers?.[0]?.uri === undefined ? glbChunks[binAt].data : null;

  const bytes = new Map<number, Uint8Array>();
  const lookup = buildResourceLookup(model.resources);
  for (const index of trimmedBuffers(json)) {
    const uri = json.buffers?.[index]?.uri;
    if (uri === undefined) {
      if (index === 0 && bin) bytes.set(0, bin);
    } else if (uri.startsWith('data:')) {
      bytes.set(index, new Uint8Array(await (await fetch(uri)).arrayBuffer()));
    } else {
      const file = resolveResource(lookup, uri);
      if (file) bytes.set(index, new Uint8Array(await file.arrayBuffer()));
    }
  }

  // Keyframes packed with meshopt (gltfpack's output) are unpacked to be read,
  // with the same decoder the preview uses.
  const unpacked = new Map<number, Uint8Array>();
  const packed = meshoptViews(json).filter((view) => bytes.has(view.buffer));
  if (packed.length > 0) {
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    await MeshoptDecoder.ready;
    for (const view of packed) {
      const source = bytes.get(view.buffer)!.subarray(view.byteOffset, view.byteOffset + view.byteLength);
      unpacked.set(
        view.view,
        await MeshoptDecoder.decodeGltfBufferAsync(view.count, view.byteStride, source, view.mode, view.filter),
      );
    }
  }

  const baked = bakeTrims(json, (index) => bytes.get(index) ?? null, bin, unpacked);
  const chunks =
    baked.bin === null
      ? glbChunks
      : glbChunks.map((chunk, index) => (index === binAt ? { type: chunk.type, data: baked.bin! } : chunk));
  return { json: baked.json, chunks };
}

/** The name a download goes out under: the file's own, extension aside. */
function exportBaseName(model: Model): string {
  return model.fileName.replace(/\.(glb|gltf)$/i, '') || 'model';
}

/**
 * Whether anything other than a name has changed, which the preview must show.
 * A trim is not among them: the preview plays it without being given the edited
 * document.
 */
function hasStructuralEdits(model: Model): boolean {
  return (
    model.mapEdits > 0 ||
    model.editedMaterials.size > 0 ||
    model.movedNodes.size > 0 ||
    model.shadowEdits.size > 0 ||
    model.morphedMeshes.size > 0 ||
    model.deletedCount > 0 ||
    model.copiedAnimations > 0
  );
}

/** Bytes for the images the user added, read only when they are exported. */
async function readAddedImages(model: Model): Promise<Map<number, ImageBytes>> {
  const bytes = new Map<number, ImageBytes>();
  for (const [index, file] of model.addedImages) {
    bytes.set(index, { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: mimeTypeOf(file) });
  }
  return bytes;
}

function mimeTypeOf(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    ktx2: 'image/ktx2',
  };
  return known[extension] ?? 'application/octet-stream';
}

function resetAll(model: Model | null = activeModel): void {
  if (!model) return;
  for (const [entry, entryRows] of rowsByEntry) {
    if (entryRows[0].model === model) setEntryName(entry, entryRows[0].original);
  }
  for (const entry of rowlessEntries(model)) {
    const kept = model.originalNames?.get(entry);
    if (kept) setEntryName(entry, kept.name);
  }
  noteEdit(model);
  updateMenus();
  showFlash(models.length > 1 ? `All names in ${model.fileName} reset` : 'All names reset');
}

/**
 * Puts the whole file back the way it was opened: names, transforms, texture
 * bindings, and the images that were added along with them. Every other open
 * file is left as it is.
 *
 * The pristine bytes are kept for the preview anyway, so re-parsing them is
 * both the shortest way to undo every kind of edit and the only one that
 * cannot miss one — a new kind of edit needs nothing added here.
 */
function resetModel(model: Model | null = activeModel): void {
  if (!model) return;
  const edited = model.json;
  if (
    modifiedCount(model) === 0 &&
    !hasStructuralEdits(model) &&
    !hasTrims(model.json) &&
    model.addedImages.size === 0
  ) {
    showFlash('Nothing to reset');
    return;
  }

  let pristine: GltfJson;
  let chunks: GlbChunk[];
  try {
    if (model.isGlb) {
      if (!model.sourceBuffer) throw new Error('the original file bytes are no longer available');
      const parsed = parseGlb(model.sourceBuffer);
      pristine = parsed.json;
      chunks = parsed.otherChunks;
    } else {
      if (!model.sourceText) throw new Error('the original file text is no longer available');
      pristine = parseGltfText(model.sourceText);
      chunks = [];
    }
  } catch (error) {
    // Nothing has been touched yet, so the document is still the edited one.
    showFlash(`Could not reset: ${messageOf(error)}`);
    return;
  }

  // An image added from disk goes with the edit that brought it in, and so does
  // the file standing in for its URI — but only when it is still that same
  // file, since a sidecar of the user's own may have taken the path over.
  for (const [index, file] of model.addedImages) {
    const uri = edited.images?.[index]?.uri;
    if (uri !== undefined && model.resources.get(uri) === file) model.resources.delete(uri);
  }
  model.addedImages = new Map();
  releaseImageUrls(model);

  // Deletes renumbered the document, so the selection and whatever is hidden
  // follow their entries back to the numbering the file itself uses.
  const { origins } = model;
  if (origins.nodes) viewer?.renumber(model.id, 'node', origins.nodes);
  if (origins.meshes) viewer?.renumber(model.id, 'mesh', origins.meshes);
  if (selection?.model === model.id) selection = inFileNumbering(model, selection);

  model.json = pristine;
  model.glbChunks = chunks;
  // The document is the file again, so every row's original is its own name —
  // and the rows still standing describe the edited one, so none are kept.
  model.originalNames = null;
  rows = rows.filter((row) => isObjectRow(row) || row.model !== model);
  model.mapEdits = 0;
  model.editedMaterials = new Set();
  model.movedNodes = new Map();
  model.shadowEdits = new Map();
  model.morphedMeshes = new Set();
  model.deletedCount = 0;
  model.copiedAnimations = 0;
  model.origins = {};
  if (propTransform?.model === model) propTransform = null;
  if (pendingSlot?.model === model) pendingSlot = null;
  model.sceneIndex = sceneIndexFor(pristine, model.sceneIndex);

  // Scene names are back to the file's, and the picker shows them.
  updateSceneSelect();
  buildEditor();
  noteEdit(model);
  // The added images belong to the stored file record, not the document one.
  void saveSourceRecord(model);
  // Materials and transforms are only in the scene the preview built, so it has
  // to be rebuilt — from the pristine bytes now, which is what it prefers.
  void startViewer(model, { keepView: true });
  showFlash(
    models.length > 1 ? `${model.fileName} reset to how it was opened` : 'Model reset to how it was opened',
  );
}

/**
 * Closes one file. The others stay open, and in the scene — and so does a scene
 * that has been worked on for its own sake, once the last of them has gone.
 */
function closeModel(model: Model | null = activeModel): void {
  if (!model) return;
  if (models.length <= 1 && !sceneStarted) {
    clearScene();
    return;
  }
  const at = models.indexOf(model);
  if (at < 0) return;
  models.splice(at, 1);

  // Whatever load of it is still running must not write into the rows.
  model.preview.token++;
  model.preview.pending = null;
  viewer?.unload(model.id);
  releaseImageUrls(model);
  forgetModelRecord(model);
  forgetHistoryOf(model);
  if (pendingSlot?.model === model) pendingSlot = null;
  if (propTransform?.model === model) propTransform = null;
  if (selection?.model === model.id) selection = null;
  // Its rows are about to go, and there is nothing of theirs worth keeping.
  rows = rows.filter((row) => isObjectRow(row) || row.model !== model);

  activeModel = models[Math.min(at, models.length - 1)] ?? null;
  renderActiveModel();
  buildEditor();
  refreshOverlay();
  updateStatus();
  showFlash(`Closed ${model.fileName}`);
}

/**
 * Closes every file, and the scene with them: what comes next starts from a new
 * scene, lit the way a new one is — the three.js editor's File → New.
 */
function closeAll(): void {
  // Closing everything gives up keeping it: the next thing stored is either the
  // file being opened right now, or nothing at all.
  forgetSession();
  sessionBroken = false;
  // The other scenes go with it; the one on show stays, emptied, under its name.
  const kept = activeScene();
  sceneList = [{ id: kept.id, name: kept.name, shelved: null }];
  setGridVisible(true);
  resetWorkspace();
  renderSceneBar();
}

/**
 * File → Close all: every file in the scene on show, and the scene's own
 * objects, while the other scenes stay as they are. With no other scene, it is
 * everything.
 */
function clearScene(): void {
  if (sceneList.length <= 1) {
    closeAll();
    return;
  }
  for (const model of models) forgetModelData(model);
  resetWorkspace();
  saveSceneList();
  markSession(sessionLabel());
  showFlash(`Cleared ${activeScene().name}`);
}

/** Stops keeping a model that is going for good, without the view write closing one does. */
function forgetModelData(model: Model): void {
  dirtyDocs.delete(model);
  if (sessionOn && !sessionBroken) void forgetModel(model.id);
}

/**
 * Takes down everything the scene on show has — its models, objects, preview
 * and per-scene UI — leaving the app the way a new scene starts. What is kept
 * across reloads is not touched: the caller either forgets it or shelves it.
 */
function resetWorkspace(): void {
  viewer?.dispose();
  viewer = null;
  viewerReady = null;
  // Invalidate any load still in flight so it cannot write into the new file.
  viewerEpoch++;
  for (const model of models) {
    model.preview.token++;
    model.preview.pending = null;
    // A load still running never reaches its own cleanup now, and a shelved
    // model has to be loadable again when its scene comes back.
    model.preview.busy = false;
    model.preview.quiet = false;
    model.preview.problem = null;
    releaseImageUrls(model);
  }
  models = [];
  activeModel = null;
  restoring = false;
  rows = [];
  rowsByEntry = new Map();
  rowsByTarget = new Map();
  asideLabels = new Map();
  noteGroups = [];
  collapsedRows = new Set();
  allCollapsed = false;
  collapsedFolders = new Set();
  clearFileSelection();
  pendingView = null;
  propTransform = null;
  pendingSlot = null;
  selection = null;
  extraPicks = [];
  selectAnchor = null;
  sceneRootEl = null;
  sceneSelected = false;
  sceneCollapsed = false;
  sceneObjects = defaultSceneObjects();
  environment = { ...DEFAULT_ENVIRONMENT };
  shadows = { ...DEFAULT_SHADOWS };
  sceneStarted = false;
  pickedObject = null;
  propObject = null;
  closeAddMenu();
  viewport.classList.remove('busy');
  outlinerEl.textContent = '';
  flash.textContent = '';
  flash.hidden = true;
  clearTimeout(flashTimer);
  // Per-file UI state must not bleed into the next file.
  searchInput.value = '';
  findInput.value = '';
  replaceInput.value = '';
  findInput.classList.remove('invalid');
  isolateBtn.hidden = true;
  showAllBtn.hidden = true;
  propSignature = '';
  renderProperties();
  renderActiveModel();
  setOverlay(null);
  dropzone.hidden = false;
  toolbar.hidden = true;
  viewportInfo.hidden = true;
  updateStatus();
  fileInput.value = '';
  folderInput.value = '';
  outlinerEl.append(emptyState(EMPTY_OUTLINER));
  // What is on show now is the empty scene, with nothing to undo.
  resetHistory();
  updateMenus();
}

function emptyState(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Undo and redo
//
// Every change is undoable the same way: before it, the state it changes is
// kept — a model's document with everything the app knows about its edits, or
// the scene's own objects and lighting — and Ctrl+Z puts that back. Nothing
// has to know how to reverse itself, so a rename, a material slider, a delete
// and a reset all come back alike.
//
// What each change starts from is a checkpoint: the state as the last step left
// it. A change opens a step holding the checkpoints of what it touches; changes
// following within a moment join it — a name typed, a gizmo dragged, a slider
// pulled are one step each — and once things go quiet the checkpoints move on
// to the state now on show.

/** A model's document and every record of its edits, as they were at one moment. */
interface ModelState {
  json: GltfJson;
  mapEdits: number;
  editedMaterials: number[];
  movedNodes: [number, NodeTransformKeys][];
  shadowEdits: [number, ShadowFlags][];
  morphedMeshes: number[];
  deletedCount: number;
  copiedAnimations: number;
  origins: Origins;
  /** The files themselves are not copied: a File never changes. */
  addedImages: [number, File][];
  placement: NodeTrs | null;
}

/** The scene's own objects and how it is lit, as they were at one moment. */
interface SceneState {
  objects: SceneObject[];
  environment: EnvironmentSettings;
  shadows: ShadowSettings;
  started: boolean;
}

/** One undoable change: the state of what it touched, from before it. */
interface HistoryStep {
  models: Map<Model, ModelState>;
  scene: SceneState | null;
  /** Selected when the change was made, and selected again when it is undone. */
  selection: SelectionItem[];
}

interface History {
  undo: HistoryStep[];
  redo: HistoryStep[];
}

/** Steps kept per scene; the oldest go first. */
const MAX_HISTORY = 100;
/** How long changes keep joining the step before it is closed. */
const HISTORY_SETTLE_MS = 600;

let history: History = { undo: [], redo: [] };
/** Each model's state as the last step left it. Shelved models keep theirs. */
const checkpoints = new WeakMap<Model, ModelState>();
let sceneCheckpoint: SceneState | null = null;
/** The step changes are still joining, if one is. */
let openStep: HistoryStep | null = null;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while a step is being put back, or the state set up wholesale, so none of it is recorded. */
let historyPaused = false;

function captureModel(model: Model): ModelState {
  return {
    json: structuredClone(model.json),
    mapEdits: model.mapEdits,
    editedMaterials: [...model.editedMaterials],
    movedNodes: structuredClone([...model.movedNodes]),
    shadowEdits: structuredClone([...model.shadowEdits]),
    morphedMeshes: [...model.morphedMeshes],
    deletedCount: model.deletedCount,
    copiedAnimations: model.copiedAnimations,
    origins: structuredClone(model.origins),
    addedImages: [...model.addedImages],
    placement: model.placement ? structuredClone(model.placement) : null,
  };
}

function captureScene(): SceneState {
  return structuredClone({ objects: sceneObjects, environment, shadows, started: sceneStarted });
}

/** Starts the history over from what is on show: a new scene, a restore, an import. */
function resetHistory(kept: History = { undo: [], redo: [] }): void {
  clearTimeout(settleTimer);
  settleTimer = undefined;
  openStep = null;
  history = kept;
  for (const model of models) checkpoints.set(model, captureModel(model));
  sceneCheckpoint = captureScene();
}

/** Models just opened start their history here: undo never goes back past the file. */
function checkpointModels(opened: Model[]): void {
  for (const model of opened) checkpoints.set(model, captureModel(model));
}

/**
 * The step the change being made belongs to. A change that clears the
 * selection on its way, the way a delete does, opens it first, so that undoing
 * it selects again what was selected.
 */
function beginHistoryStep(): HistoryStep | null {
  if (historyPaused) return null;
  if (!openStep) {
    openStep = { models: new Map(), scene: null, selection: allPicks() };
    history.undo.push(openStep);
    if (history.undo.length > MAX_HISTORY) history.undo.shift();
    history.redo = [];
  }
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settleHistory, HISTORY_SETTLE_MS);
  return openStep;
}

/** A model's document, or where it sits, was just changed. */
function recordModelEdit(model: Model): void {
  const step = beginHistoryStep();
  if (!step || step.models.has(model)) return;
  // A model with no checkpoint can only have come in some way that skipped
  // one; what it is now is the best there is.
  step.models.set(model, checkpoints.get(model) ?? captureModel(model));
  updateMenus();
}

/** The scene's own objects or its lighting were just changed. */
function recordSceneEdit(): void {
  const step = beginHistoryStep();
  if (!step || step.scene) return;
  step.scene = sceneCheckpoint ?? captureScene();
  updateMenus();
}

/** Closes the open step: what follows is a change of its own. */
function settleHistory(): void {
  clearTimeout(settleTimer);
  settleTimer = undefined;
  const step = openStep;
  if (!step) return;
  openStep = null;
  if (step.models.size === 0 && step.scene === null) {
    // Opened by a change that came to nothing, such as a delete that was refused.
    history.undo = history.undo.filter((other) => other !== step);
    updateMenus();
    return;
  }
  for (const model of step.models.keys()) {
    if (models.includes(model)) checkpoints.set(model, captureModel(model));
  }
  if (step.scene) sceneCheckpoint = captureScene();
}

function canUndo(): boolean {
  return openStep !== null || history.undo.length > 0;
}

function undo(): void {
  releaseEditingField();
  settleHistory();
  const step = history.undo.pop();
  if (!step) {
    showFlash('Nothing to undo');
    return;
  }
  history.redo.push(applyHistoryStep(step));
  showFlash(`Undone — ${redoKeyLabel()} to redo`);
}

function redo(): void {
  releaseEditingField();
  settleHistory();
  const step = history.redo.pop();
  if (!step) {
    showFlash('Nothing to redo');
    return;
  }
  history.undo.push(applyHistoryStep(step));
  showFlash('Redone');
}

/**
 * A name or number still being typed commits as it loses the keyboard. That
 * has to happen first, into the step about to be undone — not later, when the
 * rebuild takes its field away, as a change of its own after the undo.
 */
function releaseEditingField(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && sidebar.contains(active) && !ownsTextUndo(active)) active.blur();
}

function redoKeyLabel(): string {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⇧⌘Z' : 'Ctrl+Y';
}

/** Puts back what a step holds, and returns the step that would put back what is on show now. */
function applyHistoryStep(step: HistoryStep): HistoryStep {
  const back: HistoryStep = { models: new Map(), scene: null, selection: allPicks() };
  historyPaused = true;
  try {
    for (const [model, state] of step.models) {
      // A model closed since has nothing to come back to.
      if (!models.includes(model)) continue;
      back.models.set(model, captureModel(model));
      restoreModelState(model, state);
      // Nothing changes a step once it is out of the history, so it can be the checkpoint as it is.
      checkpoints.set(model, state);
    }
    if (step.scene) {
      back.scene = captureScene();
      restoreSceneState(step.scene);
      sceneCheckpoint = step.scene;
    }
    buildEditor();
    const live = step.selection.flatMap((pick) => livePick(pick) ?? []);
    selectPicks(live[0] ?? null, live.slice(1));
  } finally {
    historyPaused = false;
  }
  updateMenus();
  return back;
}

/** A model back as a step had it: its document, its edit records, and the preview to match. */
function restoreModelState(model: Model, state: ModelState): void {
  const before = model.json;
  const live = structuredClone(state);
  model.json = live.json;
  model.mapEdits = live.mapEdits;
  model.editedMaterials = new Set(live.editedMaterials);
  model.movedNodes = new Map(live.movedNodes);
  model.shadowEdits = new Map(live.shadowEdits);
  model.morphedMeshes = new Set(live.morphedMeshes);
  model.deletedCount = live.deletedCount;
  model.copiedAnimations = live.copiedAnimations;
  model.origins = live.origins;
  const imagesChanged =
    state.addedImages.length !== model.addedImages.size ||
    state.addedImages.some(([index, file]) => model.addedImages.get(index) !== file);
  model.addedImages = new Map(state.addedImages);
  // A reset since may have let go of the file standing in for an added image's URI.
  for (const [index, file] of model.addedImages) {
    const uri = model.json.images?.[index]?.uri;
    if (uri !== undefined && !model.resources.has(uri)) model.resources.set(uri, file);
  }
  releaseImageUrls(model);
  model.placement = live.placement;
  viewer?.setModelPlacement(model.id, model.placement);

  // The names the file gave each entry are paired with the entries of this
  // document now, the way a restored session pairs them; the rows standing
  // describe the other one, so none of theirs are kept.
  const pristine = pristineJson(model);
  model.originalNames = pristine ? captureOriginals(pristine, model.json, model.origins) : null;
  rows = rows.filter((row) => isObjectRow(row) || row.model !== model);
  model.sceneIndex = sceneIndexFor(model.json, model.sceneIndex);
  updateSceneSelect();
  const clips = model.json.animations?.length ?? 0;
  if (model.preview.clip >= clips) model.preview.clip = Math.max(0, clips - 1);
  if (pendingSlot?.model === model) pendingSlot = null;
  if (propTransform?.model === model) propTransform = null;

  if (sameApartFromLiveEdits(before, model.json)) {
    // Only names, transforms and morph weights differ: the preview moves what
    // moved, blends what was blended, and keeps everything else as it is drawn.
    (model.json.nodes ?? []).forEach((node, index) => {
      const old = before.nodes?.[index];
      if (!old) return;
      const trs = readNodeTransform(node);
      const was = readNodeTransform(old);
      const moved = (['translation', 'rotation', 'scale'] as const).some((part) =>
        trs[part].some((value, axis) => value !== was[part][axis]),
      );
      if (moved) viewer?.setNodeTransform(model.id, index, trs as NodeTrs);

      // The same mesh either way, or the documents would not have matched.
      const mesh = node.mesh === undefined ? undefined : model.json.meshes?.[node.mesh];
      const oldMesh = node.mesh === undefined ? undefined : before.meshes?.[node.mesh];
      if (!mesh || !oldMesh || morphTargetCount(mesh) === 0) return;
      const weights = readWeights(node, mesh);
      const previous = readWeights(old, oldMesh);
      if (weights.some((value, target) => value !== previous[target])) {
        viewer?.setMorphWeights(model.id, index, weights);
      }
    });
  } else {
    if (JSON.stringify(before.animations ?? []) !== JSON.stringify(model.json.animations ?? [])) {
      viewer?.stopAnimation(model.id);
    }
    void startViewer(model, { keepView: true });
  }
  noteEdit(model);
  scheduleViewSave();
  if (imagesChanged) void saveSourceRecord(model);
}

/**
 * Whether two documents differ only in names, in where nodes are and in how
 * meshes are morphed — which the preview can follow without being rebuilt.
 * Anything else, a node's other fields included, means a rebuild.
 */
function sameApartFromLiveEdits(a: GltfJson, b: GltfJson): boolean {
  const nodeKeys = new Set(['translation', 'rotation', 'scale', 'matrix', 'weights']);
  const meshKeys = new Set(['weights']);
  const without = (entry: object, keys: Set<string>): object =>
    Object.fromEntries(Object.entries(entry).filter(([key]) => !keys.has(key)));
  const shape = (json: GltfJson): string =>
    JSON.stringify(
      {
        ...json,
        nodes: (json.nodes ?? []).map((node) => without(node, nodeKeys)),
        meshes: (json.meshes ?? []).map((mesh) => without(mesh, meshKeys)),
      },
      (key, value: unknown) => (key === 'name' ? undefined : value),
    );
  return shape(a) === shape(b);
}

/** The scene's own objects and lighting back as a step had them. */
function restoreSceneState(state: SceneState): void {
  const live = structuredClone(state);
  sceneObjects = live.objects;
  environment = live.environment;
  shadows = live.shadows;
  // A scene that has been worked on stays one: its viewport does not close under it.
  sceneStarted = sceneStarted || live.started;
  if (pickedObject !== null && !objectById(pickedObject)) pickedObject = null;
  viewer?.syncObjects(sceneObjects);
  viewer?.setEnvironment(environment);
  viewer?.setShadows(shadows);
  keepScene();
}

/** The document the model's file holds, as opened; null when its bytes are gone. */
function pristineJson(model: Model): GltfJson | null {
  try {
    if (model.isGlb) return model.sourceBuffer ? parseGlb(model.sourceBuffer).json : null;
    return model.sourceText !== null ? parseGltfText(model.sourceText) : null;
  } catch {
    return null;
  }
}

/** A closed model leaves the history: its part of every step goes, and steps left with nothing go too. */
function forgetHistoryOf(model: Model): void {
  checkpoints.delete(model);
  const keep = (step: HistoryStep): boolean => {
    step.models.delete(model);
    return step === openStep || step.models.size > 0 || step.scene !== null;
  };
  history.undo = history.undo.filter(keep);
  history.redo = history.redo.filter(keep);
}

// ---------------------------------------------------------------------------
// Scenes
//
// Several scenes can be worked on, one at a time: each has models, objects and
// lighting of its own, and switching shelves the one on show — as it is, edits
// and all — and puts the other back. The preview only ever holds the one.

function activeScene(): SceneEntry {
  return sceneList.find((entry) => entry.id === activeSceneId) ?? sceneList[0];
}

/** Whether a shelved scene has anything in it worth bringing back. */
function shelfHasWork(shelved: NonNullable<SceneEntry['shelved']>): boolean {
  return shelved.models.length > 0 || shelved.view?.scene?.started === true;
}

/** Whether the scene on show is still the empty one a new scene starts as. */
function sceneIsEmpty(): boolean {
  return models.length === 0 && !sceneStarted;
}

function nextSceneId(): number {
  return sceneList.reduce((highest, entry) => Math.max(highest, entry.id), 0) + 1;
}

/** A name no other scene has: the one asked for, or it with the next free number after it. */
function uniqueSceneName(base: string, except?: SceneEntry): string {
  const taken = new Set(sceneList.filter((entry) => entry !== except).map((entry) => entry.name));
  if (!taken.has(base)) return base;
  const numbered = /^(.*?) (\d+)$/.exec(base);
  const stem = numbered ? numbered[1] : base;
  let count = numbered ? Number(numbered[2]) + 1 : 2;
  while (taken.has(`${stem} ${count}`)) count++;
  return `${stem} ${count}`;
}

/** The scene list as the session keeps it: the scene on show has its view in the `view` record. */
function scenesRecord(): ScenesRecord {
  return {
    active: activeSceneId,
    list: sceneList.map((entry) => ({
      id: entry.id,
      name: entry.name,
      view: entry.shelved?.view ?? null,
    })),
  };
}

/** A stored scene list made sense of; a session from before there were scenes has the one. */
function restoreSceneList(record: ScenesRecord | null): {
  active: number;
  entries: ScenesRecord['list'];
} {
  const seen = new Set<number>();
  const entries = (record?.list ?? []).filter((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    if (!Number.isInteger(entry.id) || seen.has(entry.id) || typeof entry.name !== 'string') return false;
    seen.add(entry.id);
    return true;
  });
  if (entries.length === 0) {
    return { active: 1, entries: [{ id: 1, name: FIRST_SCENE_NAME, view: null }] };
  }
  const active = record && seen.has(record.active) ? record.active : entries[0].id;
  return {
    active,
    entries: entries.map((entry) => ({
      id: entry.id,
      name: entry.name.trim() || FIRST_SCENE_NAME,
      // The scene on show has its view in the `view` record instead.
      view: entry.id !== active && entry.view && Array.isArray(entry.view.scenes) ? entry.view : null,
    })),
  };
}

/** Writes the scene list, and the view of the scene on show with it. */
function saveSceneList(): void {
  if (!sessionOn || sessionBroken) return;
  // This write has the view in it, so one still on its timer is redundant.
  clearTimeout(viewSaveTimer);
  viewSaveTimer = undefined;
  void writeRecord(() => saveScenes(scenesRecord(), viewRecord()));
}

/** Puts the scene on show away as it is, leaving the workspace empty. */
function shelveScene(): void {
  // Edits still on their timer belong to models that are about to stop being
  // the ones on show, which is what lets them be written.
  flushDocs();
  closeSceneRename(false);
  settleHistory();
  activeScene().shelved = { models: [...models], view: viewRecord(), history };
  resetWorkspace();
}

/** Brings a shelved scene back on show, into an empty workspace. */
function unshelveScene(entry: SceneEntry): void {
  const shelved = entry.shelved;
  entry.shelved = null;
  activeSceneId = entry.id;
  enterScene(shelved?.models ?? [], shelved?.view ?? null, shelved?.history);
}

function switchScene(id: number): void {
  const target = sceneList.find((entry) => entry.id === id);
  if (!target || target.id === activeSceneId) {
    renderSceneBar();
    return;
  }
  shelveScene();
  unshelveScene(target);
  saveSceneList();
  markSession(sessionLabel());
  renderSceneBar();
}

/** Shelves the scene on show and puts a new, empty one in its place. */
function createScene(name: string): SceneEntry {
  shelveScene();
  const entry: SceneEntry = { id: nextSceneId(), name: uniqueSceneName(name), shelved: null };
  sceneList.push(entry);
  activeSceneId = entry.id;
  renderSceneBar();
  return entry;
}

/** The scene picker's "+", and File → New scene. */
function newScene(): void {
  const entry = createScene(`Scene ${sceneList.length + 1}`);
  // It starts the way the app does, at the dropzone: models are what a scene
  // is mostly made of, and its default lights are there once one is in.
  renderActiveModel();
  updateMenus();
  saveSceneList();
  markSession(sessionLabel());
  showFlash(`Created ${entry.name} — drop models in, or add objects with +`);
}

function renameScene(name: string): void {
  const entry = activeScene();
  const trimmed = name.trim();
  if (trimmed !== '' && trimmed !== entry.name) {
    entry.name = uniqueSceneName(trimmed, entry);
    saveSceneList();
    markSession(sessionLabel());
  }
  renderSceneBar();
}

/** Deletes the scene on show, models and all, and shows the one beside it. */
function deleteScene(): void {
  if (sceneList.length <= 1) return;
  const entry = activeScene();
  if (
    !sceneIsEmpty() &&
    !window.confirm(
      `Delete “${entry.name}”? Its ${plural(models.length, 'model')} and objects go with it — download any edits you want to keep first.`,
    )
  ) {
    return;
  }
  closeSceneRename(false);
  for (const model of models) forgetModelData(model);
  resetWorkspace();
  const at = sceneList.indexOf(entry);
  sceneList.splice(at, 1);
  unshelveScene(sceneList[Math.min(at, sceneList.length - 1)]);
  saveSceneList();
  markSession(sessionLabel());
  renderSceneBar();
  showFlash(`Deleted ${entry.name}`);
}

/** The scene picker above the tabs, the Scene row and the menubar, after the list or a name changed. */
function renderSceneBar(): void {
  sceneSwitch.textContent = '';
  for (const entry of sceneList) {
    const option = document.createElement('option');
    option.value = String(entry.id);
    option.textContent = entry.name;
    sceneSwitch.append(option);
  }
  sceneSwitch.value = String(activeSceneId);
  const name = activeScene().name;
  sceneSwitch.title = `Working in ${name} — pick another scene to switch to it`;
  sceneDeleteBtn.disabled = sceneList.length <= 1;
  sceneDeleteBtn.title =
    sceneList.length <= 1 ? 'The only scene cannot be deleted' : `Delete ${name}, and the models in it`;

  const label = sceneRootEl?.querySelector('.row-label');
  if (label) label.textContent = name;
  for (const field of propertiesEl.querySelectorAll<HTMLInputElement>('input.scene-name-field')) {
    if (field !== document.activeElement) field.value = name;
  }
  paintMenubarFile();
  updateMenus();
}

function beginSceneRename(): void {
  sceneNameInput.value = activeScene().name;
  sceneSwitch.hidden = true;
  sceneNameInput.hidden = false;
  sceneNameInput.focus();
  sceneNameInput.select();
}

/** Ends a rename typed above the tabs, keeping what was typed or not. */
function closeSceneRename(commit: boolean): void {
  if (sceneNameInput.hidden) return;
  // Hidden first: hiding the focused field blurs it, which ends the rename again.
  sceneNameInput.hidden = true;
  sceneSwitch.hidden = false;
  if (commit) renameScene(sceneNameInput.value);
}

// ---------------------------------------------------------------------------
// Session (kept across reloads)

/** Starts keeping newly opened files, alongside whatever is kept already. */
function keepModels(opened: Model[]): void {
  // The first file of a fresh start replaces whatever was kept — a session a
  // restore was still reading back when the file was dropped, say. Storage runs
  // in order, so the clear lands before the writes below.
  if (!sessionOn) void clearSession();
  sessionOn = true;
  markSession(sessionLabel());
  for (const model of opened) {
    void saveSourceRecord(model);
    void saveDocRecord(model);
  }
  // With the scene list, since the view now claims these models for the scene on show.
  saveSceneList();
}

/** What "Restoring …" names on the next load: the files being kept, or else the scene. */
function sessionLabel(): string | null {
  const kept = models.filter((model) => !model.unkept);
  const own =
    kept.length === 0
      ? sceneStarted
        ? 'the scene'
        : null
      : kept.length === 1
        ? kept[0].fileName
        : `${kept[0].fileName} and ${kept.length - 1} more`;
  if (sceneList.length <= 1) return own;
  // The scene on show can be empty while another one is worth bringing back.
  const others = sceneList.some((entry) => entry.shelved !== null && shelfHasWork(entry.shelved));
  return own !== null || others ? `${sceneList.length} scenes` : null;
}

/**
 * Keeps the scene's own objects with the session. They are written with the
 * view, so a scene with models in it is kept already; one with none starts a
 * session of its own here.
 */
function keepScene(): void {
  if (!sessionOn) {
    // A fresh start, the way the first file of one is: whatever was kept goes.
    void clearSession();
    sessionOn = true;
    sessionBroken = false;
    markSession(sessionLabel());
    // The scene list is kept from the start, so the scenes made before anything
    // was worth keeping come back too.
    saveSceneList();
    return;
  }
  if (!sessionBroken) markSession(sessionLabel());
  scheduleViewSave();
}

/** Stops keeping the session, and throws away what was kept. */
function forgetSession(): void {
  clearTimeout(docSaveTimer);
  clearTimeout(viewSaveTimer);
  docSaveTimer = undefined;
  viewSaveTimer = undefined;
  dirtyDocs = new Set();
  sessionOn = false;
  markSession(null);
  void clearSession();
}

/** Stops keeping one closed file, while the others go on being kept. */
function forgetModelRecord(model: Model): void {
  dirtyDocs.delete(model);
  if (!sessionOn || sessionBroken) return;
  void forgetModel(model.id);
  markSession(sessionLabel());
  scheduleViewSave();
}

function isKept(model: Model): boolean {
  return sessionOn && !sessionBroken && !model.unkept && models.includes(model);
}

function scheduleDocSave(model: Model): void {
  if (!isKept(model)) return;
  dirtyDocs.add(model);
  clearTimeout(docSaveTimer);
  // Typing a name is a burst of edits, and the document can be megabytes: one
  // write per pause in the typing is plenty.
  docSaveTimer = setTimeout(flushDocs, 600);
}

/** Writes every document edited since the last write. */
function flushDocs(): void {
  clearTimeout(docSaveTimer);
  docSaveTimer = undefined;
  const dirty = [...dirtyDocs];
  dirtyDocs = new Set();
  for (const model of dirty) void saveDocRecord(model);
}

function scheduleViewSave(): void {
  if (!sessionOn || sessionBroken) return;
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => void saveViewRecord(), 600);
}

/** Writes whatever is still on a timer, for a tab that may not come back. */
function flushSession(): void {
  if (docSaveTimer !== undefined) flushDocs();
  if (viewSaveTimer !== undefined) {
    clearTimeout(viewSaveTimer);
    viewSaveTimer = undefined;
    void saveViewRecord();
  }
}

async function saveSourceRecord(model: Model): Promise<void> {
  if (!isKept(model)) return;
  const source = model.isGlb ? model.sourceBuffer : model.sourceText;
  if (source === null) return;

  const record: SourceRecord = {
    stamp: model.id,
    fileName: model.fileName,
    sceneName: model.sceneName ?? undefined,
    filePath: model.path,
    fileSize: model.size,
    isGlb: model.isGlb,
    wasPretty: model.wasPretty,
    source,
    resources: [...model.resources].map(([path, file]) => ({ path, file })),
    addedImages: [...model.addedImages].map(([index, file]) => ({ index, file })),
  };
  if (sourceSize(record) > MAX_SESSION_BYTES) {
    // Writing hundreds of megabytes on every open would cost more time than the
    // restore is worth, and the browser would likely refuse it anyway. The
    // other files go on being kept; this one alone is lost to a reload.
    model.unkept = true;
    dirtyDocs.delete(model);
    void forgetModel(model.id);
    markSession(sessionLabel());
    showFlash(
      `${model.fileName} is too large to keep across a reload — download it before you leave.`,
    );
    return;
  }
  await writeRecord(() => saveSource(record));
}

async function saveDocRecord(model: Model): Promise<void> {
  if (!isKept(model)) return;
  await writeRecord(() =>
    saveDoc({
      stamp: model.id,
      json: model.json,
      mapEdits: model.mapEdits,
      materials: [...model.editedMaterials],
      movedNodes: [...model.movedNodes].map(([index, original]) => ({ index, original })),
      shadows: [...model.shadowEdits].map(([index, original]) => ({ index, original })),
      morphs: [...model.morphedMeshes],
      deleted: model.deletedCount,
      copied: model.copiedAnimations,
      origins: model.origins,
    }),
  );
}

async function saveViewRecord(): Promise<void> {
  if (!sessionOn || sessionBroken) return;
  await writeRecord(() => saveView(viewRecord()));
}

/** Everything about the scene on show that is in no document. */
function viewRecord(): ViewRecord {
  return {
    active: activeModel?.id ?? null,
    scenes: models.map((model) => ({ model: model.id, index: model.sceneIndex })),
    placements: models.flatMap((model) =>
      model.placement ? [{ model: model.id, trs: model.placement }] : [],
    ),
    tab: sidebarTab,
    gridVisible,
    selection,
    object: pickedObject,
    scene: { objects: sceneObjects, environment, shadows, started: sceneStarted },
    // Before every model is back up, the camera worth keeping is the one
    // still waiting to be applied.
    camera: (restoring ? pendingView : null) ?? viewer?.view() ?? pendingView,
    gizmo: { mode: gizmoMode, space: gizmoSpace, enabled: gizmoEnabled },
  };
}

async function writeRecord(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    breakSession(
      isQuotaError(error)
        ? 'No room left to keep these files across a reload — download before you leave.'
        : 'This browser will not keep the files across a reload — download before you leave.',
    );
  }
}

/** Gives up on keeping the session, says so once, and re-arms the exit warning. */
function breakSession(message: string): void {
  if (sessionBroken) return;
  sessionBroken = true;
  markSession(null);
  void clearSession();
  showFlash(message);
}

/**
 * Brings back the files the last session had open, the way the three.js editor
 * brings back its scene. Runs on startup, before anything else is open.
 */
async function restoreSession(): Promise<void> {
  const name = storedSessionName();
  if (name === null || models.length > 0 || sceneStarted) return;

  // Reading a big file back takes long enough that the dropzone would flash
  // first, which reads as "nothing was kept".
  dropzone.hidden = true;
  setOverlay(`Restoring ${name}…`);

  let stored: Session | null = null;
  try {
    stored = await loadSession();
  } catch {
    stored = null;
  }
  // A file dropped (or an object added) while the read was running has already
  // started a session of its own, and must not be replaced by the old one.
  if (models.length > 0 || sceneStarted) return;
  if (!stored) {
    // The marker outlived the data: storage cleared, or a half-written session.
    markSession(null);
    void clearSession();
    dropzone.hidden = false;
    setOverlay(null);
    return;
  }

  try {
    applySession(stored);
  } catch (error) {
    // Never leave a session behind that cannot be read: it would fail again on
    // every load. closeAll() is what drops it.
    closeAll();
    showError(`Could not bring back ${name}: ${messageOf(error)}`);
  }
}

function applySession({ models: stored, view, scenes }: Session): void {
  // Which scene each model is in: a shelved scene's view lists its own, and
  // whatever none of them claims is in the scene on show.
  const { active, entries } = restoreSceneList(scenes);
  const sceneOf = new Map<number, number>();
  for (const entry of entries) {
    if (entry.id === active) continue;
    for (const { model } of entry.view?.scenes ?? []) sceneOf.set(model, entry.id);
  }
  const viewOf = (sceneId: number | undefined): ViewRecord | null =>
    sceneId === undefined ? view : (entries.find((entry) => entry.id === sceneId)?.view ?? null);

  const restored = new Map<number | undefined, Model[]>();
  const failed: string[] = [];
  for (const record of stored) {
    const sceneId = sceneOf.get(record.source.stamp);
    try {
      const model = restoreModel(record, viewOf(sceneId));
      restored.set(sceneId, [...(restored.get(sceneId) ?? []), model]);
    } catch (error) {
      failed.push(`${record.source.fileName}: ${messageOf(error)}`);
      // It would fail the same way on every load, so it is not kept.
      void forgetModel(record.source.stamp);
    }
  }
  const all = [...restored.values()].flat();
  const shown = restored.get(undefined) ?? [];
  const started = view?.scene?.started === true && restoreSceneObjects(view.scene.objects) !== null;
  const others = entries.filter((entry) => entry.id !== active);
  if (all.length === 0 && !started && !others.some((entry) => entry.view?.scene?.started === true)) {
    throw new Error(failed.join('; ') || 'nothing was kept');
  }

  sceneList = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    shelved:
      entry.id === active
        ? null
        : { models: restored.get(entry.id) ?? [], view: entry.view, history: { undo: [], redo: [] } },
  }));
  activeSceneId = active;
  lastModelId = Math.max(lastModelId, ...all.map((model) => model.id));
  sessionOn = true;
  sessionBroken = false;

  if (view) {
    setGridVisible(view.gridVisible !== false);
    if (view.gizmo) {
      setGizmoMode(view.gizmo.mode);
      setGizmoSpace(view.gizmo.space);
      setGizmoEnabled(view.gizmo.enabled);
    }
  }
  const tab = view?.tab ?? '';
  setTab(isSidebarTab(tab) ? tab : 'scene');
  enterScene(shown, view);
  markSession(sessionLabel());
  renderSceneBar();

  let changes = 0;
  for (const model of all) {
    changes +=
      modifiedCount(model) +
      model.mapEdits +
      model.editedMaterials.size +
      model.movedNodes.size +
      model.shadowEdits.size +
      model.morphedMeshes.size +
      model.deletedCount +
      model.copiedAnimations +
      trimmedCount(model);
  }
  const names = sessionLabel() ?? all[0]?.fileName ?? 'the scene';
  showFlash(
    changes > 0
      ? `Restored ${names} — ${changes} change${changes === 1 ? '' : 's'} not downloaded yet`
      : `Restored ${names}`,
  );
  if (failed.length > 0) showError(`Could not bring back ${failed.join('; ')}`);
}

/**
 * Puts a scene on show: its models, its own objects and lighting, and the view
 * it was left at. The workspace is expected to be empty, as a reset leaves it.
 */
function enterScene(entering: Model[], view: ViewRecord | null, kept?: History): void {
  // The scene's own objects come back with the view. A record from before the
  // scene had any keeps the new scene's lights.
  const scene = view?.scene;
  const objects = restoreSceneObjects(scene?.objects);
  sceneObjects = objects ?? defaultSceneObjects();
  environment = restoreEnvironment(scene?.environment);
  shadows = restoreShadows(scene?.shadows);
  sceneStarted = scene?.started === true && objects !== null;
  models = entering;
  activeModel = modelById(view?.active ?? undefined) ?? models[0] ?? null;
  // Applied once the preview has something to look at.
  pendingView = view?.camera ?? null;
  // Ctrl+Z goes back as far as the scene had got when it was put away, and no further.
  resetHistory(kept);

  renderActiveModel();
  if (models.length === 0 && !sceneStarted) {
    // Nothing in it yet: the dropzone, the way a new start looks — which a
    // restore, having covered it with its message, has to put back.
    dropzone.hidden = false;
    setOverlay(null);
    updateMenus();
    return;
  }
  buildEditor();
  dropzone.hidden = true;
  toolbar.hidden = false;
  viewportInfo.hidden = false;
  if (view?.selection && modelById(view.selection.model)) {
    selectTarget(view.selection, { scroll: true });
  } else if (typeof view?.object === 'number' && objectById(view.object)) {
    selectObject(view.object, { scroll: true });
  }
  // Every model's load puts the stored camera back once the last one is in; a
  // scene with no model in it has no load to wait for.
  restoring = models.length > 0;
  for (const model of models) void startViewer(model);
  if (models.length === 0) showScene();
  updateMenus();
}

/** One kept file, back as the model it was, edits and all. */
function restoreModel({ source, doc }: StoredModel, view: ViewRecord | null): Model {
  const json = doc.json;
  if (typeof json !== 'object' || json === null) {
    throw new Error('the stored document is unreadable');
  }
  assertGltf2(json);

  // The pristine source is parsed as well as kept: it is where the names the
  // file itself carried come from, so a restored rename is still a rename, with
  // something to revert to.
  let pristine: GltfJson;
  let glbChunks: GlbChunk[] = [];
  let sourceBuffer: ArrayBuffer | null = null;
  let sourceText: string | null = null;
  if (source.isGlb) {
    if (!(source.source instanceof ArrayBuffer)) throw new Error('the stored file is unreadable');
    const parsed = parseGlb(source.source);
    pristine = parsed.json;
    glbChunks = parsed.otherChunks;
    sourceBuffer = source.source;
  } else {
    if (typeof source.source !== 'string') throw new Error('the stored file is unreadable');
    pristine = parseGltfText(source.source);
    sourceText = source.source;
  }

  const model = createModel({
    id: source.stamp,
    fileName: source.fileName,
    // Records from an earlier build know only the name; the bytes still give the
    // size back for a .glb, and a .gltf simply shows no size for this one file.
    path: source.filePath ?? source.fileName,
    size: source.fileSize ?? (source.source instanceof ArrayBuffer ? source.source.byteLength : -1),
    json,
    glbChunks,
    isGlb: source.isGlb,
    sourceBuffer,
    sourceText,
    wasPretty: source.wasPretty,
    // Records from an earlier build of the app can be missing pieces this one
    // expects; none of them is worth refusing the restore over.
    resources: new Map((source.resources ?? []).map(({ path, file }) => [path, file])),
  });
  model.sceneName = typeof source.sceneName === 'string' ? source.sceneName : null;
  // Read before the originals are paired, since a delete moved the indices
  // they are paired by.
  model.origins = doc.origins ?? {};
  model.deletedCount = doc.deleted ?? 0;
  model.copiedAnimations = doc.copied ?? 0;
  model.originalNames = captureOriginals(pristine, json, model.origins);
  model.addedImages = new Map((source.addedImages ?? []).map(({ index, file }) => [index, file]));
  model.mapEdits = doc.mapEdits ?? 0;
  model.editedMaterials = new Set(doc.materials ?? []);
  model.movedNodes = new Map((doc.movedNodes ?? []).map(({ index, original }) => [index, original]));
  model.shadowEdits = new Map(
    (doc.shadows ?? []).flatMap(({ index, original }) =>
      isShadowFlags(original) ? [[index, original] as [number, ShadowFlags]] : [],
    ),
  );
  model.morphedMeshes = new Set(doc.morphs ?? []);
  const scene = view?.scenes?.find((entry) => entry.model === model.id)?.index;
  model.sceneIndex = sceneIndexFor(json, scene);
  const placement = view?.placements?.find((entry) => entry.model === model.id)?.trs;
  model.placement = placement && isStoredTrs(placement) ? placement : null;
  return model;
}

/** A stored placement is only put back when it still reads as one. */
function isStoredTrs(trs: NodeTrs): boolean {
  const numbers = (value: unknown, length: number) =>
    Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  return numbers(trs.translation, 3) && numbers(trs.rotation, 4) && numbers(trs.scale, 3);
}

/**
 * Pairs every entry in the restored document with the name the file gave it, by
 * walking both documents category by category — following the renumbering of
 * any delete. Entries the user added have no counterpart there, and are their
 * own original.
 */
function captureOriginals(
  pristine: GltfJson,
  edited: GltfJson,
  renumbered: Origins,
): Map<NamedEntry, { name: string; had: boolean }> {
  const originals = new Map<NamedEntry, { name: string; had: boolean }>();
  for (const category of CATEGORIES) {
    const before = category.list(pristine);
    const from = category.collection ? renumbered[category.collection] : undefined;
    category.list(edited).forEach((entry, index) => {
      const original = before[from?.[index] ?? index];
      if (!original) return;
      originals.set(entry, { name: getName(original), had: typeof original.name === 'string' });
    });
  }
  return originals;
}

function isSidebarTab(value: string): value is SidebarTab {
  return (SIDEBAR_TABS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 3D preview

/**
 * The one viewer every model is drawn in. Made on the first load, and shared by
 * however many start at once — two made side by side would each own a canvas.
 */
function ensureViewer(): Promise<Viewer> {
  if (viewerReady) return viewerReady;
  const epoch = viewerEpoch;
  viewerReady = import('./viewer').then(({ Viewer }) => {
    // Close all ran while three.js was still arriving: nothing is left to show.
    if (epoch !== viewerEpoch) throw new Error('Preview was closed while loading.');
    const created = new Viewer(viewport, {
      onPick: (ref) => selectTarget(ref, { scroll: true }),
      onRender: () => {
        updateStatus();
        // Rendering is on demand, so this fires when the view has moved —
        // which is exactly when the stored camera is out of date.
        scheduleViewSave();
      },
      onTransform: (model, node, trs) => applyGizmoTransform(model, node, trs),
      onPlace: (model, trs) => applyGizmoPlacement(model, trs),
      onPickObject: (id) => selectObject(id, { scroll: true }),
      onObjectTransform: (id, trs) => applyGizmoObjectTransform(id, trs),
      // Fires every frame a clip plays; the Animations tab shows only the active model's.
      onAnimation: (model) => {
        if (model === activeModel?.id) paintPlayback();
      },
    });
    created.setGridVisible(gridVisible);
    created.setGizmoMode(gizmoMode);
    created.setGizmoSpace(gizmoSpace);
    created.setGizmoEnabled(gizmoEnabled);
    created.setAnimationLoop(animationLoop);
    created.setAnimationSpeed(animationSpeed);
    created.setAnimationReverse(animationReverse);
    // The scene is lit before the first model is in it, by its own lights.
    created.setEnvironment(environment);
    created.setShadows(shadows);
    created.syncObjects(sceneObjects);
    if (pickedObject !== null) created.selectObject(pickedObject);
    created.setExtraSelection(...extraParts());
    viewer = created;
    return created;
  });
  // A failed import can be tried again by the next load.
  viewerReady.catch(() => {
    if (epoch === viewerEpoch) viewerReady = null;
  });
  return viewerReady;
}

/** (Re)loads one model into the preview. Every other model stays as it is. */
async function startViewer(model: Model, options: ViewerOptions = {}): Promise<void> {
  if (!models.includes(model)) return;
  const preview = model.preview;
  if (preview.busy) {
    // Coalesce rather than drop: the caller (scene switch, added files) would
    // otherwise believe its request was applied.
    preview.pending = options;
    return;
  }
  preview.busy = true;
  preview.quiet = options.quiet === true;
  preview.problem = null;
  const token = ++preview.token;
  refreshOverlay();

  try {
    const missing = missingBuffers(model);
    if (missing.length > 0) {
      // What was drawn before came from the files that are gone, so it goes too.
      viewer?.unload(model.id);
      preview.problem = {
        message: 'The preview needs this model’s data file to draw anything. Renaming works without it.',
        missing,
        pickers: true,
      };
      return;
    }

    const current = await ensureViewer();
    if (token !== preview.token) return;
    const result = await current.load(model.id, {
      source: await buildViewerSource(model),
      resources: model.resources,
      imageUris: listExternalResources(model.json).images,
      compression: detectCompression(model.json),
      // A reload bringing several models back keeps the camera through each of
      // them; the view that was stored goes back once they are all in.
      keepView: options.keepView === true || restoring,
      placement: model.placement,
      // Trims stay in the document; the preview plays them as ranges.
      clipRanges: (model.json.animations ?? []).map(getTrim),
    });
    // A newer load (or a Close) started while this one was running.
    if (token !== preview.token) return;

    for (const row of rows) {
      if (isObjectRow(row) || row.model !== model) continue;
      if (!row.target) {
        // The root stands for the whole model, which is on screen now.
        if (row.locateBtn) row.locateBtn.hidden = false;
        if (row.eyeBtn) row.eyeBtn.hidden = false;
        continue;
      }
      const present = result.renderable[row.target.kind].has(row.target.index);
      if (row.locateBtn) row.locateBtn.hidden = !present;
      if (row.eyeBtn) row.eyeBtn.hidden = !present;
      const geometryless = row.target.kind === 'node' && result.geometryless.has(row.target.index);
      row.el.classList.toggle('no-geometry', geometryless);
      if (geometryless && row.locateBtn) {
        row.locateBtn.title = 'No geometry — frames where it sits';
      }
    }
    // A restored session frames the model first and then puts the camera back,
    // so a load that fails still ends up looking at something.
    if (pendingView) current.setView(pendingView);
    refreshVisibilityState();
    updateStatus();
    // The scene is new, so the selection box and gizmo have to be re-attached.
    if (pickedObject !== null) current.selectObject(pickedObject);
    else current.select(selection);
    current.setExtraSelection(...extraParts());
    updateMoveButtons();
    updateMenus();
    if (!propertiesEl.contains(document.activeElement)) rebuildProperties();

    // The viewport works in this case, so never cover it with a blocking
    // overlay — say it in a toast instead.
    const whose = models.length > 1 ? `${model.fileName}: ` : '';
    if (result.warnings.length > 0) showFlash(whose + result.warnings.join(' '));
    if (result.substitutedImages.length > 0) {
      const count = result.substitutedImages.length;
      showFlash(
        `${whose}${count} texture${count === 1 ? '' : 's'} not supplied — showing placeholders. Drop the image files in to see them.`,
      );
    }
  } catch (error) {
    if (token === preview.token) {
      const missing = missingBuffers(model);
      preview.problem = { message: previewErrorMessage(error), missing: [], pickers: missing.length > 0 };
    }
  } finally {
    if (token === preview.token) {
      preview.busy = false;
      preview.quiet = false;
      reportProblem(model);
      // Its clips came back with it — or went, when it could not be drawn.
      if (model === activeModel) renderPlayback();
    }
    // Deferred: a load that stops before its first await would otherwise finish
    // the restore before the next model's load has even been started.
    queueMicrotask(finishRestoring);
    refreshOverlay();
    if (preview.pending && models.includes(model)) {
      const next = preview.pending;
      preview.pending = null;
      void startViewer(model, next);
    }
  }
}

/**
 * A model that could not be drawn while others are on screen gets a toast, since
 * the overlay only ever covers a viewport that has nothing else to show.
 */
function reportProblem(model: Model): void {
  const problem = model.preview.problem;
  if (!problem || !models.some((other) => other !== model && viewer?.hasModel(other.id))) return;
  showFlash(
    problem.missing.length > 0
      ? `${model.fileName} is not shown: it needs ${problem.missing.join(', ')} — add it on the Files tab`
      : `${model.fileName}: ${problem.message}`,
  );
}

/** The last model a reload brings back puts the stored camera back on all of them. */
function finishRestoring(): void {
  if (!restoring || models.some((model) => model.preview.busy)) return;
  restoring = false;
  if (pendingView) viewer?.setView(pendingView);
  else viewer?.frameAll();
  pendingView = null;
}

/**
 * The preview always parses pristine bytes/text, never the live document:
 * GLTFLoader writes `isBone`/`isSkinnedMesh` into the node and mesh defs it is
 * given, and those would be serialised into the user's download.
 */
async function buildViewerSource(model: Model): Promise<ArrayBuffer | string> {
  const { json, sceneIndex, sourceBuffer, sourceText } = model;
  const sceneCount = json.scenes?.length ?? 0;

  // Material edits have to reach the preview, so once anything beyond names has
  // changed the live document is what gets loaded — as a deep copy, for the
  // same reason the pristine bytes are used otherwise.
  if (hasStructuralEdits(model)) {
    const single = withSingleScene(structuredClone(json), sceneIndex);
    return model.isGlb ? buildGlb(single, model.glbChunks).arrayBuffer() : JSON.stringify(single);
  }

  if (model.isGlb) {
    if (!sourceBuffer) throw new Error('The original file bytes are no longer available.');
    if (sceneCount <= 1) return sourceBuffer;
    const pristine = parseGlb(sourceBuffer);
    const single = withSingleScene(pristine.json, sceneIndex);
    return buildGlb(single, pristine.otherChunks).arrayBuffer();
  }
  if (!sourceText) throw new Error('The original file text is no longer available.');
  if (sceneCount <= 1) return sourceText;
  return JSON.stringify(withSingleScene(parseGltfText(sourceText), sceneIndex));
}

function missingBuffers(model: Model): string[] {
  const { buffers } = listExternalResources(model.json);
  return findMissing(buffers, buildResourceLookup(model.resources));
}

function previewErrorMessage(error: unknown): string {
  const message = messageOf(error);
  if (/dracoloader/i.test(message)) {
    return 'This model uses Draco compression and the decoder could not be loaded. Renaming still works.';
  }
  if (/ktx2loader/i.test(message)) {
    return 'This model uses KTX2 textures and the transcoder could not be loaded. Renaming still works.';
  }
  if (/meshopt/i.test(message)) {
    return 'This model uses meshopt compression and the decoder could not be loaded. Renaming still works.';
  }
  return `The preview could not load this model: ${message} Renaming still works.`;
}

/**
 * What covers the viewport, worked out from every model at once. Nothing does
 * while any model is on screen: one still loading, or one that cannot be drawn,
 * is no reason to hide the others. Otherwise it is a load in progress, or else
 * whatever stops the first stuck model from being drawn.
 */
function refreshOverlay(): void {
  const loading = models.filter((model) => model.preview.busy);
  const shown = models.some((model) => viewer?.hasModel(model.id) === true);
  const blocking = loading.some((model) => !model.preview.quiet);
  viewport.classList.toggle('busy', loading.length > 0 && (shown || !blocking));

  if (models.length === 0 || shown) {
    setOverlay(null);
    return;
  }
  if (blocking) {
    setOverlay('Loading preview…');
    return;
  }
  const stuck = loading.length > 0 ? undefined : models.find((model) => model.preview.problem);
  if (!stuck) {
    setOverlay(null);
    return;
  }
  const { message, missing, pickers } = stuck.preview.problem!;
  setOverlay(models.length > 1 ? `${stuck.fileName}: ${message}` : message, { missing, pickers });
}

function setOverlay(
  message: string | null,
  options: { missing?: string[]; pickers?: boolean } = {},
): void {
  if (message === null) {
    viewerOverlay.hidden = true;
    return;
  }
  viewerOverlay.hidden = false;
  viewerMessage.textContent = message;
  viewerActions.hidden = options.pickers !== true;

  const missing = options.missing ?? [];
  missingList.textContent = '';
  missingList.hidden = missing.length === 0;
  for (const uri of missing) {
    const item = document.createElement('li');
    item.textContent = uri;
    missingList.append(item);
  }
}

/**
 * Supplies files to open models: to `target` when one is named (the Files tab's
 * buttons add to the model on show there), and otherwise to every model that
 * refers to any of them — or, when none does, to the active model.
 */
function addResources(picked: PickedFile[], target?: Model): void {
  if (picked.length === 0 || models.length === 0) return;
  const receivers = target && models.includes(target) ? [target] : modelsUsing(picked);
  for (const model of receivers) {
    for (const { path, file } of picked) model.resources.set(path, file);
    // Images shown as placeholders may now have real files behind them.
    releaseImageUrls(model);
    // The preview will need these files again after a reload, so they join the
    // stored session as well.
    void saveSourceRecord(model);
    void startViewer(model, { keepView: true });
  }
  rebuildProperties();
  renderFiles();
  const count = plural(picked.length, 'file');
  showFlash(
    models.length === 1
      ? `Added ${count}`
      : `Added ${count} to ${receivers.length === 1 ? receivers[0].fileName : plural(receivers.length, 'model')}`,
  );
}

/** The models that refer to any of these files, or else the active one. */
function modelsUsing(picked: PickedFile[]): Model[] {
  const lookup = buildResourceLookup(new Map(picked.map(({ path, file }) => [path, file])));
  const using = models.filter((model) => {
    const { buffers, images } = listExternalResources(model.json);
    return [...buffers, ...images].some((uri) => resolveResource(lookup, uri) !== undefined);
  });
  if (using.length > 0) return using;
  return activeModel ? [activeModel] : [];
}

/** The picker lists the active model's scenes, when it has more than one. */
function updateSceneSelect(): void {
  const model = activeModel;
  const scenes = model?.json.scenes ?? [];
  sceneRow.hidden = scenes.length <= 1;
  if (!model || scenes.length <= 1) return;
  sceneSelect.textContent = '';
  scenes.forEach((scene, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = getName(scene) || `Scene ${index}`;
    sceneSelect.append(option);
  });
  sceneSelect.value = String(model.sceneIndex);
}

function setGridVisible(visible: boolean): void {
  gridVisible = visible;
  viewer?.setGridVisible(visible);
  gridBtn.setAttribute('aria-pressed', String(visible));
  gridBtn.classList.toggle('selected', visible);
  updateMenus();
  scheduleViewSave();
}

// ---------------------------------------------------------------------------
// Animation

/**
 * Asks the preview which of the active model's clips it can play, and shows the
 * Animations tab's playback controls only when there is something to play. They
 * are about one model, the way the scene picker is: any other model plays on —
 * or stands still — as it was left.
 */
function renderPlayback(): void {
  const model = activeModel;
  previewClips = model && viewer ? viewer.animations(model.id) : [];
  playbackShows = null;
  playbackPanel.hidden = !canPlay();
  if (model && model.preview.clip >= Math.max(previewClips.length, model.json.animations?.length ?? 0)) {
    model.preview.clip = 0;
  }
  // The tab lists the clips — and names them even with no preview to play them in.
  renderAnimationTab();
  if (!model || !canPlay()) {
    updateMenus();
    return;
  }
  paintPlayback();
}

/** Whether the preview has clips of the active model's to play. */
function canPlay(): boolean {
  return previewClips.length > 0;
}

/**
 * Shows where the active model's playback stands. It runs on every frame a clip
 * plays, so beyond the thumb and the clock it writes only what has changed.
 */
function paintPlayback(): void {
  const model = activeModel;
  if (!model || !canPlay()) return;
  const state = viewer?.playback(model.id) ?? null;
  // A posed model shows the clip posing it; one at rest, the clip picked for it.
  if (state && state.clip !== null) model.preview.clip = state.clip;
  const clip = model.preview.clip;
  const posed = state !== null && state.clip === clip;
  const playing = state?.playing === true;
  const duration = posed ? state.duration : (clipPlayLength(model, clip) ?? 0);
  // At rest the thumb waits where Play will start: the end, in reverse.
  const time = posed ? state.time : animationReverse ? duration : 0;

  if (playbackShows?.playing !== playing || playbackShows.posed !== posed) {
    playbackShows = { playing, posed };
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.title = playing
      ? 'Pause the animation (Space)'
      : animationReverse
        ? 'Play the animation backwards (Space)'
        : 'Play the animation (Space)';
    stopBtn.disabled = !posed;
    updateMenus();
  }
  const max = String(duration);
  if (clipScrubber.max !== max) clipScrubber.max = max;
  // A clip with no length is a single pose: there is nothing to scrub through.
  const still = duration <= 0;
  if (clipScrubber.disabled !== still) clipScrubber.disabled = still;
  // The thumb under the pointer is where the hand holding it put it.
  if (!scrubbing) clipScrubber.value = String(time);
  clipTime.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)} s`;
  paintAnimationTab();
}

/** Plays the active model's picked clip, or pauses it where it is. */
function togglePlayback(): void {
  const model = activeModel;
  if (!viewer || !model || !canPlay()) return;
  if (viewer.playback(model.id)?.playing) viewer.pauseAnimation(model.id);
  else viewer.playAnimation(model.id, model.preview.clip);
  // A posed model has no gizmo, and the move buttons say why.
  updateMoveButtons();
}

/** Stops the active model's clip, which puts it back the way its file poses it. */
function stopPlayback(): void {
  const model = activeModel;
  if (!viewer || !model) return;
  viewer.stopAnimation(model.id);
  updateMoveButtons();
}

/**
 * Another clip takes over: playing on if the last one was, else from rest. With
 * no preview to play it in, it is still the one the Animations tab describes.
 */
function pickClip(clip: number): void {
  const model = activeModel;
  if (!model) return;
  const playing = viewer?.playback(model.id)?.playing === true;
  model.preview.clip = clip;
  if (playing) viewer?.playAnimation(model.id, clip);
  else viewer?.stopAnimation(model.id);
  updateMoveButtons();
  paintAnimationTab();
}

/** A clip's own ▶ in the Animations tab: plays it, or pauses it if it is what is playing. */
function toggleClip(clip: number): void {
  const model = activeModel;
  if (!viewer || !model || !canPlay()) return;
  const state = viewer.playback(model.id);
  if (state?.playing && state.clip === clip) {
    viewer.pauseAnimation(model.id);
  } else {
    model.preview.clip = clip;
    viewer.playAnimation(model.id, clip);
  }
  updateMoveButtons();
}

function setAnimationLoop(loop: boolean): void {
  animationLoop = loop;
  viewer?.setAnimationLoop(loop);
  loopBtn.classList.toggle('selected', loop);
  loopBtn.setAttribute('aria-pressed', String(loop));
}

/** The slowest and fastest a clip plays, as a multiple of its own pace. */
const MIN_SPEED = 0.01;
const MAX_SPEED = 10;

/** How fast every model's clips play; one that is playing carries on at the new pace. */
function setAnimationSpeed(speed: number): void {
  animationSpeed = Math.min(Math.max(Number.isFinite(speed) ? speed : 1, MIN_SPEED), MAX_SPEED);
  viewer?.setAnimationSpeed(animationSpeed);
  // A drag or a typed value past the limits shows the limit it stopped at.
  speedInput.value = formatNumber(animationSpeed);
}

/**
 * Which way every model's clips play. One that is playing turns round where it
 * stands; one at rest starts from its end the next time it plays.
 */
function setAnimationReverse(reverse: boolean): void {
  animationReverse = reverse;
  viewer?.setAnimationReverse(reverse);
  reverseBtn.classList.toggle('selected', reverse);
  reverseBtn.setAttribute('aria-pressed', String(reverse));
  // The Play button's wording and the thumb at rest both follow the direction.
  playbackShows = null;
  paintPlayback();
}

/**
 * Held still, the scrubber holds the pose still: a clip that was playing waits
 * out the drag, and picks up from wherever it was let go.
 */
function beginScrub(): void {
  const model = activeModel;
  if (!viewer || !model || clipScrubber.disabled) return;
  scrubbing?.done.abort();
  const resume = viewer.playback(model.id)?.playing === true;
  if (resume) viewer.pauseAnimation(model.id);
  // The pointer can be let go anywhere, not only over the scrubber.
  const done = new AbortController();
  scrubbing = { model, resume, done };
  for (const type of ['pointerup', 'pointercancel'] as const) {
    window.addEventListener(type, endScrub, { signal: done.signal });
  }
}

function endScrub(): void {
  const scrub = scrubbing;
  scrubbing = null;
  if (!scrub) return;
  scrub.done.abort();
  if (scrub.resume && viewer && models.includes(scrub.model)) {
    viewer.playAnimation(scrub.model.id, scrub.model.preview.clip);
  }
  // The thumb is playback's to move again.
  paintPlayback();
  updateMoveButtons();
}

// ---------------------------------------------------------------------------
// Animations tab
//
// The active model's animations as a list of their own, each under the name its
// document gives it now, with its length and a ▶ of its own. Picking one makes
// it the clip the Playback panel under the list plays, and the panel below that
// renames it.

/**
 * Lists the active model's animations. They come from its document rather than
 * the preview, so a model the preview could not draw still has them to rename.
 */
function renderAnimationTab(): void {
  clipListEl.textContent = '';
  clipRows = [];
  clipShows = null;
  paintAnimationsSummary();
  const model = activeModel;
  const animations = model?.json.animations ?? [];
  if (!model || animations.length === 0) {
    clipListEl.append(emptyState(model ? 'This file has no animations.' : 'No file open.'));
    renderClipPanel();
    return;
  }
  const list = document.createElement('ul');
  animations.forEach((entry, index) => clipRows.push(addClipRow(list, entry, index)));
  clipListEl.append(list);
  paintAnimationTab();
  // A panel kept as it was still has to hear that the preview can play now.
  paintClipTrim();
}

function addClipRow(list: HTMLUListElement, entry: GltfAnimation, index: number): ClipRow {
  const el = document.createElement('li');
  el.className = 'clip-row';
  // Every row is a tab stop, so the keyboard can pick, play and rename them.
  el.tabIndex = 0;

  const indexEl = document.createElement('span');
  indexEl.className = 'row-index';
  indexEl.textContent = String(index);

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'row-btn clip-play';
  play.dataset.action = 'play';

  const main = document.createElement('div');
  main.className = 'clip-main';
  const name = document.createElement('span');
  name.className = 'clip-name';
  main.append(typeIcon('animation'), name);

  const length = document.createElement('span');
  length.className = 'clip-length';

  el.append(indexEl, play, main, length);
  list.append(el);
  const row: ClipRow = { index, entry, el, name, play, length };
  paintClipName(row);
  paintClipLength(row);
  return row;
}

/** How long a row's clip plays for, marked when that is only a stretch of it. */
function paintClipLength(row: ClipRow): void {
  const model = activeModel;
  const plays = model ? clipPlayLength(model, row.index) : null;
  const full = model ? clipFullLength(model, row.index) : null;
  const trimmed = getTrim(row.entry) !== null;
  row.length.textContent = plays === null ? '' : `${plays.toFixed(2)} s`;
  row.el.classList.toggle('trimmed', trimmed);
  row.length.title = trimmed && full !== null ? `Trimmed from ${full.toFixed(2)} s` : '';
}

/**
 * A clip's whole length: the preview's when it has the clip, else what the
 * keyframes' own bounds say — which a model the preview could not draw still has.
 */
function clipFullLength(model: Model, index: number): number | null {
  const shown = model === activeModel ? previewClips[index]?.duration : undefined;
  if (shown !== undefined) return shown;
  const entry = model.json.animations?.[index];
  return entry ? animationLength(model.json, entry) : null;
}

/** How long a clip plays for: its trim, or all of it. */
function clipPlayLength(model: Model, index: number): number | null {
  const entry = model.json.animations?.[index];
  const trim = entry ? getTrim(entry) : null;
  return trim ? trim.end - trim.start : clipFullLength(model, index);
}

/** A row's name, marked when it is not the one the file gave it. */
function paintClipName(row: ClipRow): void {
  const name = getName(row.entry);
  const original = keptOriginal(row.entry)?.name ?? name;
  const modified = name !== original;
  row.name.textContent = name || '(unnamed)';
  row.name.classList.toggle('unnamed', name === '');
  row.el.classList.toggle('modified', modified);
  row.el.title = modified ? `Original: ${original || '(unnamed)'}` : '';
}

/** The tab's read-out: how many animations the active model has, and how many are renamed. */
function paintAnimationsSummary(): void {
  const model = activeModel;
  if (!model) {
    animationsSummary.textContent = '—';
    return;
  }
  const animations = model.json.animations ?? [];
  const parts = [animations.length === 0 ? 'None' : plural(animations.length, 'animation')];
  const renamed = renamedCount(model, animations);
  if (renamed > 0) parts.push(`${renamed} renamed`);
  const trimmed = trimmedCount(model);
  if (trimmed > 0) parts.push(`${trimmed} trimmed`);
  animationsSummary.textContent = parts.join(' · ');
}

/**
 * Marks the picked clip and the one playing. It runs on every frame a clip
 * plays, so the rows are only written when one of those two has changed.
 */
function paintAnimationTab(): void {
  const model = activeModel;
  if (model && clipRows.length > 0) {
    const state = viewer?.playback(model.id) ?? null;
    const clip = model.preview.clip;
    const playing = state?.playing ? state.clip : null;
    if (clipShows?.clip !== clip || clipShows.playing !== playing) {
      clipShows = { clip, playing };
      const playable = canPlay();
      for (const row of clipRows) {
        const on = row.index === playing;
        row.el.classList.toggle('selected', row.index === clip);
        row.el.classList.toggle('playing', on);
        row.play.innerHTML = iconSvg(on ? 'pause' : 'play');
        row.play.disabled = !playable;
        row.play.title = !playable
          ? 'The preview has not drawn this model, so there is nothing to play it in'
          : on
            ? 'Pause'
            : 'Play';
        row.play.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} animation ${row.index}`);
      }
    }
  }
  renderClipPanel();
}

/**
 * The picked animation, under the list: its name to edit, and what it moves.
 * Built only when what it describes changes, and never under the caret.
 */
function renderClipPanel(): void {
  const model = activeModel;
  const clip = model?.preview.clip ?? 0;
  const entry = model?.json.animations?.[clip];
  if (!model || !entry) {
    clipPanelFor = null;
    clipFields = [];
    clipTrim = null;
    clipPanel.textContent = '';
    clipPanel.hidden = true;
    return;
  }
  const duration = clipFullLength(model, clip) ?? undefined;
  const same = clipPanelFor?.model === model && clipPanelFor.entry === entry;
  if (same && (clipPanelFor!.duration === duration || clipPanel.contains(document.activeElement))) return;
  clipPanelFor = { model, entry, duration };
  clipFields = [];
  clipPanel.textContent = '';
  clipPanel.hidden = false;

  const title = document.createElement('h2');
  title.className = 'PanelTitle';
  title.textContent = 'Animation';
  const { nodes, paths } = clipTargets(entry);
  const lengthRow = valueRow('Length', '—', true);
  clipPanel.append(
    title,
    nameRow(model, 'animation', clip, entry, 'Name', clipFields),
    valueRow('Index', String(clip), true),
    lengthRow,
    valueRow('Channels', String(entry.channels?.length ?? 0), true),
    valueRow('Targets', plural(nodes, 'node')),
  );
  if (paths.length > 0) clipPanel.append(valueRow('Animates', paths.join(', ')));

  // Trim: where the clip starts and ends, dragged or typed like any number, or
  // set from wherever playback stands. Whether it can be trimmed at all is
  // worked out on every paint, since the preview arriving can settle it.
  const start = numberField(0, 0.01, 'Trim start, in seconds', (value) => trimClip(model, clip, 'start', value));
  const end = numberField(0, 0.01, 'Trim end, in seconds', (value) => trimClip(model, clip, 'end', value));
  const trimRow = document.createElement('div');
  trimRow.className = 'Row trim-row';
  const trimLabel = document.createElement('span');
  trimLabel.className = 'Label';
  trimLabel.textContent = 'Trim';
  const fields = document.createElement('span');
  fields.className = 'trim-fields';
  const dash = document.createElement('span');
  dash.className = 'trim-sep';
  dash.textContent = '–';
  const unit = document.createElement('span');
  unit.className = 'trim-sep';
  unit.textContent = 's';
  fields.append(start, dash, end, unit);
  trimRow.append(trimLabel, fields);

  const startHere = panelButton('Start here', 'Trim the start to where playback stands now', () =>
    trimAtPlayhead(model, clip, 'start'),
  );
  const endHere = panelButton('End here', 'Trim the end to where playback stands now', () =>
    trimAtPlayhead(model, clip, 'end'),
  );
  const whole = panelButton('Full length', 'Play the whole clip again', () => untrimClip(model, clip));
  const copy = panelButton('Copy', 'Add a copy of this animation — trim it to make a clip out of part of this one', () =>
    copyAnimation(model, clip),
  );
  const remove = panelButton('Delete', 'Delete this animation (Del)', () => deleteAnimation(model, clip));

  const note = document.createElement('p');
  note.className = 'note';
  note.hidden = true;
  clipPanel.append(trimRow, buttonRow([startHere, endHere, whole]), note, buttonRow([copy, remove]));
  clipTrim = {
    model,
    index: clip,
    length: lengthRow.querySelector('.Value')!,
    start,
    end,
    whole,
    here: [startHere, endHere],
    note,
  };
  paintClipTrim();
}

function panelButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'Button';
  button.textContent = text;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

/** A panel row of buttons under the labels, the way the Tools tab lays them out. */
function buttonRow(buttons: HTMLButtonElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  const group = document.createElement('span');
  group.className = 'Buttons';
  group.append(...buttons);
  row.append(spacer, group);
  return row;
}

// ---------------------------------------------------------------------------
// Trimming, copying and deleting animations

/** The shortest a clip can be trimmed to, in seconds. */
const MIN_CLIP_LENGTH = 0.01;
/** A trim this close to the clip's own ends is no trim at that end. */
const TRIM_SNAP = 0.0005;

/** Moves one end of a clip's trim, keeping the other where it is. */
function trimClip(model: Model, index: number, side: 'start' | 'end', value: number): void {
  const entry = model.json.animations?.[index];
  const full = clipFullLength(model, index);
  if (!entry || full === null || !Number.isFinite(value)) return;
  const trim = getTrim(entry) ?? { start: 0, end: full };
  // Typed or dragged, it keeps to the clip and never crosses the other end.
  const next: TrimRange =
    side === 'start'
      ? { start: clamp(round(value), 0, trim.end - MIN_CLIP_LENGTH), end: trim.end }
      : { start: trim.start, end: clamp(round(value), trim.start + MIN_CLIP_LENGTH, full) };
  applyTrim(model, index, next, full);
}

/** Moves one end of the trim to wherever playback of that clip stands now. */
function trimAtPlayhead(model: Model, index: number, side: 'start' | 'end'): void {
  const entry = model.json.animations?.[index];
  const full = clipFullLength(model, index);
  if (!entry || full === null) return;
  const trim = getTrim(entry) ?? { start: 0, end: full };
  const state = viewer?.playback(model.id);
  // At rest, playback stands where Play would start it.
  const local =
    state?.clip === index ? state.time : animationReverse ? trim.end - trim.start : 0;
  trimClip(model, index, side, trim.start + local);
}

function untrimClip(model: Model, index: number): void {
  const full = clipFullLength(model, index);
  if (full !== null) applyTrim(model, index, { start: 0, end: full }, full);
}

/** Keeps a trim on the animation, or none when it covers the whole clip, and plays it. */
function applyTrim(model: Model, index: number, range: TrimRange, full: number): void {
  const entry = model.json.animations?.[index];
  if (!entry) return;
  const start = range.start <= TRIM_SNAP ? 0 : range.start;
  const end = range.end >= full - TRIM_SNAP ? full : range.end;
  const trim = start <= 0 && end >= full ? null : { start, end };
  setTrim(entry, trim);
  viewer?.setClipRange(model.id, index, trim);
  // Written even into a field being typed into: an arrow-key nudge commits
  // while it has focus, and what it shows must be what was kept.
  if (clipTrim?.model === model && clipTrim.index === index) {
    clipTrim.start.value = formatNumber(start);
    clipTrim.end.value = formatNumber(end);
  }
  paintClipTrim();
  const row = clipRows.find((candidate) => candidate.entry === entry);
  if (row) paintClipLength(row);
  paintAnimationsSummary();
  paintPlayback();
  noteEdit(model);
}

/** The panel's trim fields and length, from the document. */
function paintClipTrim(): void {
  const ui = clipTrim;
  const entry = ui?.model.json.animations?.[ui.index];
  if (!ui || !entry) return;
  const full = clipFullLength(ui.model, ui.index);
  const trim = getTrim(entry);
  // A field being typed into keeps what is being typed until it is committed.
  const typing = document.activeElement;
  if (typing !== ui.start) ui.start.value = formatNumber(trim?.start ?? 0);
  if (typing !== ui.end) ui.end.value = formatNumber(trim?.end ?? full ?? 0);
  const plays = clipPlayLength(ui.model, ui.index);
  ui.length.textContent =
    plays === null ? '—' : trim && full !== null ? `${plays.toFixed(2)} s of ${full.toFixed(2)} s` : `${plays.toFixed(2)} s`;

  // Worked out here rather than when the panel was built: the preview arriving
  // is what tells the length of a clip whose file does not say it.
  const blocker =
    trimBlocker(ui.model.json, entry) ??
    (full === null ? 'its length is not known until the preview has drawn it' : null);
  ui.start.disabled = blocker !== null;
  ui.end.disabled = blocker !== null;
  ui.whole.disabled = blocker !== null || trim === null;
  for (const button of ui.here) button.disabled = blocker !== null || !canPlay();
  ui.note.hidden = blocker === null;
  ui.note.textContent = blocker === null ? '' : `This animation can’t be trimmed: ${blocker}.`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Adds a copy of an animation after the others, trim and all. It animates the
 * same nodes from the same keyframes — nothing is duplicated but the entry —
 * until a trim on one of the two makes them differ. Ctrl+Z takes it back.
 */
function copyAnimation(model: Model, index: number): void {
  const entry = model.json.animations?.[index];
  if (!entry) return;
  const copy = structuredClone(entry);
  copy.name = copyName(model, getName(entry) || `Animation ${index}`);
  const at = model.json.animations!.length;
  appendAnimation(model.json, copy);
  // A copy is nothing the file had, so a restored session must not pair it
  // with whichever of the file's own animations sat at its index.
  if (model.origins.animations) {
    const animations = [...model.origins.animations];
    animations[at] = -1;
    model.origins = { ...model.origins, animations };
  }
  model.copiedAnimations++;
  model.preview.clip = at;
  showAnimations(model);
  showFlash(`Copied as "${copy.name}" — Ctrl+Z to undo`);
}

/** "Walk copy", or "Walk copy 2" and on when that is taken. */
function copyName(model: Model, name: string): string {
  const taken = new Set((model.json.animations ?? []).map(getName));
  let candidate = `${name} copy`;
  for (let count = 2; taken.has(candidate); count++) candidate = `${name} copy ${count}`;
  return candidate;
}

/** Deletes an animation from the file. Ctrl+Z brings it back. */
function deleteAnimation(model: Model, index: number): void {
  const entry = model.json.animations?.[index];
  if (!entry) return;
  const label = getName(entry) ? `animation "${getName(entry)}"` : `animation ${index}`;
  const removal = removeAnimation(model.json, index);
  if (!removal) return;
  model.origins = followRenumbering(model.origins, removal.renumbered);
  model.deletedCount++;
  // The one after it takes its place in the list, or the one before at the end.
  const left = model.json.animations?.length ?? 0;
  model.preview.clip = Math.max(0, Math.min(index, left - 1));
  showAnimations(model);
  showFlash(`Deleted ${label} — Ctrl+Z to undo`);
}

/**
 * Shows a model's document after its animations changed. Nothing else is
 * numbered differently, so the selection stays; the preview reloads to play
 * the new list.
 */
function showAnimations(model: Model): void {
  viewer?.stopAnimation(model.id);
  buildEditor();
  noteEdit(model);
  updateMenus();
  void startViewer(model, { keepView: true });
}

/** What an animation's channels point at: how many nodes, and which of their properties. */
function clipTargets(animation: GltfAnimation): { nodes: number; paths: string[] } {
  const nodes = new Set<number>();
  const paths = new Set<string>();
  for (const channel of animation.channels ?? []) {
    if (typeof channel.target?.node === 'number') nodes.add(channel.target.node);
    if (channel.target?.path) paths.add(channel.target.path);
  }
  return { nodes: nodes.size, paths: [...paths] };
}

function clipRowFor(element: Element | null): ClipRow | undefined {
  const li = element?.closest('li.clip-row');
  return li ? clipRows.find((row) => row.el === li) : undefined;
}

/** Picks a row if it is not picked already, and opens the panel's name for editing. */
function renameClip(row: ClipRow): void {
  if (row.index !== activeModel?.preview.clip) pickClip(row.index);
  renderClipPanel();
  const input = clipFields[0]?.input;
  if (!input) return;
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Selection & properties

/** What picking a row selects. A model's root row picks the model as a whole. */
function refFor(row: Row): SelectionRef {
  if (row.target) return refForTarget(row.model, row.target.kind, row.target.index);
  return { model: row.model.id };
}

/**
 * What picking one thing selects. An object carries the mesh data it draws and
 * that mesh's material, and mesh data its material, the way the editor tabs
 * object, geometry and material together.
 */
function refForTarget(model: Model, kind: TargetKind, index: number): SelectionRef {
  const ref: SelectionRef = { model: model.id, [kind]: index };
  return narrowRef(ref) ?? ref;
}

/**
 * How a selection is made. `extras` is what is selected besides it; left out,
 * the selection is this one thing alone, and a Shift+click range starts here.
 */
interface SelectOptions {
  scroll?: boolean;
  extras?: SelectionItem[];
}

function selectTarget(ref: SelectionRef | null, options: SelectOptions = {}): void {
  // Every producer goes through here — a row, a viewport pick, a restored
  // session — so this is where a reference is reduced to the one thing it is.
  ref = narrowRef(ref);
  selection = ref;
  takeExtras(ref ? { ref } : null, options);
  // Whatever is picked now, it is not the scene itself; selectSceneRoot() says
  // so again afterwards when it is. Nor is it one of the scene's own objects.
  sceneSelected = false;
  pickedObject = null;
  paintSceneRoot();
  // The tabs follow the selection into whichever file it is in.
  if (ref) setActiveModel(modelById(ref.model) ?? activeModel);
  viewer?.select(ref);
  showSelection(ref ? rowsForRef(ref) : [], options);
}

/**
 * Picks one of the scene's own objects. It is in no file, so the tabs stay on
 * whichever model they were about.
 */
function selectObject(id: number | null, options: SelectOptions = {}): void {
  const object = objectById(id);
  selection = null;
  sceneSelected = false;
  pickedObject = object?.id ?? null;
  takeExtras(object ? { object: object.id } : null, options);
  paintSceneRoot();
  viewer?.selectObject(pickedObject);
  showSelection(object ? objectRowsFor(object) : [], options);
}

/** What every kind of selection ends with: its rows lit, and the panel and toolbar following it. */
function showSelection(matches: OutlinerRow[], options: { scroll?: boolean }): void {
  for (const row of rows) row.el.classList.remove('selected', 'selected-extra');
  isolateBtn.hidden = selection === null && pickedObject === null;

  for (const pick of extraPicks) {
    for (const row of rowsForPick(pick)) row.el.classList.add('selected', 'selected-extra');
  }
  for (const row of matches) {
    row.el.classList.add('selected');
    row.el.classList.remove('selected-extra');
  }
  viewer?.setExtraSelection(...extraParts());
  paintMultiNote();
  if (matches[0] && options.scroll) {
    // Never steal focus: the user may be typing in another name.
    matches[0].el.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }
  renderProperties();
  updateMoveButtons();
  updateMenus();
  scheduleViewSave();
}

function objectRowsFor(object: SceneObject): ObjectRow[] {
  return rows.filter((row): row is ObjectRow => isObjectRow(row) && row.object === object);
}

// ---------------------------------------------------------------------------
// Selecting several things
//
// Ctrl+click (⌘ on a Mac) adds a row to the selection or takes it out, and
// Shift+click selects every row on screen from the last one clicked to this
// one — Ctrl+Shift adds that run to what is selected already. The one picked
// last stays the selection proper, which the panel and the gizmo show; the
// rest are `extraPicks`, lit in the outliner and boxed in the viewport.

function primaryPick(): SelectionItem | null {
  if (selection) return { ref: selection };
  if (pickedObject !== null) return { object: pickedObject };
  return null;
}

/** Everything selected, the one picked last first. */
function allPicks(): SelectionItem[] {
  const primary = primaryPick();
  return primary ? [primary, ...extraPicks] : [...extraPicks];
}

function pickKey(pick: SelectionItem): string {
  if (pick.object !== undefined) return `object:${pick.object}`;
  const { model, node, mesh, material } = pick.ref;
  return `${model}:${node ?? ''}:${mesh ?? ''}:${material ?? ''}`;
}

/** A pick that still names something, narrowed the way a selection is; null once it is gone. */
function livePick(pick: SelectionItem): SelectionItem | null {
  if (pick.object !== undefined) return objectById(pick.object) ? pick : null;
  const model = modelById(pick.ref.model);
  const { node, mesh, material } = pick.ref;
  if (!model) return null;
  if (node !== undefined && !model.json.nodes?.[node]) return null;
  if (mesh !== undefined && !model.json.meshes?.[mesh]) return null;
  if (material !== undefined && !model.json.materials?.[material]) return null;
  const ref = narrowRef(pick.ref);
  return ref ? { ref } : null;
}

function pickForRow(row: OutlinerRow): SelectionItem {
  return isObjectRow(row) ? { object: row.object.id } : { ref: refFor(row) };
}

function rowsForPick(pick: SelectionItem): OutlinerRow[] {
  if (pick.object === undefined) return rowsForRef(pick.ref);
  const object = objectById(pick.object);
  return object ? objectRowsFor(object) : [];
}

/** Settles what is selected besides `primary`, for `selectTarget` and `selectObject`. */
function takeExtras(primary: SelectionItem | null, options: SelectOptions): void {
  if (options.extras === undefined) {
    // One thing on its own: a range starts from it next time.
    extraPicks = [];
    selectAnchor = primary;
    return;
  }
  const seen = new Set(primary ? [pickKey(primary)] : []);
  extraPicks = options.extras.flatMap((pick) => {
    const live = livePick(pick);
    if (!live || seen.has(pickKey(live))) return [];
    seen.add(pickKey(live));
    return [live];
  });
}

/** Selects `primary`, with `extras` selected beside it. */
function selectPicks(primary: SelectionItem | null, extras: SelectionItem[], options: { scroll?: boolean } = {}): void {
  if (!primary) {
    selectTarget(null, options);
    return;
  }
  if (primary.object !== undefined) selectObject(primary.object, { ...options, extras });
  else selectTarget(primary.ref, { ...options, extras });
}

/** What the viewer boxes besides the selection proper, split by kind. */
function extraParts(): [SelectionRef[], number[]] {
  return splitPicks(extraPicks);
}

function splitPicks(picks: SelectionItem[]): [SelectionRef[], number[]] {
  const refs: SelectionRef[] = [];
  const objects: number[] = [];
  for (const pick of picks) {
    if (pick.object !== undefined) objects.push(pick.object);
    else refs.push(pick.ref);
  }
  return [refs, objects];
}

/**
 * A row clicked with Ctrl or Shift held. Returns false for a plain click, which
 * the row handles the way it always has.
 */
function clickSelect(row: OutlinerRow, position: number, event: MouseEvent): boolean {
  const toggle = event.ctrlKey || event.metaKey;
  if (!toggle && !event.shiftKey) return false;
  const pick = pickForRow(row);
  const key = pickKey(pick);
  const current = allPicks();

  if (event.shiftKey) {
    // The run of rows on screen between the anchor and this one: collapsed and
    // filtered-out rows are not part of it.
    const anchor = selectAnchor ?? primaryPick();
    const anchorRows = anchor ? rowsForPick(anchor) : [];
    const from = anchorRows.length > 0 ? rows.indexOf(anchorRows[0]) : position;
    const [start, end] = from <= position ? [from, position] : [position, from];
    const run = rows.slice(start, end + 1).filter((candidate) => !candidate.el.hidden).map(pickForRow);
    const picks = toggle ? [...current, ...run] : run;
    selectPicks(pick, picks.filter((other) => pickKey(other) !== key));
    return true;
  }

  if (current.some((other) => pickKey(other) === key)) {
    // Taken out: the one picked before it becomes the selection proper.
    const rest = current.filter((other) => pickKey(other) !== key);
    selectPicks(rest[0] ?? null, rest.slice(1));
  } else {
    selectPicks(pick, current);
  }
  selectAnchor = pick;
  return true;
}

/** Above the panel, while several things are selected: which one the panel is showing. */
function paintMultiNote(): void {
  const count = allPicks().length;
  multiNote.hidden = count <= 1;
  if (count > 1) {
    multiNote.textContent = `${count} selected — the panel shows the one picked last. Delete, Isolate and Frame act on all of them.`;
  }
}


/**
 * Delete on several things at once: scene objects, objects and mesh data in
 * any of the open models, and whole models, which are closed. Ctrl+Z takes all
 * of it back in one go.
 */
function deletePicks(picks: SelectionItem[]): void {
  beginHistoryStep();
  const [refs, objectIds] = splitPicks(picks);
  // Everything is about to be renumbered, so nothing stays selected meanwhile.
  selectTarget(null);
  let deleted = 0;
  let skipped = 0;

  // Scene objects, with whatever hangs off them: all at once, as one undo.
  const doomed = new Set<number>();
  for (const id of objectIds) {
    if (!objectById(id)) continue;
    doomed.add(id);
    for (const below of descendantsOf(sceneObjects, id)) doomed.add(below);
  }
  if (doomed.size > 0) {
    const removed = sceneObjects.flatMap((candidate, at) =>
      doomed.has(candidate.id) ? [{ at, object: candidate }] : [],
    );
    sceneObjects = sceneObjects.filter((candidate) => !doomed.has(candidate.id));
    deleted += removed.length;
    viewer?.syncObjects(sceneObjects);
    noteSceneEdit();
  }

  const byModel = new Map<Model, SelectionRef[]>();
  for (const ref of refs) {
    const model = modelById(ref.model);
    if (model) byModel.set(model, [...(byModel.get(model) ?? []), ref]);
  }
  const closing: Model[] = [];
  for (const [model, modelRefs] of byModel) {
    if (modelRefs.some(isWholeModel)) {
      closing.push(model);
      continue;
    }
    const nodes = modelRefs.flatMap((ref) => (ref.node !== undefined ? [ref.node] : []));
    let meshes = modelRefs.flatMap((ref) =>
      ref.node === undefined && ref.mesh !== undefined ? [ref.mesh] : [],
    );
    skipped += modelRefs.filter((ref) => !canDelete(ref)).length;
    let changed = false;

    if (nodes.length > 0) {
      const result = removeFromModel(model, 'node', nodes);
      if (result) {
        renumberPreview(model, result.renumbered);
        // Mesh data only those objects drew may have gone with them.
        meshes = followMeshes(meshes, result.renumbered.meshes);
        deleted += result.nodes;
        changed = true;
      }
    }
    // One mesh at a time, each renumbering the ones still to go.
    while (meshes.length > 0) {
      const mesh = meshes.shift()!;
      const result = removeFromModel(model, 'mesh', [mesh]);
      if (!result) continue;
      renumberPreview(model, result.renumbered);
      meshes = followMeshes(meshes, result.renumbered.meshes);
      deleted++;
      changed = true;
    }
    if (changed) {
      // Rows, the panel and the preview, once for everything that went from it.
      buildEditor();
      noteEdit(model);
      void startViewer(model, { keepView: true });
    }
  }
  if (doomed.size > 0) buildEditor();

  // A whole model is closed, as Delete on its row does — asking first when it has edits.
  for (const model of closing) deleteModel(model);

  if (deleted > 0) {
    const left = skipped > 0 ? ` (${plural(skipped, 'material')} left: only objects and mesh data can be deleted)` : '';
    showFlash(`Deleted ${plural(deleted, 'thing')}${left} — Ctrl+Z to undo`);
  } else if (skipped > 0 && closing.length === 0) {
    showFlash('Only objects and mesh data can be deleted');
  }
}

/** Mesh indices still to delete, after a delete renumbered the meshes; the ones gone with it drop out. */
function followMeshes(meshes: number[], map: number[] | undefined): number[] {
  if (!map) return meshes;
  return meshes.flatMap((mesh) => {
    const to = map[mesh] ?? mesh;
    return to === -1 ? [] : [to];
  });
}

/** A reference that names nothing inside its model: the model as a whole. */
function isWholeModel(ref: SelectionRef): boolean {
  return ref.node === undefined && ref.mesh === undefined && ref.material === undefined;
}

/**
 * A viewport pick resolves to a node, its mesh data and their material at once,
 * since one three.js object is all three. Only the most specific of those is
 * what the user picked, though: clicking geometry picks the node it belongs to,
 * and its mesh data is a row (and a selection) of its own. A reference into a
 * file that is not open any more is no selection at all.
 */
function narrowRef(ref: SelectionRef | null): SelectionRef | null {
  const model = modelById(ref?.model);
  if (!ref || !model) return null;
  const id = model.id;
  // Mesh data comes with a material: the one that was picked out of the ones it
  // uses, or else the first of them.
  const withMaterial = (narrowed: SelectionRef, mesh: number): SelectionRef => {
    const uses = meshMaterials(model.json, mesh);
    const material = ref.material !== undefined && uses.includes(ref.material) ? ref.material : uses[0];
    return material === undefined ? narrowed : { ...narrowed, material };
  };
  if (ref.node !== undefined) {
    // An object comes with what it draws: the mesh its own JSON names, which
    // is what the tabs then show.
    const mesh = model.json.nodes?.[ref.node]?.mesh;
    if (mesh === undefined || !model.json.meshes?.[mesh]) return { model: id, node: ref.node };
    return withMaterial({ model: id, node: ref.node, mesh }, mesh);
  }
  if (ref.mesh !== undefined) return withMaterial({ model: id, mesh: ref.mesh }, ref.mesh);
  if (ref.material !== undefined) return { model: id, material: ref.material };
  // The model itself, which its root row — the scene on show — stands for.
  return { model: id };
}

/** Rows for the most specific part of a reference that has any. */
function rowsForRef(ref: SelectionRef): Row[] {
  const model = modelById(ref.model);
  if (!model) return [];
  for (const kind of ['node', 'mesh', 'material'] as TargetKind[]) {
    const index = ref[kind];
    if (index === undefined) continue;
    const found = rowsByTarget.get(targetKey(model, kind, index));
    if (found && found.length > 0) return found;
  }
  return isWholeModel(ref) ? (rowsByTarget.get(rootKey(model.id)) ?? []) : [];
}

/**
 * One three.js object is usually a node, a mesh and a material at once, so the
 * properties panel tabs them the way the editor tabs object/geometry/material.
 */
function renderProperties(): void {
  const parts: TargetKind[] = [];
  if (selection) {
    for (const kind of ['node', 'mesh', 'material'] as TargetKind[]) {
      // An object's own tab speaks for the mesh it draws, which it names in a
      // row; mesh data gets a tab of its own only when it is what was picked.
      if (kind === 'mesh' && selection.node !== undefined) continue;
      if (selection[kind] !== undefined) parts.push(kind);
    }
  }
  if (parts.length > 0 && !parts.includes(propTab)) propTab = parts[0];
  const model = modelById(selection?.model);
  const whole = model !== undefined && selection !== null && isWholeModel(selection);

  // Which chip beside a row is lit follows the tab, which has just been settled.
  paintAsideSelection();

  const picked = objectById(pickedObject);

  // Rebuilding on every keystroke would blow away the focused field, so the
  // panel is only rebuilt when what it describes actually changes.
  const signature = sceneSelected
    ? `scene:${models.map((open) => open.id).join(',')}:${sceneObjects.length}`
    : picked
      ? `object:${picked.id}`
      : whole
        ? `model:${model.id}:${model.sceneIndex}:${models.length}#${modelTab}`
        : `${model?.id}/` + parts.map((kind) => `${kind}:${selection?.[kind]}`).join('|') + `#${propTab}`;
  if (signature === propSignature) return;
  propSignature = signature;

  propFields = [];
  propToggles = [];
  propTransform = null;
  propObject = null;
  propertiesEl.textContent = '';

  if (sceneSelected || whole || picked) {
    const tabs = document.createElement('div');
    tabs.className = 'Tabs';
    let panel: HTMLElement;
    if (sceneSelected) {
      tabs.append(panelTab('scene', true));
      panel = buildSceneRootPanel();
    } else if (picked) {
      tabs.append(panelTab('object', true));
      panel = buildObjectPanel(picked);
    } else {
      // The shape keys anywhere in the model are gathered in a tab of their own.
      const morphs = morphEntries(model!);
      const showMorphs = morphs.length > 0 && modelTab === 'morphs';
      tabs.append(
        panelTab('model', !showMorphs, () => {
          modelTab = 'model';
          renderProperties();
        }),
      );
      if (morphs.length > 0) {
        tabs.append(
          panelTab('morph targets', showMorphs, () => {
            modelTab = 'morphs';
            renderProperties();
          }),
        );
      }
      panel = showMorphs ? buildMorphPanel(model!, morphs) : buildModelPanel(model!);
    }
    propertiesEl.append(tabs, panel);
    return;
  }

  if (parts.length === 0 || !model) {
    const panel = document.createElement('div');
    panel.className = 'Panel';
    const note = document.createElement('p');
    note.className = 'note';
    note.style.margin = '0';
    note.textContent =
      models.length > 0 || sceneStarted
        ? 'Nothing selected. Click an object in the viewport, or a name in the outliner.'
        : 'No file open.';
    panel.append(note);
    propertiesEl.append(panel);
    return;
  }

  const tabs = document.createElement('div');
  tabs.className = 'Tabs';
  for (const kind of parts) {
    tabs.append(
      panelTab(kind, kind === propTab, () => {
        propTab = kind;
        renderProperties();
      }),
    );
  }
  propertiesEl.append(tabs, buildPropertyPanel(model, propTab, selection![propTab]!));
}

/** One of the panel's tabs; one that can be switched to says so by answering a click. */
function panelTab(text: string, selected: boolean, onClick?: () => void): HTMLElement {
  const tab = document.createElement('span');
  tab.className = `Tab${selected ? ' selected' : ''}`;
  tab.textContent = text;
  if (onClick) tab.addEventListener('click', onClick);
  return tab;
}

function buildPropertyPanel(model: Model, kind: TargetKind, index: number): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'Panel';
  const json = model.json;

  const entry = entryFor(model, kind, index);
  // Which of the mesh's materials is being shown comes first: it says what the
  // rest of the panel is about.
  if (kind === 'material' && selection?.mesh !== undefined) {
    const uses = meshMaterials(json, selection.mesh);
    if (uses.length > 1) panel.append(materialSlotRow(model, selection.node, selection.mesh, index, uses));
  }
  // The editor leads with a material's type, since it decides every row below.
  const material = kind === 'material' ? json.materials?.[index] : undefined;
  if (material) panel.append(materialTypeRow(model, index, material));
  panel.append(nameRow(model, kind, index, entry));
  panel.append(valueRow('Index', String(index), true));

  if (kind === 'node') {
    const node = json.nodes?.[index];
    panel.append(valueRow('Type', nodeTypeLabel(model, index)));
    panel.append(valueRow('Children', String(node?.children?.length ?? 0), true));
    if (node?.mesh !== undefined) panel.append(linkRow(model, 'Mesh', 'mesh', node.mesh));
    if (node) for (const row of transformRows(model, index, node)) panel.append(row);
    // The editor's Shadow row: only what draws something can throw or take one.
    if (node?.mesh !== undefined) panel.append(nodeShadowRow(model, index));
    // The object's tab speaks for the mesh it draws, its shape keys included.
    const morphs = node?.mesh !== undefined ? morphSection(model, index, node.mesh) : null;
    if (morphs) panel.append(morphs);
  } else if (kind === 'mesh') {
    const mesh = json.meshes?.[index];
    panel.append(valueRow('Primitives', String(mesh?.primitives?.length ?? 0), true));
    // Mesh data has no transform of its own — only the nodes using it do — so
    // this says where it actually ended up instead.
    const placement = viewer?.placementOf({ model: model.id, mesh: index });
    if (placement) {
      if (placement.instances > 1) {
        panel.append(valueRow('Instances', String(placement.instances), true));
      }
      panel.append(valueRow('World origin', placement.origin.map(formatNumber).join(', ')));
      panel.append(valueRow('Size', placement.size.map(formatNumber).join(', ')));
    }
    const morphs = morphSection(model, undefined, index);
    if (morphs) panel.append(morphs);
  } else if (material) {
    panel.append(...materialRows(model, index, material));
  }

  if (kind !== 'material') panel.append(visibleRow(model, kind, index));

  const actions = document.createElement('div');
  actions.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  const buttons = document.createElement('span');
  buttons.className = 'Buttons';

  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'Button';
  frame.textContent = 'Frame';
  frame.disabled = viewer === null;
  frame.addEventListener('click', () => {
    if (selection) viewer?.frame(selection);
  });

  const isolate = document.createElement('button');
  isolate.type = 'button';
  isolate.className = 'Button';
  isolate.textContent = 'Isolate';
  isolate.disabled = viewer === null;
  isolate.addEventListener('click', () => {
    if (!viewer || !selection) return;
    viewer.isolate(selection);
    refreshVisibilityState();
  });

  buttons.append(frame, isolate);
  // Kept as a button as well as the Delete key, since a control nobody can see
  // is a control nobody uses.
  if (kind !== 'material') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'Button';
    remove.textContent = 'Delete';
    remove.title =
      kind === 'node'
        ? 'Delete this object and everything under it (Del)'
        : 'Delete this mesh data — the objects drawing it stay, empty (Del)';
    remove.addEventListener('click', () => deleteTarget(refForTarget(model, kind, index)));
    buttons.append(remove);
  }
  actions.append(spacer, buttons);
  panel.append(actions);

  if (material) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      'Saved in the file the way glTF stores it: MeshBasicMaterial as KHR_materials_unlit, ' +
      'MeshPhysicalMaterial as the KHR_materials_* extensions. Lambert, Phong, Toon and the ' +
      `other editor types have no glTF form, so they are saved as a standard material with the ` +
      `type in extras.${THREE_EXTRAS} — GLTFLoader puts it in material.userData.${THREE_EXTRAS}, ` +
      'and other viewers show the standard material.';
    panel.append(note);
  }
  return panel;
}

/**
 * A model as a whole: the file it came from, the name of the file's own scene —
 * which has no row of its own, the model's row being the file — and where the
 * model sits in the scene everything shares.
 */
function buildModelPanel(model: Model): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'Panel';

  if (model.sceneName !== null) panel.append(valueRow('Scene node', model.sceneName));
  panel.append(valueRow('File', model.fileName));
  const scene = model.json.scenes?.[model.sceneIndex];
  if (scene) panel.append(nameRow(model, 'scene', model.sceneIndex, scene, 'glTF scene'));
  panel.append(valueRow('Children', String(scene?.nodes?.length ?? 0), true));
  for (const row of placementRows(model)) panel.append(row);
  const shadowRow = modelShadowRow(model);
  if (shadowRow) panel.append(shadowRow);
  panel.append(visibleRow(model, null, 0));

  const actions = document.createElement('div');
  actions.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  const buttons = document.createElement('span');
  buttons.className = 'Buttons';

  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'Button';
  frame.textContent = 'Frame';
  frame.disabled = viewer === null;
  frame.addEventListener('click', () => viewer?.frame({ model: model.id }));
  buttons.append(frame);

  // Only another file can be hidden to leave this one on its own.
  if (models.length > 1) {
    const isolate = document.createElement('button');
    isolate.type = 'button';
    isolate.className = 'Button';
    isolate.textContent = 'Isolate';
    isolate.title = 'Hide every other model';
    isolate.disabled = viewer === null;
    isolate.addEventListener('click', () => {
      viewer?.isolate({ model: model.id });
      refreshVisibilityState();
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'Button';
    close.textContent = 'Close';
    close.title = `Close ${model.fileName}, leaving the other models open`;
    close.addEventListener('click', () => closeModel(model));
    buttons.append(isolate, close);
  }

  actions.append(spacer, buttons);
  panel.append(actions);
  return panel;
}

/**
 * The scene itself, which every model is in: what it holds, one click from each,
 * and the room its materials reflect besides its lights.
 */
function buildSceneRootPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'Panel';

  const nameField = document.createElement('input');
  nameField.type = 'text';
  nameField.className = 'Input scene-name-field';
  nameField.value = activeScene().name;
  nameField.setAttribute('aria-label', 'Scene name');
  nameField.addEventListener('change', () => renameScene(nameField.value));
  nameField.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') nameField.blur();
    if (event.key === 'Escape') {
      nameField.value = activeScene().name;
      nameField.blur();
    }
  });
  panel.append(fieldRow('Name', nameField));

  const lights = sceneObjects.filter((object) => categoryOf(object.kind) === 'light').length;
  panel.append(
    valueRow('Objects', `${sceneObjects.length} (${plural(lights, 'light')})`),
    environmentRow(),
  );
  const strength = numberField(environment.intensity, 0.05, 'Environment intensity', (value) => {
    const intensity = Math.max(0, value);
    if (intensity !== value) strength.value = formatNumber(intensity);
    setEnvironment({ ...environment, intensity });
  });
  strength.disabled = environment.mode === 'none';
  panel.append(fieldRow('Intensity', strength));
  panel.append(shadowsRow(), shadowTypeRow());

  panel.append(valueRow('Models', String(models.length), true));
  models.forEach((model, index) => {
    const row = document.createElement('div');
    row.className = 'Row';
    const key = document.createElement('span');
    key.className = 'Label';
    key.textContent = index === 0 ? 'Holds' : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'Button';
    button.textContent = modelLabel(model);
    button.title = model.path;
    button.addEventListener('click', () => selectTarget({ model: model.id }, { scroll: true }));
    row.append(key, button);
    panel.append(row);
  });

  const actions = document.createElement('div');
  actions.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  const buttons = document.createElement('span');
  buttons.className = 'Buttons';
  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'Button';
  frame.textContent = 'Frame';
  frame.title = 'Frame everything (F)';
  frame.disabled = viewer === null;
  frame.addEventListener('click', () => viewer?.frameAll());
  buttons.append(frame);
  actions.append(spacer, buttons);
  panel.append(actions);

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent =
    'The environment is a room every material reflects, lighting the scene besides its lights. ' +
    'Turn it off to see the models under their lights alone. Shadows are thrown by the lights ' +
    'told to cast them, onto whatever is told to receive them.';
  panel.append(note);
  return panel;
}

function environmentRow(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'Select';
  select.setAttribute('aria-label', 'Environment');
  for (const [value, text] of [
    ['room', 'Room'],
    ['none', 'None'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = environment.mode;
  select.addEventListener('change', () => {
    setEnvironment({ ...environment, mode: select.value === 'none' ? 'none' : 'room' });
    // The intensity field is only of use while there is a room to be lit by.
    rebuildProperties();
  });
  return fieldRow('Environment', select);
}

function setEnvironment(settings: EnvironmentSettings): void {
  environment = settings;
  viewer?.setEnvironment(settings);
  noteSceneEdit();
}

/** The editor's Project setting: whether the renderer draws shadows at all. */
function shadowsRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const label = document.createElement('label');
  label.className = 'Label';
  label.textContent = 'Shadows';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = 'prop-shadows';
  label.setAttribute('for', input.id);
  input.checked = shadows.enabled;
  input.title = 'Drawn by the lights told to cast, onto whatever is told to receive';
  input.addEventListener('change', () => {
    setShadows({ ...shadows, enabled: input.checked });
    // The type is only of use while something is drawn with it.
    rebuildProperties();
  });
  row.append(label, input);
  return row;
}

/** The filter the shadow maps are drawn with, as the editor lists them. */
function shadowTypeRow(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'Select';
  select.setAttribute('aria-label', 'Shadow type');
  for (const type of SHADOW_TYPES) {
    const option = document.createElement('option');
    option.value = type.value;
    option.textContent = type.label;
    option.title = type.hint;
    select.append(option);
  }
  select.value = shadows.type;
  select.disabled = !shadows.enabled;
  select.title = SHADOW_TYPES.find((type) => type.value === shadows.type)?.hint ?? '';
  select.addEventListener('change', () => {
    const type = SHADOW_TYPES.find((candidate) => candidate.value === select.value);
    if (!type) return;
    select.title = type.hint;
    setShadows({ ...shadows, type: type.value });
  });
  return fieldRow('Shadow type', select);
}

function setShadows(settings: ShadowSettings): void {
  shadows = settings;
  viewer?.setShadows(settings);
  noteSceneEdit();
}

/** A labelled row around one control of the panel. */
function fieldRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const key = document.createElement('span');
  key.className = 'Label';
  key.textContent = label;
  row.append(key, control);
  return row;
}

// ---------------------------------------------------------------------------
// The scene's own objects
//
// Lights, shapes and groups the scene holds itself, in no file: added with the
// outliner's "+" (or Add in the menubar), kept with the session, never
// downloaded. Every change ends with the viewer being handed the whole list
// again — it is short, and the viewer makes its objects match it.

function objectById(id: number | null | undefined): SceneObject | undefined {
  return id === null || id === undefined ? undefined : sceneObjects.find((object) => object.id === id);
}

function nextObjectId(): number {
  return sceneObjects.reduce((highest, object) => Math.max(highest, object.id), 0) + 1;
}

/** A name nothing else in the scene has yet — Box, Box 2, Box 3 — so rows can be told apart. */
function uniqueObjectName(base: string): string {
  const taken = new Set(sceneObjects.map((object) => object.name));
  if (!taken.has(base)) return base;
  let count = 2;
  while (taken.has(`${base} ${count}`)) count++;
  return `${base} ${count}`;
}

/**
 * Every change to the scene's own objects, or to its lighting, ends here: the
 * scene is being worked on for its own sake now, and the session keeps it.
 */
function noteSceneEdit(): void {
  recordSceneEdit();
  sceneStarted = true;
  keepScene();
}

/** Brings the viewport up with no model in it, for a scene of its own. */
function showScene(): void {
  dropzone.hidden = true;
  toolbar.hidden = false;
  viewportInfo.hidden = false;
  refreshOverlay();
  const epoch = viewerEpoch;
  ensureViewer()
    .then((created) => {
      if (epoch !== viewerEpoch) return;
      // A reload with no model to wait for puts its camera back straight away.
      if (pendingView && models.length === 0) {
        created.setView(pendingView);
        pendingView = null;
      }
      refreshVisibilityState();
      updateStatus();
      updateMoveButtons();
      rebuildProperties();
    })
    .catch((error: unknown) => {
      if (epoch === viewerEpoch) showError(`The 3D preview could not start: ${messageOf(error)}`);
    });
}

/**
 * Adds a new object to the scene, beside whatever of the scene's own is picked:
 * inside it when that is a group, next to it otherwise — so a group being filled
 * keeps being filled.
 */
function addSceneObject(kind: SceneObjectKind): void {
  const picked = objectById(pickedObject);
  const parent = picked ? (picked.kind === 'group' ? picked.id : picked.parent) : null;
  const object = createSceneObject(
    kind,
    nextObjectId(),
    uniqueObjectName(SCENE_OBJECT_KINDS[kind].name),
    parent,
  );
  sceneObjects.push(object);

  const opening = models.length === 0 && !sceneStarted;
  noteSceneEdit();
  if (opening) {
    showScene();
    setTab('scene');
  }
  viewer?.syncObjects(sceneObjects);
  buildEditor();
  selectObject(object.id, { scroll: true });
  const holder = objectById(parent);
  if (holder) showFlash(`Added ${object.name} to ${holder.name || 'the group'}`);
}

/** Renames a scene object from wherever it was typed, and every other field showing it follows. */
function setObjectName(object: SceneObject, value: string, source?: HTMLInputElement): void {
  object.name = value;
  for (const row of objectRowsFor(object)) {
    if (row.input !== source) row.input.value = value;
  }
  if (propObject?.id === object.id && propObject.name !== source) propObject.name.value = value;
  noteSceneEdit();
}

/** Sets one of a scene object's properties — a colour, an intensity — and shows it. */
function setObjectProp<K extends keyof SceneObjectProps>(
  object: SceneObject,
  key: K,
  value: SceneObjectProps[K],
): void {
  (object as SceneObjectProps)[key] = value;
  viewer?.syncObjects(sceneObjects);
  noteSceneEdit();
}

/** Hangs a scene object off another one — a group, usually — or off the scene with null. */
function setObjectParent(object: SceneObject, parent: number | null): void {
  if (parent === object.parent) return;
  // A parent inside the object itself would make a loop, and the list never offers one.
  if (parent !== null && (parent === object.id || descendantsOf(sceneObjects, object.id).has(parent))) return;
  object.parent = parent;
  // Last among its new siblings, which is where the outliner puts it.
  sceneObjects = [...sceneObjects.filter((other) => other !== object), object];
  viewer?.syncObjects(sceneObjects);
  noteSceneEdit();
  buildEditor();
  selectObject(object.id, { scroll: true });
}

/**
 * Deletes a scene object with everything under it, the way deleting an object
 * in a file takes its children. `focusAt` is the outliner row the keyboard was
 * on, so Delete can be pressed twice running.
 */
function deleteObject(id: number, focusAt = -1): void {
  const object = objectById(id);
  if (!object) return;
  beginHistoryStep();
  const doomed = descendantsOf(sceneObjects, id).add(id);
  const removed = sceneObjects.flatMap((candidate, at) => (doomed.has(candidate.id) ? [{ at, object: candidate }] : []));
  sceneObjects = sceneObjects.filter((candidate) => !doomed.has(candidate.id));
  const label = object.name || SCENE_OBJECT_KINDS[object.kind].label;

  if (pickedObject !== null && doomed.has(pickedObject)) pickedObject = null;
  viewer?.syncObjects(sceneObjects);
  noteSceneEdit();
  buildEditor();
  if (focusAt >= 0) focusRowNear(focusAt);
  const under = removed.length > 1 ? ` and ${plural(removed.length - 1, 'object')} under it` : '';
  showFlash(`Deleted ${label}${under} — Ctrl+Z to undo`);
}

/**
 * A scene object's panel: its name, where it hangs, where it sits and what it is
 * set to — the rows the editor's Object panel has for its kind.
 */
function buildObjectPanel(object: SceneObject): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'Panel';
  const kind = SCENE_OBJECT_KINDS[object.kind];

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'Input';
  name.spellcheck = false;
  name.placeholder = '(unnamed)';
  name.value = object.name;
  name.setAttribute('aria-label', `${kind.label} name`);
  name.addEventListener('input', () => setObjectName(object, name.value, name));
  panel.append(fieldRow('Name', name), valueRow('Type', kind.label), parentRow(object));

  let fields: Record<TrsPart, HTMLInputElement[]> | null = null;
  if (hasTransform(object.kind)) {
    fields = { translation: [], rotation: [], scale: [] };
    const commit = (part: TrsPart, values: Vec3) => commitObjectTransform(object, part, values);
    const { trs } = object;
    panel.append(
      vectorRow('Position', 'translation', trs.translation, fields, 0.01, commit),
      vectorRow('Rotation', 'rotation', quaternionToEuler(trs.rotation).map(toDegrees) as Vec3, fields, 1, commit),
      vectorRow('Scale', 'scale', trs.scale, fields, 0.01, commit),
    );
  }
  if (object.target !== undefined) panel.append(targetRow(object, object.target));

  if (object.color !== undefined) {
    panel.append(colorRow(kind.category === 'light' ? 'Color' : 'Surface', object, 'color'));
  }
  if (object.groundColor !== undefined) panel.append(colorRow('Ground color', object, 'groundColor'));
  if (object.intensity !== undefined) {
    panel.append(amountRow('Intensity', object, 'intensity', 0.05, { min: 0 }));
  }
  if (object.distance !== undefined) {
    panel.append(amountRow('Distance', object, 'distance', 0.1, { min: 0, title: '0 reaches without limit' }));
  }
  if (object.decay !== undefined) panel.append(amountRow('Decay', object, 'decay', 0.1, { min: 0 }));
  if (object.angle !== undefined) {
    panel.append(amountRow('Angle', object, 'angle', 1, { min: 0, max: 90, degrees: true }));
  }
  if (object.penumbra !== undefined) {
    panel.append(amountRow('Penumbra', object, 'penumbra', 0.01, { min: 0, max: 1 }));
  }
  // A shape has the editor's Shadow row; a light with a direction, a section of its own.
  if (object.receiveShadow !== undefined) panel.append(objectShadowRow(object));
  else if (object.castShadow !== undefined) panel.append(lightShadowSection(object));

  const shown = document.createElement('div');
  shown.className = 'Row';
  const shownLabel = document.createElement('label');
  shownLabel.className = 'Label';
  shownLabel.textContent = 'Visible';
  const visible = document.createElement('input');
  visible.type = 'checkbox';
  visible.id = `prop-visible-object-${object.id}`;
  shownLabel.setAttribute('for', visible.id);
  visible.checked = viewer ? viewer.objectHiddenState(object.id).reason === null : true;
  visible.disabled = viewer === null;
  visible.addEventListener('change', () => toggleObjectVisibility(object.id));
  shown.append(shownLabel, visible);
  panel.append(shown);

  const buttons = document.createElement('span');
  buttons.className = 'Buttons';
  if (object.kind !== 'ambient') {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'Button';
    frame.textContent = 'Frame';
    frame.disabled = viewer === null;
    frame.addEventListener('click', () => viewer?.frameObject(object.id));
    buttons.append(frame);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'Button';
  remove.textContent = 'Delete';
  remove.title = 'Delete this object and everything under it (Del)';
  remove.addEventListener('click', () => deleteObject(object.id));
  buttons.append(remove);
  const actions = document.createElement('div');
  actions.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  actions.append(spacer, buttons);
  panel.append(actions);

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent =
    object.kind === 'ambient'
      ? 'Lights everything evenly, from nowhere in particular. Part of the scene, not of any file: kept across a reload, never downloaded.'
      : object.kind === 'directional' || object.kind === 'spot'
        ? 'Shines from where it sits towards its target, a point in world space. Part of the scene, not of any file: kept across a reload, never downloaded.'
        : 'Part of the scene, not of any file: kept across a reload, never downloaded.';
  panel.append(note);

  propObject = { id: object.id, name, fields, visible };
  return panel;
}

/**
 * Where the object hangs: the scene itself, or another of the scene's objects —
 * a group, usually. Its own subtree is left out, since that would be a loop.
 */
function parentRow(object: SceneObject): HTMLElement {
  const select = document.createElement('select');
  select.className = 'Select';
  select.setAttribute('aria-label', 'Parent');
  const top = document.createElement('option');
  top.value = '';
  top.textContent = 'Scene';
  select.append(top);

  const excluded = descendantsOf(sceneObjects, object.id).add(object.id);
  const depthOf = (candidate: SceneObject): number => {
    let depth = 0;
    for (let at = objectById(candidate.parent); at && depth < 32; at = objectById(at.parent)) depth++;
    return depth;
  };
  // Groups first: they are what an object is meant to be put in.
  const candidates = sceneObjects.filter((candidate) => !excluded.has(candidate.id));
  candidates.sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group'));
  for (const candidate of candidates) {
    const option = document.createElement('option');
    option.value = String(candidate.id);
    const indent = '  '.repeat(depthOf(candidate));
    option.textContent = `${indent}${candidate.name || SCENE_OBJECT_KINDS[candidate.kind].label}`;
    select.append(option);
  }
  select.value = object.parent === null ? '' : String(object.parent);
  select.addEventListener('change', () => {
    setObjectParent(object, select.value === '' ? null : Number(select.value));
  });
  return fieldRow('Parent', select);
}

/**
 * The point a directional or spot light is aimed at, as three draggable numbers
 * like a position's. It is in world space, the way three.js keeps a target that
 * is not in the scene graph, so it stays put when the light's group moves.
 */
function targetRow(object: SceneObject, target: Vec3): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row vector-row';
  row.title = 'The point the light shines towards, in world space';
  const key = document.createElement('span');
  key.className = 'Label';
  key.textContent = 'Target';
  const group = document.createElement('span');
  group.className = 'vector';
  const fields: HTMLInputElement[] = [];
  target.forEach((value, axis) => {
    const input = numberField(value, 0.01, `Target ${'XYZ'[axis]}`, (next) => {
      const aim = fields.map((field) => parseNumber(field.value)) as Vec3;
      aim[axis] = next;
      setObjectProp(object, 'target', aim);
    });
    fields.push(input);
    group.append(input);
  });
  row.append(key, group);
  return row;
}

function colorRow(label: string, object: SceneObject, key: 'color' | 'groundColor'): HTMLElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'Color';
  input.value = object[key] ?? '#ffffff';
  input.setAttribute('aria-label', label);
  // `input` fires while the picker is open, so the scene follows the colour live.
  input.addEventListener('input', () => setObjectProp(object, key, input.value));
  return fieldRow(label, input);
}

/** The scene object properties that are one number each. */
type AmountKey =
  | 'intensity'
  | 'distance'
  | 'decay'
  | 'angle'
  | 'penumbra'
  | 'shadowIntensity'
  | 'shadowBias'
  | 'shadowNormalBias'
  | 'shadowRadius';

/** A draggable number for one of a light's amounts, kept inside the range the light takes. */
function amountRow(
  label: string,
  object: SceneObject,
  key: AmountKey,
  step: number,
  options: { min?: number; max?: number; degrees?: boolean; title?: string; decimals?: number },
): HTMLElement {
  const toShown = (value: number) => (options.degrees ? toDegrees(value) : value);
  const input = numberField(
    toShown(object[key] ?? 0),
    step,
    label,
    (value) => {
      const clamped = Math.min(Math.max(value, options.min ?? -Infinity), options.max ?? Infinity);
      if (clamped !== value) input.value = formatNumber(clamped, options.decimals);
      setObjectProp(object, key, options.degrees ? toRadians(clamped) : clamped);
    },
    options.decimals,
  );
  if (options.title) input.title = options.title;
  return fieldRow(label, input);
}

/** A shape's Shadow row, for the scene's own objects. */
function objectShadowRow(object: SceneObject): HTMLElement {
  return shadowFlagsRow(
    { cast: object.castShadow === true, receive: object.receiveShadow === true },
    `object-${object.id}`,
    (flag, on) => setObjectProp(object, flag === 'cast' ? 'castShadow' : 'receiveShadow', on),
  );
}

/**
 * A light's shadow, folded away under a heading of its own the way a material's
 * extensions are: whether it casts, and how its map is drawn. The heading's dot
 * says it casts. Only a light with a direction has one — an ambient or
 * hemisphere light has nothing to throw a shadow along.
 */
function lightShadowSection(object: SceneObject): HTMLElement {
  const details = document.createElement('details');
  details.className = 'material-section';
  const key = `object:${object.id}:shadow`;
  const casting = object.castShadow === true;
  details.open = sectionToggles.get(key) ?? casting;

  const summary = document.createElement('summary');
  summary.textContent = 'Shadow';
  const paint = (on: boolean): void => {
    summary.classList.toggle('in-use', on);
    summary.title = on ? 'This light casts shadows' : 'This light casts no shadow';
  };
  paint(casting);
  summary.addEventListener('click', () => sectionToggles.set(key, !details.open));

  const cast = document.createElement('div');
  cast.className = 'Row';
  const castLabel = document.createElement('label');
  castLabel.className = 'Label';
  castLabel.textContent = 'Cast';
  const castInput = document.createElement('input');
  castInput.type = 'checkbox';
  castInput.id = `prop-shadow-cast-object-${object.id}`;
  castLabel.setAttribute('for', castInput.id);
  castInput.checked = casting;
  castInput.title = 'Throws shadows onto whatever receives them';
  castInput.addEventListener('change', () => {
    setObjectProp(object, 'castShadow', castInput.checked);
    paint(castInput.checked);
  });
  cast.append(castLabel, castInput);

  const mapSize = document.createElement('select');
  mapSize.className = 'Select';
  mapSize.setAttribute('aria-label', 'Shadow map size');
  mapSize.title = 'Texels a side of the map the shadow is drawn into: finer edges for more memory';
  for (const size of SHADOW_MAP_SIZES) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = `${size} × ${size}`;
    mapSize.append(option);
  }
  mapSize.value = String(object.shadowMapSize ?? SHADOW_MAP_SIZES[0]);
  mapSize.addEventListener('change', () => setObjectProp(object, 'shadowMapSize', Number(mapSize.value)));

  details.append(
    summary,
    cast,
    amountRow('Intensity', object, 'shadowIntensity', 0.05, {
      min: 0,
      max: 1,
      title: 'How dark the shadow is: 1 is full, less lets the light through',
    }),
    amountRow('Bias', object, 'shadowBias', 0.0001, {
      decimals: 5,
      title:
        'Added to the depth the map is compared against, in tiny amounts around 0.0001: ' +
        'a little negative against stripes of self-shadowing (acne), a little positive against a shadow lifting off what casts it',
    }),
    amountRow('Normal bias', object, 'shadowNormalBias', 0.01, {
      title:
        'Moves the point looked up in the map along the surface normal, in world units. ' +
        'Cuts acne where light grazes a surface, at the cost of a slightly distorted shadow',
    }),
    amountRow('Radius', object, 'shadowRadius', 0.1, {
      min: 0,
      title: 'Blurs the shadow’s edge, in texels of its map. PCF and VSM read it; Basic and PCF Soft ignore it',
    }),
    fieldRow('Map size', mapSize),
  );
  return details;
}

/** Writes one part of a scene object's transform, typed into its panel. */
function commitObjectTransform(object: SceneObject, part: TrsPart, values: Vec3): void {
  const trs = structuredClone(object.trs);
  if (part === 'rotation') trs.rotation = eulerToQuaternion(values.map(toRadians) as Vec3);
  else trs[part] = [...values];
  object.trs = trs;
  viewer?.syncObjects(sceneObjects);
  noteSceneEdit();
}

/** The gizmo moved a scene object: its description and the panel's fields follow. */
function applyGizmoObjectTransform(id: number, trs: NodeTrs): void {
  const object = objectById(id);
  if (!object) return;
  // The viewer has already put it there; only the app's copy has to catch up.
  object.trs = structuredClone(trs);
  noteSceneEdit();
  const fields = propObject?.id === id ? propObject.fields : null;
  if (!fields) return;
  const shown = {
    translation: trs.translation,
    rotation: quaternionToEuler(trs.rotation).map(toDegrees) as Vec3,
    scale: trs.scale,
  };
  for (const part of ['translation', 'rotation', 'scale'] as TrsPart[]) {
    fields[part].forEach((field, axis) => {
      if (field !== document.activeElement) field.value = formatNumber(shown[part][axis]);
    });
  }
}

/** The eye on a scene object's row: hides it — or shows the group that is hiding it. */
function toggleObjectVisibility(id: number): void {
  if (!viewer) return;
  const state = viewer.objectHiddenState(id);
  if (state.reason === 'ancestor' && state.byObject !== undefined) {
    viewer.setObjectHidden(state.byObject, false);
    showFlash(`Showed ${objectById(state.byObject)?.name || 'the group'}, which was hiding it`);
  } else {
    viewer.setObjectHidden(id, !viewer.isObjectHidden(id));
  }
  refreshVisibilityState();
}

/** Paints a scene object's eye the way a model row's is painted. */
function paintObjectEye(row: ObjectRow): void {
  if (!viewer) return;
  const state = viewer.objectHiddenState(row.object.id);
  const name = row.object.name || SCENE_OBJECT_KINDS[row.object.kind].label;
  row.eyeBtn.innerHTML = iconSvg(state.reason === null ? 'eye' : 'eyeOff');
  row.eyeBtn.classList.toggle('off', state.reason !== null);
  row.el.classList.toggle('hidden-3d', state.reason !== null);
  row.el.classList.toggle('hidden-indirect', state.reason === 'ancestor');
  row.eyeBtn.title =
    state.reason === 'self'
      ? `${name} is hidden — click to show it`
      : state.reason === 'ancestor'
        ? `Hidden because ${objectById(state.byObject)?.name || 'a group above it'} is hidden — click to show that`
        : `Hide ${name}`;
  row.eyeBtn.setAttribute('aria-label', row.eyeBtn.title);
}

/** Fills a list of "Add" options — the "+" dropdown's, or the menubar's — from the one list of kinds. */
function fillAddOptions(container: HTMLElement, variant: 'dropdown' | 'menubar'): void {
  ADD_MENU.forEach((section, index) => {
    if (variant === 'menubar' && index > 0) container.append(document.createElement('hr'));
    if (section.heading && variant === 'dropdown') {
      const heading = document.createElement('div');
      heading.className = 'heading';
      heading.textContent = section.heading;
      container.append(heading);
    }
    for (const kind of section.kinds) {
      const option = document.createElement(variant === 'dropdown' ? 'button' : 'div');
      option.className = 'option';
      option.dataset.action = `add:${kind}`;
      option.append(typeIcon(objectIcon(kind)), SCENE_OBJECT_KINDS[kind].label);
      if (option instanceof HTMLButtonElement) {
        option.type = 'button';
        option.setAttribute('role', 'menuitem');
      }
      container.append(option);
    }
  });
}

/** The kind an "Add" option adds, read from its action. */
function addedKind(action: string | undefined): SceneObjectKind | null {
  if (!action?.startsWith('add:')) return null;
  const kind = action.slice(4);
  return kind in SCENE_OBJECT_KINDS ? (kind as SceneObjectKind) : null;
}

function openAddMenu(focusFirst: boolean): void {
  const rect = addBtn.getBoundingClientRect();
  addOptions.hidden = false;
  // Below the button, unless the narrow layout has put the sidebar at the
  // bottom of the screen and there is more room above it.
  const below = window.innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const downwards = below >= Math.min(addOptions.scrollHeight, 320) || below >= above;
  addOptions.style.top = downwards ? `${Math.round(rect.bottom + 2)}px` : '';
  addOptions.style.bottom = downwards ? '' : `${Math.round(window.innerHeight - rect.top + 2)}px`;
  addOptions.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
  addOptions.style.maxHeight = `${Math.max(120, Math.round(downwards ? below : above))}px`;
  addBtn.setAttribute('aria-expanded', 'true');
  addBtn.classList.add('selected');
  if (focusFirst) addOptions.querySelector<HTMLButtonElement>('button.option')?.focus();
}

function closeAddMenu(): void {
  if (addOptions.hidden) return;
  addOptions.hidden = true;
  addBtn.setAttribute('aria-expanded', 'false');
  addBtn.classList.remove('selected');
}

// ---------------------------------------------------------------------------
// Material parameters
//
// The editor's material panel, over the material's glTF JSON: the type picks
// the rows, each row is one key of the material, and every change is written
// into the document and set on the preview's live material in the same step.

/**
 * Sections opened or closed by hand, by model, material and section. Left
 * alone, a section is open when the material uses what it edits.
 */
const sectionToggles = new Map<string, boolean>();

/** The rows the material's type has, in the editor's order. */
function materialRows(model: Model, index: number, material: GltfMaterial): HTMLElement[] {
  const type = materialType(material);
  const out: HTMLElement[] = [];
  for (const section of MATERIAL_SECTIONS) {
    const rows = sectionItems(section, type).flatMap((item) => {
      if ('map' in item) return [textureRow(model, index, material, item.map)];
      if (item.param.shown && !item.param.shown(material)) return [];
      return [materialParamRow(model, index, material, item.param)];
    });
    if (rows.length === 0) continue;
    if (section.title === null) out.push(...rows);
    else out.push(materialSection(model, index, material, section, rows));
  }
  return out;
}

/** One of the physical extensions' groups of rows, folded away while unused. */
function materialSection(
  model: Model,
  index: number,
  material: GltfMaterial,
  section: MaterialSection,
  rows: HTMLElement[],
): HTMLElement {
  const details = document.createElement('details');
  details.className = 'material-section';
  const key = `${model.id}:${index}:${section.id}`;
  const inUse = sectionInUse(section, material);
  details.open = sectionToggles.get(key) ?? inUse;

  const summary = document.createElement('summary');
  summary.textContent = section.title;
  summary.classList.toggle('in-use', inUse);
  summary.title = inUse ? `${section.title} is in use — saved in the file` : `${section.title} is off`;
  // A click, not the toggle event: that one fires for the open set just above too,
  // which would pin a section open after its extension has gone.
  summary.addEventListener('click', () => sectionToggles.set(key, !details.open));
  details.append(summary, ...rows);
  return details;
}

/**
 * The type picker. Only the three types a glTF can hold can be picked; the
 * editor's others are listed, disabled, so their absence explains itself.
 */
function materialTypeRow(model: Model, index: number, material: GltfMaterial): HTMLElement {
  const select = document.createElement('select');
  select.className = 'Select material-type';
  select.setAttribute('aria-label', 'Material type');
  for (const type of MATERIAL_TYPES) select.append(textureOption(type, type));
  select.value = materialType(material);
  select.title =
    'MeshStandardMaterial is glTF’s own PBR material, MeshBasicMaterial adds KHR_materials_unlit, ' +
    'MeshPhysicalMaterial adds the KHR_materials_* extensions it uses. The rest have no glTF form: ' +
    `they are kept in extras.${THREE_EXTRAS}, over a standard material.`;
  select.addEventListener('change', () => changeMaterialType(model, index, select.value as MaterialType));
  return fieldRow('Type', select);
}

function changeMaterialType(model: Model, index: number, type: MaterialType): void {
  const material = model.json.materials?.[index];
  if (!material || materialType(material) === type) return;
  const dropped = setMaterialType(model.json, material, type);
  noteMaterialEdit(model, index);
  // Every row below the type depends on it.
  rebuildProperties();
  if (dropped.length > 0) {
    const what = dropped.length === 1 ? dropped[0] : `${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]}`;
    showFlash(`Removed ${what}: ${type} has none of it. Reset all brings it back.`);
  }
  // Another three.js class altogether, which only the loader builds.
  if (viewer?.hasObjects(model.id, 'material', index)) void startViewer(model, { keepView: true, quiet: true });
}

/** One colour, amount or choice of a material, written through as it changes. */
function materialParamRow(model: Model, index: number, material: GltfMaterial, param: MaterialParam): HTMLElement {
  const apply = (change: () => void): void => {
    change();
    noteMaterialEdit(model, index);
    viewer?.setMaterialLook(model.id, index, materialLook(material));
  };

  let control: HTMLElement;
  if (param.kind === 'color') {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'Color';
    input.value = linearToHex(param.get(material));
    input.setAttribute('aria-label', param.label);
    // `input` fires while the picker is open, so the preview follows the colour live.
    input.addEventListener('input', () => apply(() => param.set(model.json, material, hexToLinear(input.value))));
    control = input;
  } else if (param.kind === 'choice') {
    const select = document.createElement('select');
    select.className = 'Select';
    select.setAttribute('aria-label', param.label);
    for (const [value, text] of param.options) select.append(textureOption(value, text));
    select.value = param.get(material);
    select.addEventListener('change', () => {
      apply(() => param.set(model.json, material, select.value));
      if (param.rebuilds) rebuildProperties();
    });
    control = select;
  } else if (param.kind === 'text') {
    const area = document.createElement('textarea');
    area.className = 'Input code';
    area.spellcheck = false;
    area.rows = 6;
    area.value = param.get(material);
    area.setAttribute('aria-label', `${param.label} shader`);
    // A half-typed shader does not compile, so it is applied once typing stops
    // being in progress: when the field is left.
    area.addEventListener('change', () => apply(() => param.set(model.json, material, area.value)));
    area.addEventListener('keydown', (event) => {
      // Code is indented with tabs, as three.js's own shaders are.
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
      }
      // The outliner's arrows and the bare-letter shortcuts are not for here;
      // Ctrl/⌘ ones like save still are.
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    });
    control = area;
  } else {
    const shown = (value: number): number => (param.degrees ? toDegrees(value) : value);
    const input = numberField(shown(param.get(material)), param.step, param.label, (value) => {
      const clamped = Math.min(Math.max(value, param.min ?? -Infinity), param.max ?? Infinity);
      if (clamped !== value) input.value = formatNumber(clamped);
      apply(() => param.set(model.json, material, param.degrees ? toRadians(clamped) : clamped));
    });
    control = input;
  }

  const row = fieldRow(param.label, control);
  row.title = param.hint;
  return row;
}

/** Any change to a material's type or values: it counts once per material, however many there were. */
function noteMaterialEdit(model: Model, index: number): void {
  model.editedMaterials.add(index);
  noteEdit(model);
}

// ---------------------------------------------------------------------------
// Material textures

const ADD_IMAGE = 'add-image';

/**
 * One map slot: a thumbnail of what is bound, and a picker holding every
 * texture in the file plus the file dialog for bringing in a new image. The
 * thumbnail opens that dialog too, the way the editor's texture boxes do, and
 * the row takes a dropped image file — the quickest way to wire one up.
 */
function textureRow(model: Model, materialIndex: number, material: GltfMaterial, spec: MapSlotSpec): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row texture-row';
  row.title = spec.hint;

  const label = document.createElement('span');
  label.className = 'Label';
  label.textContent = spec.label;

  const bound = getMaterialTexture(material, spec.slot)?.index;

  const thumb = document.createElement('button');
  thumb.type = 'button';
  thumb.className = 'thumb';
  thumb.title = `Load an image into ${spec.label.toLowerCase()} — or drop one on this row`;
  thumb.setAttribute('aria-label', `Load an image for ${spec.label}`);
  if (bound === undefined) thumb.classList.add('empty');
  else void paintThumbnail(model, thumb, bound);
  thumb.addEventListener('click', () => {
    pendingSlot = { model, material: materialIndex, slot: spec.slot };
    imageInput.click();
  });

  const select = document.createElement('select');
  select.className = 'Select texture-select';
  select.setAttribute('aria-label', `${spec.label} texture`);
  select.append(textureOption('', 'None'));
  (model.json.textures ?? []).forEach((texture, index) => {
    select.append(textureOption(String(index), `${index} · ${textureLabel(model, texture, index)}`));
  });
  select.append(textureOption(ADD_IMAGE, 'Add image…'));
  select.value = bound === undefined ? '' : String(bound);

  select.addEventListener('change', () => {
    if (select.value === ADD_IMAGE) {
      // Put the shown value back: the file dialog may well be cancelled.
      select.value = bound === undefined ? '' : String(bound);
      pendingSlot = { model, material: materialIndex, slot: spec.slot };
      imageInput.click();
      return;
    }
    void assignTexture(model, materialIndex, spec.slot, select.value === '' ? null : Number(select.value));
  });

  row.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    // Without this the window handler would file the image away as a sidecar
    // and never bind it to anything.
    event.stopPropagation();
    row.classList.remove('drop-target');
    document.body.classList.remove('dragover');
    if (!event.dataTransfer) return;
    void collectDroppedFiles(event.dataTransfer).then((picked) => {
      const image = picked.find((item) => isImageFile(item.file));
      if (!image) {
        showError('Drop an image file onto a texture slot.');
        return;
      }
      void addImageToSlot(model, image, materialIndex, spec.slot);
    });
  });

  // The editor's button beside a map, for how the texture is sampled.
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'Button texture-edit';
  edit.innerHTML = iconSvg('tune');
  edit.disabled = bound === undefined;
  edit.title =
    bound === undefined
      ? `Pick a texture for ${spec.label.toLowerCase()} first`
      : 'Texture parameters: wrap, filtering and UV transform';
  edit.setAttribute('aria-label', `${spec.label} texture parameters`);
  edit.addEventListener('click', () => openTextureDialog(model, materialIndex, spec));

  row.append(label, thumb, select, edit);
  return row;
}

function textureOption(value: string, text: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  return option;
}

/** A texture's most useful name: its own, its image's, or the image's file. */
function textureLabel(model: Model, texture: GltfTexture, index: number): string {
  const image = texture.source === undefined ? undefined : model.json.images?.[texture.source];
  const fromUri = image?.uri && !image.uri.startsWith('data:') ? baseName(image.uri) : '';
  return getName(texture) || getName(image ?? {}) || fromUri || `Texture ${index}`;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|ktx2|avif|bmp|gif)$/i.test(file.name);
}

/**
 * Writes the binding into the document, then shows it. Assigning a texture the
 * preview has never seen needs a reload, which is why the viewer is allowed to
 * report that it could not apply the change.
 */
async function assignTexture(
  model: Model,
  materialIndex: number,
  slot: MapSlot,
  textureIndex: number | null,
): Promise<void> {
  const material = model.json.materials?.[materialIndex];
  if (!material) return;

  const { lifted } = setMaterialTexture(model.json, material, slot, textureIndex);
  model.mapEdits++;
  noteEdit(model);
  propSignature = '';
  renderProperties();
  updateMenus();
  if (lifted) showFlash(lifted);

  if (!viewer) return;
  const applied = await viewer.setMaterialMap(model.id, materialIndex, slot, textureIndex);
  // The factor a texture needed lifting, if it did. Not when the document was
  // replaced while the texture decoded: that one is being reloaded anyway.
  if (model.json.materials?.[materialIndex] === material) {
    viewer.setMaterialLook(model.id, materialIndex, materialLook(material));
    // The parser hands the texture over as the file had it when it loaded: the
    // slot's own transform, and the sampler as edited since, go on top.
    if (applied) showTextureLook(model, materialIndex, slot);
  }
  // A material nothing in the scene uses has nothing to repaint, so only a
  // texture the preview has never seen is worth re-parsing the file for.
  if (!applied && viewer.hasObjects(model.id, 'material', materialIndex)) {
    void startViewer(model, { keepView: true, quiet: true });
  }
}

/** Brings an image file into the document and binds it to a slot in one go. */
async function addImageToSlot(
  model: Model,
  picked: PickedFile,
  materialIndex: number,
  slot: MapSlot,
): Promise<void> {
  // The file dialog can outlast the model it was opened for.
  if (!models.includes(model)) return;
  const textureIndex = addImage(model, picked);
  await assignTexture(model, materialIndex, slot, textureIndex);
  showFlash(`Added ${picked.file.name} as texture ${textureIndex}`);
}

/**
 * Adds an image and a texture pointing at it, and keeps the file around: the
 * preview loads it through the URI, and a .glb export embeds its bytes.
 */
function addImage(model: Model, picked: PickedFile): number {
  const json = model.json;
  const images = (json.images ??= []);
  const textures = (json.textures ??= []);

  const uri = uniqueImageUri(images, picked.path);
  model.resources.set(uri, picked.file);

  const imageIndex = images.length;
  images.push({ uri, name: picked.file.name, mimeType: mimeTypeOf(picked.file) });
  model.addedImages.set(imageIndex, picked.file);

  const textureIndex = textures.length;
  textures.push({ source: imageIndex, name: picked.file.name.replace(/\.[^.]+$/, '') });

  // The edit is recorded by the assignment that always follows, so that adding
  // an image and binding it counts as the one change it looks like.
  // The Images and Textures lists have just gained a row each.
  buildEditor();
  return textureIndex;
}

/** Never let a new image quietly take over the URI an existing one uses. */
function uniqueImageUri(images: GltfImage[], path: string): string {
  const taken = new Set(images.map((image) => normalizeUri(image.uri ?? '')));
  if (!taken.has(normalizeUri(path))) return path;

  const dot = path.lastIndexOf('.');
  const stem = dot === -1 ? path : path.slice(0, dot);
  const extension = dot === -1 ? '' : path.slice(dot);
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!taken.has(normalizeUri(candidate))) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Texture parameters
//
// The three.js editor's texture dialog, opened from a map slot. Wrap and
// filtering are the texture's sampler, so they change every map that uses the
// texture; the UV set and transform are the slot's own. Each change is written
// into the document and shown at once, and Cancel puts back what was there.

/** Everything the dialog can change, as it was when the dialog opened. */
interface TextureDialogSaved {
  samplers: unknown[] | undefined;
  sampler: number | undefined;
  info: TextureInfo;
  used: string[] | undefined;
  required: string[] | undefined;
}

/** CSS pixels on each side of the preview square. */
const TEXTURE_PREVIEW_SIZE = 256;
/** The longest side the preview samples the image at: plenty for a square that size. */
const TEXTURE_PREVIEW_SOURCE = 512;

function openTextureDialog(model: Model, materialIndex: number, spec: MapSlotSpec): void {
  const json = model.json;
  const material = json.materials?.[materialIndex];
  const info = material ? getMaterialTexture(material, spec.slot) : undefined;
  const texture = info ? json.textures?.[info.index] : undefined;
  if (!material || !info || !texture) return;
  const textureIndex = info.index;

  const saved: TextureDialogSaved = {
    samplers: structuredClone(json.samplers),
    sampler: texture.sampler,
    info: structuredClone(info),
    used: json.extensionsUsed?.slice(),
    required: json.extensionsRequired?.slice(),
  };
  const sampler = readSampler(json, textureIndex);
  const uv = readUvTransform(material, spec.slot);
  const users = textureUsers(json, textureIndex);
  let changed = false;
  let kept = false;

  const preview = texturePreview(model, texture, sampler, uv);

  const setSampler = (key: keyof SamplerSettings, value: number): void => {
    sampler[key] = value;
    setSamplerValue(json, textureIndex, key, value);
    changed = true;
    for (const user of users) showTextureLook(model, user.material, user.slot);
    preview.redraw();
  };
  const setUv = (): void => {
    setUvTransform(json, material, spec.slot, uv);
    changed = true;
    showTextureLook(model, materialIndex, spec.slot);
    preview.redraw();
  };

  const choiceRow = (
    label: string,
    hint: string,
    options: [number, string][],
    value: number,
    onChange: (value: number) => void,
  ): HTMLElement => {
    const select = document.createElement('select');
    select.className = 'Select';
    select.setAttribute('aria-label', label);
    for (const [code, text] of options) select.append(textureOption(String(code), text));
    select.value = String(value);
    select.addEventListener('change', () => onChange(Number(select.value)));
    const row = fieldRow(label, select);
    row.title = hint;
    return row;
  };
  // What glTF has no say in, shown the way it always is, so its absence explains itself.
  const fixedRow = (label: string, hint: string, text: string): HTMLElement => {
    const select = document.createElement('select');
    select.className = 'Select';
    select.disabled = true;
    select.setAttribute('aria-label', label);
    select.append(textureOption('', text));
    const row = fieldRow(label, select);
    row.title = hint;
    return row;
  };
  const pairRow = (label: string, hint: string, values: [number, number], step: number): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'Row vector-row';
    row.title = hint;
    const key = document.createElement('span');
    key.className = 'Label';
    key.textContent = label;
    const group = document.createElement('span');
    group.className = 'vector';
    values.forEach((value, axis) => {
      group.append(
        numberField(value, step, `${label} ${'UV'[axis]}`, (next) => {
          values[axis] = next;
          setUv();
        }),
      );
    });
    row.append(key, group);
    return row;
  };

  const sets = uvSetsOf(model, materialIndex);
  const uvOptions: [number, string][] = [];
  for (let set = 0; set < Math.max(UV_SETS, uv.texCoord + 1); set++) {
    uvOptions.push([set, `TEXCOORD_${set}${sets && !sets.has(set) ? ' — not in the mesh' : ''}`]);
  }

  const anisotropy = numberField(sampler.anisotropy, 1, 'Anisotropy', (value) => {
    const clamped = Math.min(Math.max(value, 1), 16);
    if (clamped !== value) anisotropy.value = formatNumber(clamped);
    setSampler('anisotropy', clamped);
  });
  const anisotropyRow = fieldRow('Anisotropy', anisotropy);
  anisotropyRow.title =
    'Keeps the texture sharp at grazing angles. glTF has no anisotropy, so it is kept in the ' +
    `sampler’s extras.${ANISOTROPY_EXTRAS} — GLTFLoader does not read it, so set texture.anisotropy from there in your own code.`;

  const rotation = numberField(toDegrees(uv.rotation), 1, 'Rotation', (value) => {
    uv.rotation = toRadians(value);
    setUv();
  });
  const rotationRow = fieldRow('Rotation °', rotation);
  rotationRow.title = 'In degrees, about the centre. KHR_texture_transform.rotation';

  const premultiply = document.createElement('input');
  premultiply.type = 'checkbox';
  premultiply.disabled = true;
  premultiply.setAttribute('aria-label', 'Premultiply alpha');
  const premultiplyRow = fieldRow('Premultiply alpha', premultiply);
  premultiplyRow.title =
    'glTF images are never premultiplied, and GLTFLoader reads them as they are: there is nothing to store.';

  const section = (title: string, ...rows: HTMLElement[]): HTMLElement => {
    const group = document.createElement('section');
    group.className = 'texture-dialog-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    group.append(heading, ...rows);
    return group;
  };

  const params = document.createElement('div');
  params.className = 'texture-dialog-params';
  params.append(
    section(
      'Mapping',
      fixedRow(
        'Mapping',
        'glTF maps a texture by UV coordinates only: the editor’s reflection and refraction mappings have no glTF form.',
        'UV',
      ),
      choiceRow('UV set', 'Which of the mesh’s UV sets the map reads. texCoord', uvOptions, uv.texCoord, (value) => {
        uv.texCoord = value;
        setUv();
      }),
      choiceRow('Wrap S', 'What the texture does past its edges, across. sampler.wrapS', WRAP_OPTIONS, sampler.wrapS, (value) =>
        setSampler('wrapS', value),
      ),
      choiceRow('Wrap T', 'What the texture does past its edges, down. sampler.wrapT', WRAP_OPTIONS, sampler.wrapT, (value) =>
        setSampler('wrapT', value),
      ),
    ),
    section(
      'Filtering',
      choiceRow(
        'Min filter',
        'How the texture is shrunk, and whether it reads mipmaps. sampler.minFilter',
        MIN_FILTER_OPTIONS,
        sampler.minFilter,
        (value) => setSampler('minFilter', value),
      ),
      choiceRow('Mag filter', 'How the texture is enlarged. sampler.magFilter', MAG_FILTER_OPTIONS, sampler.magFilter, (value) =>
        setSampler('magFilter', value),
      ),
      anisotropyRow,
    ),
    section(
      'Transform',
      pairRow('Offset', 'KHR_texture_transform.offset', uv.offset, 0.01),
      pairRow('Repeat', 'KHR_texture_transform.scale', uv.repeat, 0.01),
      pairRow(
        'Center',
        'What rotation and repeat turn about. glTF turns textures about the corner, so the centre is folded ' +
          'into the stored offset, and kept in the transform’s extras.center for this dialog.',
        uv.center,
        0.01,
      ),
      rotationRow,
    ),
    section(
      'Color',
      premultiplyRow,
      fixedRow(
        'Color space',
        'glTF decides it by slot: colour maps are sRGB, data maps are linear.',
        spec.srgb ? 'sRGB' : 'None (linear)',
      ),
    ),
  );

  const dialog = document.createElement('dialog');
  dialog.className = 'texture-dialog';
  const title = document.createElement('h2');
  title.id = 'texture-dialog-title';
  title.textContent = 'Texture parameters';
  dialog.setAttribute('aria-labelledby', title.id);
  const subtitle = document.createElement('p');
  subtitle.className = 'texture-dialog-subtitle';
  subtitle.textContent = `${spec.label} · ${textureIndex} · ${textureLabel(model, texture, textureIndex)}`;

  const body = document.createElement('div');
  body.className = 'texture-dialog-body';
  body.append(section('Preview', preview.element), params);

  const footer = document.createElement('div');
  footer.className = 'texture-dialog-footer';
  const others = users.length - 1;
  if (others > 0) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      `Wrap and filtering belong to texture ${textureIndex}, so they change the ${others} other ` +
      `map${others === 1 ? '' : 's'} using it too. The UV set and transform are this map’s own.`;
    footer.append(note);
  }
  const buttons = document.createElement('div');
  buttons.className = 'Buttons';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'Button primary';
  ok.textContent = 'OK';
  ok.addEventListener('click', () => {
    kept = true;
    dialog.close();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'Button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => dialog.close());
  buttons.append(ok, cancel);
  footer.append(buttons);

  dialog.append(title, subtitle, body, footer);
  // Escape closes it too, and counts as Cancel.
  dialog.addEventListener('close', () => {
    dialog.remove();
    // Nothing to keep or undo — or a document that was closed or reset meanwhile.
    if (!changed || model.json !== json || !models.includes(model)) return;
    if (kept) {
      model.mapEdits++;
      noteEdit(model);
      updateMenus();
      return;
    }
    restoreTextureState(json, texture, info, saved);
    for (const user of users) showTextureLook(model, user.material, user.slot);
  });
  document.body.append(dialog);
  dialog.showModal();
}

function restoreTextureState(json: GltfJson, texture: GltfTexture, info: TextureInfo, saved: TextureDialogSaved): void {
  if (saved.samplers === undefined) delete json.samplers;
  else json.samplers = saved.samplers;
  if (saved.sampler === undefined) delete texture.sampler;
  else texture.sampler = saved.sampler;
  // In place: the material holds this very object.
  for (const key of Object.keys(info)) delete (info as unknown as Record<string, unknown>)[key];
  Object.assign(info, saved.info);
  if (saved.used === undefined) delete json.extensionsUsed;
  else json.extensionsUsed = saved.used;
  if (saved.required === undefined) delete json.extensionsRequired;
  else json.extensionsRequired = saved.required;
}

/** Shows one slot's sampler and transform the way the document now has them. */
function showTextureLook(model: Model, materialIndex: number, slot: MapSlot): void {
  const material = model.json.materials?.[materialIndex];
  const look = material ? textureLook(model.json, material, slot) : null;
  if (look) viewer?.setTextureLook(model.id, materialIndex, slot, look);
}

/**
 * The UV sets the meshes drawn with a material have, by TEXCOORD_n number — or
 * null when nothing is drawn with it, and there is nothing to go by.
 */
function uvSetsOf(model: Model, materialIndex: number): Set<number> | null {
  const sets = new Set<number>();
  let drawn = false;
  for (const mesh of model.json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.material !== materialIndex) continue;
      drawn = true;
      const attributes = (primitive as { attributes?: Record<string, unknown> }).attributes ?? {};
      for (const name of Object.keys(attributes)) {
        const match = /^TEXCOORD_(\d+)$/.exec(name);
        if (match) sets.add(Number(match[1]));
      }
    }
  }
  return drawn ? sets : null;
}

/**
 * The dialog's preview: one unit of UV space, sampled the way the slot's shader
 * samples it, so a repeat, a turn or a clamp shows before the model does.
 */
function texturePreview(
  model: Model,
  texture: GltfTexture,
  sampler: SamplerSettings,
  uv: UvTransform,
): { element: HTMLElement; redraw: () => void } {
  const element = document.createElement('div');
  element.className = 'texture-preview';
  const canvas = document.createElement('canvas');
  const size = Math.round(TEXTURE_PREVIEW_SIZE * Math.min(window.devicePixelRatio || 1, 2));
  canvas.width = size;
  canvas.height = size;
  const caption = document.createElement('p');
  caption.className = 'note';
  element.append(canvas, caption);

  let pixels: ImageData | null = null;
  let frame = 0;
  // Scrubbing a number sends a change per pointer move: one repaint per frame is plenty.
  const redraw = (): void => {
    if (!pixels || frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (pixels) paintTexturePreview(canvas, pixels, sampler, uv);
    });
  };

  const source = texture.source;
  void (source === undefined ? Promise.resolve(null) : imagePreviewUrl(model, source))
    .then((url) => (url === null ? null : decodeImage(url)))
    .then((image) => {
      if (!image) {
        element.classList.add('unknown');
        caption.textContent = 'No preview: the image is compressed, or its file is missing.';
        return;
      }
      pixels = imagePixels(image, TEXTURE_PREVIEW_SOURCE);
      caption.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
      redraw();
    });
  return { element, redraw };
}

async function decodeImage(url: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

/** An image's pixels, scaled down to fit `longest` on its longer side. */
function imagePixels(image: HTMLImageElement, longest: number): ImageData | null {
  const scale = Math.min(1, longest / Math.max(image.naturalWidth, image.naturalHeight, 1));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/**
 * Samples the texture across the unit square the way three.js does: its UV
 * transform (Matrix3.setUvTransform), then the sampler's wrap, then its
 * magnification filter. Minification and anisotropy are left to the viewport.
 */
function paintTexturePreview(
  canvas: HTMLCanvasElement,
  source: ImageData,
  sampler: SamplerSettings,
  uv: UvTransform,
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  const out = context.createImageData(width, height);
  const { data: texels, width: tw, height: th } = source;
  const cos = Math.cos(uv.rotation);
  const sin = Math.sin(uv.rotation);
  const [sx, sy] = uv.repeat;
  const [cx, cy] = uv.center;
  const [ox, oy] = uv.offset;
  const m00 = sx * cos;
  const m01 = sx * sin;
  const m02 = -sx * (cos * cx + sin * cy) + cx + ox;
  const m10 = -sy * sin;
  const m11 = sy * cos;
  const m12 = -sy * (-sin * cx + cos * cy) + cy + oy;
  const linear = sampler.magFilter === LINEAR;

  let at = 0;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const tu = (m00 * u + m01 * v + m02) * tw;
      const tv = (m10 * u + m11 * v + m12) * th;
      if (linear) {
        const fx = tu - 0.5;
        const fy = tv - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const ax = fx - x0;
        const ay = fy - y0;
        const c0 = wrapTexel(x0, tw, sampler.wrapS);
        const c1 = wrapTexel(x0 + 1, tw, sampler.wrapS);
        const r0 = wrapTexel(y0, th, sampler.wrapT) * tw;
        const r1 = wrapTexel(y0 + 1, th, sampler.wrapT) * tw;
        const i00 = (r0 + c0) * 4;
        const i01 = (r0 + c1) * 4;
        const i10 = (r1 + c0) * 4;
        const i11 = (r1 + c1) * 4;
        for (let channel = 0; channel < 4; channel++) {
          const top = texels[i00 + channel] + (texels[i01 + channel] - texels[i00 + channel]) * ax;
          const bottom = texels[i10 + channel] + (texels[i11 + channel] - texels[i10 + channel]) * ax;
          out.data[at + channel] = top + (bottom - top) * ay;
        }
      } else {
        const i = (wrapTexel(Math.floor(tv), th, sampler.wrapT) * tw + wrapTexel(Math.floor(tu), tw, sampler.wrapS)) * 4;
        out.data[at] = texels[i];
        out.data[at + 1] = texels[i + 1];
        out.data[at + 2] = texels[i + 2];
        out.data[at + 3] = texels[i + 3];
      }
      at += 4;
    }
  }
  context.putImageData(out, 0, 0);
}

/** A texel index past the image's edge, brought back the way the wrap mode brings it. */
function wrapTexel(index: number, size: number, wrap: number): number {
  if (wrap === CLAMP_TO_EDGE) return index < 0 ? 0 : index >= size ? size - 1 : index;
  if (wrap === MIRRORED_REPEAT) {
    const period = size * 2;
    const folded = ((index % period) + period) % period;
    return folded < size ? folded : period - 1 - folded;
  }
  return ((index % size) + size) % size;
}

// ---------------------------------------------------------------------------
// Image previews

async function paintThumbnail(model: Model, host: HTMLElement, textureIndex: number): Promise<void> {
  const source = model.json.textures?.[textureIndex]?.source;
  const url = source === undefined ? null : await imagePreviewUrl(model, source);
  // The panel may have been rebuilt while the bytes were being reached for.
  if (!host.isConnected) return;
  if (url === null) {
    // Compressed containers and files the user has not supplied show nothing.
    host.classList.add('empty', 'unknown');
    return;
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  host.textContent = '';
  host.classList.remove('empty', 'unknown');
  host.append(img);
}

function imagePreviewUrl(model: Model, imageIndex: number): Promise<string | null> {
  const cached = model.imageUrls.get(imageIndex);
  if (cached !== undefined) return Promise.resolve(cached);
  const url = buildImageUrl(model, imageIndex);
  model.imageUrls.set(imageIndex, url);
  return Promise.resolve(url);
}

/**
 * A URL an <img> can show for a glTF image, wherever its bytes live: inline as
 * a data URI, in a file the user supplied, or inside the binary chunk.
 */
function buildImageUrl(model: Model, imageIndex: number): string | null {
  const { json, resources } = model;
  const image = json.images?.[imageIndex];
  if (!image || !isDisplayableImage(image)) return null;

  if (image.uri) {
    if (image.uri.startsWith('data:')) return image.uri;
    const file = resolveResource(buildResourceLookup(resources), image.uri);
    return file ? URL.createObjectURL(file) : null;
  }

  const range = imageBufferRange(json, imageIndex);
  if (!range) return null;
  const buffer = json.buffers?.[range.buffer];

  // In a .glb the bytes are in the binary chunk; a .gltf keeps them in a file,
  // where a Blob slice reaches them without reading the whole thing.
  if (buffer?.uri === undefined) {
    const bin = model.isGlb ? model.glbChunks.find((chunk) => chunk.type === CHUNK_BIN) : undefined;
    if (!bin || range.end > bin.data.byteLength) return null;
    return URL.createObjectURL(
      new Blob([bin.data.subarray(range.start, range.end)], { type: range.mimeType }),
    );
  }
  const file = resolveResource(buildResourceLookup(resources), buffer.uri);
  if (!file || range.end > file.size) return null;
  return URL.createObjectURL(file.slice(range.start, range.end, range.mimeType));
}

/** Compressed textures are not something a browser will decode in an <img>. */
function isDisplayableImage(image: GltfImage): boolean {
  const mime = image.mimeType ?? '';
  if (mime) return /^image\/(png|jpeg|webp|avif|gif|bmp)$/.test(mime);
  return !/\.(ktx2?|basis|dds)$/i.test(image.uri ?? '');
}

function releaseImageUrls(model: Model): void {
  for (const url of model.imageUrls.values()) {
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  model.imageUrls = new Map();
}

// ---------------------------------------------------------------------------
// Deleting
//
// Objects and mesh data come out of the document itself, so out of the download
// too. Every delete renumbers what came after it in its own file, which is why
// that model's moved-node records, hidden set and selection all have to follow
// along. Ctrl+Z puts the document from before back whole, numbering and all.

/**
 * Whether a selection names something Delete can take away: an object or mesh
 * data out of its file, or the file itself out of the scene.
 */
function canDelete(ref: SelectionRef | null): boolean {
  return ref !== null && (ref.node !== undefined || ref.mesh !== undefined || isWholeModel(ref));
}

/** Delete on an outliner row: it takes the row the keyboard is on. */
function deleteRow(position: number): void {
  const row = rows[position];
  if (!row) return;
  // On a row of a multiple selection, Delete takes all of it.
  if (extraPicks.length > 0 && row.el.classList.contains('selected')) {
    deletePicks(allPicks());
    return;
  }
  if (isObjectRow(row)) deleteObject(row.object.id, position);
  else if (row.fixed) deleteModel(row.model);
  else deleteTarget(refFor(row), position);
}

/**
 * Delete on a whole model closes it, as File → Close does. That is the one
 * delete Ctrl+Z cannot take back, so a file with edits in it asks first — the
 * keyboard can land on the model's row after deleting the last thing under it.
 */
function deleteModel(model: Model): void {
  const edited =
    modifiedCount(model) > 0 ||
    hasStructuralEdits(model) ||
    hasTrims(model.json) ||
    model.addedImages.size > 0;
  const message = `Close ${model.fileName}? Its edits go with it — Ctrl+Z cannot bring it back.`;
  if (edited && !window.confirm(message)) return;
  closeModel(model);
}

/** Delete, from the keyboard or a menu: whatever is selected, in a file or in the scene. */
function deleteSelection(): void {
  if (extraPicks.length > 0) deletePicks(allPicks());
  else if (pickedObject !== null) deleteObject(pickedObject);
  else if (selection) deleteTarget(selection);
}

/** Shows the selection on its own, whichever kind it is — or all of a multiple one. */
function isolateSelection(): void {
  if (!viewer) return;
  if (extraPicks.length > 0) viewer.isolateMany(...splitPicks(allPicks()));
  else if (pickedObject !== null) viewer.isolateObject(pickedObject);
  else if (selection) viewer.isolate(selection);
  else return;
  refreshVisibilityState();
}

function frameSelection(): void {
  if (!viewer) return;
  if (extraPicks.length > 0) viewer.frameMany(...splitPicks(allPicks()));
  else if (pickedObject !== null) viewer.frameObject(pickedObject);
  else if (selection) viewer.frame(selection);
  else viewer.frameAll();
}

/**
 * Deletes an object with everything under it, or mesh data on its own.
 * `focusAt` is the outliner row the keyboard was on: it stays about there, so
 * Delete can be pressed twice running.
 */
function deleteTarget(ref: SelectionRef, focusAt = -1): void {
  const model = modelById(ref.model);
  if (!model) return;
  if (isWholeModel(ref)) {
    deleteModel(model);
    return;
  }
  if (!canDelete(ref)) {
    showFlash('Only objects and mesh data can be deleted');
    return;
  }

  // Opened before the delete clears the selection, so that undoing it selects it again.
  beginHistoryStep();
  // Named now, while the index still points at it.
  const kind = ref.node !== undefined ? 'node' : 'mesh';
  const index = (kind === 'node' ? ref.node : ref.mesh)!;
  const label = describeTarget(model, kind, index);
  const result = removeFromModel(model, kind, [index]);
  if (!result) return;

  showStructure(model, result.renumbered, null);
  if (focusAt >= 0) focusRowNear(focusAt);

  const under =
    kind === 'node' && result.nodes > 1 ? ` and ${plural(result.nodes - 1, 'object')} under it` : '';
  const drew = result.emptied > 0 ? `, which ${plural(result.emptied, 'object')} drew` : '';
  showFlash(`Deleted ${label}${under}${drew} — Ctrl+Z to undo`);
}

/**
 * The document's side of a delete: objects with everything under them, or one
 * mesh data, taken out of the model, with the records of its edits following
 * the renumbering. Ctrl+Z needs nothing of it: the history kept the document.
 * The outliner and the preview are left to the caller. Null when nothing was
 * deleted, a skinned object having said why.
 */
function removeFromModel(
  model: Model,
  kind: 'node' | 'mesh',
  indices: number[],
): Removal | null {
  const result = kind === 'node' ? removeNodes(model.json, indices) : removeMesh(model.json, indices[0]);
  if (!result) return null;
  if ('blocked' in result) {
    const user = describeTarget(model, 'node', result.blocked.user);
    showFlash(
      `Not deleted: ${user} is skinned to ${describeTarget(model, 'node', result.blocked.joint)} — delete ${user} first`,
    );
    return null;
  }

  const nodeMap = result.renumbered.nodes;
  if (nodeMap) {
    // Moved objects are remembered by index, so they follow the renumbering;
    // the deleted ones are forgotten — Ctrl+Z brings them back with the document.
    const moved = new Map<number, NodeTransformKeys>();
    for (const [at, original] of model.movedNodes) {
      const to = nodeMap[at] ?? at;
      if (to !== -1) moved.set(to, original);
    }
    model.movedNodes = moved;
    const shadowed = new Map<number, ShadowFlags>();
    for (const [at, original] of model.shadowEdits) {
      const to = nodeMap[at] ?? at;
      if (to !== -1) shadowed.set(to, original);
    }
    model.shadowEdits = shadowed;
  }
  const meshMap = result.renumbered.meshes;
  if (meshMap) {
    model.morphedMeshes = new Set(
      [...model.morphedMeshes].flatMap((at) => {
        const to = meshMap[at] ?? at;
        return to === -1 ? [] : [to];
      }),
    );
  }
  model.origins = followRenumbering(model.origins, result.renumbered);
  model.deletedCount += kind === 'node' ? result.nodes : 1;
  return result;
}

/**
 * Shows a model's document after a delete or its undo. The preview keeps what
 * was hidden, under its new number, and reloads; the outliner and panel are
 * rebuilt. Every other model is numbered as it was, and left alone.
 */
function showStructure(
  model: Model,
  renumbered: Partial<Record<Collection, number[]>>,
  select: SelectionRef | null,
): void {
  renumberPreview(model, renumbered);
  // What was selected in it is gone, or numbered differently now.
  if (selection?.model === model.id) selectTarget(null);
  buildEditor();
  if (select) selectTarget(select, { scroll: true });
  noteEdit(model);
  void startViewer(model, { keepView: true });
}

/** Keeps what is hidden in the preview hidden, under the numbers a delete gave it. */
function renumberPreview(model: Model, renumbered: Partial<Record<Collection, number[]>>): void {
  if (renumbered.nodes) viewer?.renumber(model.id, 'node', renumbered.nodes);
  if (renumbered.meshes) viewer?.renumber(model.id, 'mesh', renumbered.meshes);
}

/** Keeps the keyboard near where it was, so Delete can be pressed twice running. */
function focusRowNear(position: number): void {
  const at = Math.min(position, rows.length - 1);
  let next = seekVisible(at, 1);
  if (next < 0) next = seekVisible(at, -1);
  if (next >= 0) focusRowAt(next);
}

/** Where each entry sat in the file as opened, after one more delete. */
function followRenumbering(
  current: Origins,
  renumbered: Partial<Record<Collection, number[]>>,
): Origins {
  const next: Origins = { ...current };
  for (const [key, map] of Object.entries(renumbered) as [Collection, number[]][]) {
    const from = current[key];
    const kept: number[] = [];
    map.forEach((to, old) => {
      if (to !== -1) kept[to] = from?.[old] ?? old;
    });
    next[key] = kept;
  }
  return next;
}

/** A selection in the numbering of its file as opened, before any delete. */
function inFileNumbering(model: Model, ref: SelectionRef): SelectionRef {
  const numbered: SelectionRef = { ...ref };
  const { origins } = model;
  if (ref.node !== undefined) numbered.node = origins.nodes?.[ref.node] ?? ref.node;
  if (ref.mesh !== undefined) numbered.mesh = origins.meshes?.[ref.mesh] ?? ref.mesh;
  return numbered;
}

// ---------------------------------------------------------------------------
// Morph targets
//
// Blender's shape keys: a slider per target, written into the document as it
// moves. On an object's tab they are the weights that object is drawn with —
// its own when the file gives it some, else its mesh's; on the mesh's tab, the
// mesh's own. Either way the download carries them.

interface MorphSectionOptions {
  /** A heading in place of "Morph targets": whose they are, where several are listed. */
  title?: string;
  /** Buttons to go before Reset weights. */
  actions?: HTMLButtonElement[];
}

/** A mesh's morph targets, folded under a heading of their own the way a material's extensions are. */
function morphSection(
  model: Model,
  nodeIndex: number | undefined,
  meshIndex: number,
  options: MorphSectionOptions = {},
): HTMLElement | null {
  const json = model.json;
  const mesh = json.meshes?.[meshIndex];
  if (!mesh || morphTargetCount(mesh) === 0) return null;
  const node = nodeIndex === undefined ? undefined : json.nodes?.[nodeIndex];

  const details = document.createElement('details');
  details.className = `material-section morph-section${options.title === undefined ? '' : ' named'}`;
  const key = `${model.id}:mesh:${meshIndex}:morph`;
  details.dataset.key = key;
  details.open = sectionToggles.get(key) ?? true;
  const summary = document.createElement('summary');
  summary.textContent = options.title ?? 'Morph targets';
  summary.title =
    weightsHolder(node, mesh) === node
      ? 'Shape keys — saved as this object’s own weights, which the file gives it in place of its mesh’s'
      : 'Shape keys — saved in the file as the mesh’s weights';
  summary.addEventListener('click', () => sectionToggles.set(key, !details.open));
  details.append(summary);

  // Always drawn, only enabled once there is something to put back: appearing
  // on the first edit would mean rebuilding the panel in the middle of a drag.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'Button';
  reset.textContent = 'Reset weights';
  reset.title = 'Put these weights back the way the file had them';
  reset.disabled = !model.morphedMeshes.has(meshIndex);
  reset.addEventListener('click', () => resetMorphWeights(model, meshIndex));

  const weights = readWeights(node, mesh);
  morphTargetNames(mesh).forEach((name, target) => {
    details.append(
      morphRow(name ?? `Target ${target}`, weights[target], (value) => {
        setMorphWeight(model, nodeIndex, meshIndex, target, value);
        reset.disabled = false;
      }),
    );
  });

  const actions = document.createElement('div');
  actions.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  const buttons = document.createElement('span');
  buttons.className = 'Buttons';
  buttons.append(...(options.actions ?? []), reset);
  actions.append(spacer, buttons);
  details.append(actions);

  if (animatesWeights(json, nodeIndex === undefined ? nodesDrawing(json, meshIndex) : [nodeIndex])) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      'Its animations drive these weights too. While a clip holds the model the clip’s show; ' +
      'these are what it comes back to once stopped.';
    details.append(note);
  }
  return details;
}

/** One target: its name, a slider over the usual 0–1, and the exact weight, which may go past either end. */
function morphRow(name: string, weight: number, onChange: (value: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row morph-row';
  const label = document.createElement('span');
  label.className = 'Label';
  label.textContent = name;
  label.title = name;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'morph-slider';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.001';
  slider.value = String(weight);
  slider.setAttribute('aria-label', `${name} weight`);

  const field = numberField(weight, 0.01, `${name} weight`, (value) => {
    slider.value = String(value);
    onChange(value);
  });
  // `input` fires all through a drag, so the preview follows the slider live.
  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    field.value = formatNumber(value);
    onChange(value);
  });
  // Arrows move the weight here, not the outliner's selection.
  row.addEventListener('keydown', (event) => {
    if (TREE_KEYS.has(event.key)) event.stopPropagation();
  });

  row.append(label, slider, field);
  return row;
}

/** One set of weights a model's morph targets tab lists. */
interface MorphEntry {
  /** The object whose own weights these are; undefined for the mesh's. */
  node: number | undefined;
  mesh: number;
  /** The objects drawn with them: the one with its own, or those going by the mesh's. */
  nodes: number[];
}

/**
 * Every set of weights in a model, each once so no two sections edit the same
 * list: the mesh's own, shared by the objects that give none of their own —
 * usually just the one object — and those of each object that does. Mesh data
 * nothing draws is listed too, by itself.
 */
function morphEntries(model: Model): MorphEntry[] {
  const json = model.json;
  const entries: MorphEntry[] = [];
  (json.meshes ?? []).forEach((mesh, index) => {
    if (morphTargetCount(mesh) === 0) return;
    const drawing = nodesDrawing(json, index);
    const own = drawing.filter((node) => json.nodes?.[node]?.weights !== undefined);
    const shared = drawing.filter((node) => !own.includes(node));
    if (shared.length > 0 || drawing.length === 0) entries.push({ node: undefined, mesh: index, nodes: shared });
    for (const node of own) entries.push({ node, mesh: index, nodes: [node] });
  });
  return entries;
}

/**
 * A model's morph targets tab: a section per set of weights, headed by whose
 * they are, with the same sliders as that object's own tab and a way to it.
 */
function buildMorphPanel(model: Model, entries: MorphEntry[]): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'Panel';

  for (const entry of entries) {
    const first = entry.nodes[0];
    const kind: TargetKind = first === undefined ? 'mesh' : 'node';
    const index = first ?? entry.mesh;
    const name = getName(entryFor(model, kind, index) ?? {}) || `${kind === 'node' ? 'Node' : 'Mesh'} ${index}`;
    const others = entry.nodes.length - 1;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'Button';
    select.textContent = 'Select';
    select.title = `Select ${name} and show its own tab`;
    select.addEventListener('click', () => {
      propTab = kind;
      selectTarget(refForTarget(model, kind, index), { scroll: true });
    });

    const section = morphSection(model, entry.node, entry.mesh, {
      title: others > 0 ? `${name} +${others}` : name,
      actions: [select],
    });
    if (section) panel.append(section);
  }

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent =
    `Every morph target in ${model.fileName}, by the object drawing it. ` +
    'Each object’s own tab has the same sliders.';
  panel.append(note);
  return panel;
}

/** Opens the panel's morph targets and brings them into view, for a click that asked for them. */
function revealMorphs(): void {
  const section = propertiesEl.querySelector<HTMLDetailsElement>('.morph-section');
  if (!section) return;
  section.open = true;
  if (section.dataset.key) sectionToggles.set(section.dataset.key, true);
  section.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/** Writes one target's weight where it takes effect, and shows every object drawing the mesh blended by it. */
function setMorphWeight(
  model: Model,
  nodeIndex: number | undefined,
  meshIndex: number,
  target: number,
  value: number,
): void {
  const mesh = model.json.meshes?.[meshIndex];
  if (!mesh) return;
  writeWeight(nodeIndex === undefined ? undefined : model.json.nodes?.[nodeIndex], mesh, target, value);
  model.morphedMeshes.add(meshIndex);
  showMorphWeights(model, meshIndex);
  noteEdit(model);
}

/**
 * Draws every object showing a mesh with the weights it now has: its own, where
 * the file gives it some, else the mesh's.
 */
function showMorphWeights(model: Model, meshIndex: number): void {
  const current = viewer;
  const mesh = model.json.meshes?.[meshIndex];
  if (!current || !mesh) return;
  for (const index of nodesDrawing(model.json, meshIndex)) {
    current.setMorphWeights(model.id, index, readWeights(model.json.nodes?.[index], mesh));
  }
}

/**
 * Puts a mesh's weights back the way the file had them — the mesh's own, and
 * those of every object drawing it — read from the file as opened.
 */
function resetMorphWeights(model: Model, meshIndex: number): void {
  const mesh = model.json.meshes?.[meshIndex];
  const pristine = pristineJson(model);
  if (!mesh) return;
  if (!pristine) {
    showFlash('Could not reset: the original file is no longer available');
    return;
  }
  // A delete may have renumbered either collection since the file was opened.
  const { origins } = model;
  restoreWeights(mesh, pristine.meshes?.[origins.meshes?.[meshIndex] ?? meshIndex]);
  for (const index of nodesDrawing(model.json, meshIndex)) {
    const node = model.json.nodes?.[index];
    if (node) restoreWeights(node, pristine.nodes?.[origins.nodes?.[index] ?? index]);
  }
  model.morphedMeshes.delete(meshIndex);
  showMorphWeights(model, meshIndex);
  noteEdit(model);
  rebuildProperties();
  showFlash('Morph weights reset');
}

// ---------------------------------------------------------------------------
// Node transform

/**
 * Position, rotation and scale, the way the editor shows them: three draggable
 * numbers each, rotation in degrees. A node stating its transform as a matrix
 * is shown decomposed, and editing it writes plain TRS back.
 */
function transformRows(model: Model, index: number, node: GltfNode): HTMLElement[] {
  const trs = readNodeTransform(node);
  const fields: Record<TrsPart, HTMLInputElement[]> = { translation: [], rotation: [], scale: [] };

  const rows = [
    vectorRow('Position', 'translation', trs.translation, fields, 0.01),
    vectorRow('Rotation', 'rotation', quaternionToEuler(trs.rotation).map(toDegrees) as Vec3, fields, 1),
    vectorRow('Scale', 'scale', trs.scale, fields, 0.01),
  ];

  // Always drawn, only enabled once there is something to undo: appearing on
  // the first edit would mean rebuilding the panel in the middle of a drag.
  const row = document.createElement('div');
  row.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'Button';
  reset.textContent = 'Reset transform';
  reset.title = 'Put this node back where the file had it';
  reset.disabled = !model.movedNodes.has(index);
  reset.addEventListener('click', () => resetNodeTransform(model, index));
  const buttons = document.createElement('span');
  buttons.className = 'Buttons';
  buttons.append(reset);
  row.append(spacer, buttons);
  rows.push(row);

  propTransform = { model, node: index, fields, reset };
  return rows;
}

function vectorRow(
  label: string,
  part: TrsPart,
  values: Vec3,
  fields: Record<TrsPart, HTMLInputElement[]>,
  step: number,
  commit: (part: TrsPart, values: Vec3) => void = commitTransform,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row vector-row';
  const key = document.createElement('span');
  key.className = 'Label';
  key.textContent = label;
  row.append(key);

  const group = document.createElement('span');
  group.className = 'vector';
  values.forEach((value, axis) => {
    const input = numberField(value, step, `${label} ${'XYZ'[axis]}`, (next) => {
      const current = fields[part].map((field) => parseNumber(field.value)) as Vec3;
      current[axis] = next;
      commit(part, current);
    });
    fields[part].push(input);
    group.append(input);
  });
  row.append(group);
  return row;
}

/**
 * The editor's draggable number: drag across it to scrub the value, click to
 * type one. Dragging is what makes nudging an object in the panel bearable.
 */
function numberField(
  value: number,
  step: number,
  label: string,
  onChange: (value: number) => void,
  /** How many decimals it shows and nudges to: three, as the editor's do, unless a value is finer. */
  decimals = 3,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'Input Number';
  input.inputMode = 'decimal';
  input.spellcheck = false;
  input.value = formatNumber(value, decimals);
  input.setAttribute('aria-label', label);

  const commit = (next: number, live: boolean): void => {
    if (!Number.isFinite(next)) return;
    input.value = formatNumber(next, decimals);
    if (!live) input.dataset.value = String(next);
    onChange(next);
  };

  input.addEventListener('change', () => commit(parseNumber(input.value), false));
  input.addEventListener('keydown', (event) => {
    // Arrow keys nudge, as they do in the editor's number fields.
    const direction = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (direction === 0) {
      if (event.key === 'Enter') input.blur();
      return;
    }
    event.preventDefault();
    const scale = event.shiftKey ? 10 : 1;
    commit(round(parseNumber(input.value) + direction * step * scale, decimals), false);
  });

  // Scrubbing: the pointer is captured, so the drag survives leaving the input.
  let start: { x: number; value: number } | null = null;
  let dragged = false;
  input.addEventListener('pointerdown', (event) => {
    // Browsers still send pointer events to a disabled field, and it must not
    // be dragged any more than it can be typed into.
    if (input.disabled || event.button !== 0 || document.activeElement === input) return;
    // Keeps the press from focusing the field: it is a drag until it turns out
    // not to be, and only then does it focus. Without this the first drag would
    // also place a caret, and every later one would be a text selection.
    event.preventDefault();
    start = { x: event.clientX, value: parseNumber(input.value) };
    dragged = false;
    input.setPointerCapture(event.pointerId);
  });
  input.addEventListener('pointermove', (event) => {
    if (!start) return;
    const travelled = event.clientX - start.x;
    if (!dragged && Math.abs(travelled) < 2) return;
    if (!dragged) document.body.classList.add('scrubbing');
    dragged = true;
    commit(round(start.value + travelled * step * (event.shiftKey ? 10 : 1), decimals), true);
  });
  const end = (event: PointerEvent): void => {
    if (!start) return;
    if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
    document.body.classList.remove('scrubbing');
    // A press that never moved is a click, and a click means "let me type".
    if (!dragged) {
      input.focus();
      input.select();
    }
    start = null;
  };
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);

  return input;
}

/** Writes one part of the selected node's transform, and shows it moving. */
function commitTransform(part: TrsPart, values: Vec3): void {
  if (!propTransform) return;
  const { model, node: index } = propTransform;
  if (index === null) {
    commitPlacement(model, part, values);
    return;
  }
  const node = model.json.nodes?.[index];
  if (!node) return;

  const trs = readNodeTransform(node);
  if (part === 'rotation') trs.rotation = eulerToQuaternion(values.map(toRadians) as Vec3);
  else trs[part] = [...values];

  rememberTransform(model, index, node);
  writeNodeTransform(node, trs);
  settleTransform(model, index, node);
  viewer?.setNodeTransform(model.id, index, trs as NodeTrs);
  noteEdit(model);
}

/** The gizmo moved something: the document and the fields follow it. */
function applyGizmoTransform(id: number, index: number, trs: NodeTrs): void {
  const model = modelById(id);
  const node = model?.json.nodes?.[index];
  if (!model || !node) return;

  rememberTransform(model, index, node);
  writeNodeTransform(node, trs as Trs);
  settleTransform(model, index, node);
  noteEdit(model);

  if (propTransform?.model !== model || propTransform.node !== index) return;
  const shown = {
    translation: trs.translation,
    rotation: quaternionToEuler(trs.rotation).map(toDegrees) as Vec3,
    scale: trs.scale,
  };
  for (const part of ['translation', 'rotation', 'scale'] as TrsPart[]) {
    propTransform.fields[part].forEach((field, axis) => {
      // Never overwrite the field being typed into.
      if (field !== document.activeElement) field.value = formatNumber(shown[part][axis]);
    });
  }
}

/**
 * Where a model sits in the scene, in the three rows a node's transform takes.
 * It is the scene's, not the file's: moving a model whole writes nothing into
 * its document, and a download leaves the model where its file has it.
 */
function placementRows(model: Model): HTMLElement[] {
  const trs = model.placement ?? DEFAULT_TRS;
  const fields: Record<TrsPart, HTMLInputElement[]> = { translation: [], rotation: [], scale: [] };

  const rows = [
    vectorRow('Position', 'translation', trs.translation, fields, 0.01),
    vectorRow('Rotation', 'rotation', quaternionToEuler(trs.rotation).map(toDegrees) as Vec3, fields, 1),
    vectorRow('Scale', 'scale', trs.scale, fields, 0.01),
  ];

  const row = document.createElement('div');
  row.className = 'Row';
  const spacer = document.createElement('span');
  spacer.className = 'Label';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'Button';
  reset.textContent = 'Reset placement';
  reset.title = 'Put the model back where its file has it. Where it sits in the scene is never downloaded.';
  reset.disabled = model.placement === null;
  reset.addEventListener('click', () => {
    placeModel(model, null);
    rebuildProperties();
  });
  const buttons = document.createElement('span');
  buttons.className = 'Buttons';
  buttons.append(reset);
  row.append(spacer, buttons);
  rows.push(row);

  propTransform = { model, node: null, fields, reset };
  return rows;
}

/** Writes one part of where a model sits, and shows it moving. */
function commitPlacement(model: Model, part: TrsPart, values: Vec3): void {
  const trs: Trs = structuredClone(model.placement ?? DEFAULT_TRS);
  if (part === 'rotation') trs.rotation = eulerToQuaternion(values.map(toRadians) as Vec3);
  else trs[part] = [...values];
  placeModel(model, trs);
}

/**
 * Puts a model somewhere in the scene, or — with null, or anywhere that is where
 * its file has it anyway — back where its file has it.
 */
function placeModel(model: Model, trs: NodeTrs | null): void {
  model.placement = trs === null || isRestingPlacement(trs) ? null : trs;
  recordModelEdit(model);
  viewer?.setModelPlacement(model.id, model.placement);
  if (propTransform?.model === model && propTransform.node === null) {
    propTransform.reset.disabled = model.placement === null;
  }
  scheduleViewSave();
}

/** The gizmo moved a model whole: the fields follow it, and the session keeps it. */
function applyGizmoPlacement(id: number, trs: NodeTrs): void {
  const model = modelById(id);
  if (!model) return;
  // The viewer has already put it there; only the app's copy has to catch up.
  model.placement = isRestingPlacement(trs) ? null : trs;
  recordModelEdit(model);
  scheduleViewSave();

  if (propTransform?.model !== model || propTransform.node !== null) return;
  propTransform.reset.disabled = model.placement === null;
  const shown = {
    translation: trs.translation,
    rotation: quaternionToEuler(trs.rotation).map(toDegrees) as Vec3,
    scale: trs.scale,
  };
  for (const part of ['translation', 'rotation', 'scale'] as TrsPart[]) {
    propTransform.fields[part].forEach((field, axis) => {
      if (field !== document.activeElement) field.value = formatNumber(shown[part][axis]);
    });
  }
}

/** Whether a placement leaves a model exactly where its file has it. */
function isRestingPlacement(trs: NodeTrs): boolean {
  const same = (a: number[], b: number[]) => a.every((value, axis) => Math.abs(value - b[axis]) < 1e-9);
  return (
    same(trs.translation, DEFAULT_TRS.translation) &&
    same(trs.rotation, DEFAULT_TRS.rotation) &&
    same(trs.scale, DEFAULT_TRS.scale)
  );
}

/** Keeps the file's own transform for this node, the first time it is moved. */
function rememberTransform(model: Model, index: number, node: GltfNode): void {
  if (model.movedNodes.has(index)) return;
  model.movedNodes.set(index, captureNodeTransform(node));
  updateTransformReset(model, index);
}

/**
 * Drops the "moved" mark when a node ends up written exactly as the file had
 * it, so putting something back really does undo the change.
 */
function settleTransform(model: Model, index: number, node: GltfNode): void {
  const original = model.movedNodes.get(index);
  if (!original || !sameTransform(original, captureNodeTransform(node))) return;
  model.movedNodes.delete(index);
  updateTransformReset(model, index);
}

function updateTransformReset(model: Model, index: number): void {
  if (propTransform?.model !== model || propTransform.node !== index) return;
  propTransform.reset.disabled = !model.movedNodes.has(index);
}

function resetNodeTransform(model: Model, index: number): void {
  const saved = model.movedNodes.get(index);
  const node = model.json.nodes?.[index];
  if (!saved || !node) return;

  restoreNodeTransform(node, saved);
  model.movedNodes.delete(index);
  viewer?.setNodeTransform(model.id, index, readNodeTransform(node) as NodeTrs);
  noteEdit(model);
  rebuildProperties();
  showFlash('Transform reset');
}

/** Drops the panel's memo of what it drew, so the next render rebuilds it. */
function rebuildProperties(): void {
  propSignature = '';
  renderProperties();
}

function setGizmoMode(mode: GizmoMode): void {
  gizmoMode = mode;
  viewer?.setGizmoMode(mode);
  updateMoveButtons();
}

function setGizmoSpace(space: 'local' | 'world'): void {
  gizmoSpace = space;
  viewer?.setGizmoSpace(space);
  updateMoveButtons();
}

function setGizmoEnabled(enabled: boolean): void {
  gizmoEnabled = enabled;
  viewer?.setGizmoEnabled(enabled);
  updateMoveButtons();
}

const GIZMO_KEYS: Record<GizmoMode, string> = { translate: 'W', rotate: 'E', scale: 'R' };

function updateMoveButtons(): void {
  for (const [mode, button] of Object.entries(gizmoButtons) as [GizmoMode, HTMLButtonElement][]) {
    const active = gizmoEnabled && gizmoMode === mode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = viewer === null;
    // A node moves, and so does a model as a whole — but a node not while a
    // clip poses its model, so the buttons say when there is nothing to.
    const picked = objectById(pickedObject);
    const what = picked
      ? hasTransform(picked.kind)
        ? 'the selected object'
        : 'Select something that has a place first — an ambient light has none'
      : selection && isWholeModel(selection)
        ? 'the selected model'
        : selection?.node === undefined
          ? 'Select a node, a model or an object first'
          : viewer?.isPosed(selection.model)
            ? 'the selected node, once its animation is stopped'
            : 'the selected node';
    button.title = `${button.textContent?.trim()} ${what} (${GIZMO_KEYS[mode]})`;
  }
  spaceBtn.textContent = gizmoSpace === 'world' ? 'World' : 'Local';
  spaceBtn.disabled = viewer === null;
  updateMenus();
}

/** Short enough to read in a narrow field, exact enough to type back in. */
function formatNumber(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return '0';
  return String(round(value, decimals));
}

function round(value: number, decimals = 3): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function parseNumber(text: string): number {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : 0;
}

function entryFor(model: Model, kind: TargetKind, index: number): NamedEntry | undefined {
  if (kind === 'node') return model.json.nodes?.[index];
  if (kind === 'mesh') return model.json.meshes?.[index];
  return model.json.materials?.[index];
}

/** A name field, kept in step with every other one showing its entry through `fields`. */
function nameRow(
  model: Model,
  kind: TargetKind | 'scene' | 'animation',
  index: number,
  entry: NamedEntry | undefined,
  text = 'Name',
  fields: PropField[] = propFields,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const label = document.createElement('span');
  label.className = 'Label';
  label.textContent = text;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'Input';
  input.spellcheck = false;
  input.placeholder = '(unnamed)';
  input.setAttribute('aria-label', `${kind} ${index} name`);

  if (entry) {
    const original = rowsByEntry.get(entry)?.[0]?.original ?? keptOriginal(entry)?.name ?? getName(entry);
    input.value = getName(entry);
    input.classList.toggle('modified', input.value !== original);
    input.addEventListener('input', () => applyNameEdit(model, entry, input));
    input.addEventListener('blur', () => settleNameEdit(model, entry, input));
    fields.push({ model, entry, input, original });
  } else {
    input.disabled = true;
  }

  row.append(label, input);
  return row;
}

/**
 * The same choice the outliner puts beside a mesh, in the panel: which of the
 * mesh's materials the tab is showing. It only appears for a mesh that has more
 * than one, the way the editor's material panel only offers a slot when there
 * is a slot to pick.
 */
function materialSlotRow(
  model: Model,
  node: number | undefined,
  mesh: number,
  current: number,
  uses: number[],
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row material-row';
  const label = document.createElement('span');
  label.className = 'Label';
  label.textContent = 'Material';

  const select = document.createElement('select');
  select.className = 'Select';
  select.setAttribute('aria-label', 'Which of the mesh materials to show');
  for (const material of uses) {
    const option = document.createElement('option');
    option.value = String(material);
    option.textContent = materialLabel(getName(entryFor(model, 'material', material) ?? {}), material);
    select.append(option);
  }
  select.value = String(current);
  select.addEventListener('change', () => {
    propTab = 'material';
    selectTarget(asideRef(model, node, mesh, Number(select.value)));
  });

  row.append(label, select);
  return row;
}

function valueRow(label: string, value: string, numeric = false): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const key = document.createElement('span');
  key.className = 'Label';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = numeric ? 'Value number' : 'Value';
  val.textContent = value;
  row.append(key, val);
  return row;
}

/** A row that moves the selection to a related entry, like the editor's links. */
function linkRow(model: Model, label: string, kind: TargetKind, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const key = document.createElement('span');
  key.className = 'Label';
  key.textContent = label;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'Button';
  button.textContent = getName(entryFor(model, kind, index) ?? {}) || `${kind} ${index}`;
  button.addEventListener('click', () => {
    // Set first: the panel keeps the tab when the new selection still has it.
    propTab = kind;
    selectTarget(refForTarget(model, kind, index), { scroll: true });
  });

  row.append(key, button);
  return row;
}

/** The panel's "visible" box; a null kind is the model as a whole. */
function visibleRow(model: Model, kind: TargetKind | null, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const key = document.createElement('label');
  key.className = 'Label';
  key.textContent = 'Visible';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `prop-visible-${model.id}-${kind ?? 'model'}-${index}`;
  key.setAttribute('for', input.id);
  input.checked = viewer ? toggleShowsVisible(model, kind, index) : true;
  input.disabled = viewer === null;
  input.addEventListener('change', () => {
    if (kind === null) toggleModelVisibility(model);
    else toggleTargetVisibility(model, kind, index);
  });

  propToggles.push({ model, kind, index, input });
  row.append(key, input);
  return row;
}

/**
 * The editor's Shadow row for a mesh node: whether it throws a shadow and
 * whether one falls on it. Kept in the node's extras, so it goes into the file.
 */
function nodeShadowRow(model: Model, index: number): HTMLElement {
  const node = model.json.nodes?.[index];
  const row = shadowFlagsRow(readShadowFlags(node?.extras), `${model.id}-node-${index}`, (flag, on) => {
    if (!node) return;
    if (applyNodeShadow(model, index, { ...readShadowFlags(node.extras), [flag]: on })) noteEdit(model);
  });
  row.title = 'Saved in the node’s extras as castShadow / receiveShadow';
  return row;
}

/**
 * The same two boxes for the whole file: every mesh node at once, since ticking
 * a hundred of them one by one is no way to see a model's shadow. A box shows a
 * dash while the nodes disagree; a click then sets them all.
 */
function modelShadowRow(model: Model): HTMLElement | null {
  const nodes = model.json.nodes ?? [];
  const meshNodes = nodes.flatMap((node, index) => (node.mesh !== undefined ? [index] : []));
  if (meshNodes.length === 0) return null;
  const flagsOf = (index: number): ShadowFlags => readShadowFlags(nodes[index]?.extras);
  const all = meshNodes.length;
  const casting = meshNodes.filter((index) => flagsOf(index).cast).length;
  const receiving = meshNodes.filter((index) => flagsOf(index).receive).length;
  const row = shadowFlagsRow(
    { cast: casting === all, receive: receiving === all },
    `${model.id}-model`,
    (flag, on) => {
      let changed = false;
      for (const index of meshNodes) {
        if (applyNodeShadow(model, index, { ...flagsOf(index), [flag]: on })) changed = true;
      }
      if (changed) noteEdit(model);
    },
    { cast: casting > 0 && casting < all, receive: receiving > 0 && receiving < all },
  );
  row.title = `Every node in the file that draws a mesh — ${plural(all, 'node')} — saved in each one’s extras`;
  return row;
}

/**
 * "Shadow: [ ] cast [ ] receive", as the editor's Object panel has it. A flag
 * shown as a dash stands for several objects that disagree; clicking it sets
 * them all.
 */
function shadowFlagsRow(
  flags: ShadowFlags,
  key: string,
  onChange: (flag: keyof ShadowFlags, on: boolean) => void,
  mixed?: ShadowFlags,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const label = document.createElement('span');
  label.className = 'Label';
  label.textContent = 'Shadow';
  const checks = document.createElement('span');
  checks.className = 'checks';
  for (const [flag, hint] of [
    ['cast', 'Throws a shadow onto whatever receives one'],
    ['receive', 'Shadows thrown by others fall on it'],
  ] as const) {
    const box = document.createElement('label');
    box.title = hint;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `prop-shadow-${flag}-${key}`;
    input.checked = flags[flag];
    input.indeterminate = mixed?.[flag] === true;
    input.addEventListener('change', () => onChange(flag, input.checked));
    box.append(input, document.createTextNode(flag));
    checks.append(box);
  }
  row.append(label, checks);
  return row;
}

/**
 * Writes a node's shadow flags into its extras and shows them, remembering what
 * the file said so the edit counts — and forgetting it again once put back, the
 * way a moved node stops counting when its transform is. Says whether anything
 * changed, so a caller can note one edit for many nodes.
 */
function applyNodeShadow(model: Model, index: number, flags: ShadowFlags): boolean {
  const node = model.json.nodes?.[index];
  if (!node) return false;
  const before = readShadowFlags(node.extras);
  if (sameShadowFlags(before, flags)) return false;
  const original = model.shadowEdits.get(index) ?? before;
  writeShadowFlags(node, flags);
  if (sameShadowFlags(original, flags)) model.shadowEdits.delete(index);
  else model.shadowEdits.set(index, original);
  viewer?.setNodeShadow(model.id, index, flags);
  return true;
}

function nodeTypeLabel(model: Model, index: number): string {
  const node = model.json.nodes?.[index];
  if (!node) return '—';
  if (node.mesh !== undefined) return 'Mesh';
  if (node.camera !== undefined) return 'Camera';
  if (node.extensions?.KHR_lights_punctual !== undefined) return 'Light';
  for (const skin of model.json.skins ?? []) {
    if (skin.joints?.includes(index)) return 'Bone';
  }
  return 'Group';
}

/** Repaints every eye and visibility box to match what is actually on screen. */
function refreshVisibilityState(): void {
  if (!viewer) return;
  for (const row of rows) {
    if (isObjectRow(row)) {
      paintObjectEye(row);
      continue;
    }
    if (!row.eyeBtn || row.eyeBtn.hidden) continue;
    const { model } = row;
    // A model's root row hides the whole file, which nothing else can hide.
    const state: HiddenState = row.target
      ? viewer.hiddenState(model.id, row.target.kind, row.target.index)
      : { reason: viewer.isModelHidden(model.id) ? 'self' : null };
    const name = row.input.value || `${row.label} ${row.index}`;

    row.eyeBtn.innerHTML = iconSvg(state.reason === null ? 'eye' : 'eyeOff');
    row.eyeBtn.classList.toggle('off', state.reason !== null);
    row.el.classList.toggle('hidden-3d', state.reason !== null);
    row.el.classList.toggle('hidden-indirect', state.reason !== null && state.reason !== 'self');

    // The label states the situation and what the click will do, since one
    // button covers "hide", "show" and "show whatever is hiding this".
    if (state.reason === 'self') {
      row.eyeBtn.title = `${name} is hidden — click to show it`;
    } else if (state.reason === 'model') {
      row.eyeBtn.title = `Hidden because ${model.fileName} is hidden — click to show it`;
    } else if (state.reason === 'ancestor') {
      row.eyeBtn.title = `Hidden because ${describeTarget(model, 'node', state.byNode)} is hidden — click to show that`;
    } else if (state.reason === 'mesh') {
      row.eyeBtn.title = `Hidden because ${describeTarget(model, 'mesh', state.byMesh)} is hidden — click to show that`;
    } else {
      row.eyeBtn.title = `Hide ${name}`;
    }
    row.eyeBtn.setAttribute('aria-label', row.eyeBtn.title);
  }

  for (const toggle of propToggles) {
    toggle.input.checked = toggleShowsVisible(toggle.model, toggle.kind, toggle.index);
  }
  if (propObject) {
    propObject.visible.checked = viewer.objectHiddenState(propObject.id).reason === null;
    propObject.visible.disabled = false;
  }
  showAllBtn.hidden = !viewer.anyHidden();
  updateMenus();
}

/** Whether a "visible" box should be ticked; a null kind is the model itself. */
function toggleShowsVisible(model: Model, kind: TargetKind | null, index: number): boolean {
  if (!viewer) return true;
  if (kind === null) return !viewer.isModelHidden(model.id);
  return viewer.hiddenState(model.id, kind, index).reason === null;
}

/** How to refer to whatever is doing the hiding, using its current name. */
function describeTarget(model: Model, kind: TargetKind, index: number | undefined): string {
  if (index === undefined) return 'something above it';
  // From the document, not from a row: an object's row stands in for its mesh
  // data as well, and its name is the object's.
  const name = getName(entryFor(model, kind, index) ?? {});
  return name ? `${kind} "${name}"` : `${kind} ${index}`;
}

function toggleTargetVisibility(model: Model, kind: TargetKind, index: number): void {
  if (!viewer || kind === 'material') return;
  const state = viewer.hiddenState(model.id, kind, index);
  // Clicking the eye of something hidden by something else should reveal that,
  // rather than appear to do nothing (or hide it twice over).
  if (state.reason === 'model') {
    viewer.setModelHidden(model.id, false);
    showFlash(`Showed ${model.fileName}, which was hiding it`);
  } else if (state.reason === 'ancestor' && state.byNode !== undefined) {
    viewer.setHidden(model.id, 'node', state.byNode, false);
    showFlash(`Showed ${describeTarget(model, 'node', state.byNode)}, which was hiding it`);
  } else if (state.reason === 'mesh' && state.byMesh !== undefined) {
    viewer.setHidden(model.id, 'mesh', state.byMesh, false);
    showFlash(`Showed ${describeTarget(model, 'mesh', state.byMesh)}, which was hiding it`);
  } else {
    viewer.toggleHidden(model.id, kind === 'node' ? 'node' : 'mesh', index);
  }
  refreshVisibilityState();
}

/** Hides or shows a whole file, from its root row or its panel. */
function toggleModelVisibility(model: Model): void {
  if (!viewer) return;
  viewer.setModelHidden(model.id, !viewer.isModelHidden(model.id));
  refreshVisibilityState();
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// Sidebar tabs & resizer

function setTab(tab: SidebarTab): void {
  for (const span of tabsEl.querySelectorAll<HTMLElement>('span[data-tab]')) {
    span.classList.toggle('selected', span.dataset.tab === tab);
  }
  for (const name of SIDEBAR_TABS) {
    $(`#tab-${name}`).hidden = name !== tab;
  }
  sidebar.scrollTop = 0;
  sidebarTab = tab;
  scheduleViewSave();
}

let sidebarWidth = 350;

/**
 * Applies the width only. Storage is synchronous, and this runs on every
 * pointer move of a drag, so persisting is left to `saveSidebarWidth`.
 */
function setSidebarWidth(width: number): void {
  const max = Math.max(280, window.innerWidth - 240);
  const clamped = Math.min(Math.max(width, 280), Math.min(720, max));
  if (clamped === sidebarWidth) return;
  sidebarWidth = clamped;
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
}

function saveSidebarWidth(): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
  } catch {
    // Private-mode storage failures are not worth surfacing.
  }
}

function initSidebarWidth(): void {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_KEY));
    if (Number.isFinite(saved) && saved > 0) setSidebarWidth(saved);
  } catch {
    // ignored
  }
}

// ---------------------------------------------------------------------------
// Menubar

function closeMenus(): void {
  for (const menu of menubar.querySelectorAll<HTMLElement>('.menu.open')) {
    menu.classList.remove('open');
  }
}

function menuOption(action: string): HTMLElement | null {
  return menubar.querySelector<HTMLElement>(`.option[data-action="${action}"]`);
}

function setOptionInactive(action: string, inactive: boolean): void {
  menuOption(action)?.classList.toggle('inactive', inactive);
}

function updateMenus(): void {
  const open = models.length > 0;
  for (const action of ['download', 'reset', 'reset-all', 'close', 'find']) {
    setOptionInactive(action, !open);
  }
  // A scene of its own has an outliner to filter and fold, and is put away with the models.
  for (const action of ['close-all', 'collapse', 'filter']) {
    setOptionInactive(action, !open && !sceneStarted);
  }
  setOptionInactive('undo', !canUndo());
  setOptionInactive('redo', history.redo.length === 0);
  setOptionInactive('delete-scene', sceneList.length <= 1);
  setOptionInactive('delete', !canDelete(selection) && pickedObject === null);
  setOptionInactive('frame', viewer === null);
  setOptionInactive('isolate', viewer === null || (selection === null && pickedObject === null));
  setOptionInactive('show-all', viewer === null || !viewer.anyHidden());

  const grid = menuOption('grid');
  grid?.classList.toggle('toggle-on', gridVisible);

  menuOption('gizmo')?.classList.toggle('toggle-on', gizmoEnabled);
  menuOption('space')?.classList.toggle('toggle-on', gizmoSpace === 'local');
  for (const mode of ['translate', 'rotate', 'scale'] as GizmoMode[]) {
    menuOption(`mode-${mode}`)?.classList.toggle('toggle-on', gizmoEnabled && gizmoMode === mode);
    setOptionInactive(`mode-${mode}`, viewer === null);
  }
  setOptionInactive('gizmo', viewer === null);
  setOptionInactive('space', viewer === null || !gizmoEnabled);

  // Playback is the active model's, as the Animations tab is; its key hint follows the text.
  const animated = canPlay() ? activeModel : null;
  const playback = animated ? (viewer?.playback(animated.id) ?? null) : null;
  const play = menuOption('play');
  if (play?.firstChild) {
    play.firstChild.textContent = playback?.playing ? 'Pause animation' : 'Play animation';
  }
  setOptionInactive('play', playback === null);
  setOptionInactive('stop', playback === null || playback.clip === null);

  const collapse = menuOption('collapse');
  if (collapse) collapse.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
}

function runMenuAction(action: string | undefined): void {
  const kind = addedKind(action);
  if (kind) {
    addSceneObject(kind);
    return;
  }
  switch (action) {
    case 'open':
      fileInput.click();
      break;
    case 'open-folder':
    // An exported scene is a folder too, and Open folder recognises one by its
    // ___main.json; this is the same picker, under the name to look for it by.
    case 'import-scene':
      folderInput.click();
      break;
    case 'download':
      void exportModel();
      break;
    case 'reset':
      resetAll();
      break;
    case 'reset-all':
      resetModel();
      break;
    case 'close':
      closeModel();
      break;
    case 'close-all':
      clearScene();
      break;
    case 'new-scene':
      newScene();
      break;
    case 'rename-scene':
      setTab('scene');
      beginSceneRename();
      break;
    case 'delete-scene':
      deleteScene();
      break;
    case 'undo':
      undo();
      break;
    case 'redo':
      redo();
      break;
    case 'delete':
      deleteSelection();
      break;
    case 'find':
      setTab('tools');
      findInput.focus();
      break;
    case 'filter':
      setTab('scene');
      searchInput.focus();
      break;
    case 'grid':
      setGridVisible(!gridVisible);
      break;
    case 'gizmo':
      setGizmoEnabled(!gizmoEnabled);
      break;
    case 'space':
      setGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world');
      break;
    case 'mode-translate':
      setGizmoMode('translate');
      break;
    case 'mode-rotate':
      setGizmoMode('rotate');
      break;
    case 'mode-scale':
      setGizmoMode('scale');
      break;
    case 'frame':
      viewer?.frameAll();
      break;
    case 'isolate':
      isolateSelection();
      break;
    case 'show-all':
      viewer?.showAll();
      refreshVisibilityState();
      break;
    case 'play':
      togglePlayback();
      break;
    case 'stop':
      stopPlayback();
      break;
    case 'collapse':
      setAllCollapsed(!allCollapsed);
      break;
    case 'about':
      setTab('tools');
      break;
    case 'source':
      window.open(GITHUB_URL, '_blank', 'noopener');
      break;
  }
}

// ---------------------------------------------------------------------------
// Keyboard navigation

const TREE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Fields whose text is no part of any document, and so undo their own typing. */
function ownsTextUndo(element: Element | null): boolean {
  return (
    element instanceof HTMLTextAreaElement ||
    element === searchInput ||
    element === findInput ||
    element === replaceInput ||
    element === sceneNameInput
  );
}

function isTextEntry(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

/** The name field of a row, if that is what has focus. */
function focusedNameField(): HTMLInputElement | null {
  const element = document.activeElement;
  if (!(element instanceof HTMLInputElement)) return null;
  return element.closest('li.row') === null ? null : element;
}

/**
 * True while a name is open for editing, which is what hands the left/right
 * keys back to the caret: a row that is merely selected keeps them for the
 * tree.
 */
function isEditingName(element: Element | null): boolean {
  if (!(element instanceof HTMLInputElement) || element.closest('li.row') === null) return false;
  return !element.readOnly;
}

/**
 * Names are labels until a row is picked twice, the way a file name is in a
 * file browser: the first click selects the row, the second opens the name for
 * editing. A read-only field is still focusable, which is what lets the arrow
 * keys walk the tree without ever touching a name.
 */
function beginRename(input: HTMLInputElement): void {
  // The model row is the file it came from, not a name inside it.
  if (input.closest('li.row')?.classList.contains('fixed')) {
    input.focus();
    return;
  }
  input.readOnly = false;
  input.focus();
  input.select();
}

/** Ends the rename without leaving the row, so the tree keys come back. */
function endRename(input: HTMLInputElement): void {
  input.readOnly = true;
  input.select();
  // Enter and Escape end an edit without a blur, so a rejected name is settled
  // here too rather than lingering in a field that is a label again.
  const field = entryForInput(input);
  if (field) settleNameEdit(field.model, field.entry, input);
}

/** A row is reachable only while on screen: collapsed, filtered-out and
 *  inactive-tab rows all report no offset parent, so one test covers them. */
function rowIsVisible(row: OutlinerRow): boolean {
  return row.el.offsetParent !== null;
}

function rowPositionOf(element: Element | null): number {
  const rowEl = element instanceof Element ? element.closest<HTMLLIElement>('li.row') : null;
  if (!rowEl || rowEl.dataset.row === undefined) return -1;
  const position = Number(rowEl.dataset.row);
  return rows[position] ? position : -1;
}

/** The first row at or after `from` that the user can see, walking `step`. */
function seekVisible(from: number, step: number): number {
  for (let position = from; position >= 0 && position < rows.length; position += step) {
    if (rowIsVisible(rows[position])) return position;
  }
  return -1;
}

function focusRowAt(position: number): void {
  const row = rows[position];
  if (!row) return;
  // Focusing the name field is what selects the row (see addRow); leaving the
  // text fully selected is the signal that the row is being navigated, not
  // edited — and it means typing immediately replaces the name.
  row.input.focus();
  row.input.select();
  row.el.scrollIntoView({ block: 'nearest' });
}

/** The row the arrow keys move from: the focused one, else the selected one. */
function anchorRow(): number {
  const focused = rowPositionOf(document.activeElement);
  if (focused >= 0) return focused;
  const picked = objectById(pickedObject);
  const selected = picked ? objectRowsFor(picked) : selection ? rowsForRef(selection) : [];
  for (const row of selected) {
    if (rowIsVisible(row)) return Number(row.el.dataset.row);
  }
  return -1;
}

/**
 * Outliner keys, the way a tree widget behaves: up/down walk the visible rows,
 * left closes a row (or steps out to its parent) and right opens it (or steps
 * in to its first child). Returns whether the key was used.
 */
function handleTreeKey(event: KeyboardEvent): boolean {
  if (!TREE_KEYS.has(event.key)) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (rows.length === 0) return false;

  let position = anchorRow();
  // Typing in the filter or find fields keeps its own arrow keys, even when a
  // row is selected elsewhere.
  if (position < 0 && isTextEntry(document.activeElement)) return false;

  if (position < 0) {
    // Nothing to move from yet, so the ends of the list are the starting
    // points — but only for someone already working inside the sidebar.
    if (!sidebar.contains(event.target as Node)) return false;
    position =
      event.key === 'ArrowUp' ? seekVisible(rows.length - 1, -1) : seekVisible(0, 1);
    if (position < 0) return false;
    focusRowAt(position);
    return true;
  }

  const row = rows[position];

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = seekVisible(position + step, step);
    if (next < 0) return false;
    focusRowAt(next);
    return true;
  }

  if (isEditingName(document.activeElement)) return false;

  // While a filter is active the tree is shown flat, so opening and closing
  // rows would have no visible effect; the keys only step around.
  const collapsible = row.hasChildren && searchInput.value.trim() === '';

  if (event.key === 'ArrowRight') {
    if (collapsible && collapsedRows.has(position)) {
      toggleDisclosure(position, row);
      return true;
    }
    if (!row.hasChildren) return false;
    const child = seekVisible(position + 1, 1);
    if (child < 0 || rows[child].depth <= row.depth) return false;
    focusRowAt(child);
    return true;
  }

  if (collapsible && !collapsedRows.has(position)) {
    toggleDisclosure(position, row);
    return true;
  }
  // Flat rows have no parent to step out to, so they never pay for the scan.
  if (row.depth === 0) return false;
  for (let above = position - 1; above >= 0; above--) {
    if (rows[above].depth < row.depth && rowIsVisible(rows[above])) {
      focusRowAt(above);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Errors

function showError(message: string): void {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
  setTimeout(hideError, 6000);
}

function hideError(): void {
  errorBanner.hidden = true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Wiring

browseBtn.addEventListener('click', () => fileInput.click());
browseFolderBtn.addEventListener('click', () => folderInput.click());
for (const input of [fileInput, folderInput]) {
  input.addEventListener('change', () => {
    if (input.files?.length) void openFiles(pickedFromList(input.files));
  });
}

// The scene picker above the tabs.
sceneSwitch.addEventListener('change', () => switchScene(Number(sceneSwitch.value)));
sceneNewBtn.addEventListener('click', () => newScene());
sceneRenameBtn.addEventListener('click', () => beginSceneRename());
sceneDeleteBtn.addEventListener('click', () => deleteScene());
sceneNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    closeSceneRename(true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSceneRename(false);
  }
  // Typing a name must not reach the bare-key shortcuts: W, E, R, F, Delete.
  if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
});
sceneNameInput.addEventListener('blur', () => closeSceneRename(true));

// The file dialog opened by a texture slot's "Add image…".
imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  const slot = pendingSlot;
  pendingSlot = null;
  imageInput.value = '';
  if (!file || !slot) return;
  void addImageToSlot(slot.model, { path: file.name, file }, slot.material, slot.slot);
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dragover');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragover');
  if (!event.dataTransfer) return;
  // Called before any await, while the drop's items can still be read.
  void collectDroppedFiles(event.dataTransfer).then((picked) => {
    if (picked.length > 0) void openFiles(picked);
  });
});

// Menus: click to open, then hover to walk across the bar.
menubar.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const option = target.closest<HTMLElement>('.option');
  if (option) {
    if (option.classList.contains('inactive')) return;
    closeMenus();
    runMenuAction(option.dataset.action);
    return;
  }
  const menu = target.closest<HTMLElement>('.menu');
  if (!menu || menu.classList.contains('brand') || menu.classList.contains('right')) return;
  const wasOpen = menu.classList.contains('open');
  closeMenus();
  if (!wasOpen) menu.classList.add('open');
});

menubar.addEventListener('pointerover', (event) => {
  if (menubar.querySelector('.menu.open') === null) return;
  const menu = (event.target as HTMLElement).closest<HTMLElement>('.menu');
  if (!menu || menu.classList.contains('brand') || menu.classList.contains('right')) return;
  if (menu.classList.contains('open')) return;
  closeMenus();
  menu.classList.add('open');
});

document.addEventListener('pointerdown', (event) => {
  if (!menubar.contains(event.target as Node)) closeMenus();
});

tabsEl.addEventListener('click', (event) => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>('span[data-tab]');
  if (tab?.dataset.tab) setTab(tab.dataset.tab as SidebarTab);
});
tabsEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const tab = (event.target as HTMLElement).closest<HTMLElement>('span[data-tab]');
  if (!tab?.dataset.tab) return;
  event.preventDefault();
  setTab(tab.dataset.tab as SidebarTab);
});

// One delegated listener rather than four per row: large files have many rows.
/**
 * Which name a click could open for editing. Read on pointerdown because the
 * press itself selects and focuses the row: by the time the click arrives,
 * every row looks like one that was already picked.
 */
let renameArmed: HTMLInputElement | null = null;

/**
 * A Ctrl, ⌘ or Shift click on an outliner row itself — not on one of its
 * buttons, nor in a name being typed — which adds to the selection.
 */
function isSelectionClick(event: MouseEvent, target: HTMLElement): boolean {
  if (!(event.ctrlKey || event.metaKey || event.shiftKey) || event.button !== 0) return false;
  const rowEl = target.closest<HTMLLIElement>('li.row');
  if (!rowEl || rowEl === sceneRootEl || !outlinerEl.contains(rowEl)) return false;
  if (target.closest('button, select')) return false;
  return !(target instanceof HTMLInputElement && !target.readOnly);
}

sidebar.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement;
  renameArmed = null;
  if (isSelectionClick(event, target)) {
    // A press that adds to the selection must not focus the name field: its
    // focus selects that row on its own. Nor start a text selection on Shift.
    event.preventDefault();
    return;
  }
  if (!(target instanceof HTMLInputElement) || !target.readOnly) return;
  const rowEl = target.closest<HTMLLIElement>('li.row');
  if (!rowEl) return;
  // Already selected, or already the field the keyboard is on — rows that own
  // nothing in the 3D scene are never "selected", so focus counts too.
  if (rowEl.classList.contains('selected') || document.activeElement === target) {
    renameArmed = target;
  }
});

sidebar.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const rowEl = target.closest<HTMLLIElement>('li.row');
  if (!rowEl) return;
  if (rowEl === sceneRootEl) {
    handleSceneRootClick(target);
    return;
  }
  const position = rowEl.dataset.row === undefined ? -1 : Number(rowEl.dataset.row);
  const row = rows[position];
  if (!row) return;

  if (target === renameArmed) {
    beginRename(renameArmed);
    renameArmed = null;
    return;
  }

  const button = target.closest<HTMLButtonElement>('button[data-action]');
  if (isSelectionClick(event, target) && clickSelect(row, position, event)) return;
  if (isObjectRow(row)) {
    handleObjectRowClick(row, position, button);
    return;
  }
  if (!button) {
    // Clicking the row itself selects it, the way the editor's outliner does —
    // but a field being typed into and an open dropdown are their own business.
    if (target.tagName !== 'INPUT' && target.tagName !== 'SELECT') selectTarget(refFor(row));
    return;
  }

  switch (button.dataset.action) {
    case 'revert':
      setEntryName(row.entry, row.original);
      noteEdit(row.model);
      break;
    case 'toggle-visibility':
      if (row.target) toggleTargetVisibility(row.model, row.target.kind, row.target.index);
      else toggleModelVisibility(row.model);
      break;
    case 'disclose':
      toggleDisclosure(position, row);
      break;
    case 'select-mesh': {
      const index = Number(button.dataset.mesh);
      if (Number.isInteger(index)) {
        propTab = 'mesh';
        selectTarget(refForTarget(row.model, 'mesh', index));
      }
      break;
    }
    case 'show-morphs':
      // An object's row keeps the object picked and shows its own tab; a mesh's
      // row, the mesh's. Either has the targets, opened and brought into view.
      propTab = row.target?.kind === 'mesh' ? 'mesh' : 'node';
      selectTarget(refFor(row));
      revealMorphs();
      break;
    case 'select-material': {
      const index = Number(button.dataset.material);
      if (Number.isInteger(index)) {
        const ref: SelectionRef = { model: row.model.id, material: index };
        // The mesh the row names it under, so the panel can offer the same
        // choice again and knows whose material this is.
        const mesh = row.mesh?.index ?? (row.target?.kind === 'mesh' ? row.target.index : undefined);
        if (mesh !== undefined) ref.mesh = mesh;
        // On an object's row, the object stays picked and shows its material tab.
        if (row.target?.kind === 'node') ref.node = row.target.index;
        propTab = 'material';
        selectTarget(ref);
      }
      break;
    }
    case 'locate': {
      if (!viewer) break;
      const ref = refFor(row);
      selectTarget(ref);
      viewer.frame(ref);
      break;
    }
  }
});

function handleObjectRowClick(row: ObjectRow, position: number, button: HTMLButtonElement | null): void {
  const id = row.object.id;
  switch (button?.dataset.action) {
    case 'toggle-visibility':
      toggleObjectVisibility(id);
      break;
    case 'disclose':
      toggleDisclosure(position, row);
      break;
    case 'locate':
      selectObject(id);
      viewer?.frameObject(id);
      break;
    default:
      // The name field selects on focus already; the rest of the row does it here.
      if (!button && document.activeElement !== row.input) selectObject(id);
  }
}

// Renaming from the keyboard, so walking the tree and editing a name stay
// separate the same way they are for the mouse.
sidebar.addEventListener('keydown', (event) => {
  const input = focusedNameField();
  if (!input || event.ctrlKey || event.metaKey || event.altKey) return;

  if (input.readOnly) {
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      beginRename(input);
      return;
    }
    // Delete takes the row the keyboard is on, the way it does in the Files
    // tab. A name open for editing keeps both keys for its text.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteRow(rowPositionOf(input));
      return;
    }
    // Typing on a selected row means renaming it: opening the field before the
    // key's own default runs lets the character land in the (fully selected)
    // name, replacing it.
    if (event.key.length === 1 && event.key !== ' ') beginRename(input);
    return;
  }

  if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault();
    endRename(input);
  }
});

sidebar.addEventListener('pointerover', (event) => {
  if (!viewer) return;
  if ((event as PointerEvent).pointerType === 'touch') return;
  const target = event.target as HTMLElement;
  const rowEl = target.closest<HTMLLIElement>('li.row');
  const row = rowEl?.dataset.row === undefined ? undefined : rows[Number(rowEl.dataset.row)];
  if (row && isObjectRow(row)) {
    viewer.highlightObject(row.object.id);
    return;
  }
  // Over something named beside a row, that is what is being pointed at — the
  // mesh outlines every instance of itself, a material every object using it.
  const chip = target.closest<HTMLElement>('.row-chip');
  if (row && chip?.dataset.material !== undefined) {
    viewer.highlight({ model: row.model.id, material: Number(chip.dataset.material) });
    return;
  }
  if (row && chip?.dataset.mesh !== undefined) {
    viewer.highlight({ model: row.model.id, mesh: Number(chip.dataset.mesh) });
    return;
  }
  viewer.highlight(row ? refFor(row) : null);
});
sidebar.addEventListener('pointerleave', () => viewer?.highlight(null));

// The file tree's own keys. They are stopped here rather than left to bubble:
// the outliner's arrow handling sits on `document`, and this is not its tree.
fileTreeEl.addEventListener('keydown', (event) => {
  const el = document.activeElement;
  const li = el instanceof HTMLElement ? el.closest<HTMLLIElement>('li.file-row') : null;
  const row = li === null ? undefined : fileTreeRows.find((candidate) => candidate.el === li);
  if (!row || event.ctrlKey || event.metaKey || event.altKey) return;

  const claim = (): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (event.key === 'Delete' || event.key === 'Backspace') {
    claim();
    removeFileRow(row.path);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    claim();
    activateFileRow(row.path);
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    claim();
    moveFileFocus(row, event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  // Left and right close and open a folder, as they do in the outliner.
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (row.file !== null) return;
    const collapsed = collapsedFolders.has(row.path);
    if (event.key === 'ArrowRight' ? !collapsed : collapsed) return;
    claim();
    toggleFolder(row.path);
  }
});

// The Animations tab: a click picks a clip, its ▶ plays it, a double-click
// renames it.
clipListEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const row = clipRowFor(target);
  if (!row) return;
  if (target.closest('button[data-action="play"]')) {
    toggleClip(row.index);
    return;
  }
  // Picking the clip already picked would stop it where it stands.
  if (row.index !== activeModel?.preview.clip) pickClip(row.index);
});
clipListEl.addEventListener('dblclick', (event) => {
  const target = event.target as HTMLElement;
  const row = clipRowFor(target);
  if (row && !target.closest('button')) renameClip(row);
});
// Its keys are stopped here, as the file tree's are: arrows and Space mean
// something else on `document`. A focused ▶ keeps its own keys.
clipListEl.addEventListener('keydown', (event) => {
  const row = clipRowFor(document.activeElement);
  if (!row || document.activeElement !== row.el) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const claim = (): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (event.key === 'Enter' || event.key === 'F2') {
    claim();
    renameClip(row);
    return;
  }
  if (event.key === ' ') {
    claim();
    if (!event.repeat) toggleClip(row.index);
    return;
  }
  // Delete takes the animation the keyboard is on, the way the Files tab takes
  // its row — never the 3D selection, which this tab is hiding.
  if (event.key === 'Delete' || event.key === 'Backspace') {
    claim();
    const model = activeModel;
    if (!model) return;
    deleteAnimation(model, row.index);
    // The keyboard stays about where it was, so Delete can be pressed again.
    clipRows[Math.min(row.index, clipRows.length - 1)]?.el.focus();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    claim();
    const next = clipRows[clipRows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    next.el.focus();
    next.el.scrollIntoView({ block: 'nearest' });
    pickClip(next.index);
  }
});
// Enter or Escape in the panel's name hands the keyboard back to the list.
clipPanel.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  // The panel's buttons and trim numbers keep their own Enter.
  if (!clipFields.some((field) => field.input === event.target)) return;
  const row = clipRows.find((candidate) => candidate.index === activeModel?.preview.clip);
  if (!row) return;
  event.preventDefault();
  row.el.focus();
});

searchInput.addEventListener('input', applyFilter);
replaceBtn.addEventListener('click', replaceAll);
for (const input of [findInput, replaceInput]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') replaceAll();
  });
}
findInput.addEventListener('input', () => findInput.classList.remove('invalid'));

exportBtn.addEventListener('click', () => void exportModel());
compression = initCompression<Model>({
  readAddedImages,
  prepare: withBakedTrims,
  changed: renderDownload,
  flash: showFlash,
});
// The panel's own first paint came before it was there to ask.
renderDownload();
resetBtn.addEventListener('click', () => resetAll());
resetAllBtn.addEventListener('click', () => resetModel());
closeBtn.addEventListener('click', () => closeModel());
for (const { select } of modelPickers) {
  // Picking a model in the Files or Tools tab picks it everywhere: the tabs are
  // always about the model the selection is in.
  select.addEventListener('change', () => {
    const model = modelById(Number(select.value));
    if (model) selectTarget({ model: model.id });
  });
}

frameBtn.addEventListener('click', () => viewer?.frameAll());
isolateBtn.addEventListener('click', isolateSelection);

// The outliner's "+": a dropdown of what can be added to the scene. It opens
// on a click and closes on a pick, a click elsewhere or Escape; opened from the
// keyboard, the keyboard goes into it.
addBtn.addEventListener('click', (event) => {
  if (addOptions.hidden) openAddMenu(event.detail === 0);
  else closeAddMenu();
});
addOptions.addEventListener('click', (event) => {
  const option = (event.target as HTMLElement).closest<HTMLElement>('.option');
  const kind = addedKind(option?.dataset.action);
  if (!kind) return;
  closeAddMenu();
  addSceneObject(kind);
});
addOptions.addEventListener('keydown', (event) => {
  const options = [...addOptions.querySelectorAll<HTMLButtonElement>('button.option')];
  const at = options.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeAddMenu();
    addBtn.focus();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  // Stopped here: the outliner's arrow keys listen on `document`.
  event.preventDefault();
  event.stopPropagation();
  const step = event.key === 'ArrowDown' ? 1 : -1;
  options[(at + step + options.length) % options.length]?.focus();
});
document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node;
  if (!addOptions.contains(target) && !addBtn.contains(target)) closeAddMenu();
});
// It is placed beside the button once, so anything that moves the button puts it away.
window.addEventListener('resize', closeAddMenu);
sidebar.addEventListener('scroll', closeAddMenu);
showAllBtn.addEventListener('click', () => {
  viewer?.showAll();
  refreshVisibilityState();
});
gridBtn.addEventListener('click', () => setGridVisible(!gridVisible));

for (const [mode, button] of Object.entries(gizmoButtons) as [GizmoMode, HTMLButtonElement][]) {
  button.addEventListener('click', () => {
    // Clicking the active mode again puts the gizmo away, so it can be got rid
    // of without losing the selection.
    if (gizmoEnabled && gizmoMode === mode) setGizmoEnabled(false);
    else {
      if (!gizmoEnabled) setGizmoEnabled(true);
      setGizmoMode(mode);
    }
  });
}
spaceBtn.addEventListener('click', () => setGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world'));

playBtn.addEventListener('click', togglePlayback);
stopBtn.addEventListener('click', stopPlayback);
loopBtn.addEventListener('click', () => setAnimationLoop(!animationLoop));
reverseBtn.addEventListener('click', () => setAnimationReverse(!animationReverse));
clipScrubber.addEventListener('pointerdown', beginScrub);
clipScrubber.addEventListener('input', () => {
  const model = activeModel;
  if (!viewer || !model) return;
  viewer.seekAnimation(model.id, model.preview.clip, Number(clipScrubber.value));
});
// Arrow keys scrub too, without a pointer to end the drag; either way, a model
// that has just been posed has lost its gizmo.
clipScrubber.addEventListener('change', updateMoveButtons);
sceneSelect.addEventListener('change', () => {
  const model = activeModel;
  if (!model) return;
  model.sceneIndex = Number(sceneSelect.value);
  // Whatever was picked may not be in the scene now on show.
  if (selection?.model === model.id) selectTarget(null);
  // The hierarchy is per-scene, so it has to be rebuilt as well.
  buildEditor();
  void startViewer(model);
  scheduleViewSave();
});

// The overlay's buttons supply whichever models are missing files; the Files
// tab's supply the model it is showing.
for (const [button, input, target] of [
  [addFilesBtn, resourceInput, false],
  [addFolderBtn, resourceFolderInput, false],
  [filesAddBtn, resourceInput, true],
  [filesAddFolderBtn, resourceFolderInput, true],
] as const) {
  button.addEventListener('click', () => {
    resourceTarget = target ? activeModel : null;
    input.click();
  });
}
for (const input of [resourceInput, resourceFolderInput]) {
  input.addEventListener('change', () => {
    if (input.files?.length) addResources(pickedFromList(input.files), resourceTarget ?? undefined);
    resourceTarget = null;
    input.value = '';
  });
}

// Sidebar resizer, dragged the way the editor's is.
resizer.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
});
resizer.addEventListener('pointermove', (event) => {
  if (!document.body.classList.contains('resizing')) return;
  setSidebarWidth(window.innerWidth - event.clientX);
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  resizer.addEventListener(type, () => {
    if (!document.body.classList.contains('resizing')) return;
    document.body.classList.remove('resizing');
    saveSidebarWidth();
  });
}
resizer.addEventListener('dblclick', () => {
  setSidebarWidth(350);
  saveSidebarWidth();
});

document.addEventListener('keydown', (event) => {
  // A modal dialog has the keyboard: nothing under it answers a shortcut.
  if (document.querySelector('dialog[open]')) return;
  const target = event.target as HTMLElement | null;
  const editing = isTextEntry(target);

  // Bare-letter shortcuts must never fire mid-composition or while typing.
  if (event.isComposing) return;

  // Arrow keys walk the outliner, so they are handled even while a name field
  // has focus — that is where the keyboard usually is.
  if (handleTreeKey(event)) {
    event.preventDefault();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    if (activeModel) {
      event.preventDefault();
      void exportModel();
    }
    return;
  }
  const typing = editing && !(target instanceof HTMLInputElement && target.readOnly);
  // Ctrl+Z is the app's, even in a name or a number being typed — those edit
  // the document as they are typed, so the history has them already. Only the
  // fields that hold text of their own keep the browser's undo for it.
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
    if (ownsTextUndo(target)) return;
    event.preventDefault();
    if (key === 'y' || event.shiftKey) redo();
    else undo();
    return;
  }
  if (event.key === 'Escape') {
    closeMenus();
    closeAddMenu();
    if (!editing && (selection || pickedObject !== null)) selectTarget(null);
    return;
  }
  // Space plays and pauses, as in a video player. A button, a field or a
  // dropdown the keyboard is on keeps Space for itself; a name that is only
  // picked has no use for it, and neither has the scrubber.
  if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const own = target !== clipScrubber && (typing || target instanceof HTMLButtonElement);
    if (!own && !event.defaultPrevented && canPlay()) {
      event.preventDefault();
      if (!event.repeat) togglePlayback();
      return;
    }
  }
  if (editing || event.ctrlKey || event.metaKey || event.altKey) return;

  // Delete takes the selection out of the file, as it does in the three.js
  // editor. The outliner and the Files tab handle it for the row they are on.
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selection || pickedObject !== null) {
      event.preventDefault();
      deleteSelection();
    }
    return;
  }

  if (event.key.toLowerCase() === 'f' && viewer) {
    frameSelection();
    return;
  }

  // W/E/R switch the gizmo, as they do in the three.js editor.
  const mode = { w: 'translate', e: 'rotate', r: 'scale' }[event.key.toLowerCase()];
  if (mode && viewer) {
    if (!gizmoEnabled) setGizmoEnabled(true);
    setGizmoMode(mode as GizmoMode);
  }
});

window.addEventListener('beforeunload', (event) => {
  // A reload loses nothing while the session is being kept, so the prompt would
  // be noise. It comes back the moment keeping it stops working — for every
  // model, or for one too large to keep.
  // A scene worked on for its own sake is only in the session, and goes with it.
  if (sessionBroken && sceneStarted) {
    event.preventDefault();
    return;
  }
  const unkept = models.filter((model) => sessionBroken || model.unkept);
  if (unkept.length === 0) return;
  if (unkept.some((model) => hasStructuralEdits(model) || hasTrims(model.json))) {
    event.preventDefault();
    return;
  }
  for (const entryRows of rowsByEntry.values()) {
    if (!unkept.includes(entryRows[0].model)) continue;
    if (entryRows[0].input.value !== entryRows[0].original) {
      event.preventDefault();
      return;
    }
  }
  // Scenes and animations are renamed outside the outliner, so no row answers for them.
  if (unkept.some((model) => renamedCount(model, rowlessEntries(model)) > 0)) event.preventDefault();
});

// A hidden tab may never get another tick, so anything still on a save timer is
// written now. `pagehide` covers the reload; `visibilitychange` covers a phone
// switching apps, which is where the tab is likeliest to be discarded outright.
window.addEventListener('pagehide', flushSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSession();
});

initSidebarWidth();
speedField.prepend(speedInput);
updateMoveButtons();
outlinerEl.append(emptyState(EMPTY_OUTLINER));
fillAddOptions(addOptions, 'dropdown');
fillAddOptions(menubarAdd, 'menubar');
renderFiles();
renderAnimationTab();
renderProperties();
updateMenus();
renderSceneBar();
void restoreSession();
