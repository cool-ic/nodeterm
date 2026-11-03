// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { XYPanZoom, PanOnScrollMode } from '@xyflow/system'
import { constrainCanvasPan, type CanvasLockMode } from './canvasLock'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(f => f()); document.body.replaceChildren() })

/** Exercise the actual d3-backed pan engine, including its first wheel packet and sync callbacks. */
function fixture(mode: CanvasLockMode) {
  const pane = document.createElement('div')
  pane.className = 'react-flow__pane'
  pane.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON() {} })
  document.body.append(pane)
  let previous = { x: 40, y: 20, zoom: 1 }, visible = previous
  const engine = XYPanZoom({
    domNode: pane, minZoom: 0.1, maxZoom: 4, translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]], viewport: previous,
    onDraggingChange: () => {},
    onPanZoomStart: (_e, vp) => { previous = vp },
    onPanZoom: (event, next) => {
      const projected = event ? constrainCanvasPan(next, previous, mode) : next
      previous = projected
      if (projected !== next) { visible = projected; engine.syncViewport(projected) }
    }
  })
  engine.update({
    noWheelClassName: 'nowheel', noPanClassName: 'nopan', onPaneContextMenu: undefined,
    userSelectionActive: false, panOnScroll: true, panOnDrag: [0, 1],
    panOnScrollMode: mode === 'horizontal' ? PanOnScrollMode.Vertical : mode === 'vertical' ? PanOnScrollMode.Horizontal : PanOnScrollMode.Free,
    panOnScrollSpeed: 1, preventScrolling: true, zoomOnPinch: false, zoomOnScroll: false, zoomOnDoubleClick: false,
    zoomActivationKeyPressed: false, lib: 'react', onTransformChange: ([x, y, zoom]) => { visible = { x, y, zoom } },
    connectionInProgress: false, paneClickDistance: 0, selectionOnDrag: false
  })
  cleanups.push(() => engine.destroy())
  return { pane, engine, visible: () => visible }
}

describe('directional locks on the real pan engine', () => {
  it.each(['horizontal', 'vertical'] as const)('constrains the very first and subsequent diagonal wheel packets: %s', (mode) => {
    const f = fixture(mode)
    for (let i = 1; i <= 3; i++) {
      f.pane.dispatchEvent(new WheelEvent('wheel', { deltaX: 12, deltaY: 8, bubbles: true, cancelable: true }))
      const expected = mode === 'horizontal' ? { x: 40, y: 20 - 8 * i, zoom: 1 } : { x: 40 - 12 * i, y: 20, zoom: 1 }
      expect(f.visible()).toEqual(expected)
      expect(f.engine.getViewport()).toEqual(expected)
    }
  })

  it.each(['horizontal', 'vertical'] as const)('constrains every middle-drag packet and keeps d3 synchronized: %s', (mode) => {
    const f = fixture(mode)
    const view = f.pane.ownerDocument.defaultView!
    const mouse = (type: string, init: MouseEventInit) => {
      const event = new MouseEvent(type, { ...init, bubbles: true })
      // Vitest's Window proxy is not accepted by jsdom's constructor realm check; d3 still
      // needs the originating view for its document-level drag/selection listeners.
      Object.defineProperty(event, 'view', { value: view })
      return event
    }
    f.pane.dispatchEvent(mouse('mousedown', { button: 1, buttons: 4, clientX: 100, clientY: 100 }))
    for (let i = 1; i <= 3; i++) {
      view.dispatchEvent(mouse('mousemove', { buttons: 4, clientX: 100 + 10 * i, clientY: 100 + 6 * i }))
      const actual = f.engine.getViewport()
      expect(actual.x).toBe(mode === 'horizontal' ? 40 : 40 + 10 * i)
      expect(actual.y).toBe(mode === 'vertical' ? 20 : 20 + 6 * i)
      expect(f.visible()).toEqual(actual)
    }
    view.dispatchEvent(mouse('mouseup', { button: 1 }))
  })

  it('allows deliberate navigation while an axis is locked', async () => {
    const f = fixture('horizontal')
    await f.engine.setViewport({ x: 120, y: -90, zoom: 1 })
    expect(f.visible()).toEqual({ x: 120, y: -90, zoom: 1 })
    await f.engine.setViewport({ x: -80, y: -40, zoom: 2 })
    expect(f.visible()).toEqual({ x: -80, y: -40, zoom: 2 })
  })
})
