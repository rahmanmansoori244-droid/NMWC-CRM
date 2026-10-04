/**
 * F2 — chart colours for the insights dashboard, as hex for inline `style` /
 * SVG `fill` values.
 *
 * Deliberately not Tailwind classes: a colour picked at render time from a class
 * name built in code (`bg-${x}`) is purged, and the brand palette has no 300 or
 * 400 shade (tailwind.config.ts). Text never wears these colours; labels stay in
 * the slate text classes and a swatch beside them carries identity.
 *
 * SERIES is a fixed categorical order, validated for colour-vision deficiency on
 * adjacent pairs (stacked bars) in light mode; slots 3 and 4 sit under 3:1
 * against white, so every chart that uses them shows its numbers in a legend and
 * in a "Show the numbers" list. The app has no dark mode.
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;

/** One hue, light to dark, for magnitude (the map's heat classes). */
export const SEQUENTIAL = ['#9ec5f4', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'] as const;

/** Bar track and the map's land and outline. */
export const TRACK = '#e2e8f0';
export const LAND = '#f1f5f9';
export const COAST = '#94a3b8';
