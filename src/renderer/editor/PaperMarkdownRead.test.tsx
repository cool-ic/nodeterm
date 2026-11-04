// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PaperMarkdownRead } from './PaperMarkdownRead'
import { tooLargeSentinel } from '@shared/fsLimits'
import type { FsApi } from '@shared/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); vi.restoreAllMocks() })
async function setup(text: string, readBinary = vi.fn(async (_path: string) => 'YQ==')) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const fs = { readBinary } as unknown as FsApi, openImage = vi.fn()
  const render = async (value: string, path = '/remote/notes/doc.md') => {
    await act(async () => root.render(<PaperMarkdownRead text={value} filePath={path} fs={fs} openImage={openImage} />))
  }
  await render(text)
  return { readBinary, openImage, render }
}
it('uses the supplied filesystem once per unique image, and does not reload for an identical render', async () => {
  const text = '![a](../assets/中文%20图.png)\n\n![b](../assets/中文%20图.png)'
  const { readBinary, render } = await setup(text)
  expect(readBinary).toHaveBeenCalledExactlyOnceWith('/remote/assets/中文 图.png')
  expect([...host.querySelectorAll('img')].every(i => i.src.startsWith('data:image/png;base64,'))).toBe(true)
  await render(text)
  expect(readBinary).toHaveBeenCalledTimes(1)
})
it('shows useful failure text for missing, oversized and network-failed images', async () => {
  const reader = vi.fn(async (path: string) => path.endsWith('large.png') ? tooLargeSentinel(50_000_000) : '')
  await setup('![missing](./missing.png)\n\n![large](./large.png)\n\n![web](https://images.example/x.png)', reader)
  expect(host.textContent).toContain('unreadable'); expect(host.textContent).toContain('too large')
  host.querySelector('img')!.dispatchEvent(new Event('error'))
  expect(host.textContent).toContain('couldn’t load image')
})
it('prevents stale reads replacing a newly opened document image', async () => {
  let finish!: (value: string) => void
  const reader = vi.fn((path: string) => path.endsWith('old.png') ? new Promise<string>(r => { finish = r }) : Promise.resolve('bmV3'))
  const { render } = await setup('![old](./old.png)', reader)
  await render('![new](./new.png)')
  await act(async () => finish('b2xk'))
  expect(host.querySelector('img')!.src).toBe('data:image/png;base64,bmV3')
})
it('opens a local image link through the owning canvas instead of navigating the app', async () => {
  const { openImage, readBinary } = await setup('[open](../assets/photo.png)')
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  host.querySelector('a')!.dispatchEvent(e)
  expect(e.defaultPrevented).toBe(true)
  expect(openImage).toHaveBeenCalledExactlyOnceWith('/remote/assets/photo.png')
  expect(readBinary).not.toHaveBeenCalled()
})
