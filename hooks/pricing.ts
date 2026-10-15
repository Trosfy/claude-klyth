import type { Measure, UsageEvidence } from './usage-evidence'

// User-supplied USD rates for the token categories a provider reports.
export type TokenRates = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number | { '5m'?: number; '1h'?: number }
}

export type Pricing = { currency: 'USD'; perMillionTokens: TokenRates; tiers?: { aboveInputTokens: number; perMillionTokens: TokenRates }[] }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown key`)
}

function rate(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${path}: must be a finite nonnegative number`)
    return undefined
  }
  return value
}

function parseRates(rates: unknown, path: string, errors: string[]): TokenRates | undefined {
  if (!object(rates)) {
    errors.push(`${path}: must be an object`)
    return undefined
  }
  keys(rates, ['input', 'output', 'cacheRead', 'cacheWrite'], path, errors)
  const parsed: TokenRates = {}
  for (const key of ['input', 'output', 'cacheRead'] as const) {
    if (Object.hasOwn(rates, key)) {
      const amount = rate(rates[key], `${path}.${key}`, errors)
      if (amount !== undefined) parsed[key] = amount
    }
  }
  if (Object.hasOwn(rates, 'cacheWrite')) {
    const writes = rates['cacheWrite']
    if (typeof writes === 'number') {
      const amount = rate(writes, `${path}.cacheWrite`, errors)
      if (amount !== undefined) parsed.cacheWrite = amount
    } else if (object(writes)) {
      keys(writes, ['5m', '1h'], `${path}.cacheWrite`, errors)
      const variants: { '5m'?: number; '1h'?: number } = {}
      for (const ttl of ['5m', '1h'] as const) {
        if (!Object.hasOwn(writes, ttl)) continue
        const amount = rate(writes[ttl], `${path}.cacheWrite.${ttl}`, errors)
        if (amount !== undefined) variants[ttl] = amount
      }
      parsed.cacheWrite = variants
    } else errors.push(`${path}.cacheWrite: must be a number or an object with "5m" and/or "1h" rates`)
  }
  return parsed
}

// Pricing is strict metadata. An omitted rate means that category cannot be valued.
export function parsePricing(value: unknown, path: string, errors: string[]): Pricing | undefined {
  if (value === undefined) return undefined
  const before = errors.length
  if (!object(value)) {
    errors.push(`${path}: must be an object`)
    return undefined
  }
  keys(value, ['currency', 'perMillionTokens', 'tiers'], path, errors)
  if (value['currency'] !== 'USD') errors.push(`${path}.currency: must be "USD"`)
  const perMillionTokens = parseRates(value['perMillionTokens'], `${path}.perMillionTokens`, errors)
  const tiers: NonNullable<Pricing['tiers']> = []
  if (Object.hasOwn(value, 'tiers')) {
    if (!Array.isArray(value['tiers'])) errors.push(`${path}.tiers: must be an array`)
    else {
      let previous = -1
      for (const [index, tier] of value['tiers'].entries()) {
        const at = `${path}.tiers[${index}]`
        if (!object(tier)) { errors.push(`${at}: must be an object`); continue }
        keys(tier, ['aboveInputTokens', 'perMillionTokens'], at, errors)
        const threshold = tier['aboveInputTokens']
        if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 0 || threshold <= previous) {
          errors.push(`${at}.aboveInputTokens: must be a nonnegative safe integer in strictly increasing order`)
        } else previous = threshold
        const rates = parseRates(tier['perMillionTokens'], `${at}.perMillionTokens`, errors)
        if (typeof threshold === 'number' && rates !== undefined) tiers.push({ aboveInputTokens: threshold, perMillionTokens: rates })
      }
    }
  }
  return errors.length === before && perMillionTokens !== undefined
    ? { currency: 'USD', perMillionTokens, ...(Object.hasOwn(value, 'tiers') ? { tiers } : {}) }
    : undefined
}

function selectedRates(evidence: UsageEvidence, pricing: Pricing | undefined): TokenRates | undefined {
  if (!pricing?.tiers?.length) return pricing?.perMillionTokens
  if (evidence.totalInput.status !== 'reported') return undefined
  let rates = pricing.perMillionTokens
  for (const tier of pricing.tiers) {
    if (evidence.totalInput.count <= tier.aboveInputTokens) break
    rates = tier.perMillionTokens
  }
  return rates
}

export const cacheWriteRate = (rates: TokenRates | undefined, ttl: '5m' | '1h' | undefined): number | undefined => {
  const write = rates?.cacheWrite
  if (typeof write === 'number') return write
  return ttl === undefined ? undefined : write?.[ttl]
}

export type UsageValue = { value: number; hasKnown: boolean; complete: boolean; overflow: boolean }

// Price only final, reported token categories. Reasoning remains an output subset.
export function valueUsage(evidence: UsageEvidence | undefined, pricing: Pricing | undefined): UsageValue {
  if (evidence === undefined || evidence.finality !== 'final') return { value: 0, hasKnown: false, complete: false, overflow: false }
  let value = 0, hasKnown = false, complete = true, overflow = false
  const rates = selectedRates(evidence, pricing)
  if (pricing?.tiers?.length && evidence.totalInput.status !== 'reported') complete = false
  const add = (measure: Measure, rate: number | undefined) => {
    if (measure.status === 'notApplicable') return
    if (measure.status === 'unknown') { complete = false; return }
    if (measure.count === 0) { hasKnown = true; return }
    if (rate === undefined) { complete = false; return }
    const amount = measure.count * rate / 1_000_000
    if (!Number.isFinite(amount) || !Number.isFinite(value + amount)) { complete = false; overflow = true; return }
    hasKnown = true
    value += amount
  }
  add(evidence.input, rates?.input)
  add(evidence.output, rates?.output)
  add(evidence.cacheRead, rates?.cacheRead)
  const write = evidence.cacheWrite, writeRate = rates?.cacheWrite
  if (write.status === 'notApplicable') return { value, hasKnown, complete, overflow }
  if (write.status === 'unknown') complete = false
  else if (write.count === 0) hasKnown = true
  else if (typeof writeRate === 'number') add(write, writeRate)
  else if (typeof writeRate === 'object' && writeRate !== null) {
    const variants = [evidence.cacheWrite5m, evidence.cacheWrite1h]
    if (variants.some(variant => variant.status === 'unknown')) complete = false
    for (const [variant, ttl] of [[evidence.cacheWrite5m, '5m'], [evidence.cacheWrite1h, '1h']] as const) {
      const before = value
      add(variant, cacheWriteRate(rates, ttl))
      if (value !== before || variant.status === 'reported' && variant.count === 0) hasKnown = true
    }
    if (evidence.cacheWrite5m.status === 'notApplicable' || evidence.cacheWrite1h.status === 'notApplicable') complete = false
  } else complete = false
  return { value, hasKnown, complete, overflow }
}
