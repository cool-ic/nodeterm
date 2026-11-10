// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PaperMarkdownNode } from './PaperMarkdownNode'
import { useSettings } from '../state/settings'
import { DEFAULT_SETTINGS } from '@shared/types'

const fake = vi.hoisted(() => ({
  fs: { exists: vi.fn(), read: vi.fn(), write: vi.fn() },
  remove: vi.fn(), updateData: vi.fn(), change: (_: string) => {}, toggle: () => {}, reset: (_mods: { meta: boolean; control: boolean }) => {}, created: 0
}))
vi.mock('@xyflow/react', () => ({ Handle: () => null, NodeResizer: () => null, Position: { Top: 'top' }, useReactFlow: () => ({ deleteElements: fake.remove, updateNodeData: fake.updateData }) }))
vi.mock('../session/session', () => ({ useSession: () => ({ api: { fs: fake.fs } }) }))
vi.mock('../components/Tooltip', () => ({ Tooltip: ({ children }: any) => children }))
vi.mock('./MaximizeButton', () => ({ MaximizeButton: () => null }))
vi.mock('../editor/PaperMarkdownEditor', () => ({ PaperMarkdownEditor: (props: any) => {
  fake.change = props.onChange
  return <textarea defaultValue={props.initialText} aria-label="source" />
} }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.clearAllMocks(); vi.restoreAllMocks() })
async function mount() {
  let disk = '# Hello\n\n中文 **Markdown**\n<script>alert(1)</script>'
  fake.fs.exists.mockResolvedValue(true); fake.fs.read.mockImplementation(async () => disk)
  fake.fs.write.mockImplementation(async (_path, content) => { disk = content; return true })
  const bridge = window.nodeTerminal, settings = useSettings.getState()
  ;(window as any).nodeTerminal = {
    onMarkdownToggle: (fn: () => void) => { fake.toggle = fn; return () => {} },
    onZoomActualSize: (fn: typeof fake.reset) => { fake.reset = fn; return () => {} }
  }
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, terminalTheme: 'paper-cotton', openMarkdownPreview: false }, hydrated: true })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let props = { id: 'test-md', data: { filePath: '/test.md', color: '#abc' }, selected: false } as ComponentProps<typeof PaperMarkdownNode>
  fake.updateData.mockImplementation((_id: string, updater: any) => {
    const patch = typeof updater === 'function' ? updater({ id: props.id, data: props.data }) : updater
    props = { ...props, data: { ...props.data, ...patch } }
    root.render(<PaperMarkdownNode {...props} />)
  })
  await act(async () => root.render(<PaperMarkdownNode {...props} />))
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); useSettings.setState(settings); window.nodeTerminal = bridge }
  const click = async (name: string) => { await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click()) }
  return { host, click, external: (text: string) => { disk = text }, update: async (data: object) => { props = { ...props, data: { ...props.data, ...data } }; await act(async () => root.render(<PaperMarkdownNode {...props} />)) } }
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
it('shares the live margin setting in writing and reading without replacing the draft editor', async () => {
  const { host, click } = await mount()
  const source = host.querySelector('textarea')!
  await act(async () => fake.change('an unsaved draft'))
  const paper = host.querySelector<HTMLElement>('.paper-markdown')!
  expect(paper.style.getPropertyValue('--paper-margin-inline')).toBe('0px')
  await act(async () => useSettings.setState({ settings: { ...useSettings.getState().settings, terminalPaperMargins: true } }))
  expect(paper.style.getPropertyValue('--paper-margin-inline')).not.toBe('0px')
  expect(host.querySelector('textarea')).toBe(source)
  await click('Read Markdown')
  expect(host.querySelector('article')!.textContent?.trim()).toBe('an unsaved draft')
  await act(async () => useSettings.setState({ settings: { ...useSettings.getState().settings, terminalPaperMargins: false } }))
  expect(paper.style.getPropertyValue('--paper-margin-block')).toBe('0px')
  await click('Edit Markdown')
  expect(host.querySelector('textarea')).toBe(source)
  expect(host.querySelector('.term-node__title-text')!.textContent).toContain('●')
  expect(fake.fs.write).not.toHaveBeenCalled()
})
it('zooms only this document in both modes, scales its material, and resets via desktop focus routing', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const { host, click } = await mount()
  const paper = host.querySelector<HTMLElement>('.paper-markdown')!
  const source = host.querySelector('textarea')!
  const press = async (key: string, code: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, code, metaKey: true, bubbles: true, cancelable: true, ...extra })
    await act(async () => (document.activeElement ?? source).dispatchEvent(event))
    return event
  }
  source.focus()
  const base = useSettings.getState().settings.fontSize
  expect((await press('=', 'Equal')).defaultPrevented).toBe(true)
  expect(paper.style.getPropertyValue('--paper-font-size')).toBe(`${base + 1}px`)
  expect(parseFloat(paper.style.getPropertyValue('--paper-tile-size'))).toBeCloseTo(680 * (base + 1) / 15)
  await act(async () => fake.change('a draft'))
  await click('Read Markdown')
  host.querySelector<HTMLElement>('article')!.focus()
  await press('+', 'Equal', { shiftKey: true })
  expect(paper.style.getPropertyValue('--paper-font-size')).toBe(`${base + 2}px`)
  await press('-', 'Minus')
  expect(paper.style.getPropertyValue('--paper-font-size')).toBe(`${base + 1}px`)
  const outside = document.createElement('input'); document.body.append(outside); outside.focus()
  await act(async () => fake.reset({ meta: true, control: false }))
  expect(paper.style.getPropertyValue('--paper-font-size')).toBe(`${base + 1}px`)
  host.querySelector<HTMLElement>('article')!.focus()
  await act(async () => fake.reset({ meta: true, control: false }))
  expect(paper.style.getPropertyValue('--paper-font-size')).toBe(`${base}px`)
  await click('Edit Markdown')
  expect(host.querySelector('textarea')).toBe(source)
  expect(host.querySelector('.term-node__title-text')!.textContent).toContain('●')
  expect(useSettings.getState().settings.fontSize).toBe(base)
  expect(fake.fs.write).not.toHaveBeenCalled()
  outside.remove()
})
it('leaves ordinary typing, alternate modifiers and IME composition alone', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const { host } = await mount()
  const source = host.querySelector('textarea')!; source.focus()
  for (const event of [
    { key: '=', code: 'Equal' },
    { key: '-', code: 'Minus', ctrlKey: true },
    { key: '+', code: 'Equal', metaKey: true, isComposing: true },
    { key: '+', code: 'Equal', metaKey: true, altKey: true }
  ]) {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...event })
    await act(async () => source.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(false)
  }
  expect(fake.updateData).not.toHaveBeenCalled()
})

it('refreshes an external edit on focus in Read mode and preserves a conflicting draft', async () => {
  const { host, click, external } = await mount()
  await click('Read Markdown')
  external('# External update')
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(host.querySelector('h1')?.textContent).toBe('External update')
  await act(async () => fake.change('# Unsaved draft'))
  external('# Another external edit')
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(host.querySelector('h1')?.textContent).toBe('Unsaved draft')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('unsaved edits')
  await click('Edit Markdown'); await click('Read Markdown')
  expect(host.querySelector('h1')?.textContent).toBe('Unsaved draft')
  expect(fake.fs.write).not.toHaveBeenCalled()
})
