import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'

const ROWS = {
  updates: { title: 'Updates', keywords: ['update', 'version', 'check', 'upgrade'] }
}
const ENTRIES = Object.values(ROWS)

export function UpdatesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.nodeTerminal.updates.getVersion().then(setVersion)
  }, [])
  return (
    <SettingsSection id="updates" title="Version" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.updates}>
        <div className="space-y-3">
          <FieldRow
            label="Current version"
            control={<span className="text-[13px] text-muted">{version || '…'}</span>}
          />
          <p className="text-sm text-muted">This build is maintained locally through Git.</p>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
