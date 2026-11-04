import { describe, expect, it, vi } from 'vitest'
import { MarkdownDocument } from './markdown-document'
import { tooLargeSentinel } from '@shared/fsLimits'

const make = (text = '# 原文\r\n\r\n**hello**\r\n') => {
  let disk = text
  const fs = { exists: vi.fn(async () => true), read: vi.fn(async () => disk),
    write: vi.fn(async (_path: string, value: string) => { disk = value; return true }) }
  const doc = new MarkdownDocument(fs, '/notes/test.md')
  return { doc, fs, disk: () => disk, external: (text: string) => { disk = text } }
}
describe('Markdown file lifecycle', () => {
  it('saves the exact Markdown including line endings and only when changed', async () => {
    const { doc, fs, disk } = make()
    await doc.load(); await doc.save()
    expect(fs.write).not.toHaveBeenCalled()
    doc.text += 'English / 中文 `code`\r\n'
    await doc.save()
    expect(disk()).toBe(doc.text); expect(doc.dirty).toBe(false)
  })
  it('does not overwrite an external edit or deleted file', async () => {
    const { doc, fs, external } = make('before')
    await doc.load(); doc.text = 'mine'; external('someone else')
    await doc.save()
    expect(doc.error).toContain('changed on disk'); expect(doc.dirty).toBe(true)
    expect(fs.write).not.toHaveBeenCalled()
    fs.exists.mockResolvedValue(false); await doc.save()
    expect(doc.error).toContain('removed'); expect(fs.write).not.toHaveBeenCalled()
  })
  it('keeps edits and retries after a refused or rejected write', async () => {
    const { doc, fs } = make('before')
    await doc.load(); doc.text = 'after'
    fs.write.mockResolvedValueOnce(false)
    await doc.save(); expect(doc.dirty).toBe(true); expect(doc.saving).toBe(false)
    fs.write.mockRejectedValueOnce(new Error('offline'))
    await doc.save(); expect(doc.error).toBe('offline'); expect(doc.dirty).toBe(true)
    await doc.save(); expect(doc.dirty).toBe(false); expect(doc.error).toBe('')
  })
  it('serializes saves and does not mark text typed during a save as saved', async () => {
    const { doc, fs } = make('before')
    await doc.load(); doc.text = 'first'
    let finish!: (value: boolean) => void
    fs.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = doc.save(); await vi.waitFor(() => expect(fs.write).toHaveBeenCalledTimes(1))
    doc.text = 'second'; await doc.save()
    expect(fs.write).toHaveBeenCalledTimes(1)
    finish(true); await first
    expect(doc.saved).toBe('first'); expect(doc.text).toBe('second'); expect(doc.dirty).toBe(true)
  })
  it('does not create a savable placeholder for oversized, missing or failed reads', async () => {
    const { doc, fs } = make(tooLargeSentinel(20_000_000))
    await doc.load(); expect(doc.loaded).toBe(false); expect(doc.error).toContain('too large')
    doc.text = 'oops'; await doc.save(); expect(fs.write).not.toHaveBeenCalled()
    fs.exists.mockResolvedValue(false); await doc.load(); expect(doc.error).toContain('no longer exists')
    fs.exists.mockResolvedValue(true); fs.read.mockRejectedValue(new Error('offline'))
    await doc.load(); expect(doc.error).toBe('offline'); expect(doc.loaded).toBe(false)
  })
})
