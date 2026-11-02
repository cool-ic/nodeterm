import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { inkCellMatches, inkStrength, inkGeometry, INK_SETTLE_MS } from './paper-ink'

describe('read-only ink feedback', () => {
  it('settles monotonically and expires without delaying terminal text', () => {
    expect(inkStrength(0)).toBe(0.48)
    expect(inkStrength(100)).toBeGreaterThan(inkStrength(300))
    expect(inkStrength(INK_SETTLE_MS)).toBe(0)
    expect(inkStrength(10000)).toBe(0)
  })
  it('never paints input absent from the terminal, concealed text or inverse cells', async () => {
    const t = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    try {
      expect(inkCellMatches(t.buffer.active.getLine(0)?.getCell(0), 'password')).toBe(false)
      await new Promise<void>((r) => t.write('a\x1b[8msecret\x1b[0m\x1b[7mx\x1b[0m', r))
      const line = t.buffer.active.getLine(0)!
      expect(inkCellMatches(line.getCell(0), 'a')).toBe(true)
      expect(inkCellMatches(line.getCell(1), 's')).toBe(false)
      expect(inkCellMatches(line.getCell(7), 'x')).toBe(false)
      expect(inkCellMatches(line.getCell(0), 'b')).toBe(false)
    } finally { t.dispose() }
  })
  it('uses the buffer character and wide-cell boundary, including redraw changes', async () => {
    const t = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    try {
      await new Promise<void>((r) => t.write('中文', r))
      expect(inkCellMatches(t.buffer.active.getLine(0)?.getCell(0), '中')).toBe(true)
      expect(inkCellMatches(t.buffer.active.getLine(0)?.getCell(1), '中')).toBe(false)
      await new Promise<void>((r) => t.write('\r改', r))
      expect(inkCellMatches(t.buffer.active.getLine(0)?.getCell(0), '中')).toBe(false)
      expect(t.buffer.active.getLine(0)?.translateToString(true)).toBe('改文')
    } finally { t.dispose() }
  })
})

it('scales the settling halo and offset with type size, without lengthening its delay', () => {
 const base=inkGeometry(15)
 for(const size of [30,60,120]){
  const actual=inkGeometry(size)
  for(const key of ['blur','offsetX','offsetY'] as const)expect(actual[key]/base[key]).toBe(size/15)
 }
 expect(INK_SETTLE_MS).toBe(420)
})
