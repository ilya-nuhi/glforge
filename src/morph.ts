/**
 * Morph targets — Blender's shape keys: shapes a mesh can be blended towards,
 * each by a weight.
 *
 * Every primitive of a mesh carries the same list of targets. How much of each
 * is applied is a weight: the mesh's `weights` are its defaults, and a node
 * drawing the mesh may give `weights` of its own, which win for that node.
 * Neither has to be there — an absent weight is 0. Exporters name the targets
 * in the mesh's `extras.targetNames`: not glTF itself, but what Blender writes
 * and what GLTFLoader reads into `morphTargetDictionary`.
 *
 * Free of three.js, like shadow.ts: the panel reads and writes these before the
 * preview has loaded.
 */
import type { GltfJson, GltfMesh, GltfNode } from './gltf';

/** How many targets a mesh has; every primitive has the same number in a valid file. */
export function morphTargetCount(mesh: GltfMesh | undefined): number {
  return Math.max(0, ...(mesh?.primitives ?? []).map((primitive) => primitive.targets?.length ?? 0));
}

/** Each target's name from `extras.targetNames`, or null where the file gives none. */
export function morphTargetNames(mesh: GltfMesh | undefined): (string | null)[] {
  const names = mesh?.extras?.targetNames;
  return Array.from({ length: morphTargetCount(mesh) }, (_, target) => {
    const name: unknown = Array.isArray(names) ? names[target] : undefined;
    return typeof name === 'string' && name !== '' ? name : null;
  });
}

/**
 * Where the weights a node is drawn with live: on the node when it gives its
 * own, else on the mesh it draws. With no node, the mesh's own.
 */
export function weightsHolder(node: GltfNode | undefined, mesh: GltfMesh): GltfNode | GltfMesh {
  return node?.weights !== undefined ? node : mesh;
}

/** The weights a node — or, with none, its mesh — is drawn with: one per target, 0 where unset. */
export function readWeights(node: GltfNode | undefined, mesh: GltfMesh): number[] {
  const weights = weightsHolder(node, mesh).weights;
  return Array.from({ length: morphTargetCount(mesh) }, (_, target) => {
    const value = weights?.[target];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  });
}

/** Sets one target's weight where it takes effect, writing out the whole list. */
export function writeWeight(node: GltfNode | undefined, mesh: GltfMesh, target: number, value: number): void {
  const weights = readWeights(node, mesh);
  weights[target] = value;
  weightsHolder(node, mesh).weights = weights;
}

/** Copies the weights an entry had, or takes them away when it had none. */
export function restoreWeights(entry: GltfNode | GltfMesh, original: GltfNode | GltfMesh | undefined): void {
  if (original?.weights !== undefined) entry.weights = [...original.weights];
  else delete entry.weights;
}

/** The nodes drawing a mesh. */
export function nodesDrawing(json: GltfJson, mesh: number): number[] {
  return (json.nodes ?? []).flatMap((node, index) => (node.mesh === mesh ? [index] : []));
}

/** Whether any animation drives the weights of one of these nodes. */
export function animatesWeights(json: GltfJson, nodes: number[]): boolean {
  return (json.animations ?? []).some((animation) =>
    (animation.channels ?? []).some(
      (channel) =>
        channel.target?.path === 'weights' &&
        channel.target.node !== undefined &&
        nodes.includes(channel.target.node),
    ),
  );
}
