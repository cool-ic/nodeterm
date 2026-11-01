import { installPaperDimReadability } from './paper-dim'
import type { IBufferCell, ITerminalAddon, ITheme, Terminal } from '@xterm/xterm'
// Ink-settling treatment adapted from Typewriter Nocturne (MIT); see resources/licenses.

export const INK_SETTLE_MS = 420
export function inkStrength(age: number): number {
  const t = Math.max(0, Math.min(1, age / INK_SETTLE_MS))
  return (1 - t * t * (3 - 2 * t)) * 0.48
}
export function inkCellMatches(cell: IBufferCell | undefined, chars: string): boolean {
  return !!cell && cell.getChars() === chars && cell.getWidth() > 0 &&
    !cell.isInvisible() && !cell.isInverse()
}
type Mark = { chars: string; col: number; line: number; at: number }
const ANSI: (keyof ITheme)[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
function inkColor(cell: IBufferCell, theme: ITheme = {}): string {
  const n = cell.getFgColor()
  if (cell.isFgRGB()) return `#${n.toString(16).padStart(6, '0')}`
  if (cell.isFgPalette()) {
    if (n < 16) {
      const color = theme[ANSI[n]]
      return typeof color === 'string' ? color : theme.foreground ?? '#2a2019'
    }
    if (theme.extendedAnsi?.[n - 16]) return theme.extendedAnsi[n - 16]
    if (n >= 232) { const gray = 8 + (n - 232) * 10; return `rgb(${gray}, ${gray}, ${gray})` }
    const cube = [0, 95, 135, 175, 215, 255], i = n - 16
    return `rgb(${cube[Math.floor(i / 36)]}, ${cube[Math.floor(i / 6) % 6]}, ${cube[i % 6]})`
  }
  return theme.foreground ?? '#2a2019'
}

/** Read-only echo feedback. Never paints a key until the terminal itself has displayed it.
 * The real text never moves; a short-lived copy settles above it. */
export class PaperInkAddon implements ITerminalAddon {
  private cleanups: (() => void)[] = []
  activate(term: Terminal): void {
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen || !term.textarea) return
    this.cleanups.push(installPaperDimReadability(term))
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    canvas.className = 'terminal-paper-ink'
    canvas.setAttribute('aria-hidden', 'true')
    // xterm's renderer lifecycle owns ALL canvases inside its element. An ink canvas there
    // is mistaken for a broken WebGL renderer and swept away during budget swaps.
    term.element!.parentElement!.appendChild(canvas)
    const c = canvas.getContext('2d')
    if (!c) { canvas.remove(); return }
    let pending: Mark[] = [], strikes: Mark[] = [], frame = 0, dirty = false
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const enabled = () => !!term.element?.closest('.terminal-paper') && !reduced.matches &&
      !document.hidden && document.activeElement === term.textarea && screen.isConnected && screen.getClientRects().length > 0
    const clear = () => {
      pending = []; strikes = []
      cancelAnimationFrame(frame); frame = 0
      if (dirty) c.clearRect(0, 0, canvas.width, canvas.height)
      if (canvas.width > 1 || canvas.height > 1) canvas.width = canvas.height = 1
      dirty = false
    }
    const draw = (now: number) => {
      frame = 0
      if (!enabled()) { clear(); return }
      const w = parseFloat(screen.style.width) || screen.offsetWidth
      const h = parseFloat(screen.style.height) || screen.offsetHeight
      if (!w || !h) { clear(); return }
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const host = term.element!.parentElement!
      // A parked terminal can be adopted by a new host; move the decoration with it.
      if (canvas.parentElement !== host) host.appendChild(canvas)
      canvas.style.left = `${term.element!.offsetLeft + screen.offsetLeft}px`
      canvas.style.top = `${term.element!.offsetTop + screen.offsetTop}px`
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
      }
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h)
      dirty = true
      const buffer = term.buffer.active, cw = w / term.cols, ch = h / term.rows
      strikes = strikes.filter((s) => now - s.at < INK_SETTLE_MS &&
        inkCellMatches(buffer.getLine(s.line)?.getCell(s.col), s.chars))
      for (const s of strikes) {
        const cell = buffer.getLine(s.line)!.getCell(s.col)!
        const row = s.line - buffer.viewportY
        if (row < 0 || row >= term.rows) continue
        c.font = `${cell.isBold() ? term.options.fontWeightBold : term.options.fontWeight} ${term.options.fontSize}px ${term.options.fontFamily}`
        c.textBaseline = 'ideographic'
        const metrics = c.measureText('W')
        const height = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)
        const x = s.col * cw + Math.floor((term.options.letterSpacing ?? 0) / 2)
        const y = row * ch + Math.round((ch - height) / 2) + height
        const k = inkStrength(now - s.at)
        c.fillStyle = inkColor(cell, term.options.theme)
        c.shadowColor = c.fillStyle; c.shadowBlur = 1.6 * k * dpr
        c.globalAlpha = k; c.fillText(s.chars, x, y)
        c.shadowBlur = 0; c.globalAlpha = k * 0.45; c.fillText(s.chars, x + 0.25, y + 0.15)
      }
      c.globalAlpha = 1
      if (strikes.length) frame = requestAnimationFrame(draw)
      else clear()
    }
    const record = (text: string) => {
      if (!enabled() || !text) return
      const b = term.buffer.active
      const existing = b.getLine(b.baseY + b.cursorY)?.getCell(b.cursorX)?.getChars()
      // A pre-existing matching glyph is not evidence of an echo (e.g. a hidden-input TUI).
      if (existing && text.startsWith(existing)) return
      pending.push({ chars: text, col: b.cursorX, line: b.baseY + b.cursorY, at: performance.now() })
      pending = pending.slice(-32)
    }
    const onKey = term.onKey(({ key, domEvent: e }) => {
      if (e.isTrusted && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && [...key].length === 1 && key >= ' ') record(key)
    })
    const composition = (e: CompositionEvent) => { if (e.isTrusted) record(e.data) }
    term.textarea.addEventListener('compositionend', composition, true)
    const render = term.onRender(() => {
      if (!enabled()) { clear(); return }
      const now = performance.now(), b = term.buffer.active
      pending = pending.filter((p) => {
        if (now - p.at > 1500) return false
        let rest = p.chars
        while (rest && p.col < term.cols) {
          const cell = b.getLine(p.line)?.getCell(p.col)
          const glyph = cell?.getChars()
          if (!glyph || !rest.startsWith(glyph) || !inkCellMatches(cell, glyph)) break
          strikes.push({ chars: glyph, col: p.col, line: p.line, at: now })
          rest = rest.slice(glyph.length)
          p.col += cell!.getWidth()
        }
        p.chars = rest
        return rest.length > 0
      })
      strikes = strikes.slice(-32)
      if (strikes.length && !frame) frame = requestAnimationFrame(draw)
    })
    const scroll = term.onScroll(clear), resize = term.onResize(clear), bufferChange = term.buffer.onBufferChange(clear)
    term.textarea.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    this.cleanups.push(() => { clear(); canvas.remove(); onKey.dispose(); render.dispose(); scroll.dispose(); resize.dispose(); bufferChange.dispose()
      term.textarea?.removeEventListener('compositionend', composition, true)
      term.textarea?.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', clear) })
  }
  dispose(): void { this.cleanups.splice(0).forEach((f) => f()) }
}
