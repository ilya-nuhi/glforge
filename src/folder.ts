/**
 * The folder the model came from, as a tree.
 *
 * A drop or a directory picker hands over a flat list of files that each
 * remember the path they sat at (see `files.ts`). This turns those paths back
 * into the folder structure the user recognises, so the Files tab can show what
 * was supplied alongside the model — and, file by file, what the document
 * actually reaches for.
 */
import { baseName } from './resources';

/** What the open document uses a supplied file for, if anything. */
export type FileRole =
  /** The `.glb` / `.gltf` itself. */
  | 'model'
  /** Geometry/animation data: the preview cannot draw anything without it. */
  | 'buffer'
  /** A texture image the document points at. */
  | 'image'
  /** An image the user brought in, which the download folds back in. */
  | 'added'
  /** Supplied, but nothing in the document refers to it. */
  | 'unused';

export interface FolderFile {
  /** Path the file arrived at, e.g. `MyModel/textures/wood.png`. */
  path: string;
  /** Negative when it is not known, which a restored session can leave behind. */
  size: number;
  role: FileRole;
  /** The glTF URIs this file is standing in for, if any. */
  usedAs: string[];
}

export interface FolderRow {
  /** The folder's or the file's own path, which is unique within the tree. */
  path: string;
  label: string;
  depth: number;
  /** Null for a folder row. */
  file: FolderFile | null;
  /** Folders only: what the whole subtree below holds. */
  fileCount: number;
  totalSize: number;
}

interface Dir {
  dirs: Map<string, Dir>;
  files: FolderFile[];
}

/**
 * Flattens the paths into display order — every folder followed by its own
 * contents — so the same "a collapsed row hides the run of deeper rows that
 * follows it" rule the outliner uses works here unchanged.
 */
export function buildFolderRows(files: FolderFile[]): FolderRow[] {
  const root: Dir = { dirs: new Map(), files: [] };

  for (const file of files) {
    // Empty and '.' segments would otherwise become folders of their own.
    const parts = file.path.split('/').filter((part) => part !== '' && part !== '.');
    // Everything before the last segment is folders; the last one is the file.
    parts.pop();
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }

  const rows: FolderRow[] = [];
  emit(root, '', 0, rows);
  return rows;
}

function emit(dir: Dir, prefix: string, depth: number, rows: FolderRow[]): void {
  // Folders before files, each alphabetical — the order a file browser uses.
  for (const name of [...dir.dirs.keys()].sort(compare)) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const row: FolderRow = {
      path,
      label: name,
      depth,
      file: null,
      fileCount: 0,
      totalSize: 0,
    };
    rows.push(row);

    const start = rows.length;
    emit(dir.dirs.get(name)!, path, depth + 1, rows);
    // A folder's totals are its whole subtree's, so they are only known once
    // that subtree has been walked.
    for (let index = start; index < rows.length; index++) {
      const file = rows[index].file;
      if (!file) continue;
      row.fileCount++;
      if (file.size > 0) row.totalSize += file.size;
    }
  }

  for (const file of [...dir.files].sort((a, b) => compare(baseName(a.path), baseName(b.path)))) {
    rows.push({
      path: file.path,
      label: baseName(file.path),
      depth,
      file,
      fileCount: 0,
      totalSize: 0,
    });
  }
}

/**
 * The files a folder row holds: the run of deeper rows that follows it, the
 * tree being in depth-first order. Subfolders are walked through, so this is
 * everything below the folder rather than just its immediate contents.
 */
export function filesUnder(rows: FolderRow[], position: number): FolderFile[] {
  const parent = rows[position];
  if (!parent || parent.file !== null) return [];

  const found: FolderFile[] = [];
  for (let index = position + 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.depth <= parent.depth) break;
    if (row.file !== null) found.push(row.file);
  }
  return found;
}

function compare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** File sizes the way a file browser writes them; '—' when it is not known. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 10, none above: enough to tell 1.2 MB from 1.9 MB without
  // implying a precision the units do not have.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
