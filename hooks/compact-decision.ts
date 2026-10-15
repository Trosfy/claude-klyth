// Automatic ownership is separate from the boundary finalized by history reconciliation.
import type { Session } from './session'
import type { HistoryPrefix } from './history-context'

export type CompactBoundary = { loaded: Session['loaded']; target: Session['main']; epoch: number; revision: number; choice: number }
export const permissionEpoch = (s: Session, who = 'main') => s.permissionEpoch + (s.permissionModes.get(who)?.revision ?? 0)
export const compactBoundary = (s: Session): CompactBoundary => ({ loaded: s.loaded, target: s.main, epoch: permissionEpoch(s), revision: s.historyRevision.get('main') ?? 0, choice: s.mainChoiceRevision })
export const boundaryMatches = (s: Session, b: CompactBoundary) => s.loaded === b.loaded && s.main === b.target && permissionEpoch(s) === b.epoch && (s.historyRevision.get('main') ?? 0) === b.revision && s.mainChoiceRevision === b.choice
export type ContextPreparation = { valid(): boolean; committed(boundary: CompactBoundary, prefix: HistoryPrefix): void }
export type AutoDecision = { boundary: CompactBoundary; raw: HistoryPrefix; estimate: number; threshold: number; valid(): boolean }

// Guard each asynchronous port operation, including operations nested in header construction.
export function guardedPort<T extends object>(port: T, valid: () => boolean): T {
  return new Proxy(port, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver)
    if (typeof value !== 'function' || ['debug', 'toast', 'status', 'restoreStatus', 'progress', 'compacted', 'after', 'log', 'saveDraft'].includes(String(key))) return value
    return (...args: unknown[]) => {
      if (!valid()) throw new Error('automatic compaction decision is stale')
      const result = value.apply(target, args)
      if (result instanceof Promise) return result.then(answer => {
        if (!valid()) throw new Error('automatic compaction decision is stale')
        return answer
      })
      return result
    }
  } })
}
