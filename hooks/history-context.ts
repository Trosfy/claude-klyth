// Cross-boundary history checks keep digests, never transcript copies or permission authority.
import type { SessionCompactInput } from 'claude-code'
import type { ApiMessage, StepRequest } from './protocol'
import type { Session } from './session'
import { stable } from './compact-snapshot'
import { compactBoundary, permissionEpoch } from './compact-decision'
import type { ContextPreparation, CompactBoundary } from './compact-decision'
import { blocksOf } from './transcript'

export type HistoryPrefix = { count: number; digest: string }
const MAX_LOOPS = 64
const canonical = (messages: readonly ApiMessage[]) => messages.map(m => ({ ...m, content: blocksOf(m).filter(b => b.type !== 'text' || b.text !== '') })).filter(m => m.content.length > 0)
async function hash(messages: readonly ApiMessage[]): Promise<string> {
  const bytes = new TextEncoder().encode(stable(messages)).buffer as ArrayBuffer
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function historyPrefix(messages: readonly ApiMessage[]): Promise<HistoryPrefix> {
  const rows = canonical(messages)
  return { count: rows.length, digest: await hash(rows) }
}

export async function matchesPrefix(messages: readonly ApiMessage[], prefix?: HistoryPrefix): Promise<boolean> {
  if (prefix === undefined) return false
  const rows = canonical(messages)
  return rows.length >= prefix.count && await hash(rows.slice(0, prefix.count)) === prefix.digest
}

// Core may coalesce its current manual command into the last API user row. Validate the
// original whole prefix digest, removing only that command and a single stdout separator LF.
export async function matchesCompactProjection(messages: readonly ApiMessage[], old: HistoryPrefix, e?: SessionCompactInput): Promise<boolean> {
  if (e?.trigger !== 'manual' || e.agentId !== undefined) return false
  const rows = canonical(messages), last = rows.at(-1)
  if (rows.length !== old.count || last?.role !== 'user') return false
  const content = last.content, command = content.at(-1)
  if (command?.type !== 'text' || command.text !== `/compact${e.instructions ? ` ${e.instructions}` : ''}`) return false
  const prefix = content.slice(0, -1)
  const candidate = [...rows.slice(0, -1), { ...last, content: prefix }]
  if (await matchesPrefix(candidate, old)) return true
  const previous = prefix.at(-1)
  if (previous?.type !== 'text' || typeof previous.text !== 'string' || !previous.text.endsWith('\n')) return false
  candidate[candidate.length - 1] = { ...last, content: [...prefix.slice(0, -1), { ...previous, text: previous.text.slice(0, -1) }] }
  return matchesPrefix(candidate, old)
}

// Automatic execution requires the whole original raw history, not merely append-only growth.
export async function matchesDecisionHistory(messages: readonly ApiMessage[], old: HistoryPrefix, e?: SessionCompactInput): Promise<boolean> {
  const current = await historyPrefix(messages)
  if (current.count === old.count && current.digest === old.digest) return true
  if (await matchesCompactProjection(messages, old, e)) return true
  if (e?.trigger !== 'manual' || e.agentId !== undefined) return false
  const rows = canonical(messages), command = rows.at(-1)
  const expected = `/compact${e.instructions ? ` ${e.instructions}` : ''}`
  return rows.length === old.count + 1 && command?.role === 'user' && command.content.length === 1 && command.content[0]?.type === 'text' && command.content[0]?.text === expected && await matchesPrefix(rows.slice(0, -1), old)
}

// Check raw getter history before task, identity and attested delivery projections can change it.
export type ReconciliationReceipt = { status: 'unchanged' | 'committed'; prefix: HistoryPrefix; boundary: CompactBoundary } | { status: 'stale' }
export async function reconcileHistoryReceipt(s: Session, who: string, messages: readonly ApiMessage[], debug: (text: string) => void, compact?: SessionCompactInput, preparation?: ContextPreparation): Promise<ReconciliationReceipt> {
  if (preparation !== undefined && !preparation.valid()) return { status: 'stale' }
  const generation = s.conversationGeneration
  const old = s.historyPrefixes.get(who), epoch = permissionEpoch(s, who), revision = s.historyRevision.get(who), loaded = s.loaded
  const valid = () => s.conversationGeneration === generation && s.historyPrefixes.get(who) === old && permissionEpoch(s, who) === epoch && s.historyRevision.get(who) === revision && s.loaded === loaded && (preparation === undefined || preparation.valid())
  const matches = old === undefined || await matchesPrefix(messages, old)
  if (!valid()) return { status: 'stale' }
  const projection = !matches && who === 'main' && await matchesCompactProjection(messages, old!, compact)
  if (!valid()) return { status: 'stale' }
  const changed = !matches && !projection
  const next = await historyPrefix(messages)
  if (!valid()) return { status: 'stale' }
  if (changed) {
    s.promptTokens.delete(who)
    s.sent.delete(who)
    const stamp = s.sentContext.get(who)
    if (stamp !== undefined) s.sentContext.set(who, { ...stamp, prefix: undefined })
    s.cacheHistory.invalidate(who === 'main' ? undefined : who)
    s.forkPrefixes.delete(who)
    s.classified.delete(who)
    s.vettedSpawns.clear()
    for (const [id, { vetted: _vetted, ...note }] of s.calls) s.calls.set(id, note)
    s.tokens.clear()
    s.dropEpoch++
    s.historyRevision.set(who, (s.historyRevision.get(who) ?? 0) + 1)
    if (who === 'main') s.prompts = s.currentPrompt === undefined ? [] : [s.currentPrompt]
  }
  s.historyPrefixes.delete(who)
  s.historyPrefixes.set(who, next)
  if (s.historyPrefixes.size > MAX_LOOPS) s.historyPrefixes.delete(s.historyPrefixes.keys().next().value!)
  const boundary = compactBoundary(s)
  preparation?.committed(boundary, next)
  if (changed) debug(`klyth: ${who} history changed outside append-only growth; cached context and permission tokens revoked`)
  return { status: changed ? 'committed' : 'unchanged', prefix: next, boundary }
}

export async function reconcileHistory(s: Session, who: string, messages: readonly ApiMessage[], debug: (text: string) => void, compact?: SessionCompactInput): Promise<boolean> {
  return (await reconcileHistoryReceipt(s, who, messages, debug, compact)).status === 'committed'
}

// Measured usage counts only a validated sent prefix. Fresh tail and header/schema bytes are estimates.
export async function contextEstimate(s: Session, who: string, req: StepRequest): Promise<number> {
  const serialized = Math.ceil(JSON.stringify(req).length / 3.5)
  const stamp = s.sentContext.get(who), last = s.promptTokens.get(who)
  if (last === undefined || stamp?.loaded !== s.loaded || stamp.messageCount > req.transcript.length) return serialized
  const header = { target: req.target, system: req.system, tools: req.tools, ...(req.effort === undefined ? {} : { effort: req.effort }) }
  if (stable(s.sent.get(who)) !== stable(header)) return serialized
  if (!(await matchesPrefix(req.transcript.slice(0, stamp.messageCount), stamp.prefix))) return serialized
  return Math.max(serialized, last.tokens + Math.ceil(JSON.stringify(req.transcript.slice(stamp.messageCount)).length / 3.5))
}
