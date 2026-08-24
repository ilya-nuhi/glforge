/**
 * Turning a drop or a file picker into a flat list of files that remember where
 * they came from.
 *
 * A dropped folder is not in `DataTransfer.files` — that only ever holds the
 * top-level entries, and a directory arrives there as a zero-byte `File` that
 * cannot be read. The tree has to be walked through the entries API instead,
 * which is also the only way to learn the path a file sat at, and paths are
 * what makes `textures/wood.png` in the glTF find the right file.
 */

export interface PickedFile {
  /** Path relative to whatever was dropped or chosen, e.g. `textures/wood.png`. */
  path: string;
  file: File;
}

/** Deep enough for any asset folder; a guard against an entry tree that loops. */
const MAX_DEPTH = 32;

export function pickedFromList(files: FileList | File[]): PickedFile[] {
  return Array.from(files, (file) => ({ path: pathOf(file), file }));
}

/** Directory pickers expose the path under the chosen folder; drops do not. */
function pathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative || file.name;
}

/**
 * Must be called synchronously from the drop handler: `DataTransfer.items` is
 * emptied the moment the event finishes dispatching, so every entry is taken
 * before the first `await`.
 */
export function collectDroppedFiles(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const entries: FileSystemEntry[] = [];
  const items = dataTransfer.items;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  // Safari before 11.1 and any browser that hands back no entries: the plain
  // file list is all there is, so folders are simply not available.
  if (entries.length === 0) return Promise.resolve(pickedFromList(dataTransfer.files));
  return walk(entries);
}

async function walk(roots: FileSystemEntry[]): Promise<PickedFile[]> {
  const picked: PickedFile[] = [];
  const queue = roots.map((entry) => ({ entry, depth: 0 }));

  while (queue.length > 0) {
    const { entry, depth } = queue.shift()!;
    if (entry.isFile) {
      const file = await fileOf(entry as FileSystemFileEntry);
      if (file) picked.push({ path: entry.fullPath.replace(/^\/+/, '') || file.name, file });
    } else if (entry.isDirectory && depth < MAX_DEPTH) {
      for (const child of await readDirectory(entry as FileSystemDirectoryEntry)) {
        queue.push({ entry: child, depth: depth + 1 });
      }
    }
  }
  return picked;
}

/** `readEntries` yields a batch at a time and signals the end with an empty one. */
function readDirectory(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const readBatch = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolve(all));
    };
    readBatch();
  });
}

/** A file that has been moved or deleted since the drag started resolves to null. */
function fileOf(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file((file) => resolve(file), () => resolve(null)));
}
