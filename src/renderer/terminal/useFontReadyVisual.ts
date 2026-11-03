import { useEffect, useMemo, useState } from 'react'
import { loadTerminalFonts, terminalFontsReady } from './paper-fonts'

/** Keep the last measured family during a live switch; never tear down its PTY to load a font. */
export function useFontReadyVisual<T extends { fontFamily: string }>(requested: T): { visual: T; fontsReady: boolean } {
  const family = requested.fontFamily
  const [lastReady, setLastReady] = useState<string | null>(() => terminalFontsReady(family) ? family : null)
  useEffect(() => {
    let cancelled = false
    void loadTerminalFonts(family).then(() => { if (!cancelled) setLastReady(family) })
    return () => { cancelled = true }
  }, [family])
  const usable = terminalFontsReady(family) ? family : lastReady
  const visual = useMemo(() => usable === null || usable === family
    ? requested : { ...requested, fontFamily: usable }, [requested, family, usable])
  return { visual, fontsReady: usable !== null }
}
