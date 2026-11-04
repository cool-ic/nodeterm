// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LazyEditorNode } from './lazyMonacoNodes'
const loads = vi.hoisted(() => ({ monaco: 0, markdown: 0 }))
vi.mock('./EditorNode', () => { loads.monaco++; return { EditorNode: () => <div>Code editor</div> } })
vi.mock('./PaperMarkdownNode', () => { loads.markdown++; return { PaperMarkdownNode: () => <div>Paper Markdown</div> } })
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
it('routes all supported Markdown extensions without loading the Monaco chunk', async () => {
  const host = document.createElement('div'), root = createRoot(host)
  try {
    for (const filePath of ['/test.md', '/test.MARKDOWN', '/test.mdown', '/test.mkd']) {
      await act(async () => root.render(<LazyEditorNode {...({ id: 'test', data: { filePath } } as any)} />))
      expect(host.textContent).toBe('Paper Markdown')
    }
    expect(loads.monaco).toBe(0); expect(loads.markdown).toBe(1)
    await act(async () => root.render(<LazyEditorNode {...({ id: 'test', data: { filePath: '/test.ts' } } as any)} />))
    expect(host.textContent).toBe('Code editor'); expect(loads.monaco).toBe(1)
  } finally { await act(async () => root.unmount()) }
})
