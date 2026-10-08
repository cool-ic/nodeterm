// @vitest-environment jsdom
//
// T233: maximize reserves the same chrome fit-view does. The regression this guarded: the old
// hand-written formula assumed `.dock` was a BOTTOM band (`depth = wrap.bottom − dock.top`), which
// T223 invalidated when it moved the dock into the top right-hand track — so it read the top docks
// as a 844px bottom inset on a 932px canvas, `maximizeTargetRect` returned null, and Maximize did
// nothing. Every rect below is the employer's CDP measurement (t233-maximize-insets-spec.md).
// T235 moved on from that layout: the two top clusters are gone and the rails sit on the cluster
// row (window y=50), so the fixture and its expected insets follow the new field.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { measureMaximizeInsets, MAXIMIZE_CHROME_SELECTOR } from './maximizeInsets'
import { maximizeTargetRect } from './nodeMaximize'
import { viewportForRect } from './nodeFocus'

const BUTTON_SRC = fs
  .readFileSync(path.join(__dirname, '..', 'nodes', 'MaximizeButton.tsx'), 'utf8')
  .replace(/\r\n/g, '\n')

/** The canvas wrapper inside the field window: 1728 wide, 932 tall (the tab bar is above it). */
const WRAP = { left: 0, top: 28, right: 1728, bottom: 960 }

function chrome(
  className: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
  chromed = false
) {
  const el = document.createElement('div')
  el.className = className
  if (chromed) el.setAttribute('data-canvas-chrome', '')
  el.getBoundingClientRect = () =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
  document.body.append(el)
  return el
}

/** The chrome that actually paints over the fleet canvas: the two 56px rails (each ONE
 *  `data-canvas-chrome` body) with their docks inside. T235: they sit on the old cluster row
 *  (window y=50) and the two clusters are gone. */
function fieldChrome() {
  chrome('canvas-rail__body', 22, 50, 78, 630, true) // left rail body (22..78)
  chrome('canvas-rail__body', 1650, 50, 1706, 640, true) // right rail body (W-78..W-22)
  chrome('dock', 28, 58, 70, 560) // the left rail's dock, INSIDE the body
  chrome('dock', 1658, 58, 1700, 500) // the right rail's dock, inside the body
}

afterEach(() => document.body.replaceChildren())

describe('maximize reserves the shared chrome model (T233 regression)', () => {
  it('keeps the bottom inset sane — a top dock is not a bottom band', () => {
    fieldChrome()
    const insets = measureMaximizeInsets(WRAP)
    // The old formula read the docks (top y=100) as a bottom band: 860 + 8 − 24 = 844 > 932.
    expect(insets.bottom).toBeLessThan(932)
    expect(insets.bottom).toBe(0)
  })

  it('reserves both 56px rails: the rail footprint plus the shared fit gap', () => {
    fieldChrome()
    const insets = measureMaximizeInsets(WRAP)
    // 22 (--float-gap) + 56 (rail) = 78 is the rail's footprint; chromeObstacles inflates it by the
    // shared FIT_VIEW_GAP (12), so the solved inset is 90 on each edge. (The spec's "about 78"
    // counted the rail's own footprint and left the gap out.)
    expect(insets.left).toBe(90)
    expect(insets.right).toBe(90)
  })

  it('produces a usable maximize rect on the field layout', () => {
    fieldChrome()
    const insets = measureMaximizeInsets(WRAP)
    // T235: no top chrome, so nothing reserves a top band any more (it was 68 below the clusters).
    expect(insets.top).toBe(0)
    const rect = maximizeTargetRect({ x: 0, y: 0, zoom: 1 }, 1728, 932, 24, insets)
    expect(rect).not.toBeNull()
    expect(rect!.height).toBeGreaterThanOrEqual(120)
    // The node's top is now just the window margin: margin (24) + wrap top (28) = 52.
    expect(rect!.y + WRAP.top).toBe(WRAP.top + 24)
  })

  it('keeps a maximized node clear of a pinned drawer the fit list does not name', () => {
    fieldChrome()
    // `.drawer` is not in fit's chrome list, so only the union with measurePinnedInsets sees it.
    chrome('drawer drawer--pinned', 1428, 90, 1706, 780)
    const insets = measureMaximizeInsets(WRAP)
    expect(insets.right).toBe(1728 - 1428)
    expect(insets.left).toBe(90)
  })

  it('reserves nothing when no chrome floats over the canvas', () => {
    expect(measureMaximizeInsets(WRAP)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 })
  })

  it.each([0.7345, 1, 1.1704, 2])('maximize then refocus is a fixed point at zoom %s', (zoom) => {
    fieldChrome()
    const insets = measureMaximizeInsets(WRAP)
    const viewport = { x: -123, y: 87, zoom }
    const rect = maximizeTargetRect(viewport, 1728, 932, 24, insets)!
    const focused = viewportForRect(rect, 1728, 932, zoom, insets)!
    expect(focused.x).toBeCloseTo(viewport.x)
    expect(focused.y).toBeCloseTo(viewport.y)
    expect(focused.zoom).toBe(zoom)
  })

  it('releases the side inset once the rails are gone', () => {
    fieldChrome()
    expect(measureMaximizeInsets(WRAP).left).toBe(90)
    document.body.replaceChildren()
    expect(measureMaximizeInsets(WRAP).left).toBe(0)
  })

  it('observes exactly the fit opt-in plus both pinned panels, and drops .dock', () => {
    // What the ResizeObserver watches (Canvas.tsx:10032). `.dock` is gone: it is an in-flow child
    // of a `[data-canvas-chrome]` rail body now, so the body already tracks it.
    expect(MAXIMIZE_CHROME_SELECTOR).toContain('[data-canvas-chrome]')
    expect(MAXIMIZE_CHROME_SELECTOR).toContain('.sessions-sidebar--pinned')
    expect(MAXIMIZE_CHROME_SELECTOR).toContain('.drawer--pinned')
    expect(MAXIMIZE_CHROME_SELECTOR).not.toContain('.dock')
  })

  it('the header button computes its rect through the shared insets', () => {
    // A source read, in the canvas-wiring spirit: nothing else sees this call survive a refactor.
    expect(BUTTON_SRC).toContain('measureMaximizeInsets(wrap)')
    expect(BUTTON_SRC).toContain('maximizeTargetRect(')
  })
})
