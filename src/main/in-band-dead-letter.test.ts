import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sendsInBandDeadLetter } from './in-band-dead-letter'
import type { QueuedDeliveryRequest } from '../core/agents/delivery-queue'

const INDEX_SRC = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** The verb is the only field the rule reads; the rest just makes the request typecheck. */
const req = (verb: string): QueuedDeliveryRequest => ({
  verb,
  sourceNodeId: 'st1',
  targetNodeId: 'orch1',
  sourceTitle: 'Station',
  body: 'n'
})

/**
 * T245 — the in-band dead letter's ONE rule: the app's own station notices never get one. The
 * decision lives in its own module (not inline in `index.ts`) because index is the Electron entry
 * and no test can import it; main's handler routes through this and a source pin in the wiring
 * test keeps it that way.
 */
describe('sendsInBandDeadLetter (T245)', () => {
  it('a station-notice NEVER earns one — bodyOmitted true or false, both subsumed', () => {
    // T240④ first cut only the body-omitted kind; app-composed bodies are short and on disk, so
    // the chain survived. The rule is now the verb, and the T240④ gate is pinned as subsumed:
    // both variants of the old second gate answer the same "no".
    expect(sendsInBandDeadLetter(req('station-notice'), { bodyOmitted: true })).toBe(false)
    expect(sendsInBandDeadLetter(req('station-notice'), { bodyOmitted: false })).toBe(false)
    expect(sendsInBandDeadLetter(req('station-notice'))).toBe(false)
  })

  it('send / reply / notify keep theirs — a sender still hears that its words died', () => {
    for (const verb of ['send', 'reply', 'notify'] as const) {
      expect(sendsInBandDeadLetter(req(verb)), verb).toBe(true)
    }
  })

  it('a board comment keeps its (unchanged) routing — outside this rule', () => {
    expect(sendsInBandDeadLetter(req('board-comment'))).toBe(true)
  })

  it('main routes through this predicate — the old inline bodyOmitted gate is gone', () => {
    expect(INDEX_SRC).toContain('if (!sendsInBandDeadLetter(req, info)) return')
    expect(INDEX_SRC).not.toContain('req.verb === STATION_NOTICE_VERB && info.bodyOmitted')
  })
})
