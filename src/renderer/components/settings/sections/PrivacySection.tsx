import { SettingsSection } from '../SettingsSection'
export function PrivacySection({ isActive }: { isActive: boolean }) {
 return <SettingsSection id="privacy" title="Privacy" isActive={isActive} searchEntries={[]}><p className="text-sm text-muted">Official cloud accounts, telemetry, announcements, push and update services are removed from this build. Local notifications, LAN pairing and your configured SSH connections remain available.</p></SettingsSection>
}
