import { createdAgentId, type AgentId } from './agents/config'
import type { NormalizedAgentEvent } from './agents/normalize'
import { isAgentPane, type PaneOwner } from './agents/pane-owner-predicate'

/** A verified CLI launch/turn can give a plain terminal the same durable binding
 * as an explicit agent node. Late end events and unverified claims cannot adopt it. */
export function observedBindingPatch(
  data: { agentId?: unknown; tags?: unknown; agentSessionId?: unknown; pendingLaunch?: unknown },
  event: NormalizedAgentEvent
): { agentId: AgentId; agentSessionId: string } | null {
  if (!event.verified || !event.sessionId || data.pendingLaunch) return null
  if (event.agentId !== 'codex' && event.agentId !== 'qoder') return null
  const starts = event.kind === 'session' && event.sessionPhase === 'start'
  if (!starts && !event.newTurn) return null
  const current = createdAgentId(data)
  // Switching an explicitly bound harness needs a separate, process-verified transition.
  if (current && current !== event.agentId) return null
  if (current === event.agentId && data.agentSessionId === event.sessionId) return null
  return { agentId: event.agentId, agentSessionId: event.sessionId }
}

/** A node token authenticates the reporter, not the foreground process. Reject
 * claims when the foreground harness does not match. This assumes one managed
 * CLI per pane; it does not prove same-harness nested process provenance. */
export async function verifyObservedBinding(
  data: Parameters<typeof observedBindingPatch>[0],
  event: NormalizedAgentEvent,
  readOwner: () => Promise<PaneOwner | null>,
  stillCurrent: () => boolean
): Promise<ReturnType<typeof observedBindingPatch>> {
  const patch = observedBindingPatch(data, event)
  if (!patch) return null
  try {
    const owner = await readOwner()
    return stillCurrent() && isAgentPane(owner, patch.agentId) === 'agent' ? patch : null
  } catch { return null }
}
