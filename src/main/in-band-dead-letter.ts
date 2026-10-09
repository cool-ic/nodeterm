import { STATION_NOTICE_VERB } from '../shared/agents/agent-messaging'
import type { QueuedDeliveryRequest } from '../core/agents/delivery-queue'

/**
 * T245 — does a queued message's EXPIRY earn an in-band dead letter (the app-authored notice
 * `onExpiredInBand` sends the sender)? ONE rule: the app's own station notices never do.
 *
 * Why: a notice's "sender" is the APP, not a person or an agent — nobody sent anything that can be
 * mourned, so a notice's death belongs to the durable legs alone (the board-log `expired` line and
 * the trace). Generating a further notice about it is what fed the chain the field kept finding:
 * notice expires → dead letter (itself a notice) queues → that one expires too — three generations
 * on 2026-10-09, one entry waiting 15453s. T240④ first cut this only for notices whose body was
 * not on disk, but app-composed bodies are short and on disk, so the chain survived; hence the
 * verb-level rule. `info.bodyOmitted` (T240④) is subsumed by it — a body-omitted notice is still a
 * notice — and stays in the signature so the "bodyOmitted 真假都算" nail pins both against this
 * one decision.
 *
 * `send` / `reply` / `notify` keep their dead letters: those carry something a sender actually
 * said (T234/T237 semantics untouched). A board comment keeps its (unchanged) routing.
 */
export function sendsInBandDeadLetter(
  req: QueuedDeliveryRequest,
  _info?: { bodyOmitted?: boolean }
): boolean {
  return req.verb !== STATION_NOTICE_VERB
}
