// One lifecycle boundary owns preparation, queued idle dispatch and final publication.
import type { SessionCompactResult } from 'claude-code'
import { inputBudget } from './config'
import type { ModelConfig } from './config'
import type { Kind } from './kinds'
import { resolve } from './names'
import type { Session } from './session'
import { boundaryMatches, compactBoundary } from './compact-decision'
import type { AutoDecision, ContextPreparation } from './compact-decision'
import type { HistoryPrefix } from './history-context'

export type AutoPort = {
  enabled(valid?: () => boolean): Promise<boolean>
  estimate(preparation?: ContextPreparation): Promise<number | undefined>
  after(fn: () => void): void
  enqueue(): Promise<unknown>
  now(): number
  debug(text: string): void
}
export const autoThreshold = (model: ModelConfig, kind: Kind) => Math.floor(Math.min(0.78 * model.contextWindow, 0.9 * inputBudget(model, kind)))

export function createAutoCompact(s: Session) {
  type Owner = { boundary: ReturnType<typeof compactBoundary>; decision?: AutoDecision }
  let pending: Owner | undefined
  let cooldown = 0
  const valid = (owner: Owner) => pending === owner && boundaryMatches(s, owner.boundary)
  const enabled = async (io: AutoPort, owner: Owner) => valid(owner) && await io.enabled(() => valid(owner)) && valid(owner)
  return {
    async schedule(io: AutoPort) {
      if (pending !== undefined && !valid(pending)) pending = undefined
      if (pending !== undefined || io.now() < cooldown) return
      const owner = pending = { boundary: compactBoundary(s) } as Owner
      let estimate: number | undefined, threshold: number | undefined
      let raw: HistoryPrefix | undefined
      let queued = false, reason = 'not-routed'
      try {
        const t = s.loaded.config === undefined || s.main == null ? undefined : resolve(s.loaded.config, s.main)
        if (t?.kind !== 'remote') return
        reason = 'disabled-or-stale'
        if (!(await enabled(io, owner))) return
        threshold = autoThreshold(t.model, t.provider.kind)
        reason = 'estimate-ineligible-or-stale'
        estimate = await io.estimate({ valid: () => valid(owner), committed: (boundary, prefix) => { owner.boundary = boundary; raw = prefix } })
        if (!valid(owner) || estimate === undefined || raw === undefined || estimate < threshold || !(await enabled(io, owner))) return
        const decision: AutoDecision = { boundary: owner.boundary, raw, estimate, threshold, valid: () => valid(owner) }
        owner.decision = decision
        reason = 'queue-failed'
        io.after(() => {
          if (!valid(owner)) return
          void io.enqueue().catch(err => {
            if (pending !== owner) return
            pending = undefined
            cooldown = io.now() + 60_000
            io.debug(`klyth autocompact: could not queue idle compaction (${String(err).slice(0, 240)})`)
          })
        })
        queued = true
        reason = 'queued'
      } catch (err) {
        if (valid(owner)) throw err
      } finally {
        io.debug(`klyth autocompact: trigger=lifecycle reason=${reason} estimate=${estimate ?? '-'} threshold=${threshold ?? '-'}`)
        if (pending === owner && !queued) pending = undefined
      }
    },
    async run(io: AutoPort, compact: (decision: AutoDecision) => Promise<SessionCompactResult>): Promise<SessionCompactResult> {
      const owner = pending, decision = owner?.decision
      try {
        if (owner === undefined || decision === undefined || !(await enabled(io, owner))) return { skip: 'klyth: queued auto-compaction is stale or disabled; history kept' }
        let raw: HistoryPrefix | undefined
        const estimate = await io.estimate({ valid: () => valid(owner), committed: (boundary, prefix) => {
          // Execution may revoke authority, but cannot adopt a new boundary or raw prefix.
          if (!boundaryMatches(s, decision.boundary)) return
          raw = prefix
        } })
        if (!valid(owner) || estimate === undefined || estimate < decision.threshold || (raw?.count !== decision.raw.count || raw.digest !== decision.raw.digest) || !(await enabled(io, owner))) return { skip: 'klyth: queued auto-compaction is stale or disabled; history kept' }
        const done = await compact(decision)
        if (pending === owner && done.skip !== undefined) cooldown = io.now() + 60_000
        return done
      } catch (err) {
        if (owner !== undefined && !valid(owner)) return { skip: 'klyth: queued auto-compaction is stale or disabled; history kept' }
        if (pending === owner) cooldown = io.now() + 60_000
        throw err
      } finally {
        if (pending === owner) pending = undefined
      }
    },
    cancel() { pending = undefined },
  }
}
