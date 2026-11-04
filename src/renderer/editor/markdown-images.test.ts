// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markdownImageTarget, prepareMarkdownImages } from './markdown-images'

it('resolves local images relative to the document, including spaces, Unicode and file URLs', () => {
  for (const [src, expected] of [
    ['./assets/a.png', '/notes/assets/a.png'],
    ['../图片/图%201.png?raw=1#x', '/图片/图 1.png'],
    ['/tmp/a.png', '/tmp/a.png'],
    ['file:///Users/f/a%20b.png', '/Users/f/a b.png'],
    ['~/Pictures/a.png', '~/Pictures/a.png']
  ]) expect(markdownImageTarget(src, '/notes/中文.md')).toMatchObject({ kind: 'local', path: expected, mime: 'image/png' })
})
it('uses the document path’s Windows dialect, not the browser OS', () => {
  expect(markdownImageTarget('assets\\a.png', 'C:\\notes\\doc.md')).toMatchObject({ path: 'C:/notes/assets/a.png' })
  expect(markdownImageTarget('D:\\images\\a.png', 'C:\\notes\\doc.md')).toMatchObject({ path: 'D:/images/a.png' })
  expect(markdownImageTarget('/images/a.png', 'C:\\notes\\doc.md')).toMatchObject({ path: 'C:/images/a.png' })
})
it('accepts network/data images but rejects unsupported protocols and non-image local files', () => {
  expect(markdownImageTarget('https://images.example/id?width=100', '/a.md')).toEqual({ kind: 'web', src: 'https://images.example/id?width=100' })
  expect(markdownImageTarget('//images.example/a.png', '/a.md')).toMatchObject({ kind: 'web', src: 'https://images.example/a.png' })
  expect(markdownImageTarget('data:image/png;base64,YQ==', '/a.md')?.kind).toBe('web')
  for (const src of ['javascript:alert(1)', 'data:text/html;base64,YQ==', './secrets.txt', '/tmp/a%00.png', 'blob:https://other/123']) {
    expect(markdownImageTarget(src, '/a.md'), src).toBeNull()
  }
})
it('replaces file URLs before final sanitization, removes active HTML and leaves no premature local request', () => {
  const result = prepareMarkdownImages('![local](file:///tmp/a%20b.png)\n\n<img src="./x.svg" onerror="alert(1)" srcset="./evil.png 2x"><script>alert(1)</script>', '/notes/a.md')
  expect(result.images.map(i => i.path)).toEqual(['/tmp/a b.png', '/notes/x.svg'])
  expect(result.html).not.toMatch(/onerror|<script|srcset|file:\/\/\//)
  const doc = new DOMParser().parseFromString(result.html, 'text/html')
  expect([...doc.querySelectorAll('img')].every(i => !i.hasAttribute('src'))).toBe(true)
  expect(doc.querySelectorAll('img[data-markdown-image]')).toHaveLength(2)
})
it('keeps image links clickable through checked references, without trusting document-supplied ids', () => {
  const result = prepareMarkdownImages('[image](file:///tmp/a.png)\n\n<a href="https://example.com" data-markdown-image-link="0">web</a>', '/notes/a.md')
  expect(result.links).toEqual(['/tmp/a.png'])
  const doc = new DOMParser().parseFromString(result.html, 'text/html')
  expect(doc.querySelectorAll('[data-markdown-image-link]')).toHaveLength(1)
  expect(doc.querySelector('a')!.getAttribute('href')).toBe('#')
})
it('permits HTTP(S) image loading while keeping scripts on the original self-only policy', () => {
  const html = readFileSync(join(__dirname, '../index.html'), 'utf8')
  const policy = html.match(/content="([^"]*default-src[^\"]*)"/)![1]
  const img = policy.match(/img-src ([^;]+)/)![1]
  expect(img).toContain('https:'); expect(img).toContain('http:')
  expect(policy).toContain("script-src 'self';")
  expect(policy).toContain("default-src 'self';")
})
