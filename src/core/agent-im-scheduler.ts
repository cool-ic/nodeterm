/** Coalesce bursts, but continuous activity in another node cannot starve idle mail. */
export class ImWakeScheduler {
  private quiet?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>
  private stopped = false
  constructor(private run: () => void, private quietMs = 200, private maxWaitMs = 1000) {}
  request(): void {
    if (this.stopped) return
    clearTimeout(this.quiet)
    this.quiet = setTimeout(() => this.flush(), this.quietMs)
    if (this.deadline === undefined) this.deadline = setTimeout(() => this.flush(), this.maxWaitMs)
  }
  private flush(): void {
    clearTimeout(this.quiet); clearTimeout(this.deadline)
    this.quiet = this.deadline = undefined
    if (!this.stopped) this.run()
  }
  dispose(): void {
    this.stopped = true
    clearTimeout(this.quiet); clearTimeout(this.deadline)
    this.quiet = this.deadline = undefined
  }
}
