// Personal "canvas rail collapsed" flag. Same storage family as the minimap minimize
// (`nodeterm.minimapCollapsed`) and the sessions sidebar pin: this machine only, never
// settings.json or project.json — how much chrome one viewer wants over their canvas is not
// something a git-shared project file should carry to everyone who clones it.
//
// Default EXPANDED (T223 ruling): the rail is the dock's new home, so a missing (or unreadable)
// key must keep it on screen rather than hide the canvas controls on every existing user's next
// launch.

export const RAIL_COLLAPSED_KEY = 'nodeterm.canvasRailCollapsed'

/** `'1'` is collapsed; missing, `'0'`, or any other value is expanded. */
export function parseRailCollapsed(raw: string | null): boolean {
  return raw === '1'
}

export function readRailCollapsed(
  getItem: (key: string) => string | null = (key) => localStorage.getItem(key)
): boolean {
  try {
    return parseRailCollapsed(getItem(RAIL_COLLAPSED_KEY))
  } catch {
    return false
  }
}

export function writeRailCollapsed(
  collapsed: boolean,
  setItem: (key: string, value: string) => void = (key, value) => localStorage.setItem(key, value)
): void {
  try {
    setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* private mode etc. — the toggle still works this session */
  }
}
