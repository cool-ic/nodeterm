// T234's desktop wiring, pinned at source level for the same reason the station monitor's is: every
// piece here is a call a shell can leave out and still compile.
//
//  - `shellTearingDown` is what makes a failed write during the app's OWN quit window read as a hold
//    rather than as "the target died". Unwired, the delivery falls back to the session probe — and
//    in the field incident the drop happened in the same minute as a restart, which is precisely
//    the window the flag exists to name.
//  - `unflushedSenderNotice` is the in-band leg. Without it, a queued `send` whose entry ends
//    unwritten reaches the sender's board log and nowhere else, which is how the T233 dispatch went
//    unnoticed for half an hour.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const MAIN = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The body of a `const <name> = (…) => { … }` declaration, up to its closing line. */
function arrowBody(decl: string, indent = '  '): string {
  const start = MAIN.indexOf(decl)
  expect(start, `${decl} not found — this guard is looking at the wrong file`).toBeGreaterThan(-1)
  const end = MAIN.indexOf(`\n${indent}}`, start)
  expect(end).toBeGreaterThan(start)
  return MAIN.slice(start, end)
}

describe('T234 wiring in main', () => {
  it('tells the delivery layer when THIS process is quitting', () => {
    expect(arrowBody('const messagingDeps: AgentMessagingDeps = {')).toContain(
      'shellTearingDown: () => quitting'
    )
    // …and that flag is the before-quit one, not a fresh variable that nothing sets.
    expect(MAIN).toContain("app.on('before-quit'")
    expect(MAIN).toContain('quitting = true')
  })

  it('hands an unwritten queued message to its SENDER in band, over the notice route', () => {
    const hook = arrowBody('messagingDeps.onQueuedResult = (req, outcome) => {')
    expect(hook).toContain('unflushedSenderNotice(req, outcome')
    expect(hook).toContain('if (notice)')
    // The same reversed station-notice route the expiry dead letter rides (T185/T198): from the
    // unreachable target to the sender, through every gate a message takes.
    expect(hook).toContain('deliverFromControl({ verb: STATION_NOTICE_VERB, ...notice }, messagingDeps)')
    // The sender's owning project is resolved from MAIN's canvases, never from the renderer.
    expect(hook).toContain('workspaceStore.persistedCanvases()')
  })
})
