import type { LaunchClaim } from './launch-attempt'
import type { LaunchFailureReason, PendingLaunch } from '@shared/types'
import { lineBytes } from '@shared/canonical-line'
import { deliverCommand, type DeliveryIo, type DeliveryOutcome } from '@shared/command-delivery'

// A writer belongs to the PTY lifetime (including a parked view), not a Canvas render.
// A durable write-ahead claim distinguishes a never-attempted warm launch from an uncertain
// earlier submission whose clearing autosave may have been lost.
/**
 * T216: a refusal names the gate that refused it, at the moment it refused — a bare `cancelled`
 * conflated five different dead ends into one undiagnosable LAUNCH FAILED. `failBytes` rides
 * `line-too-long` only. `DeliveryOutcome`'s `line-too-long` is converted here, at the one place
 * that knows the command's length, so no consumer ever re-measures it.
 */
export interface LaunchRefusal {
  gate: LaunchFailureReason
  failBytes?: number
}
/** `cancelled` = refused with no gate attributable (a stale pending record, a dead writer). */
export type LaunchFailure = LaunchRefusal | 'cancelled'
type LaunchOutcome = Exclude<DeliveryOutcome, 'line-too-long'> | 'deferred' | LaunchRefusal
type Writer = (command: string, manual: boolean) => Promise<LaunchOutcome>

/** T216 (c): gate 1 is the most transient refusal and nothing has been typed yet, so the
 *  automatic path retries the shell probe twice before giving up. A manual ▶ stays single-shot —
 *  the user is present, and pressing ▶ again IS the retry. */
const SHELL_RETRY_DELAYS_MS = [1000, 3000]

/** One line for a CLI error string — the gate, plus the byte count when gate 4 refused. */
export function launchFailureText(failure: LaunchFailure): string {
  if (failure === 'cancelled') return 'cancelled'
  return failure.failBytes != null ? `${failure.gate} (${failure.failBytes} bytes)` : failure.gate
}
const defaultScope = {}
const scopedWriters = new WeakMap<object, Map<string, Writer>>()
function writersFor(scope: object): Map<string, Writer> {
  let writers = scopedWriters.get(scope)
  if (!writers) { writers = new Map(); scopedWriters.set(scope, writers) }
  return writers
}

export function registerLaunchWriter(id: string, writer: Writer, scope: object = defaultScope): () => void {
  const writers = writersFor(scope)
  writers.set(id, writer)
  return () => { if (writers.get(id) === writer) writers.delete(id) }
}
export function launchCommand(id: string, command: string, manual = false, scope: object = defaultScope): Promise<LaunchOutcome> {
  return writersFor(scope).get(id)?.(command, manual) ?? Promise.resolve('cancelled')
}
/** Is a writer registered for `id` (its PTY is mounted, or parked with the writer alive)? */
export function hasLaunchWriter(id: string, scope: object = defaultScope): boolean {
  return writersFor(scope).has(id)
}

export function createLaunchWriter(opts: {
  claimAttempt(manual: boolean, command: string): Promise<LaunchClaim>
  io: DeliveryIo
  shellReady(manual: boolean): Promise<boolean>
  killLine: string
  cleanup(cancel: () => void): void
}): Writer {
  let attempted = false
  let submitted = false
  let inFlight: Promise<LaunchOutcome> | undefined
  let disposed = false
  opts.cleanup(() => { disposed = true })
  // Gate 1 (shell confirmed?) and gate 3 (writer torn down mid-flight?) share one probe loop:
  // every pass rechecks `disposed` first, so a teardown during the probe or a backoff wait is
  // reported as `torn-down`, never as a probe timeout.
  const confirmShell = async (manual: boolean): Promise<LaunchRefusal | undefined> => {
    const delays = manual ? [] : [...SHELL_RETRY_DELAYS_MS]
    for (;;) {
      if (disposed) return { gate: 'torn-down' }
      if (await opts.shellReady(manual)) return disposed ? { gate: 'torn-down' } : undefined
      const delay = delays.shift()
      if (delay === undefined) return { gate: 'shell-unconfirmed' }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  return (command, manual) => {
    if (submitted) return Promise.resolve('submitted') // stale UI/save; never paste twice
    if (inFlight) return inFlight
    if (disposed || (!manual && attempted)) return Promise.resolve('cancelled')
    inFlight = (async () => {
      const ready = await confirmShell(manual)
      if (ready) return ready
      const claim = await opts.claimAttempt(manual, command)
      if (claim === 'deferred' && !disposed) return 'deferred' as const
      if (disposed) return { gate: 'torn-down' } as const
      if (!claim) return { gate: 'hold-not-committed' } as const
      attempted = true
      // Saving can take a remote round trip. Recheck after the barrier, before any input.
      const settled = await confirmShell(manual)
      if (settled) return settled
      return new Promise<DeliveryOutcome>((resolve) => {
        try {
          // A cancelled delivery may have left an unsubmitted prefix in the shell editor.
          // Explicit recovery starts a new line rather than appending another CLI command.
          if (manual) opts.io.write(opts.killLine)
          opts.cleanup(deliverCommand(opts.io, command, resolve, { killLine: opts.killLine }))
        } catch { resolve('cancelled') }
      })
    })().then((outcome) => {
      submitted = outcome === 'submitted'
      // Gate 4 carries the byte count; a `cancelled` from deliverCommand is a transport that
      // could not be written to — the pane is gone, which is gate 3's territory.
      if (outcome === 'line-too-long') return { gate: 'line-too-long', failBytes: lineBytes(command) }
      if (outcome === 'cancelled') return { gate: 'torn-down' }
      return outcome
    }).catch(() => 'cancelled' as const).finally(() => { inFlight = undefined })
    return inFlight
  }
}

/** Keep UI launch intent through the asynchronous shell settle and submission boundary. */
export function deliverInitialLaunch(command: string, opts: {
  pending?: PendingLaunch
  whenReady(run: () => void): void
  write: Writer
  update(patch: { initialCommand?: undefined; pendingLaunch?: PendingLaunch }): void
  onFailure(failure: LaunchFailure): void
}): void {
  if (opts.pending && opts.pending.attempted !== false) {
    // A park/remount can retain the live initialCommand alias while its first submission is
    // still settling. Never let that alias reset the durable attempted mark.
    opts.update({ initialCommand: undefined })
    opts.onFailure('cancelled')
    return
  }
  const pendingLaunch: PendingLaunch = { after: [], command, attempted: false }
  // Do not discard the live initialCommand before settle. The durable pending record also
  // survives a project switch. Canvas and this callback share the same in-flight writer.
  opts.update({ pendingLaunch })
  opts.whenReady(() => {
    void opts.write(command, false).then((outcome) => {
      if (outcome === 'deferred') return // no input/claim; retain never-attempted intent
      // The gate name rides the durable hold too: LAUNCH FAILED is found mostly on off-screen
      // nodes and after restarts, where only the persisted record can still answer "why".
      const refused = outcome === 'cancelled' ? undefined
        : { failReason: outcome.gate, ...(outcome.failBytes != null ? { failBytes: outcome.failBytes } : {}) }
      opts.update({ initialCommand: undefined,
        pendingLaunch: outcome === 'submitted' ? undefined
          : { ...pendingLaunch, attempted: true, manualOnly: true, ...refused } })
      if (outcome !== 'submitted') opts.onFailure(outcome)
    })
  })
}
