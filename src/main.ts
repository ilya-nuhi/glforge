import {
  CHUNK_BIN,
  MAP_SLOTS,
  assertGltf2,
  buildGlb,
  detectCompression,
  embedGlbImages,
  getMaterialTexture,
  imageBufferRange,
  listExternalResources,
  parseGlb,
  parseGltfText,
  setMaterialTexture,
  withSingleScene,
  type GlbChunk,
  type GltfImage,
  type GltfJson,
  type GltfMaterial,
  type GltfNode,
  type GltfTexture,
  type ImageBytes,
  type MapSlot,
  type NamedEntry,
} from './gltf';
import { collectDroppedFiles, pickedFromList, type PickedFile } from './files';
import {
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
  isQuotaError,
  loadSession,
  markSession,
  saveDoc,
  saveSource,
  saveView,
  sourceSize,
  storedSessionName,
  type Session,
  type SourceRecord,
} from './session';
import { buildHierarchy, meshMaterials, type EntryUse } from './tree';
import type {
  CameraView,
  GizmoMode,
  NodeTrs,
  SelectionRef,
  TargetKind,
  Viewer,
} from './viewer';
import './style.css';

/**
 * The glTF collections that carry names, for counting what a file holds and for
 * pairing a restored document against the file's own names. Rows are built from
 * the scene hierarchy alone, so nothing here needs an icon or a 3D target.
 */
interface Category {
  label: string;
  singular: string;
  list: (json: GltfJson) => NamedEntry[];
}

const CATEGORIES: Category[] = [
  { label: 'Scenes', singular: 'Scene', list: (j) => j.scenes ?? [] },
  { label: 'Nodes', singular: 'Node', list: (j) => j.nodes ?? [] },
  { label: 'Meshes', singular: 'Mesh', list: (j) => j.meshes ?? [] },
  { label: 'Skins', singular: 'Skin', list: (j) => j.skins ?? [] },
  { label: 'Materials', singular: 'Material', list: (j) => j.materials ?? [] },
  { label: 'Textures', singular: 'Texture', list: (j) => j.textures ?? [] },
  { label: 'Images', singular: 'Image', list: (j) => j.images ?? [] },
  { label: 'Animations', singular: 'Animation', list: (j) => j.animations ?? [] },
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

type SidebarTab = 'scene' | 'files' | 'tools';

/** A row of the Files tab's tree, paired with the element drawing it. */
interface FileTreeRow extends FolderRow {
  el: HTMLLIElement;
}

interface Row {
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

interface RowSpec {
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
  /** The file's own row: shown, walked and framed, but never renamed. */
  fixed?: boolean;
}

/**
 * A material named beside a mesh row — a chip when the mesh has one material, an
 * option of its dropdown when it has several. Both have to follow a rename and
 * to say when their material is the selection, so both are described by what
 * they do rather than by which element they are.
 */
interface AsideLabel {
  /** What it names: the row's mesh data, or one of that mesh's materials. */
  kind: 'mesh' | 'material';
  index: number;
  /** The mesh it belongs to, so only that mesh's labels mark its selection. */
  mesh: number;
  /** Repaint after a rename. */
  paint: (value: string) => void;
  /** Show whether this material is what is selected. */
  mark: (selected: boolean) => void;
}

/** A name field in the properties panel, kept in sync with its row. */
interface PropField {
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
  kind: TargetKind;
  index: number;
  input: HTMLInputElement;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const menubar = $('#menubar');
const menubarFile = $('#menubar-file');
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
const searchInput = $<HTMLInputElement>('#search-input');
const findInput = $<HTMLInputElement>('#find-input');
const replaceInput = $<HTMLInputElement>('#replace-input');
const regexToggle = $<HTMLInputElement>('#regex-toggle');
const replaceBtn = $<HTMLButtonElement>('#replace-btn');
const resetBtn = $('#reset-btn');
const resetAllBtn = $('#reset-all-btn');
const closeBtn = $('#close-btn');
const exportBtn = $<HTMLButtonElement>('#export-btn');
const flash = $('#flash');

const SIDEBAR_KEY = 'glforge:sidebar-width';
const GITHUB_URL = 'https://github.com/ilya-nuhi/glforge';

// ---------------------------------------------------------------------------
// State

let gltfJson: GltfJson | null = null;
let glbChunks: GlbChunk[] = [];
let sourceIsGlb = false;
/** Pristine bytes/text, kept so the preview never sees the edited document. */
let sourceBuffer: ArrayBuffer | null = null;
let sourceText: string | null = null;
let sourceWasPretty = false;
let exportBaseName = 'model';
/** Where the model itself sat in what was dropped, for the Files tab. */
let modelPath = '';
/** Its size in bytes, or -1 when a restored session did not record one. */
let modelSize = -1;

let rows: Row[] = [];
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
/** What the properties panel was last built from, so typing never rebuilds it. */
let propSignature = '';

/** Images the user added from disk, so export can fold them into the file. */
let addedImages = new Map<number, File>();
/** Cached preview URLs for images, keyed by image index (null = not showable). */
let imageUrls = new Map<number, string | null>();
/** Which material slot an "Add image…" file picker was opened for. */
let pendingSlot: { material: number; slot: MapSlot } | null = null;
/** Edits beyond names, which the preview and the export both have to reflect. */
let mapEdits = 0;
/** Nodes the user has moved, holding what the file said before they did. */
let movedNodes = new Map<number, NodeTransformKeys>();
let gizmoMode: GizmoMode = 'translate';
let gizmoSpace: 'local' | 'world' = 'world';
let gizmoEnabled = true;
/** The transform fields on screen, so the gizmo can write into them live. */
let propTransform: {
  node: number;
  fields: Record<TrsPart, HTMLInputElement[]>;
  reset: HTMLButtonElement;
} | null = null;

let viewer: Viewer | null = null;
let viewerBusy = false;
/** Guards against a stale load's result overwriting a newer one. */
let loadToken = 0;
/** A reload asked for while one was in flight, so it is not silently dropped. */
let reloadPending: ViewerOptions | null = null;
let sceneIndex = 0;
let selection: SelectionRef | null = null;
let resources = new Map<string, File>();
let fileTreeRows: FileTreeRow[] = [];
/** Collapsed folders in the Files tab, by path so a rebuild keeps them shut. */
let collapsedFolders = new Set<string>();
/** The picked row in the Files tab, by path, so a rebuild keeps it picked. */
let selectedFilePath: string | null = null;
/** The image on show under the tree, and the URL drawing it. */
let previewFile: { path: string; file: File; url: string } | null = null;
let replaceUndo: { entry: NamedEntry; value: string }[] | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let gridVisible = true;

/** Identifies the stored session; 0 while nothing is being kept. */
let sessionStamp = 0;
/** The name the open file was opened under, as stored and as restored. */
let sessionFileName = '';
/** Set once a write has failed, which is what brings the unload guard back. */
let sessionBroken = false;
let docSaveTimer: ReturnType<typeof setTimeout> | undefined;
let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
/** A camera read back from storage, applied once the preview has loaded. */
let pendingView: CameraView | null = null;
/**
 * The names the file itself carried, when the document was restored mid-edit:
 * rows take their "original" from here, so a restored rename still shows as a
 * change and still reverts to what the file said.
 */
let originalNames: Map<NamedEntry, { name: string; had: boolean }> | null = null;
/** Which sidebar tab is showing, so a reload comes back to it. */
let sidebarTab: SidebarTab = 'scene';

const targetKey = (kind: TargetKind, index: number) => `${kind}:${index}`;

// ---------------------------------------------------------------------------
// Loading a file

async function openFiles(picked: PickedFile[]): Promise<void> {
  hideError();
  const models = picked.filter((item) => /\.(glb|gltf)$/i.test(item.file.name));
  const sidecars = picked.filter((item) => !models.includes(item));

  if (models.length === 0) {
    // Files dropped while a model is open are treated as its missing resources.
    if (gltfJson && sidecars.length > 0) {
      addResources(sidecars);
      return;
    }
    showError('Drop a .glb or .gltf file, or a folder containing one.');
    return;
  }
  if (models.length > 1) {
    // A folder of variants is common; naming them is more use than refusing.
    const names = models.slice(0, 3).map((item) => item.file.name);
    showError(
      `That holds ${models.length} models — open one at a time (${names.join(', ')}${
        models.length > names.length ? ', …' : ''
      }).`,
    );
    return;
  }

  const modelFile = models[0].file;
  const isGlb = /\.glb$/i.test(modelFile.name);

  try {
    if (isGlb) {
      const buffer = await modelFile.arrayBuffer();
      const parsed = parseGlb(buffer);
      assertGltf2(parsed.json);
      closeFile(false);
      gltfJson = parsed.json;
      glbChunks = parsed.otherChunks;
      sourceBuffer = buffer;
      sourceText = null;
    } else {
      const text = await modelFile.text();
      const json = parseGltfText(text);
      assertGltf2(json);
      closeFile(false);
      gltfJson = json;
      glbChunks = [];
      sourceBuffer = null;
      sourceText = text;
      sourceWasPretty = text.includes('\n');
    }

    sourceIsGlb = isGlb;
    exportBaseName = modelFile.name.replace(/\.(glb|gltf)$/i, '');
    // The path it was dropped at, so the Files tab can show it where it sat.
    modelPath = models[0].path;
    modelSize = modelFile.size;
    gltfNote.hidden = isGlb;
    fileNameEl.textContent = modelFile.name;
    menubarFile.textContent = modelFile.name;
    exportBtn.textContent = isGlb ? 'Download .glb' : 'Download .gltf';
    // Keyed by the path each file was dropped at, so a URI like
    // `textures/wood.png` finds the file that actually sat there.
    if (sidecars.length > 0) resources = new Map(sidecars.map((item) => [item.path, item.file]));

    updateSceneSelect();
    buildEditor();
    dropzone.hidden = true;
    toolbar.hidden = false;
    viewportInfo.hidden = false;
    setTab('scene');
    void startViewer();
    beginSession(modelFile.name);
  } catch (error) {
    showError(`Could not read the file: ${messageOf(error)}`);
  }
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
  const hadName = siblings[0]?.hadName ?? typeof entry.name === 'string';
  if (value === '' && !hadName) delete entry.name;
  else entry.name = value;

  for (const row of siblings) {
    // Never rewrite the input being typed into: it would reset the caret.
    if (row.input !== source) row.input.value = value;
    // Whatever a field shows now is what the document holds, so nothing about
    // it is rejected any more.
    row.input.classList.remove('invalid');
    updateRowState(row);
    if (row.materials.length > 0) fitNameField(row.input);
  }
  for (const field of propFields) {
    if (field.entry !== entry) continue;
    if (field.input !== source) field.input.value = value;
    field.input.classList.remove('invalid');
    field.input.classList.toggle('modified', value !== field.original);
  }
  // A material is named beside every mesh that uses it, not just on a row.
  for (const label of asideLabels.get(entry) ?? []) label.paint(value);
}

/**
 * The other material already carrying this name, if any. Downstream of the file
 * a material is usually looked up by name, so two of them answering to one name
 * is a rename the app refuses to make. Comparison is exact: glTF names are, and
 * two names differing in case are two names.
 */
function materialNameClash(entry: NamedEntry, value: string): NamedEntry | null {
  const materials = gltfJson?.materials;
  // An unnamed material is not a name being taken, and only materials collide.
  if (!materials || value === '' || !materials.includes(entry)) return null;
  return materials.find((other) => other !== entry && getName(other) === value) ?? null;
}

/**
 * Writes what was typed into a name field, unless it would give two materials
 * the same name. A rejected name stays in the field, marked, and never reaches
 * the document — so the file keeps the name it had while the user fixes theirs.
 */
function applyNameEdit(entry: NamedEntry, input: HTMLInputElement): void {
  const clash = materialNameClash(entry, input.value);
  if (clash) {
    input.classList.add('invalid');
    input.title = `Material ${gltfJson!.materials!.indexOf(clash)} is already named "${input.value}"`;
    return;
  }
  setEntryName(entry, input.value, input);
  updateFileStats();
}

/** Leaving a field with a rejected name in it puts the document's name back. */
function settleNameEdit(entry: NamedEntry, input: HTMLInputElement): void {
  if (!input.classList.contains('invalid')) return;
  const kept = getName(entry);
  const typed = input.value;
  setEntryName(entry, kept);
  updateFileStats();
  showFlash(`"${typed}" is another material's name — kept "${kept || '(unnamed)'}"`);
}

/** Which entry a name field stands for, wherever in the UI it is. */
function entryForInput(input: HTMLInputElement): NamedEntry | undefined {
  for (const row of rows) {
    if (row.input === input) return row.entry;
  }
  return propFields.find((field) => field.input === input)?.entry;
}

function buildEditor(): void {
  outlinerEl.textContent = '';
  rows = [];
  rowsByEntry = new Map();
  rowsByTarget = new Map();
  asideLabels = new Map();
  noteGroups = [];
  collapsedRows = new Set();
  allCollapsed = false;
  replaceUndo = null;

  buildOutliner();

  updateFileStats();
  // Added images become files of their own, so the folder view moves with the
  // document as well as with what has been dropped in.
  renderFiles();

  applyFilter();
  updateStatus();
  refreshVisibilityState();
  // Re-attach the selection to the freshly built rows, or clear the panel.
  propSignature = '';
  if (selection) selectTarget(selection);
  else renderProperties();
  updateMenus();
}

function buildOutliner(): void {
  const items = buildHierarchy(gltfJson!, sceneIndex);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'This file has no scene contents.';
    outlinerEl.append(empty);
    return;
  }

  const list = document.createElement('ul');
  outlinerEl.append(list);

  // The file is the outliner's one root: the scene it shows is the scene the
  // toolbar has selected, so a row for it would only repeat that.
  const model = baseName(modelPath);
  if (model !== '') {
    addRow(list, {
      entry: { name: model },
      label: 'Model',
      icon: 'fileModel',
      index: 0,
      depth: 0,
      hasChildren: true,
      fixed: true,
    });
  }

  let currentGroup: { el: HTMLElement; rows: Row[] } | null = null;
  // Everything hangs off the file row, the leftovers below the group note
  // included: they are in the file, just not in this scene.
  const rootDepth = model === '' ? 0 : 1;

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
  if (owner !== undefined && (spec.mesh || (spec.materials?.length ?? 0) > 0)) {
    // The name field stops where its text does, so what follows sits beside the
    // name rather than out at the edge of the row.
    main.classList.add('has-aside');
    main.append(rowAside(spec.mesh, spec.materials ?? [], owner));
    fitNameField(input);
  }

  let eyeBtn: HTMLButtonElement | null = null;
  let locateBtn: HTMLButtonElement | null = null;
  if (spec.target) {
    if (spec.target.kind !== 'material') {
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
  const pristine = originalNames?.get(spec.entry);

  const row: Row = {
    entry: spec.entry,
    label: spec.label,
    index: spec.index,
    target: spec.target,
    mesh: spec.mesh,
    materials: spec.materials ?? [],
    fixed: spec.fixed === true,
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
    applyNameEdit(row.entry, input);
    // Rejected or not, the field is showing what was typed, so it resizes.
    if (row.materials.length > 0) fitNameField(input);
  });
  // Reaching a name is a selection: the properties panel and the 3D view follow.
  input.addEventListener('focus', () => {
    const ref = refFor(row);
    if (ref) selectTarget(ref);
  });
  // Leaving the field ends the rename, so the row is a row again next time.
  input.addEventListener('blur', () => {
    input.readOnly = true;
    settleNameEdit(row.entry, input);
  });

  // Only a restored row can already differ from the file, so the usual path
  // pays nothing for this.
  if (row.original !== input.value) updateRowState(row);

  rows.push(row);
  const siblings = rowsByEntry.get(spec.entry);
  if (siblings) siblings.push(row);
  else rowsByEntry.set(spec.entry, [row]);

  if (spec.target) addTargetRow(spec.target.kind, spec.target.index, row);
  // An object's row stands in for its mesh data as well, since that has no row
  // of its own: selecting the mesh has to light something up in here.
  if (spec.mesh) addTargetRow('mesh', spec.mesh.index, row);
  return row;
}

function addTargetRow(kind: TargetKind, index: number, row: Row): void {
  const key = targetKey(kind, index);
  const targeted = rowsByTarget.get(key);
  if (targeted) targeted.push(row);
  else rowsByTarget.set(key, [row]);
}

/**
 * What a row draws, printed just after its own name the way the three.js
 * editor's outliner prints an object's geometry and material after its name:
 * the mesh data, then that mesh's materials. One material is a chip; several are
 * a dropdown, since a mesh with eight primitives would otherwise bury the name.
 * Picking any of them shows its properties, which is where mesh data and
 * materials live now that neither has a row of its own.
 */
function rowAside(mesh: EntryUse | undefined, materials: EntryUse[], owner: number): HTMLElement {
  const aside = document.createElement('span');
  aside.className = 'row-aside';

  // A row that *is* mesh data — mesh nothing in the file draws — has no chip for
  // it: the row's own name is the mesh, and it names its materials.
  if (mesh) aside.append(meshChip(mesh, materials.length > 0));
  if (materials.length === 1) aside.append(materialChip(materials[0], owner));
  else if (materials.length > 1) {
    // The icon is the chip's; a native dropdown cannot carry one in its options.
    aside.append(typeIcon('material'), materialPicker(materials, owner));
  }
  return aside;
}

/**
 * That the object draws mesh data, as the symbol for it alone: the mesh usually
 * carries the object's own name over again, and printing it twice on one row
 * says nothing. Its name is in the tooltip, and one click away in the panel.
 */
function meshChip(use: EntryUse, hasMaterials: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-chip glyph';
  button.dataset.action = 'select-mesh';
  button.dataset.mesh = String(use.index);
  // A mesh with no material at all reads differently from one that has some.
  button.append(typeIcon(hasMaterials ? 'meshData' : 'meshDataPlain'));

  registerAside(use.entry, {
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

function materialChip(use: EntryUse, mesh: number): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-chip';
  button.dataset.action = 'select-material';
  button.dataset.material = String(use.index);

  const name = document.createElement('span');
  name.className = 'row-chip-name';
  button.append(typeIcon('material'), name);

  registerAside(use.entry, {
    kind: 'material',
    index: use.index,
    mesh,
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

function materialPicker(uses: EntryUse[], mesh: number): HTMLSelectElement {
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
      kind: 'material',
      index: use.index,
      mesh,
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
    selectTarget({ mesh, material: Number(select.value) });
  });
  return select;
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
  if (!selection) return false;
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

function modifiedCount(): number {
  let count = 0;
  for (const entryRows of rowsByEntry.values()) {
    // The document, not the field: a rejected name is in a field but not in the
    // file, and the count is about what would be downloaded.
    if (getName(entryRows[0].entry) !== entryRows[0].original) count++;
  }
  return count;
}

/** The File panel's "Contents" row: what the file holds, and what was renamed. */
function updateFileStats(): void {
  const json = gltfJson;
  if (!json) {
    fileStatsEl.textContent = '—';
    return;
  }
  // Counts describe the file, so they are the same in either list.
  const parts: string[] = [];
  for (const category of CATEGORIES) {
    const count = category.list(json).length;
    if (count > 0) parts.push(`${count} ${count === 1 ? category.singular : category.label}`);
  }
  const modified = modifiedCount();
  if (modified > 0) parts.push(`${modified} renamed`);
  if (mapEdits > 0) parts.push(`${mapEdits} texture change${mapEdits === 1 ? '' : 's'}`);
  if (movedNodes.size > 0) parts.push(`${movedNodes.size} moved`);
  fileStatsEl.textContent = parts.join(' · ') || '—';

  // Every edit ends up here to refresh this read-out, which makes it the one
  // place the stored document has to be kept in step from.
  scheduleDocSave();
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

/** Every file that came in with the model, and what the document does with it. */
function folderFiles(): FolderFile[] {
  const json = gltfJson;
  if (!json) return [];

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
  const added = new Set(addedImages.values());

  const files: FolderFile[] = [];
  if (modelPath !== '') {
    files.push({ path: modelPath, size: modelSize, role: 'model', usedAs: [] });
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
      return sourceIsGlb
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
  if (previewFile && resources.get(previewFile.path) !== previewFile.file) clearFilePreview();
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
  const file = spec.file === null ? undefined : resources.get(spec.path);
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

  const file = resources.get(path);
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

  if (row.file?.role === 'model') {
    showFlash('That is the open file itself — File → Close puts it away');
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
  removeFiles(paths, label, position);
}

/**
 * Forgets supplied files. Nothing on disk is touched: they simply stop being
 * available, exactly as if they had never been dropped in — so a URI one of
 * them covered moves straight to "Not supplied", and dropping it back in undoes
 * this completely.
 */
function removeFiles(paths: string[], label: string, focusAt: number): void {
  const removed: string[] = [];
  for (const path of paths) {
    const file = resources.get(path);
    if (file === undefined) continue;
    resources.delete(path);
    removed.push(path);
    // An image brought in from disk is held twice; forgetting it in one place
    // only would leave the export embedding bytes the tab says are gone.
    for (const [index, added] of addedImages) {
      if (added === file) addedImages.delete(index);
    }
  }
  if (removed.length === 0) return;

  if (previewFile && removed.includes(previewFile.path)) clearFilePreview();
  selectedFilePath = null;
  // A thumbnail may have been drawn from a file that is no longer there.
  releaseImageUrls();
  propSignature = '';
  renderProperties();
  renderFiles();
  focusFileRowAt(focusAt);
  // The stored session keeps the supplied files, so it has to lose them too.
  void saveSourceRecord();
  // The preview was built with them; without the .bin it now says so.
  if (gltfJson) void startViewer({ keepView: true });
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

/** The URIs the document declares that nothing supplied covers. */
function renderMissingFiles(): void {
  const json = gltfJson;
  missingFilesEl.textContent = '';
  if (!json) {
    missingPanel.hidden = true;
    return;
  }

  const lookup = buildResourceLookup(resources);
  const { buffers, images } = listExternalResources(json);
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
    row.filtered =
      query === '' ||
      row.input.value.toLowerCase().includes(query) ||
      row.original.toLowerCase().includes(query) ||
      // Mesh data and materials have no rows here any more, so the row naming
      // them answers for them.
      (row.mesh !== undefined && getName(row.mesh.entry).toLowerCase().includes(query)) ||
      row.materials.some((use) => getName(use.entry).toLowerCase().includes(query));
  }
  applyRowVisibility();
}

/**
 * Visibility combines the text filter with tree collapsing. A collapsed row
 * hides the following run of deeper rows; while a filter is active, collapsing
 * is ignored so matches are never buried.
 */
function applyRowVisibility(): void {
  const filtering = searchInput.value.trim() !== '';
  let floor = Infinity;

  rows.forEach((row, position) => {
    let hiddenByCollapse = false;
    if (!filtering) {
      hiddenByCollapse = row.depth > floor;
      if (!hiddenByCollapse) floor = collapsedRows.has(position) ? row.depth : Infinity;
    }
    row.el.hidden = hiddenByCollapse || !row.filtered;
  });

  for (const group of noteGroups) {
    group.el.hidden = group.rows.every((row) => row.el.hidden);
  }
}

function toggleDisclosure(position: number, row: Row): void {
  if (collapsedRows.has(position)) collapsedRows.delete(position);
  else collapsedRows.add(position);
  const expanded = !collapsedRows.has(position);
  row.discloseBtn?.setAttribute('aria-expanded', String(expanded));
  row.el.classList.toggle('collapsed', !expanded);
  if (row.discloseBtn) row.discloseBtn.title = expanded ? 'Collapse' : 'Expand';
  applyRowVisibility();
}

function setAllCollapsed(collapse: boolean): void {
  collapsedRows = new Set();
  rows.forEach((row, position) => {
    if (!row.hasChildren) return;
    if (collapse) collapsedRows.add(position);
    row.discloseBtn?.setAttribute('aria-expanded', String(!collapse));
    row.el.classList.toggle('collapsed', collapse);
    if (row.discloseBtn) row.discloseBtn.title = collapse ? 'Expand' : 'Collapse';
  });
  allCollapsed = collapse;
  applyRowVisibility();
  updateMenus();
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

  const undo: { entry: NamedEntry; value: string }[] = [];
  const done = new Set<NamedEntry>();
  let clashes = 0;
  for (const row of rows) {
    if (!row.filtered || row.fixed) continue; // respect the filter; skip the file
    // The same entry can own several rows; replacing twice would compound.
    if (done.has(row.entry)) continue;
    done.add(row.entry);

    const current = row.input.value;
    const next = replacer(current);
    if (next === current) continue;
    // Replacing across a whole file is the easiest way to collide two material
    // names, so the ones that would are left alone and counted.
    if (materialNameClash(row.entry, next)) {
      clashes++;
      continue;
    }
    undo.push({ entry: row.entry, value: current });
    setEntryName(row.entry, next);
  }
  replaceUndo = undo.length > 0 ? undo : null;
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

function undoReplace(): void {
  if (!replaceUndo) return;
  for (const { entry, value } of replaceUndo) setEntryName(entry, value);
  const count = replaceUndo.length;
  replaceUndo = null;
  updateFileStats();
  updateMenus();
  showFlash(`Undid replace in ${count} name${count === 1 ? '' : 's'}`);
}

async function exportModel(): Promise<void> {
  if (!gltfJson) return;
  try {
    let blob: Blob;
    if (sourceIsGlb) {
      // A .glb is meant to be one file, so images added from disk are folded
      // into it rather than left pointing at the user's own folders.
      const embedded = embedGlbImages(gltfJson, glbChunks, await readAddedImages());
      blob = buildGlb(embedded.json, embedded.chunks);
    } else {
      blob = new Blob([JSON.stringify(gltfJson, null, sourceWasPretty ? 2 : undefined)], {
        type: 'model/gltf+json',
      });
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exportBaseName}.${sourceIsGlb ? 'glb' : 'gltf'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // A .gltf keeps its references, so added images stay separate files.
    if (!sourceIsGlb && addedImages.size > 0) {
      const names = [...addedImages.keys()]
        .map((index) => gltfJson?.images?.[index]?.uri)
        .filter((uri): uri is string => typeof uri === 'string');
      showFlash(
        `Save the added image${names.length === 1 ? '' : 's'} next to the .gltf: ${names.join(', ')}`,
      );
    }
  } catch (error) {
    showFlash(`Export failed: ${messageOf(error)}`);
  }
}

/** Whether anything other than a name has changed, which the preview must show. */
function hasStructuralEdits(): boolean {
  return mapEdits > 0 || movedNodes.size > 0;
}

/** Bytes for the images the user added, read only when they are exported. */
async function readAddedImages(): Promise<Map<number, ImageBytes>> {
  const bytes = new Map<number, ImageBytes>();
  for (const [index, file] of addedImages) {
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

function resetAll(): void {
  for (const [entry, entryRows] of rowsByEntry) setEntryName(entry, entryRows[0].original);
  replaceUndo = null;
  updateFileStats();
  updateMenus();
  showFlash('All names reset');
}

/**
 * Puts the whole file back the way it was opened: names, transforms, texture
 * bindings, and the images that were added along with them.
 *
 * The pristine bytes are kept for the preview anyway, so re-parsing them is
 * both the shortest way to undo every kind of edit and the only one that
 * cannot miss one — a new kind of edit needs nothing added here.
 */
function resetModel(): void {
  const edited = gltfJson;
  if (!edited) return;
  if (modifiedCount() === 0 && !hasStructuralEdits() && addedImages.size === 0) {
    showFlash('Nothing to reset');
    return;
  }

  let pristine: GltfJson;
  let chunks: GlbChunk[];
  try {
    if (sourceIsGlb) {
      if (!sourceBuffer) throw new Error('the original file bytes are no longer available');
      const parsed = parseGlb(sourceBuffer);
      pristine = parsed.json;
      chunks = parsed.otherChunks;
    } else {
      if (!sourceText) throw new Error('the original file text is no longer available');
      pristine = parseGltfText(sourceText);
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
  for (const [index, file] of addedImages) {
    const uri = edited.images?.[index]?.uri;
    if (uri !== undefined && resources.get(uri) === file) resources.delete(uri);
  }
  addedImages = new Map();
  releaseImageUrls();

  gltfJson = pristine;
  glbChunks = chunks;
  // The document is the file again, so every row's original is its own name.
  originalNames = null;
  mapEdits = 0;
  movedNodes = new Map();
  propTransform = null;
  pendingSlot = null;
  replaceUndo = null;

  // Scene names are back to the file's, and the picker shows them.
  updateSceneSelect(sceneIndex);
  buildEditor();
  // The added images belong to the stored file record, not the document one,
  // which buildEditor() has already scheduled a write of.
  void saveSourceRecord();
  // Materials and transforms are only in the scene the preview built, so it has
  // to be rebuilt — from the pristine bytes now, which is what it prefers.
  void startViewer({ keepView: true });
  showFlash('Model reset to how it was opened');
}

function closeFile(returnToDrop = true): void {
  // Closing a file gives up keeping it: the next thing stored is either the
  // file being opened right now, or nothing at all.
  forgetSession();
  viewer?.dispose();
  viewer = null;
  viewerBusy = false;
  // Invalidate any load still in flight so it cannot write into the new file.
  loadToken++;
  reloadPending = null;
  gltfJson = null;
  glbChunks = [];
  sourceBuffer = null;
  sourceText = null;
  rows = [];
  rowsByEntry = new Map();
  rowsByTarget = new Map();
  asideLabels = new Map();
  noteGroups = [];
  collapsedRows = new Set();
  allCollapsed = false;
  resources = new Map();
  modelPath = '';
  modelSize = -1;
  collapsedFolders = new Set();
  clearFileSelection();
  releaseImageUrls();
  addedImages = new Map();
  mapEdits = 0;
  movedNodes = new Map();
  originalNames = null;
  pendingView = null;
  propTransform = null;
  pendingSlot = null;
  selection = null;
  sceneIndex = 0;
  replaceUndo = null;
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
  setGridVisible(true);
  propSignature = '';
  renderProperties();
  renderFiles();
  setOverlay(null);
  if (returnToDrop) {
    dropzone.hidden = false;
    toolbar.hidden = true;
    viewportInfo.hidden = true;
    updateStatus();
    fileInput.value = '';
    folderInput.value = '';
    fileNameEl.textContent = '—';
    fileStatsEl.textContent = '—';
    menubarFile.textContent = 'No file open';
    sceneRow.hidden = true;
    gltfNote.hidden = true;
    outlinerEl.append(emptyState('No file open.'));
  }
  updateMenus();
}

function emptyState(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Session (kept across reloads)

/** Starts keeping a newly opened file, in place of whatever was kept before. */
function beginSession(fileName: string): void {
  sessionStamp = Date.now();
  sessionBroken = false;
  sessionFileName = fileName;
  markSession(fileName);
  void saveSourceRecord();
  void saveDocRecord();
  void saveViewRecord();
}

/** Stops keeping the session, and throws away what was kept. */
function forgetSession(): void {
  clearTimeout(docSaveTimer);
  clearTimeout(viewSaveTimer);
  docSaveTimer = undefined;
  viewSaveTimer = undefined;
  sessionStamp = 0;
  sessionFileName = '';
  markSession(null);
  void clearSession();
}

function scheduleDocSave(): void {
  if (sessionStamp === 0 || sessionBroken) return;
  clearTimeout(docSaveTimer);
  // Typing a name is a burst of edits, and the document can be megabytes: one
  // write per pause in the typing is plenty.
  docSaveTimer = setTimeout(() => void saveDocRecord(), 600);
}

function scheduleViewSave(): void {
  if (sessionStamp === 0 || sessionBroken) return;
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => void saveViewRecord(), 600);
}

/** Writes whatever is still on a timer, for a tab that may not come back. */
function flushSession(): void {
  if (docSaveTimer !== undefined) {
    clearTimeout(docSaveTimer);
    docSaveTimer = undefined;
    void saveDocRecord();
  }
  if (viewSaveTimer !== undefined) {
    clearTimeout(viewSaveTimer);
    viewSaveTimer = undefined;
    void saveViewRecord();
  }
}

async function saveSourceRecord(): Promise<void> {
  if (sessionStamp === 0 || sessionBroken) return;
  const source = sourceIsGlb ? sourceBuffer : sourceText;
  if (source === null) return;

  const record: SourceRecord = {
    stamp: sessionStamp,
    fileName: sessionFileName,
    filePath: modelPath,
    fileSize: modelSize,
    isGlb: sourceIsGlb,
    wasPretty: sourceWasPretty,
    source,
    resources: [...resources].map(([path, file]) => ({ path, file })),
    addedImages: [...addedImages].map(([index, file]) => ({ index, file })),
  };
  if (sourceSize(record) > MAX_SESSION_BYTES) {
    // Writing hundreds of megabytes on every open would cost more time than the
    // restore is worth, and the browser would likely refuse it anyway.
    breakSession('This file is too large to keep across a reload — download before you leave.');
    return;
  }
  await writeRecord(() => saveSource(record));
}

async function saveDocRecord(): Promise<void> {
  const json = gltfJson;
  if (sessionStamp === 0 || sessionBroken || !json) return;
  await writeRecord(() =>
    saveDoc({
      stamp: sessionStamp,
      json,
      mapEdits,
      movedNodes: [...movedNodes].map(([index, original]) => ({ index, original })),
    }),
  );
}

async function saveViewRecord(): Promise<void> {
  if (sessionStamp === 0 || sessionBroken) return;
  await writeRecord(() =>
    saveView({
      stamp: sessionStamp,
      sceneIndex,
      tab: sidebarTab,
      gridVisible,
      selection,
      // Before the preview is up, the camera worth keeping is the one still
      // waiting to be applied to it.
      camera: viewer?.view() ?? pendingView,
      gizmo: { mode: gizmoMode, space: gizmoSpace, enabled: gizmoEnabled },
    }),
  );
}

async function writeRecord(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    breakSession(
      isQuotaError(error)
        ? 'No room left to keep this file across a reload — download before you leave.'
        : 'This browser will not keep the file across a reload — download before you leave.',
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
 * Brings back the file the last session had open, the way the three.js editor
 * brings back its scene. Runs on startup, before anything else is open.
 */
async function restoreSession(): Promise<void> {
  const name = storedSessionName();
  if (name === null || gltfJson) return;

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
  // A file dropped while the read was running has already replaced the session,
  // and must not be replaced back.
  if (gltfJson) return;
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
    // every load. closeFile() is what drops it.
    closeFile();
    showError(`Could not bring back ${name}: ${messageOf(error)}`);
  }
}

function applySession({ source, doc, view }: Session): void {
  const json = doc.json;
  if (typeof json !== 'object' || json === null) {
    throw new Error('the stored document is unreadable');
  }
  assertGltf2(json);

  // The pristine source is parsed as well as kept: it is where the names the
  // file itself carried come from, so a restored rename is still a rename, with
  // something to revert to.
  let pristine: GltfJson;
  if (source.isGlb) {
    if (!(source.source instanceof ArrayBuffer)) throw new Error('the stored file is unreadable');
    const parsed = parseGlb(source.source);
    pristine = parsed.json;
    glbChunks = parsed.otherChunks;
    sourceBuffer = source.source;
    sourceText = null;
  } else {
    if (typeof source.source !== 'string') throw new Error('the stored file is unreadable');
    pristine = parseGltfText(source.source);
    glbChunks = [];
    sourceBuffer = null;
    sourceText = source.source;
  }

  gltfJson = json;
  originalNames = captureOriginals(pristine, json);
  sourceIsGlb = source.isGlb;
  sourceWasPretty = source.wasPretty;
  // Records from an earlier build know only the name; the bytes still give the
  // size back for a .glb, and a .gltf simply shows no size for this one file.
  modelPath = source.filePath ?? source.fileName;
  modelSize =
    source.fileSize ?? (source.source instanceof ArrayBuffer ? source.source.byteLength : -1);
  exportBaseName = source.fileName.replace(/\.(glb|gltf)$/i, '');
  // Records from an earlier build of the app can be missing pieces this one
  // expects; none of them is worth refusing the restore over.
  resources = new Map((source.resources ?? []).map(({ path, file }) => [path, file]));
  addedImages = new Map((source.addedImages ?? []).map(({ index, file }) => [index, file]));
  mapEdits = doc.mapEdits ?? 0;
  movedNodes = new Map((doc.movedNodes ?? []).map(({ index, original }) => [index, original]));

  sessionStamp = source.stamp;
  sessionBroken = false;
  sessionFileName = source.fileName;
  markSession(source.fileName);

  gltfNote.hidden = source.isGlb;
  fileNameEl.textContent = source.fileName;
  menubarFile.textContent = source.fileName;
  exportBtn.textContent = source.isGlb ? 'Download .glb' : 'Download .gltf';

  if (view) {
    setGridVisible(view.gridVisible !== false);
    if (view.gizmo) {
      setGizmoMode(view.gizmo.mode);
      setGizmoSpace(view.gizmo.space);
      setGizmoEnabled(view.gizmo.enabled);
    }
    // Applied once the preview has something to look at.
    pendingView = view.camera ?? null;
  }

  updateSceneSelect(view?.sceneIndex);
  buildEditor();
  dropzone.hidden = true;
  toolbar.hidden = false;
  viewportInfo.hidden = false;
  const tab = view?.tab ?? '';
  setTab(isSidebarTab(tab) ? tab : 'scene');
  if (view?.selection) selectTarget(view.selection, { scroll: true });
  void startViewer();

  const changes = modifiedCount() + mapEdits + movedNodes.size;
  showFlash(
    changes > 0
      ? `Restored ${source.fileName} — ${changes} change${changes === 1 ? '' : 's'} not downloaded yet`
      : `Restored ${source.fileName}`,
  );
}

/**
 * Pairs every entry in the restored document with the name the file gave it, by
 * walking both documents category by category. Entries the user added have no
 * counterpart there, and are their own original.
 */
function captureOriginals(
  pristine: GltfJson,
  edited: GltfJson,
): Map<NamedEntry, { name: string; had: boolean }> {
  const originals = new Map<NamedEntry, { name: string; had: boolean }>();
  for (const category of CATEGORIES) {
    const before = category.list(pristine);
    category.list(edited).forEach((entry, index) => {
      const original = before[index];
      if (!original) return;
      originals.set(entry, { name: getName(original), had: typeof original.name === 'string' });
    });
  }
  return originals;
}

function isSidebarTab(value: string): value is SidebarTab {
  return value === 'scene' || value === 'files' || value === 'tools';
}

// ---------------------------------------------------------------------------
// 3D preview

async function startViewer(options: ViewerOptions = {}): Promise<void> {
  if (!gltfJson) return;
  if (viewerBusy) {
    // Coalesce rather than drop: the caller (scene switch, added files) would
    // otherwise believe its request was applied.
    reloadPending = options;
    return;
  }
  viewerBusy = true;
  const token = ++loadToken;
  if (options.quiet) viewport.classList.add('busy');
  else setOverlay('Loading preview…');

  try {
    const missing = missingBuffers();
    if (missing.length > 0) {
      setOverlay(
        'The preview needs this model’s data file to draw anything. Renaming works without it.',
        { missing, pickers: true },
      );
      return;
    }

    const { Viewer } = await import('./viewer');
    if (!viewer) {
      viewer = new Viewer(viewport, {
        onPick: (ref) => selectTarget(ref, { scroll: true }),
        onRender: () => {
          updateStatus();
          // Rendering is on demand, so this fires when the view has moved —
          // which is exactly when the stored camera is out of date.
          scheduleViewSave();
        },
        onTransform: (node, trs) => applyGizmoTransform(node, trs),
      });
      viewer.setGridVisible(gridVisible);
      viewer.setGizmoMode(gizmoMode);
      viewer.setGizmoSpace(gizmoSpace);
      viewer.setGizmoEnabled(gizmoEnabled);
    }

    const result = await viewer.load({
      source: await buildViewerSource(),
      resources,
      imageUris: listExternalResources(gltfJson).images,
      compression: detectCompression(gltfJson),
      keepView: options.keepView,
    });
    // A newer load (or a Close) started while this one was running.
    if (token !== loadToken) return;

    for (const row of rows) {
      if (!row.target) continue;
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
    if (pendingView) {
      viewer.setView(pendingView);
      pendingView = null;
    }
    refreshVisibilityState();
    updateStatus();
    // The scene is new, so the selection box and gizmo have to be re-attached.
    viewer.select(selection);
    updateMoveButtons();
    updateMenus();
    if (!propertiesEl.contains(document.activeElement)) {
      propSignature = '';
      renderProperties();
    }

    // The viewport works in this case, so never cover it with a blocking
    // overlay — say it in a toast instead.
    setOverlay(null);
    if (result.warnings.length > 0) showFlash(result.warnings.join(' '));
    if (result.substitutedImages.length > 0) {
      const count = result.substitutedImages.length;
      showFlash(
        `${count} texture${count === 1 ? '' : 's'} not supplied — showing placeholders. Drop the image files in to see them.`,
      );
    }
  } catch (error) {
    if (token === loadToken) {
      setOverlay(previewErrorMessage(error), { pickers: missingBuffers().length > 0 });
    }
  } finally {
    if (token === loadToken) {
      viewerBusy = false;
      viewport.classList.remove('busy');
    }
    if (reloadPending && gltfJson) {
      const next = reloadPending;
      reloadPending = null;
      void startViewer(next);
    }
  }
}

/**
 * The preview always parses pristine bytes/text, never the live document:
 * GLTFLoader writes `isBone`/`isSkinnedMesh` into the node and mesh defs it is
 * given, and those would be serialised into the user's download.
 */
async function buildViewerSource(): Promise<ArrayBuffer | string> {
  const sceneCount = gltfJson?.scenes?.length ?? 0;

  // Material edits have to reach the preview, so once anything beyond names has
  // changed the live document is what gets loaded — as a deep copy, for the
  // same reason the pristine bytes are used otherwise.
  if (hasStructuralEdits() && gltfJson) {
    const single = withSingleScene(structuredClone(gltfJson), sceneIndex);
    return sourceIsGlb ? buildGlb(single, glbChunks).arrayBuffer() : JSON.stringify(single);
  }

  if (sourceIsGlb) {
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

function missingBuffers(): string[] {
  if (!gltfJson) return [];
  const { buffers } = listExternalResources(gltfJson);
  return findMissing(buffers, buildResourceLookup(resources));
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

function addResources(picked: PickedFile[]): void {
  if (picked.length === 0) return;
  for (const { path, file } of picked) resources.set(path, file);
  // Images shown as placeholders may now have real files behind them.
  releaseImageUrls();
  propSignature = '';
  renderProperties();
  renderFiles();
  showFlash(`Added ${picked.length} file${picked.length === 1 ? '' : 's'}`);
  // The preview will need these files again after a reload, so they join the
  // stored session as well.
  void saveSourceRecord();
  if (gltfJson) void startViewer({ keepView: true });
}

/** `preferred` is the scene a restored session was last looking at. */
function updateSceneSelect(preferred?: number): void {
  const scenes = gltfJson?.scenes ?? [];
  sceneRow.hidden = scenes.length <= 1;
  const fallback = gltfJson?.scene ?? 0;
  sceneIndex =
    preferred !== undefined && preferred >= 0 && preferred < scenes.length ? preferred : fallback;
  if (scenes.length <= 1) return;
  sceneSelect.textContent = '';
  scenes.forEach((scene, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = getName(scene) || `Scene ${index}`;
    sceneSelect.append(option);
  });
  sceneSelect.value = String(sceneIndex);
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
// Selection & properties

function refFor(row: Row): SelectionRef | null {
  return row.target ? refForTarget(row.target.kind, row.target.index) : null;
}

/**
 * What picking one thing selects. A node is only ever a node: its mesh data has
 * a row of its own, so showing the mesh and material of whatever it happens to
 * draw would describe something the user did not pick. Mesh data does carry its
 * material, the way the editor tabs geometry and material together.
 */
function refForTarget(kind: TargetKind, index: number): SelectionRef {
  return narrowRef({ [kind]: index }) ?? { [kind]: index };
}

function selectTarget(ref: SelectionRef | null, options: { scroll?: boolean } = {}): void {
  // Every producer goes through here — a row, a viewport pick, a restored
  // session — so this is where a reference is reduced to the one thing it is.
  ref = narrowRef(ref);
  selection = ref;
  viewer?.select(ref);

  for (const row of rows) row.el.classList.remove('selected');
  isolateBtn.hidden = ref === null;

  if (ref) {
    const matches = rowsForRef(ref);
    for (const row of matches) row.el.classList.add('selected');
    if (matches[0] && options.scroll) {
      // Never steal focus: the user may be typing in another name.
      matches[0].el.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }
  renderProperties();
  updateMoveButtons();
  updateMenus();
  scheduleViewSave();
}

/**
 * A viewport pick resolves to a node, its mesh data and their material at once,
 * since one three.js object is all three. Only the most specific of those is
 * what the user picked, though: clicking geometry picks the node it belongs to,
 * and its mesh data is a row (and a selection) of its own.
 */
function narrowRef(ref: SelectionRef | null): SelectionRef | null {
  if (!ref) return null;
  if (ref.node !== undefined) return { node: ref.node };
  if (ref.mesh !== undefined) {
    // Mesh data comes with a material: the one that was picked out of the ones
    // it uses, or else the first of them.
    const uses = meshMaterials(gltfJson, ref.mesh);
    const material = ref.material !== undefined && uses.includes(ref.material) ? ref.material : uses[0];
    return material === undefined ? { mesh: ref.mesh } : { mesh: ref.mesh, material };
  }
  if (ref.material !== undefined) return { material: ref.material };
  return null;
}

/** Rows for the most specific part of a reference that has any. */
function rowsForRef(ref: SelectionRef): Row[] {
  for (const kind of ['node', 'mesh', 'material'] as TargetKind[]) {
    const index = ref[kind];
    if (index === undefined) continue;
    const found = rowsByTarget.get(targetKey(kind, index));
    if (found && found.length > 0) return found;
  }
  return [];
}

/**
 * One three.js object is usually a node, a mesh and a material at once, so the
 * properties panel tabs them the way the editor tabs object/geometry/material.
 */
function renderProperties(): void {
  const parts: TargetKind[] = [];
  if (selection) {
    for (const kind of ['node', 'mesh', 'material'] as TargetKind[]) {
      if (selection[kind] !== undefined) parts.push(kind);
    }
  }
  if (parts.length > 0 && !parts.includes(propTab)) propTab = parts[0];

  // Which chip beside a row is lit follows the tab, which has just been settled.
  paintAsideSelection();

  // Rebuilding on every keystroke would blow away the focused field, so the
  // panel is only rebuilt when what it describes actually changes.
  const signature = parts.map((kind) => `${kind}:${selection?.[kind]}`).join('|') + `#${propTab}`;
  if (signature === propSignature) return;
  propSignature = signature;

  propFields = [];
  propToggles = [];
  propTransform = null;
  propertiesEl.textContent = '';

  if (parts.length === 0) {
    const panel = document.createElement('div');
    panel.className = 'Panel';
    const note = document.createElement('p');
    note.className = 'note';
    note.style.margin = '0';
    note.textContent = gltfJson
      ? 'Nothing selected. Click an object in the viewport, or a name in the outliner.'
      : 'No file open.';
    panel.append(note);
    propertiesEl.append(panel);
    return;
  }

  const tabs = document.createElement('div');
  tabs.className = 'Tabs';
  for (const kind of parts) {
    const tab = document.createElement('span');
    tab.className = `Tab${kind === propTab ? ' selected' : ''}`;
    tab.textContent = kind;
    tab.addEventListener('click', () => {
      propTab = kind;
      renderProperties();
    });
    tabs.append(tab);
  }
  propertiesEl.append(tabs, buildPropertyPanel(propTab, selection![propTab]!));
}

function buildPropertyPanel(kind: TargetKind, index: number): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'Panel';

  const entry = entryFor(kind, index);
  // Which of the mesh's materials is being shown comes first: it says what the
  // rest of the panel is about.
  if (kind === 'material' && selection?.mesh !== undefined) {
    const uses = meshMaterials(gltfJson, selection.mesh);
    if (uses.length > 1) panel.append(materialSlotRow(selection.mesh, index, uses));
  }
  panel.append(nameRow(kind, index, entry));
  panel.append(valueRow('Index', String(index), true));

  if (kind === 'node') {
    const node = gltfJson?.nodes?.[index];
    panel.append(valueRow('Type', nodeTypeLabel(index)));
    panel.append(valueRow('Children', String(node?.children?.length ?? 0), true));
    if (node?.mesh !== undefined) panel.append(linkRow('Mesh', 'mesh', node.mesh));
    if (node) for (const row of transformRows(index, node)) panel.append(row);
  } else if (kind === 'mesh') {
    const mesh = gltfJson?.meshes?.[index];
    panel.append(valueRow('Primitives', String(mesh?.primitives?.length ?? 0), true));
    // Mesh data has no transform of its own — only the nodes using it do — so
    // this says where it actually ended up instead.
    const placement = viewer?.placementOf({ mesh: index });
    if (placement) {
      if (placement.instances > 1) {
        panel.append(valueRow('Instances', String(placement.instances), true));
      }
      panel.append(valueRow('World origin', placement.origin.map(formatNumber).join(', ')));
      panel.append(valueRow('Size', placement.size.map(formatNumber).join(', ')));
    }
  } else {
    const material = gltfJson?.materials?.[index];
    panel.append(valueRow('Alpha mode', material?.alphaMode ?? 'OPAQUE'));
    panel.append(valueRow('Double sided', material?.doubleSided === true ? 'yes' : 'no'));
    if (material) {
      for (const spec of MAP_SLOTS) panel.append(textureRow(index, material, spec));
    }
  }

  if (kind !== 'material') panel.append(visibleRow(kind, index));

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
  actions.append(spacer, buttons);
  panel.append(actions);
  return panel;
}

// ---------------------------------------------------------------------------
// Material textures

const ADD_IMAGE = 'add-image';

/**
 * One map slot: a thumbnail of what is bound, and a picker holding every
 * texture in the file plus the file dialog for bringing in a new image. The row
 * also takes a dropped image file, which is the quickest way to wire one up.
 */
function textureRow(
  materialIndex: number,
  material: GltfMaterial,
  spec: (typeof MAP_SLOTS)[number],
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row texture-row';
  row.title = spec.hint;

  const label = document.createElement('span');
  label.className = 'Label';
  label.textContent = spec.label;

  const bound = getMaterialTexture(material, spec.slot)?.index;

  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  if (bound === undefined) thumb.classList.add('empty');
  else void paintThumbnail(thumb, bound);

  const select = document.createElement('select');
  select.className = 'Select texture-select';
  select.setAttribute('aria-label', `${spec.label} texture`);
  select.append(textureOption('', 'None'));
  (gltfJson?.textures ?? []).forEach((texture, index) => {
    select.append(textureOption(String(index), `${index} · ${textureLabel(texture, index)}`));
  });
  select.append(textureOption(ADD_IMAGE, 'Add image…'));
  select.value = bound === undefined ? '' : String(bound);

  select.addEventListener('change', () => {
    if (select.value === ADD_IMAGE) {
      // Put the shown value back: the file dialog may well be cancelled.
      select.value = bound === undefined ? '' : String(bound);
      pendingSlot = { material: materialIndex, slot: spec.slot };
      imageInput.click();
      return;
    }
    void assignTexture(materialIndex, spec.slot, select.value === '' ? null : Number(select.value));
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
      void addImageToSlot(image, materialIndex, spec.slot);
    });
  });

  row.append(label, thumb, select);
  return row;
}

function textureOption(value: string, text: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  return option;
}

/** A texture's most useful name: its own, its image's, or the image's file. */
function textureLabel(texture: GltfTexture, index: number): string {
  const image = texture.source === undefined ? undefined : gltfJson?.images?.[texture.source];
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
  materialIndex: number,
  slot: MapSlot,
  textureIndex: number | null,
): Promise<void> {
  const material = gltfJson?.materials?.[materialIndex];
  if (!material) return;

  const { litEmissive } = setMaterialTexture(material, slot, textureIndex);
  mapEdits++;
  updateFileStats();
  propSignature = '';
  renderProperties();
  updateMenus();
  if (litEmissive) showFlash('Emissive colour set to white, so the texture is visible.');

  if (!viewer) return;
  const applied = await viewer.setMaterialMap(materialIndex, slot, textureIndex);
  // A material nothing in the scene uses has nothing to repaint, so only a
  // texture the preview has never seen is worth re-parsing the file for.
  if (!applied && viewer.hasObjects('material', materialIndex)) {
    void startViewer({ keepView: true, quiet: true });
  }
}

/** Brings an image file into the document and binds it to a slot in one go. */
async function addImageToSlot(
  picked: PickedFile,
  materialIndex: number,
  slot: MapSlot,
): Promise<void> {
  const textureIndex = addImage(picked);
  if (textureIndex === null) return;
  await assignTexture(materialIndex, slot, textureIndex);
  showFlash(`Added ${picked.file.name} as texture ${textureIndex}`);
}

/**
 * Adds an image and a texture pointing at it, and keeps the file around: the
 * preview loads it through the URI, and a .glb export embeds its bytes.
 */
function addImage(picked: PickedFile): number | null {
  const json = gltfJson;
  if (!json) return null;
  const images = (json.images ??= []);
  const textures = (json.textures ??= []);

  const uri = uniqueImageUri(images, picked.path);
  resources.set(uri, picked.file);

  const imageIndex = images.length;
  images.push({ uri, name: picked.file.name, mimeType: mimeTypeOf(picked.file) });
  addedImages.set(imageIndex, picked.file);

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
// Image previews

async function paintThumbnail(host: HTMLElement, textureIndex: number): Promise<void> {
  const source = gltfJson?.textures?.[textureIndex]?.source;
  const url = source === undefined ? null : await imagePreviewUrl(source);
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

function imagePreviewUrl(imageIndex: number): Promise<string | null> {
  const cached = imageUrls.get(imageIndex);
  if (cached !== undefined) return Promise.resolve(cached);
  const url = buildImageUrl(imageIndex);
  imageUrls.set(imageIndex, url);
  return Promise.resolve(url);
}

/**
 * A URL an <img> can show for a glTF image, wherever its bytes live: inline as
 * a data URI, in a file the user supplied, or inside the binary chunk.
 */
function buildImageUrl(imageIndex: number): string | null {
  const json = gltfJson;
  const image = json?.images?.[imageIndex];
  if (!json || !image || !isDisplayableImage(image)) return null;

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
    const bin = sourceIsGlb ? glbChunks.find((chunk) => chunk.type === CHUNK_BIN) : undefined;
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

function releaseImageUrls(): void {
  for (const url of imageUrls.values()) {
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  imageUrls = new Map();
}

// ---------------------------------------------------------------------------
// Node transform

/**
 * Position, rotation and scale, the way the editor shows them: three draggable
 * numbers each, rotation in degrees. A node stating its transform as a matrix
 * is shown decomposed, and editing it writes plain TRS back.
 */
function transformRows(index: number, node: GltfNode): HTMLElement[] {
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
  reset.disabled = !movedNodes.has(index);
  reset.addEventListener('click', () => resetNodeTransform(index));
  const buttons = document.createElement('span');
  buttons.className = 'Buttons';
  buttons.append(reset);
  row.append(spacer, buttons);
  rows.push(row);

  propTransform = { node: index, fields, reset };
  return rows;
}

function vectorRow(
  label: string,
  part: TrsPart,
  values: Vec3,
  fields: Record<TrsPart, HTMLInputElement[]>,
  step: number,
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
      commitTransform(part, current);
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
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'Input Number';
  input.inputMode = 'decimal';
  input.spellcheck = false;
  input.value = formatNumber(value);
  input.setAttribute('aria-label', label);

  const commit = (next: number, live: boolean): void => {
    if (!Number.isFinite(next)) return;
    input.value = formatNumber(next);
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
    commit(round(parseNumber(input.value) + direction * step * scale), false);
  });

  // Scrubbing: the pointer is captured, so the drag survives leaving the input.
  let start: { x: number; value: number } | null = null;
  let dragged = false;
  input.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || document.activeElement === input) return;
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
    commit(round(start.value + travelled * step * (event.shiftKey ? 10 : 1)), true);
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
  const index = propTransform?.node;
  const node = index === undefined ? undefined : gltfJson?.nodes?.[index];
  if (index === undefined || !node) return;

  const trs = readNodeTransform(node);
  if (part === 'rotation') trs.rotation = eulerToQuaternion(values.map(toRadians) as Vec3);
  else trs[part] = [...values];

  rememberTransform(index, node);
  writeNodeTransform(node, trs);
  settleTransform(index, node);
  viewer?.setNodeTransform(index, trs as NodeTrs);
  updateFileStats();
}

/** The gizmo moved something: the document and the fields follow it. */
function applyGizmoTransform(index: number, trs: NodeTrs): void {
  const node = gltfJson?.nodes?.[index];
  if (!node) return;

  rememberTransform(index, node);
  writeNodeTransform(node, trs as Trs);
  settleTransform(index, node);
  updateFileStats();

  if (propTransform?.node !== index) return;
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

/** Keeps the file's own transform for this node, the first time it is moved. */
function rememberTransform(index: number, node: GltfNode): void {
  if (movedNodes.has(index)) return;
  movedNodes.set(index, captureNodeTransform(node));
  updateTransformReset(index);
}

/**
 * Drops the "moved" mark when a node ends up written exactly as the file had
 * it, so putting something back really does undo the change.
 */
function settleTransform(index: number, node: GltfNode): void {
  const original = movedNodes.get(index);
  if (!original || !sameTransform(original, captureNodeTransform(node))) return;
  movedNodes.delete(index);
  updateTransformReset(index);
}

function updateTransformReset(index: number): void {
  if (propTransform?.node === index) propTransform.reset.disabled = !movedNodes.has(index);
}

function resetNodeTransform(index: number): void {
  const saved = movedNodes.get(index);
  const node = gltfJson?.nodes?.[index];
  if (!saved || !node) return;

  restoreNodeTransform(node, saved);
  movedNodes.delete(index);
  viewer?.setNodeTransform(index, readNodeTransform(node) as NodeTrs);
  updateFileStats();
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
    // Only a node can be moved, so the buttons say when there is nothing to.
    const what = selection?.node === undefined ? 'Select a node first' : 'the selected node';
    button.title = `${button.textContent?.trim()} ${what} (${GIZMO_KEYS[mode]})`;
  }
  spaceBtn.textContent = gizmoSpace === 'world' ? 'World' : 'Local';
  spaceBtn.disabled = viewer === null;
  updateMenus();
}

/** Short enough to read in a narrow field, exact enough to type back in. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(round(value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseNumber(text: string): number {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : 0;
}

function entryFor(kind: TargetKind, index: number): NamedEntry | undefined {
  if (kind === 'node') return gltfJson?.nodes?.[index];
  if (kind === 'mesh') return gltfJson?.meshes?.[index];
  return gltfJson?.materials?.[index];
}

function nameRow(kind: TargetKind, index: number, entry: NamedEntry | undefined): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const label = document.createElement('span');
  label.className = 'Label';
  label.textContent = 'Name';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'Input';
  input.spellcheck = false;
  input.placeholder = '(unnamed)';
  input.setAttribute('aria-label', `${kind} ${index} name`);

  if (entry) {
    const original = rowsByEntry.get(entry)?.[0]?.original ?? getName(entry);
    input.value = getName(entry);
    input.classList.toggle('modified', input.value !== original);
    input.addEventListener('input', () => applyNameEdit(entry, input));
    input.addEventListener('blur', () => settleNameEdit(entry, input));
    propFields.push({ entry, input, original });
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
function materialSlotRow(mesh: number, current: number, uses: number[]): HTMLElement {
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
    option.textContent = materialLabel(getName(entryFor('material', material) ?? {}), material);
    select.append(option);
  }
  select.value = String(current);
  select.addEventListener('change', () => {
    propTab = 'material';
    selectTarget({ mesh, material: Number(select.value) });
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
function linkRow(label: string, kind: TargetKind, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const key = document.createElement('span');
  key.className = 'Label';
  key.textContent = label;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'Button';
  button.textContent = getName(entryFor(kind, index) ?? {}) || `${kind} ${index}`;
  button.addEventListener('click', () => {
    // Set first: the panel keeps the tab when the new selection still has it.
    propTab = kind;
    selectTarget(refForTarget(kind, index), { scroll: true });
  });

  row.append(key, button);
  return row;
}

function visibleRow(kind: TargetKind, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const key = document.createElement('label');
  key.className = 'Label';
  key.textContent = 'Visible';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `prop-visible-${kind}-${index}`;
  key.setAttribute('for', input.id);
  const state = viewer?.hiddenState(kind, index);
  input.checked = state ? state.reason === null : true;
  input.disabled = viewer === null;
  input.addEventListener('change', () => toggleTargetVisibility(kind, index));

  propToggles.push({ kind, index, input });
  row.append(key, input);
  return row;
}

function nodeTypeLabel(index: number): string {
  const node = gltfJson?.nodes?.[index];
  if (!node) return '—';
  if (node.mesh !== undefined) return 'Mesh';
  if (node.camera !== undefined) return 'Camera';
  if (node.extensions?.KHR_lights_punctual !== undefined) return 'Light';
  for (const skin of gltfJson?.skins ?? []) {
    if (skin.joints?.includes(index)) return 'Bone';
  }
  return 'Group';
}

/** Repaints every eye and visibility box to match what is actually on screen. */
function refreshVisibilityState(): void {
  if (!viewer) return;
  for (const row of rows) {
    if (!row.target || !row.eyeBtn || row.eyeBtn.hidden) continue;
    const { kind, index } = row.target;
    const state = viewer.hiddenState(kind, index);
    const name = row.input.value || `${row.label} ${index}`;

    row.eyeBtn.innerHTML = iconSvg(state.reason === null ? 'eye' : 'eyeOff');
    row.eyeBtn.classList.toggle('off', state.reason !== null);
    row.el.classList.toggle('hidden-3d', state.reason !== null);
    row.el.classList.toggle('hidden-indirect', state.reason !== null && state.reason !== 'self');

    // The label states the situation and what the click will do, since one
    // button covers "hide", "show" and "show whatever is hiding this".
    if (state.reason === 'self') {
      row.eyeBtn.title = `${name} is hidden — click to show it`;
    } else if (state.reason === 'ancestor') {
      row.eyeBtn.title = `Hidden because ${describeTarget('node', state.byNode)} is hidden — click to show that`;
    } else if (state.reason === 'mesh') {
      row.eyeBtn.title = `Hidden because ${describeTarget('mesh', state.byMesh)} is hidden — click to show that`;
    } else {
      row.eyeBtn.title = `Hide ${name}`;
    }
    row.eyeBtn.setAttribute('aria-label', row.eyeBtn.title);
  }

  for (const toggle of propToggles) {
    toggle.input.checked = viewer.hiddenState(toggle.kind, toggle.index).reason === null;
  }
  showAllBtn.hidden = !viewer.anyHidden();
  updateMenus();
}

/** How to refer to whatever is doing the hiding, using its current name. */
function describeTarget(kind: TargetKind, index: number | undefined): string {
  if (index === undefined) return 'something above it';
  // From the document, not from a row: an object's row stands in for its mesh
  // data as well, and its name is the object's.
  const name = getName(entryFor(kind, index) ?? {});
  return name ? `${kind} "${name}"` : `${kind} ${index}`;
}

function toggleTargetVisibility(kind: TargetKind, index: number): void {
  if (!viewer || kind === 'material') return;
  const state = viewer.hiddenState(kind, index);
  // Clicking the eye of something hidden by something else should reveal that,
  // rather than appear to do nothing (or hide it twice over).
  if (state.reason === 'ancestor' && state.byNode !== undefined) {
    viewer.setHidden('node', state.byNode, false);
    showFlash(`Showed ${describeTarget('node', state.byNode)}, which was hiding it`);
  } else if (state.reason === 'mesh' && state.byMesh !== undefined) {
    viewer.setHidden('mesh', state.byMesh, false);
    showFlash(`Showed ${describeTarget('mesh', state.byMesh)}, which was hiding it`);
  } else {
    viewer.toggleHidden(kind === 'node' ? 'node' : 'mesh', index);
  }
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
  for (const name of ['scene', 'files', 'tools'] as SidebarTab[]) {
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
  const open = gltfJson !== null;
  for (const action of ['download', 'reset', 'reset-all', 'close', 'collapse', 'find', 'filter']) {
    setOptionInactive(action, !open);
  }
  setOptionInactive('undo', replaceUndo === null);
  setOptionInactive('frame', viewer === null);
  setOptionInactive('isolate', viewer === null || selection === null);
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

  const collapse = menuOption('collapse');
  if (collapse) collapse.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
}

function runMenuAction(action: string | undefined): void {
  switch (action) {
    case 'open':
      fileInput.click();
      break;
    case 'open-folder':
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
      closeFile();
      break;
    case 'undo':
      undoReplace();
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
      if (viewer && selection) {
        viewer.isolate(selection);
        refreshVisibilityState();
      }
      break;
    case 'show-all':
      viewer?.showAll();
      refreshVisibilityState();
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
  const entry = entryForInput(input);
  if (entry) settleNameEdit(entry, input);
}

/** A row is reachable only while on screen: collapsed, filtered-out and
 *  inactive-tab rows all report no offset parent, so one test covers them. */
function rowIsVisible(row: Row): boolean {
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
  if (selection) {
    for (const row of rowsForRef(selection)) {
      if (rowIsVisible(row)) return Number(row.el.dataset.row);
    }
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

// The file dialog opened by a texture slot's "Add image…".
imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  const slot = pendingSlot;
  pendingSlot = null;
  imageInput.value = '';
  if (!file || !slot) return;
  void addImageToSlot({ path: file.name, file }, slot.material, slot.slot);
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

sidebar.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement;
  renameArmed = null;
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
  const position = rowEl.dataset.row === undefined ? -1 : Number(rowEl.dataset.row);
  const row = rows[position];
  if (!row) return;

  if (target === renameArmed) {
    beginRename(renameArmed);
    renameArmed = null;
    return;
  }

  const button = target.closest<HTMLButtonElement>('button[data-action]');
  if (!button) {
    // Clicking the row itself selects it, the way the editor's outliner does —
    // but a field being typed into and an open dropdown are their own business.
    if (target.tagName !== 'INPUT' && target.tagName !== 'SELECT') {
      const ref = refFor(row);
      if (ref) selectTarget(ref);
    }
    return;
  }

  switch (button.dataset.action) {
    case 'revert':
      setEntryName(row.entry, row.original);
      updateFileStats();
      break;
    case 'toggle-visibility':
      if (row.target) toggleTargetVisibility(row.target.kind, row.target.index);
      break;
    case 'disclose':
      toggleDisclosure(position, row);
      break;
    case 'select-mesh': {
      const index = Number(button.dataset.mesh);
      if (Number.isInteger(index)) {
        propTab = 'mesh';
        selectTarget(refForTarget('mesh', index));
      }
      break;
    }
    case 'select-material': {
      const index = Number(button.dataset.material);
      if (Number.isInteger(index)) {
        const ref: SelectionRef = { material: index };
        // The mesh the row names it under, so the panel can offer the same
        // choice again and knows whose material this is.
        const mesh = row.mesh?.index ?? (row.target?.kind === 'mesh' ? row.target.index : undefined);
        if (mesh !== undefined) ref.mesh = mesh;
        propTab = 'material';
        selectTarget(ref);
      }
      break;
    }
    case 'locate': {
      const ref = refFor(row);
      if (!ref || !viewer) break;
      selectTarget(ref);
      viewer.frame(ref);
      break;
    }
  }
});

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
  // Over something named beside a row, that is what is being pointed at — the
  // mesh outlines every instance of itself, a material every object using it.
  const chip = target.closest<HTMLElement>('.row-chip');
  if (chip?.dataset.material !== undefined) {
    viewer.highlight({ material: Number(chip.dataset.material) });
    return;
  }
  if (chip?.dataset.mesh !== undefined) {
    viewer.highlight({ mesh: Number(chip.dataset.mesh) });
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

searchInput.addEventListener('input', applyFilter);
replaceBtn.addEventListener('click', replaceAll);
for (const input of [findInput, replaceInput]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') replaceAll();
  });
}
findInput.addEventListener('input', () => findInput.classList.remove('invalid'));

exportBtn.addEventListener('click', () => void exportModel());
resetBtn.addEventListener('click', resetAll);
resetAllBtn.addEventListener('click', resetModel);
closeBtn.addEventListener('click', () => closeFile());

frameBtn.addEventListener('click', () => viewer?.frameAll());
isolateBtn.addEventListener('click', () => {
  if (!viewer || !selection) return;
  viewer.isolate(selection);
  refreshVisibilityState();
});
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
sceneSelect.addEventListener('change', () => {
  sceneIndex = Number(sceneSelect.value);
  selectTarget(null);
  // The hierarchy is per-scene, so it has to be rebuilt as well.
  buildEditor();
  void startViewer();
});

for (const button of [addFilesBtn, filesAddBtn]) {
  button.addEventListener('click', () => resourceInput.click());
}
for (const button of [addFolderBtn, filesAddFolderBtn]) {
  button.addEventListener('click', () => resourceFolderInput.click());
}
for (const input of [resourceInput, resourceFolderInput]) {
  input.addEventListener('change', () => {
    if (input.files?.length) addResources(pickedFromList(input.files));
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
    if (gltfJson) {
      event.preventDefault();
      void exportModel();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !editing) {
    if (replaceUndo) {
      event.preventDefault();
      undoReplace();
    }
    return;
  }
  if (event.key === 'Escape') {
    closeMenus();
    if (!editing && selection) selectTarget(null);
    return;
  }
  if (editing || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key.toLowerCase() === 'f' && viewer) {
    if (selection) viewer.frame(selection);
    else viewer.frameAll();
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
  // be noise. It comes back the moment keeping it stops working.
  if (!sessionBroken) return;
  if (hasStructuralEdits()) {
    event.preventDefault();
    return;
  }
  for (const entryRows of rowsByEntry.values()) {
    if (entryRows[0].input.value !== entryRows[0].original) {
      event.preventDefault();
      return;
    }
  }
});

// A hidden tab may never get another tick, so anything still on a save timer is
// written now. `pagehide` covers the reload; `visibilitychange` covers a phone
// switching apps, which is where the tab is likeliest to be discarded outright.
window.addEventListener('pagehide', flushSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSession();
});

initSidebarWidth();
updateMoveButtons();
outlinerEl.append(emptyState('No file open.'));
renderFiles();
renderProperties();
updateMenus();
void restoreSession();
