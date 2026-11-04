import { expect, it } from 'vitest'
import { flowToNodeStates, nodeStatesToFlow } from './workspace'
import type { CanvasNodeState } from '@shared/types'

const base: CanvasNodeState = { id: 'md-one', kind: 'editor', position: { x: 0, y: 0 }, size: { width: 800, height: 600 }, title: 'test.md', filePath: '/test.md', color: '#aaa', group: null }
it('persists a Markdown font override through the real save/load seam and validates untrusted values', () => {
  for (const size of [8, 24, 72]) {
    const roundTrip = flowToNodeStates(nodeStatesToFlow([{ ...base, markdownFontSize: size }]))
    expect(roundTrip[0].markdownFontSize).toBe(size)
    expect(nodeStatesToFlow(roundTrip)[0].data.markdownFontSize).toBe(size)
  }
  for (const size of [undefined, null, '20', 0, NaN, Infinity]) {
    const flow = nodeStatesToFlow([{ ...base, markdownFontSize: size } as CanvasNodeState])
    expect(flow[0].data.markdownFontSize).toBeUndefined()
    ;(flow[0].data as Record<string, unknown>).markdownFontSize = size
    expect(flowToNodeStates(flow)[0].markdownFontSize).toBeUndefined()
  }
})
