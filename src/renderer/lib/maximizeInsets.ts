import { chromeObstacles, largestFreeAreaRect, type FitRect } from '../canvas/fit-view'
import { measurePinnedInsets, type RectLike, type ScreenInsets } from './pinnedInsets'

/**
 * Chrome whose geometry changes must re-fit a maximized node: everything that opts into fit's
 * obstacle model (`data-canvas-chrome` — the two canvas rails are each one such element, and the
 * left rail shifts right when the sessions sidebar opens), plus the two panels that can be PINNED
 * over the canvas (they are docked boxes, not canvas chrome, so they carry no opt-in attribute).
 *
 * `.dock` is deliberately absent (T233). Since T223 it is an in-flow child INSIDE
 * `.canvas-rail__body`, so the body — already a `[data-canvas-chrome]` element — covers it; listing
 * `.dock` here would observe a rect that no longer identifies a distinct piece of chrome. Fit's own
 * `CANVAS_CHROME_SELECTOR` still names `.dock`; that is a separate concern from WHAT WE OBSERVE.
 */
export const MAXIMIZE_CHROME_SELECTOR =
  '[data-canvas-chrome], .sessions-sidebar--pinned, .drawer--pinned'

/**
 * Screen-px the persistent chrome carves off each edge of `wrap`, using the SAME model fit-view
 * does: the visible chrome becomes inflated obstacle rects (`chromeObstacles`, `FIT_VIEW_GAP` = 12)
 * and we take the largest empty rectangle left (`largestFreeAreaRect`). Returning it relative to
 * `wrap` lets `maximizeTargetRect` keep its own `NODE_MAXIMIZE_MARGIN_PX` (24) as the window
 * margin — so the maximized node ends up `FIT_VIEW_GAP + NODE_MAXIMIZE_MARGIN_PX` = 36px clear of
 * any real chrome and `NODE_MAXIMIZE_MARGIN_PX` = 24px from a bare window edge. The solver owns the
 * chrome gap (12), the margin owns the rest (24); that split is the one the nails pin, and it
 * replaces the old hand-written "depth + 8 − margin" formula whose "dock is a bottom band"
 * assumption T223 invalidated (the dock moved into the top track, so that formula reported a
 * 844px bottom inset on a 932px canvas and maximize silently did nothing).
 *
 * The pinned-panel insets are UNIONED in (not just a null fallback): fit's chrome list carries
 * `.sessions-sidebar` but NOT `.drawer`, so the pinned explorer drawer is invisible to the solver
 * while `measurePinnedInsets` sees it. Taking the per-edge max keeps #854's guarantee that a
 * maximized node never lands under a pinned panel, whichever side it hugs.
 */
export function measureMaximizeInsets(wrap: RectLike): ScreenInsets {
  const sides = measurePinnedInsets(wrap)
  if (typeof document === 'undefined') return { ...sides, top: 0, bottom: 0 }
  const viewport: FitRect = {
    left: wrap.left,
    top: wrap.top,
    right: wrap.right,
    bottom: wrap.bottom
  }
  const free = largestFreeAreaRect(viewport, chromeObstacles(viewport))
  if (!free) return { ...sides, top: 0, bottom: 0 }
  return {
    left: Math.max(sides.left, free.left - wrap.left),
    right: Math.max(sides.right, wrap.right - free.right),
    top: free.top - wrap.top,
    bottom: wrap.bottom - free.bottom
  }
}
