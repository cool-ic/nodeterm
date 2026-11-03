import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
const main = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
it('uses indexed ownership in both native registration and recovery', () => {
  const recovery = main.slice(main.indexOf('const recoverIm='), main.indexOf('const imCommand ='))
  expect(recovery).toContain('workspaceStore.projectIdsForNode(row.node).includes(row.project)')
  expect(recovery).not.toContain('persistedCanvases')
  const start = main.indexOf('if (enriched.verified && enriched.sessionId)')
  const events = main.slice(start, main.indexOf('// T228:', start))
  expect(events).toContain('workspaceStore.projectIdsForNode(enriched.nodeId)[0]')
  expect(events).toContain("imOwnerProofs.refresh(identity,enriched.kind==='session' && enriched.sessionPhase==='start')")
  expect(events).toContain("enriched.sessionPhase==='end') imOwnerProofs.forget(identity.node)")
})
it('retains safe wake checks and disposes the bounded scheduler on quit', () => {
  expect(main).toContain('new ImWakeScheduler(')
  expect(main).toContain('imScheduler.dispose();imWakeOutputRetry.dispose();imRuntime.close()')
  expect(main).toContain('mirrorEntry(identity.node)?.sessionId===identity.session) && ready()')
  expect(main).toContain('imSweeping){imAgain=true;return}')
})
