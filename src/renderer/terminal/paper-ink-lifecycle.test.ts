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

it('moves an active ink wash without restarting its age or duplicating overwritten positions', async () => {
  vi.useFakeTimers()
  try {
    const headless = new HeadlessTerminal({ cols: 10, rows: 3, allowProposedApi: true })
    const write = (s: string) => new Promise<void>((r) => headless.write(s, r))
    // Headless parsing uses timers; flush writes independently of the animation clock.
    const feed = async (s: string) => { const work = write(s); await vi.runOnlyPendingTimersAsync(); await work }
    await feed('\x1b[?1049h')
    const host = document.createElement('div'); host.className = 'terminal-paper'
    const element = document.createElement('div'), screen = document.createElement('div'), textarea = document.createElement('textarea')
    screen.className = 'xterm-screen';screen.style.width = '120px';screen.style.height = '60px'
    screen.getClientRects = () => [{}] as any
    screen.getBoundingClientRect = () => ({ left: 0, top: 0, right: 120, bottom: 60 }) as DOMRect
    element.append(screen, textarea);host.append(element);document.body.append(host)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.spyOn(document,'hidden','get').mockReturnValue(false)
    const paints: Array<{ alpha: number; y: number }> = []
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const owner = this
      return { clearRect() {}, setTransform() {}, fillText() {}, measureText: () => ({ fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 2 }),
        globalAlpha: 1, drawImage(_image: unknown,_x: number,y: number) { if(owner.classList.contains('terminal-paper-ink'))paints.push({alpha:this.globalAlpha,y}) } } as any
    })
    let id = 0;const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame',(f: FrameRequestCallback)=>{frames.set(++id,f);return id})
    vi.stubGlobal('cancelAnimationFrame',(n: number)=>frames.delete(n))
    let render!: (event:{start:number;end:number})=>void
    const term = { element,textarea,cols:10,rows:3,options:headless.options,buffer:headless.buffer,hasSelection:()=>false,
      onWriteParsed:headless.onWriteParsed.bind(headless), onScroll:headless.onScroll.bind(headless),onResize:headless.onResize.bind(headless),
      onSelectionChange:()=>({dispose(){}}),onRender:(f:typeof render)=>{render=f;return {dispose(){}}} } as unknown as Terminal
    const addon=new PaperInkAddon();addon.activate(term)
    const step=async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);const next=[...frames.values()];frames.clear();paints.length=0;next.forEach(f=>f(performance.now()))}
    await feed('A\r\nB\r\nC');render({start:0,end:2});await step(100)
    expect(paints).toHaveLength(3)
    await feed('\x1b[1S\x1b[3;1HD');render({start:0,end:2});await step(100)
    expect(paints).toHaveLength(3)
    expect(paints[0].alpha).toBeCloseTo(paints[1].alpha)
    expect(paints[2].alpha).toBeGreaterThan(paints[0].alpha) // D is new; B/C retain their old clock
    await step(225)
    expect(paints).toHaveLength(1)
    await step(105)
    expect(frames.size).toBe(0)
    addon.dispose();headless.dispose()
  } finally { vi.useRealTimers() }
})
