import type { FsApi } from '@shared/types'
import { tooLargeSize, formatBytes } from '@shared/fsLimits'

/** Original Markdown is the document. No HTML → Markdown round trip or autosave. */
export class MarkdownDocument {
  text = ''
  saved = ''
  loaded = false
  saving = false
  error = ''
  constructor(private fs: Pick<FsApi, 'read' | 'write' | 'exists'>, private path: string) {}
  get dirty(): boolean { return this.loaded && this.text !== this.saved }
  async load(): Promise<void> {
    try {
      if (!await this.fs.exists(this.path)) throw Error('This file no longer exists.')
      const text = await this.fs.read(this.path)
      const size = tooLargeSize(text)
      if (size !== null) throw Error(`File too large to edit (${formatBytes(size)}).`)
      this.text = this.saved = text
      this.loaded = true
    } catch (e) { this.error = e instanceof Error ? e.message : 'Couldn’t read this file.' }
  }
  async save(): Promise<void> {
    if (!this.loaded || this.saving || !this.dirty) return
    this.saving = true
    this.error = ''
    // Fence concurrent saves before the first await; typing during a write stays dirty.
    const snapshot = this.text
    try {
      if (!await this.fs.exists(this.path)) throw Error('File removed. Your edits are still here; copy them before closing.')
      if (await this.fs.read(this.path) !== this.saved) {
        throw Error('File changed on disk. Your edits are kept here; copy them before reopening to compare.')
      }
      if (!await this.fs.write(this.path, snapshot)) throw Error('Couldn’t save. Your edits are still here; try again.')
      this.saved = snapshot
    } catch (e) { this.error = e instanceof Error ? e.message : 'Couldn’t save. Try again.' }
    finally { this.saving = false }
  }
}
