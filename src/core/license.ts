// Official account, checkout, token storage and license networking are removed.
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'
export const PRO_FREE_SEATS = 0
export function isDntEnv() { return true }
export function setLicenseNetworkConsent(_fn: () => boolean): void {}
export function licenseNetworkGate() { return 'disabled' as const }
export function clockAnchorMs() { return Date.now() }
export function getStoredEntitlement(): null { return null }
export function licensedSeats() { return 0 }
export function isPremium() { return false }
export function proForProjectLimit() { return false }
export function initLicense(_onChange?: () => void): void {
 const status = (): LicenseStatus => ({ tier: null, active: false, expiresAt: null, termEndsAt: null, seats: 0, error: 'disabled' })
 for (const channel of [IPC.licenseStatus, IPC.licenseUpgrade, IPC.licenseActivate, IPC.licenseDeactivate]) platform().handle(channel, status)
 for (const channel of [IPC.licenseDetail, IPC.licenseRelease]) platform().handle(channel, () => ({ key: null, used: 0, seats: 0, source: null, error: 'disabled' }))
}
