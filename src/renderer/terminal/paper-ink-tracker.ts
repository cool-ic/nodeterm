import type { IBuffer, IBufferCell } from '@xterm/xterm'

export type InkChange = { chars: string; col: number; line: number; signature: string }
/** Public buffer attributes only: never infer output from keys or retain unrendered input. */
export function inkSignature(cell: IBufferCell | undefined): string {
  if (!cell || !cell.getWidth() || cell.isInvisible()) return ''
  return `${cell.getChars()}:${cell.getWidth()}:${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.getBgColorMode()}:${cell.getBgColor()}:${cell.isBold()}:${cell.isItalic()}:${cell.isDim()}:${cell.isInverse()}`
}

/** A viewport-sized snapshot, shared by normal-buffer and alternate-buffer applications.
 * Call after parsing AND rendering; a repaint alone does not constitute new output. */
export class VisibleInkChanges {
  private buffer?: IBuffer
  private rows = new Map<number, string[]>()
  private cols = 0
  private height = 0
  private top = -1
  reset(): void { this.buffer = undefined; this.rows.clear(); this.top = -1 }
  capture(buffer: IBuffer, cols: number, height: number, start: number, end: number, output: boolean): InkChange[] {
    const hadBaseline = this.buffer !== undefined
    const changedBuffer = this.buffer !== buffer || this.cols !== cols || this.height !== height
    const oldBottom = this.top + this.height - 1
    const shifted = this.top !== buffer.viewportY
    if (changedBuffer) this.rows.clear()
    if (!output && !changedBuffer && !shifted) return [] // cursor blink, focus or selection repaint
    const changes: InkChange[] = []
    const scratch = buffer.getNullCell()
    const first = changedBuffer || shifted ? 0 : Math.max(0, start)
    const last = changedBuffer || shifted ? height - 1 : Math.min(height - 1, end)
    for (let row = first; row <= last; row++) {
      const absolute = buffer.viewportY + row, line = buffer.getLine(absolute)
      const before = this.rows.get(absolute)
      const next: string[] = []
      // Newly revealed history must not look like newly emitted output. New live bottom rows can.
      const animate = output && hadBaseline && buffer.viewportY === buffer.baseY &&
        (changedBuffer || !!before || absolute > oldBottom)
      for (let col = 0; col < cols; col++) {
        const cell = line?.getCell(col, scratch)
        const signature = inkSignature(cell)
        next.push(signature)
        const chars = cell?.getChars() ?? ''
        if (animate && signature !== before?.[col] && signature && chars.trim()) {
          changes.push({ chars, col, line: absolute, signature })
        }
      }
      this.rows.set(absolute, next)
    }
    for (const line of this.rows.keys()) if (line < buffer.viewportY || line >= buffer.viewportY + height) this.rows.delete(line)
    this.buffer = buffer; this.cols = cols; this.height = height; this.top = buffer.viewportY
    return changes
  }
}
