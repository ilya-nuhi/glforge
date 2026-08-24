/**
 * Keeping the open file and its edits across a page reload.
 *
 * The three.js editor holds its scene in IndexedDB so that a refresh — or a tab
 * the browser decided to discard — does not throw the work away, and this tool
 * wants the same: a session here is a long run of small edits, and the file
 * being edited is megabytes of binary that `localStorage` could not hold.
 *
 * The state is split across three records so a keystroke never rewrites a 50 MB
 * buffer:
 *
 * - `source` — the pristine file, its sidecars, and images added from disk.
 *   Written when a file opens, and again when files are added to it.
 * - `doc` — the edited glTF JSON and what was changed in it. Written, debounced,
 *   as names and transforms change.
 * - `view` — camera, tab, selection, toolbar toggles. Tiny, so written freely.
 *
 * `stamp` is what ties the three together: a `doc` left over from a previous
 * file is discarded rather than applied to the wrong `source`.
 *
 * Everything here degrades to a no-op. A private window, a browser with storage
 * switched off, and a file too big for the quota all leave the app working
 * exactly as it did before — minus the restore.
 */
import type { GltfJson } from './gltf';
import type { NodeTransformKeys } from './transform';
import type { CameraView, GizmoMode, SelectionRef } from './viewer';

export interface SourceRecord {
  stamp: number;
  fileName: string;
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
  /** Node index → the transform the file itself gave it, for reverting. */
  movedNodes: { index: number; original: NodeTransformKeys }[];
}

export interface ViewRecord {
  stamp: number;
  sceneIndex: number;
  tab: string;
  gridVisible: boolean;
  selection: SelectionRef | null;
  camera: CameraView | null;
  gizmo: { mode: GizmoMode; space: 'local' | 'world'; enabled: boolean };
}

export interface Session {
  source: SourceRecord;
  doc: DocRecord;
  /** Absent for a session stored before the view was ever written. */
  view: ViewRecord | null;
}

/**
 * Past this, keeping the file is not worth the seconds of disk writing (and the
 * quota) it would cost. Well above any model this tool is used on in practice.
 */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

const DB_NAME = 'sceneforge';
const DB_VERSION = 1;
const STORE = 'session';
/**
 * The name of the file being kept, in `localStorage` as well: it is the one
 * thing the shell needs *synchronously*, to say "Restoring …" on first paint
 * instead of flashing the dropzone for as long as an IndexedDB read takes.
 */
const MARKER_KEY = 'sceneforge:session';

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
    const [source, doc, view] = await Promise.all([
      read<SourceRecord>(db, 'source'),
      read<DocRecord>(db, 'doc'),
      read<ViewRecord>(db, 'view'),
    ]);
    // A half-written session is no session: the document only makes sense
    // against the source it was edited from.
    if (!source || !doc || doc.stamp !== source.stamp) return null;
    return { source, doc, view: view && view.stamp === source.stamp ? view : null };
  });
}

export const saveSource = (record: SourceRecord): Promise<void> => write('source', record);
export const saveDoc = (record: DocRecord): Promise<void> => write('doc', record);
export const saveView = (record: ViewRecord): Promise<void> => write('view', record);

export function clearSession(): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();
    if (!db) return;
    await transact(db, 'readwrite', (store) => {
      for (const key of ['source', 'doc', 'view']) store.delete(key);
    });
  });
}

/** Out of room — worth telling the user about, unlike every other failure. */
export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
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
 * a file safe: the clear it starts can never land on top of the write that the
 * file opened next has already begun.
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

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error('The browser refused to store the session.');
}
