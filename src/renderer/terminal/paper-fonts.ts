/** Fixed bundled family: no local() source, so system installations cannot change its metrics. */
export const BUNDLED_TERMINAL_FONT = '"Nodeterm Maple Mono", monospace'

/** Boot waits for the actual bundled faces before xterm's first grid measurement. */
export async function loadPaperFonts(): Promise<void> {
  if (!document.fonts) return
  await Promise.all(['Courier Prime', 'Nodeterm Maple Mono'].flatMap((family) =>
    [400, 700].map(async (weight) => {
      try { await document.fonts.load(`${weight} 16px "${family}"`, 'MW中文繁體\ue0b0') }
      catch (error) { console.warn(`Bundled terminal font failed to load: ${family} ${weight}`, error) }
    })
  ))
}
