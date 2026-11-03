import type { ImIdentity } from '../../scripts/agent-mail/runtime.mjs'

export interface ImOwnerProof { pid: number; pane?: string; tty: string; boot: number }

/** Cache successful proofs between native starts, never across a restarted CLI process.
 * Slot identity fences a slow proof from the previous start/session. */
export class ImOwnerProofs {
  private slots = new Map<string, { session: string; generation: string }>()
  constructor(
    private read: (identity: ImIdentity) => Promise<ImOwnerProof | null>,
    private remember: (identity: ImIdentity, proof: ImOwnerProof) => void
  ) {}

  recovered(identity: ImIdentity): void {
    this.slots.set(identity.node, { session: identity.session, generation: identity.generation })
  }
  forget(node: string): void { this.slots.delete(node) }

  async refresh(identity: ImIdentity, restarted = false): Promise<void> {
    const prior = this.slots.get(identity.node)
    if (!restarted && prior?.session === identity.session && prior.generation === identity.generation) return
    const slot = { session: identity.session, generation: identity.generation }
    this.slots.set(identity.node, slot)
    try {
      const proof = await this.read(identity)
      if (this.slots.get(identity.node) !== slot) return
      if (proof) this.remember(identity, proof)
      else this.slots.delete(identity.node)
    } catch {
      if (this.slots.get(identity.node) === slot) this.slots.delete(identity.node)
    }
  }
}
