/**
 * Keeping the open files and their edits across a page reload.
 *
 * The three.js editor holds its scene in IndexedDB so that a refresh — or a tab
 * the browser decided to discard — does not throw the work away, and this tool
 * wants the same: a session here is a long run of small edits, and the files
 * being edited are megabytes of binary that `localStorage` could not hold.
 *
 * Every open model is kept as two records of its own, and the view as one more,
 * so a keystroke never rewrites a 50 MB buffer — nor another model's document:
 *
 * - `source:<stamp>` — the pristine file, its sidecars, and images added from
 *   disk. Written when a file opens, and again when files are added to it.
 * - `doc:<stamp>` — the edited glTF JSON and what was changed in it. Written,
 *   debounced, as names and transforms change.
 * - `view` — camera, tab, selection, toolbar toggles, which model the tabs were
 *   about, where each model was moved to in the scene, and the scene's own
 *   lights and shapes. Tiny, so written freely.
 * - `scenes` — the scenes there are besides the one on show, each with the view
 *   it was left at (which also says which models are its own), and their names.
 *   Absent while there has only ever been one scene, under its first name.
 *
 * `stamp` is what ties a model's two records together: a `doc` left over from a
 * previous file is discarded rather than applied to the wrong `source`. It is
 * also the model's id while it is open, and the order stamps were handed out in
 * is the order the files were opened in.
 *
 * Everything here degrades to a no-op. A private window, a browser with storage
 * switched off, and a file too big for the quota all leave the app working
 * exactly as it did before — minus the restore.
 */
import type { GltfJson } from './gltf';
import type { Collection } from './remove';
import type { EnvironmentSettings, SceneObject } from './scene';
import type { ShadowFlags, ShadowSettings } from './shadow';
import type { NodeTransformKeys } from './transform';
import type { CameraView, GizmoMode, NodeTrs, SelectionRef } from './viewer';

export interface SourceRecord {
  stamp: number;
  fileName: string;
  /** The node of a studio scene the model was imported as, if it was. */
  sceneName?: string;
  /** The path the model sat at in what was dropped, for the folder view. */
  filePath?: string;
  /** Its size in bytes; a .gltf text does not give one back on its own. */
  fileSize?: number;
  isGlb: boolean;
  /** Whether the original `.gltf` text was indented, so export matches it. */
  wasPretty: boolean;
  /** GLB bytes, or glTF JSON text — whichever the file was. */
  source: ArrayBuffer | string;
  /** Sidecars, keyed the way `resources` is: by the path each arrived at. */
  resources: { path: string; file: File }[];
  addedImages: { index: number; file: File }[];
}

export interface DocRecord {
  stamp: number;
  /** The live document, edits and all. */
  json: GltfJson;
  mapEdits: number;
  /** Materials whose type or values were edited. Absent in records from before editing them. */
  materials?: number[];
  /** Node index → the transform the file itself gave it, for reverting. */
  movedNodes: { index: number; original: NodeTransformKeys }[];
  /** Node index → the shadow flags the file itself gave it. Absent in records from before shadows. */
  shadows?: { index: number; original: ShadowFlags }[];
  /** Meshes whose morph target weights were changed. Absent in records from before morphing. */
  morphs?: number[];
  /** Objects, mesh data and animations deleted. Absent in records from before deleting. */
  deleted?: number;
  /** Animations copied. Absent in records from before copying. */
  copied?: number;
  /**
   * Current index → the file's own, for each collection a delete renumbered:
   * what pairs a restored entry with the name the file gave it.
   */
  origins?: Partial<Record<Collection, number[]>>;
}

export interface ViewRecord {
  /** The model the Files and Tools tabs were about, by stamp. */
  active: number | null;
  /** The scene each model had on show, by stamp. */
  scenes: { model: number; index: number }[];
  /**
   * Where the models moved as a whole sat in the scene, by stamp. The scene's
   * alone — none of it is in the documents. Absent in records from before
   * models could be moved.
   */
  placements?: { model: number; trs: NodeTrs }[];
  tab: string;
  gridVisible: boolean;
  selection: SelectionRef | null;
  /** The scene object picked, by id, when the selection is one of those instead. */
  object?: number | null;
  /**
   * The scene's own objects and how it is lit — in no document either. Absent
   * in records from before the scene had objects of its own.
   */
  scene?: {
    objects: SceneObject[];
    environment: EnvironmentSettings;
    /** How shadows are drawn. Absent in records from before there were any. */
    shadows?: ShadowSettings;
    /** A scene worked on for its own sake, which is kept even with no model in it. */
    started: boolean;
  };
  camera: CameraView | null;
  gizmo: { mode: GizmoMode; space: 'local' | 'world'; enabled: boolean };
}

/**
 * Every scene, in the order the scene picker lists them. The one on show has
 * its view in the `view` record, which is written far more often than this.
 */
export interface ScenesRecord {
  active: number;
  list: { id: number; name: string; view: ViewRecord | null }[];
}

/** The view as the single-file build stored it, for bringing that session over. */
interface LegacyViewRecord {
  stamp: number;
  sceneIndex: number;
  tab: string;
  gridVisible: boolean;
  selection: Omit<SelectionRef, 'model'> | null;
  camera: CameraView | null;
  gizmo: ViewRecord['gizmo'];
}

export interface StoredModel {
  source: SourceRecord;
  doc: DocRecord;
}

export interface Session {
  /** In the order the files were opened. */
  models: StoredModel[];
  /** Absent for a session stored before the view was ever written. */
  view: ViewRecord | null;
  /** Absent for a session that has only ever had the one scene. */
  scenes: ScenesRecord | null;
}

/**
 * Past this, keeping a file is not worth the seconds of disk writing (and the
 * quota) it would cost. Well above any model this tool is used on in practice.
 */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

const DB_NAME = 'glforge';
const DB_VERSION = 1;
const STORE = 'session';
/**
 * What is being kept, in `localStorage` as well: it is the one thing the shell
 * needs *synchronously*, to say "Restoring …" on first paint instead of
 * flashing the dropzone for as long as an IndexedDB read takes.
 */
const MARKER_KEY = 'glforge:session';

const sourceKey = (stamp: number) => `source:${stamp}`;
const docKey = (stamp: number) => `doc:${stamp}`;

export function storedSessionName(): string | null {
  try {
    return localStorage.getItem(MARKER_KEY);
  } catch {
    return null;
  }
}

export function markSession(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(MARKER_KEY);
    else localStorage.setItem(MARKER_KEY, name);
  } catch {
    // Storage blocked: the session simply is not advertised on next load.
  }
}

/** What a `source` record will cost to store, for the cap above. */
export function sourceSize(record: SourceRecord): number {
  const source = typeof record.source === 'string' ? record.source.length * 2 : record.source.byteLength;
  let total = source;
  for (const { file } of record.resources) total += file.size;
  return total;
}

export function loadSession(): Promise<Session | null> {
  return enqueue(async () => {
    const db = await openDb();
    if (!db) return null;
    try {
      await migrateLegacy(db);
    } catch {
      // Whatever could not be moved over is simply not restored.
    }
    const [sources, docs, view, scenes] = await Promise.all([
      readRange<SourceRecord>(db, 'source:'),
      readRange<DocRecord>(db, 'doc:'),
      read<ViewRecord>(db, 'view'),
      read<ScenesRecord>(db, 'scenes'),
    ]);
    // A half-written model is no model: the document only makes sense against
    // the source it was edited from.
    const docByStamp = new Map(docs.map((doc) => [doc.stamp, doc]));
    const models = sources
      .filter((source) => docByStamp.has(source.stamp))
      .sort((a, b) => a.stamp - b.stamp)
      .map((source) => ({ source, doc: docByStamp.get(source.stamp)! }));
    const kept = view && Array.isArray(view.scenes) ? view : null;
    const list = scenes && Array.isArray(scenes.list) && scenes.list.length > 0 ? scenes : null;
    // A scene worked on for its own sake is worth bringing back with no model in
    // it, and so is a list of scenes that has one.
    const started = [kept, ...(list?.list.map((entry) => entry.view) ?? [])].some(
      (entry) => entry?.scene?.started === true,
    );
    if (models.length === 0 && !started) return null;
    return { models, view: kept, scenes: list };
  });
}

export const saveSource = (record: SourceRecord): Promise<void> =>
  write(sourceKey(record.stamp), record);
export const saveDoc = (record: DocRecord): Promise<void> => write(docKey(record.stamp), record);
export const saveView = (record: ViewRecord): Promise<void> => write('view', record);

/**
 * The scene list and the view of the scene now on show, together: a switch
 * moves a view from one to the other, and a reload between two separate writes
 * would find the same models claimed by two scenes, or by none.
 */
export function saveScenes(scenes: ScenesRecord, view: ViewRecord): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();
    if (!db) throw new Error('This browser is not storing anything for this site.');
    await transact(db, 'readwrite', (store) => {
      store.put(scenes, 'scenes');
      store.put(view, 'view');
    });
  });
}

/** Stops keeping one model: its file was closed, while others stay open. */
export function forgetModel(stamp: number): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();
    if (!db) return;
    await transact(db, 'readwrite', (store) => {
      store.delete(sourceKey(stamp));
      store.delete(docKey(stamp));
    });
  }).catch(() => undefined);
}

export function clearSession(): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();
    if (!db) return;
    await transact(db, 'readwrite', (store) => store.clear());
  });
}

/** Out of room — worth telling the user about, unlike every other failure. */
export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

/**
 * Moves a session the single-file build stored — one `source`, one `doc` and a
 * `view` of its own shape — to the keys a model has now, so a reload after the
 * update still brings the file back where it was.
 */
async function migrateLegacy(db: IDBDatabase): Promise<void> {
  const source = await read<SourceRecord>(db, 'source');
  if (!source) return;
  const doc = await read<DocRecord>(db, 'doc');
  const view = await read<LegacyViewRecord | ViewRecord>(db, 'view');

  await transact(db, 'readwrite', (store) => {
    store.delete('source');
    store.delete('doc');
    if (!doc || doc.stamp !== source.stamp) return;
    store.put(source, sourceKey(source.stamp));
    store.put(doc, docKey(source.stamp));
    if (!view || !('sceneIndex' in view) || view.stamp !== source.stamp) return;
    const migrated: ViewRecord = {
      active: source.stamp,
      scenes: [{ model: source.stamp, index: view.sceneIndex }],
      tab: view.tab,
      gridVisible: view.gridVisible,
      selection: view.selection ? { ...view.selection, model: source.stamp } : null,
      camera: view.camera,
      gizmo: view.gizmo,
    };
    store.put(migrated, 'view');
  });
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing

function write(key: string, record: SourceRecord | DocRecord | ViewRecord): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();
    // Failing loudly matters here and nowhere else: a caller that believes the
    // file is safe would drop the warning that says otherwise.
    if (!db) throw new Error('This browser is not storing anything for this site.');
    await transact(db, 'readwrite', (store) => store.put(record, key));
  });
}

/**
 * Every operation runs after the one before it. Ordering is what makes closing
 * a file safe: the delete it starts can never land on top of a write that the
 * file opened next has already begun, nor a late write resurrect a closed one.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = chain.then(operation, operation);
  chain = next.catch(() => undefined);
  return next;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Third-party or hardened contexts throw here rather than fail the request.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // A private window, a blocked upgrade, or storage denied outright.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function transact(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
      body(tx.objectStore(STORE));
    } catch (error) {
      // A `put` of something unclonable, or a database that has been deleted
      // from under us, throws synchronously.
      reject(asError(error));
      return;
    }
    tx.oncomplete = () => resolve();
    // Quota failures arrive as an abort, and carry the reason on the transaction.
    tx.onabort = () => reject(asError(tx.error));
    tx.onerror = () => reject(asError(tx.error));
  });
}

function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Every record whose key starts with `prefix`. */
function readRange<T>(db: IDBDatabase, prefix: string): Promise<T[]> {
  return new Promise((resolve) => {
    try {
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll(range);
      request.onsuccess = () => resolve((request.result ?? []) as T[]);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error('The browser refused to store the session.');
}
