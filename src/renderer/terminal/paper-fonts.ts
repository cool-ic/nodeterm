/** Measure xterm only after the bundled face is available; a missing font cannot stall boot. */
export async function loadPaperFonts(): Promise<void> {
  if (!document.fonts) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all([400, 700].map((w) => document.fonts.load(`${w} 16px "Courier Prime"`).catch(() => []))),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 800) })
  ])
  clearTimeout(timer)
}
