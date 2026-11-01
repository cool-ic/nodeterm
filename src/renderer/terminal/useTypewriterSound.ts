import { useEffect } from 'react'
import { useSettings } from '../state/settings'
import { installTypewriterSound, TypewriterSound, typewriterVolume } from './typewriter-sound'

/** Mount once at App, so many terminals never multiply listeners or audio contexts. */
export function useTypewriterSound(): void {
  const enabled = useSettings((s) => s.settings.terminalTypewriterSound)
  const volume = useSettings((s) => s.settings.terminalTypewriterVolume)
  useEffect(() => {
    if (enabled !== true || typewriterVolume(volume) === 0) return
    const sound = new TypewriterSound()
    const remove = installTypewriterSound(document, (kind) => sound.play(kind, typewriterVolume(volume)))
    const stop = () => { if (document.hidden) sound.dispose() }
    const blur = () => sound.dispose()
    document.addEventListener('visibilitychange', stop)
    window.addEventListener('blur', blur)
    return () => { remove(); document.removeEventListener('visibilitychange', stop); window.removeEventListener('blur', blur); sound.dispose() }
  }, [enabled, volume])
}
