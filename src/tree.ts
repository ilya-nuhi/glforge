/**
 * Builds a Blender-outliner-style hierarchy from the glTF JSON: one row per
 * object, nested by parent. What an object draws is not split off into rows of
 * its own — like the three.js editor's outliner, the row names its mesh data and
 * that mesh's materials after the object's own name, and their properties live
 * in the panel on the right.
 *
 * The list is flat with a `depth` on every item — collapsing is then a matter
 * of hiding the following run of deeper rows, which is far cheaper than nested
 * DOM for files with thousands of objects.
 */
import type { GltfJson, GltfNode, NamedEntry } from './gltf';
import type { IconName } from './icons';
import type { TargetKind } from './viewer';

export interface TreeItem {
  entry: NamedEntry;
  /** Singular noun for aria labels and placeholders. */
  label: string;
  icon: IconName;
  depth: number;
  hasChildren: boolean;
  /** Present when the row maps to something in the 3D scene. */
  target?: { kind: TargetKind; index: number };
  /** The mesh data the object draws, printed beside it rather than under it. */
  mesh?: EntryUse;
  /** Materials the row uses, printed beside it rather than nested under it. */
  materials?: EntryUse[];
  /** Heading to print above this item, starting a trailing group. */
  groupNote?: string;
}

/**
 * Something a row names beside itself — its mesh data, or one of that mesh's
 * materials. Kept as the entry, not just an index, so a rename anywhere else
 * repaints it.
 */
export interface EntryUse {
  entry: NamedEntry;
  index: number;
}

/**
 * The distinct materials a mesh's primitives use, in the order they appear. A
 * mesh names these beside itself in the outliner, and the properties panel picks
 * between them, so both go through this.
 */
export function meshMaterials(json: GltfJson | null, meshIndex: number): number[] {
  const used: number[] = [];
  for (const primitive of json?.meshes?.[meshIndex]?.primitives ?? []) {
    if (typeof primitive.material === 'number' && !used.includes(primitive.material)) {
      used.push(primitive.material);
    }
  }
  return used;
}

export function buildHierarchy(json: GltfJson, sceneIndex: number): TreeItem[] {
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const materials = json.materials ?? [];

  const joints = new Set<number>();
  for (const skin of json.skins ?? []) {
    for (const joint of skin.joints ?? []) joints.add(joint);
  }

  const items: TreeItem[] = [];
  const visitedNodes = new Set<number>();
  const usedMeshes = new Set<number>();
  const usedMaterials = new Set<number>();

  /** The materials a mesh uses, marked as reached so the leftovers skip them. */
  const usesOf = (meshIndex: number): EntryUse[] => {
    const uses: EntryUse[] = [];
    for (const materialIndex of meshMaterials(json, meshIndex)) {
      const material = materials[materialIndex];
      if (!material) continue;
      usedMaterials.add(materialIndex);
      uses.push({ entry: material, index: materialIndex });
    }
    return uses;
  };

  const iconFor = (node: GltfNode, index: number): IconName => {
    if (node.mesh !== undefined) return 'nodeMesh';
    if (node.camera !== undefined) return 'nodeCamera';
    if (node.extensions?.KHR_lights_punctual !== undefined) return 'nodeLight';
    if (joints.has(index)) return 'nodeBone';
    return 'nodeEmpty';
  };

  const walk = (index: number, depth: number): void => {
    const node = nodes[index];
    // A malformed file can describe a cycle or a shared child; visit once.
    if (!node || visitedNodes.has(index)) return;
    visitedNodes.add(index);

    const children = (node.children ?? []).filter((child) => nodes[child] !== undefined);
    const item: TreeItem = {
      entry: node,
      label: 'Node',
      icon: iconFor(node, index),
      depth,
      // Only real children: what the object draws is named on this row, not
      // nested under it.
      hasChildren: children.length > 0,
      target: { kind: 'node', index },
    };

    const mesh = node.mesh === undefined ? undefined : meshes[node.mesh];
    if (node.mesh !== undefined && mesh) {
      usedMeshes.add(node.mesh);
      item.mesh = { entry: mesh, index: node.mesh };
      item.materials = usesOf(node.mesh);
    }
    items.push(item);

    for (const child of children) walk(child, depth + 1);
  };

  const roots = json.scenes?.[sceneIndex]?.nodes ?? [];
  for (const root of roots) walk(root, 0);

  // Everything the displayed scene does not reach still has to be renameable.
  // Mesh data no object in the scene draws has nowhere else to be named, so it
  // keeps a row of its own down here.
  const leftovers: TreeItem[] = [];
  nodes.forEach((node, index) => {
    if (visitedNodes.has(index)) return;
    const item: TreeItem = {
      entry: node,
      label: 'Node',
      icon: iconFor(node, index),
      depth: 0,
      hasChildren: false,
      target: { kind: 'node', index },
    };
    // An object out here names what it draws just as one in the scene does, so
    // that mesh does not need a second row below.
    const mesh = node.mesh === undefined ? undefined : meshes[node.mesh];
    if (node.mesh !== undefined && mesh) {
      usedMeshes.add(node.mesh);
      item.mesh = { entry: mesh, index: node.mesh };
      item.materials = usesOf(node.mesh);
    }
    leftovers.push(item);
  });
  meshes.forEach((mesh, index) => {
    if (usedMeshes.has(index)) return;
    const uses = usesOf(index);
    leftovers.push({
      entry: mesh,
      label: 'Mesh',
      icon: uses.length > 0 ? 'meshData' : 'meshDataPlain',
      depth: 0,
      hasChildren: false,
      target: { kind: 'mesh', index },
      materials: uses,
    });
  });
  // Runs after the mesh pass above, so a material only an unused mesh refers to
  // is named beside that mesh instead of turning up here as well.
  materials.forEach((material, index) => {
    if (usedMaterials.has(index)) return;
    leftovers.push({
      entry: material,
      label: 'Material',
      icon: 'material',
      depth: 0,
      hasChildren: false,
      target: { kind: 'material', index },
    });
  });

  if (leftovers.length > 0) {
    leftovers[0].groupNote = 'Not used in this scene';
    items.push(...leftovers);
  }

  return items;
}
