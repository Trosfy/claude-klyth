// One visible, bounded approval per session. Payloads and controls live only in this controller's memory.
export const APPROVAL_PANE = 'klyth-classifier-approval'
export type ApprovalAnswer = 'allow' | 'deny' | 'timeout' | 'cancelled' | 'unplaced' | 'budget' | 'busy' | 'stale'
export type ApprovalView = { details: string; seconds: number; answer(value: 'allow' | 'deny'): void }
export type ApprovalPort = {
  monotonic(): number
  remaining(): number
  open(): Promise<{ isPlaced: boolean }>
  showing(): Promise<boolean>
  close(): Promise<void>
  redraw(): void
  after(ms: number, fn: () => void): { cancel(): void }
}

export function createApproval() {
  let active: { key: string; view: ApprovalView; showing: boolean; result: Promise<ApprovalAnswer>; cancel(): void } | undefined
  return {
    view: () => active?.showing ? active.view : undefined,
    cancel: () => active?.cancel(),
    async ask(io: ApprovalPort, key: string, details: string, valid: () => Promise<boolean>, signal: AbortSignal): Promise<ApprovalAnswer> {
      if (active !== undefined) return active.key === key ? active.result : 'busy'
      if (signal.aborted) return 'cancelled'
      if (io.remaining() < 9500) return 'budget'
      let resolve = (_answer: ApprovalAnswer) => {}, done = false, answering = false, deadline: number | undefined, timer = { cancel: () => {} }, expiry = { cancel: () => {} }
      const result = new Promise<ApprovalAnswer>(r => { resolve = r })
      const finish = (answer: ApprovalAnswer) => {
        if (done) return
        done = true
        timer.cancel()
        expiry.cancel()
        signal.removeEventListener('abort', abort)
        if (active !== undefined) active.showing = false
        io.redraw()
        void io.close().then(() => { active = undefined; resolve(answer) }, () => { active = undefined; resolve('cancelled') })
      }
      const abort = () => finish('cancelled')
      const view: ApprovalView = { details, seconds: 8, answer: value => {
        if (deadline === undefined || done || answering) return
        if (io.monotonic() >= deadline) { void expire(); return }
        answering = true
        if (value !== 'allow') return finish('deny')
        void Promise.all([valid(), io.showing()]).then(([ok, showing]) => {
          if (!showing) finish('unplaced')
          else if (!ok) finish('stale')
          else if (deadline !== undefined && io.monotonic() < deadline) finish(value)
          else void expire()
        }, () => finish('stale'))
      } }
      active = { key, view, showing: true, result, cancel: abort }
      signal.addEventListener('abort', abort, { once: true })
      const expire = async () => {
        if (done) return
        try {
          if (!(await io.showing())) return finish('unplaced')
          if (!(await valid()) || signal.aborted) return finish('stale')
          if (!(await io.showing())) return finish('unplaced')
          finish('timeout')
        } catch { finish('cancelled') }
      }
      const tick = async () => {
        if (done || deadline === undefined) return
        try {
          if (!(await io.showing())) return finish('unplaced')
          if (!(await valid()) || signal.aborted) return finish('stale')
          if (done) return
          const left = Math.max(0, Math.ceil((deadline - io.monotonic()) / 1000))
          view.seconds = left
          if (left === 0) return expire()
          io.redraw()
          timer = io.after(Math.min(1000, Math.max(1, deadline - io.monotonic())), () => { void tick() })
        } catch { finish('cancelled') }
      }
      try {
        if (!(await valid())) finish('stale')
        else if (io.remaining() < 9500) finish('budget')
        else {
          const opened = await io.open()
          if (done) { await io.close(); return result }
          if (!opened.isPlaced || !(await io.showing())) finish('unplaced')
          else if (io.remaining() < 9500) finish('budget')
          else {
            deadline = io.monotonic() + 8000
            io.redraw()
            expiry = io.after(8000, () => { void expire() })
            timer = io.after(1000, () => { void tick() })
          }
        }
      } catch { finish('cancelled') }
      return result
    },
  }
}
export type Approval = ReturnType<typeof createApproval>
