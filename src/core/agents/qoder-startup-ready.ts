/** Measured Qoder 1.1.68 empty composer. Unknown layouts deliberately fail closed.
 * This is only useful AFTER a verified SessionStart with no subsequent state;
 * an idle-looking screen during a turn is never permission to send a message. */
export function qoderEmptyComposer(text: string | null): boolean {
  if (!text) return false
  const lines = text.replace(/\r/g, '').trimEnd().split('\n')
  const tail = lines.slice(-4).map((line) => line.trim())
  return tail.length === 4 &&
    /^[─━-]{8,}$/.test(tail[0]) &&
    /^>\s+Type your message or @path\/to\/file$/.test(tail[1]) &&
    /^[─━-]{8,}$/.test(tail[2]) &&
    /^.+ Model\s*·\s*ctx\s+.+\s*·\s*.+$/.test(tail[3])
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
