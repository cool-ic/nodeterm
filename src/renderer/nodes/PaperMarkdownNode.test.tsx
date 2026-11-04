// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PaperMarkdownNode } from './PaperMarkdownNode'
import { useSettings } from '../state/settings'
import { DEFAULT_SETTINGS } from '@shared/types'

const fake = vi.hoisted(() => ({
  fs: { exists: vi.fn(), read: vi.fn(), write: vi.fn() },
  remove: vi.fn(), change: (_: string) => {}, toggle: () => {}, created: 0
}))
vi.mock('@xyflow/react', () => ({ Handle: () => null, NodeResizer: () => null, Position: { Top: 'top' }, useReactFlow: () => ({ deleteElements: fake.remove }) }))
vi.mock('../session/session', () => ({ useSession: () => ({ api: { fs: fake.fs } }) }))
vi.mock('../components/Tooltip', () => ({ Tooltip: ({ children }: any) => children }))
vi.mock('./MaximizeButton', () => ({ MaximizeButton: () => null }))
vi.mock('../editor/PaperMarkdownEditor', () => ({ PaperMarkdownEditor: (props: any) => {
  fake.change = props.onChange
  return <textarea defaultValue={props.initialText} aria-label="source" />
} }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.clearAllMocks() })
async function mount() {
  let disk = '# Hello\n\n中文 **Markdown**\n<script>alert(1)</script>'
  fake.fs.exists.mockResolvedValue(true); fake.fs.read.mockImplementation(async () => disk)
  fake.fs.write.mockImplementation(async (_path, content) => { disk = content; return true })
  const bridge = window.nodeTerminal, settings = useSettings.getState()
  ;(window as any).nodeTerminal = { onMarkdownToggle: (fn: () => void) => { fake.toggle = fn; return () => {} } }
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalTheme: 'paper-cotton', openMarkdownPreview: false }, hydrated: true })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let props = { id: 'test-md', data: { filePath: '/test.md', color: '#abc' }, selected: false } as ComponentProps<typeof PaperMarkdownNode>
  await act(async () => root.render(<PaperMarkdownNode {...props} />))
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); useSettings.setState(settings); window.nodeTerminal = bridge }
  const click = async (name: string) => { await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click()) }
  return { host, click, update: async (data: object) => { props = { ...props, data: { ...props.data, ...data } }; await act(async () => root.render(<PaperMarkdownNode {...props} />)) } }
}
it('reads current edits safely, retains the source, and saves exact source from reading mode', async () => {
  const { host, click } = await mount()
  expect(host.querySelector('[data-paper-theme]')!.getAttribute('data-paper-theme')).toBe('paper-cotton')
  const source = host.querySelector('textarea')!
  await act(async () => fake.change('## Edited\n\n中文 <script>alert(1)</script>'))
  expect(host.querySelector('.term-node__title-text')!.textContent).toContain('●')
  await click('Read Markdown')
  expect(host.querySelector('h2')!.textContent).toBe('Edited')
  expect(host.querySelector('script')).toBeNull()
  await click('Save Markdown')
  expect(fake.fs.write).toHaveBeenCalledExactlyOnceWith('/test.md', '## Edited\n\n中文 <script>alert(1)</script>')
  expect(host.querySelector('.term-node__title-text')!.textContent).not.toContain('●')
  await click('Edit Markdown')
  expect(host.querySelector('textarea')).toBe(source)
})
it('keeps the draft accessible and refuses saves after the worktree is removed', async () => {
  const { host, click, update } = await mount()
  await act(async () => fake.change('a draft'))
  await update({ fileMissing: true })
  expect(host.querySelector('textarea')).not.toBeNull()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('Copy your edits')
  await click('Save Markdown'); expect(fake.fs.write).not.toHaveBeenCalled()
})
