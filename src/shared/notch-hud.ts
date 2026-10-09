// macOS Notch HUD — the user-tunable PLACEMENT values and their sanitizers (docs/notch-hud.md).
//
// Shared because two sides consume the same numbers: main clamps them at the point of use
// (`notch-hud.ts` → `hudGeometry` / `hudPlacement`), and Settings → Notch draws its controls from
// the same bounds, so the slider range and the clamp can never drift apart (they used to be two
// hand-copied constants with a "keep in sync" comment).
//
// Every value here comes from settings.json, which is hand-editable — a hostile input. Nothing
// trusts the TypeScript type: `sanitize*` re-validates at runtime and an unrecognised value falls
// back to the default, never to a guess.

/**
 * Which side of the primary display the capsule sits on.
 *
 * `left` / `center` / `right` are upstream's: a full-width strip at the very top of the display, the
 * capsule fused to the notch (`center`) or a floating pill at that edge. `bottom-right` (T227) is a
 * different SHAPE, not a fourth corner of the same strip — a standalone floating pill in the WORK
 * AREA's bottom-right corner, no notch, never fused (see `hudGeometry` / `hudPlacement`).
 */
export type NotchAlign = 'left' | 'center' | 'right' | 'bottom-right'
/** Every side, in the order the Settings control draws them. */
export const NOTCH_ALIGNS: readonly NotchAlign[] = ['left', 'center', 'right', 'bottom-right']
/**
 * UPSTREAM'S DEFAULT IS `'center'` — the capsule fused to the physical notch, which is what a
 * notched MacBook expects and what the docs describe.
 *
 * THIS FORK SHIPS `'bottom-right'`. That is a deliberate local product decision (employer,
 * 2026-10-08): the pill sitting at the top of the screen was in the way, and the bottom-right corner
 * is out of the way and next to where the pointer already lives. It is a DEFAULT only — every side
 * above is still reachable in Settings, and an install whose settings.json already names a side
 * keeps it (the settings merge only fills absent keys).
 */
export const NOTCH_ALIGN_DEFAULT: NotchAlign = 'bottom-right'

/**
 * Assumed physical notch WIDTH (px). Electron exposes no `auxiliaryTopLeftArea`, so we assume a
 * centered notch of this width, and the capsule butts against its LEFT edge. Field-tuned to 168 px
 * (200 left a visible gap — the capsule sat too far left). TUNE ON A MAC: raise it to push the
 * capsule LEFT, lower it to slide the capsule RIGHT toward the notch.
 */
export const NOTCH_WIDTH_DEFAULT = 168
/** Bounds for the user-tunable notch width (settings.notchWidth). */
export const NOTCH_WIDTH_MIN = 100
export const NOTCH_WIDTH_MAX = 320

/**
 * Bounds for the vertical offset (settings.notchOffsetY, px, positive = DOWN). The offset is
 * relative to where the capsule rests by default, and the effective value is additionally clamped
 * at the display's top edge by `hudPlacement` — there is nothing above it. The minimum only needs
 * to reach that edge from the floating pill's resting place (menu bar ≈ 24–37 px + its gap), so
 * -48 covers every real menu bar; a bigger number would just be dead slider travel.
 */
export const NOTCH_OFFSET_MIN = -48
export const NOTCH_OFFSET_MAX = 240
export const NOTCH_OFFSET_DEFAULT = 0

// ---- The bottom-right dock's avoidance of the canvas minimap (T243) -------------------------
//
// The docked capsule and the canvas minimap share the work area's bottom-right corner, and the gap
// between the right rail's card and the minimap's top edge is exactly one capsule tall — so the
// capsule's only way out of the minimap's way is UP, onto a ledge computed from the minimap's own
// footprint. These constants are that footprint, held in ONE place both sides read: main's
// `hudPlacement` reasons with them, and the renderer feeds them to the MiniMap element, so the
// measured box can never silently drift away from the avoidance value.

/** The canvas minimap's width (px). These two were never OUR numbers — they are @xyflow/react's
 *  `MiniMap` defaults, which the canvas never overrode, so the HUD's avoidance silently depended
 *  on a library default. T243 makes them ours: `VisibleMiniMap` passes them as explicit style, so
 *  the rendered box is `CANVAS_MINIMAP_WIDTH × CANVAS_MINIMAP_HEIGHT` by declaration, not by
 *  coincidence with the library. */
export const CANVAS_MINIMAP_WIDTH = 200
export const CANVAS_MINIMAP_HEIGHT = 150
/** The minimap dock's edge margin (px) — the same value canvas CSS carries as `--float-gap`
 *  (`.minimap-dock { right/bottom: var(--float-gap) }` in `src/renderer/styles.css`). The CSS copy
 *  remains the renderer's implementation; this one is what the HUD reasons with, and the two
 *  comment blocks point at each other so a change to one gets asked about in the other. */
export const CANVAS_MINIMAP_MARGIN = 22
/** Air the docked capsule keeps between its bottom edge and the minimap's top edge (px). */
export const HUD_DOCK_CLEARANCE = 12
/**
 * How far above the work area's bottom edge the DOCKED capsule hangs (px). The minimap's dock is
 * `CANVAS_MINIMAP_MARGIN` off the corner and `CANVAS_MINIMAP_HEIGHT + 2` tall (its own 1px border
 * on each side — the field-measured box is 202×152), so sitting `HUD_DOCK_CLEARANCE` above it
 * means the capsule's bottom edge is this far up:
 *
 *   CANVAS_MINIMAP_MARGIN + (CANVAS_MINIMAP_HEIGHT + 2) + HUD_DOCK_CLEARANCE = 186
 *
 * The employer picked "move the capsule up" from the three options and accepted the cost: the
 * capsule's top edge now touches the right rail card's bottom edge by ~14px. The right rail is not
 * moved and the minimap is not moved; the three top-strip alignments are untouched by this.
 */
export const HUD_BOTTOM_RIGHT_INSET =
  CANVAS_MINIMAP_MARGIN + (CANVAS_MINIMAP_HEIGHT + 2) + HUD_DOCK_CLEARANCE

/** Clamp a hand-editable width to something that can't push the capsule off the display. */
export function sanitizeNotchWidth(px: unknown): number {
  return typeof px === 'number' && Number.isFinite(px)
    ? Math.max(NOTCH_WIDTH_MIN, Math.min(NOTCH_WIDTH_MAX, Math.round(px)))
    : NOTCH_WIDTH_DEFAULT
}

/** An unknown alignment string (typo, a future value on an older build) draws the DEFAULT layout —
 *  never a pill on a side nobody asked for. Since T227 that default is `bottom-right` (see
 *  `NOTCH_ALIGN_DEFAULT`), so a corrupt/absent value lands the pill out of the way rather than in
 *  the middle of the notch strip. */
export function sanitizeNotchAlign(v: unknown): NotchAlign {
  return typeof v === 'string' && (NOTCH_ALIGNS as readonly string[]).includes(v) ? (v as NotchAlign) : NOTCH_ALIGN_DEFAULT
}

/** Non-finite / non-numeric → the default resting place (0); out of range → the nearest bound
 *  (the same rule as the width: keep the direction the user asked for, drop the excess). */
export function sanitizeNotchOffsetY(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(NOTCH_OFFSET_MIN, Math.min(NOTCH_OFFSET_MAX, Math.round(v)))
    : NOTCH_OFFSET_DEFAULT
}
