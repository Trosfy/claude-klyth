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
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 15)).join('')}... (shortened)` : safe
}
const shortenName = (value: string, max: number) => {
  const chars = Array.from(clean(value))
  if (chars.length <= max) return chars.join('')
  const room = Math.max(2, max - 15), start = Math.ceil(room / 2)
  return `${chars.slice(0, start).join('')}...${chars.slice(-(room - start)).join('')} (shortened)`
}
export function usageModelName(target: string, max: number): string {
  const slash = target.indexOf('/')
  if (slash < 0) return shortenName(target, max)
  const provider = target.slice(0, slash), model = target.slice(slash + 1)
  const providerRoom = Math.min(Array.from(clean(provider)).length, Math.max(18, Math.floor((max - 1) / 2)))
  return `${shortenName(provider, providerRoom)}/${shortenName(model, max - providerRoom - 1)}`
}
export function usageModelNames(targets: string[], max: number): Map<string, string> {
  const labels = new Map(targets.map(target => [target, usageModelName(target, max)]))
  const counts = new Map<string, number>()
  for (const label of labels.values()) counts.set(label, (counts.get(label) ?? 0) + 1)
  const used = new Set(labels.values())
  for (const target of [...labels.keys()].sort()) {
    if (counts.get(labels.get(target)!) === 1) continue
    let index = 1, label: string
    do {
      const suffix = ` [${index++}]`
      label = usageModelName(target, max - suffix.length) + suffix
    } while (used.has(label))
    used.add(label)
    labels.set(target, label)
  }
  return labels
}
const integer = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: true }).format(value)
export const usageCount = (value: number, singular: string) => `${integer(value)} ${singular}${value === 1 ? '' : 's'}`
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const RESULT_LABELS = { success: 'Completed', failure: 'Failed', refused: 'Refused', aborted: 'Stopped', responseError: 'Response errors', httpError: 'HTTP errors', transportError: 'Connection errors', cut: 'Incomplete streams', unknown: 'Unknown' }
const executionsText = (counts: UsageExecutionCounts) => USAGE_EXECUTION_OUTCOMES.map(outcome => `${RESULT_LABELS[outcome].toLowerCase()} ${integer(counts[outcome])}`).join(', ')
const amount = (value: number, lowerBound = false) => {
  if (!Number.isFinite(value)) return 'Not available'
  if (value > 0 && value < 1e-12) {
    if (!lowerBound) return 'Less than $0.000000000001'
    const [digits, exponent] = String(value).split('e-')
    return `$0.${'0'.repeat(Number(exponent) - 1)}${digits!.replace('.', '')}`
  }
  return `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 12, useGrouping: true }).format(value)}`
}
const percentage = (numerator: number, denominator: number) => `${((numerator / denominator) * 100).toFixed(1)}%`
export const usageNumber = integer
const partialText = (count: number) => `Other calls reported at least ${usageCount(count, 'token')}. Their final counts are not available.`
export function usageCompactTokens(value: UsageBucket['totals'][keyof UsageBucket['totals']]): string {
  const known = value.unknown > 0 ? value.count === 0 ? 'No token count' : `${usageCount(value.count, 'token')}. Some counts are missing.` : integer(value.count)
  return value.partial > 0 ? `${value.unknown > 0 && value.count === 0 ? 'No final token count' : usageCount(value.count, 'final token')}. ${partialText(value.partial)}${value.unknown > 0 ? ' Some counts are missing.' : ''}` : known
}
export const usageCacheRatio = (reads: number, input: number) => input > 0 ? percentage(reads, input) : 'Not available'
export const USAGE_HEADING = 'Klyth usage: routed work in this session'
export const USAGE_UNAVAILABLE = ['Estimated cost: Not available', 'Klyth has no usage record for this session.', 'Run a request through Klyth, then open usage again.']
export type UsageRecordState = 'active' | 'fenced'
export function usageWarning(session: UsageSession, state: UsageRecordState = 'active'): string[] {
  if (state === 'fenced') return ['Klyth cannot update this usage record. Totals may be incomplete.', 'Print this report to keep the current totals.']
  if (session.warnings.persistenceFailure) return ['Klyth could not save usage. Totals may be incomplete.', 'Print this report to keep the current totals.']
  if (session.warnings.trackingGap || session.unknownExecutions > 0 || session.untrackedRequests > 0 || session.missingUsageAttempts > 0 || session.arithmeticOverflow) return ['Some requests have no usage data. Totals may be incomplete.', 'Open Session details to see which requests have usage data.']
  if (session.warnings.recovered || session.warnings.earlierUnavailable) return ['Earlier usage may be missing. Open Session details.']
  return []
}
export function usageEmptyModels(session: UsageSession): { pane: string[]; report: string[] } {
  const empty = session.logicalRequests + session.untrackedRequests === 0
  return {
    pane: [empty ? 'Klyth has not sent a request in this session.' : 'Klyth has no usage data for a model yet.', empty ? 'Run a request through Klyth to see usage.' : 'Open Session details to see which requests have usage data.'],
    // The report keeps one sentence for both cases on purpose; to change it is a copy change, not a cleanup.
    report: ['Klyth has no usage data for a model yet. Run a request through Klyth.'],
  }
}
function qualifiedCount(session: UsageSession, category: keyof UsageSession['totals'], label: string): string {
  return `${label}: ${tokenText(session.totals[category])}`
}
type CostFacts = {
  cost: number; hasKnown: boolean; incomplete: number; requests: number; attempts: number; unknown: number
  pending: number; untracked: number; hasGap: boolean; state: UsageRecordState; totals: UsageSession['totals']
}
function costLabel({ cost, hasKnown, incomplete, requests, attempts, unknown, pending, untracked, hasGap, state, totals }: CostFacts) {
  if (state === 'fenced') return 'Not available. Klyth cannot update this usage record.'
  if (requests === 0) return 'No requests yet. Run a request through Klyth to see usage.'
  if (attempts === 0 && pending > 0) return 'Work in progress. Wait for the request to finish.'
  if (attempts === 0 && unknown === 0 && untracked === 0) return 'Not available. No provider calls have usage data. Run another request through Klyth.'
  const missingCounts = ['totalInput', 'input', 'output', 'cacheRead', 'cacheWrite'].some(key => totals[key as keyof typeof totals].unknown > 0)
  const partialCounts = CATEGORIES.some(key => totals[key].partial > 0)
  const gap = unknown > 0 || untracked > 0 || hasGap
  const reason = partialCounts ? 'Some calls have no final token counts. Open Session details.' : incomplete > 0 ? missingCounts ? 'Some token counts are missing. Run another request to check usage data.' : 'Some usage has no cost estimate. Add model prices under pricing in klyth.json.' : gap ? 'Some usage data is missing. Open Session details.' : ''
  if (!hasKnown) return `Not available. ${reason || 'Run another request through Klyth to check usage data.'}`
  return reason ? `At least ${amount(cost, true)}. ${reason}` : amount(cost)
}
export type UsageFilter = 'All' | 'Main' | 'Children' | 'Maintenance'
export function usageBucketMatches(bucket: UsageBucket, filter: UsageFilter): boolean {
  return filter === 'All' || (filter === 'Main' ? bucket.purpose === 'step' && bucket.owner === 'main' : filter === 'Children' ? bucket.purpose === 'step' && bucket.owner === 'child' : bucket.purpose !== 'step')
}
function rowsOf(session: UsageSession, filter: UsageFilter, state: UsageRecordState): UsageModelRow[] {
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
    row.estimatedCost = costLabel({
      cost: row.costUsd, hasKnown: row.hasKnownCost, incomplete: row.costIncompleteAttempts, requests: row.requests,
      totals: row.totals, attempts: row.attempts, unknown: row.unknownExecutions, state, pending: 0,
      untracked: session.untrackedRequests, hasGap: session.warnings.trackingGap || overflow,
    })
  }
  return [...rows.values()].sort((a, b) => (b.totals.totalInput.count + b.totals.output.count) - (a.totals.totalInput.count + a.totals.output.count) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
}

const tokenText = (value: UsageBucket['totals'][keyof UsageBucket['totals']]) => {
  const count = value.unknown > 0 && value.count === 0 ? `No count for ${usageCount(value.unknown, 'provider call')}` : integer(value.count)
  return `${count}${value.partial > 0 ? `. ${partialText(value.partial)}` : ''}${value.unknown > 0 && value.count > 0 ? `. ${usageCount(value.unknown, 'provider call')} ${value.unknown === 1 ? 'has' : 'have'} no token count.` : ''}`
}
function cacheText(eligible: number, input: number, reads: number): string {
  if (input === 0) return eligible > 0 ? `Not available. ${usageCount(eligible, 'provider call')} reported zero input tokens.` : 'Not available. Klyth has no usable cache counts.'
  return `${percentage(reads, input)}. ${integer(reads)} of ${usageCount(input, 'input token')} came from cache across ${usageCount(eligible, 'provider call')}.`
}
const purposeName = (purpose: string, owner: string) => purpose === 'step' ? owner === 'main' ? 'Main conversation' : 'Subagents' : `${purpose === 'classifier' ? 'Auto mode checks' : 'Conversation summaries'}${owner === 'child' ? ' for subagents' : ''}`
function identityChunks(target: string, always = false): string[] {
  const safe = clean(target)
  const chars = Array.from(safe)
  if (chars.length <= 480 && !always) return []
  const parts: string[] = []
  for (let i = 0; i < chars.length; i += 440) parts.push(chars.slice(i, i + 440).join(''))
  return parts.map((part, i) => `Full model name, part ${i + 1} of ${parts.length}: ${part}`)
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
    return [
      purposeName(group.purpose, group.owner),
      `Requests: ${integer(group.requests)}`,
      `Runs: ${executionsText(group.executions)}`,
      `Provider calls: ${integer(group.attempts)}`,
      ...[...attempts].sort(([a], [b]) => compare(a, b)).map(([name, count]) => `${RESULT_LABELS[name as keyof typeof RESULT_LABELS]}: ${integer(count)}`),
    ].join('\n')
  }).flatMap(line => line.split('\n'))
}

export type UsageView = { session: UsageSession; estimatedCost: string; models: UsageModelRow[] }

// Text and the native pane share canonical model aggregation and headline qualification.
export function usageView(session: UsageSession, filter: UsageFilter = 'All', state: UsageRecordState = 'active'): UsageView {
  return {
    session,
    estimatedCost: costLabel({
      cost: session.costUsd, hasKnown: session.hasKnownCost, incomplete: session.costIncompleteAttempts,
      requests: session.logicalRequests + session.untrackedRequests, totals: session.totals, attempts: session.completedAttempts,
      unknown: session.unknownExecutions, state, pending: Object.keys(session.pending).length,
      untracked: session.untrackedRequests, hasGap: session.warnings.trackingGap || session.arithmeticOverflow,
    }),
    models: rowsOf(session, filter, state),
  }
}

const date = (value: number) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(value) + ' UTC'

// Session diagnostics are shared by the pane and the text report.
export function usageSummary(session: UsageSession, contextTokens?: number, state: UsageRecordState = 'active'): string[] {
  const attempts = integer(session.completedAttempts)
  const pending = integer(Object.keys(session.pending).length)
  const context = typeof contextTokens === 'number' && Number.isSafeInteger(contextTokens) && contextTokens >= 0 ? `About ${usageCount(contextTokens, 'token')}. This is not total usage.` : 'Not available. Open usage after the next request.'
  return [
    `Session start: ${date(session.startedAt)}`,
    `Usage count start: ${session.observedSince === null ? 'Klyth has not counted usage yet. Run a request through Klyth.' : date(session.observedSince)}`,
    'Includes requests through Klyth in this session and its subagents.',
    'A request is one routed unit of work. A run is one Klyth execution.',
    'A provider call is one attempt, including a retry.',
    ...(session.warnings.persistenceFailure ? [] : ['Klyth tries to save usage. A saved copy may omit recent requests.']),
    ...(session.warnings.recovered ? ['Klyth read a saved usage record. Recent requests may be missing.'] : []),
    ...(session.warnings.earlierUnavailable ? ['This record excludes earlier usage. See Usage count start for the start time.'] : []),
    `Requests: ${integer(session.logicalRequests + session.untrackedRequests)}`,
    `Requests with records: ${integer(session.logicalRequests)}`,
    `Requests without records: ${integer(session.untrackedRequests)}`,
    `Runs: ${executionsText(session.executions)}`,
    `Runs with no result: ${integer(session.unknownExecutions)}`,
    `Requests with no run: ${integer(session.requestsWithoutExecution)}`,
    qualifiedCount(session, 'totalInput', 'Reported input tokens'),
    qualifiedCount(session, 'output', 'Reported output tokens'),
    ...(session.totals.totalInput.partial > 0 || session.totals.output.partial > 0 ? [`Minimum counts without final data: input ${integer(session.totals.totalInput.partial)}, output ${integer(session.totals.output.partial)}.`, 'These counts do not affect final totals or cost.'] : []),
    `Input tokens from cache: ${cacheText(session.cacheEligibleAttempts, session.cacheInputTokens, session.cacheReadTokens)}`,
    `Provider calls with input and output counts: ${integer(session.usageCompleteAttempts)} of ${attempts}`,
    `${state === 'fenced' ? 'Requests without final records' : 'Requests in progress'}: ${pending}`,
    `Provider calls with complete cost estimates: ${integer(session.costFullyPricedAttempts)} of ${attempts}`,
    `Calls with incomplete estimates: ${integer(session.costIncompleteAttempts)}`,
    `Calls with no model name: ${integer(session.unattributedAttempts)}`,
    `Gaps in usage records: ${session.warnings.trackingGap ? 'present' : 'none'}`,
    'Klyth uses your model prices to estimate cost.',
    'This estimate is not a bill or an extra subscription charge.',
    `Current conversation size: ${context}`,
    ...(session.arithmeticOverflow ? ['Some counts exceeded the number limit. Those totals are incomplete.'] : []),
  ]
}

const CATEGORY_LABELS = ['Total input tokens', 'Input tokens outside cache', 'Output tokens', 'Input tokens from cache', 'Input tokens saved in cache', 'Tokens saved for 5 minutes', 'Tokens saved for 1 hour', 'Reasoning tokens within output']
export function usageModelDetails(row: UsageModelRow): string[] {
  return [
    ...identityChunks(row.target, true),
    ...[...row.labels].sort().flatMap(alias => identityChunks(alias, true).map(line => line.replace('Full model name', 'Model shortcut'))),
    ...CATEGORIES.map((category, i) => `${CATEGORY_LABELS[i]}: ${tokenText(row.totals[category])}`),
    `Runs: ${executionsText(row.executions)}`,
    `Provider calls: ${integer(row.attempts)}`, `Runs with no result: ${integer(row.unknownExecutions)}`,
    `Provider calls with complete cost estimates: ${integer(row.fullyPricedAttempts)} of ${integer(row.attempts)}`, `Calls with incomplete estimates: ${integer(row.costIncompleteAttempts)}`,
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

export function usageText(session: UsageSession | undefined, contextTokens?: number, state: UsageRecordState = 'active'): string[] {
  if (session === undefined) return [USAGE_HEADING, ...USAGE_UNAVAILABLE]
  const lines = [USAGE_HEADING, `Estimated cost: ${usageView(session, 'All', state).estimatedCost}`, ...usageWarning(session, state)]
  const rows = usageView(session, 'All', state).models
  if (rows.length === 0) lines.push(...usageEmptyModels(session).report)
  else {
    lines.push('Models by provider and model name:')
    for (const row of rows) {
      lines.push(`Model: ${usageDisplay(row.target)}`, ...identityChunks(row.target))
      for (const alias of [...row.labels].sort()) lines.push(...identityChunks(alias, true).map(line => line.replace('Full model name', 'Model shortcut')))
      lines.push(`Requests: ${integer(row.requests)}`, `Input tokens: ${tokenText(row.totals.totalInput)}`, `Output tokens: ${tokenText(row.totals.output)}`, `Input tokens from cache: ${cacheText(row.cacheEligibleAttempts, row.cacheInputTokens, row.cacheReadTokens)}`, `Estimated cost: ${row.estimatedCost}`)
    }
  }
  lines.push('Session details', ...usageSummary(session, contextTokens, state))
  if (session.overflow.length > 0) {
    lines.push('Earlier usage with no model name. Cost: Not available. Open Session details to check for gaps.')
    for (const item of [...session.overflow].sort((a, b) => compare(a.purpose, b.purpose) || compare(a.owner, b.owner))) {
      lines.push(`Earlier usage: ${purposeName(item.purpose, item.owner)}`, `Requests: ${integer(item.requests)}`, `Runs: ${executionsText(item.executions)}`, `Provider calls: ${integer(item.attempts)}`, `Input tokens: ${tokenText(item.totals.totalInput)}`, `Output tokens: ${tokenText(item.totals.output)}`)
    }
  }
  return lines
}

export function usageCommand(args: string, session: UsageSession | undefined, contextTokens?: number): string[] | undefined {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts[0] !== 'usage') return undefined
  if (parts.length > 1 && !(parts.length === 2 && parts[1] === 'text')) return ['Use `/klyth usage` or `/klyth usage text`.']
  return usageText(session, contextTokens)
}
