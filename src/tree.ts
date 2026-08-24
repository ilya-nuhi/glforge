/**
 * Builds a Blender-outliner-style hierarchy from the glTF JSON: objects nested
 * by parent, each object's mesh data nested under it, and each mesh's materials
 * nested under that.
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
  /** Heading to print above this item, starting a trailing group. */
  groupNote?: string;
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

  const materialsOf = (meshIndex: number): number[] => {
    const seen: number[] = [];
    for (const primitive of meshes[meshIndex]?.primitives ?? []) {
      if (typeof primitive.material === 'number' && !seen.includes(primitive.material)) {
        seen.push(primitive.material);
      }
    }
    return seen;
  };

  const pushMesh = (meshIndex: number, depth: number): void => {
    const mesh = meshes[meshIndex];
    if (!mesh) return;
    usedMeshes.add(meshIndex);
    const used = materialsOf(meshIndex);
    items.push({
      entry: mesh,
      label: 'Mesh',
      // A mesh with no material at all reads differently from one that has some.
      icon: used.length > 0 ? 'meshData' : 'meshDataPlain',
      depth,
      hasChildren: used.length > 0,
      target: { kind: 'mesh', index: meshIndex },
    });
    for (const materialIndex of used) {
      const material = materials[materialIndex];
      if (!material) continue;
      usedMaterials.add(materialIndex);
      items.push({
        entry: material,
        label: 'Material',
        icon: 'material',
        depth: depth + 1,
        hasChildren: false,
        target: { kind: 'material', index: materialIndex },
      });
    }
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
    items.push({
      entry: node,
      label: 'Node',
      icon: iconFor(node, index),
      depth,
      hasChildren: children.length > 0 || node.mesh !== undefined,
      target: { kind: 'node', index },
    });

    if (node.mesh !== undefined) pushMesh(node.mesh, depth + 1);
    for (const child of children) walk(child, depth + 1);
  };

  const roots = json.scenes?.[sceneIndex]?.nodes ?? [];
  for (const root of roots) walk(root, 0);

  // Everything the displayed scene does not reach still has to be renameable.
  const leftovers: TreeItem[] = [];
  nodes.forEach((node, index) => {
    if (visitedNodes.has(index)) return;
    leftovers.push({
      entry: node,
      label: 'Node',
      icon: iconFor(node, index),
      depth: 0,
      hasChildren: false,
      target: { kind: 'node', index },
    });
  });
  meshes.forEach((mesh, index) => {
    if (usedMeshes.has(index)) return;
    leftovers.push({
      entry: mesh,
      label: 'Mesh',
      icon: materialsOf(index).length > 0 ? 'meshData' : 'meshDataPlain',
      depth: 0,
      hasChildren: false,
      target: { kind: 'mesh', index },
    });
  });
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
