// Phases are observable work; only multi-call recovery has a count, never an estimated token percentage.
export type CompactProgress = {
  stage: 'preparing' | 'awaiting provider' | 'receiving summary' | 'completed' | 'saving draft' | 'validating' | 'ready to install'
  path?: 'cache-friendly' | 'uncached recovery'
  completed: number
  total: number
  chunk?: number
  chunks?: number
  reduction?: boolean
  chars?: number
}

type ProgressPort = {
  after(ms: number, fn: () => void): { cancel(): void }
  status(text: string): void
  restoreStatus(): void
  debug(text: string): void
}

export function progressText(p: CompactProgress, elapsedMs: number): string {
  const filled = p.total === 0 ? 0 : Math.floor(8 * p.completed / p.total)
  const bar = '■'.repeat(filled) + '□'.repeat(8 - filled)
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const elapsed = `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
  const path = p.path === 'uncached recovery' ? 'large-history summary' : p.path === 'cache-friendly' ? 'conversation summary' : undefined
  const work = p.reduction ? 'combining summaries' : p.chunk === undefined ? undefined : `part ${p.chunk} of ${p.chunks}`
  const stage = { preparing: 'preparing', 'awaiting provider': 'waiting for provider', 'receiving summary': 'receiving summary', completed: 'summary received', 'saving draft': 'saving draft', validating: 'validating replacement', 'ready to install': 'replacement ready for host installation' }[p.stage]
  const chars = p.chars === undefined ? '' : ` · ${p.chars} chars`
  const calls = p.total > 1 ? ` [${bar}] ${p.completed}/${p.total} calls` : ''
  return `Compacting${calls} · ${[path, work, stage].filter(Boolean).join(' · ')}${chars} · ${elapsed}`
}

export function createCompactProgress(io: ProgressPort) {
  const started = Date.now()
  let current: CompactProgress | undefined
  let timer: { cancel(): void } | undefined
  let closed = false
  let milestone = ''
  const render = () => { if (!closed && current !== undefined) io.status(progressText(current, Date.now() - started)) }
  const heartbeat = () => {
    render()
    if (!closed) timer = io.after(1000, heartbeat)
  }
  return {
    update(p: CompactProgress) {
      if (closed) return
      current = p
      render()
      const next = `${p.path ?? 'preparing'}:${p.stage}:${p.completed}:${p.chunk ?? ''}:${p.reduction ?? false}`
      if (next !== milestone) {
        milestone = next
        io.debug(`Klyth ${progressText(p, Date.now() - started)}`)
      }
      if (timer === undefined) timer = io.after(1000, heartbeat)
    },
    finish() {
      if (closed) return
      closed = true
      timer?.cancel()
      io.restoreStatus()
    },
  }
}
