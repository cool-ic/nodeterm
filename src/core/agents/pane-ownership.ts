import { DurableFactFile, type DurableFactSpec } from '../durable-state'

/**
 * The runtime pane-ownership ledger: nodeId → the project that actually SPAWNED that node's pane,
 * this process run. It exists because the persisted store cannot be trusted to answer "who owns
 * this pane?" — `.nodeterm/project.json` is git-shared and hand-editable, so a hostile/cloned
 * project can LIST any node id, including one a different project is really running. A messaging
 * grant is per project, and panes are keyed by the BARE node id globally (tmux `nt-<nodeId>`), so
 * ownership derived from the file is a confused-deputy hole: PR #237's re-review drove it end to
 * end (a granted project A delivered into ungranted project B's live pane just by listing B's id).
 *
 * THE ONE FACT THAT IS NOT FORGEABLE BY A CLONED FILE is which project's `create()` actually
 * brought the tmux session into being. That is what this records, and only that:
 *
 *  - Recorded ONLY on a GENUINE FRESH SPAWN (`PtyManager.spawnNew` with `fresh === true` — no live
 *    session existed to reattach to). An attach/co-attach to a session someone else spawned never
 *    records, so a second project that merely OPENS a node id another project is running cannot
 *    claim it. `fresh` is the manager's own signal, not anything off the wire or the file.
 *  - The owner value is the machine-local project id the renderer passed at the create call
 *    (`PtyCreateOptions.ownerProjectId`) — the entry id (`IndexEntryV3.id`), never the file's
 *    git-copied `id`. A cloned repo gets a fresh entry id, so it cannot inherit another copy's
 *    ownership either.
 *
 * ── COLD STATE / RESTART (stated honestly) ──────────────────────────────────────────────────────
 * This ledger is IN-MEMORY and starts empty every run. After an app restart the tmux SERVER
 * usually survives, so the renderer's re-open of a node ATTACHES (`fresh === false`) and records
 * nothing — the pane is then UNPROVEN and messaging to it is REFUSED (fail-closed) until the
 * session is truly respawned (or the machine reboots, killing the tmux server, after which the
 * next open is a real fresh spawn and records correctly). We do NOT repopulate on attach: there is
 * no cheap cross-restart signal a hostile agent could not also write (a tmux session-env var is
 * settable from any pane's shell), and guessing the owner on attach is exactly how the attacker
 * would re-acquire ownership by opening the victim's id first. Fail-closed is the safe direction
 * and is pinned by a test (`ownerOf` empty ⇒ the delivery gate refuses).
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────────────────────────
 * This is scoped to tmux-pane messaging ownership but is intentionally feature-neutral: S8 PR 4's
 * BrowserControlLedger and messaging PR 7's deliver-on-idle queue want the same "who really spawned
 * this node" answer and can consume `paneOwnerProject` directly. It lives in `src/core` (no
 * electron, no main import) so it ships on both shells; the opt-in Server Edition control runtime
 * now records and reads it through the same PtyManager and messaging service as desktop.
 */

/** nodeId → owning projectId (machine-local entry id), for panes freshly spawned THIS run. */
const owners = new Map<string, string>()

// ── T198: the durable half of the ledger ────────────────────────────────────────────────────────
// The in-memory map above dies with the process; a restart empties it while the tmux sessions it
// describes are still alive, and every non-opener relationship goes `unproven-target-owner`. The
// fix is NOT "record on attach" (the original sin this ledger exists to refuse) — it is to PERSIST
// the spawn-time record and RE-PROVE it on attach:
//
//   - At fresh spawn the row {nodeId, ownerEntryId} lands in a machine-local DurableFactFile.
//   - At attach (fresh === false), `reproveOnAttach` matches the claiming project's CURRENT entry
//     id against the row. Entry ids are minted by the machine-local project registry
//     (`IndexEntryV3.id`), stable across restarts, and a cloned repo always mints a NEW one — so
//     the match proves "the SAME project that spawned this pane re-opened it", which a cloned or
//     hostile project.json cannot fabricate.
//
// WHAT THIS FILE IS NOT: an anti-local-agent defense. It lives in userData, which a local agent
// can write — and a local agent that can write userData never needed it: it can `tmux -L node-
// terminal send-keys -t nt-<nodeId>` straight into any pane (verified live). The gate it feeds
// exists to keep the GIT-SHARED project.json from granting messaging on its own (PR #237); that
// is exactly what this preserves across a restart. See the honest-safety note in
// trust-recovery-design.md and the line-28 rationale above.

export interface PersistedOwnershipRow {
  nodeId: string
  /** The machine-local registry entry id of the project that spawned the pane. */
  ownerEntryId: string
  spawnedAt: number
}

function sanitizePersistedOwnershipRow(raw: unknown): PersistedOwnershipRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.nodeId !== 'string' || !r.nodeId) return null
  if (typeof r.ownerEntryId !== 'string' || !r.ownerEntryId) return null
  if (typeof r.spawnedAt !== 'number' || !Number.isFinite(r.spawnedAt)) return null
  return { nodeId: r.nodeId, ownerEntryId: r.ownerEntryId, spawnedAt: r.spawnedAt }
}

export const OWNERSHIP_FACT: DurableFactSpec<PersistedOwnershipRow> = {
  kind: 'pane-ownership',
  version: 1,
  maxRecords: 500,
  sanitize: sanitizePersistedOwnershipRow
}

let durable: DurableFactFile<PersistedOwnershipRow> | null = null
let durableRows: Map<string, PersistedOwnershipRow> | null = null

/**
 * Wire the durable half (desktop main / a Server Edition host call this once, with `<userData>`).
 * Unwired ⇒ `reproveOnAttach` is simply off and the gate behaves exactly as before — fail-closed
 * degradation, never fail-open. `debounceMs` exists for tests (default: the fact file's own).
 */
export function initOwnershipPersistence(
  userDataDir: string,
  warn?: (m: string) => void,
  debounceMs?: number
): void {
  const file = new DurableFactFile(OWNERSHIP_FACT, {
    userDataDir,
    warn,
    ...(debounceMs !== undefined ? { debounceMs } : {})
  })
  const rows = new Map<string, PersistedOwnershipRow>()
  for (const row of file.load()) rows.set(row.nodeId, row)
  durable = file
  durableRows = rows
}

/**
 * Attach-time re-proof (T198): may THIS project re-acquire messaging ownership of a pane it did
 * not freshly spawn this run? Yes only when the durable spawn record exists and its owner entry id
 * equals the claiming project's CURRENT entry id. Idempotent (re-running is a map set); anything
 * else — no row, no claim, a mismatching id — returns `false` and the gate stays closed.
 */
export function reproveOnAttach(nodeId: string, claimedProjectId: string | undefined): boolean {
  if (!durableRows || !claimedProjectId) return false
  const row = durableRows.get(nodeId)
  if (!row || row.ownerEntryId !== claimedProjectId) return false
  owners.set(nodeId, claimedProjectId)
  return true
}

/** T201 read-only view accessors: whether the durable half is wired, and who a node's durable
 *  spawn row names (or `undefined` when there is no row). No mutation surface on purpose. */
export function ownershipWired(): boolean {
  return durableRows !== null
}

export function ownershipRowOwner(nodeId: string): string | undefined {
  return durableRows?.get(nodeId)?.ownerEntryId
}

/**
 * THE FRESH-GATE, pure and pinned: may this create() record pane ownership? True ONLY for a
 * genuine fresh spawn (`fresh === true`) of a persistent node (`persistKey`) whose owner is known
 * (`ownerProjectId`). This is the load-bearing security property — recording on an ATTACH
 * (`fresh === false`) would let a project claim a pane it merely re-opened after a restart, which
 * is exactly the confused deputy this ledger closes. Extracted so the gate has its own unit test
 * (`pane-ownership.test.ts`) rather than living only inside `spawnNew`.
 */
export function shouldRecordOwnership(
  fresh: boolean,
  persistKey: string | undefined,
  ownerProjectId: string | undefined
): boolean {
  return fresh === true && !!persistKey && !!ownerProjectId
}

/**
 * Record the owner of a node whose pane was just GENUINELY spawned. Call site: `spawnNew`, guarded
 * by `fresh === true` and a present `persistKey` + `ownerProjectId`. A fresh spawn for an id that
 * somehow already has an entry OVERWRITES it — the live pane is the one that just came into being.
 * A missing owner is a no-op (old callers / tests that pass no `ownerProjectId` simply leave the
 * pane unproven, which fails closed downstream — the correct direction). T198: the record also
 * lands in the durable file so the SAME project can re-prove the pane after an app restart.
 */
export function recordFreshSpawnOwner(nodeId: string, ownerProjectId: string | undefined): void {
  if (!nodeId || !ownerProjectId) return
  owners.set(nodeId, ownerProjectId)
  if (durableRows !== null) {
    durableRows.set(nodeId, { nodeId, ownerEntryId: ownerProjectId, spawnedAt: Date.now() })
    durable?.save([...durableRows.values()])
  }
}

/** The project that provably spawned this node's pane this run, or `undefined` when unproven
 *  (never spawned here, or only ever attached — e.g. after a restart). Undefined MUST fail closed
 *  at every gate: an unprovable owner is not an absent restriction. */
export function paneOwnerProject(nodeId: string): string | undefined {
  return owners.get(nodeId)
}

/** Drop a node's ownership — its session is ending (delete or recycle). A later genuine respawn
 *  re-records; until then the id is unproven again, which fails closed. */
export function forgetPaneOwner(nodeId: string): void {
  owners.delete(nodeId)
  if (durableRows !== null) {
    durableRows.delete(nodeId)
    durable?.save([...durableRows.values()])
  }
}

/** Test seam only: wipe the ledger between cases. Never called in production. */
export function resetPaneOwnershipForTests(): void {
  owners.clear()
  durableRows = null
  durable = null
}
