/** Fixed family: system installations cannot replace the bundled metrics. */
export const BUNDLED_TERMINAL_FONT = '"Nodeterm Maple Mono", monospace'

const families = ['Courier Prime', 'Nodeterm Maple Mono']
type Load = { ready: boolean; promise: Promise<void> }
const loads = new WeakMap<FontFaceSet, Map<string, Load>>()
function resource(stack: string): Load | undefined {
  if (typeof document === 'undefined' || !document.fonts) return
  const selected = families.filter((family) => stack.split(',').some((part) =>
    part.trim().replace(/^['"]|['"]$/g, '').toLowerCase() === family.toLowerCase()))
  if (!selected.length) return
  let byFamily = loads.get(document.fonts)
  if (!byFamily) { byFamily = new Map(); loads.set(document.fonts, byFamily) }
  const key = selected.join(',')
  let entry = byFamily.get(key)
  if (!entry) {
    entry = { ready: false, promise: Promise.resolve() }
    const current = entry
    current.promise = Promise.all(selected.flatMap((family) => [400, 700].map(async (weight) => {
      try { await document.fonts.load(`${weight} 16px "${family}"`, 'MW中文繁體\ue0b0') }
      catch (error) { console.warn(`Bundled terminal font failed to load: ${family} ${weight}`, error) }
    }))).then(() => { current.ready = true })
    byFamily.set(key, current)
  }
  return entry
}

/** Request only faces used by this terminal. Unbundled/system stacks are immediately usable. */
export function loadTerminalFonts(stack: string): Promise<void> {
  return resource(stack)?.promise ?? Promise.resolve()
}
export function terminalFontsReady(stack: string): boolean {
  return resource(stack)?.ready ?? true
}
