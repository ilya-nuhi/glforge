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
import { buildHierarchy } from './tree';
import type {
  CameraView,
  GizmoMode,
  NodeTrs,
  SelectionRef,
  TargetKind,
  Viewer,
} from './viewer';
import './style.css';

interface Category {
  label: string;
  singular: string;
  icon: IconName;
  /** What rows in this category map to in the 3D scene, if anything. */
  kind?: TargetKind;
  list: (json: GltfJson) => NamedEntry[];
}

const CATEGORIES: Category[] = [
  { label: 'Scenes', singular: 'Scene', icon: 'scene', list: (j) => j.scenes ?? [] },
  { label: 'Nodes', singular: 'Node', icon: 'nodeMesh', kind: 'node', list: (j) => j.nodes ?? [] },
  { label: 'Meshes', singular: 'Mesh', icon: 'meshData', kind: 'mesh', list: (j) => j.meshes ?? [] },
  { label: 'Skins', singular: 'Skin', icon: 'skin', list: (j) => j.skins ?? [] },
  {
    label: 'Materials',
    singular: 'Material',
    icon: 'material',
    kind: 'material',
    list: (j) => j.materials ?? [],
  },
  { label: 'Textures', singular: 'Texture', icon: 'texture', list: (j) => j.textures ?? [] },
  { label: 'Images', singular: 'Image', icon: 'image', list: (j) => j.images ?? [] },
  {
    label: 'Animations',
    singular: 'Animation',
    icon: 'animation',
    list: (j) => j.animations ?? [],
  },
  { label: 'Cameras', singular: 'Camera', icon: 'nodeCamera', list: (j) => j.cameras ?? [] },
  {
    label: 'Lights',
    singular: 'Light',
    icon: 'nodeLight',
    list: (j) => j.extensions?.KHR_lights_punctual?.lights ?? [],
  },
  {
    label: 'Material variants',
    singular: 'Material variant',
    icon: 'variant',
    list: (j) => j.extensions?.KHR_materials_variants?.variants ?? [],
  },
];

type SidebarTab = 'scene' | 'names' | 'tools';

interface Row {
  entry: NamedEntry;
  label: string;
  /** Index within its own glTF collection. */
  index: number;
  target?: { kind: TargetKind; index: number };
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
const namesEl = $('#names-list');
const propertiesEl = $('#properties');
const searchInput = $<HTMLInputElement>('#search-input');
const findInput = $<HTMLInputElement>('#find-input');
const replaceInput = $<HTMLInputElement>('#replace-input');
const regexToggle = $<HTMLInputElement>('#regex-toggle');
const replaceBtn = $<HTMLButtonElement>('#replace-btn');
const resetBtn = $('#reset-btn');
const closeBtn = $('#close-btn');
const exportBtn = $<HTMLButtonElement>('#export-btn');
const flash = $('#flash');

const SIDEBAR_KEY = 'sceneforge:sidebar-width';
const GITHUB_URL = 'https://github.com/ilya-nuhi/sceneforge';

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

let rows: Row[] = [];
/** One entry can own several rows: a mesh used by two nodes appears twice. */
let rowsByEntry = new Map<NamedEntry, Row[]>();
let rowsByTarget = new Map<string, Row[]>();
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
    updateRowState(row);
  }
  for (const field of propFields) {
    if (field.entry !== entry) continue;
    if (field.input !== source) field.input.value = value;
    field.input.classList.toggle('modified', value !== field.original);
  }
}

function buildEditor(): void {
  outlinerEl.textContent = '';
  namesEl.textContent = '';
  rows = [];
  rowsByEntry = new Map();
  rowsByTarget = new Map();
  noteGroups = [];
  collapsedRows = new Set();
  allCollapsed = false;
  replaceUndo = null;

  // Order matters: hierarchy rows first, so collapsing (which hides the run of
  // deeper rows that follows) never reaches into the flat lists.
  buildOutliner();
  for (const category of CATEGORIES) buildFlatSection(category);

  updateFileStats();

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
  const list = document.createElement('ul');
  outlinerEl.append(list);

  // The scene is the outliner's root row, as in the three.js editor.
  const scene = gltfJson?.scenes?.[sceneIndex];
  if (scene) {
    addRow(list, {
      entry: scene,
      label: 'Scene',
      icon: 'scene',
      index: sceneIndex,
      depth: 0,
      hasChildren: items.length > 0,
      });
  }

  let currentGroup: { el: HTMLElement; rows: Row[] } | null = null;
  // Everything the scene reaches hangs off the scene row; the leftovers that
  // follow the group note belong to no scene, so they stay at the root.
  let offset = scene ? 1 : 0;

  for (const item of items) {
    if (item.groupNote) {
      offset = 0;
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
      depth: item.depth + offset,
      hasChildren: item.hasChildren,
      target: item.target,
    });
    currentGroup?.rows.push(row);
  }

  if (rows.length === 0) {
    outlinerEl.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'This file has no scene contents.';
    outlinerEl.append(empty);
  }
}

function buildFlatSection(category: Category): void {
  const entries = category.list(gltfJson!);
  if (entries.length === 0) return;
  const { section, list } = createSection(category.label, String(entries.length));
  entries.forEach((entry, index) => {
    addRow(list, {
      entry,
      label: category.singular,
      icon: category.icon,
      index,
      depth: 0,
      hasChildren: false,
      target: category.kind ? { kind: category.kind, index } : undefined,
    });
  });
  namesEl.append(section);
}

function createSection(title: string, badge: string): { section: HTMLElement; list: HTMLUListElement } {
  const section = document.createElement('section');
  section.className = 'category';

  const heading = document.createElement('h2');
  heading.textContent = title;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = badge;
  heading.append(count);

  const list = document.createElement('ul');
  section.append(heading, list);
  return { section, list };
}

function addRow(list: HTMLUListElement, spec: RowSpec): Row {
  const el = document.createElement('li');
  el.className = 'row';
  el.dataset.row = String(rows.length);

  const indexEl = document.createElement('span');
  indexEl.className = 'row-index';
  indexEl.textContent = String(spec.index);

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
  input.setAttribute('aria-label', `${spec.label} ${spec.index} name`);
  main.append(input);

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
    setEntryName(row.entry, input.value, input);
    updateFileStats();
  });
  // Reaching a name is a selection: the properties panel and the 3D view follow.
  input.addEventListener('focus', () => {
    const ref = refFor(row);
    if (ref) selectTarget(ref);
  });
  // Leaving the field ends the rename, so the row is a row again next time.
  input.addEventListener('blur', () => {
    input.readOnly = true;
  });

  // Only a restored row can already differ from the file, so the usual path
  // pays nothing for this.
  if (row.original !== input.value) updateRowState(row);

  rows.push(row);
  const siblings = rowsByEntry.get(spec.entry);
  if (siblings) siblings.push(row);
  else rowsByEntry.set(spec.entry, [row]);

  if (spec.target) {
    const key = targetKey(spec.target.kind, spec.target.index);
    const targeted = rowsByTarget.get(key);
    if (targeted) targeted.push(row);
    else rowsByTarget.set(key, [row]);
  }
  return row;
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
    if (entryRows[0].input.value !== entryRows[0].original) count++;
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
// Filtering, collapsing, replace, export

function applyFilter(): void {
  const query = searchInput.value.trim().toLowerCase();
  for (const row of rows) {
    row.filtered =
      query === '' ||
      row.input.value.toLowerCase().includes(query) ||
      row.original.toLowerCase().includes(query);
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
  for (const section of namesEl.querySelectorAll<HTMLElement>('.category')) {
    const anyVisible = [...section.querySelectorAll<HTMLElement>('.row')].some((el) => !el.hidden);
    section.hidden = !anyVisible;
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
  for (const row of rows) {
    if (!row.filtered) continue; // respect the active filter
    // The same entry can own several rows; replacing twice would compound.
    if (done.has(row.entry)) continue;
    done.add(row.entry);

    const current = row.input.value;
    const next = replacer(current);
    if (next === current) continue;
    undo.push({ entry: row.entry, value: current });
    setEntryName(row.entry, next);
  }
  replaceUndo = undo.length > 0 ? undo : null;
  updateFileStats();
  updateMenus();
  showFlash(
    undo.length > 0
      ? `Replaced in ${undo.length} name${undo.length === 1 ? '' : 's'} — Ctrl+Z to undo`
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
  noteGroups = [];
  collapsedRows = new Set();
  allCollapsed = false;
  resources = new Map();
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
  namesEl.textContent = '';
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
  return value === 'scene' || value === 'names' || value === 'tools';
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

/**
 * A row's reference, enriched down the chain so selecting a node from the list
 * shows the same node/mesh/material properties as clicking it in the viewport.
 */
function refFor(row: Row): SelectionRef | null {
  if (!row.target) return null;
  const { kind, index } = row.target;
  const ref: SelectionRef = { [kind]: index };

  const meshIndex = kind === 'node' ? gltfJson?.nodes?.[index]?.mesh : kind === 'mesh' ? index : undefined;
  if (kind === 'node' && meshIndex !== undefined) ref.mesh = meshIndex;
  if (meshIndex !== undefined) {
    const material = gltfJson?.meshes?.[meshIndex]?.primitives?.[0]?.material;
    if (typeof material === 'number') ref.material = material;
  }
  return ref;
}

function selectTarget(ref: SelectionRef | null, options: { scroll?: boolean } = {}): void {
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
  panel.append(nameRow(kind, index, entry));
  panel.append(valueRow('Index', String(index), true));

  if (kind === 'node') {
    const node = gltfJson?.nodes?.[index];
    panel.append(valueRow('Type', nodeTypeLabel(index)));
    panel.append(valueRow('Children', String(node?.children?.length ?? 0), true));
    if (node?.mesh !== undefined && selection?.mesh !== undefined) {
      panel.append(linkRow('Mesh', 'mesh', node.mesh));
    }
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
    input.addEventListener('input', () => {
      setEntryName(entry, input.value, input);
      updateFileStats();
    });
    propFields.push({ entry, input, original });
  } else {
    input.disabled = true;
  }

  row.append(label, input);
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

/** A row that jumps the selection to a related entry, like the editor's links. */
function linkRow(label: string, kind: TargetKind, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'Row';
  const key = document.createElement('span');
  key.className = 'Label';
  key.textContent = label;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'Button';
  const name = rowsByTarget.get(targetKey(kind, index))?.[0]?.input.value;
  button.textContent = name || `${kind} ${index}`;
  button.addEventListener('click', () => {
    propTab = kind;
    renderProperties();
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
  const name = rowsByTarget.get(targetKey(kind, index))?.[0]?.input.value;
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
  for (const name of ['scene', 'names', 'tools'] as SidebarTab[]) {
    $(`#tab-${name}`).hidden = name !== tab;
  }
  sidebar.scrollTop = 0;
  sidebarTab = tab;
  scheduleViewSave();
}

function setSidebarWidth(width: number): void {
  const max = Math.max(280, window.innerWidth - 240);
  const clamped = Math.min(Math.max(width, 280), Math.min(720, max));
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
  try {
    localStorage.setItem(SIDEBAR_KEY, String(clamped));
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
  for (const action of ['download', 'reset', 'close', 'collapse', 'find', 'filter']) {
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
  input.readOnly = false;
  input.focus();
  input.select();
}

/** Ends the rename without leaving the row, so the tree keys come back. */
function endRename(input: HTMLInputElement): void {
  input.readOnly = true;
  input.select();
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
    // Clicking the row itself selects it, the way the editor's outliner does.
    if (target.tagName !== 'INPUT') {
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
  const rowEl = (event.target as HTMLElement).closest<HTMLLIElement>('li.row');
  const row = rowEl?.dataset.row === undefined ? undefined : rows[Number(rowEl.dataset.row)];
  viewer.highlight(row ? refFor(row) : null);
});
sidebar.addEventListener('pointerleave', () => viewer?.highlight(null));

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

addFilesBtn.addEventListener('click', () => resourceInput.click());
addFolderBtn.addEventListener('click', () => resourceFolderInput.click());
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
  resizer.addEventListener(type, () => document.body.classList.remove('resizing'));
}
resizer.addEventListener('dblclick', () => setSidebarWidth(350));

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
renderProperties();
updateMenus();
void restoreSession();
