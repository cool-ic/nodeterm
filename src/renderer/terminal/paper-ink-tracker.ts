import type { IBuffer, IBufferCell } from '@xterm/xterm'

export type InkChange = { chars: string; col: number; line: number; signature: string }
export type InkMove = InkChange & { fromLine: number; fromCol: number }
/** Appearance validates a live decoration; it must not decide whether text is newly printed. */
export function inkSignature(cell: IBufferCell | undefined): string {
  if (!cell || !cell.getWidth() || cell.isInvisible()) return ''
  return `${cell.getChars()}:${cell.getWidth()}:${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.getBgColorMode()}:${cell.getBgColor()}:${cell.isBold()}:${cell.isItalic()}:${cell.isDim()}:${cell.isInverse()}`
}

type Row = { keys: string[]; text: string }
type Token = { key: string; line: number; col: number }
type Pair = readonly [number, number]
type Budget = { left: number }
const ALIGNMENT_BUDGET = 250_000

/** Ordered matching prevents a copied/repeated line from consuming the same old line twice.
 * Prefix/suffix are linear; ambiguous large replacements skip decoration rather than flash history. */
function align(before: readonly string[], after: readonly string[], budget: Budget): Pair[] | null {
  let head = 0, oldEnd = before.length, newEnd = after.length
  const pairs: Pair[] = [], tail: Pair[] = []
  while (head < oldEnd && head < newEnd && before[head] === after[head]) { pairs.push([head, head]); head++ }
  while (oldEnd > head && newEnd > head && before[oldEnd - 1] === after[newEnd - 1]) tail.push([--oldEnd, --newEnd])
  const n = oldEnd - head, m = newEnd - head
  if (n && m) {
    if ((n + 1) * (m + 1) > budget.left) return null
    budget.left -= (n + 1) * (m + 1)
    const width = m + 1, table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = before[head + i] === after[head + j]
        ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
    let i = 0, j = 0
    while (i < n && j < m) {
      if (before[head + i] === after[head + j]) { pairs.push([head + i++, head + j++]); continue }
      if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++
      else j++
    }
  }
  return pairs.concat(tail.reverse())
}

function readRow(buffer: IBuffer, line: number, cols: number, scratch: IBufferCell): Row {
  const row = buffer.getLine(line), keys: string[] = []
  for (let col = 0; col < cols; col++) {
    const cell = row?.getCell(col, scratch)
    const chars = cell && cell.getWidth() && !cell.isInvisible() ? cell.getChars() : ''
    keys.push(chars ? `${cell!.getWidth()}:${chars}` : '')
  }
  while (keys.length && (!keys.at(-1) || !keys.at(-1)!.slice(2).trim())) keys.pop()
  return { keys, text: keys.join('\0') }
}
function tokens(rows: readonly (readonly [number, Row])[]): Token[] {
  const result: Token[] = []
  for (const [line, row] of rows) for (let col = 0; col < row.keys.length; col++) {
    const key = row.keys[col]
    if (key) result.push({ key, line, col })
  }
  return result
}

/** Compare visible content, then carry its identity across row/character movement.
 * Colour/focus redraws update appearance but never restart a character's settling clock. */
export class VisibleInkChanges {
  private buffer?: IBuffer
  private rows = new Map<number, Row>()
  private cols = 0
  private height = 0
  private top = -1
  private base = -1
  moves: InkMove[] = []
  uncertain = false
  reset(): void { this.buffer = undefined; this.rows.clear(); this.top = this.base = -1; this.moves = []; this.uncertain = false }
  capture(buffer: IBuffer, cols: number, height: number, start: number, end: number, output: boolean): InkChange[] {
    this.moves = []; this.uncertain = false
    const hadBaseline = this.buffer !== undefined
    const changedBuffer = this.buffer !== buffer || this.cols !== cols || this.height !== height
    const wasLive = this.top === this.base
    const oldBottom = this.top + this.height - 1
    const shifted = this.top !== buffer.viewportY
    if (!output && !changedBuffer && !shifted) return []
    const before = changedBuffer ? new Map<number, Row>() : this.rows
    const next = new Map(before), scratch = buffer.getNullCell()
    const first = changedBuffer || shifted ? 0 : Math.max(0, start)
    const last = changedBuffer || shifted ? height - 1 : Math.min(height - 1, end)
    for (let row = first; row <= last; row++) {
      const absolute = buffer.viewportY + row
      const value = readRow(buffer, absolute, cols, scratch), prior = before.get(absolute)
      next.set(absolute, value.text === prior?.text ? prior : value)
    }
    for (const line of next.keys()) if (line < buffer.viewportY || line >= buffer.viewportY + height) next.delete(line)
    const freshBottom = new Set<number>()
    if (wasLive && buffer.type === 'normal' && buffer.baseY > this.base) {
      for (const line of next.keys()) if (line > oldBottom) freshBottom.add(line)
    }
    this.rows = next; this.buffer = buffer; this.cols = cols; this.height = height
    this.top = buffer.viewportY; this.base = buffer.baseY
    if (!output || !hadBaseline || changedBuffer || !wasLive || buffer.viewportY !== buffer.baseY) return []

    const changes: InkChange[] = [], budget = { left: ALIGNMENT_BUDGET }
    const oldRows = [...before.entries()].sort((a, b) => a[0] - b[0])
    const newRows = [...next.entries()].filter(([line]) => !freshBottom.has(line)).sort((a, b) => a[0] - b[0])
    const makeMark = (token: Token): InkChange | undefined => {
      const chars = token.key.slice(2)
      if (!chars.trim()) return
      const cell = buffer.getLine(token.line)?.getCell(token.col, scratch)
      const signature = inkSignature(cell)
      if (signature) return { chars, col: token.col, line: token.line, signature }
    }
    const carry = (old: Token, next: Token) => {
      if (old.line === next.line && old.col === next.col) return
      const mark = makeMark(next)
      if (mark) this.moves.push({ ...mark, fromLine: old.line, fromCol: old.col })
    }
    const rowPairs = align(oldRows.map(([, row]) => row.text), newRows.map(([, row]) => row.text), budget)
    if (rowPairs) {
      let oldAt = 0, newAt = 0
      for (const [oldIndex, newIndex] of [...rowPairs, [oldRows.length, newRows.length] as const]) {
        const oldTokens = tokens(oldRows.slice(oldAt, oldIndex)), newTokens = tokens(newRows.slice(newAt, newIndex))
        const pairs = align(oldTokens.map(t => t.key), newTokens.map(t => t.key), budget)
        if (pairs) {
          const kept = new Set<number>()
          for (const [a, b] of pairs) { kept.add(b); carry(oldTokens[a], newTokens[b]) }
          for (let i = 0; i < newTokens.length; i++) if (!kept.has(i)) {
            const mark = makeMark(newTokens[i]); if (mark) changes.push(mark)
          }
        } else this.uncertain = true
        if (oldIndex < oldRows.length && oldRows[oldIndex][0] !== newRows[newIndex][0]) {
          const oldTokens = tokens([oldRows[oldIndex]]), newTokens = tokens([newRows[newIndex]])
          for (let i = 0; i < oldTokens.length; i++) carry(oldTokens[i], newTokens[i])
        }
        oldAt = oldIndex + 1; newAt = newIndex + 1
      }
    } else this.uncertain = true
    // Normal scrollback has true append identities even when the new log line repeats old text.
    for (const line of freshBottom) for (const token of tokens([[line, next.get(line)!]])) {
      const mark = makeMark(token); if (mark) changes.push(mark)
    }
    return changes
  }
}
