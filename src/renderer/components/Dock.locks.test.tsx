// @vitest-environment jsdom
import { act, useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Dock } from './Dock'
import { toggleCanvasLockMode, type CanvasLockMode } from '../lib/canvasLock'

vi.mock('../terminal/use-core-platform', () => ({ useCoreIsWindows: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('shows both axis buttons alongside full lock and switches modes without combining them', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function Harness() {
    const [mode, setMode] = useState<CanvasLockMode>('none')
    const props = {
      group: 'compact', zoomPct: 100, canvasLocked: mode === 'all', canvasLockMode: mode,
      onToggleCanvasLock: () => setMode(m => toggleCanvasLockMode(m, 'all')),
      onToggleCanvasAxisLock: (axis: 'horizontal' | 'vertical') => setMode(m => toggleCanvasLockMode(m, axis))
    } as ComponentProps<typeof Dock>
    return <Dock {...props} />
  }
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  const pressed = (label: string) => button(label).getAttribute('aria-pressed')
  try {
    act(() => root.render(<Harness />))
    expect(pressed('Lock view')).toBe('false')
    expect(pressed('Lock left/right pan')).toBe('false')
    expect(pressed('Lock up/down pan')).toBe('false')
    act(() => button('Lock left/right pan').click())
    expect(pressed('Lock left/right pan')).toBe('true')
    expect(pressed('Lock up/down pan')).toBe('false')
    act(() => button('Lock up/down pan').click())
    expect(pressed('Lock left/right pan')).toBe('false')
    expect(pressed('Lock up/down pan')).toBe('true')
    act(() => button('Lock view').click())
    expect(pressed('Unlock view')).toBe('true')
    expect(pressed('Lock up/down pan')).toBe('false')
    act(() => button('Lock left/right pan').click())
    expect(pressed('Lock view')).toBe('false')
    expect(pressed('Lock left/right pan')).toBe('true')
    act(() => button('Lock left/right pan').click())
    expect(pressed('Lock left/right pan')).toBe('false')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
