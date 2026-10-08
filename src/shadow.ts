/**
 * Shadows: what the renderer draws them with, and the two flags a node carries
 * for them.
 *
 * glTF has no form for shadows at all — no flag on a node, no setting on a
 * light — so a node's two flags are kept in its extras, the way a material's
 * editor-only type is kept in `extras.threeMaterial`: `extras.castShadow` and
 * `extras.receiveShadow`, each written only while it is on, since an absent
 * flag is off in three.js too. GLTFLoader hands a node's extras over as
 * `object.userData`, so code loading the file has them as
 * `userData.castShadow` / `userData.receiveShadow` to copy onto the object;
 * the preview does just that, and any other viewer ignores them.
 *
 * How shadows are drawn — on or off, and which filter — is the scene's, like
 * its environment: kept with the session, never written into a file. So is
 * whatever the scene's own lights and shapes are set to, since those are never
 * downloaded either.
 *
 * Free of three.js, like scene.ts: the panel reads and writes these before the
 * preview has loaded.
 */

/** Whether something throws a shadow, and whether shadows fall on it. */
export interface ShadowFlags {
  cast: boolean;
  receive: boolean;
}

/** The keys in a node's extras — and so in its `userData` once loaded. */
export const CAST_KEY = 'castShadow';
export const RECEIVE_KEY = 'receiveShadow';

/** The flags an extras object carries — or the `userData` the loader made of one. */
export function readShadowFlags(extras: Record<string, unknown> | undefined): ShadowFlags {
  return { cast: isOn(extras?.[CAST_KEY]), receive: isOn(extras?.[RECEIVE_KEY]) };
}

/**
 * Writes the flags into a node's extras, leaving out what is off: an absent flag
 * is off, so a node set back to casting nothing carries nothing. Whatever else
 * the extras hold is kept.
 */
export function writeShadowFlags(node: { extras?: Record<string, unknown> }, flags: ShadowFlags): void {
  const extras: Record<string, unknown> = { ...node.extras };
  if (flags.cast) extras[CAST_KEY] = true;
  else delete extras[CAST_KEY];
  if (flags.receive) extras[RECEIVE_KEY] = true;
  else delete extras[RECEIVE_KEY];
  if (Object.keys(extras).length === 0) delete node.extras;
  else node.extras = extras;
}

export function sameShadowFlags(a: ShadowFlags, b: ShadowFlags): boolean {
  return a.cast === b.cast && a.receive === b.receive;
}

/** Whether a stored value reads as a pair of flags, for a session coming back. */
export function isShadowFlags(value: unknown): value is ShadowFlags {
  const flags = value as Partial<ShadowFlags> | null;
  return typeof flags === 'object' && flags !== null && typeof flags.cast === 'boolean' && typeof flags.receive === 'boolean';
}

/**
 * `true` — or the `1` a custom property exported from another tool may have
 * turned it into. Anything else, `"true"` included, is off: guessing at strings
 * would have `"false"` cast.
 */
function isOn(value: unknown): boolean {
  return value === true || value === 1;
}

// ---------------------------------------------------------------------------
// The renderer's side

/** The filters three.js draws a shadow map with, as the editor's Project settings list them. */
export type ShadowType = 'basic' | 'pcf' | 'pcfsoft' | 'vsm';

export interface ShadowSettings {
  /** Whether any shadow is drawn at all, whatever the lights and objects say. */
  enabled: boolean;
  type: ShadowType;
}

/**
 * On, with the filter three.js and the editor default to. On costs nothing
 * until a light casts onto something that receives, so a scene nobody has told
 * to cast looks exactly as it did.
 */
export const DEFAULT_SHADOWS: ShadowSettings = { enabled: true, type: 'pcf' };

export const SHADOW_TYPES: { value: ShadowType; label: string; hint: string }[] = [
  { value: 'basic', label: 'Basic', hint: 'Unfiltered: hard, pixelated edges, and the cheapest' },
  { value: 'pcf', label: 'PCF', hint: 'Percentage-closer filtering: softened edges, blurred further by a light’s Radius' },
  { value: 'pcfsoft', label: 'PCF Soft', hint: 'Softer edges still; a light’s Radius has no effect on it' },
  { value: 'vsm', label: 'VSM', hint: 'Variance shadow maps: smooth, blurred by Radius, and not drawn for point lights' },
];

/** The sides a light's shadow map can be drawn at, in texels. */
export const SHADOW_MAP_SIZES = [256, 512, 1024, 2048, 4096];

export function restoreShadows(value: unknown): ShadowSettings {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<ShadowSettings>;
  const type = SHADOW_TYPES.find((candidate) => candidate.value === stored.type)?.value;
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_SHADOWS.enabled,
    type: type ?? DEFAULT_SHADOWS.type,
  };
}
