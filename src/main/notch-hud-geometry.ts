// Pure, Electron-free geometry for the macOS Notch HUD (docs/notch-hud.md).
//
// Split out of notch-hud.ts so vitest can cover notch DETECTION without an Electron runtime: the
// controller reads `screen.getPrimaryDisplay()` and hands the plain numbers here. Everything the
// HUD window and its renderer position themselves by is decided in this module: `hudGeometry`
// places the WINDOW (and detects the notch), `hudPlacement` places the CAPSULE and its expanded
// panel inside that window from the user's side / vertical-offset settings.

import type { NotchAlign } from '../shared/notch-hud'
import { HUD_BOTTOM_RIGHT_INSET } from '../shared/notch-hud'

/** A rectangle in Electron's logical (point) coordinate space. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface HudGeometryInput {
  /** display.bounds — the full display, menu bar included. */
  bounds: Rect
  /** display.workArea — excludes the menu bar / notch strip. */
  workArea: Rect
  /** display.internal — a notch only ever exists on a built-in panel. */
  internal: boolean
  /** Already-sanitized settings.notchWidth. */
  notchWidth: number
  /** Already-sanitized settings.notchOffsetY (px, positive = down). Only the window HEIGHT depends
   *  on it here — a capsule pushed down needs the window to grow with it (see `hudPlacement`). */
  offsetY: number
  /**
   * T227 — Already-sanitized settings.notchAlign. ABSENT means the top-strip layout, bit-for-bit
   * what this function always returned: the three upstream sides all live on that strip, so only
   * `bottom-right` changes anything here. Optional on purpose — a caller (or a test) that does not
   * care about the dock cannot accidentally move a window by omitting it.
   */
  align?: NotchAlign
}

export interface HudGeometry {
  x: number
  y: number
  width: number
  height: number
  /** Height of the fused top strip (menu bar / notch), floored so the mascots always fit. */
  bar: number
  notchWidth: number
  notchCenterX: number
  hasNotch: boolean
  /**
   * T227 — this window is the small box docked in the work area's bottom-right corner, not the
   * full-width top strip. The renderer keys its bottom-anchored layout on it.
   */
  docked: boolean
}

/** Minimum strip height when there is no physical notch (menu-bar height floor). */
export const NOTCH_BAR_FLOOR = 24

/**
 * Notch detection threshold, as a FRACTION of the display's logical height — deliberately not an
 * absolute px count.
 *
 * macOS reserves a menu bar exactly as tall as the notch on a notched panel, so that strip is a
 * fixed share of the panel and survives every scaling mode: a 15" Air reports 37/1112 at its
 * default and 31/932 at 1440x932 — both 0.0333. A notchless panel's menu bar is a fixed 24 pt, so
 * its share instead FALLS as the resolution rises: 24/1080 = 0.0222, 24/900 = 0.0267.
 *
 * The predecessor of this constant was an absolute 32 px, which the 0.0333 share only clears while
 * the display is tall enough — i.e. at the default scaling and nowhere else (issue #508).
 *
 * Residual, and why it is survivable: a notchless BUILT-IN panel driven at an unusually low scaled
 * resolution (24/640 = 0.0375) still reads as notched. That misdetection now costs a capsule fused
 * to a notch that is not there, never a pill hidden behind one — the notchless layout no longer
 * occupies the top strip at all (see `.notchless .hud-capsule` in hud.css).
 */
export const NOTCH_BAR_RATIO = 0.03

/** Total window height ABOVE the top strip — sized to the EXPANDED box (we never resize the frame;
 *  the renderer scales a CSS transform). The strip itself is added on top, because both layouts
 *  start below it: the fused capsule reserves it as padding, the floating pill clears it. */
export const HUD_WINDOW_HEIGHT = 460

/**
 * Decide where the HUD window sits and which of the two layouts its renderer should draw.
 *
 * The window always spans the display's full width at its very top edge (`bounds`, not `workArea`
 * — painting OVER the menu bar is the point, see `enableLargerThanScreen` in notch-hud.ts).
 */
export function hudGeometry(input: HudGeometryInput): HudGeometry {
  const b = input.bounds
  const inset = input.workArea.y - b.y
  const bar = Math.max(NOTCH_BAR_FLOOR, inset)
  // A physical notch requires a built-in panel whose reserved strip is a notch-sized SHARE of it.
  const hasNotch = input.internal && inset > 0 && b.height > 0 && inset / b.height >= NOTCH_BAR_RATIO
  // ── T227: THE DOCKED LAYOUT ──────────────────────────────────────────────────────────────────
  //
  // `bottom-right` is not a fourth corner of the top strip — it is a standalone pill in the work
  // area's bottom-right corner, so the WINDOW is a small box there rather than a full-width bar:
  // the work area's right/bottom edge, minus the box's own size. `workArea` and NOT `bounds` is
  // load-bearing: `bounds` includes the Dock and the menu bar, so a window placed against it would
  // sit UNDER the Dock (the owner's own requirement — "用 workArea 避开 Dock").
  //
  // Sized to the top-strip layout's EXPANDED box (`HUD_WINDOW_HEIGHT`) plus one edge margin, so the
  // panel gets exactly the room it gets up there. The notch inputs are still reported (`bar`,
  // `hasNotch`, …) because the renderer draws the same mascots, but nothing on this path is fused.
  if (input.align === 'bottom-right') {
    const width = Math.min(HUD_DOCK_WINDOW_WIDTH, input.workArea.width)
    const height = Math.min(HUD_DOCK_WINDOW_HEIGHT, input.workArea.height)
    return {
      x: input.workArea.x + input.workArea.width - width,
      y: input.workArea.y + input.workArea.height - height,
      width,
      height,
      bar,
      notchWidth: input.notchWidth,
      notchCenterX: Math.round(b.width / 2),
      hasNotch,
      docked: true
    }
  }
  // A capsule lowered by `offsetY` drags its expanded panel down with it, so the window grows by the
  // same amount — otherwise the panel's bottom rows would be clipped by the window edge. A RAISED
  // capsule (negative) needs nothing extra, and offset 0 keeps the historical height bit-for-bit.
  const extra = Math.max(0, input.offsetY)
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: Math.min(bar + HUD_WINDOW_HEIGHT + extra, b.height),
    bar,
    notchWidth: input.notchWidth,
    notchCenterX: Math.round(b.width / 2),
    hasNotch,
    docked: false
  }
}

// ---- Capsule + panel placement inside the window ------------------------------------------

/** Width of the EXPANDED session panel (px). Lives here, not only in hud.css, because the panel's
 *  left edge is decided by `hudPlacement` (it has to stay on screen at every alignment) and the
 *  renderer paints exactly the width main reasoned with (`--panel-width` is pushed). */
export const HUD_PANEL_WIDTH = 400
/** Gap between the menu-bar / notch strip and a floating pill's top edge (px). The pill's resting
 *  place is BELOW the strip — load-bearing, see the `.pill .hud-capsule` note in hud.css. */
export const PILL_TOP_GAP = 6
/** Margin between a left/right-aligned capsule (and its panel) and the display's edge (px). */
export const HUD_EDGE_MARGIN = 12

/**
 * T227 — the `bottom-right` dock's window: a small box in the work area's corner, sized so the
 * expanded panel has exactly the room the top-strip layout gives it (`HUD_WINDOW_HEIGHT`, which the
 * CSS `--panel-max-h` is tuned against). Width = one panel plus a margin on each side, which is why
 * the panel lands `HUD_EDGE_MARGIN` from BOTH side edges of the window.
 *
 * Both are clamped to the work area by `hudGeometry`, so a small work area yields a small window and
 * the panel is bounded by `expandedMaxHeight` (see `hudPlacement`) rather than by these numbers.
 */
export const HUD_DOCK_WINDOW_WIDTH = HUD_PANEL_WIDTH + 2 * HUD_EDGE_MARGIN
export const HUD_DOCK_WINDOW_HEIGHT = HUD_WINDOW_HEIGHT
/** Clearance between the docked window's top edge and the expanded panel's top edge (px). The panel
 *  grows UP from the capsule's bottom edge, so this is what keeps it inside the window — and the
 *  window is inside the work area, so it keeps it inside the work area too. */
export const HUD_DOCK_TOP_GAP = 12

export interface HudPlacementInput {
  /** Window / display width (px). */
  width: number
  /** Fused top-strip height (`HudGeometry.bar`). */
  bar: number
  notchWidth: number
  notchCenterX: number
  /** Notch present AND the window actually paints over it (main folds its own clamp check in). */
  hasNotch: boolean
  /** Already-sanitized settings.notchAlign / settings.notchOffsetY. */
  align: NotchAlign
  offsetY: number
  /** T227 — the window's height, needed only by the docked layout to bound the expanded panel.
   *  Absent ⇒ `HUD_DOCK_WINDOW_HEIGHT` (the standard docked window), which is what a caller that
   *  never asks for `bottom-right` gets anyway. */
  height?: number
}

export interface HudPlacement {
  /**
   * The SHAPE. `true` = the capsule is fused to the physical notch (square top corners at y=0,
   * grows left of the notch, expands under it). `false` = a standalone floating pill (all corners
   * rounded) — the only shape that makes sense once the capsule is not touching the notch.
   *
   * What each combination draws:
   *   notch + center + offset ≤ 0  → fused to the notch (the historical layout; a negative offset
   *                                   cannot go above the top edge, so it stays fused)
   *   notch + center + offset > 0  → a pill hanging centered BELOW the notch
   *   notch + left / right         → a pill at that edge, below the menu-bar strip (± offset)
   *   no notch, any side           → a pill on that side, below the strip (± offset)
   *   bottom-right (T227)          → a pill in the work area's corner, ALWAYS (never fused, and the
   *                                   vertical offset is not applied — the corner is the position)
   */
  fused: boolean
  /** Which edge of the COLLAPSED capsule sits at `capsuleX` (the capsule is shrink-to-fit wide,
   *  so it is positioned by an anchor + a CSS translate, not by a left/width pair). Fused = `right`
   *  (its right edge butts against the notch's right edge); a pill = the chosen side. The dock
   *  reports `right` too — it is a right-anchored pill that additionally hangs by its bottom edge
   *  (`docked`), which is why this stays the three horizontal anchors rather than `NotchAlign`. */
  anchor: 'left' | 'center' | 'right'
  /** X of that anchor edge (px, window coords). */
  capsuleX: number
  /** Top of the capsule (px, window coords) — 0 when fused; never negative (nothing is above the
   *  display's top edge, so an offset that would raise the capsule past it is clamped there).
   *  Meaningless when `docked` (the capsule hangs by its BOTTOM edge instead). */
  capsuleTop: number
  /** Left edge of the EXPANDED panel (px, window coords), clamped so the panel is on screen. */
  panelLeft: number
  panelWidth: number
  /** T227 — docked to the work area's bottom-right corner: the renderer anchors the capsule by its
   *  bottom edge (`--capsule-bottom`) and grows the panel UPWARD. */
  docked?: boolean
  /** Distance from the capsule's bottom edge to the window's bottom edge (px, window coords) —
   *  `HUD_BOTTOM_RIGHT_INSET` since T243: the corner's lower reaches belong to the canvas minimap,
   *  so the capsule sits on a ledge above it instead of `HUD_EDGE_MARGIN` from the edge. Only
   *  present when `docked`. */
  capsuleBottom?: number
  /** The tallest the EXPANDED capsule may grow in this window (px), i.e. the room left above the
   *  capsule's bottom edge after the minimap inset and the top gap. Only present when `docked`: the
   *  window is inside the work area, so bounding the growth here keeps the panel inside it — which
   *  is what a short work area needs (the panel is SHORTENED, never allowed to overflow). */
  expandedMaxHeight?: number
}

/**
 * Where the capsule and its expanded panel sit, from the user's placement settings. Pure: the
 * renderer draws EXACTLY these numbers (pushed as CSS variables), and the click-through hotspot is
 * the capsule element itself, so the interactive region follows whatever this returns.
 */
export function hudPlacement(input: HudPlacementInput): HudPlacement {
  const { width, bar, notchWidth, notchCenterX, align, offsetY } = input
  const panelWidth = HUD_PANEL_WIDTH
  // ── T227: THE DOCKED PILL ────────────────────────────────────────────────────────────────────
  //
  // Answered BEFORE anything about the notch strip, because none of it applies: the dock is a
  // standalone pill in the work area's corner, `fused` is false by construction (a square-cornered
  // capsule fused to a notch that is nowhere near it is the "black box below the menu bar" bug, one
  // screenful further away), and the vertical offset does not move it — the corner IS the position.
  // Horizontally it is `HUD_EDGE_MARGIN` from the right edge; VERTICALLY it hangs
  // `HUD_BOTTOM_RIGHT_INSET` above the bottom edge (T243) — the corner's lower reaches belong to
  // the canvas minimap, so the distance off the bottom edge is decided by the minimap's footprint,
  // not by the edge margin.
  //
  // The panel grows UP (the renderer anchors the capsule's bottom edge) and LEFT (its right edge is
  // the capsule's right edge, so `panelLeft` = that minus the panel's width). Both stay inside the
  // window — and the window is inside the work area — so there is nothing to clamp horizontally
  // beyond keeping `panelLeft` non-negative on a work area narrower than a panel.
  if (align === 'bottom-right') {
    const capsuleX = width - HUD_EDGE_MARGIN
    const maxLeft = Math.max(0, width - panelWidth)
    return {
      fused: false,
      anchor: 'right',
      capsuleX,
      capsuleTop: 0, // unused while docked; the capsule hangs by its bottom edge
      panelLeft: Math.round(Math.max(0, Math.min(maxLeft, capsuleX - panelWidth))),
      panelWidth,
      docked: true,
      // T243: the corner's lower reaches belong to the canvas minimap, so the capsule no longer
      // hugs the work area's bottom edge (that was HUD_EDGE_MARGIN = 12). It hangs
      // HUD_BOTTOM_RIGHT_INSET above it instead — the minimap's own footprint (margin, box,
      // 1px borders) plus the clearance — and the panel's budget below shrinks by the same
      // amount so the expanded box still fits the window.
      capsuleBottom: HUD_BOTTOM_RIGHT_INSET,
      expandedMaxHeight: Math.max(
        0,
        (input.height ?? HUD_DOCK_WINDOW_HEIGHT) - HUD_BOTTOM_RIGHT_INSET - HUD_DOCK_TOP_GAP
      )
    }
  }
  // Fused only when the capsule actually touches the notch. A positive offset detaches it, and a
  // detached capsule with square top corners is the "black box below the menu bar" field bug, so
  // it becomes a pill; a negative offset has nowhere to go (top edge) and stays fused at 0.
  const fused = input.hasNotch && align === 'center' && offsetY <= 0
  // Pill top: below the strip by default, pushed by the offset, and never above the display edge.
  const capsuleTop = fused ? 0 : Math.max(0, bar + PILL_TOP_GAP + offsetY)
  let anchor: NotchAlign
  let capsuleX: number
  if (fused) {
    anchor = 'right'
    capsuleX = notchCenterX + Math.round(notchWidth / 2)
  } else if (align === 'left') {
    anchor = 'left'
    capsuleX = HUD_EDGE_MARGIN
  } else if (align === 'right') {
    anchor = 'right'
    capsuleX = width - HUD_EDGE_MARGIN
  } else {
    anchor = 'center'
    capsuleX = notchCenterX
  }
  // The expanded panel keeps the capsule's side but is clamped INTO the display: anchored hard
  // left/right it must not run off the edge (the #791 class of bug — a surface that opens where it
  // cannot be seen). Center keeps the historical `center - width/2`. On a display too narrow for
  // the panel plus its margin, the margin is dropped on the CHOSEN side (a left panel hugs the
  // left edge, a right panel the right edge) — a bare clamp would have dropped it on the far side.
  const maxLeft = Math.max(0, width - panelWidth)
  const desired =
    align === 'left' && !fused
      ? HUD_EDGE_MARGIN + panelWidth <= width
        ? HUD_EDGE_MARGIN
        : 0
      : align === 'right' && !fused
        ? width - HUD_EDGE_MARGIN - panelWidth >= 0
          ? width - HUD_EDGE_MARGIN - panelWidth
          : maxLeft
        : notchCenterX - panelWidth / 2
  const panelLeft = Math.round(Math.max(0, Math.min(maxLeft, desired)))
  return { fused, anchor, capsuleX, capsuleTop, panelLeft, panelWidth }
}
