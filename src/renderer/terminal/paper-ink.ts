import { VisibleInkChanges, inkSignature, type InkChange } from './paper-ink-tracker'
import { installPaperDimReadability } from './paper-dim'
import type { IBufferCell, ITerminalAddon, ITheme, Terminal } from '@xterm/xterm'
// Ink-settling treatment adapted from Typewriter Nocturne (MIT); see resources/licenses.

export const INK_SETTLE_MS = 420
/** Match the paper/type scale: a constant pixel halo vanishes relative to a large glyph. */
export function inkGeometry(fontSize: number): { blur: number; offsetX: number; offsetY: number } {
  const scale = Math.max(1, Number.isFinite(fontSize) ? fontSize : 15) / 15
  return { blur: 1.6 * scale, offsetX: 0.25 * scale, offsetY: 0.15 * scale }
}
export function inkStrength(age: number): number {
  const t = Math.max(0, Math.min(1, age / INK_SETTLE_MS))
  return (1 - t * t * (3 - 2 * t)) * 0.48
}
export function inkCellMatches(cell: IBufferCell | undefined, chars: string): boolean {
  return !!cell && cell.getChars() === chars && cell.getWidth() > 0 &&
    !cell.isInvisible() && !cell.isInverse()
}
type Mark = InkChange & { at: number }
export const INK_MAX_CELLS = 2048
const STAMP_BYTES = 4 * 1024 * 1024
const stamps = new Map<string, HTMLCanvasElement>()
let stampBytes = 0

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

/** Cache rasterized ink, not per-frame text/shadow synthesis. Shared and byte-bounded across panes. */
function stampFor(cell: IBufferCell, term: Terminal, cw: number, ch: number, dpr: number): { image: HTMLCanvasElement; pad: number } | null {
  const size = term.options.fontSize ?? 15
  const ink = inkGeometry(size), pad = Math.ceil(ink.blur * 3 + 1)
  const font = `${cell.isItalic() ? 'italic ' : ''}${cell.isBold() ? term.options.fontWeightBold : term.options.fontWeight} ${size}px ${term.options.fontFamily}`
  const color = inkColor(cell, term.options.theme)
  const key = `${font}:${color}:${cell.isDim()}:${cell.getChars()}:${cell.getWidth()}:${cw}:${ch}:${term.options.letterSpacing}:${dpr}`
  let image = stamps.get(key)
  if (image) return { image, pad }
  image = document.createElement('canvas')
  image.width = Math.ceil((cw * cell.getWidth() + pad * 2) * dpr)
  image.height = Math.ceil((ch + pad * 2) * dpr)
  const c = image.getContext('2d')
  if (!c) return null
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.font = font; c.textBaseline = 'ideographic'
  const metrics = c.measureText('W')
  const height = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)
  const x = pad + Math.floor((term.options.letterSpacing ?? 0) / 2)
  const y = pad + Math.round((ch - height) / 2) + height
  c.fillStyle = color; c.shadowColor = color; c.shadowBlur = ink.blur * .48 * dpr
  c.globalAlpha = cell.isDim() ? .65 : 1
  c.fillText(cell.getChars(), x, y)
  c.shadowBlur = 0; c.globalAlpha *= .45
  c.fillText(cell.getChars(), x + ink.offsetX, y + ink.offsetY)
  const bytes = image.width * image.height * 4
  // A single exceptionally large glyph remains usable but is never retained in the cache.
  if (bytes <= STAMP_BYTES) {
    while (stamps.size && (stampBytes + bytes > STAMP_BYTES || stamps.size >= 256)) {
      const first = stamps.keys().next().value!
      const old = stamps.get(first)!
      stampBytes -= old.width * old.height * 4; stamps.delete(first)
    }
    stamps.set(key, image); stampBytes += bytes
  }
  return { image, pad }
}

/** App-independent output decoration. Observe the rendered buffer, never keyboard guesses.
 * The terminal renders immediately; only a bounded, read-only ink wash settles above its glyphs. */
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
    term.element!.parentElement!.appendChild(canvas)
    const c = canvas.getContext('2d')
    if (!c) { canvas.remove(); return }
    const changes = new VisibleInkChanges()
    let strikes: Mark[] = [], frame = 0, dirty = false, output = false
    let theme = term.options.theme
    let appearance = ''
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const enabled = () => !!term.element?.closest('.terminal-paper') && !reduced.matches &&
      !document.hidden && !term.hasSelection() && screen.isConnected && screen.getClientRects().length > 0
    const clear = () => {
      strikes = []
      cancelAnimationFrame(frame); frame = 0
      if (dirty) c.clearRect(0, 0, canvas.width, canvas.height)
      if (canvas.width > 1 || canvas.height > 1) canvas.width = canvas.height = 1
      dirty = false
    }
    const seed = () => {
      clear(); output = false; changes.reset()
      if (term.element?.closest('.terminal-paper')) changes.capture(term.buffer.active, term.cols, term.rows, 0, term.rows - 1, false)
    }
    const draw = (now: number) => {
      frame = 0
      if (!enabled()) { clear(); return }
      const rect = screen.getBoundingClientRect()
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) { clear(); return }
      const w = parseFloat(screen.style.width) || screen.offsetWidth
      const h = parseFloat(screen.style.height) || screen.offsetHeight
      if (!w || !h) { clear(); return }
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const host = term.element!.parentElement!
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
      const scratch = buffer.getNullCell()
      strikes = strikes.filter((s) => now - s.at < INK_SETTLE_MS && s.line >= buffer.viewportY &&
        s.line < buffer.viewportY + term.rows && inkSignature(buffer.getLine(s.line)?.getCell(s.col, scratch)) === s.signature)
      for (const s of strikes) {
        const cell = buffer.getLine(s.line)!.getCell(s.col, scratch)!
        if (!inkCellMatches(cell, s.chars)) continue // concealed/inverse UI retains its renderer treatment
        const stamp = stampFor(cell, term, cw, ch, dpr)
        if (!stamp) continue
        c.globalAlpha = inkStrength(now - s.at)
        c.drawImage(stamp.image, s.col * cw - stamp.pad, (s.line - buffer.viewportY) * ch - stamp.pad,
          stamp.image.width / dpr, stamp.image.height / dpr)
      }
      c.globalAlpha = 1
      if (strikes.length) frame = requestAnimationFrame(draw)
      else clear()
    }
    seed()
    const parsed = term.onWriteParsed(() => { output = enabled() })
    const render = term.onRender(({ start, end }) => {
      if (!enabled()) { clear(); changes.reset(); output = false; return }
      const nextAppearance = `${term.options.fontFamily}:${term.options.fontSize}:${term.options.fontWeight}:${term.options.fontWeightBold}:${term.options.letterSpacing}:${term.options.lineHeight}`
      if (appearance && (appearance !== nextAppearance || theme !== term.options.theme)) seed()
      appearance = nextAppearance; theme = term.options.theme
      const changed = changes.capture(term.buffer.active, term.cols, term.rows, start, end, output)
      output = false
      if (changed.length) {
        const at = performance.now(), replaced = new Set(changed.map((s) => `${s.line}:${s.col}`))
        strikes = strikes.filter((s) => at - s.at < INK_SETTLE_MS && !replaced.has(`${s.line}:${s.col}`))
        strikes.push(...changed.slice(-INK_MAX_CELLS).map((s) => ({ ...s, at })))
        strikes = strikes.slice(-INK_MAX_CELLS)
        if (!frame) frame = requestAnimationFrame(draw)
      }
    })
    const scroll = term.onScroll(clear), resize = term.onResize(seed), bufferChange = term.buffer.onBufferChange(seed)
    const selection = term.onSelectionChange(() => { if (term.hasSelection()) { clear(); changes.reset(); output = false } })
    const visibility = () => { clear(); changes.reset(); output = false }
    document.addEventListener('visibilitychange', visibility)
    this.cleanups.push(() => { clear(); canvas.remove(); parsed.dispose(); render.dispose(); scroll.dispose(); resize.dispose(); bufferChange.dispose(); selection.dispose()
      document.removeEventListener('visibilitychange', visibility) })
  }
  dispose(): void { this.cleanups.splice(0).forEach((f) => f()) }
}
