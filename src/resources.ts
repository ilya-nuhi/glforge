/**
 * Matching user-supplied sidecar files against the URIs a glTF declares.
 *
 * The two sides rarely agree spelling: glTF URIs are percent-encoded and may
 * contain subdirectories or (from sloppy exporters) backslashes, while a file
 * picker gives only a basename unless a directory was chosen, and macOS hands
 * back decomposed Unicode. Everything is folded to one canonical form.
 */

export function normalizeUri(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // A lone '%' from a hand-edited file: match on the raw text instead.
  }
  return decoded.replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC').toLowerCase();
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Directory pickers expose a relative path; drop the chosen folder itself. */
export function relativePathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (!relative) return '';
  const slash = relative.indexOf('/');
  return slash === -1 ? relative : relative.slice(slash + 1);
}

/**
 * Every way a supplied path could be spelled by a glTF URI: the whole path,
 * then the same path with leading folders peeled off one at a time.
 *
 * A dropped folder gives paths rooted at the folder itself
 * (`MyModel/textures/wood.png`) while the glTF inside it refers to
 * `textures/wood.png`, so the suffixes are what actually match. The bare
 * basename comes last, as the loosest fallback.
 */
export function pathVariants(path: string): string[] {
  const variants: string[] = [];
  let rest = path;
  for (;;) {
    variants.push(rest);
    const slash = rest.indexOf('/');
    if (slash === -1) return variants;
    rest = rest.slice(slash + 1);
  }
}

/** Index of supplied files under every name they could be referenced by. */
export function buildResourceLookup(resources: Map<string, File>): Map<string, File> {
  const lookup = new Map<string, File>();
  for (const [key, file] of resources) {
    for (const candidate of [key, relativePathOf(file), file.name]) {
      if (!candidate) continue;
      // First spelling wins, so a deeper (more specific) path is never
      // displaced by a later file that happens to share its basename.
      for (const variant of pathVariants(normalizeUri(candidate))) {
        if (!lookup.has(variant)) lookup.set(variant, file);
      }
    }
  }
  return lookup;
}

export function resolveResource(
  lookup: Map<string, File>,
  uri: string,
): File | undefined {
  const key = normalizeUri(uri);
  return lookup.get(key) ?? lookup.get(baseName(key));
}

/** URIs with no matching file among those supplied. */
export function findMissing(uris: string[], lookup: Map<string, File>): string[] {
  return uris.filter((uri) => resolveResource(lookup, uri) === undefined);
}
