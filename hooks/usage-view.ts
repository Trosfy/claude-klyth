import type { UsageBucket, UsageSession } from './usage-ledger'
import { emptyUsageExecutionCounts, USAGE_EXECUTION_OUTCOMES } from './usage-ledger-codec'
import type { UsageExecutionCounts } from './usage-ledger-codec'

export type UsageModelRow = {
  target: string
  labels: Set<string>
  requests: number
  executions: UsageExecutionCounts
  attempts: number
  unknownExecutions: number
  totals: UsageBucket['totals']
  costUsd: number
  estimatedCost: string
  hasKnownCost: boolean
  costIncompleteAttempts: number
  fullyPricedAttempts: number
  cacheEligibleAttempts: number
  cacheInputTokens: number
  cacheReadTokens: number
  buckets: UsageBucket[]
}

const CATEGORIES = ['totalInput', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning'] as const
const clean = (value: string) => Array.from(value, char => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) ? `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0')}` : char).join('')
export const usageDisplay = (value: string, max = 480) => {
  const safe = clean(value)
  const chars = Array.from(safe)
  return chars.length > max ? `${chars.slice(0, max - 16).join('')}… (truncated)` : safe
}
const integer = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: true }).format(value)
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const executionsText = (counts: UsageExecutionCounts) => USAGE_EXECUTION_OUTCOMES.map(outcome => `${outcome} ${integer(counts[outcome])}`).join(', ')
const amount = (value: number) => {
  if (!Number.isFinite(value)) return 'unavailable'
  if (value === 0) return '$0'
  if (value > 0 && value < 1e-12) return '<$0.000000000001'
  if (value >= 1e21) return `$${String(value)}`
  const fixed = value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
  return `$${fixed}`
}
const percentage = (numerator: number, denominator: number) => `${((numerator / denominator) * 100).toFixed(1)}%`
export const usageCompactNumber = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
export function usageCompactTokens(value: UsageBucket['totals'][keyof UsageBucket['totals']]): string {
  const known = value.unknown > 0 ? value.count === 0 ? 'Unknown' : `${usageCompactNumber(value.count)} + ?` : usageCompactNumber(value.count)
  return value.partial > 0 ? `${known} + provisional` : known
}
export const usageCacheRatio = (reads: number, input: number) => input > 0 ? percentage(reads, input) : 'n/a'
function qualifiedCount(session: UsageSession, category: keyof UsageSession['totals'], label: string): string {
  const item = session.totals[category]
  const qualification = item.unknown > 0 ? `, partial (${integer(item.unknown)} attempts unknown)` : ''
  return `${label}: ${integer(item.count)}${qualification}`
}
function costLabel(cost: number, hasKnown: boolean, incomplete: number, session: UsageSession, requests: number) {
  if (requests === 0) return 'unavailable (no routed requests observed)'
  if (session.completedAttempts === 0 && session.unknownExecutions === 0 && session.untrackedRequests === 0) return 'unavailable (no observed attempts)'
  if (!hasKnown) return 'Unidentified cost'
  return incomplete === 0 && session.unknownExecutions === 0 && session.untrackedRequests === 0 && !session.warnings.trackingGap
    ? `Approx. ${amount(cost)}`
    : `${amount(cost)} known + unpriced usage`
}
export type UsageFilter = 'All' | 'Main' | 'Children' | 'Maintenance'
export function usageBucketMatches(bucket: UsageBucket, filter: UsageFilter): boolean {
  return filter === 'All' || (filter === 'Main' ? bucket.purpose === 'step' && bucket.owner === 'main' : filter === 'Children' ? bucket.purpose === 'step' && bucket.owner === 'child' : bucket.purpose !== 'step')
}
function rowsOf(session: UsageSession, filter: UsageFilter): UsageModelRow[] {
  const rows = new Map<string, UsageModelRow>()
  for (const bucket of Object.values(session.buckets)) {
    if (!usageBucketMatches(bucket, filter)) continue
    let row = rows.get(bucket.target)
    if (row === undefined) {
      row = {
        target: bucket.target, labels: new Set(), requests: 0, executions: emptyUsageExecutionCounts(), attempts: 0, unknownExecutions: 0,
        totals: Object.fromEntries(CATEGORIES.map(key => [key, { count: 0, unknown: 0, partial: 0 }])) as UsageBucket['totals'],
        costUsd: 0, estimatedCost: '', hasKnownCost: false, costIncompleteAttempts: 0, fullyPricedAttempts: 0,
        cacheEligibleAttempts: 0, cacheInputTokens: 0, cacheReadTokens: 0, buckets: [],
      }
      rows.set(bucket.target, row)
    }
    if (bucket.label !== undefined) row.labels.add(bucket.label)
    row.requests += bucket.requests
    row.attempts += bucket.attempts
    row.unknownExecutions += bucket.unknownExecutions
    for (const outcome of USAGE_EXECUTION_OUTCOMES) row.executions[outcome] += bucket.executions[outcome]
    row.costUsd += bucket.costUsd
    row.hasKnownCost ||= bucket.hasKnownCost
    row.costIncompleteAttempts += bucket.costIncompleteAttempts
    row.fullyPricedAttempts += bucket.fullyPricedAttempts
    row.cacheEligibleAttempts += bucket.cacheEligibleAttempts
    row.cacheInputTokens += bucket.cacheInputTokens
    row.cacheReadTokens += bucket.cacheReadTokens
    row.buckets.push(bucket)
    for (const key of CATEGORIES) for (const metric of ['count', 'unknown', 'partial'] as const) row.totals[key][metric] += bucket.totals[key][metric]
  }
  for (const row of rows.values()) {
    const overflow = row.buckets.some(bucket => bucket.arithmeticOverflow)
    row.estimatedCost = row.requests === 0 ? 'unavailable (no routed requests observed)' : row.attempts === 0 && row.unknownExecutions === 0 ? 'unavailable (no observed attempts)' : !row.hasKnownCost ? 'Unidentified cost' : row.costIncompleteAttempts === 0 && row.unknownExecutions === 0 && !overflow && session.untrackedRequests === 0 && !session.warnings.trackingGap ? `Approx. ${amount(row.costUsd)}` : `${amount(row.costUsd)} known + unpriced usage`
  }
  return [...rows.values()].sort((a, b) => (b.totals.totalInput.count + b.totals.output.count) - (a.totals.totalInput.count + a.totals.output.count) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
}

const tokenText = (value: UsageBucket['totals'][keyof UsageBucket['totals']]) => `${integer(value.count)}${value.partial > 0 ? ` + ${integer(value.partial)} provisional` : ''}${value.unknown > 0 ? ` (${integer(value.unknown)} unknown)` : ''}`
function cacheText(eligible: number, input: number, reads: number): string {
  if (input === 0) return eligible > 0 ? `Not available (${integer(eligible)} eligible attempts; zero-token denominator)` : 'Not available'
  return `${percentage(reads, input)} (${integer(reads)} / ${integer(input)} tokens; ${integer(eligible)} eligible attempts)`
}
function identityChunks(target: string, always = false): string[] {
  const safe = clean(target)
  const chars = Array.from(safe)
  if (chars.length <= 480 && !always) return []
  const parts: string[] = []
  for (let i = 0; i < chars.length; i += 440) parts.push(chars.slice(i, i + 440).join(''))
  return parts.map((part, i) => `  model identity ${i + 1}/${parts.length}: ${part}`)
}
function purposeLines(row: UsageModelRow): string[] {
  const groups = new Map<string, { purpose: string; owner: string; requests: number; attempts: number; executions: UsageExecutionCounts; buckets: UsageBucket[] }>()
  for (const bucket of row.buckets) {
    const key = `${bucket.purpose}:${bucket.owner}`
    const group = groups.get(key) ?? { purpose: bucket.purpose, owner: bucket.owner, requests: 0, attempts: 0, executions: emptyUsageExecutionCounts(), buckets: [] }
    group.requests += bucket.requests
    group.attempts += bucket.attempts
    for (const outcome of USAGE_EXECUTION_OUTCOMES) group.executions[outcome] += bucket.executions[outcome]
    group.buckets.push(bucket)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => compare(a.purpose, b.purpose) || compare(a.owner, b.owner)).map(group => {
    const attempts = new Map<string, number>()
    for (const bucket of group.buckets) for (const [name, count] of Object.entries(bucket.outcomes)) if (count > 0) attempts.set(name, (attempts.get(name) ?? 0) + count)
    const executionText = USAGE_EXECUTION_OUTCOMES.filter(name => group.executions[name] > 0).map(name => `${name} ${integer(group.executions[name])}`).join(', ') || 'none'
    const attemptText = [...attempts].sort(([a], [b]) => compare(a, b)).map(([name, count]) => `${name} ${integer(count)}`).join(', ') || 'none'
    return `  ${group.purpose} / ${group.owner === 'main' ? 'main' : 'children'}: ${integer(group.requests)} requests, executions ${executionText}, attempts ${integer(group.attempts)} (${attemptText})`
  })
}

export type UsageView = { session: UsageSession; estimatedCost: string; models: UsageModelRow[] }

// Text and the native pane share canonical model aggregation and headline qualification.
export function usageView(session: UsageSession, filter: UsageFilter = 'All'): UsageView {
  return {
    session,
    estimatedCost: costLabel(session.costUsd, session.hasKnownCost, session.costIncompleteAttempts, session, session.logicalRequests + session.untrackedRequests),
    models: rowsOf(session, filter),
  }
}

// A fixed local report. It reads only retained accounting state and the optional plain host context estimate.
export function usageSummary(session: UsageSession, contextTokens?: number): string[] {
  const attempts = session.completedAttempts
  const requests = session.logicalRequests + session.untrackedRequests
  const cost = costLabel(session.costUsd, session.hasKnownCost, session.costIncompleteAttempts, session, requests)
  const pending = Object.keys(session.pending).length
  const context = typeof contextTokens === 'number' && Number.isSafeInteger(contextTokens) && contextTokens >= 0 ? `${integer(contextTokens)} tokens` : 'Not available'
  const lines = [
    'Klyth usage · This session',
    `Estimated cost: ${cost}`,
    `Started: ${new Date(session.startedAt).toISOString()}`,
    `Observed since: ${session.observedSince === null ? 'Not observed yet' : new Date(session.observedSince).toISOString()}`,
    'Scope: routed requests observed by this engine session, including its local children.',
    `Checkpoint: ${session.warnings.persistenceFailure ? 'Not saved' : 'best effort'}`,
    ...(session.warnings.recovered ? ['Recovered checkpoint; an unsaved or interrupted tail may be missing.'] : []),
    ...(session.warnings.earlierUnavailable ? ['Observed since now; earlier usage is unavailable.'] : []),
    `Logical requests: ${integer(requests)} (${integer(session.logicalRequests)} tracked, ${integer(session.untrackedRequests)} untracked)`,
    `Execution outcomes: ${executionsText(session.executions)}; ${integer(session.unknownExecutions)} summaries unknown; ${integer(session.requestsWithoutExecution)} requests had no daemon execution.`,
    qualifiedCount(session, 'totalInput', 'Reported input tokens'),
    qualifiedCount(session, 'output', 'Reported output tokens'),
    ...(session.totals.totalInput.partial > 0 || session.totals.output.partial > 0 ? [`Provisional lower bounds: input ${integer(session.totals.totalInput.partial)}, output ${integer(session.totals.output.partial)}; not added to final totals or cost.`] : []),
    `Cache reuse: ${cacheText(session.cacheEligibleAttempts, session.cacheInputTokens, session.cacheReadTokens)}`,
    `Usage coverage: ${integer(session.usageCompleteAttempts)} / ${integer(attempts)} completed observed attempts reported both input and output; ${integer(pending)} pending.`,
    `Cost coverage: ${integer(session.costFullyPricedAttempts)} / ${integer(attempts)} completed observed attempts fully priceable; ${integer(session.costIncompleteAttempts)} partial or unpriced.`,
    `Unattributed attempts: ${integer(session.unattributedAttempts)}; executions without a summary: ${integer(session.unknownExecutions)}; tracking gaps ${session.warnings.trackingGap ? 'present' : 'none'} (${integer(session.untrackedRequests)} untracked requests).`,
    'Configured rates value reported usage. This is not a provider invoice or an incremental subscription charge.',
    `Current context (host estimate): ${context}`,
  ]
  if (session.arithmeticOverflow) lines.push('Some accumulated values exceeded safe numeric bounds; affected totals are partial.')
  return lines
}

export function usageModelDetails(row: UsageModelRow): string[] {
  return [
    ...identityChunks(row.target, true),
    ...[...row.labels].sort().flatMap(alias => identityChunks(alias, true).map(line => line.replace('model identity', 'alias identity'))),
    ...CATEGORIES.map(category => `${category === 'reasoning' ? 'reasoning (output subset)' : category}: ${tokenText(row.totals[category])}`),
    `Executions: ${executionsText(row.executions)}`,
    `Attempts: ${integer(row.attempts)}; ${integer(row.unknownExecutions)} summaries unknown`,
    `Cost coverage: ${integer(row.fullyPricedAttempts)} / ${integer(row.attempts)} fully priceable; ${integer(row.costIncompleteAttempts)} partial or unpriced`,
    ...purposeLines(row),
  ].flatMap(line => {
    const chunks: string[] = []
    let chunk = ''
    for (const char of line) {
      if (chunk.length + char.length > 480) { chunks.push(chunk); chunk = '' }
      chunk += char
    }
    if (chunk.length > 0) chunks.push(chunk)
    return chunks
  })
}

export function usageText(session: UsageSession, contextTokens?: number): string[] {
  const lines = usageSummary(session, contextTokens)
  const rows = usageView(session).models
  if (rows.length === 0) lines.push('Models: none observed')
  else {
    lines.push('Models (canonical provider/model; aliases are secondary):')
    for (const row of rows) {
      const alias = [...row.labels].sort()[0]
      const name = usageDisplay(row.target)
      const aliasText = alias === undefined ? '' : ` (via ${usageDisplay(alias)})`
      lines.push(`  ${name}${aliasText}: ${integer(row.requests)} requests; input ${tokenText(row.totals.totalInput)}; output ${tokenText(row.totals.output)}; cache ${cacheText(row.cacheEligibleAttempts, row.cacheInputTokens, row.cacheReadTokens)}; ${row.estimatedCost}`)
      lines.push(...identityChunks(row.target), ...purposeLines(row))
    }
  }
  if (session.overflow.length > 0) {
    lines.push('Historical unattributed totals (cost remains unknown):')
    for (const item of [...session.overflow].sort((a, b) => compare(a.purpose, b.purpose) || compare(a.owner, b.owner))) {
      const countText = (value: UsageBucket['totals'][keyof UsageBucket['totals']]) => `${integer(value.count)}${value.partial > 0 ? ` + ${integer(value.partial)} provisional` : ''}${value.unknown > 0 ? ` (${integer(value.unknown)} unknown)` : ''}`
      lines.push(`  ${item.purpose}/${item.owner}: ${integer(item.requests)} requests, executions ${executionsText(item.executions)}, ${integer(item.attempts)} attempts, input ${countText(item.totals.totalInput)}, output ${countText(item.totals.output)}`)
    }
  }
  return lines.map(line => Array.from(line).length <= 1800 ? line : `${Array.from(line).slice(0, 1760).join('')}… (line shortened; full identity follows in chunks)`)
}

export function usageCommand(args: string, session: UsageSession | undefined, contextTokens?: number): string[] | undefined {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts[0] !== 'usage') return undefined
  if (parts.length > 1 && !(parts.length === 2 && parts[1] === 'text')) return ['klyth usage: use `/klyth usage` or `/klyth usage text`.']
  if (session === undefined) return ['klyth usage: no session accounting state is available yet.']
  return usageText(session, contextTokens)
}
