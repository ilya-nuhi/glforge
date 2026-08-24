/**
 * Inline SVG glyphs, coloured per type so the hierarchy is scannable at a
 * glance the way Blender's outliner is. Colours live in style.css, keyed off
 * the `data-icon` attribute.
 */

export type IconName =
  | 'nodeEmpty'
  | 'nodeMesh'
  | 'nodeCamera'
  | 'nodeLight'
  | 'nodeBone'
  | 'meshData'
  | 'meshDataPlain'
  | 'material'
  | 'scene'
  | 'texture'
  | 'image'
  | 'animation'
  | 'skin'
  | 'variant'
  | 'eye'
  | 'eyeOff'
  | 'locate'
  | 'revert'
  | 'chevron';

const PATHS: Record<IconName, string> = {
  // An empty/transform-only node: plain axes, as in Blender.
  nodeEmpty: '<path d="M12 4v16M4 12h16"/>',
  // A node that draws something: an isometric cube.
  nodeMesh:
    '<path d="M12 2.6l8.4 4.7v9.4L12 21.4 3.6 16.7V7.3z"/><path d="M12 12l8.4-4.7M12 12l-8.4-4.7M12 12v9.4"/>',
  nodeCamera:
    '<path d="M4 8.5h3l1.5-2h7l1.5 2h3v9.5H4z"/><circle cx="12" cy="13.2" r="2.6"/>',
  nodeLight:
    '<path d="M12 3.2a5.4 5.4 0 0 0-3 9.9V16h6v-2.9a5.4 5.4 0 0 0-3-9.9z"/><path d="M10 18.6h4M10.6 21h2.8"/>',
  nodeBone:
    '<path d="M9.4 14.6l5.2-5.2"/><circle cx="7.2" cy="16.8" r="2.6"/><circle cx="16.8" cy="7.2" r="2.6"/>',
  // Mesh data carrying at least one material: vertices marked.
  meshData:
    '<path d="M12 4.4L20 18.6H4z"/><circle cx="12" cy="4.4" r="1.5" fill="currentColor"/><circle cx="4" cy="18.6" r="1.5" fill="currentColor"/><circle cx="20" cy="18.6" r="1.5" fill="currentColor"/>',
  // Mesh data with no material assigned at all.
  meshDataPlain: '<path d="M12 4.4L20 18.6H4z" stroke-dasharray="3 2.5"/>',
  material: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  scene: '<path d="M3.5 5.5h17v13h-17z"/><path d="M6.5 15l3-3.2 2.6 2.8 2.7-3.6 2.7 4"/>',
  texture:
    '<path d="M4 4h16v16H4z"/><path d="M4 4h8v8H4zM12 12h8v8h-8z" fill="currentColor" stroke="none"/>',
  image:
    '<path d="M3.5 5.5h17v13h-17z"/><circle cx="8.6" cy="10" r="1.7"/><path d="M5 17l4.2-4 3 2.6 3-3.4 3.8 4.8"/>',
  animation:
    '<path d="M3 12h3M10 12h4M18 12h3"/><path d="M8 9.5l2.2 2.5L8 14.5 5.8 12z" fill="currentColor" stroke="none"/><path d="M16 9.5l2.2 2.5L16 14.5 13.8 12z" fill="currentColor" stroke="none"/>',
  skin:
    '<path d="M8 6v12M16 6v12"/><circle cx="8" cy="4.6" r="1.8"/><circle cx="16" cy="4.6" r="1.8"/><circle cx="8" cy="19.4" r="1.8"/><circle cx="16" cy="19.4" r="1.8"/>',
  variant: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M17.9 17.9A10.1 10.1 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-6M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2m-6.7-1.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/>',
  locate: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  revert: '<path d="M3 8V3M3 8h5"/><path d="M3.5 14a8.5 8.5 0 1 0 2-8.5L3 8"/>',
  chevron: '<path d="M9.5 6.5l6 5.5-6 5.5"/>',
};

export function iconSvg(name: IconName): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
}

/** A decorative type glyph, coloured by kind. */
export function typeIcon(name: IconName): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'type-icon';
  span.dataset.icon = name;
  span.innerHTML = iconSvg(name);
  return span;
}
