// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIT_VIEW_GAP,
  largestFreeRect,
  rectToPadding,
  rectsOverlap,
  solveFitFrame,
  type FitRect
} from './fit-view'

/**
 * Geometry measured from a real 1264x722 canvas (see docs/superpowers/specs) — the chrome rects
 * are the actual dock / minimap / controls positions, already inflated by the gap.
 */
const VIEWPORT: FitRect = { left: 12, top: 56, right: 1252, bottom: 754 }
const DOCK: FitRect = { left: 407, top: 678, right: 858, bottom: 756 }
const MINIMAP: FitRect = { left: 1035, top: 587, right: 1261, bottom: 763 }
const CONTROLS: FitRect = { left: 3, top: 635, right: 53, bottom: 763 }
const CHROME = [DOCK, MINIMAP, CONTROLS]

const w = (r: FitRect): number => r.right - r.left
const h = (r: FitRect): number => r.bottom - r.top
const zoomOf = (r: FitRect, cw: number, ch: number): number => Math.min(w(r) / cw, h(r) / ch)

describe('largestFreeRect', () => {
  it('never returns a rect that overlaps any chrome', () => {
    for (const [cw, ch] of [
      [2000, 600],
      [300, 2000],
      [1000, 1000],
      [50, 50],
      [5000, 20]
    ]) {
      const r = largestFreeRect(VIEWPORT, CHROME, cw, ch)
      expect(r, `content ${cw}x${ch}`).not.toBeNull()
      for (const c of CHROME) expect(rectsOverlap(r!, c), `content ${cw}x${ch}`).toBe(false)
    }
  })

  it('stays inside the viewport', () => {
    const r = largestFreeRect(VIEWPORT, CHROME, 1000, 1000)!
    expect(r.left).toBeGreaterThanOrEqual(VIEWPORT.left)
    expect(r.top).toBeGreaterThanOrEqual(VIEWPORT.top)
    expect(r.right).toBeLessThanOrEqual(VIEWPORT.right)
    expect(r.bottom).toBeLessThanOrEqual(VIEWPORT.bottom)
  })

  it('does not charge narrow content for the bottom-right minimap', () => {
    // The regression this whole module exists for: a tall narrow column sits well clear of the
    // minimap's x-range, so it must be allowed to run past the minimap's top edge.
    const r = largestFreeRect(VIEWPORT, CHROME, 300, 2000)!
    expect(r.bottom).toBeGreaterThan(MINIMAP.top)
    expect(r.right).toBeLessThanOrEqual(MINIMAP.left)
  })

  it('beats a naive "reserve the deepest bottom intrusion" strategy for narrow content', () => {
    const naiveBottom = Math.min(DOCK.top, MINIMAP.top, CONTROLS.top)
    const naive: FitRect = { ...VIEWPORT, bottom: naiveBottom }
    const solved = largestFreeRect(VIEWPORT, CHROME, 300, 2000)!
    expect(zoomOf(solved, 300, 2000)).toBeGreaterThan(zoomOf(naive, 300, 2000))
  })

  it('uses the full width for wide content, stopping above the bottom chrome', () => {
    const r = largestFreeRect(VIEWPORT, CHROME, 4000, 500)!
    // Wide content genuinely spans the minimap's and controls' x-range, so it must clear them.
    expect(r.bottom).toBeLessThanOrEqual(Math.min(MINIMAP.top, CONTROLS.top))
    expect(w(r)).toBeGreaterThan(1000)
  })

  it('returns the whole viewport when nothing is in the way', () => {
    const r = largestFreeRect(VIEWPORT, [], 1000, 1000)!
    expect(r).toEqual(VIEWPORT)
  })

  it('reclaims space when chrome is hidden (fewer obstacles ⇒ at least as much zoom)', () => {
    const withAll = largestFreeRect(VIEWPORT, CHROME, 1200, 700)!
    const withoutMinimap = largestFreeRect(VIEWPORT, [DOCK, CONTROLS], 1200, 700)!
    expect(zoomOf(withoutMinimap, 1200, 700)).toBeGreaterThanOrEqual(zoomOf(withAll, 1200, 700))
  })

  it('is exhaustive: no sampled free rect beats the chosen one', () => {
    const cw = 900
    const ch = 800
    const best = largestFreeRect(VIEWPORT, CHROME, cw, ch)!
    const bestZoom = zoomOf(best, cw, ch)
    // Brute-force a grid of candidate rects; none may afford more zoom than the solver's. Track
    // the max and assert once — an expect() per candidate would be millions of calls.
    const step = 25
    let brute = 0
    for (let l = VIEWPORT.left; l < VIEWPORT.right; l += step) {
      for (let r2 = l + step; r2 <= VIEWPORT.right; r2 += step) {
        for (let t = VIEWPORT.top; t < VIEWPORT.bottom; t += step) {
          for (let b = t + step; b <= VIEWPORT.bottom; b += step) {
            const cand: FitRect = { left: l, right: r2, top: t, bottom: b }
            if (CHROME.some((c) => rectsOverlap(c, cand))) continue
            const z = zoomOf(cand, cw, ch)
            if (z > brute) brute = z
          }
        }
      }
    }
    expect(brute).toBeLessThanOrEqual(bestZoom + 1e-6)
  })

  it('guards degenerate content', () => {
    expect(largestFreeRect(VIEWPORT, CHROME, 0, 100)).toBeNull()
    expect(largestFreeRect(VIEWPORT, CHROME, 100, 0)).toBeNull()
  })
})

describe('rectToPadding', () => {
  it('converts a chosen rect into per-side px insets', () => {
    const outer: FitRect = { left: 0, top: 0, right: 1000, bottom: 800 }
    expect(rectToPadding(outer, { left: 20, top: 30, right: 900, bottom: 700 })).toEqual({
      left: '20px',
      top: '30px',
      right: '100px',
      bottom: '100px'
    })
  })

  it('never emits negative padding', () => {
    const outer: FitRect = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(rectToPadding(outer, { left: -10, top: -10, right: 110, bottom: 110 })).toEqual({
      left: '0px',
      top: '0px',
      right: '0px',
      bottom: '0px'
    })
  })
})

describe('solveFitFrame answers in the pane\u2019s own coordinates', () => {
  // The camera transform lives in pane space, so a caller that computes the viewport itself
  // (`viewportForRectInFrame`) needs the frame there — converting per call site is how the two
  // would drift. `solveFitPadding` is expressed through this, so both stay one solve.
  function pane(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
    const el = document.createElement('div')
    el.getBoundingClientRect = () =>
      ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top
      }) as DOMRect
    return el
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('offsets the frame by the pane origin, so an inset pane does not shift the camera', () => {
    const flush = pane({ left: 0, top: 0, width: 1200, height: 800 })
    const inset = pane({ left: 300, top: 120, width: 1200, height: 800 })
    expect(solveFitFrame(inset, 600, 400)).toEqual(solveFitFrame(flush, 600, 400))
  })

  it('keeps the frame clear of visible chrome', () => {
    document.body.innerHTML = '<div class="dock"></div>'
    const dock = document.querySelector('.dock')!
    dock.getBoundingClientRect = () =>
      ({ left: 0, top: 700, right: 1200, bottom: 800, width: 1200, height: 100, x: 0, y: 700 }) as DOMRect
    const frame = solveFitFrame(pane({ left: 0, top: 0, width: 1200, height: 800 }), 600, 400)!
    expect(frame.bottom).toBeLessThanOrEqual(700 - FIT_VIEW_GAP)
  })

  it('gives up rather than returning a degenerate frame', () => {
    expect(solveFitFrame(pane({ left: 0, top: 0, width: 8, height: 8 }), 600, 400)).toBeNull()
    expect(solveFitFrame(pane({ left: 0, top: 0, width: 1200, height: 800 }), 0, 400)).toBeNull()
  })
})

// T223: the bottom band's chrome (dock + pills) moves into the right rail, so the fit free
// rectangle reaches the pane bottom. Numbers measured from the fleet canvas (2026-10-08): pane
// 1264×722 chrome (the same rects the fixtures above use), content bbox 1550×1324 — five live
// nodes spanning x −205..1552, y 12..~1336 (node heights estimated from pane rows × 13px font).
describe('the right rail gives the fit rectangle its height back', () => {
  const PANE: FitRect = { left: 12, top: 56, right: 1252, bottom: 754 }
  // Before: dock bottom-center, pills bottom-left, minimap bottom-right, flow controls bottom-left.
  const BEFORE = [
    { left: 407, top: 678, right: 858, bottom: 756 }, // .dock
    { left: 48, top: 728, right: 312, bottom: 778 }, // .canvas-pills (inflated by data-canvas-chrome)
    { left: 1023, top: 575, right: 1273, bottom: 775 }, // .minimap
    { left: -9, top: 623, right: 65, bottom: 775 } // the old .react-flow__controls column
  ]
  // After: ONE rail rect on the right edge (dock + pills merged via data-canvas-chrome); the
  // minimap keeps its corner. T241 deleted the flow-controls column, so it leaves the fixture too.
  const AFTER = [
    { left: 1068, top: 50, right: 1214, bottom: 724 }, // .canvas-rail__body
    { left: 1023, top: 575, right: 1273, bottom: 775 } // .minimap
  ]
  // Collapsed: rail body and minimap hide (T241 removed the flow-controls rule); the 14px
  // toggle tab sits inside the 12px edge inset, so the solver measures NOTHING.
  const FLEET_W = 1550
  const FLEET_H = 1324

  it('the rail frees more height for the fleet canvas than the bottom band did', () => {
    const before = largestFreeRect(PANE, BEFORE, FLEET_W, FLEET_H)!
    const after = largestFreeRect(PANE, AFTER, FLEET_W, FLEET_H)!
    expect(h(before)).toBeLessThan(h(after))
    // The ruling's promise, in pixels: the freed bottom band is at least 76px of rect height.
    expect(h(after) - h(before)).toBeGreaterThanOrEqual(76)
    expect(zoomOf(after, FLEET_W, FLEET_H)).toBeGreaterThan(zoomOf(before, FLEET_W, FLEET_H))
  })

  it('a collapsed canvas measures zero obstacles and the fit takes the whole pane', () => {
    expect(largestFreeRect(PANE, [], FLEET_W, FLEET_H)).toEqual(PANE)
  })
})

// T235 (fourth revision, measured): the two top clusters are GONE (their buttons moved into the
// rails) and the rails moved UP onto the cluster row (window y=50). In the field's pane space the
// winning rect was 858×698 with the clusters present and 933×698 without them. The content is
// HEIGHT-limited, so the 75px of freed width does NOT move the zoom (0.5272 either way) — that is
// the honest number. The width gain only becomes a zoom gain on a wide-limited canvas.
describe('T235: the clusters are gone and the rails sit on their old row', () => {
  const PANE: FitRect = { left: 12, top: 56, right: 1252, bottom: 754 }
  const FLEET_W = 1550
  const FLEET_H = 1324
  const MINIMAP = { left: 1023, top: 575, right: 1273, bottom: 775 }
  // The bottom-left zoom column still existed at T235; T241 deleted it, so it stays in the
  // BEFORE fixture as history and leaves the AFTER one.
  const FLOW_CONTROLS = { left: -9, top: 623, right: 65, bottom: 775 }
  // T232 (before): rails 42px below the clusters, and both clusters were obstacles of their own.
  const BEFORE = [
    { left: 10, top: 92, right: 90, bottom: 519 }, // left rail card, inflated
    { left: 1174, top: 92, right: 1254, bottom: 574 }, // right rail card, inflated
    { left: 10, top: 38, right: 68, bottom: 96 }, // .sessions-icon-cluster, inflated
    { left: 948, top: 38, right: 1254, bottom: 96 }, // .controls-cluster, inflated
    MINIMAP,
    FLOW_CONTROLS
  ]
  // T241 (after): T235's rails plus the deleted zoom column — the winning rect is x-limited
  // (left rail → minimap) and the column sat left of the left rail, so its removal moves no
  // number here; it is dropped from the fixture because the element no longer exists to measure.
  const AFTER = [
    { left: 10, top: 50, right: 90, bottom: 600 }, // left rail card, inflated
    { left: 1174, top: 50, right: 1254, bottom: 640 }, // right rail card, inflated
    MINIMAP
  ]

  it('removing the clusters widens the winning rect by exactly their intrusion', () => {
    const before = largestFreeRect(PANE, BEFORE, FLEET_W, FLEET_H)!
    const after = largestFreeRect(PANE, AFTER, FLEET_W, FLEET_H)!
    expect(w(before)).toBe(858) // 90..948, stopped by the controls cluster's inflated left edge
    expect(w(after)).toBe(933) // 90..1023, now stopped only by the minimap
    expect(w(after) - w(before)).toBe(75)
  })

  it('claims no zoom gain: the fleet content is height-limited', () => {
    const before = largestFreeRect(PANE, BEFORE, FLEET_W, FLEET_H)!
    const after = largestFreeRect(PANE, AFTER, FLEET_W, FLEET_H)!
    expect(h(after)).toBe(h(before))
    expect(zoomOf(after, FLEET_W, FLEET_H)).toBeCloseTo(zoomOf(before, FLEET_W, FLEET_H), 6)
  })

  it('a live fit on the fleet canvas lands gapTop = gapBottom = 12px', () => {
    // Height-limited content fills the free rect exactly; the rect is inset 12px from the pane on
    // both axes, so the visible top and bottom gaps are both the edge inset.
    const after = largestFreeRect(PANE, AFTER, FLEET_W, FLEET_H)!
    expect(after.top).toBe(PANE.top)
    expect(after.bottom).toBe(PANE.bottom)
    const slack = (h(after) - FLEET_H * zoomOf(after, FLEET_W, FLEET_H)) / 2
    expect(slack).toBeCloseTo(0, 6)
  })

  it('a collapsed canvas measures zero obstacles and the fit takes the whole pane', () => {
    expect(largestFreeRect(PANE, [], FLEET_W, FLEET_H)).toEqual(PANE)
  })
})
