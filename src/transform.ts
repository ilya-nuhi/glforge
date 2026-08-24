/**
 * Node transforms: reading, writing and converting them.
 *
 * A glTF node states its transform either as a TRS triple or as a single
 * matrix, and rotation is always a quaternion — while a person editing one
 * wants three numbers in degrees. This module is the only place that knows how
 * to get between those, and it is deliberately free of three.js so the editor
 * UI can use it before the 3D preview has loaded (or at all).
 */
import type { GltfNode } from './gltf';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface Trs {
  translation: Vec3;
  /** Quaternion, x/y/z/w, as glTF stores it. */
  rotation: Quat;
  scale: Vec3;
}

/** The four keys a node's transform can live in, kept for an exact revert. */
export interface NodeTransformKeys {
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
}

export const DEFAULT_TRS: Trs = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

export function readNodeTransform(node: GltfNode): Trs {
  // A node has either a matrix or a TRS, never both — but a malformed file can
  // carry both, and the spec says the matrix wins.
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return decomposeMatrix(node.matrix);
  }
  return {
    translation: vec3(node.translation, DEFAULT_TRS.translation),
    rotation: quat(node.rotation),
    scale: vec3(node.scale, DEFAULT_TRS.scale),
  };
}

/**
 * Writes a transform back as TRS, dropping any matrix the node had: keeping
 * both would be ambiguous, and TRS is what the fields are editing.
 * Components left at their defaults are omitted, the way exporters write them.
 */
export function writeNodeTransform(node: GltfNode, trs: Trs): void {
  delete node.matrix;
  assign(node, 'translation', trs.translation, DEFAULT_TRS.translation);
  assign(node, 'rotation', trs.rotation, DEFAULT_TRS.rotation);
  assign(node, 'scale', trs.scale, DEFAULT_TRS.scale);
}

function assign(
  node: GltfNode,
  key: 'translation' | 'rotation' | 'scale',
  value: number[],
  fallback: number[],
): void {
  if (value.every((component, index) => component === fallback[index])) delete node[key];
  else node[key] = [...value];
}

/** A copy of exactly the keys a node's transform occupies, for reverting. */
export function captureNodeTransform(node: GltfNode): NodeTransformKeys {
  const saved: NodeTransformKeys = {};
  if (node.translation) saved.translation = [...node.translation];
  if (node.rotation) saved.rotation = [...node.rotation];
  if (node.scale) saved.scale = [...node.scale];
  if (node.matrix) saved.matrix = [...node.matrix];
  return saved;
}

export function restoreNodeTransform(node: GltfNode, saved: NodeTransformKeys): void {
  for (const key of ['translation', 'rotation', 'scale', 'matrix'] as const) {
    if (saved[key]) node[key] = [...saved[key]];
    else delete node[key];
  }
}

/** Whether a node still sits where the file put it. */
export function sameTransform(a: NodeTransformKeys, b: NodeTransformKeys): boolean {
  for (const key of ['translation', 'rotation', 'scale', 'matrix'] as const) {
    const left = a[key];
    const right = b[key];
    if (left === undefined && right === undefined) continue;
    if (left === undefined || right === undefined) return false;
    if (left.length !== right.length) return false;
    if (left.some((value, index) => value !== right[index])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Matrix / quaternion / Euler conversions
//
// These mirror three.js exactly — Matrix4.decompose, Quaternion.setFromEuler
// and Euler.setFromRotationMatrix in 'XYZ' order — so a value shown here is the
// same one the gizmo would produce.

/** glTF matrices are column-major, like three's. */
export function decomposeMatrix(m: number[]): Trs {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);

  // A negative determinant means the matrix mirrors; three folds that into the
  // x scale so the rotation stays a rotation.
  if (determinant(m) < 0) sx = -sx;

  const rotation: number[] = [...m];
  for (const [column, scale] of [
    [0, sx],
    [4, sy],
    [8, sz],
  ] as const) {
    const inverse = scale === 0 ? 0 : 1 / scale;
    rotation[column] *= inverse;
    rotation[column + 1] *= inverse;
    rotation[column + 2] *= inverse;
  }

  return {
    translation: [m[12], m[13], m[14]],
    rotation: quaternionFromMatrix(rotation),
    scale: [sx, sy, sz],
  };
}

function determinant(m: number[]): number {
  // Only the sign matters here, so this is the 3×3 upper-left determinant.
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5])
  );
}

function quaternionFromMatrix(m: number[]): Quat {
  const [m11, m21, m31] = [m[0], m[1], m[2]];
  const [m12, m22, m32] = [m[4], m[5], m[6]];
  const [m13, m23, m33] = [m[8], m[9], m[10]];
  const trace = m11 + m22 + m33;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** Quaternion to intrinsic XYZ Euler angles, in radians. */
export function quaternionToEuler(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const [x2, y2, z2] = [x + x, y + y, z + z];
  const [xx, xy, xz] = [x * x2, x * y2, x * z2];
  const [yy, yz, zz] = [y * y2, y * z2, z * z2];
  const [wx, wy, wz] = [w * x2, w * y2, w * z2];

  const m11 = 1 - (yy + zz);
  const m12 = xy - wz;
  const m13 = xz + wy;
  const m22 = 1 - (xx + zz);
  const m23 = yz - wx;
  const m32 = yz + wx;
  const m33 = 1 - (xx + yy);

  const euler: Vec3 = [0, Math.asin(Math.min(Math.max(m13, -1), 1)), 0];
  // Straight up or down is a gimbal lock: pin z and put all the spin into x.
  if (Math.abs(m13) < 0.9999999) {
    euler[0] = Math.atan2(-m23, m33);
    euler[2] = Math.atan2(-m12, m11);
  } else {
    euler[0] = Math.atan2(m32, m22);
  }
  return euler;
}

/** Intrinsic XYZ Euler angles in radians to a quaternion. */
export function eulerToQuaternion(euler: Vec3): Quat {
  const [c1, c2, c3] = euler.map((angle) => Math.cos(angle / 2));
  const [s1, s2, s3] = euler.map((angle) => Math.sin(angle / 2));
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

export const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

function vec3(value: number[] | undefined, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [number(value[0]), number(value[1]), number(value[2])];
}

function quat(value: number[] | undefined): Quat {
  if (!Array.isArray(value) || value.length < 4) return [...DEFAULT_TRS.rotation];
  return [number(value[0]), number(value[1]), number(value[2]), number(value[3])];
}

/** A hand-edited file can carry a string or a null where a number belongs. */
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
