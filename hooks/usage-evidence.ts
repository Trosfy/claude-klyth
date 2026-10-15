export type Measure = { status: 'reported'; count: number } | { status: 'unknown' } | { status: 'notApplicable' }
export type UsageProtocol = 'openai' | 'openai-responses' | 'anthropic' | 'bedrock'
export type UsageEvidence = {
  protocol: UsageProtocol
  finality: 'provisional' | 'final'
  totalInput: Measure
  input: Measure
  output: Measure
  cacheRead: Measure
  cacheWrite: Measure
  cacheWrite5m: Measure
  cacheWrite1h: Measure
  reasoning: Measure
}

export type AttemptOutcome = 'success' | 'httpError' | 'transportError' | 'responseError' | 'cut' | 'aborted' | 'unknown'
export type ExecutionOutcome = 'success' | 'failure' | 'refused' | 'aborted'
export type UsageAttemptSummary = { sequence: number; outcome: AttemptOutcome; evidence?: UsageEvidence }
export type UsageExecutionSummary = {
  type: 'usage_summary'
  requestId: string
  executionId: string
  outcome: ExecutionOutcome
  attempts: UsageAttemptSummary[]
}

export const unknownMeasure = (): Measure => ({ status: 'unknown' })
export const notApplicable = (): Measure => ({ status: 'notApplicable' })
export const reported = (count: number): Measure => ({ status: 'reported', count })
export const isEvidenceObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const countOf = (value: unknown): Measure => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? reported(value) : unknownMeasure())
const field = (value: Record<string, unknown>, key: string): Measure => (Object.hasOwn(value, key) ? countOf(value[key]) : unknownMeasure())
const valueOf = (value: Measure): number | undefined => (value.status === 'reported' ? value.count : undefined)
const sum = (...values: number[]): number | undefined => {
  const total = values.reduce((n, value) => n + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

// OpenAI protocols report total input and cache reads; uncached input is valid only when both are known.
export function openAiUsage(raw: unknown, protocol: 'openai' | 'openai-responses', finality: UsageEvidence['finality'] = 'provisional'): UsageEvidence {
  const usage = isEvidenceObject(raw) ? raw : {}
  const detailsKey = protocol === 'openai' ? 'prompt_tokens_details' : 'input_tokens_details'
  const totalInput = field(usage, protocol === 'openai' ? 'prompt_tokens' : 'input_tokens')
  const output = field(usage, protocol === 'openai' ? 'completion_tokens' : 'output_tokens')
  const details = isEvidenceObject(usage[detailsKey]) ? usage[detailsKey] as Record<string, unknown> : {}
  const cacheRead = field(details, 'cached_tokens')
  const total = valueOf(totalInput), cached = valueOf(cacheRead)
  const input = total === undefined || cached === undefined || cached > total ? unknownMeasure() : reported(total - cached)
  const reasoning = field(isEvidenceObject(usage['completion_tokens_details']) ? usage['completion_tokens_details'] as Record<string, unknown> : isEvidenceObject(usage['output_tokens_details']) ? usage['output_tokens_details'] as Record<string, unknown> : {}, 'reasoning_tokens')
  return {
    protocol,
    finality,
    totalInput,
    input,
    output,
    cacheRead: total !== undefined && cached !== undefined && cached > total ? unknownMeasure() : cacheRead,
    cacheWrite: notApplicable(),
    cacheWrite5m: notApplicable(),
    cacheWrite1h: notApplicable(),
    reasoning: valueOf(reasoning) !== undefined && valueOf(output) !== undefined && (valueOf(reasoning) as number) <= (valueOf(output) as number) ? reasoning : unknownMeasure(),
  }
}

export type PartitionFields = {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  reasoning?: string
  cacheWrite5m?: string
  cacheWrite1h?: string
}

// Anthropic and Bedrock expose input and cache buckets separately; total input needs a complete partition.
export function partitionedUsage(raw: unknown, protocol: 'anthropic' | 'bedrock', fields: PartitionFields, finality: UsageEvidence['finality'] = 'provisional'): UsageEvidence {
  const usage = isEvidenceObject(raw) ? raw : {}
  const input = field(usage, fields.input)
  const output = field(usage, fields.output)
  const cacheRead = field(usage, fields.cacheRead)
  const cacheWrite = field(usage, fields.cacheWrite)
  const parts = [valueOf(input), valueOf(cacheRead), valueOf(cacheWrite)]
  const total = parts.every((value): value is number => value !== undefined) ? sum(...parts as number[]) : undefined
  let cacheWrite5m = unknownMeasure()
  let cacheWrite1h = unknownMeasure()
  if (fields.cacheWrite5m !== undefined || fields.cacheWrite1h !== undefined) {
    const five = fields.cacheWrite5m === undefined ? unknownMeasure() : field(usage, fields.cacheWrite5m)
    const hour = fields.cacheWrite1h === undefined ? unknownMeasure() : field(usage, fields.cacheWrite1h)
    const writeTotal = valueOf(cacheWrite), fiveCount = valueOf(five), hourCount = valueOf(hour)
    if (writeTotal === 0) [cacheWrite5m, cacheWrite1h] = [reported(0), reported(0)]
    else if (writeTotal !== undefined && fiveCount !== undefined && hourCount !== undefined && sum(fiveCount, hourCount) === writeTotal) [cacheWrite5m, cacheWrite1h] = [five, hour]
    else if (writeTotal !== undefined && fiveCount === writeTotal && fields.cacheWrite1h !== undefined && !Object.hasOwn(usage, fields.cacheWrite1h)) [cacheWrite5m, cacheWrite1h] = [five, reported(0)]
    else if (writeTotal !== undefined && hourCount === writeTotal && fields.cacheWrite5m !== undefined && !Object.hasOwn(usage, fields.cacheWrite5m)) [cacheWrite5m, cacheWrite1h] = [reported(0), hour]
  } else if (valueOf(cacheWrite) === 0) [cacheWrite5m, cacheWrite1h] = [reported(0), reported(0)]
  return {
    protocol,
    finality,
    totalInput: total === undefined ? unknownMeasure() : reported(total),
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    reasoning: fields.reasoning === undefined ? unknownMeasure() : field(usage, fields.reasoning),
  }
}

function parseMeasure(value: unknown): Measure | undefined {
  if (!isEvidenceObject(value)) return undefined
  if (value['status'] === 'unknown' || value['status'] === 'notApplicable') return Object.keys(value).length === 1 ? value as Measure : undefined
  if (value['status'] === 'reported' && Object.keys(value).length === 2 && typeof value['count'] === 'number' && Number.isSafeInteger(value['count']) && value['count'] >= 0) return value as Measure
  return undefined
}

// Wire evidence is accepted only with its exact bounded shape and internally consistent partitions.
export function validateUsageEvidence(value: unknown): UsageEvidence | undefined {
  if (!isEvidenceObject(value)) return undefined
  const keys = ['protocol', 'finality', 'totalInput', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning']
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return undefined
  if (!(['openai', 'openai-responses', 'anthropic', 'bedrock'] as unknown[]).includes(value['protocol']) || (value['finality'] !== 'provisional' && value['finality'] !== 'final')) return undefined
  const parsed = Object.fromEntries(keys.filter(key => !['protocol', 'finality'].includes(key)).map(key => [key, parseMeasure(value[key])])) as Record<string, Measure | undefined>
  if (Object.values(parsed).some(item => item === undefined)) return undefined
  const evidence = { protocol: value['protocol'], finality: value['finality'], ...parsed } as UsageEvidence
  const total = valueOf(evidence.totalInput), input = valueOf(evidence.input), read = valueOf(evidence.cacheRead), write = valueOf(evidence.cacheWrite)
  if (total !== undefined && input !== undefined && read !== undefined && write !== undefined && sum(input, read, write) !== total) return undefined
  if (evidence.protocol === 'openai' || evidence.protocol === 'openai-responses') {
    if (evidence.cacheWrite.status !== 'notApplicable' || evidence.cacheWrite5m.status !== 'notApplicable' || evidence.cacheWrite1h.status !== 'notApplicable') return undefined
    if (total !== undefined && read !== undefined && (read > total || input === undefined || input + read !== total) || input !== undefined && (total === undefined || read === undefined)) return undefined
  } else {
    const five = valueOf(evidence.cacheWrite5m), hour = valueOf(evidence.cacheWrite1h)
    const completeInput = input !== undefined && read !== undefined && write !== undefined
    const calculated = completeInput ? sum(input, read, write) : undefined
    if (total !== undefined && (!completeInput || calculated !== total) || calculated !== undefined && total === undefined) return undefined
    if ((five !== undefined || hour !== undefined) && write === undefined || five !== undefined && hour !== undefined && write !== undefined && sum(five, hour) !== write) return undefined
  }
  const output = valueOf(evidence.output), reasoning = valueOf(evidence.reasoning)
  if (reasoning !== undefined && output !== undefined && reasoning > output) return undefined
  return evidence
}

// An explicit terminal usage report can be final even when the provider call itself failed.
export const finalEvidence = (evidence: UsageEvidence): UsageEvidence => ({ ...evidence, finality: 'final' })

const EXECUTION_OUTCOMES: readonly ExecutionOutcome[] = ['success', 'failure', 'refused', 'aborted']
const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ['success', 'httpError', 'transportError', 'responseError', 'cut', 'aborted', 'unknown']
export const USAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const boundedId = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

export function validateUsageSummary(value: unknown): UsageExecutionSummary | undefined {
  if (!isEvidenceObject(value)) return undefined
  const keys = ['type', 'requestId', 'executionId', 'outcome', 'attempts']
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return undefined
  if (value['type'] !== 'usage_summary' || !boundedId(value['requestId'], 256) || !boundedId(value['executionId'], 36) || !USAGE_UUID.test(value['executionId'] as string)) return undefined
  if (!EXECUTION_OUTCOMES.includes(value['outcome'] as ExecutionOutcome) || !Array.isArray(value['attempts']) || value['attempts'].length > 10) return undefined
  const attempts: UsageAttemptSummary[] = []
  for (let i = 0; i < value['attempts'].length; i++) {
    const raw = value['attempts'][i]
    if (!isEvidenceObject(raw)) return undefined
    const attemptKeys = ['sequence', 'outcome', 'evidence']
    if (Object.keys(raw).some(key => !attemptKeys.includes(key)) || Object.keys(raw).length !== (Object.hasOwn(raw, 'evidence') ? 3 : 2)) return undefined
    if (raw['sequence'] !== i + 1 || !ATTEMPT_OUTCOMES.includes(raw['outcome'] as AttemptOutcome)) return undefined
    const evidence = Object.hasOwn(raw, 'evidence') ? validateUsageEvidence(raw['evidence']) : undefined
    if (Object.hasOwn(raw, 'evidence') && evidence === undefined) return undefined
    attempts.push({ sequence: i + 1, outcome: raw['outcome'] as AttemptOutcome, ...(evidence === undefined ? {} : { evidence }) })
  }
  return { type: 'usage_summary', requestId: value['requestId'] as string, executionId: value['executionId'] as string, outcome: value['outcome'] as ExecutionOutcome, attempts }
}
