import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import {
  NOTCH_ALIGNS,
  NOTCH_OFFSET_MAX,
  NOTCH_OFFSET_MIN,
  NOTCH_WIDTH_MAX,
  NOTCH_WIDTH_MIN,
  sanitizeNotchAlign,
  sanitizeNotchOffsetY,
  type NotchAlign
} from '@shared/notch-hud'

const ROWS = {
  enabled: {
    title: 'Notch HUD',
    keywords: ['notch', 'hud', 'mascot', 'menu bar', 'overlay', 'agent', 'status', 'macos', 'capsule', 'dynamic island']
  },
  width: {
    title: 'Notch width',
    keywords: ['notch', 'width', 'flush', 'align', 'capsule', 'position', 'offset', 'tune']
  },
  side: {
    title: 'Capsule side',
    // T227: the bottom-right dock is what most people will be looking for here — it is this fork's
    // DEFAULT and the reason the control exists at all.
    keywords: [
      'notch',
      'side',
      'left',
      'right',
      'center',
      'centre',
      'align',
      'position',
      'place',
      'corner',
      'capsule',
      'bottom',
      'bottom-right',
      '右下',
      '右下角',
      '角落',
      '角'
    ]
  },
  offset: {
    title: 'Vertical position',
    keywords: ['notch', 'vertical', 'offset', 'raise', 'lower', 'up', 'down', 'height', 'position', 'move', 'capsule']
  },
  hover: {
    title: 'Expand on hover',
    keywords: ['notch', 'hover', 'expand', 'panel', 'click', 'open', 'sessions']
  }
}
const ENTRIES = Object.values(ROWS)

/**
 * The side control's labels, one per side in the shared vocabulary.
 *
 * `Record<NotchAlign, string>` on purpose: adding a side to `NOTCH_ALIGNS` without a label here is a
 * COMPILE error, so the control can never silently omit a layout main accepts. The three upstream
 * sides keep their English labels; the dock (T227) is `右下角` because that is what the person
 * asking for it calls it.
 */
const SIDE_LABELS: Record<NotchAlign, string> = {
  left: 'Left',
  center: 'Center',
  right: 'Right',
  'bottom-right': '右下角'
}

/** The options, DERIVED from `NOTCH_ALIGNS` (T227) rather than hand-listed: the order and the set on
 *  screen are main's own, so a side added upstream appears here the day it is added. Exported so the
 *  test can assert that without rendering the section. */
export const NOTCH_SIDE_OPTIONS: readonly { value: NotchAlign; label: string }[] = NOTCH_ALIGNS.map(
  (value) => ({ value, label: SIDE_LABELS[value] })
)

/** "+12 px" / "−8 px" / "0 px" — a signed readout so the direction is legible at a glance. */
function offsetLabel(px: number): string {
  if (px > 0) return `+${px} px`
  if (px < 0) return `−${-px} px`
  return '0 px'
}

/**
 * Settings → Interface → Notch (macOS only; the page only renders it on darwin).
 *
 * Everything the notch capsule exposes lives here rather than in Appearance: the enable toggle, the
 * notch-width knob (macOS exposes no API for the real notch width, so the capsule has to assume one
 * — this is how you make it sit flush on YOUR Mac), the two PLACEMENT controls (which side of the
 * display, and how far up/down), and hover-vs-click expansion. Everything applies live: dragging a
 * slider moves the capsule as you drag.
 *
 * The slider bounds and the sanitizers are the SAME constants main clamps against
 * (`@shared/notch-hud`), so the range on screen cannot drift from the clamp.
 */
export function NotchSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const notchHud = useSettings((s) => s.settings.notchHud)
  const notchWidth = useSettings((s) => s.settings.notchWidth)
  // Read through the sanitizers: settings.json is hand-editable, and a control bound to a value it
  // cannot represent (an unknown side, NaN) would render blank and overwrite the file on the next
  // interaction. Reading it as main will read it keeps the control honest about what is drawn.
  const notchAlign = useSettings((s) => sanitizeNotchAlign(s.settings.notchAlign))
  const notchOffsetY = useSettings((s) => sanitizeNotchOffsetY(s.settings.notchOffsetY))
  const hoverExpand = useSettings((s) => s.settings.notchHoverExpand)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="notch"
      title="Notch"
      description="Walking agent mascots inside the MacBook notch, and a mini session panel when you need it."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.enabled}>
        <FieldRow
          label="Show the notch HUD"
          description="Extends the notch into a black capsule while agents work: a walking mascot per busy agent, a red dot when one needs you, a green blob when one has finished and you haven't looked yet."
          control={
            <Switch
              checked={notchHud}
              ariaLabel="macOS Notch HUD"
              onChange={(on) => update({ notchHud: on })}
            />
          }
        />
      </SearchableRow>

      <div
        className={
          'mt-3 space-y-3 border-l border-border pl-4' +
          (notchHud ? '' : ' pointer-events-none opacity-40')
        }
        aria-disabled={!notchHud}
      >
        <SearchableRow {...ROWS.side}>
          <FieldRow
            label="Capsule side"
            description="右下角 docks the capsule in the bottom-right corner of the screen's work area — out of the way of the menu bar and the Dock. Center hugs the notch (on a screen without one, a floating pill in the middle). Left and Right draw a floating pill at that edge of the screen, just below the menu bar."
            control={
              <SegmentedPill<NotchAlign>
                value={notchAlign}
                options={[...NOTCH_SIDE_OPTIONS]}
                onChange={(v) => update({ notchAlign: v })}
                ariaLabel="Notch capsule side"
              />
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.offset}>
          <FieldRow
            label="Vertical position"
            description="Nudges the capsule down (positive) or up (negative) from where it normally sits. Up stops at the top edge of the screen — and the capsule fused to the notch is already there, so it can only move down, which turns it into a floating pill under the notch. Does not move the 右下角 corner dock, whose place is pinned to the corner."
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={NOTCH_OFFSET_MIN}
                  max={NOTCH_OFFSET_MAX}
                  step={2}
                  value={notchOffsetY}
                  aria-label="Notch capsule vertical offset in pixels"
                  onChange={(e) => update({ notchOffsetY: Number(e.target.value) })}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-14 text-right text-[12px] text-muted tabular-nums">
                  {offsetLabel(notchOffsetY)}
                </span>
              </div>
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.width}>
          <FieldRow
            label="Notch width"
            description="macOS doesn't tell apps how wide the notch is, so the capsule assumes it. Nudge this until the capsule sits flush against the notch — larger moves it left, smaller moves it right. Only the centered, notch-hugging capsule uses it."
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={NOTCH_WIDTH_MIN}
                  max={NOTCH_WIDTH_MAX}
                  step={2}
                  value={notchWidth}
                  aria-label="Assumed notch width in pixels"
                  onChange={(e) => update({ notchWidth: Number(e.target.value) })}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-12 text-right text-[12px] text-muted tabular-nums">
                  {notchWidth} px
                </span>
              </div>
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.hover}>
          <FieldRow
            label="Expand on hover"
            description="Point at the capsule to open the session panel. Off = it only opens when you click it. Either way it closes when you move away — and that's when a finished session stops glowing green."
            control={
              <Switch
                checked={hoverExpand}
                ariaLabel="Expand the notch panel on hover"
                onChange={(on) => update({ notchHoverExpand: on })}
              />
            }
          />
        </SearchableRow>
      </div>
    </SettingsSection>
  )
}
