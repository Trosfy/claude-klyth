// The one-line texts of failed provider requests: what failed, why, and what to do. Every provider text in
// them is redacted and cut short. Pure.
import type { ProviderConfig } from '../hooks/config'
import { firstLine, redact } from '../hooks/redact'

// How a request ended without a usable response: no connection (refused, unresolved, or none within the
// connect timeout), silence past the stall window, the whole-request bound, a redirect, or a transport fault.
export type Cut = { kind: 'connect' | 'connect-timeout' | 'stall' | 'total' | 'redirect' | 'reset'; detail: string }

export const CONNECT_TIMEOUT_S = 15
export const ERROR_TEXT_MAX = 4096 // the most kept of a provider's error text: an error body's start, or a decoder's failure
export const MAX_ATTEMPTS = 10 // all sends, including the one cached-key refresh
const BACKOFF_MS = 1000 // the backoff's base: the ceiling of the first wait, doubled for each next
const RETRY_CAP_MS = 8000 // the longest provider `retry-after` waited out, independent of the backoff's ceiling
const MODEL_NAME_RE = /^[A-Za-z0-9._:/@-]{1,128}$/
const POLICY_ERROR = /policy|guardrail|content[_ -]?filter|moderation/i

// Text on one line, at most `max` characters, redacted. Linear: it reads only its first 4 × `max` characters, less the token that cut splits (a token that ends exactly at the cut is whole, and stays).
export function oneLine(text: string, max = 200): string {
  let end = Math.min(text.length, max * 4)
  while (end < text.length && end > 0 && !/\s/.test(text.charAt(end - 1)) && !/\s/.test(text.charAt(end))) end--
  return redact(text.slice(0, end).split('\n').map(l => l.trim()).filter(Boolean).join(' ')).slice(0, max)
}

// A string as JSON for a debug line, with U+2028, U+2029 and the bidi controls (U+202A–U+202E, U+2066–U+2069) as \u escapes.
export const logJson = (text: string) => JSON.stringify(text).replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

// A provider's error, read from an error body or an in-stream `error` value: its `error.message` (or
// `message`, `detail`) and `error.type` (or `code`) when it is JSON, else its first line.
export function errorDetail(error: unknown): { message: string; type: string } {
  let v: unknown = error
  if (typeof error === 'string') {
    try {
      v = JSON.parse(error)
    } catch {
      return { message: firstLine(error), type: '' }
    }
  }
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const inner = typeof o['error'] === 'object' && o['error'] !== null ? (o['error'] as Record<string, unknown>) : typeof o['error'] === 'string' ? { message: o['error'] } : o
  const text = (x: unknown) => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '')
  const message = text(inner['message']) || text(o['message']) || text(o['detail']) || (typeof error === 'string' ? firstLine(error) : JSON.stringify(v))
  return { message, type: `${text(inner['type'])} ${text(inner['code'])}`.trim() }
}

// The models a gateway's key-access error (LiteLLM's format) names as allowed (`models=['a', 'b']`), when it names any.
const allowedModels = (message: string) =>
  (/models=\[([^\]]*)\]/.exec(message)?.[1] ?? '')
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => MODEL_NAME_RE.test(s) && !/^sk-/i.test(s))

const UNAVAILABLE = 'ChatGPT plan usage is unavailable for this account right now; retry later, or use an API key'
// The fix for a ChatGPT plan-usage error, by the code its type carries (`chatpass_v2` is a family, so a substring); undefined for any other error.
const FIXES: [code: string, fix: (id: string) => string][] = [
  ['subscription_sharing_usage_limit_exceeded', () => "your ChatGPT plan's usage limit for klyth is reached; wait for it to reset, or raise it in ChatGPT settings"],
  ['subscription_sharing_user_not_eligible', id => `this ChatGPT plan cannot be used in other apps; use an API key (bun run auth login ${id}, kind openai or openai-responses)`],
  ['subscription_sharing_invalid_user', id => `sign in again with bun run auth login ${id} --chatgpt`],
  ['subscription_sharing_route_not_supported', id => `this model or route is not available on ChatGPT plan usage; pick a model from bun run auth login ${id} --chatgpt's list`],
  ['subscription_sharing_unsupported_capability', () => "ChatGPT plan usage does not support an input, tool or param of this request; set the model's vision to false, or drop the one the message names"],
  ['subscription_sharing_usage_unavailable', () => UNAVAILABLE],
  ['subscription_sharing_user_unavailable', () => UNAVAILABLE],
  ['chatpass_v2', () => UNAVAILABLE],
]
export const knownFix = (id: string, type: string) => FIXES.find(([code]) => type.includes(code))?.[1](id)

// The text for an HTTP error status. An HTML page (an edge proxy or WAF answering before the API does) is
// named by its title; a ChatGPT plan-usage code names its own fix, whatever the status; a key-access denial
// names the allowed models; a rejected key (a key wanted by a provider with auth "none"), a content-policy
// refusal, a rate limit and a server failure each say what to do; any other status shows the provider's own
// message with the fix for its class. After more than one send, the rate limit and the server failure (and a
// gateway page) say how many.
export function httpErrorText(p: ProviderConfig, status: number, body: string, model: string, tries = 1): string {
  const after = tries > 1 ? ` after ${tries} attempts` : ''
  if (/^\s*</.test(body) && /<(?:!doctype\s+html|html|head|body)\b/i.test(body.slice(0, 512))) {
    const raw = /<title>([^<]{1,80})<\/title>/i.exec(body)?.[1]
    const title = raw === undefined ? '' : oneLine(raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' '))
    return `klyth: ${p.id} blocked the request at its gateway (HTTP ${status}${after}${title ? `, "${title}"` : ''}), before the API answered; ask the ${p.id} platform team what their edge rule rejected`
  }
  const { message, type } = errorDetail(body)
  const said = oneLine(message, 300) || 'no error message'
  const known = knownFix(p.id, type)
  if (known !== undefined) return `klyth: ${p.id} HTTP ${status}: ${said}; ${known}`
  if (/key_model_access_denied/.test(type) || /not allowed to access model/i.test(message)) {
    const allowed = allowedModels(message)
    const shown = allowed.length > 12 ? `${allowed.slice(0, 12).join(', ')} (+${allowed.length - 12} more)` : allowed.join(', ')
    return `klyth: your key for ${p.id} can't use ${model}${shown ? `; allowed: ${shown}` : ''}. Pick an allowed model, or ask the gateway's admin for access`
  }
  if (status === 401) return p.auth === 'none' ? `klyth: ${p.id} wants a key (HTTP 401) but auth is "none"; run bun run auth login ${p.id} and set auth.command, then retry` : `klyth: ${p.id} rejected its key (HTTP 401); store a valid one with bun run auth login ${p.id}, then retry`
  if (POLICY_ERROR.test(`${type} ${message}`)) return `klyth: ${p.id} refused the request under its content policy (HTTP ${status}): ${said}. Rephrase it, or use another model`
  const fixes: Record<number, string> = {
    429: `rate limited${after}: wait, then retry`,
    403: p.auth === 'none' ? `ask the ${p.id} admin for access; if it wants a key, run bun run auth login ${p.id} and set auth.command (auth is "none")` : `ask the ${p.id} admin for access, or store another key with bun run auth login ${p.id}`,
    404: `check providers.${p.id}.baseUrl and the model id ${model}`,
  }
  const fix = status >= 500 ? `the provider failed${after}: retry, or pick another model` : (fixes[status] ?? `check the params of ${model} in klyth.json`)
  return `klyth: ${p.id} HTTP ${status}: ${said}; ${fix}`
}

// The text for a request cut before a usable response ended, by how it was cut: the provider's id, the cut's detail,
// the config key that sets the bound a timeout hit, and how many attempts were made when more than one.
const CUTS: Record<Cut['kind'], (id: string, detail: string, bound: string, after: string) => string> = {
  'connect-timeout': id => `klyth: ${id} could not connect within ${CONNECT_TIMEOUT_S} s; check the network or VPN, then retry`,
  connect: (id, d, _, after) => `klyth: ${id} could not connect (${oneLine(d)})${after}; check the network or VPN, then retry`,
  stall: (id, d) => `klyth: ${id} stalled (no data for ${d} s); retry`,
  total: (id, d, bound) => `klyth: ${id} timed out after ${d} s; retry, or raise ${bound}`,
  redirect: (id, d) => `klyth: ${id} answered with a redirect (HTTP ${d}), which klyth does not follow; set providers.${id}.baseUrl to the URL it redirects to`,
  reset: (id, d, _, after) => `klyth: ${id} request failed (${oneLine(d)})${after}; retry, or see the debug log`,
}
// `byRequest`: the request's own bound (only the classifier sets one) was the tighter, so the key to raise is classifier.timeoutMs.
export const cutText = (p: ProviderConfig, c: Cut, byRequest = false, tries = 1) => CUTS[c.kind](p.id, c.detail, byRequest ? 'classifier.timeoutMs' : `providers.${p.id}.timeoutMs`, tries > 1 ? ` after ${tries} attempts` : '')

// The wait in ms before a request with no meaningful output is sent again, or undefined when it is not; `tries` is
// the sends made. Only a connection that failed before the answer (not a certificate, TLS or header fault), a 500, 502,
// 503, 504 or 529, Envoy's 507 for a request too big for its retry buffer, and a 429 that names its wait pass, never a
// ChatGPT plan code. Structured Responses server/overload failures pass too; decoder faults never do. The wait is random(0, 1 s × 2^(tries - 1)), full jitter, plus the provider's `retry-after` (seconds
// or a GMT date) when it sends one; one past 8 s means no resend.
export function retryWait(a: { status: number; retryAfter?: string } | { cut: Cut } | { failure: string; retryAfter?: string }, body: string, tries: number, now: number): number | undefined {
  if (tries >= MAX_ATTEMPTS) return undefined
  const backoff = Math.round(Math.random() * BACKOFF_MS * 2 ** (tries - 1))
  if ('cut' in a) return a.cut.kind === 'connect' || (a.cut.kind === 'reset' && !/certificat|CERT_|SSL|TLS|TypeError/i.test(a.cut.detail)) ? backoff : undefined
  if ('failure' in a) {
    const { type, message } = errorDetail(a.failure)
    const codes = type.split(/\s+/).filter(Boolean)
    const allowed = ['error', 'server_error', 'overloaded_error', 'server_overloaded', 'overload']
    const knownText = message === 'Our servers are currently overloaded. Please try again later.'
    if (POLICY_ERROR.test(`${type} ${message}`) || /quota|authentication|unauthori[sz]ed|invalid (?:request|api key)|usage limit|subscription/i.test(message)) return undefined
    if (!codes.every(code => allowed.includes(code)) || !(codes.some(code => code !== 'error') || knownText)) return undefined
    body = a.failure
    a = { status: 503, retryAfter: a.retryAfter }
  }
  const { status, retryAfter } = a
  const asked = retryAfter === undefined ? NaN : /^\s*\d+(\.\d+)?\s*$/.test(retryAfter) ? Number(retryAfter) * 1000 : /GMT/.test(retryAfter) ? Date.parse(retryAfter) - now : NaN // NaN when absent or unreadable
  const transient = [500, 502, 503, 504, 529].includes(status) || (status === 507 && body.includes('exceeded request buffer limit while retrying upstream'))
  if (!(status === 429 ? !Number.isNaN(asked) : transient) || /subscription_sharing_|chatpass_/.test(errorDetail(body).type)) return undefined
  return Number.isNaN(asked) ? backoff : asked > RETRY_CAP_MS ? undefined : Math.max(0, asked) + backoff
}
