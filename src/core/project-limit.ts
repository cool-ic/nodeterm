// Local projects have no cloud allowance or machine fingerprint.
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import { INACTIVE_PROJECT_LIMIT, type ProjectLimitState, type ClaimResult } from '../shared/project-limit'
import type { MachineHashResult } from './machine-id'
export interface ProjectLimitDeps {
  /** `WorkspaceStore.openProjectCount` — undefined = unknown, never recorded or sent as 0. */
  openProjects: () => number | undefined
  /** `readMachineHashResult` (machine-id.ts). Read lazily: only by a claim, or at init when a
   *  token is already stored. */
  machineHash: () => Promise<MachineHashResult>
  /** The allowance public key; defaults to the shipped one ('' = none: never active). */
  publicKeyPem?: string
  /** Deliver the new state to this machine's own windows — never to relay peers. */
  notify: (s: ProjectLimitState) => void
  /** Settles once `openProjects` can answer (main: the boot workspace load). The init check read
   *  waits for it, settled either way: read before it, the count is still unknown and that read
   *  goes out without it. Absent = read at once. */
  ready?: Promise<unknown>
}
export interface ProjectLimitHandle {
  /** The current state. Synchronous and offline. */
  state(): ProjectLimitState
  /** Ask the server for this device's allowance. Never rejects. */
  claim(): Promise<ClaimResult>
  /** Re-send the state, unconditionally. */
  refresh(): void
  /** Send the state only if it differs from the last one sent — what a license or settings change
   *  calls (either can alter it with nothing here noticing, and settings change on every save). */
  pushIfChanged(): void
}
export function initProjectLimit(d: ProjectLimitDeps): ProjectLimitHandle {
 const state = () => ({ ...INACTIVE_PROJECT_LIMIT })
 const h = { state, async claim(): Promise<ClaimResult> { return { ok: true, state: state() } }, refresh() { d.notify(state()) }, pushIfChanged() {} }
 platform().handle(IPC.projectLimitState, state)
 platform().handle(IPC.projectLimitClaim, h.claim)
 return h
}

export async function __projectLimitIdleForTests(): Promise<void> {}
