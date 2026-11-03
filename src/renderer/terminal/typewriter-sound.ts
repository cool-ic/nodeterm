import { TypewriterSounds } from './nocturne/sound-engine'
/** Decorative keyboard feedback only: no terminal input/output subscriptions or text storage. */
export type Strike = 'key' | 'space' | 'return' | 'backspace'

export function strikeForKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): Strike | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null
  if (e.key === 'Enter') return 'return'
  if (e.key === 'Backspace' || e.key === 'Delete') return 'backspace'
  if (e.key === ' ') return 'space'
  return [...e.key].length === 1 ? 'key' : null
}

export function typewriterVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : 0.25
}

/** One upstream sound engine per renderer. No audio work is queued behind terminal input. */
export class TypewriterSound {
  private engine = new TypewriterSounds(['key', 'space', 'return', 'backspace'])
  private lastAt = -Infinity
  constructor() {
    if (typeof OfflineAudioContext !== 'undefined') this.engine.configure({ sound: true, volume: 0.25, voice: 'standard', variation: 0.65 })
  }
  play(kind: Strike, volume: number): void {
    if (volume <= 0 || typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined') return
    const now = performance.now()
    if (now - this.lastAt < 28) return
    this.lastAt = now
    try {
      this.engine.configure({ sound: true, volume: Math.max(0, Math.min(1, volume)), voice: 'standard', variation: 0.65 })
      this.engine.play(kind)
    } catch { /* Audio is optional, input is not. */ }
  }
  close(): void { this.engine.close() }
  dispose(): void { this.engine.dispose() }
}

export function installTypewriterSound(doc: Document, play: (kind: Strike) => void): () => void {
  const isTerminal = (target: EventTarget | null): target is HTMLTextAreaElement =>
    target instanceof HTMLTextAreaElement && target.matches('.xterm-helper-textarea') &&
    doc.activeElement === target && !target.closest('.settings-term-preview') &&
    !target.closest('[inert], [aria-hidden="true"]') && doc.visibilityState === 'visible' && doc.hasFocus()
  const key = (e: KeyboardEvent) => {
    if (!e.isTrusted || !isTerminal(e.target)) return
    const kind = strikeForKey(e)
    if (kind) play(kind)
  }
  const commit = (e: CompositionEvent) => {
    if (e.isTrusted && e.data && isTerminal(e.target)) play('key')
  }
  doc.addEventListener('keydown', key, { capture: true, passive: true })
  doc.addEventListener('compositionend', commit, { capture: true, passive: true })
  return () => {
    doc.removeEventListener('keydown', key, true)
    doc.removeEventListener('compositionend', commit, true)
  }
}
