import { valueUsage } from './pricing'
import { USAGE_UUID, validateUsageEvidence } from './usage-evidence'
import type { AttemptOutcome, Measure, UsageEvidence, UsageExecutionSummary } from './usage-evidence'
import { USAGE_EXECUTIONS_MAX, USAGE_PENDING_MAX, USAGE_VERSION, emptyUsageExecutionCounts, emptyUsageTotals, safeUsageId } from './usage-ledger-codec'
import type { PendingUsage, UsageBucket, UsageCategory, UsageEnvelope, UsageOwner, UsagePurpose, UsageSession, UsageSnapshot, UsageTotals } from './usage-ledger-codec'

export type { PendingUsage, UsageBucket, UsageEnvelope, UsageOwner, UsagePurpose, UsageSession, UsageSnapshot } from './usage-ledger-codec'
export type UsageToken = { id: string; sessionId: string; generation: number; sequence: number }
type Category = UsageCategory
type Totals = UsageTotals

export type UsageAction =
  | { type: 'begin'; pending: PendingUsage }
  | { type: 'dispatch'; token: UsageToken; executionId: string; snapshot: UsageSnapshot }
  | { type: 'summary'; token: UsageToken; summary: UsageExecutionSummary }
  | { type: 'missing'; token: UsageToken; executionId: string }
  | { type: 'settle'; token: UsageToken; at: number }
  | { type: 'gap'; sessionId?: string }

const OUTCOMES: readonly AttemptOutcome[] = ['success', 'httpError', 'transportError', 'responseError', 'cut', 'aborted', 'unknown']
const CATEGORIES: readonly Category[] = ['totalInput', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning']
const emptyTotals = emptyUsageTotals
const blankSession = (id: string, now: number): UsageSession => ({
  id, startedAt: now, observedSince: now, observedAt: now, logicalRequests: 0, untrackedRequests: 0, requestsWithoutExecution: 0, executions: emptyUsageExecutionCounts(), completedAttempts: 0, usageCompleteAttempts: 0,
  missingUsageAttempts: 0, costFullyPricedAttempts: 0, costIncompleteAttempts: 0, unknownExecutions: 0,
  unattributedAttempts: 0, cacheEligibleAttempts: 0, cacheInputTokens: 0, cacheReadTokens: 0, totals: emptyTotals(),
  costUsd: 0, hasKnownCost: false, arithmeticOverflow: false,
  warnings: { trackingGap: false, persistenceFailure: false, recovered: false, earlierUnavailable: false }, pending: {}, buckets: {}, overflow: [],
})
export const createUsageEnvelope = (sessionId: string, now: number, generation = 1): UsageEnvelope => ({ version: USAGE_VERSION, activeSessionId: sessionId, ownerGeneration: generation, revision: 0, sessions: [blankSession(sessionId, now)] })

const sessionOf = (envelope: UsageEnvelope, id: string) => envelope.sessions.find(session => session.id === id)
const bump = (value: number, amount: number, session?: UsageSession) => {
  const next = value + amount
  if (!Number.isSafeInteger(next)) {
    if (session) { session.arithmeticOverflow = true; session.warnings.trackingGap = true }
    return Number.MAX_SAFE_INTEGER
  }
  return next
}
function addMeasure(totals: Totals, category: Category, measure: Measure, session: UsageSession, partial = false) {
  if (measure.status === 'notApplicable') return
  const current = totals[category]
  if (measure.status === 'unknown') current.unknown = bump(current.unknown, 1, session)
  else if (partial) current.partial = bump(current.partial, measure.count, session)
  else current.count = bump(current.count, measure.count, session)
}
const evidenceValues = (evidence: UsageEvidence): Record<Category, Measure> => ({ totalInput: evidence.totalInput, input: evidence.input, output: evidence.output, cacheRead: evidence.cacheRead, cacheWrite: evidence.cacheWrite, cacheWrite5m: evidence.cacheWrite5m, cacheWrite1h: evidence.cacheWrite1h, reasoning: evidence.reasoning })
const counter = () => Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0])) as Record<AttemptOutcome, number>
const modelIdentity = (snapshot: UsageSnapshot, purpose: UsagePurpose, owner: UsageOwner) => JSON.stringify([snapshot.target, purpose, owner])

function bucketFor(session: UsageSession, snapshot: UsageSnapshot, purpose: UsagePurpose, owner: UsageOwner): UsageBucket {
  const id = modelIdentity(snapshot, purpose, owner)
  const current = session.buckets[id]
  if (current !== undefined) return current
  const bucket: UsageBucket = {
    target: snapshot.target, ...(snapshot.label === snapshot.target || snapshot.label.length > 512 ? {} : { label: snapshot.label }),
    purpose, owner,
    requests: 0, executions: emptyUsageExecutionCounts(), attempts: 0, unknownExecutions: 0, cacheEligibleAttempts: 0, cacheInputTokens: 0, cacheReadTokens: 0, outcomes: counter(), totals: emptyTotals(), costUsd: 0,
    hasKnownCost: false, costIncompleteAttempts: 0, fullyPricedAttempts: 0, arithmeticOverflow: false,
  }
  session.buckets[id] = bucket
  return bucket
}
function recordTotals(session: UsageSession, bucket: UsageBucket | undefined, values: Record<Category, Measure>, partial = false) {
  for (const category of CATEGORIES) {
    addMeasure(session.totals, category, values[category], session, partial)
    if (bucket !== undefined) addMeasure(bucket.totals, category, values[category], session, partial)
  }
}

function tokenMatches(pending: PendingUsage | undefined, token: UsageToken): pending is PendingUsage {
  return pending !== undefined && pending.requestId === token.id && pending.sessionId === token.sessionId && pending.generation === token.generation && pending.sequence === token.sequence
}
function update(envelope: UsageEnvelope, action: UsageAction): UsageEnvelope {
  const next = structuredClone(envelope)
  const now = action.type === 'begin' ? action.pending.startedAt : action.type === 'settle' ? action.at : undefined
  const sessionId = action.type === 'begin' ? action.pending.sessionId : action.type === 'gap' ? action.sessionId ?? next.activeSessionId : action.token.sessionId
  const session = sessionOf(next, sessionId)
  if (session === undefined) return envelope
  if (now !== undefined) session.observedAt = Math.max(session.observedAt, now)
  if (action.type === 'begin' && session.observedSince === null) session.observedSince = action.pending.startedAt
  if (action.type === 'gap') { session.warnings.trackingGap = true; next.revision++; return next }
  if (action.type === 'begin') {
    const p = action.pending
    if (next.activeSessionId !== p.sessionId || next.ownerGeneration !== p.generation || Object.hasOwn(session.pending, p.requestId)) return envelope
    if (Object.keys(session.pending).length >= USAGE_PENDING_MAX) {
      session.untrackedRequests = bump(session.untrackedRequests, 1, session)
      session.warnings.trackingGap = true
    } else {
      session.logicalRequests = bump(session.logicalRequests, 1, session)
      session.pending[p.requestId] = p
    }
    next.revision++
    return next
  }
  const pending = session.pending[action.token.id]
  if (!tokenMatches(pending, action.token) || action.token.generation !== next.ownerGeneration) return envelope
  if (action.type === 'dispatch') {
    if (!USAGE_UUID.test(action.executionId) || Object.keys(pending.executions).length >= USAGE_EXECUTIONS_MAX && pending.executions[action.executionId] === undefined) {
      session.warnings.trackingGap = true
      next.revision++
      return next
    }
    const execution = pending.executions[action.executionId]
    if (execution === undefined) pending.executions[action.executionId] = { snapshot: action.snapshot }
    else if (JSON.stringify(execution.snapshot) !== JSON.stringify(action.snapshot)) { execution.conflict = true; session.warnings.trackingGap = true }
  } else if (action.type === 'summary') {
    const execution = pending.executions[action.summary.executionId]
    if (execution === undefined) { session.warnings.trackingGap = true; next.revision++; return next }
    if (execution.summary === undefined) execution.summary = action.summary
    else if (JSON.stringify(execution.summary) !== JSON.stringify(action.summary)) { execution.conflict = true; session.warnings.trackingGap = true }
  } else if (action.type === 'missing') {
    const execution = pending.executions[action.executionId]
    if (execution !== undefined && execution.summary === undefined) execution.missing = true
  } else if (action.type === 'settle') {
    finalize(session, pending)
    delete session.pending[action.token.id]
  }
  next.revision++
  return next
}

function finalize(session: UsageSession, pending: PendingUsage, dispatchUnknown = false) {
  const executions = Object.entries(pending.executions)
  if (dispatchUnknown) session.warnings.trackingGap = true
  if (executions.length === 0 && !dispatchUnknown) session.requestsWithoutExecution = bump(session.requestsWithoutExecution, 1, session)
  const modelRequests = new Map<string, UsageBucket | undefined>()
  for (const [, execution] of executions) {
    const snapshot = execution.snapshot
    const bucket = snapshot === undefined ? undefined : bucketFor(session, snapshot, pending.purpose, pending.owner)
    if (snapshot !== undefined && !modelRequests.has(snapshot.target)) {
      modelRequests.set(snapshot.target, bucket)
    }
    if (execution.summary === undefined) {
      session.unknownExecutions = bump(session.unknownExecutions, 1, session)
      session.warnings.trackingGap = true
      if (bucket !== undefined) bucket.unknownExecutions = bump(bucket.unknownExecutions, 1, session)
      continue
    }
    session.executions[execution.summary.outcome] = bump(session.executions[execution.summary.outcome], 1, session)
    if (bucket !== undefined) bucket.executions[execution.summary.outcome] = bump(bucket.executions[execution.summary.outcome], 1, session)
    for (const attempt of execution.summary.attempts) {
      session.completedAttempts = bump(session.completedAttempts, 1, session)
      if (bucket === undefined) {
        session.unattributedAttempts = bump(session.unattributedAttempts, 1, session)
      } else {
        bucket.attempts = bump(bucket.attempts, 1, session)
        bucket.outcomes[attempt.outcome] = bump(bucket.outcomes[attempt.outcome], 1, session)
      }
      const evidence = attempt.evidence === undefined ? undefined : validateUsageEvidence(attempt.evidence)
      const usable = execution.conflict === true && evidence !== undefined ? { ...evidence, finality: 'provisional' as const } : evidence
      if (usable === undefined || usable.finality !== 'final') session.missingUsageAttempts = bump(session.missingUsageAttempts, 1, session)
      if (usable !== undefined) {
        const values = evidenceValues(usable)
        recordTotals(session, bucket, values, usable.finality !== 'final')
        if (usable.finality === 'final') {
          if (usable.totalInput.status === 'reported' && usable.output.status === 'reported') session.usageCompleteAttempts = bump(session.usageCompleteAttempts, 1, session)
          const partitionComplete = usable.totalInput.status === 'reported' && usable.input.status === 'reported' && usable.cacheRead.status === 'reported' && (usable.cacheWrite.status === 'notApplicable' || usable.cacheWrite.status === 'reported')
          if (partitionComplete) {
            session.cacheEligibleAttempts = bump(session.cacheEligibleAttempts, 1, session)
            if (usable.totalInput.status === 'reported' && usable.cacheRead.status === 'reported') {
              session.cacheInputTokens = bump(session.cacheInputTokens, usable.totalInput.count, session)
              session.cacheReadTokens = bump(session.cacheReadTokens, usable.cacheRead.count, session)
              if (bucket !== undefined) {
                bucket.cacheEligibleAttempts = bump(bucket.cacheEligibleAttempts, 1, session)
                bucket.cacheInputTokens = bump(bucket.cacheInputTokens, usable.totalInput.count, session)
                bucket.cacheReadTokens = bump(bucket.cacheReadTokens, usable.cacheRead.count, session)
              }
            }
          }
        }
      } else {
        const unavailable = Object.fromEntries(CATEGORIES.map(category => [category, { status: 'unknown' as const }])) as Record<Category, Measure>
        recordTotals(session, bucket, unavailable)
        if (bucket === undefined) session.warnings.trackingGap = true
      }
      const cost = valueUsage(usable, snapshot?.pricing)
      if (cost.hasKnown) { session.hasKnownCost = true; session.costUsd = addUsd(session.costUsd, cost.value, session) }
      if (!cost.complete || usable?.finality !== 'final') session.costIncompleteAttempts = bump(session.costIncompleteAttempts, 1, session)
      if (cost.complete && usable?.finality === 'final') session.costFullyPricedAttempts = bump(session.costFullyPricedAttempts, 1, session)
      if (bucket !== undefined) {
        if (cost.hasKnown) { bucket.hasKnownCost = true; bucket.costUsd = addUsd(bucket.costUsd, cost.value, session, bucket) }
        if (!cost.complete || usable?.finality !== 'final') bucket.costIncompleteAttempts = bump(bucket.costIncompleteAttempts, 1, session)
        if (cost.complete && usable?.finality === 'final') bucket.fullyPricedAttempts = bump(bucket.fullyPricedAttempts, 1, session)
        if (cost.overflow) { bucket.arithmeticOverflow = true; session.arithmeticOverflow = true; session.warnings.trackingGap = true }
      }
      if (cost.overflow) { session.arithmeticOverflow = true; session.warnings.trackingGap = true }
    }
  }
  for (const bucket of modelRequests.values()) if (bucket !== undefined) bucket.requests = bump(bucket.requests, 1, session)
}
function addUsd(current: number, add: number, session: UsageSession, bucket?: UsageBucket) {
  const value = current + add
  if (!Number.isFinite(value)) {
    session.arithmeticOverflow = true
    session.warnings.trackingGap = true
    if (bucket !== undefined) bucket.arithmeticOverflow = true
    return current
  }
  return value
}

export const reduceUsage = (envelope: UsageEnvelope, action: UsageAction): UsageEnvelope => update(envelope, action)

// Session activation preserves prior records until the host removes their known transcripts.
export function activateUsageSession(envelope: UsageEnvelope, sessionId: string, now: number): UsageEnvelope {
  if (!safeUsageId(sessionId)) return envelope
  const next = structuredClone(envelope)
  let session = next.sessions.find(item => item.id === sessionId)
  if (session === undefined) session = blankSession(sessionId, now)
  else session.observedAt = Math.max(session.observedAt, now)
  next.sessions = [session, ...next.sessions.filter(item => item.id !== sessionId)]
  next.activeSessionId = sessionId
  next.revision++
  return next
}

export function interruptPending(envelope: UsageEnvelope, at: number, generation: number): UsageEnvelope {
  const next = structuredClone(envelope)
  for (const session of next.sessions) {
    for (const pending of Object.values(session.pending)) {
      if (pending.generation !== generation) continue
      finalize(session, pending, true)
      if (Object.keys(pending.executions).length === 0) {
        session.logicalRequests = Math.max(0, session.logicalRequests - 1)
        session.untrackedRequests = bump(session.untrackedRequests, 1, session)
      }
      delete session.pending[pending.requestId]
    }
  }
  next.ownerGeneration = generation + 1
  next.revision++
  for (const session of next.sessions) session.observedAt = Math.max(session.observedAt, at)
  return next
}

export function markUsageWarning(envelope: UsageEnvelope, key: keyof UsageSession['warnings'], sessionId = envelope.activeSessionId): UsageEnvelope {
  const next = structuredClone(envelope)
  const session = sessionOf(next, sessionId)
  if (session === undefined) return envelope
  session.warnings[key] = true
  next.revision++
  return next
}

export function markUntracked(envelope: UsageEnvelope, sessionId = envelope.activeSessionId, at = Date.now(), count = 1): UsageEnvelope {
  const next = structuredClone(envelope)
  const session = sessionOf(next, sessionId)
  if (session === undefined) return envelope
  const increment = Number.isSafeInteger(count) && count > 0 ? count : 1
  session.untrackedRequests = bump(session.untrackedRequests, increment, session)
  session.observedSince ??= at
  session.observedAt = Math.max(session.observedAt, at)
  session.warnings.trackingGap = true
  next.revision++
  return next
}

export function usageTokenFor(envelope: UsageEnvelope, sequence: number): UsageToken | undefined {
  const sessionId = envelope.activeSessionId
  const session = sessionOf(envelope, sessionId)
  if (session === undefined || Object.keys(session.pending).length >= USAGE_PENDING_MAX) return undefined
  const id = `${sessionId}:${envelope.ownerGeneration}:${sequence}`
  return { id, sessionId, generation: envelope.ownerGeneration, sequence }
}
