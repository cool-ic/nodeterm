/** Re-evaluate held mail when the CLI redraws its composer, without polling or resending mail.
 * Arm before capture so output racing with a failed observation also schedules a new sweep.
 * The caller's existing scheduler coalesces events; all safety gates run again on every attempt. */
export class ImWakeOutputRetry {
  private watches = new Map<string, () => void>()
  private held = new Set<string>()

  constructor(
    private onOutput: (node: string, changed: () => void) => () => void,
    private schedule: () => void
  ) {}

  begin(node: string): void {
    if (!this.watches.has(node)) {
      this.watches.set(node, this.onOutput(node, () => {
        if (this.held.has(node)) this.schedule()
      }))
    }
    this.held.add(node)
  }

  finish(node: string, result: string): void {
    if (!result.startsWith('held:') || result === 'held:wake-already-claimed') {
      this.held.delete(node)
      this.watches.get(node)?.()
      this.watches.delete(node)
    }
  }

  dispose(): void {
    for (const stop of this.watches.values()) stop()
    this.watches.clear()
    this.held.clear()
  }
}
