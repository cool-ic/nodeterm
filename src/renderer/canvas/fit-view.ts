/**
 * Fit-view geometry: place the canvas content in the largest chrome-free rectangle.
 *
 * The dock, minimap, controls, sidebars and banners all paint OVER the flow, so a plain `fitView`
 * tucks nodes underneath them. Reserving a fixed margin per edge is too blunt — it taxes content
 * that never reaches the offending panel (narrow content paying for a bottom-RIGHT minimap).
 *
 * Instead every visible overlay becomes an obstacle rect, and we pick the free rectangle that lets
 * the content — at its own aspect ratio — reach the highest zoom. xyflow's directional padding is
 * exactly "fit inside the viewport minus these insets", so the winning rect maps straight onto it.
 *
 * Kept DOM-light and free of React so the geometry can be unit-tested on its own.
 */

/** Chrome that floats over the canvas. New chrome can opt in via `data-canvas-chrome` instead of
 *  being added here. */
export const CANVAS_CHROME_SELECTOR = [
  '[data-canvas-chrome]',
  '.dock',
  '.minimap',
  '.react-flow__controls',
  // T235: the two top clusters (`.sessions-icon-cluster`, `.controls-cluster`) are gone — their
  // buttons live inside the rail cards, which are `data-canvas-chrome` elements. Naming the dead
  // selectors here would reserve a rect that no longer exists.
  '.sessions-sidebar',
  '.top-banners',
  '.presence-prompt',
  '.dictation',
  '.update-card'
].join(',')

/** Breathing room kept between the content and both the chrome and the window edge. */
export const FIT_VIEW_GAP = 12

export type FitRect = { left: number; top: number; right: number; bottom: number }

export const rectsOverlap = (a: FitRect, b: FitRect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

const width = (r: FitRect): number => r.right - r.left
const height = (r: FitRect): number => r.bottom - r.top

/** Area of a rect, and its Chebyshev-ish distance from a point — the two tie-breakers the
 *  scoring functions below share. */
const areaOf = (r: FitRect): number => width(r) * height(r)
const offCentreOf = (r: FitRect, cx: number, cy: number): number =>
  Math.abs((r.left + r.right) / 2 - cx) + Math.abs((r.top + r.bottom) / 2 - cy)

/** Does `candidate` beat the incumbent `best`? Callers encode "biggest zoom" / "biggest area"
 *  here; the enumeration below only supplies the candidates. */
type FreeRectScorer = (candidate: FitRect, best: FitRect) => boolean

/**
 * The best chrome-free rectangle inside `viewport`, per `isBetter`. Every maximal empty rectangle
 * has each edge either on the viewport border or flush against an obstacle edge, so enumerating
 * obstacle/viewport edge pairs is exhaustive: this finds the true optimum, not an approximation.
 * ~8 overlays → ~18 boundaries per axis, comfortably under a ms.
 *
 * The single enumeration every public picker runs through (see `largestFreeRect` and
 * `largestFreeAreaRect`) — the two differ only in what they score, never in what they look at.
 *
 * Returns null only if no non-degenerate free rectangle exists.
 */
function bestFreeRect(
  viewport: FitRect,
  obstacles: FitRect[],
  isBetter: FreeRectScorer
): FitRect | null {
  const axis = (lo: number, hi: number, edges: number[]): number[] =>
    [...new Set([lo, hi, ...edges.filter((v) => v > lo && v < hi)])].sort((a, b) => a - b)
  const xs = axis(viewport.left, viewport.right, obstacles.flatMap((o) => [o.left, o.right]))
  const ys = axis(viewport.top, viewport.bottom, obstacles.flatMap((o) => [o.top, o.bottom]))

  let best: FitRect | null = null
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      for (let k = 0; k < ys.length - 1; k++) {
        for (let l = k + 1; l < ys.length; l++) {
          const r: FitRect = { left: xs[i], right: xs[j], top: ys[k], bottom: ys[l] }
          const w = width(r)
          const h = height(r)
          if (w < 1 || h < 1) continue
          if (obstacles.some((o) => rectsOverlap(o, r))) continue
          if (best === null || isBetter(r, best)) best = r
        }
      }
    }
  }
  return best
}

/**
 * Largest chrome-free rectangle inside `viewport`, chosen to maximize the zoom a
 * `contentW × contentH` box can reach inside it (ties → bigger area, then closer to centre).
 */
export function largestFreeRect(
  viewport: FitRect,
  obstacles: FitRect[],
  contentW: number,
  contentH: number
): FitRect | null {
  if (contentW <= 0 || contentH <= 0) return null
  const vcx = (viewport.left + viewport.right) / 2
  const vcy = (viewport.top + viewport.bottom) / 2
  return bestFreeRect(viewport, obstacles, (candidate, best) => {
    // Zoom this rect affords the content. Ties are common once the caller's maxZoom clamps, so
    // fall back to area and then centredness to keep results stable and pleasant.
    const zoom = Math.min(width(candidate) / contentW, height(candidate) / contentH)
    const bestZoom = Math.min(width(best) / contentW, height(best) / contentH)
    const area = areaOf(candidate)
    const bestArea = areaOf(best)
    return (
      zoom > bestZoom + 1e-6 ||
      (zoom > bestZoom - 1e-6 &&
        (area > bestArea + 1e-6 ||
          (area > bestArea - 1e-6 &&
            offCentreOf(candidate, vcx, vcy) < offCentreOf(best, vcx, vcy))))
    )
  })
}

/**
 * Largest chrome-free rectangle inside `viewport` by AREA (ties → closer to centre). The shape a
 * caller wants when it fills a panel rather than fitting content at an aspect ratio — maximize
 * uses it to reserve the chrome, where "the biggest empty box" is the whole question.
 */
export function largestFreeAreaRect(viewport: FitRect, obstacles: FitRect[]): FitRect | null {
  const vcx = (viewport.left + viewport.right) / 2
  const vcy = (viewport.top + viewport.bottom) / 2
  return bestFreeRect(viewport, obstacles, (candidate, best) => {
    const area = areaOf(candidate)
    const bestArea = areaOf(best)
    return (
      area > bestArea + 1e-6 ||
      (area > bestArea - 1e-6 && offCentreOf(candidate, vcx, vcy) < offCentreOf(best, vcx, vcy))
    )
  })
}

/** Inflate a measured chrome rect by the gap so content keeps its distance. */
export const inflate = (r: FitRect, by: number): FitRect => ({
  left: r.left - by,
  top: r.top - by,
  right: r.right + by,
  bottom: r.bottom + by
})

/** Visible canvas chrome as obstacle rects, inflated by the gap and limited to the viewport. */
export function chromeObstacles(viewport: FitRect, root: ParentNode = document): FitRect[] {
  return [...root.querySelectorAll(CANVAS_CHROME_SELECTOR)]
    .map((el) => el.getBoundingClientRect())
    // Hidden/collapsed chrome measures 0 — it must not reserve any space.
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => inflate({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, FIT_VIEW_GAP))
    .filter((r) => rectsOverlap(r, viewport))
}

/** Padding accepted by xyflow's `fitView` (px strings per side). */
export type FitPadding = {
  top: `${number}px`
  left: `${number}px`
  right: `${number}px`
  bottom: `${number}px`
}

/** Express a chosen free rect as the directional insets `fitView` expects, relative to `outer`. */
export function rectToPadding(outer: FitRect, rect: FitRect): FitPadding {
  return {
    top: `${Math.max(0, Math.round(rect.top - outer.top))}px`,
    left: `${Math.max(0, Math.round(rect.left - outer.left))}px`,
    right: `${Math.max(0, Math.round(outer.right - rect.right))}px`,
    bottom: `${Math.max(0, Math.round(outer.bottom - rect.bottom))}px`
  }
}

/**
 * The chrome-free rectangle for this content, in the pane's OWN coordinates (0,0 = the pane's
 * top-left) rather than the window's. Null when there is nothing sensible to solve.
 *
 * Pane-local because that is the space a viewport transform lives in: a caller that computes the
 * camera itself (`viewportForRectInFrame`) needs the frame in the same coordinates as the
 * transform, and converting at each call site is how the two would drift.
 */
export function solveFitFrame(
  wrap: HTMLElement,
  contentW: number,
  contentH: number
): FitRect | null {
  if (contentW <= 0 || contentH <= 0) return null
  const v = wrap.getBoundingClientRect()
  const outer: FitRect = { left: v.left, top: v.top, right: v.right, bottom: v.bottom }
  const viewport: FitRect = {
    left: outer.left + FIT_VIEW_GAP,
    top: outer.top + FIT_VIEW_GAP,
    right: outer.right - FIT_VIEW_GAP,
    bottom: outer.bottom - FIT_VIEW_GAP
  }
  if (width(viewport) < 1 || height(viewport) < 1) return null
  const rect = largestFreeRect(viewport, chromeObstacles(viewport), contentW, contentH)
  return rect
    ? {
        left: rect.left - outer.left,
        top: rect.top - outer.top,
        right: rect.right - outer.left,
        bottom: rect.bottom - outer.top
      }
    : null
}

/**
 * Solve the fit-view padding for the current chrome layout and content shape.
 * Returns null when there is nothing sensible to solve, so callers can fall back to plain fitView.
 */
export function solveFitPadding(
  wrap: HTMLElement,
  contentW: number,
  contentH: number
): FitPadding | null {
  const frame = solveFitFrame(wrap, contentW, contentH)
  if (!frame) return null
  const v = wrap.getBoundingClientRect()
  // `frame` is pane-local, so the pane's own box IS the outer rect at the origin.
  return rectToPadding({ left: 0, top: 0, right: v.width, bottom: v.height }, frame)
}
