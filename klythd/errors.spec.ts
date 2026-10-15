// The one-line texts of failed provider requests: each names what failed and the fix, redacted and short,
// against the bodies providers and gateways answered with in live runs.
import { expect, spyOn, test } from 'bun:test'

import { parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import { redact } from '../hooks/redact'
import { cutText, errorDetail, httpErrorText, knownFix, logJson, oneLine, retryWait } from './errors'
import type { Cut } from './errors'

const P = (parseConfig(JSON.stringify({ providers: { acme: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: { command: ['/usr/bin/security'] }, models: { m: { contextWindow: 1000, maxOutputTokens: 100 } } } } })).config as Config)
  .providers['acme'] as ProviderConfig
const FREE = { ...P, auth: 'none' } as ProviderConfig
const SK = 'sk-live-abcdefghijklmnopqrstuvwx1234'
const HEX = '0123456789abcdef0123456789abcdef'
const http = (status: number, body: string) => httpErrorText(P, status, body, 'model-a')

test('redaction masks bearer tokens, sk- keys, key assignments and long credential-shaped runs', () => {
  const out = redact(`Bearer ${HEX} key ${SK} api_key="abc123" token: xyz ${HEX} short-word ok`)
  for (const secret of [HEX, 'sk-live', 'abc123', 'xyz']) expect(out).not.toContain(secret)
  expect(out).toContain('short-word ok')
  expect(redact('rejected sk-ab12.c3 for team a')).toBe('rejected [REDACTED] for team a')
})

test('a key-access denial names the model and the allowed ones, parsed from the body, and never the key', () => {
  const body = `{"error":{"message":"key not allowed to access model. This key can only access models=['model-b', 'gemini/gemini-2.5-pro']. Tried to access model-a","type":"key_model_access_denied","param":"${SK}","code":"403"}}`
  expect(http(403, body)).toBe("klyth: your key for acme can't use model-a; allowed: model-b, gemini/gemini-2.5-pro. Pick an allowed model, or ask the gateway's admin for access")
  expect(http(401, '{"error":{"message":"key not allowed to access model","type":"auth_error"}}')).toBe("klyth: your key for acme can't use model-a. Pick an allowed model, or ask the gateway's admin for access")
  const many = Array.from({ length: 14 }, (_, i) => `'m${i}'`).join(', ')
  expect(http(403, `{"error":{"message":"This key can only access models=[${many}, '${SK}']","type":"key_model_access_denied"}}`)).toBe(
    "klyth: your key for acme can't use model-a; allowed: m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11 (+2 more). Pick an allowed model, or ask the gateway's admin for access",
  )
})

test('an HTML page (a gateway edge answering before the API) is named as a gateway block by its redacted title, never dumped', () => {
  const blocked = (status: number, title?: string) =>
    `klyth: acme blocked the request at its gateway (HTTP ${status}${title === undefined ? '' : `, "${title}"`}), before the API answered; ask the acme platform team what their edge rule rejected`
  expect(http(403, '<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n</body>\n</html>\n')).toBe(blocked(403, '403 Forbidden'))
  expect(http(502, '<!DOCTYPE html><html><body>Bad gateway</body></html>')).toBe(blocked(502))
  expect(http(403, '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Denied</title></head></html>')).toBe(blocked(403, 'Denied'))
  expect(http(403, '<!-- edge 7 -->\n<head><title>Request blocked</title></head><body>x</body>')).toBe(blocked(403, 'Request blocked'))
  expect(http(403, `<html><title>blocked\r\n\u0007for ${SK}</title></html>`)).toBe(blocked(403, 'blocked for [REDACTED]'))
  expect(http(403, '<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>')).toMatch(/^klyth: acme HTTP 403: <\?xml version="1.0"\?><Error><Code>AccessDenied<\/Code><\/Error>; /)
})

test('every other status says what failed and the fix for its class, redacted, on one line, at most 300 characters of the message', () => {
  expect(http(401, `{"error":{"message":"Authentication Error, Invalid proxy server token passed. Received API Key = ${SK}","type":"auth_error"}}`)).toBe(
    'klyth: acme rejected its key (HTTP 401). Store a valid one with klyth auth login api-key acme, then retry',
  )
  expect(http(400, '{"error":{"message":"Violated guardrail policy: prompt blocked","type":"None","code":"400"}}')).toBe(
    'klyth: acme refused the request under its content policy (HTTP 400): Violated guardrail policy: prompt blocked. Rephrase it, or use another model',
  )
  expect(http(500, `{"error":{"message":"upstream exploded with ${SK}"}}`)).toBe('klyth: acme HTTP 500: upstream exploded with [REDACTED]; the provider failed: retry, or pick another model')
  expect(http(429, '{"error":{"message":"slow down"}}')).toBe('klyth: acme HTTP 429: slow down; rate limited: wait, then retry')
  expect(http(403, '{"error":{"message":"Access denied for this route"}}')).toBe('klyth: acme HTTP 403: Access denied for this route; ask the acme admin for access, or store another key with klyth auth login api-key acme')
  expect(http(404, '{"detail":"Not Found"}')).toBe('klyth: acme HTTP 404: Not Found; check providers.acme.baseUrl and the model id model-a')
  expect(http(422, JSON.stringify({ error: { message: 'bad param\nsecond line' } }))).toBe('klyth: acme HTTP 422: bad param second line; check the params of model-a in klyth.json')
  expect(http(503, '')).toBe('klyth: acme HTTP 503: no error message; the provider failed: retry, or pick another model')
  const long = http(500, 'x '.repeat(2000))
  expect(long.length).toBeLessThanOrEqual('klyth: acme HTTP 500: '.length + 300 + '; the provider failed: retry, or pick another model'.length)
  expect(long).not.toContain('\n')
})

test('a ChatGPT plan-usage code names its fix, before the status and content-policy texts; a code of another family keeps the status text', () => {
  const body = (code: string, message = 'denied') => JSON.stringify({ error: { message, code } })
  const cases: [number, string, string][] = [
    [429, 'subscription_sharing_usage_limit_exceeded', "your ChatGPT plan's usage limit for klyth is reached; wait for it to reset, or raise it in ChatGPT settings"],
    [403, 'subscription_sharing_user_not_eligible', 'This ChatGPT plan does not permit other apps. Use an API key (klyth auth login api-key acme, kind openai or openai-responses)'],
    [401, 'subscription_sharing_invalid_user', 'sign in again with klyth auth login chatgpt --provider acme'],
    [400, 'subscription_sharing_route_not_supported', "ChatGPT plan usage does not include this model or route. Pick a model from klyth auth login chatgpt --provider acme's list"],
    [400, 'subscription_sharing_unsupported_capability', "ChatGPT plan usage does not support an input, tool or param of this request; set the model's vision to false, or drop the one the message names"],
    [503, 'subscription_sharing_usage_unavailable', 'ChatGPT plan usage is unavailable for this account right now; retry later, or use an API key'],
    [503, 'subscription_sharing_user_unavailable', 'ChatGPT plan usage is unavailable for this account right now; retry later, or use an API key'],
    [503, 'chatpass_v2_foo', 'ChatGPT plan usage is unavailable for this account right now; retry later, or use an API key'],
  ]
  for (const [status, code, fix] of cases) expect(http(status, body(code))).toBe(`klyth: acme HTTP ${status}: denied; ${fix}`)
  expect(knownFix('acme', 'error subscription_sharing_invalid_user')).toBe('sign in again with klyth auth login chatgpt --provider acme')
  expect(http(403, body('subscription_sharing_user_not_eligible', 'blocked by policy'))).toContain('This ChatGPT plan does not permit other apps')
  expect(http(429, body('subscription_sharing_other'))).toBe('klyth: acme HTTP 429: denied; rate limited: wait, then retry')
  expect(http(401, body('subscription_sharing_other'))).toBe('klyth: acme rejected its key (HTTP 401). Store a valid one with klyth auth login api-key acme, then retry')
  expect(knownFix('acme', '')).toBeUndefined()
})

test('a 401 or 403 from a provider with auth "none" says it wants a key and names the fix, on one line', () => {
  const FIX = 'run klyth auth login api-key acme and set auth.command'
  expect(httpErrorText(FREE, 401, '{"error":{"message":"Authentication Error, no api key passed"}}', 'model-a')).toBe(`klyth: acme wants a key (HTTP 401) but auth is "none". Run ${FIX.slice(4)}, then retry`)
  expect(httpErrorText(FREE, 403, '{"error":{"message":"Access denied for this route"}}', 'model-a')).toBe(
    `klyth: acme HTTP 403: Access denied for this route; ask the acme admin for access. If it wants a key, ${FIX} (auth is "none")`,
  )
  expect(httpErrorText(FREE, 429, '{"error":{"message":"slow down"}}', 'model-a')).toBe('klyth: acme HTTP 429: slow down; rate limited: wait, then retry')
})

test('an error detail is the error message and type of a JSON body or value, else its first line', () => {
  expect(errorDetail('{"error":{"message":"m","type":"t","code":403}}')).toEqual({ message: 'm', type: 't 403' })
  expect(errorDetail({ message: 'in stream', code: 'rate_limit' })).toEqual({ message: 'in stream', type: 'rate_limit' })
  expect(errorDetail('{"error":"plain"}')).toEqual({ message: 'plain', type: '' })
  expect(errorDetail('{"detail":"Not Found"}')).toEqual({ message: 'Not Found', type: '' })
  expect(errorDetail('the stream ended with no finish reason\nmore')).toEqual({ message: 'the stream ended with no finish reason', type: '' })
})

test('a request cut before a usable response says why and what to do, on one line', () => {
  const cuts: [Cut, string][] = [
    [{ kind: 'connect-timeout', detail: '' }, 'klyth: acme could not connect within 15 s; check the network or VPN, then retry'],
    [{ kind: 'connect', detail: 'klyth.invalid:443 ECONNREFUSED\nmore' }, 'klyth: acme could not connect (klyth.invalid:443 ECONNREFUSED more); check the network or VPN, then retry'],
    [{ kind: 'stall', detail: '600' }, 'klyth: acme stalled (no data for 600 s); retry'],
    [{ kind: 'total', detail: '1800' }, 'klyth: acme timed out after 1800 s; retry, or raise providers.acme.timeoutMs'],
    [{ kind: 'redirect', detail: '302' }, 'klyth: acme answered with a redirect (HTTP 302), which klyth does not follow; set providers.acme.baseUrl to the URL it redirects to'],
    [{ kind: 'reset', detail: `Error: socket hang up for ${SK}` }, 'klyth: acme request failed (Error: socket hang up for [REDACTED]); retry, or see the debug log'],
  ]
  for (const [cut, text] of cuts) expect(cutText(P, cut)).toBe(text)
})

test("a timeout the request's own bound caused names classifier.timeoutMs; no other cut changes with it", () => {
  expect(cutText(P, { kind: 'total', detail: '20' }, true)).toBe('klyth: acme timed out after 20 s; retry, or raise classifier.timeoutMs')
  expect(cutText(P, { kind: 'total', detail: '20' }, false)).toBe('klyth: acme timed out after 20 s; retry, or raise providers.acme.timeoutMs')
  for (const kind of ['connect-timeout', 'connect', 'stall', 'redirect', 'reset'] as const) expect(cutText(P, { kind, detail: '1' }, true)).toBe(cutText(P, { kind, detail: '1' }))
})

test('oneLine joins the lines of a text with single spaces, redacts and cuts it, and reads a megabyte of whitespace in linear time', () => {
  expect(oneLine('  a  \n\n \r\n b c \n')).toBe('a b c')
  expect(oneLine('a   b')).toBe('a   b')
  expect(oneLine(`key ${SK}\nmore`)).toBe('key [REDACTED] more')
  expect(oneLine('word '.repeat(100), 21)).toBe('word word word word w')
  for (const text of [' '.repeat(1 << 20), `${' '.repeat(1 << 20)}x`, `${'\t\n'.repeat(1 << 19)}x`]) {
    const started = performance.now()
    const out = oneLine(text, 300)
    expect(performance.now() - started).toBeLessThan(100)
    expect(out.length).toBeLessThanOrEqual(300)
    expect(out).not.toContain('\n')
  }
})

test('oneLine drops the token its cut splits before redacting, so no part of a key shows; a text that fits keeps its last token', () => {
  const secret = 'Zq7xK2mP9vL4nR8tW1yB6cF3hJ5dG0sA' // 32 characters, no sk- prefix
  // 1180 x's redact to 10 characters; the secret straddles the 4 × 300 = 1200 character cut.
  const cut = oneLine(`${'x'.repeat(1180)} ${secret}`, 300)
  expect(cut).toBe('[REDACTED]')
  for (const part of [secret.slice(0, 19), 'Zq7x']) expect(cut).not.toContain(part)
  // Nothing is cut: the last token stays, redacted when it is a key.
  expect(oneLine(`key ${secret}`, 300)).toBe('key [REDACTED]')
  expect(oneLine('ends with word', 300)).toBe('ends with word')
  // A cut text with no whitespace at all has no whole token to keep; the reading stays linear.
  const started = performance.now()
  expect(oneLine('a'.repeat(1 << 20), 300)).toBe('')
  expect(performance.now() - started).toBeLessThan(100)
})

test('oneLine keeps a token that ends exactly at its cut, and drops one the cut splits', () => {
  // The cut falls at 4 × 300 = 1200 characters; the x's redact to the 10 characters of [REDACTED], so what follows them shows.
  const ends = `${'x'.repeat(1195)} word tail`
  expect(ends.charAt(1199)).toBe('d')
  expect(ends.charAt(1200)).toBe(' ')
  expect(oneLine(ends, 300)).toBe('[REDACTED] word')
  const split = `${'x'.repeat(1196)} word tail`
  expect(split.charAt(1199)).toBe('r')
  expect(split.charAt(1200)).toBe('d')
  expect(oneLine(split, 300)).toBe('[REDACTED]')
})

test('logJson is JSON.stringify with U+2028, U+2029 and the bidirectional controls U+202A to U+202E and U+2066 to U+2069 as \\u escapes', () => {
  const bad = ['\u2028', '\u2029', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']
  const out = logJson(bad.join('|'))
  expect(out).toBe('"\\u2028|\\u2029|\\u202a|\\u202b|\\u202c|\\u202d|\\u202e|\\u2066|\\u2067|\\u2068|\\u2069"')
  expect(JSON.parse(out)).toBe(bad.join('|'))
  expect(logJson('plain "quoted" text\n')).toBe(JSON.stringify('plain "quoted" text\n'))
})

test('Responses retry policy allowlists structured server/overload failures and rejects permanent or unknown codes', () => {
  const random = spyOn(Math, 'random').mockReturnValue(0.5)
  const failure = (error: unknown, tries = 1, retryAfter?: string) => retryWait({ failure: JSON.stringify(error), ...(retryAfter === undefined ? {} : { retryAfter }) }, '', tries, 0)
  const message = 'Our servers are currently overloaded. Please try again later.'
  try {
    for (const code of ['server_error', 'overloaded_error', 'server_overloaded', 'overload']) {
      expect(failure({ code, message })).toBe(500)
      expect(failure({ error: { type: 'server_error', code, message } })).toBe(500)
    }
    for (const code of ['unknown', 'insufficient_quota', 'authentication_error', 'invalid_api_key', 'content_policy_violation', 'invalid_request_error', 'rate_limit_exceeded', 'subscription_sharing_usage_limit_exceeded', 'chatpass_v2']) {
      expect(failure({ type: 'server_error', code, message }), code).toBeUndefined()
    }
    for (const reason of ['quota exceeded; retry', 'authentication failed; retry', 'invalid request; retry', 'content policy refused; retry']) expect(failure({ type: 'server_error', message: reason }), reason).toBeUndefined()
    expect(failure({ message })).toBe(500)
    expect(failure({ type: 'error', message })).toBe(500)
    expect(failure({ type: 'invalid_request_error', message })).toBeUndefined()
    expect(failure({ message: 'busy, retry later' })).toBeUndefined()
    expect(failure({ code: 'server_error', message }, 10)).toBeUndefined()
    expect(failure({ code: 'server_error', message }, 2, '1')).toBe(2000)
    expect(failure({ code: 'server_error', message }, 1, '9')).toBeUndefined()
  } finally { random.mockRestore() }
})

test('streamed server errors use the HTTP formatter policy vocabulary before allowing a retry', () => {
  for (const message of ['Request blocked by content_filter due to a policy violation', 'Request denied by a guardrail', 'Moderation rejected the request', 'Content-filter refused the request', 'Content filter refused the request']) {
    const body = JSON.stringify({ error: { type: 'server_error', message } })
    expect(httpErrorText(P, 400, body, 'model-a')).toContain('refused the request under its content policy')
    expect(retryWait({ failure: body }, '', 1, 0)).toBeUndefined()
  }
})
