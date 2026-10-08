import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// T224: the macOS Dock badge counts every `unread` entry in this table, and the table outlives
// restarts (localStorage). Unread is cleared ONLY by selecting a node, so an entry whose node no
// longer exists in ANY project canvas shows a badge forever that no gesture can clear — the
// employer's stuck "3". `pruneMissingNodes` is the one place such entries go away, and it may only
// ever drop PROVEN absence: an empty list and an unreadable one both mean "keep everything".

function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

const KEY = 'nodeterm.agentStatus'
const CLOCK_KEY = 'nodeterm.agentStatus.lastSeen'

/** The Dock badge's number, derived exactly as Canvas derives it. */
const badge = (byId: Record<string, { unread?: boolean } | undefined>): number =>
  Object.values(byId).filter((st) => st?.unread).length

async function boot(storage: Storage): Promise<typeof import('./agentStatus')> {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  return import('./agentStatus')
}

const seeded = (main: Record<string, unknown>, clocks?: Record<string, unknown>): Storage =>
  memStorage({
    [KEY]: JSON.stringify(main),
    ...(clocks ? { [CLOCK_KEY]: JSON.stringify(clocks) } : {})
  })

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('pruneMissingNodes', () => {
  it('drops the dead ids, keeps the live ones unread flags included, and writes the table back', async () => {
    const storage = seeded({
      'dead-1': { unread: true },
      'dead-2': { unread: true },
      'dead-3': { unread: true },
      'live-1': { unread: true },
      'live-2': { unread: false }
    })
    const mod = await boot(storage)
    expect(badge(mod.useAgentStatus.getState().byId)).toBe(4)

    expect(mod.useAgentStatus.getState().pruneMissingNodes(['live-1', 'live-2'])).toEqual([
      'dead-1',
      'dead-2',
      'dead-3'
    ])

    const after = mod.useAgentStatus.getState()
    expect(badge(after.byId)).toBe(1)
    expect(Object.keys(after.byId).sort()).toEqual(['live-1', 'live-2'])
    expect(after.byId['live-1'].unread).toBe(true)
    expect(Object.hasOwn(after.byId, 'dead-1')).toBe(false)
    // On disk too, or the next restart restores exactly what was just pruned. `live-2` has nothing
    // durable (no unread, no session) and was never in the durable form — unchanged by this.
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual({ 'live-1': { unread: true } })
  })

  it('keeps a node whose project is CLOSED: the id only has to exist in SOME project canvas', async () => {
    const storage = seeded({ 'closed-node': { unread: true } })
    const mod = await boot(storage)
    // Main's union scans every project canvas — recently closed ones included — so a node of a
    // closed project (its tmux session may still be running) is IN this list while it is in no way
    // in the canvas that is open right now. The original cross-project intent depends on this.
    expect(mod.useAgentStatus.getState().pruneMissingNodes(['closed-node', 'open-node'])).toEqual([])
    expect(mod.useAgentStatus.getState().byId['closed-node'].unread).toBe(true)
  })

  it('touches nothing when the project list could not be read', async () => {
    const storage = seeded({ 'dead-1': { unread: true }, 'live-1': { unread: true } })
    const mod = await boot(storage)
    // `undefined` (the index is not loaded, a local ref could not be read, an SSH project was never
    // cached) and the EMPTY list both mean "cannot tell". Treating the empty answer as availability
    // would delete the whole table — every live node's unread flag with it.
    expect(mod.useAgentStatus.getState().pruneMissingNodes(undefined)).toEqual([])
    expect(mod.useAgentStatus.getState().pruneMissingNodes([])).toEqual([])
    expect(Object.keys(mod.useAgentStatus.getState().byId).sort()).toEqual(['dead-1', 'live-1'])
    expect(badge(mod.useAgentStatus.getState().byId)).toBe(2)
  })

  it('touches nothing when reading the list throws part-way', async () => {
    const storage = seeded({ 'dead-1': { unread: true }, 'live-1': { unread: true } })
    const mod = await boot(storage)
    function* halves(): Generator<string> {
      yield 'live-1'
      throw new Error('index unavailable')
    }
    expect(() => mod.useAgentStatus.getState().pruneMissingNodes(halves())).toThrow('index unavailable')
    expect(Object.keys(mod.useAgentStatus.getState().byId).sort()).toEqual(['dead-1', 'live-1'])
  })

  it('drops the pruned ids’ lastSeen clocks, so a dead id leaves nothing behind on disk', async () => {
    const at = Date.now() - 1000
    const storage = seeded(
      { dead: { unread: true }, live: { unread: true } },
      { dead: { at, state: 'done' }, live: { at, state: 'done' } }
    )
    const mod = await boot(storage)
    expect(mod.useAgentStatus.getState().pruneMissingNodes(['live'])).toEqual(['dead'])
    expect(JSON.parse(storage.getItem(CLOCK_KEY)!)).toEqual({ live: { at, state: 'done' } })
  })

  it('is a no-op when every entry is still held by some canvas', async () => {
    const storage = seeded({ a: { unread: true }, b: { unread: true } })
    const mod = await boot(storage)
    const before = mod.useAgentStatus.getState()
    expect(mod.useAgentStatus.getState().pruneMissingNodes(['a', 'b'])).toEqual([])
    // Same state object: no re-render, no save — this runs on every workspace push.
    expect(mod.useAgentStatus.getState()).toBe(before)
  })
})
