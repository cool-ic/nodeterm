import { it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { locateQoderIn } from './locate'
import { linesFromQoder } from '../context-link-render'
import { testTmpDir } from '../test-tmp'

it('locates the exact Qoder session and rejects path injection and symlinks', async () => {
  const root = testTmpDir('qoder-locate-'), dir = path.join(root, 'project')
  fs.mkdirSync(dir)
  const id = '11111111-2222-3333-4444-555555555555', file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, '{}\n')
  expect(await locateQoderIn(root, id)).toBe(file)
  expect(await locateQoderIn(root, '../outside')).toBeUndefined()
  if (process.platform === 'win32') return // symlink creation requires a separate Windows privilege
  fs.unlinkSync(file)
  fs.symlinkSync(path.join(root, 'outside.jsonl'), file)
  fs.writeFileSync(path.join(root, 'outside.jsonl'), '{}\n')
  expect(await locateQoderIn(root, id)).toBeUndefined()
})
it('renders native Qoder messages while ignoring hooks and runtime metadata', () => {
  expect(linesFromQoder(JSON.stringify({ type: 'user', message: { content: 'question' } }))).toEqual(['user: question'])
  expect(linesFromQoder(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }))).toEqual(['assistant: answer'])
  expect(linesFromQoder(JSON.stringify({ type: 'assistant', message: { content: 'answer' } }))).toEqual(['assistant: answer'])
  expect(linesFromQoder(JSON.stringify({ type: 'attachment', attachment: { output: 'hook instructions' } }))).toEqual([])
})
