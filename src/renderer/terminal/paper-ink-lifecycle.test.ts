// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { PaperInkAddon } from './paper-ink'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
it('keeps decorations outside the subtree owned and swept by terminal renderers', () => {
  const host = document.createElement('div'), element = document.createElement('div')
  const screen = document.createElement('div'), textarea = document.createElement('textarea')
  screen.className = 'xterm-screen'
  const rendererCanvas = document.createElement('canvas'); screen.append(rendererCanvas)
  element.append(screen, textarea); host.append(element); document.body.append(host)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn() } as any)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const event = () => ({ dispose: vi.fn() })
  const headless = new HeadlessTerminal({ cols: 20, rows: 3, allowProposedApi: true })
  const term = { element, textarea, cols: 20, rows: 3, options: headless.options, hasSelection: () => false,
    onWriteParsed: event, onSelectionChange: event, onRender: event, onScroll: event, onResize: event,
    buffer: headless.buffer } as unknown as Terminal
  const addon = new PaperInkAddon(); addon.activate(term)
  expect(element.querySelectorAll('canvas')).toHaveLength(1)
  expect(host.querySelector('.terminal-paper-ink')?.parentElement).toBe(host)
  // Simulate the existing DOM renderer recovery sweep: it must not remove our decoration.
  element.querySelectorAll('.xterm-screen canvas').forEach((c) => c.remove())
  expect(host.querySelector('.terminal-paper-ink')).not.toBeNull()
  addon.dispose(); headless.dispose()
  expect(host.querySelector('.terminal-paper-ink')).toBeNull()
})
