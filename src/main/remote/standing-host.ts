import { removeRelayAdvertisement } from './relay-advertise'
// Official standing cloud host removed. LAN pairing remains independent.
export interface StandingHost { setEnabled(enabled: boolean): void; syncFromSettings(): void; stop(): void }
export function initStandingHost(..._args: unknown[]): StandingHost { void removeRelayAdvertisement(); return { setEnabled() {}, syncFromSettings() {}, stop() {} } }
