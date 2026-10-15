import { validTranscriptPath } from './usage-retention'
import type { UsageTranscript } from './usage-retention'
import type { Cache } from './config'
import { parsePricing } from './pricing'
import type { Pricing } from './pricing'
import { USAGE_UUID, validateUsageSummary } from './usage-evidence'
import type { AttemptOutcome, ExecutionOutcome, UsageExecutionSummary } from './usage-evidence'

export const USAGE_VERSION = 2
export const USAGE_ENVELOPE_BYTES_MAX = 4 * 1024 * 1024
export const USAGE_PENDING_MAX = 64
export const USAGE_EXECUTIONS_MAX = 2

export type UsagePurpose = 'step' | 'classifier' | 'compaction'
export type UsageOwner = 'main' | 'child'
export type UsageSnapshot = { target: string; label: string; pricing?: Pricing; cache?: Cache; overflow?: true }
export type UsageCategory = 'totalInput' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' | 'reasoning'
export type UsageTotals = Record<UsageCategory, { count: number; unknown: number; partial: number }>
export type UsageExecutionCounts = Record<ExecutionOutcome, number>
export const USAGE_EXECUTION_OUTCOMES: readonly ExecutionOutcome[] = ['success', 'failure', 'refused', 'aborted']
export const emptyUsageExecutionCounts = (): UsageExecutionCounts => Object.fromEntries(USAGE_EXECUTION_OUTCOMES.map(outcome => [outcome, 0])) as UsageExecutionCounts
type Execution = { snapshot?: UsageSnapshot; summary?: UsageExecutionSummary; missing?: true; conflict?: true }
export type PendingUsage = { requestId: string; sessionId: string; generation: number; sequence: number; purpose: UsagePurpose; owner: UsageOwner; target: string; startedAt: number; executions: Record<string, Execution> }
export type UsageBucket = {
  target: string
  label?: string
  purpose: UsagePurpose
  owner: UsageOwner
  requests: number
  executions: UsageExecutionCounts
  attempts: number
  unknownExecutions: number
  cacheEligibleAttempts: number
  cacheInputTokens: number
  cacheReadTokens: number
  outcomes: Record<AttemptOutcome, number>
  totals: UsageTotals
  costUsd: number
  hasKnownCost: boolean
  costIncompleteAttempts: number
  fullyPricedAttempts: number
  arithmeticOverflow: boolean
}
export type UsageOverflow = { purpose: UsagePurpose; owner: UsageOwner; requests: number; executions: UsageExecutionCounts; attempts: number; totals: UsageTotals }
export type UsageSession = {
  id: string
  transcript?: UsageTranscript
  startedAt: number
  observedSince: number | null
  observedAt: number
  logicalRequests: number
  untrackedRequests: number
  requestsWithoutExecution: number
  executions: UsageExecutionCounts
  completedAttempts: number
  usageCompleteAttempts: number
  missingUsageAttempts: number
  costFullyPricedAttempts: number
  costIncompleteAttempts: number
  unknownExecutions: number
  unattributedAttempts: number
  cacheEligibleAttempts: number
  cacheInputTokens: number
  cacheReadTokens: number
  totals: UsageTotals
  costUsd: number
  hasKnownCost: boolean
  arithmeticOverflow: boolean
  warnings: { trackingGap: boolean; persistenceFailure: boolean; recovered: boolean; earlierUnavailable: boolean }
  pending: Record<string, PendingUsage>
  buckets: Record<string, UsageBucket>
  overflow: UsageOverflow[]
}
export type UsageEnvelope = { version: 2; activeSessionId: string; ownerGeneration: number; revision: number; sessions: UsageSession[] }

const OUTCOMES: readonly AttemptOutcome[] = ['success', 'httpError', 'transportError', 'responseError', 'cut', 'aborted', 'unknown']
const CATEGORIES: readonly UsageCategory[] = ['totalInput', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning']
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
export const safeUsageId = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const safeIdentity = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
export const emptyUsageTotals = (): UsageTotals => Object.fromEntries(CATEGORIES.map(k => [k, { count: 0, unknown: 0, partial: 0 }])) as UsageTotals
const finiteCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const finiteAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const validTime = (value: unknown): value is number => finiteAmount(value) && value <= 8.64e15
const exact = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))

function validPricing(value: unknown): value is Pricing {
  return parsePricing(value, 'pricing', []) !== undefined
}
function validExecutionCounts(value: unknown): value is UsageExecutionCounts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const counts = value as Record<string, unknown>
  return exact(counts, USAGE_EXECUTION_OUTCOMES) && USAGE_EXECUTION_OUTCOMES.every(outcome => finiteCount(counts[outcome]))
}
function validTotals(value: unknown): value is UsageTotals {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const totals = value as Record<string, unknown>
  if (!exact(totals, CATEGORIES)) return false
  return CATEGORIES.every(key => {
    const item = totals[key]
    return typeof item === 'object' && item !== null && !Array.isArray(item) && exact(item as Record<string, unknown>, ['count', 'unknown', 'partial']) && finiteCount((item as UsageTotals[UsageCategory]).count) && finiteCount((item as UsageTotals[UsageCategory]).unknown) && finiteCount((item as UsageTotals[UsageCategory]).partial)
  })
}

// Validate accounting structure independently of host publication capacity.
export function validateUsageEnvelope(value: unknown): UsageEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const envelope = value as Record<string, unknown>
  if (!exact(envelope, ['version', 'activeSessionId', 'ownerGeneration', 'revision', 'sessions']) || ![1, USAGE_VERSION].includes(envelope['version'] as number) || !safeUsageId(envelope['activeSessionId']) || !finiteCount(envelope['ownerGeneration']) || envelope['ownerGeneration'] < 1 || !finiteCount(envelope['revision']) || !Array.isArray(envelope['sessions']) || envelope['sessions'].length < 1) return undefined
  const ids = new Set<string>()
  for (const raw of envelope['sessions']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const session = raw as Record<string, unknown>
    const fields = ['id', 'startedAt', 'observedSince', 'observedAt', 'logicalRequests', 'untrackedRequests', 'requestsWithoutExecution', 'executions', 'completedAttempts', 'usageCompleteAttempts', 'missingUsageAttempts', 'costFullyPricedAttempts', 'costIncompleteAttempts', 'unknownExecutions', 'unattributedAttempts', 'cacheEligibleAttempts', 'cacheInputTokens', 'cacheReadTokens', 'totals', 'costUsd', 'hasKnownCost', 'arithmeticOverflow', 'warnings', 'pending', 'buckets', 'overflow', ...(Object.hasOwn(session, 'transcript') ? ['transcript'] : [])]
    if (!exact(session, fields) || !safeUsageId(session['id']) || ids.has(session['id'] as string) || !validTime(session['startedAt']) || !(session['observedSince'] === null || validTime(session['observedSince'])) || !validTime(session['observedAt']) || !validTotals(session['totals']) || !validExecutionCounts(session['executions']) || !finiteAmount(session['costUsd']) || typeof session['hasKnownCost'] !== 'boolean' || typeof session['arithmeticOverflow'] !== 'boolean') return undefined
    if (Object.hasOwn(session, 'transcript')) {
      const transcript = session['transcript']
      if (typeof transcript !== 'object' || transcript === null || Array.isArray(transcript) || !exact(transcript as Record<string, unknown>, ['path', 'confirmed']) || !validTranscriptPath((transcript as UsageTranscript).path) || typeof (transcript as UsageTranscript).confirmed !== 'boolean') return undefined
    }
    ids.add(session['id'] as string)
    for (const key of ['logicalRequests', 'untrackedRequests', 'requestsWithoutExecution', 'completedAttempts', 'usageCompleteAttempts', 'missingUsageAttempts', 'costFullyPricedAttempts', 'costIncompleteAttempts', 'unknownExecutions', 'unattributedAttempts', 'cacheEligibleAttempts', 'cacheInputTokens', 'cacheReadTokens']) if (!finiteCount(session[key])) return undefined
    const warnings = session['warnings']
    if (typeof warnings !== 'object' || warnings === null || Array.isArray(warnings) || !exact(warnings as Record<string, unknown>, ['trackingGap', 'persistenceFailure', 'recovered', 'earlierUnavailable']) || !['trackingGap', 'persistenceFailure', 'recovered', 'earlierUnavailable'].every(key => typeof (warnings as Record<string, unknown>)[key] === 'boolean')) return undefined
    const pending = session['pending'], buckets = session['buckets'], overflow = session['overflow']
    if (typeof pending !== 'object' || pending === null || Array.isArray(pending) || Object.keys(pending).length > USAGE_PENDING_MAX || typeof buckets !== 'object' || buckets === null || Array.isArray(buckets) || !Array.isArray(overflow) || overflow.length > 6) return undefined
    for (const [id, rawPending] of Object.entries(pending)) {
      if (typeof rawPending !== 'object' || rawPending === null || Array.isArray(rawPending)) return undefined
      const p = rawPending as Record<string, unknown>
      if (!exact(p, ['requestId', 'sessionId', 'generation', 'sequence', 'purpose', 'owner', 'target', 'startedAt', 'executions']) || p['requestId'] !== id || !safeUsageId(p['sessionId']) || p['sessionId'] !== session['id'] || !finiteCount(p['generation']) || p['generation'] !== envelope['ownerGeneration'] || !finiteCount(p['sequence']) || p['sequence'] < 1 || id !== `${p['sessionId']}:${p['generation']}:${p['sequence']}` || !['step', 'classifier', 'compaction'].includes(p['purpose'] as string) || !['main', 'child'].includes(p['owner'] as string) || !safeIdentity(p['target'], Infinity) || !validTime(p['startedAt']) || typeof p['executions'] !== 'object' || p['executions'] === null || Array.isArray(p['executions']) || Object.keys(p['executions'] as object).length > USAGE_EXECUTIONS_MAX) return undefined
      for (const [executionId, rawExecution] of Object.entries(p['executions'] as Record<string, unknown>)) {
        if (!USAGE_UUID.test(executionId) || !validExecution(rawExecution)) return undefined
        const execution = rawExecution as Execution
        if (execution.summary !== undefined && (execution.summary.executionId !== executionId || execution.summary.requestId !== p['requestId'])) return undefined
      }
    }
    for (const [bucketId, rawBucket] of Object.entries(buckets as Record<string, unknown>)) {
      if (!validBucket(rawBucket, envelope['version'] === 1)) return undefined
      const bucket = rawBucket as UsageBucket & { pricing?: Pricing; cache?: Cache }
      const key = envelope['version'] === 1 ? [bucket.target, bucket.purpose, bucket.owner, bucket.pricing ?? null, bucket.cache ?? null] : [bucket.target, bucket.purpose, bucket.owner]
      if (bucketId !== JSON.stringify(key)) return undefined
    }
    const overflowKeys = new Set<string>()
    for (const rawOverflow of overflow) {
      if (!validOverflow(rawOverflow)) return undefined
      const key = `${rawOverflow.purpose}:${rawOverflow.owner}`
      if (overflowKeys.has(key)) return undefined
      overflowKeys.add(key)
    }
  }
  if (!ids.has(envelope['activeSessionId'] as string)) return undefined
  return envelope['version'] === 1 ? convertLegacyUsage(value as UsageEnvelope) : value as UsageEnvelope
}

function validExecution(value: unknown): value is Execution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  const fields = [...(Object.hasOwn(e, 'snapshot') ? ['snapshot'] : []), ...(Object.hasOwn(e, 'summary') ? ['summary'] : []), ...(Object.hasOwn(e, 'missing') ? ['missing'] : []), ...(Object.hasOwn(e, 'conflict') ? ['conflict'] : [])]
  if (!exact(e, fields) || fields.length === 0 || e['missing'] !== undefined && e['missing'] !== true || e['conflict'] !== undefined && e['conflict'] !== true) return false
  if (e['snapshot'] !== undefined && !validSnapshot(e['snapshot'])) return false
  if (e['summary'] !== undefined && validateUsageSummary(e['summary']) === undefined) return false
  return true
}
function validSnapshot(value: unknown): value is UsageSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const s = value as Record<string, unknown>
  const fields = ['target', 'label', ...(Object.hasOwn(s, 'pricing') ? ['pricing'] : []), ...(Object.hasOwn(s, 'cache') ? ['cache'] : []), ...(Object.hasOwn(s, 'overflow') ? ['overflow'] : [])]
  return exact(s, fields) && safeIdentity(s['target'], Infinity) && safeIdentity(s['label'], Infinity) && (s['overflow'] === undefined || s['overflow'] === true && s['target'] === 'oversized-identity') && (s['pricing'] === undefined || validPricing(s['pricing'])) && (s['cache'] === undefined || s['cache'] === '5m' || s['cache'] === '1h')
}
function validBucket(value: unknown, legacy: boolean): value is UsageBucket {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const b = value as Record<string, unknown>
  const fields = ['target', 'purpose', 'owner', 'requests', 'executions', 'attempts', 'unknownExecutions', 'cacheEligibleAttempts', 'cacheInputTokens', 'cacheReadTokens', 'outcomes', 'totals', 'costUsd', 'hasKnownCost', 'costIncompleteAttempts', 'fullyPricedAttempts', 'arithmeticOverflow']
  if (Object.keys(b).some(key => !fields.concat(legacy ? ['label', 'pricing', 'cache'] : ['label']).includes(key)) || !fields.every(key => Object.hasOwn(b, key)) || !safeIdentity(b['target'], Infinity) || (b['label'] !== undefined && !safeIdentity(b['label'], 512)) || !['step', 'classifier', 'compaction'].includes(b['purpose'] as string) || !['main', 'child'].includes(b['owner'] as string)) return false
  if (b['pricing'] !== undefined && !validPricing(b['pricing']) || b['cache'] !== undefined && b['cache'] !== '5m' && b['cache'] !== '1h') return false
  if (!['requests', 'attempts', 'unknownExecutions', 'cacheEligibleAttempts', 'cacheInputTokens', 'cacheReadTokens', 'costIncompleteAttempts', 'fullyPricedAttempts'].every(key => finiteCount(b[key])) || !finiteAmount(b['costUsd']) || typeof b['hasKnownCost'] !== 'boolean' || typeof b['arithmeticOverflow'] !== 'boolean' || !validTotals(b['totals'])) return false
  const outcomes = b['outcomes']
  return validExecutionCounts(b['executions']) && typeof outcomes === 'object' && outcomes !== null && !Array.isArray(outcomes) && exact(outcomes as Record<string, unknown>, OUTCOMES) && OUTCOMES.every(key => finiteCount((outcomes as Record<string, unknown>)[key]))
}
function validOverflow(value: unknown): value is UsageOverflow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return exact(o, ['purpose', 'owner', 'requests', 'executions', 'attempts', 'totals']) && validExecutionCounts(o['executions']) && ['step', 'classifier', 'compaction'].includes(o['purpose'] as string) && ['main', 'child'].includes(o['owner'] as string) && finiteCount(o['requests']) && finiteCount(o['attempts']) && validTotals(o['totals'])
}

// Unreleased v1 stored already-valued rate buckets; session totals are authoritative.
function convertLegacyUsage(value: UsageEnvelope): UsageEnvelope {
  const next = structuredClone(value)
  next.version = USAGE_VERSION
  for (const session of next.sessions) {
    const merged: Record<string, UsageBucket> = {}
    for (const old of Object.values(session.buckets)) {
      const { pricing: _pricing, cache: _cache, ...bucket } = old as UsageBucket & { pricing?: Pricing; cache?: Cache }
      const key = JSON.stringify([bucket.target, bucket.purpose, bucket.owner])
      const current = merged[key]
      if (current === undefined) { merged[key] = bucket; continue }
      const add = (a: number, b: number) => {
        if (Number.isSafeInteger(a + b)) return a + b
        current.arithmeticOverflow = true
        session.arithmeticOverflow = true
        session.warnings.trackingGap = true
        return Number.MAX_SAFE_INTEGER
      }
      for (const field of ['requests', 'attempts', 'unknownExecutions', 'cacheEligibleAttempts', 'cacheInputTokens', 'cacheReadTokens', 'costIncompleteAttempts', 'fullyPricedAttempts'] as const) current[field] = add(current[field], bucket[field])
      for (const outcome of OUTCOMES) current.outcomes[outcome] = add(current.outcomes[outcome], bucket.outcomes[outcome])
      for (const outcome of USAGE_EXECUTION_OUTCOMES) current.executions[outcome] = add(current.executions[outcome], bucket.executions[outcome])
      for (const category of CATEGORIES) for (const metric of ['count', 'unknown', 'partial'] as const) current.totals[category][metric] = add(current.totals[category][metric], bucket.totals[category][metric])
      if (Number.isFinite(current.costUsd + bucket.costUsd)) current.costUsd += bucket.costUsd
      else { current.arithmeticOverflow = true; session.warnings.trackingGap = true }
      current.hasKnownCost ||= bucket.hasKnownCost
      current.arithmeticOverflow ||= bucket.arithmeticOverflow
    }
    session.buckets = merged
  }
  return next
}

export function usageCheckpointFits(value: UsageEnvelope): boolean {
  try { return validateUsageEnvelope(value) !== undefined && jsonBytes(value) <= USAGE_ENVELOPE_BYTES_MAX } catch { return false }
}
