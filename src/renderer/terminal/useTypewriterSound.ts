import { useEffect, useRef } from 'react'
import { useSettings } from '../state/settings'
import { installTypewriterSound, TypewriterSound, typewriterVolume } from './typewriter-sound'

/** Mount once at App, so many terminals never multiply listeners or audio contexts. */
export function useTypewriterSound(): void {
  const enabled = useSettings((s) => s.settings.terminalTypewriterSound)
  const volume = useSettings((s) => s.settings.terminalTypewriterVolume)
  const currentVolume = useRef(typewriterVolume(volume))
  currentVolume.current = typewriterVolume(volume)
  const active = enabled === true && currentVolume.current > 0
  useEffect(() => {
    if (!active) return
    const sound = new TypewriterSound()
    const remove = installTypewriterSound(document, (kind) => sound.play(kind, currentVolume.current))
    const stop = () => { if (document.hidden) sound.close() }
    const blur = () => sound.close()
    document.addEventListener('visibilitychange', stop)
    window.addEventListener('blur', blur)
    return () => { remove(); document.removeEventListener('visibilitychange', stop); window.removeEventListener('blur', blur); sound.dispose() }
  }, [active])
}
