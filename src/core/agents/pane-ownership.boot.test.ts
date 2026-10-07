import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import { derivedProjectId } from '../../shared/project-id'
import { testTmpDir } from '../test-tmp'
import {
  fileToProject,
  splitWorkspace,
  serializeProjectFile,
  type IndexEntryV3
} from '../workspace-files'
import {
  initOwnershipPersistence,
  paneOwnerProject,
  recordFreshSpawnOwner,
  reproveOnAttach,
  resetPaneOwnershipForTests
} from './pane-ownership'
import type { Project } from '../../shared/types'

/**
 * T198 boot test — THE GATE THE WHOLE DESIGN STANDS ON. The attach-time re-proof trusts that:
 *
 *   1. a project's machine-local entry id is STABLE across app restarts (it is data on disk in
 *      `workspace.json`, re-read on boot; the derived ids are deterministic in their inputs), and
 *   2. a CLONE of the repo — the same shared `project.json` content adopted from another folder —
 *      ends up with a DIFFERENT entry id (the seed is the folder; the shared file carries no
 *      identity), so the durable spawn row cannot match for it.
 *
 * If (1) broke, every restart would un-prove every surviving node again — the bug this design
 * fixes. If (2) broke, a clone could re-prove another project's pane — the PR #237 confused deputy
 * returns. Either failure blocks the feature. Part 3 pins the ownership half across a simulated
 * restart: persist in boot 1, re-prove in boot 2, refuse the clone, refuse the unwired host.
 */

const project: Project = {
  id: 'proj-alpha-1a2b',
  name: 'alpha-repo',
  color: '#4a7ddd',
  cwd: '/Users/someone/code/alpha',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: []
}

function boot1(p: Project): { dir: string; entry: IndexEntryV3; fileJson: string } {
  const ws = { version: 2, activeProjectId: p.id, projects: [p] } as never as Parameters<
    typeof splitWorkspace
  >[0]
  const { index, files } = splitWorkspace(ws, () => 1, new Date(0).toISOString())
  const entry = JSON.parse(JSON.stringify(index.entries[0])) as IndexEntryV3
  const dir = testTmpDir('nodeterm-boot1-')
  // The app persists the index at <userData>/workspace.json; boot 2 reads it back from DISK.
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify(index), 'utf-8')
  const shared = files.get(p.cwd!)!
  const fileJson = serializeProjectFile(shared)
  writeFileSync(join(dir, 'project.json'), fileJson, 'utf-8')
  return { dir, entry, fileJson }
}

function boot2(dir: string): { entry: IndexEntryV3; loadedId: string } {
  // A fresh process reads the index from disk and re-derives the project — with the id coming
  // from the ENTRY (machine-local), never from the shared file's own id field.
  const index = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf-8')) as {
    entries: IndexEntryV3[]
  }
  const entry = index.entries[0]
  const file = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8')) as never
  const loaded = fileToProject(file, { id: entry.id, cwd: entry.cwd })
  return { entry, loadedId: loaded.id }
}

describe('T198 boot gate — entry id survives a restart, a clone cannot match it', () => {
  it('boot 2 reads the SAME entry id boot 1 wrote', () => {
    const { dir, entry } = boot1(project)
    const { entry: reread, loadedId } = boot2(dir)
    expect(reread.id).toBe(entry.id)
    // The project's identity comes from the machine-local ENTRY, never the shared file.
    expect(loadedId).toBe(entry.id)
  })

  it('the derived id is deterministic in its inputs — same folder, same id, every boot', () => {
    const seed = project.cwd!
    const a = derivedProjectId(project.id, seed, () => false)
    const b = derivedProjectId(project.id, seed, () => false)
    expect(a).toBe(b)
  })

  it('a CLONE (same shared file, different folder) lands on a different entry id', () => {
    const cloneSeed = '/Users/someone/code/alpha-clone'
    const cloneId = derivedProjectId(project.id, cloneSeed, () => false)
    expect(cloneId).not.toBe(project.id)
  })
})

describe('T198 ownership re-proof across a simulated restart', () => {
  beforeEach(() => resetPaneOwnershipForTests())

  it('boot 1 persists the spawn row; boot 2 re-proves the SAME project and refuses a clone', async () => {
    // ── boot 1: fresh spawn records in-memory AND durably ──
    const dir = testTmpDir('nodeterm-t198-')
    initOwnershipPersistence(dir, undefined, 1)
    recordFreshSpawnOwner('term-x', 'proj-alpha-1a2b')
    expect(paneOwnerProject('term-x')).toBe('proj-alpha-1a2b')
    await new Promise((r) => setTimeout(r, 20)) // let the coalesced save hit disk

    // ── boot 2: a fresh host loads the durable file; the map above is gone ──
    resetPaneOwnershipForTests()
    initOwnershipPersistence(dir, undefined, 1)
    expect(paneOwnerProject('term-x')).toBeUndefined() // the restart really did empty the ledger

    // The same project re-attaches its own pane: re-proven, reach restored.
    expect(reproveOnAttach('term-x', 'proj-alpha-1a2b')).toBe(true)
    expect(paneOwnerProject('term-x')).toBe('proj-alpha-1a2b')
    // Idempotent: re-proving again changes nothing.
    expect(reproveOnAttach('term-x', 'proj-alpha-1a2b')).toBe(true)
  })

  it('a CLONE claiming the pane is refused — the gate behaves exactly as before the feature', async () => {
    const dir = testTmpDir('nodeterm-t198-clone-')
    initOwnershipPersistence(dir, undefined, 1)
    recordFreshSpawnOwner('term-x', 'proj-alpha-1a2b')
    await new Promise((r) => setTimeout(r, 20))

    resetPaneOwnershipForTests()
    initOwnershipPersistence(dir, undefined, 1)
    // The clone's entry id differs (pinned above) — re-proof fails, the ledger stays empty, and
    // `paneOwnerProject` returning undefined is what makes every delivery gate refuse: byte for
    // byte the pre-T198 behavior.
    expect(reproveOnAttach('term-x', 'proj-alpha-clone-9f3e')).toBe(false)
    expect(paneOwnerProject('term-x')).toBeUndefined()
  })

  it('no durable row (never spawned on this machine) fails closed', () => {
    const dir = testTmpDir('nodeterm-t198-empty-')
    initOwnershipPersistence(dir, undefined, 1)
    expect(reproveOnAttach('term-unknown', 'proj-alpha-1a2b')).toBe(false)
    expect(paneOwnerProject('term-unknown')).toBeUndefined()
  })

  it('an UNWIRED host (no durable file) fails closed — the feature degrades, never opens', () => {
    resetPaneOwnershipForTests()
    expect(reproveOnAttach('term-x', 'proj-alpha-1a2b')).toBe(false)
    expect(paneOwnerProject('term-x')).toBeUndefined()
  })
})
