/**
 * T201 — the read-only trust view's reasoning, as ONE pure function.
 *
 * The view answers, per surviving agent node: can the runtime ownership ledger vouch for this
 * pane THIS run, and when it cannot, why. It is deliberately read-only — a trust view that could
 * GRANT trust would be the vouch-button T198's design rejected. The reasons are ordered by what
 * they mean for reach:
 *
 *   - `proven`            — the ledger names this project; delivery gates behave normally.
 *   - `session-gone`      — no live tmux session: nothing to deliver to (and a respawn will
 *                           re-record ownership as a fresh spawn anyway).
 *   - `no-durable-row`    — attach-restored, and no spawn record exists on this machine: the
 *                           pre-T198 world; only the opener exceptions reach it.
 *   - `entry-id-mismatch` — a durable row exists but names ANOTHER project's registry entry: the
 *                           PR #237 confused-deputy case, refused by design.
 *   - `reproof-pending`   — the row matches this project, but the ledger is still empty: the pane
 *                           attached before the durable file was wired, or before T198. The NEXT
 *                           re-open of the project (a fresh attach) re-proves it; nothing to do.
 *   - `ownership-unwired` — the host never wired the durable half at all (e.g. a Server Edition
 *                           host that has not adopted T198): today's fail-closed behavior.
 */

export type TrustReason =
  | 'proven'
  | 'session-gone'
  | 'no-durable-row'
  | 'entry-id-mismatch'
  | 'reproof-pending'
  | 'ownership-unwired'

export function trustReason(input: {
  live: boolean
  proven: boolean
  wired: boolean
  /** The durable spawn row's owner entry id for this node, when one exists. */
  rowOwner: string | undefined
  /** The viewing project's machine-local registry entry id. */
  entryId: string
}): TrustReason {
  if (!input.live) return 'session-gone'
  if (input.proven) return 'proven'
  if (!input.wired) return 'ownership-unwired'
  if (!input.rowOwner) return 'no-durable-row'
  if (input.rowOwner !== input.entryId) return 'entry-id-mismatch'
  return 'reproof-pending'
}

/**
 * T204: do ALL of these targets pass the delivery gate's ownership check? A target absent from
 * the snapshot (another project's pane, or a plain terminal) is NOT proven — the dialog stays for
 * it. One missing row refuses the whole set: partial auto-approval would split a multi-target
 * action between asked and unasked.
 */
export function targetsProven(
  rows: readonly { nodeId: string; proven: boolean }[],
  targetIds: readonly string[]
): boolean {
  return (
    targetIds.length > 0 &&
    targetIds.every((id) => rows.find((r) => r.nodeId === id)?.proven === true)
  )
}

/** The `list` column's words (T201's second landing): one short line per reason. */
export function trustReasonText(reason: TrustReason): string {
  switch (reason) {
    case 'proven':
      return '已证明'
    case 'session-gone':
      return '未证明（会话已亡）'
    case 'no-durable-row':
      return '未证明（无持久行：attach 还原且本机无 spawn 记录）'
    case 'entry-id-mismatch':
      return '未证明（entry id 不匹配：持久行属别的项目）'
    case 'reproof-pending':
      return '未证明（待再证明：重开项目即恢复）'
    case 'ownership-unwired':
      return '未证明（宿主未接持久账本）'
  }
}
