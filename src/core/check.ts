// Local compatibility contract: the official announcement/update feed is removed.
import type { Announcement, PopupAnnouncement, UpdatePolicy } from '../shared/types'
export interface CheckResult { messages: Announcement[]; popups: PopupAnnouncement[]; update: UpdatePolicy }
export type LimitsAnswer = { kind: 'on'; free: number; epoch: number } | { kind: 'off' } | { kind: 'unknown' }
export function onCheckAnswer(_listener: (answer: LimitsAnswer) => void): () => void { return () => {} }
export async function fetchCheck(): Promise<CheckResult> {
  return { messages: [], popups: [], update: { minSupported: null, mandatory: false } }
}
export async function fetchPopupImage(_hash: string): Promise<null> { return null }

export function configureCheck(_deps: { openProjects: () => number | undefined; telemetryEnabled: () => boolean }): void {}
