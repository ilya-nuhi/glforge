/**
 * Copying objects and pasting them back into the file they came from.
 *
 * A copy is a snapshot rather than a list of indices: the objects with
 * everything under them, the mesh data and skins they use, and the animation
 * channels aimed at them. So a paste still works after the originals were
 * deleted, renumbered, or swapped for copies by an undo — copy, delete and
 * paste is how an object moves to another parent. What else a snapshot points
 * at (accessors, materials, cameras, lights) is never renumbered by the app, so
 * it stays good for as long as the file is open.
 *
 * Pasting only appends, so nothing already in the document is renumbered: the
 * one list changed in place is the one the copies are hung in. Like remove.ts
 * it is free of the DOM and of three.js, and only the JSON changes — a pasted
 * object draws the same binary data its original does.
 */
import type {
  GltfAnimationChannel,
  GltfAnimationSampler,
  GltfJson,
  GltfMesh,
  GltfNode,
  GltfSkin,
} from './gltf';

/** What Copy takes out of a document. */
export interface NodeClip {
  /** The copied objects and everything under them; every index below numbers into this. */
  nodes: GltfNode[];
  /** The objects that were picked, rather than coming along under one. */
  roots: ClipRoot[];
  /** Mesh data the nodes draw; a node's `mesh` numbers into this. */
  meshes: GltfMesh[];
  /** Skins the nodes are skinned with; a node's `skin` numbers into this. */
  skins: ClipSkin[];
  /** Animation channels aimed at the nodes, with the keyframes each plays. */
  channels: ClipChannel[];
}

interface ClipRoot {
  node: number;
  /**
   * What it hung off when copied, or null for the scene: the entry itself,
   * which a delete renumbers but keeps, and its index for when an undo has
   * swapped the entry for a copy of itself.
   */
  parent: { entry: GltfNode; index: number } | null;
}

interface ClipSkin {
  skin: GltfSkin;
  /**
   * Every joint is among the copied nodes, numbered the way they are, and the
   * paste gets a skeleton of its own. Otherwise the joints are the document's,
   * and the copy is skinned to the same bones as its original.
   */
  own: boolean;
}

interface ClipChannel {
  node: number;
  path: string;
  sampler: GltfAnimationSampler;
}

export interface Pasted {
  /** The copies of the clip's roots, as the document now numbers them. */
  roots: number[];
  /** How many entries each collection gained, all of them at its end. */
  added: { nodes: number; meshes: number; skins: number };
}

/** A paste that was refused: a copied object skinned to bones that were not copied with it, and have changed since. */
export interface PasteBlocked {
  blocked: { node: GltfNode };
}

/**
 * Copies objects with everything under them. An object picked along with
 * something above it comes along under that anyway, and is not copied twice.
 */
export function copyNodes(json: GltfJson, picked: number[]): NodeClip | null {
  const nodes = json.nodes ?? [];
  const parents = parentsOf(nodes);
  const pickedSet = new Set(picked.filter((index) => nodes[index] !== undefined));
  const underPicked = (index: number): boolean => {
    // A malformed file can describe a cycle; stop once one has been walked round.
    const seen = new Set<number>();
    for (let at = parents.get(index); at !== undefined && !seen.has(at); at = parents.get(at)) {
      if (pickedSet.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const roots = [...pickedSet].filter((index) => !underPicked(index));
  if (roots.length === 0) return null;

  // Each root is followed by everything under it, so the copies list the way the outliner does.
  const local = new Map<number, number>();
  const order: number[] = [];
  const visit = (index: number): void => {
    if (local.has(index) || !nodes[index]) return;
    local.set(index, order.length);
    order.push(index);
    for (const child of nodes[index].children ?? []) visit(child);
  };
  roots.forEach(visit);

  const meshes: GltfMesh[] = [];
  const meshAt = new Map<number, number>();
  const skins: ClipSkin[] = [];
  const skinAt = new Map<number, number>();
  const copied = order.map((index) => {
    const node = structuredClone(nodes[index]);
    if (node.children) node.children = node.children.flatMap((child) => local.get(child) ?? []);

    if (typeof node.mesh === 'number') {
      const mesh = json.meshes?.[node.mesh];
      if (!mesh) delete node.mesh;
      else {
        if (!meshAt.has(node.mesh)) {
          meshAt.set(node.mesh, meshes.length);
          meshes.push(structuredClone(mesh));
        }
        node.mesh = meshAt.get(node.mesh)!;
      }
    }

    if (typeof node.skin === 'number') {
      const skin = json.skins?.[node.skin];
      if (!skin) delete node.skin;
      else {
        if (!skinAt.has(node.skin)) {
          skinAt.set(node.skin, skins.length);
          skins.push(copySkin(skin, local));
        }
        node.skin = skinAt.get(node.skin)!;
      }
    }
    return node;
  });

  const channels: ClipChannel[] = [];
  for (const animation of json.animations ?? []) {
    for (const channel of animation.channels ?? []) {
      const node = channel.target?.node;
      const path = channel.target?.path;
      if (typeof node !== 'number' || !local.has(node) || typeof path !== 'string') continue;
      const sampler = typeof channel.sampler === 'number' ? animation.samplers?.[channel.sampler] : undefined;
      if (sampler) channels.push({ node: local.get(node)!, path, sampler: structuredClone(sampler) });
    }
  }

  return {
    nodes: copied,
    roots: roots.map((index) => {
      const parent = parents.get(index);
      return {
        node: local.get(index)!,
        parent: parent === undefined ? null : { entry: nodes[parent], index: parent },
      };
    }),
    meshes,
    skins,
    channels,
  };
}

/** A skin as the copy has it: numbered among the copies when they hold all of its joints. */
function copySkin(skin: GltfSkin, local: Map<number, number>): ClipSkin {
  const copy = structuredClone(skin);
  const joints = skin.joints ?? [];
  const own = joints.length > 0 && joints.every((joint) => local.has(joint));
  if (own) {
    copy.joints = joints.map((joint) => local.get(joint)!);
    // Only a hint to loaders: kept when it was copied too, dropped otherwise.
    if (typeof copy.skeleton === 'number') {
      const skeleton = local.get(copy.skeleton);
      if (skeleton === undefined) delete copy.skeleton;
      else copy.skeleton = skeleton;
    }
  }
  return { skin: copy, own };
}

/**
 * Pastes a copy into the document. With `beside`, the copies hang next to that
 * object, right after it; without it, each goes back under whatever its
 * original hung off — the scene when that is gone. Mesh data still in the
 * document is shared, the way the originals share it; mesh data deleted since
 * comes back. The copies play in every animation their originals play in.
 */
export function pasteNodes(
  json: GltfJson,
  clip: NodeClip,
  scene: number,
  beside: number | null,
): Pasted | PasteBlocked {
  // Skins borrowed from the document have to be there still, joints and all —
  // checked before anything is written.
  const skinList = json.skins ?? [];
  const skinKeys = skinList.map(entryKey);
  const skinIndex: number[] = [];
  for (let at = 0; at < clip.skins.length; at++) {
    const { skin, own } = clip.skins[at];
    if (own) continue;
    const found = skinKeys.indexOf(entryKey(skin));
    if (found === -1) return { blocked: { node: clip.nodes.find((node) => node.skin === at)! } };
    skinIndex[at] = found;
  }

  const nodeList = json.nodes ?? [];
  const base = nodeList.length;
  const parents = parentsOf(nodeList);

  const meshList = json.meshes ?? [];
  const meshKeys = meshList.map(entryKey);
  let addedMeshes = 0;
  const meshIndex = clip.meshes.map((mesh) => {
    const found = meshKeys.indexOf(entryKey(mesh));
    if (found !== -1) return found;
    meshList.push(structuredClone(mesh));
    meshKeys.push(entryKey(mesh));
    addedMeshes++;
    return meshList.length - 1;
  });
  if (meshList.length > 0) json.meshes = meshList;

  let addedSkins = 0;
  clip.skins.forEach(({ skin, own }, at) => {
    if (!own) return;
    const copy = structuredClone(skin);
    copy.joints = (skin.joints ?? []).map((joint) => base + joint);
    if (typeof skin.skeleton === 'number') copy.skeleton = base + skin.skeleton;
    skinList.push(copy);
    skinIndex[at] = skinList.length - 1;
    addedSkins++;
  });
  if (skinList.length > 0) json.skins = skinList;

  for (const source of clip.nodes) {
    const node = structuredClone(source);
    if (node.children) node.children = node.children.map((child) => base + child);
    if (typeof node.mesh === 'number') node.mesh = meshIndex[node.mesh];
    if (typeof node.skin === 'number') node.skin = skinIndex[node.skin];
    nodeList.push(node);
  }
  json.nodes = nodeList;

  // Copies are named apart from their originals; what is under them keeps its names.
  const taken = new Set(nodeList.flatMap((node) => (typeof node.name === 'string' ? [node.name] : [])));
  const roots = clip.roots.map((root) => base + root.node);
  for (const index of roots) {
    const node = nodeList[index];
    if (!node.name) continue;
    node.name = copyName(taken, node.name);
    taken.add(node.name);
  }

  if (beside !== null && nodeList[beside] && beside < base) {
    hang(json, scene, parents.get(beside) ?? null, roots, beside);
  } else {
    clip.roots.forEach((root, at) => hang(json, scene, findParent(nodeList, base, root.parent), [roots[at]]));
  }

  // Each animation that plays an original gets a channel for its copy, from the
  // same keyframes: found by what the channel plays, since animations may have
  // been renumbered since the copy was taken.
  for (const animation of json.animations ?? []) {
    const channels = animation.channels ?? [];
    const samplers = animation.samplers ?? [];
    const samplerKeys = samplers.map(entryKey);
    const targets = new Set<string>();
    const added: GltfAnimationChannel[] = [];
    for (const wanted of clip.channels) {
      const node = base + wanted.node;
      const target = `${node}:${wanted.path}`;
      // glTF allows one channel per node and property in an animation.
      if (targets.has(target)) continue;
      const key = entryKey(wanted.sampler);
      const match = channels.find(
        (channel) =>
          channel.target?.path === wanted.path &&
          typeof channel.sampler === 'number' &&
          samplerKeys[channel.sampler] === key,
      );
      if (!match) continue;
      targets.add(target);
      added.push({ sampler: match.sampler, target: { node, path: wanted.path } });
    }
    if (added.length > 0) animation.channels = [...channels, ...added];
  }

  return { roots, added: { nodes: clip.nodes.length, meshes: addedMeshes, skins: addedSkins } };
}

/** "Tree copy", then "Tree copy 2" and on; a copy of a copy counts on from its original's name. */
function copyName(taken: Set<string>, name: string): string {
  const base = name.replace(/ copy(?: \d+)?$/, '') || name;
  let candidate = `${base} copy`;
  for (let count = 2; taken.has(candidate); count++) candidate = `${base} copy ${count}`;
  return candidate;
}

/** Each node's parent, by index; a root has none. */
function parentsOf(nodes: GltfNode[]): Map<number, number> {
  const parents = new Map<number, number>();
  nodes.forEach((node, index) => {
    for (const child of node.children ?? []) {
      if (!parents.has(child)) parents.set(child, index);
    }
  });
  return parents;
}

/** Where a root's original hung: the same entry, else a node of the same name where it was. */
function findParent(nodes: GltfNode[], base: number, parent: ClipRoot['parent']): number | null {
  if (!parent) return null;
  const at = nodes.indexOf(parent.entry);
  if (at !== -1 && at < base) return at;
  const there = nodes[parent.index];
  if (parent.index < base && there && parent.entry.name && there.name === parent.entry.name) return parent.index;
  return null;
}

/**
 * Hangs nodes off a parent — off the scene for null — right after `after` when
 * that is among its children, at the end otherwise.
 */
function hang(json: GltfJson, scene: number, parent: number | null, nodes: number[], after?: number): void {
  const insert = (list: number[] = []): number[] => {
    const at = after === undefined ? -1 : list.indexOf(after);
    return at === -1 ? [...list, ...nodes] : [...list.slice(0, at + 1), ...nodes, ...list.slice(at + 1)];
  };
  if (parent === null) {
    // A file with no scene lists nothing: an object hanging off nothing is a root already.
    const holder = json.scenes?.[scene];
    if (holder) holder.nodes = insert(holder.nodes);
  } else {
    const holder = json.nodes?.[parent];
    if (holder) holder.children = insert(holder.children);
  }
}

/** An entry as text, its names left out: a rename since the copy does not make it another entry. */
function entryKey(entry: object): string {
  return JSON.stringify(entry, (key, value: unknown) => (key === 'name' ? undefined : value));
}
