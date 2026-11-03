/** Layout evidence only: native lifecycle and process identity must independently permit a wake.
 * Supports the measured legacy footer and the 1.1.81 Fast/capacity footer from issue #1.
 * Do not search arbitrary transcript lines for a placeholder: inspect the complete bottom frame. */
export function qoderComposerState(text: string | null): 'empty' | 'missing' | 'structure-unknown' | 'not-empty' | 'footer-unknown' {
  if (!text) return 'missing'
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').trimEnd().split('\n')
  const tail = lines.slice(-4).map((line) => line.trim())
  if (tail.length !== 4 || !/^[─━-]{8,}$/.test(tail[0]) || !/^[─━-]{8,}$/.test(tail[2])) return 'structure-unknown'
  if (!/^[>*]\s+Type your message or @path\/to\/file$/.test(tail[1])) return 'not-empty'
  const legacy = /^.+ Model\s*·\s*ctx\s+[^·]+(?:·\s*.+)?$/
  const fast = /^Fast\s*·\s*\d+(?:\.\d+)?[KM]\s*·\s*ctx\s+[^·]+(?:·\s*.+)?$/
  return legacy.test(tail[3]) || fast.test(tail[3]) ? 'empty' : 'footer-unknown'
}

export function qoderEmptyComposer(text: string | null): boolean {
  return qoderComposerState(text) === 'empty'
}

/** No writes and no synthetic turn-end hook; require three identical visible frames. */
export async function qoderComposerSettled(
  capture: () => Promise<string | null>,
  wait: (ms: number) => Promise<void>,
  stillStarting: () => boolean
): Promise<boolean> {
  let previous = ''
  let stable = 0
  for (let i = 0; i < 20; i++) {
    if (!stillStarting()) return false
    const frame = await capture()
    if (!stillStarting()) return false
    if (!qoderEmptyComposer(frame)) return false
    const normalized = frame!.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trimEnd()
    stable = normalized === previous ? stable + 1 : 1
    previous = normalized
    if (stable >= 3) return true
    await wait(100)
  }
  return false
}
