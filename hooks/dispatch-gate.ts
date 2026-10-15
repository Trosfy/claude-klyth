// Local socket dispatch readiness: each guarded request waits for one authenticated client decision.
// Provider preparation finishes before readiness; no callback or credential crosses this boundary.
import type { StepEvent, StepWire } from './protocol'
import type { UsageExecutionSummary } from './usage-evidence'
import type { createStepper, Env } from '../klythd/step'

export type DispatchReady = { dispatchReady: string; request: string }
type Pending = { request: string; ready: boolean; decide(accepted: boolean): void }
const ACK_MS = 5000
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)

export function dispatchGate(stepper: ReturnType<typeof createStepper>, sleep: Env['sleep']) {
  const pending = new Map<string, Pending>()
  return {
    ...stepper,
    ack(w: { dispatch?: unknown; accepted?: unknown }): { status: number; body: string } {
      const request = validId(w.dispatch) ? pending.get(w.dispatch) : undefined
      if (request === undefined || !request.ready || typeof w.accepted !== 'boolean') return { status: 409, body: 'dispatch expired or invalid' }
      request.decide(w.accepted)
      return { status: 200, body: 'acknowledged' }
    },
    async *step(w: StepWire, signal: AbortSignal): AsyncGenerator<StepEvent | UsageExecutionSummary | DispatchReady, void> {
      if (w.dispatch === undefined) return yield* stepper.stepWithAccounting(w, signal)
      if (!validId(w.dispatch) || [...pending.values()].some(p => p.request === w.dispatch) || pending.size >= 16) throw new Error('invalid or duplicate dispatch id')
      const id = crypto.randomUUID(), timer = new AbortController(), started = performance.now()
      let notify!: () => void
      const ready = new Promise<void>(resolve => { notify = resolve })
      let decide!: (accepted: boolean) => void
      const decision = new Promise<boolean>(resolve => { decide = resolve })
      let settled = false
      const owner: Pending = { request: w.dispatch, ready: false, decide(accepted) {
        if (settled) return
        settled = true
        if (pending.get(id) === owner) pending.delete(id)
        timer.abort()
        decide(accepted && !signal.aborted && performance.now() - started < (w.req.timeoutMs ?? Infinity))
      } }
      pending.set(id, owner)
      const abort = () => owner.decide(false)
      signal.addEventListener('abort', abort, { once: true })
      const source = stepper.stepWithAccounting(w, signal, () => {
        if (signal.aborted || settled) return Promise.resolve(false)
        const remaining = Math.min(ACK_MS, (w.req.timeoutMs ?? Infinity) - (performance.now() - started))
        if (remaining <= 0) { owner.decide(false); return decision }
        owner.ready = true
        notify()
        void sleep(remaining, AbortSignal.any([signal, timer.signal])).then(abort, abort)
        return decision
      })
      try {
        let next = source.next()
        // The generator can fail before readiness (invalid config/key/encoding); forward that failure.
        const first = await Promise.race([next.then(value => ({ value })), ready.then(() => ({ ready: true }))])
        if ('ready' in first) yield { dispatchReady: id, request: w.dispatch }
        else {
          if (first.value.done) return
          yield first.value.value
          next = source.next()
        }
        for (;;) {
          const item = await next
          if (item.done) return
          yield item.value
          next = source.next()
        }
      } finally {
        owner.decide(false)
        signal.removeEventListener('abort', abort)
        timer.abort()
        await source.return()
      }
    },
  }
}
