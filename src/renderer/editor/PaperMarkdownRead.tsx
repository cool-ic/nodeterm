import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import type { FsApi } from '@shared/types'
import { tooLargeSize } from '@shared/fsLimits'
import { prepareMarkdownImages, type LocalMarkdownImage } from './markdown-images'

interface Props {
  text: string
  filePath: string
  fs: FsApi
  openImage: (path: string) => void
}

/** The same routed fs as the document (local, SSH, relay/server); no nt-media/local-machine guess. */
export function PaperMarkdownRead({ text, filePath, fs, openImage }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const prepared = useMemo(() => prepareMarkdownImages(text, filePath), [text, filePath])
  useEffect(() => {
    const root = host.current
    if (!root) return
    let live = true, next = 0, retained = 0
    const cache = new Map<string, Promise<{ src: string } | { error: string }>>()
    const failures = new Map<HTMLImageElement, EventListener>()
    const fail = (img: HTMLImageElement, reason: string) => {
      if (!live) return
      const label = document.createElement('span')
      label.className = 'paper-markdown__image-error'
      label.setAttribute('role', 'img')
      label.setAttribute('aria-label', `${img.alt || 'Image'}: ${reason}`)
      label.textContent = `[${img.alt || 'Image'} — ${reason}]`
      img.replaceWith(label)
    }
    for (const img of root.querySelectorAll('img')) {
      const listener: EventListener = () => fail(img, 'couldn’t load image')
      img.addEventListener('error', listener, { once: true })
      failures.set(img, listener)
      if (img.complete && img.getAttribute('src') && img.naturalWidth === 0) fail(img, 'couldn’t load image')
    }
    const load = (item: LocalMarkdownImage): Promise<{ src: string } | { error: string }> => {
      const existing = cache.get(item.path)
      if (existing) return existing
      const pending: Promise<{ src: string } | { error: string }> = (async () => {
        try {
          const b64 = await fs.readBinary(item.path)
          if (!live) return { error: 'view closed' }
          if (!b64 || tooLargeSize(b64) !== null) return { error: b64 ? 'image too large' : 'file not found or unreadable' }
          if (retained + b64.length > 48 * 1024 * 1024) return { error: 'preview image limit reached' }
          retained += b64.length
          return { src: `data:${item.mime};base64,${b64}` }
        } catch { return { error: 'couldn’t read image' } }
      })()
      cache.set(item.path, pending)
      return pending
    }
    // Bound work/memory per reading view. Two readers share the existing per-file IPC size cap;
    // data URLs reuse the image-node path and disappear with the view, with no global cache.
    const worker = async () => {
      while (live && next < prepared.images.length) {
        const index = next++, item = prepared.images[index]
        const img = root.querySelector<HTMLImageElement>(`img[data-markdown-image="${item.id}"]`)
        if (!img) continue
        if (!item.path) { fail(img, 'unsupported image address'); continue }
        if (!cache.has(item.path) && (cache.size >= 64 || retained >= 48 * 1024 * 1024)) { fail(img, 'preview image limit reached'); continue }
        const result = await load(item)
        if (!live) return
        if ('src' in result) img.src = result.src
        else fail(img, result.error)
      }
    }
    void worker(); void worker()
    return () => { live = false; cache.clear(); for (const [img, listener] of failures) img.removeEventListener('error', listener) }
  }, [prepared, fs])
  const imageLink = (e: MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    if (!(e.target instanceof Element)) return
    const anchor = e.target.closest<HTMLAnchorElement>('a[data-markdown-image-link]')
    const id = anchor?.getAttribute('data-markdown-image-link')
    const path = id != null ? prepared.links[Number(id)] : undefined
    if (!path) return
    e.preventDefault(); e.stopPropagation(); openImage(path)
  }
  return <div ref={host} className="paper-markdown__prose" onClick={imageLink} onAuxClick={imageLink}
    dangerouslySetInnerHTML={{ __html: prepared.html }} />
}
