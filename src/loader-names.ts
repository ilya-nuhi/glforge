/**
 * The names three.js gives a glTF's nodes as it loads them. GLTFLoader does not
 * keep a name as the file spells it: it drops the characters its animation
 * bindings reserve (`.` `:` `/` `[` `]`), turns whitespace into `_`, and numbers
 * a name it has already handed out — `_1`, `_2` — in the order it reaches
 * things. Those are the names the three.js editor's outliner shows and the ones
 * `getObjectByName` finds at runtime, so they are the names the outliner shows.
 *
 * This walks the document in GLTFLoader's own order (three r185, `parse`):
 *
 * 1. every scene in turn — its name, then its nodes depth first, each node's
 *    name before its camera's and light's, then its children, then the joints
 *    of its skin;
 * 2. nodes only animations reach;
 * 3. cameras no node holds;
 * 4. mesh names, which are taken once their geometry has loaded. That order is
 *    the browser's, so it is taken to be the order the meshes were asked for.
 *    Only an unnamed node ever shows its mesh's name, so only those can be off.
 *
 * Everything before step 4 is taken synchronously in three.js as well, so a
 * named node's name always comes out exactly as the editor shows it.
 */
import { PropertyBinding } from 'three';
import type { GltfJson, GltfNode } from './gltf';

/**
 * What three.js calls each node it loads. A node it never loads — in no scene,
 * reached by no animation — has no entry.
 */
export function loaderNodeNames(json: GltfJson): Map<GltfNode, string> {
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const cameras = json.cameras ?? [];
  const lights = json.extensions?.KHR_lights_punctual?.lights ?? [];

  // GLTFLoader's bookkeeping, copied as it is: a plain object tested with `in`,
  // so even a name like "constructor" comes out the way it does there.
  const used: Record<string, number> = {};
  const unique = (original: string): string => {
    const sanitized = PropertyBinding.sanitizeNodeName(original);
    if (sanitized in used) return `${sanitized}_${++used[sanitized]}`;
    used[sanitized] = 0;
    return sanitized;
  };
  const named = (entry: { name?: unknown } | undefined): string | undefined =>
    typeof entry?.name === 'string' && entry.name !== '' ? entry.name : undefined;
  const lightOf = (node: GltfNode): number | undefined => {
    const light = (node.extensions?.KHR_lights_punctual as { light?: unknown } | undefined)?.light;
    return typeof light === 'number' ? light : undefined;
  };

  // A mesh, camera or light held by more than one node is cloned for each of
  // them, and every clone's name gets `_instance_<n>` — counted over the whole
  // file, loaded or not.
  const meshRefs = new Map<number, number>();
  const cameraRefs = new Map<number, number>();
  const lightRefs = new Map<number, number>();
  const countRef = (refs: Map<number, number>, index: number | undefined): void => {
    if (index !== undefined) refs.set(index, (refs.get(index) ?? 0) + 1);
  };
  for (const node of nodes) {
    countRef(meshRefs, node.mesh);
    countRef(cameraRefs, node.camera);
    countRef(lightRefs, lightOf(node));
  }

  // A joint loads as a Bone, which holds what the node draws as a child rather
  // than becoming it.
  const joints = new Set<number>();
  for (const skin of json.skins ?? []) {
    for (const joint of skin.joints ?? []) joints.add(joint);
  }

  const nodeNames = new Map<number, string>();
  const cameraNames = new Map<number, string>();
  const lightNames = new Map<number, string>();
  /** Nodes in the order they load — the order clones are numbered in. */
  const loadOrder: number[] = [];
  const walked = new Set<number>();
  /** Meshes in the order they are asked for, which a Set keeps. */
  const meshOrder = new Set<number>();
  const skinsLoaded = new Set<number>();

  // `_loadNodeShallow`: the node's name is taken first, so a root keeps the name
  // it was given; then its camera's and its light's, the first time each loads.
  const loadShallow = (index: number): void => {
    const node = nodes[index];
    if (!node || nodeNames.has(index)) return;
    const name = named(node);
    nodeNames.set(index, name === undefined ? '' : unique(name));
    loadOrder.push(index);

    if (node.mesh !== undefined && meshes[node.mesh]) meshOrder.add(node.mesh);
    if (node.camera !== undefined && cameras[node.camera] && !cameraNames.has(node.camera)) {
      const cameraName = named(cameras[node.camera]);
      cameraNames.set(node.camera, cameraName === undefined ? '' : unique(cameraName));
    }
    const light = lightOf(node);
    if (light !== undefined && lights[light] && !lightNames.has(light)) {
      lightNames.set(light, unique(named(lights[light]) ?? `light_${light}`));
    }
  };

  // `loadNode`: the node, then its children, then its skin's joints.
  const loadNode = (index: number): void => {
    const node = nodes[index];
    if (!node || walked.has(index)) return;
    walked.add(index);
    loadShallow(index);
    for (const child of node.children ?? []) loadNode(child);
    if (node.skin !== undefined && !skinsLoaded.has(node.skin)) {
      skinsLoaded.add(node.skin);
      for (const joint of json.skins?.[node.skin]?.joints ?? []) loadShallow(joint);
    }
  };

  for (const scene of json.scenes ?? []) {
    const name = named(scene);
    if (name !== undefined) unique(name);
    for (const root of scene.nodes ?? []) loadNode(root);
  }
  for (const animation of json.animations ?? []) {
    for (const channel of animation.channels ?? []) {
      if (channel.target?.node !== undefined) loadNode(channel.target.node);
    }
  }
  cameras.forEach((camera, index) => {
    if (cameraNames.has(index)) return;
    const name = named(camera);
    cameraNames.set(index, name === undefined ? '' : unique(name));
  });

  // Each primitive becomes a mesh of its own, every one named after the mesh.
  // One primitive is the object itself; several are a Group, which is unnamed.
  const meshNames = new Map<number, string>();
  for (const index of meshOrder) {
    const base = named(meshes[index]) ?? `mesh_${index}`;
    const primitives = (meshes[index].primitives ?? []).map(() => unique(base));
    meshNames.set(index, primitives.length === 1 ? primitives[0] : '');
  }

  const meshUses = new Map<number, number>();
  const cameraUses = new Map<number, number>();
  const lightUses = new Map<number, number>();
  const instance = (
    refs: Map<number, number>,
    uses: Map<number, number>,
    index: number,
    name: string,
  ): string => {
    if ((refs.get(index) ?? 0) <= 1) return name;
    const use = uses.get(index) ?? 0;
    uses.set(index, use + 1);
    return `${name}_instance_${use}`;
  };

  const result = new Map<GltfNode, string>();
  for (const index of loadOrder) {
    const node = nodes[index];
    // What the node holds, by the name each loads with. Taken for every node,
    // named or not, since each one moves the clone numbering along.
    const objects: string[] = [];
    if (node.mesh !== undefined && meshNames.has(node.mesh)) {
      objects.push(instance(meshRefs, meshUses, node.mesh, meshNames.get(node.mesh)!));
    }
    if (node.camera !== undefined && cameraNames.has(node.camera)) {
      objects.push(instance(cameraRefs, cameraUses, node.camera, cameraNames.get(node.camera)!));
    }
    const light = lightOf(node);
    if (light !== undefined && lightNames.has(light)) {
      objects.push(instance(lightRefs, lightUses, light, lightNames.get(light)!));
    }

    // A named node is called by its own name. An unnamed one holding exactly
    // one thing *is* that thing, so it goes by its name; anything else — a
    // Bone, a Group of several, a bare Object3D — has none.
    let name = nodeNames.get(index)!;
    if (named(node) === undefined) name = objects.length === 1 && !joints.has(index) ? objects[0] : '';
    result.set(node, name);
  }
  return result;
}
