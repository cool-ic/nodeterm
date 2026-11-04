import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { localImageMime } from '../lib/localFilePreview'

export type MarkdownImageTarget = { kind: 'web'; src: string } | { kind: 'local'; path: string; mime: string }

/** Resolve on the document's filesystem, never against the app URL or the viewer's OS/cwd. */
export function markdownImageTarget(raw: string, documentPath: string): MarkdownImageTarget | null {
  const src = raw.trim()
  if (!src || /[\u0000-\u001f]/.test(src)) return null
  if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
    try {
      const url = new URL(src.startsWith('//') ? `https:${src}` : src)
      return { kind: 'web', src: url.href }
    } catch { return null }
  }
  if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon)[;,]/i.test(src)) return { kind: 'web', src }
  const windows = /^[a-z]:[\\/]/i.test(documentPath) || documentPath.startsWith('\\\\')
  if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^file:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null
  let path: string
  try {
    if (src.startsWith('~/')) path = decodeURIComponent(src.split(/[?#]/)[0])
    else {
      const doc = windows ? documentPath.replace(/\\/g, '/') : documentPath
      if (!doc.startsWith('/') && !/^[a-z]:\//i.test(doc)) return null
      const encoded = doc.split('/').map(encodeURIComponent).join('/').replace(/^([a-z])%3A/i, '$1:')
      const base = new URL(`file://${doc.startsWith('/') ? '' : '/'}${encoded}`)
      const ref = windows ? src.replace(/\\/g, '/') : src
      const url = new URL(windows && /^[a-z]:\//i.test(ref) ? `file:///${ref}` : ref, base)
      if (url.protocol !== 'file:') return null
      path = decodeURIComponent(url.pathname)
      if (windows && /^\/[a-z]:\//i.test(path)) path = path.slice(1)
      if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`
    }
  } catch { return null }
  if (/[\u0000-\u001f]/.test(path)) return null
  const mime = localImageMime(path)
  return mime ? { kind: 'local', path, mime } : null
}

export interface LocalMarkdownImage { id: string; path: string; mime: string }
export function prepareMarkdownImages(text: string, documentPath: string): { html: string; images: LocalMarkdownImage[]; links: string[] } {
  // A template is inert: resolve/remove image URLs before attaching anything to the live DOM.
  // Sanitize the FINAL HTML, after replacing file: URLs (which DOMPurify normally removes).
  const template = document.createElement('template')
  template.innerHTML = marked.parse(text || '', { async: false, breaks: false }) as string
  const doc = template.content
  const images: LocalMarkdownImage[] = []
  const links: string[] = []
  // Use one checked src, including for raw HTML <picture>/<img>. No unhandled local srcset URLs.
  for (const source of doc.querySelectorAll('source[srcset]')) source.removeAttribute('srcset')
  for (const img of doc.querySelectorAll('img')) {
    const raw = img.getAttribute('src') ?? ''
    const target = markdownImageTarget(raw, documentPath)
    img.removeAttribute('srcset')
    img.setAttribute('loading', 'lazy')
    img.setAttribute('decoding', 'async')
    img.setAttribute('referrerpolicy', 'no-referrer')
    // Allocate our own identity after sanitization; a document cannot impersonate another image.
    img.removeAttribute('data-markdown-image')
    if (target?.kind === 'web') img.setAttribute('src', target.src)
    else {
      img.removeAttribute('src')
      const id = String(images.length)
      img.setAttribute('data-markdown-image', id)
      images.push({ id, path: target?.kind === 'local' ? target.path : '', mime: target?.kind === 'local' ? target.mime : '' })
    }
  }
  for (const anchor of doc.querySelectorAll('a')) {
    anchor.removeAttribute('data-markdown-image-link')
    const target = markdownImageTarget(anchor.getAttribute('href') ?? '', documentPath)
    if (target?.kind === 'local') {
      anchor.setAttribute('data-markdown-image-link', String(links.length))
      anchor.setAttribute('href', '#')
      links.push(target.path)
    }
  }
  return { html: DOMPurify.sanitize(template.innerHTML), images, links }
}
