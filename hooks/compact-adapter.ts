// Engine adapter for deferred compact commands and successful history replacement. The summarizer
// and automatic eligibility rules use their own ports; this boundary owns clocks and public operations.
import type { CommandRunInput, CommandRunResult, SessionCompactInput, SessionCompactResult, Timer } from 'claude-code'

import { createAutoCompact } from './autocompact'
import type { AutoPort } from './autocompact'
import { dropTokens } from './classifier'
import { matchesDecisionHistory, reconcileHistory } from './history-context'
import { guardedPort, permissionEpoch } from './compact-decision'
import type { AutoDecision, ContextPreparation } from './compact-decision'
import { compact } from './compact'
import { createCompactProgress } from './compact-progress'
import type { CompactPort } from './compact'
import type { Backend } from './protocol'
import { firstLine, redact } from './redact'
import type { Session } from './session'

export type CompactEnginePort = Pick<CompactPort, 'engineModel' | 'rows' | 'saveDraft' | 'after' | 'wallNow' | 'debug' | 'toast'> & {
  status(text: string): void
  restoreStatus(): void
  enabled(valid?: () => boolean): Promise<boolean>
  estimate(preparation?: ContextPreparation): Promise<number | undefined>
  run(instructions?: string): Promise<CommandRunResult>
  log(text: string): void
}

type CompactOperation = { loaded: Session['loaded']; target: Session['main']; epoch: number; revision: number; automatic: boolean; decision?: AutoDecision; instructions?: string; result?: SessionCompactResult }

export async function autoEnabled(setting: () => Promise<boolean>, effective: () => Promise<boolean>, valid: () => boolean = () => true): Promise<boolean> {
  return valid() && await setting() && valid() && await effective() && valid()
}

export function createCompactAdapter(s: Session) {
  const auto = createAutoCompact(s)
  let queued: Timer | undefined
  let autoTimer: Timer | undefined
  let operation: CompactOperation | undefined
  let activeProgress: ReturnType<typeof createCompactProgress> | undefined
  const revision = (who: string) => s.historyRevision.set(who, (s.historyRevision.get(who) ?? 0) + 1)
  const staleReason = (snap: Pick<CompactOperation, 'loaded' | 'target' | 'epoch' | 'revision'>) => [
    s.loaded !== snap.loaded && 'configuration changed', s.main !== snap.target && 'route changed',
    permissionEpoch(s) !== snap.epoch && 'permission state changed', (s.historyRevision.get('main') ?? 0) !== snap.revision && 'recipient history changed',
  ].filter(Boolean).join(', ')
  const autoPort = (io: CompactEnginePort): AutoPort => ({
    enabled: io.enabled,
    estimate: io.estimate,
    after: fn => {
      autoTimer?.cancel()
      const timer = io.after(0, () => { if (autoTimer === timer) autoTimer = undefined; fn() })
      autoTimer = timer
    },
    enqueue: () => execute(io, undefined, true),
    now: () => Date.now(),
    debug: io.debug,
  })
  const run = async (io: CompactEnginePort, instructions?: string, automatic = false, decision?: AutoDecision): Promise<SessionCompactResult> => {
    if (operation !== undefined) return { skip: 'klyth: compaction is already scheduled or running; history kept' }
    const snap: CompactOperation = { loaded: s.loaded, target: s.main, epoch: permissionEpoch(s), revision: s.historyRevision.get('main') ?? 0, automatic, decision, instructions }
    operation = snap
    try {
      // The built-in command owns session.compact's dispatch. A direct plugin operation skips our hook.
      await io.run(instructions)
      if (snap.result !== undefined) return snap.result
      const skipped = { skip: 'klyth: built-in compact did not reach the routed hook; history kept' }
      io.log(skipped.skip)
      return skipped
    } finally { if (operation === snap) operation = undefined }
  }
  const execute = async (io: CompactEnginePort, instructions?: string, automatic = false) => {
    let invoked = false
    const dispatch = (decision?: AutoDecision) => { invoked = true; return run(io, instructions, automatic, decision) }
    const done = await (automatic ? auto.run(autoPort(io), dispatch) : dispatch())
    // Core prints its own final notice. Only a veto before command dispatch needs a plugin notice.
    if (!invoked) io.log(done.skip ?? 'Conversation compacted.')
    return done
  }
  return {
    revision,
    async compact(io: Omit<CompactPort, 'compacted'> & Partial<Pick<CompactEnginePort, 'status' | 'restoreStatus' | 'enabled'>>, backend: Backend, e: SessionCompactInput, signal: AbortSignal, native: () => Promise<SessionCompactResult>) {
      const capture = e.agentId === undefined && e.trigger === 'manual' && (e.instructions ?? '') === (operation?.instructions ?? '') ? operation : undefined
      try {
        if (capture?.decision !== undefined) io = guardedPort(io, capture.decision.valid)
        const automaticGuard = capture?.decision === undefined ? undefined : async () => {
          const decision = capture.decision!
          if (!decision.valid() || io.enabled === undefined || !(await io.enabled(decision.valid)) || !decision.valid()) return false
          const read = await io.transcript(undefined)
          if (!decision.valid() || 'deny' in read || decision.raw === undefined) return false
          const matches = await matchesDecisionHistory(read, decision.raw, e)
          return matches && decision.valid()
        }
        if (automaticGuard !== undefined && !(await automaticGuard())) return capture!.result = { skip: 'klyth: queued auto-compaction is stale or disabled; history kept' }
        if (capture !== undefined) {
          const read = await io.transcript(undefined)
          if (!('deny' in read)) await reconcileHistory(s, 'main', read, io.debug, e)
        }
        if (capture?.automatic && io.enabled !== undefined && !(await io.enabled())) return capture.result = { skip: 'klyth: queued auto-compaction is disabled; history kept' }
        const changed = capture === undefined ? '' : staleReason(capture)
        if (capture !== undefined && changed) {
          return capture.result = { skip: `klyth: queued compaction is stale: ${changed}; history kept; run /compact after this change settles` }
        }
        let progress: ReturnType<typeof createCompactProgress> | undefined
        try {
          const done = await compact({ ...io, automaticGuard,
            progress: e.agentId === undefined && io.status && io.restoreStatus ? event => {
              progress ??= createCompactProgress({ after: io.after, status: io.status!, restoreStatus: io.restoreStatus!, debug: io.debug })
              activeProgress = progress
              progress.update(event)
            } : undefined,
            compacted: who => {
              s.cacheHistory.invalidate(e.agentId)
              revision(who)
              dropTokens(io, s, 'compaction', false)
            },
          }, s, backend, e, signal, async () => {
            const done = await native()
            // A precomputed native result has not replaced history yet.
            if (done.skip === undefined && e.trigger !== 'precompute') {
              s.cacheHistory.invalidate(e.agentId)
              revision(e.agentId ?? 'main')
            }
            return done
          })
          if (capture !== undefined) capture.result = done
          return done
        } finally {
          progress?.finish()
          if (activeProgress === progress) activeProgress = undefined
        }
      } catch (err) {
        if (capture?.decision !== undefined && !capture.decision.valid()) return capture.result = { skip: 'klyth: queued auto-compaction is stale; history kept' }
        throw err
      }
    },
    schedule: (io: CompactEnginePort) => queued === undefined && operation === undefined && !s.compacting.has('main') ? auto.schedule(autoPort(io)) : Promise.resolve(),
    command(io: CompactEnginePort, e: CommandRunInput): CommandRunResult | undefined {
      const arg = e.args.trim()
      if (arg !== 'compact' && !arg.startsWith('compact ')) return undefined
      if (queued !== undefined || operation !== undefined || s.compacting.has('main')) {
        return { text: 'Compaction is already scheduled or running.' }
      }
      const snap = { loaded: s.loaded, target: s.main, epoch: permissionEpoch(s), revision: s.historyRevision.get('main') ?? 0 }
      queued = io.after(0, () => {
        queued = undefined
        const changed = staleReason(snap)
        if (changed) {
          auto.cancel()
          io.log(`Compaction skipped: ${changed}; history kept. Run /compact after this change settles.`)
          return
        }
        void execute(io, arg.slice(7).trim() || undefined)
          .catch(err => {
            const detail = firstLine(redact(err instanceof Error ? err.message : String(err))).slice(0, 240)
            io.debug(`klyth compact command: ${detail}`)
            io.toast(`Compaction could not run (${detail || 'unknown error'}); history kept; retry /klyth compact between turns.`)
          })
      })
      return { text: 'Compaction queued for main to become idle; no need to issue another /compact command.' }
    },
    end() {
      s.conversationGeneration++
      s.pin = null
      activeProgress?.finish()
      activeProgress = undefined
      autoTimer?.cancel()
      autoTimer = undefined
      s.forget('main')
      s.historyPrefixes.clear()
      s.currentPrompt = undefined
      s.prompts = []
      s.tokens.clear()
      s.dropEpoch++
      s.permissionEpoch++
      queued?.cancel()
      queued = undefined
      auto.cancel()
      revision('main')
      s.mainTurn = undefined
    },
  }
}
