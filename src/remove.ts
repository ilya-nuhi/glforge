/**
 * Deleting objects and mesh data from the document.
 *
 * glTF points at everything by index, so taking one node out of the middle of
 * `nodes` renumbers every node after it — and with it every child list, scene
 * root, skin joint and animation channel that points at one. This module is the
 * one place that knows where those references live. Like transform.ts it is
 * free of the DOM and of three.js.
 *
 * Only the JSON changes. The geometry a deleted object drew stays in the binary
 * data, unreferenced: the renamer never re-encodes a buffer, so the download is
 * no smaller, but nothing in it points at what was deleted any more. References
 * held inside vendor extensions (MSFT_lod, KHR_animation_pointer, …) are not
 * followed.
 */
import type { GltfAnimation, GltfAnimationChannel, GltfJson, GltfNode } from './gltf';

/** The collections a delete can renumber. */
export type Collection = 'nodes' | 'meshes' | 'skins' | 'animations';

export interface Removal {
  /** Old index → new, -1 where the entry went, for each collection that lost one. */
  renumbered: Partial<Record<Collection, number[]>>;
  /** Objects removed: the ones asked for and everything under them. */
  nodes: number;
  /** Mesh data removed — asked for, or left with nothing drawing it. */
  meshes: number;
  /** Objects that stayed but lost the mesh they drew. */
  emptied: number;
  /** Puts back every value the delete wrote, leaving the document as it was. */
  undo: () => void;
}

/** A delete that was refused, because an object staying behind would lose a bone. */
export interface RemovalBlocked {
  blocked: {
    /** The object skinned to `joint`, which is not being deleted with it. */
    user: number;
    joint: number;
  };
}

/**
 * Deletes objects and everything under them, the way deleting an object does in
 * the three.js editor. What only they used goes with them: mesh data nothing
 * else draws, skins nothing else is skinned with, and the animation channels
 * aimed at them — plus any animation left with no channel at all.
 */
export function removeNodes(json: GltfJson, roots: number[]): Removal | RemovalBlocked | null {
  const nodes = json.nodes ?? [];
  const removed = subtreeOf(nodes, roots);
  if (removed.size === 0) return null;

  // A bone can only go when nothing staying behind is skinned to it: a skin
  // missing a joint is not a skin, and loaders reject the file.
  const skins = json.skins ?? [];
  const deadSkins = new Set<number>();
  for (let skin = 0; skin < skins.length; skin++) {
    const joint = (skins[skin].joints ?? []).find((index) => removed.has(index));
    if (joint === undefined) continue;
    const user = nodes.findIndex((node, index) => node.skin === skin && !removed.has(index));
    if (user !== -1) return { blocked: { user, joint } };
    deadSkins.add(skin);
  }

  // Mesh data only the deleted objects drew would be left drawn by nothing.
  const meshCount = json.meshes?.length ?? 0;
  const deadMeshes = new Set<number>();
  for (const index of removed) {
    const mesh = nodes[index].mesh;
    if (typeof mesh === 'number' && mesh >= 0 && mesh < meshCount) deadMeshes.add(mesh);
  }
  nodes.forEach((node, index) => {
    if (!removed.has(index) && typeof node.mesh === 'number') deadMeshes.delete(node.mesh);
  });

  const journal = new Journal();
  const nodeMap = compact(journal, json, 'nodes', removed)!;
  const meshMap = compact(journal, json, 'meshes', deadMeshes);
  const skinMap = compact(journal, json, 'skins', deadSkins);

  for (const scene of json.scenes ?? []) rewriteList(journal, scene, 'nodes', nodeMap);
  // Only the nodes that stayed are left to walk.
  for (const node of json.nodes ?? []) {
    rewriteList(journal, node, 'children', nodeMap);
    if (meshMap) rewriteIndex(journal, node, 'mesh', meshMap);
    if (skinMap) rewriteIndex(journal, node, 'skin', skinMap);
  }
  for (const skin of json.skins ?? []) {
    rewriteList(journal, skin, 'joints', nodeMap);
    // Only a hint to loaders, and optional: a skeleton root that went is dropped.
    rewriteIndex(journal, skin, 'skeleton', nodeMap);
  }
  const animationMap = rewriteAnimations(journal, json, nodeMap);

  const renumbered: Removal['renumbered'] = { nodes: nodeMap };
  if (meshMap) renumbered.meshes = meshMap;
  if (skinMap) renumbered.skins = skinMap;
  if (animationMap) renumbered.animations = animationMap;
  return {
    renumbered,
    nodes: removed.size,
    meshes: deadMeshes.size,
    emptied: 0,
    undo: () => journal.undo(),
  };
}

/**
 * Deletes mesh data. The objects that drew it stay, empty — they may well have
 * children — and lose what only means something with a mesh: a skin, morph
 * weights, and the animation channels driving those weights.
 */
export function removeMesh(json: GltfJson, mesh: number): Removal | null {
  if (!json.meshes?.[mesh]) return null;

  const journal = new Journal();
  const meshMap = compact(journal, json, 'meshes', new Set([mesh]))!;
  const unmorphed = new Set<number>();
  (json.nodes ?? []).forEach((node, index) => {
    if (node.mesh !== mesh) {
      rewriteIndex(journal, node, 'mesh', meshMap);
      return;
    }
    journal.set(node, 'mesh', undefined);
    // glTF only allows these on a node that draws a mesh.
    if (node.skin !== undefined) journal.set(node, 'skin', undefined);
    if (node.weights !== undefined) journal.set(node, 'weights', undefined);
    unmorphed.add(index);
  });
  const animationMap = rewriteAnimations(journal, json, undefined, unmorphed);

  const renumbered: Removal['renumbered'] = { meshes: meshMap };
  if (animationMap) renumbered.animations = animationMap;
  return { renumbered, nodes: 0, meshes: 1, emptied: unmorphed.size, undo: () => journal.undo() };
}

/**
 * Deletes one animation. Nothing in a glTF points at an animation, so only the
 * animations after it are renumbered.
 */
export function removeAnimation(json: GltfJson, animation: number): Removal | null {
  if (!json.animations?.[animation]) return null;
  const journal = new Journal();
  const animationMap = compact(journal, json, 'animations', new Set([animation]))!;
  return {
    renumbered: { animations: animationMap },
    nodes: 0,
    meshes: 0,
    emptied: 0,
    undo: () => journal.undo(),
  };
}

/**
 * Adds an animation after the others, where it renumbers nothing. Not a removal,
 * but taken back the same way: it goes on the same undo stack as the deletes,
 * so taking edits back in order never finds the list changed under it.
 */
export function appendAnimation(json: GltfJson, animation: GltfAnimation): Removal {
  const journal = new Journal();
  journal.set(json, 'animations', [...(json.animations ?? []), animation]);
  return { renumbered: {}, nodes: 0, meshes: 0, emptied: 0, undo: () => journal.undo() };
}

// ---------------------------------------------------------------------------
// Rewriting references

/**
 * Animation channels follow what they animate: one aimed at something deleted
 * goes, the rest are renumbered, and an animation left with no channel at all
 * goes too, since glTF does not allow an empty one. Samplers stay behind unused,
 * which the format does allow.
 */
function rewriteAnimations(
  journal: Journal,
  json: GltfJson,
  nodeMap: number[] | undefined,
  /** Nodes that lost their mesh, and with it anything for `weights` to morph. */
  unmorphed: Set<number> = new Set(),
): number[] | undefined {
  const dead = new Set<number>();
  (json.animations ?? []).forEach((animation, index) => {
    const channels = animation.channels;
    if (!Array.isArray(channels)) return;
    const staying = channels.filter((channel) => keepChannel(journal, channel, nodeMap, unmorphed));
    if (staying.length === channels.length) return;
    journal.set(animation, 'channels', staying);
    if (staying.length === 0) dead.add(index);
  });
  return compact(journal, json, 'animations', dead);
}

/** Whether a channel still has something to animate, renumbering it if so. */
function keepChannel(
  journal: Journal,
  channel: GltfAnimationChannel,
  nodeMap: number[] | undefined,
  unmorphed: Set<number>,
): boolean {
  const target = channel.target;
  if (typeof target?.node !== 'number') return true;
  if (target.path === 'weights' && unmorphed.has(target.node)) return false;
  if (!nodeMap) return true;
  const next = renumber(target.node, nodeMap);
  if (next === null) return false;
  if (next !== target.node) journal.set(target, 'node', next);
  return true;
}

/** The given nodes and everything under them. */
function subtreeOf(nodes: GltfNode[], roots: number[]): Set<number> {
  const found = new Set<number>();
  const pending = [...roots];
  while (pending.length > 0) {
    const index = pending.pop()!;
    // A malformed file can describe a cycle or a shared child; visit once.
    if (found.has(index) || !nodes[index]) continue;
    found.add(index);
    pending.push(...(nodes[index].children ?? []));
  }
  return found;
}

/**
 * Takes the removed entries out of a collection, returning old index → new. An
 * emptied collection goes altogether, since glTF allows no empty arrays.
 */
function compact(
  journal: Journal,
  json: GltfJson,
  key: Collection,
  removed: Set<number>,
): number[] | undefined {
  const list: unknown[] | undefined = json[key];
  if (!list || removed.size === 0) return undefined;
  const kept = list.filter((_, index) => !removed.has(index));
  journal.set(json, key, kept.length > 0 ? kept : undefined);

  const map: number[] = [];
  let next = 0;
  for (let index = 0; index < list.length; index++) map.push(removed.has(index) ? -1 : next++);
  return map;
}

/** Where an index ends up, or null if it went. One the file got wrong is left alone. */
function renumber(index: number, map: number[]): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= map.length) return index;
  return map[index] === -1 ? null : map[index];
}

/** Renumbers an index list, dropping what went; an emptied list goes too. */
function rewriteList(journal: Journal, target: object, key: string, map: number[]): void {
  const list = (target as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return;
  const next = (list as number[])
    .map((index) => renumber(index, map))
    .filter((index): index is number => index !== null);
  if (next.length === list.length && next.every((index, at) => index === list[at])) return;
  journal.set(target, key, next.length > 0 ? next : undefined);
}

/** Renumbers a single index; one pointing at something that went loses its key. */
function rewriteIndex(journal: Journal, target: object, key: string, map: number[]): void {
  const index = (target as Record<string, unknown>)[key];
  if (typeof index !== 'number') return;
  const next = renumber(index, map);
  if (next !== index) journal.set(target, key, next ?? undefined);
}

/**
 * Every write a delete makes, kept so it can be taken back. Entries are never
 * swapped for copies — only the keys inside them and the arrays that list them
 * are replaced — so everything else holding an entry (an outliner row, a
 * remembered original name) still holds the live one after an undo.
 */
class Journal {
  private readonly steps: (() => void)[] = [];

  /** Writes `value` under `key`, or removes the key for `undefined`. */
  set(target: object, key: string, value: unknown): void {
    const bag = target as Record<string, unknown>;
    const had = Object.hasOwn(bag, key);
    const previous = bag[key];
    this.steps.push(() => {
      if (had) bag[key] = previous;
      else delete bag[key];
    });
    if (value === undefined) delete bag[key];
    else bag[key] = value;
  }

  undo(): void {
    for (let step = this.steps.length - 1; step >= 0; step--) this.steps[step]();
  }
}
