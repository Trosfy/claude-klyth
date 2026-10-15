// One step inside klythd over a faked transport: the steps it refuses before sending, the provider request
// (URL, headers, User-Agent, key, the time bound), one 401/403 retry with a fresh key before any event, the resends after a
// failure before any body byte (which failures, the waits, the time bound, an abort), the failure texts,
// tool-call ids given back only to the provider that made them, the stats that end every step, and the one
// debug line, which never holds the key or a body.
import { expect, spyOn, test } from 'bun:test'

import { fingerprint, parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import type { StepEvent, StepRequest, StepWire } from '../hooks/protocol'
import { CODECS } from './codecs'
import type { Cut } from './errors'
import { remoteIds } from './history'
import { assembler, createStepper } from './step'
import type { Answer, Env, UpstreamRequest } from './step'

const KEY = 'sk-klyth-test-0123456789abcdef'
const UA = 'klyth/0.2.0'
const helper = (name: string) => ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', name, '-w']
const MODEL = { contextWindow: 100_000, maxOutputTokens: 8000, effort: { low: { reasoning_effort: 'low' }, high: { reasoning_effort: 'high' } } }
const CONFIG = JSON.stringify({
  providers: {
    acme: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: { command: helper('acme') }, headers: { 'User-Agent': 'evil/1', 'X-Tag': 'klyth' }, models: { m: MODEL } },
    other: { kind: 'openai', baseUrl: 'https://other.invalid/v1', auth: { command: helper('other') }, models: { m: MODEL } },
    claude: { kind: 'anthropic', baseUrl: 'https://claude.invalid', auth: { command: helper('claude') }, models: { m: MODEL } },
    free: { kind: 'openai', baseUrl: 'https://free.invalid/v1', auth: 'none', models: { m: MODEL } },
    freecl: { kind: 'anthropic', baseUrl: 'https://freecl.invalid', auth: 'none', models: { m: MODEL } },
  },
})
const providers = (parseConfig(CONFIG).config as Config).providers
const fp = (id: string) => fingerprint(providers[id] as ProviderConfig)
const REQ: StepRequest = { target: 'acme/m', system: 'SYS', tools: [], transcript: [{ role: 'user', content: 'hi' }], effort: 'high', who: 'main', accounting: { purpose: 'step', owner: 'main' } }
const wire = (req: Partial<StepRequest> = {}, approved = [fp('acme'), fp('other'), fp('claude'), fp('free'), fp('freecl')]): StepWire => ({
  token: 't',
  configText: CONFIG,
  approved,
  req: { ...REQ, ...req },
})
const sse = (...events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
const OK = sse({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]')

type Reply = { status?: number; body?: string; cut?: Cut; before?: Cut; retryAfter?: string; pieces?: string[]; holdRead?: boolean }
// A stepper whose provider answers `replies` in turn (the last one again after), whose helper prints a key
// numbered by its run, and whose log, requests and waits are recorded (a wait ends at once, or only when its
// signal aborts once `hold` is set); `identity` is what klythd read from its environment.
function fake(replies: Reply[] = [{}], requestHeaders?: Env['requestHeaders']) {
  const h = { posts: [] as UpstreamRequest[], runs: [] as string[][], logs: [] as string[], slept: [] as number[], hold: false, onSleep: undefined as ((ms: number) => void) | undefined, aborted: 0, cancelled: 0, onPost: undefined as (() => void) | undefined, onRead: undefined as (() => void) | undefined, onHold: undefined as (() => void) | undefined, onRun: undefined as (() => void) | undefined }
  const post = async (r: UpstreamRequest, signal: AbortSignal): Promise<Answer> => {
    const reply = replies[Math.min(h.posts.length, replies.length - 1)] as Reply
    h.posts.push(r)
    h.onPost?.()
    if (reply.before !== undefined) return { cut: reply.before }
    signal.addEventListener('abort', () => void h.aborted++)
    const bytes = new TextEncoder().encode(reply.body ?? OK)
    async function* body(): AsyncGenerator<Uint8Array, Cut | undefined> {
      const pieces = reply.pieces?.map(piece => new TextEncoder().encode(piece)) ?? Array.from({ length: Math.ceil(bytes.length / 64) }, (_, i) => bytes.subarray(i * 64, (i + 1) * 64))
      for (const piece of pieces) { h.onRead?.(); yield piece }
      if (reply.holdRead && !signal.aborted) await new Promise<void>(done => {
        signal.addEventListener('abort', () => done(), { once: true })
        h.onHold?.()
      })
      return reply.cut
    }
    return { status: reply.status ?? 200, ...(reply.retryAfter === undefined ? {} : { retryAfter: reply.retryAfter }), body: body(), cancel: () => void h.cancelled++ }
  }
  const run = async (argv: readonly string[]) => (h.onRun?.(), h.runs.push([...argv]), { exitCode: 0, stdout: `${KEY}-${h.runs.length}\n` })
  const sleep = async (ms: number, signal: AbortSignal) => {
    h.slept.push(ms)
    h.onSleep?.(ms)
    if (h.hold) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }))
  }
  return { h, s: createStepper({ version: '0.2.0', post, run, sleep, now: () => 0, log: line => void h.logs.push(line), ...(requestHeaders === undefined ? {} : { requestHeaders }) }) }
}
async function events(s: ReturnType<typeof createStepper>, w: StepWire = wire(), signal = new AbortController().signal) {
  const out: StepEvent[] = []
  for await (const ev of s.step(w, signal)) out.push(ev)
  return out
}
const errorOf = (evs: readonly StepEvent[]) => (evs.find(e => e.type === 'error') as { text: string } | undefined)?.text

test('the request goes to baseUrl with the codec path, the key as a bearer header, and a configured User-Agent over the Klyth default', async () => {
  const { h, s } = fake()
  const evs = await events(s)
  expect(evs.map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  const r = h.posts[0] as UpstreamRequest
  expect(r.url).toBe('https://klyth.invalid/v1/chat/completions')
  expect(r.headers).toEqual({ 'content-type': 'application/json', 'x-tag': 'klyth', 'user-agent': 'evil/1', authorization: `Bearer ${KEY}-1` })
  expect(JSON.parse(r.body)).toMatchObject({ model: 'm', reasoning_effort: 'high', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] })
  expect([r.stallS, r.totalS, r.allowHttp]).toEqual([600, 1800, false])
  const { h: bare, s: s2 } = fake()
  const unnamed = wire({ target: 'other/m' })
  await events(s2, unnamed)
  expect(bare.posts[0]?.headers['user-agent']).toBe(UA)
  expect(JSON.stringify([...h.posts, ...bare.posts].map(p => p.headers))).not.toContain('Bun/')
})


test("the step's session id goes out in the provider's sessionHeader only when both are present: the name lowercased, over a configured header of the same name", async () => {
  const model = { contextWindow: 100_000, maxOutputTokens: 8000 }
  const config = JSON.stringify({
    providers: {
      cached: { kind: 'openai-responses', baseUrl: 'https://cached.invalid/v1', auth: 'none', sessionHeader: 'Session_Id', models: { m: model } },
      tagged: { kind: 'openai', baseUrl: 'https://tagged.invalid/v1', auth: 'none', sessionHeader: 'X-Conv', headers: { 'x-conv': 'static' }, models: { m: model } },
      plain: { kind: 'openai', baseUrl: 'https://plain.invalid/v1', auth: 'none', models: { m: model } },
      bare: { kind: 'openai-responses', baseUrl: 'https://bare.invalid/v1', auth: 'none', models: { m: model } },
      cl: { kind: 'anthropic', baseUrl: 'https://cl.invalid', auth: 'none', models: { m: model } },
    },
  })
  const parsed = parseConfig(config)
  expect(parsed.errors).toEqual([])
  const approved = Object.values((parsed.config as Config).providers).map(fingerprint)
  const { h, s } = fake()
  const sent = async (target: string, sessionId?: string) => {
    await events(s, { token: 't', configText: config, approved, req: { ...REQ, target, ...(sessionId === undefined ? {} : { sessionId }) } })
    return h.posts.at(-1)?.headers ?? {}
  }
  for (let n = 0; n < 3; n++) expect((await sent('cached/m', 'conv-1'))['session_id']).toBe('conv-1')
  expect(h.posts.map(p => p.headers['session_id'])).toEqual(['conv-1', 'conv-1', 'conv-1'])
  expect(Object.keys(h.posts[0]?.headers ?? {})).not.toContain('Session_Id')
  expect((await sent('tagged/m', 'conv-1'))['x-conv']).toBe('conv-1')
  expect(Object.keys(await sent('cached/m'))).not.toContain('session_id')
  expect((await sent('tagged/m'))['x-conv']).toBe('static')
  // The Responses kind also sends the id as prompt_cache_key, only with a sessionHeader; other kinds and a step without an id send none.
  const bodies = h.posts.map(p => JSON.parse(p.body) as Record<string, unknown>)
  expect(bodies.slice(0, 3).map(b => b['prompt_cache_key'])).toEqual(['conv-1', 'conv-1', 'conv-1'])
  expect(h.posts.slice(3).some(p => p.body.includes('conv-1') || p.body.includes('prompt_cache_key'))).toBe(false)
  for (const target of ['bare/m', 'cl/m']) {
    const headers = await sent(target, 'conv-1')
    expect([Object.keys(headers).some(k => /session|conv/i.test(k)), h.posts.at(-1)!.body.includes('conv-1'), 'prompt_cache_key' in JSON.parse(h.posts.at(-1)!.body)]).toEqual([false, false, false])
  }
  expect(Object.values(await sent('plain/m', 'conv-1'))).not.toContain('conv-1')
})

test("a step's own timeoutMs bounds its provider request, and the provider's timeoutMs wins when it is smaller", async () => {
  const acme = (JSON.parse(CONFIG) as { providers: { acme: object } }).providers.acme
  const bounded = (providerMs: number | undefined, requestMs: number | undefined): StepWire => ({
    ...wire(requestMs === undefined ? {} : { timeoutMs: requestMs }),
    configText: JSON.stringify({ providers: { acme: { ...acme, ...(providerMs === undefined ? {} : { timeoutMs: providerMs }) } } }),
  })
  const cases: [number | undefined, number | undefined, [number, number]][] = [
    [undefined, undefined, [600, 1800]],
    [undefined, 20_000, [20, 20]],
    [undefined, 20_500, [20, 21]],
    [undefined, 900_000, [600, 900]],
    [900_000, 20_000, [20, 20]],
    [5_000, 20_000, [5, 5]],
    [5_000, undefined, [5, 5]],
  ]
  for (const [providerMs, requestMs, bounds] of cases) {
    const { h, s } = fake()
    await events(s, bounded(providerMs, requestMs))
    expect([h.posts[0]?.stallS, h.posts[0]?.totalS], `${providerMs} ${requestMs}`).toEqual(bounds)
  }
})

test("a timeout names the step's whole bound and the key of the tighter one: classifier.timeoutMs when the request's own is, the provider's otherwise, before an answer and in the middle of one", async () => {
  const acme = (JSON.parse(CONFIG) as { providers: { acme: object } }).providers.acme
  const total: Cut = { kind: 'total', detail: '20' }
  const half = sse({ choices: [{ index: 0, delta: { content: 'par' } }] })
  const cases: [number | undefined, number | undefined, number, string][] = [
    [undefined, 20_000, 20, 'classifier.timeoutMs'],
    [900_000, 20_000, 20, 'classifier.timeoutMs'],
    [5_000, 20_000, 5, 'providers.acme.timeoutMs'],
    [20_000, 20_000, 20, 'providers.acme.timeoutMs'],
    [5_000, undefined, 5, 'providers.acme.timeoutMs'],
    [undefined, undefined, 1800, 'providers.acme.timeoutMs'],
  ]
  for (const [providerMs, requestMs, bound, key] of cases) {
    for (const reply of [{ before: total }, { body: half, cut: total }] as Reply[]) {
      const { s } = fake([reply])
      const w: StepWire = { ...wire(requestMs === undefined ? {} : { timeoutMs: requestMs }), configText: JSON.stringify({ providers: { acme: { ...acme, ...(providerMs === undefined ? {} : { timeoutMs: providerMs }) } } }) }
      expect(errorOf(await events(s, w)), `${providerMs} ${requestMs}`).toBe(`klyth: acme timed out after ${bound} s; retry, or raise ${key}`)
    }
  }
})

test('a keyless step sends no authorization or x-api-key header and runs no helper, on the bearer and the x-api-key kinds alike', async () => {
  const { h, s } = fake()
  expect((await events(s, wire({ target: 'free/m' }))).map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  await events(s, wire({ target: 'freecl/m' }))
  expect(h.runs).toEqual([])
  expect(h.posts.map(p => p.url)).toEqual(['https://free.invalid/v1/chat/completions', 'https://freecl.invalid/v1/messages'])
  for (const p of h.posts) expect(Object.keys(p.headers).filter(k => /^(authorization|x-api-key)$/.test(k))).toEqual([])
  expect(h.posts[0]?.headers).toEqual({ 'content-type': 'application/json', 'user-agent': UA })
})

test('an unapproved keyless provider is refused before anything is sent, even when other providers are approved', async () => {
  const { h, s } = fake()
  const evs = await events(s, wire({ target: 'free/m' }, [fp('acme'), fp('freecl')]))
  expect(errorOf(evs)).toBe('klyth: free not approved — run /model <alias> to approve it')
  expect([h.runs, h.posts]).toEqual([[], []])
})

test('a keyless provider answering 401 or 403 is not retried, runs no helper, and the line names the fix', async () => {
  for (const [status, text] of [
    [401, 'klyth: free wants a key (HTTP 401) but auth is "none"; run bun run auth login free and set auth.command, then retry'],
    [403, 'klyth: free HTTP 403: nope; ask the free admin for access; if it wants a key, run bun run auth login free and set auth.command (auth is "none")'],
  ] as const) {
    const { h, s } = fake([{ status, body: '{"error":{"message":"nope"}}' }])
    expect(errorOf(await events(s, wire({ target: 'free/m' })))).toBe(text)
    expect(errorOf(await events(s, wire({ target: 'free/m' })))).toBe(text)
    expect([h.runs.length, h.posts.length]).toEqual([0, 2])
  }
})

test('a step for an unconfigured target or an unapproved provider runs no helper and sends nothing', async () => {
  const { h, s } = fake()
  const refused = (text: string) => [
    { type: 'error', kind: 'request', text },
    { type: 'stats', ttfbMs: null, totalMs: expect.any(Number), reqBytes: 0, in: null, out: null, finish: 'error' },
  ]
  expect<unknown>(await events(s, wire({ target: 'acme/gone' }))).toEqual(refused('klyth: acme/gone is not configured in this session; run /klyth reload'))
  expect<unknown>(await events(s, wire({}, []))).toEqual(refused('klyth: acme not approved — run /model <alias> to approve it'))
  expect<unknown>(await events(s, { ...wire(), configText: '{ broken' })).toEqual(refused('klyth: acme/m is not configured in this session; run /klyth reload'))
  expect([h.runs, h.posts]).toEqual([[], []])
})

test('a rejected cached key is fetched again and the request retried once, before any event; a fresh key rejected is not retried', async () => {
  for (const status of [401, 403]) {
    const { h, s } = fake([{}, { status, body: '{"error":{"message":"expired"}}' }, {}])
    await events(s)
    const evs = await events(s)
    expect(evs.map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
    expect(h.runs).toHaveLength(2)
    expect(h.posts.map(p => p.headers['authorization'])).toEqual([`Bearer ${KEY}-1`, `Bearer ${KEY}-1`, `Bearer ${KEY}-2`])
  }
  const { h, s } = fake([{ status: 401, body: '{"error":{"message":"bad key"}}' }, {}])
  expect(errorOf(await events(s))).toBe('klyth: acme rejected its key (HTTP 401); store a valid one with bun run auth login acme, then retry')
  expect([h.runs.length, h.posts.length]).toEqual([1, 1])
  await events(s)
  expect(h.runs).toHaveLength(2)
  const twice = fake([{}, { status: 401 }])
  await events(twice.s)
  expect(errorOf(await events(twice.s))).toMatch(/^klyth: acme rejected its key \(HTTP 401\)/)
  expect([twice.h.runs.length, twice.h.posts.length]).toEqual([2, 3])
})

test('an HTTP error, a cut before any answer and a cut mid-stream each end the step with one request error and stats', async () => {
  const cases: [Reply, string][] = [
    [{ status: 404, body: '{"error":{"message":"no such model"}}' }, 'klyth: acme HTTP 404: no such model; check providers.acme.baseUrl and the model id m'],
    [{ before: { kind: 'connect-timeout', detail: '' } }, 'klyth: acme could not connect within 15 s; check the network or VPN, then retry'],
    [{ before: { kind: 'redirect', detail: '301' } }, 'klyth: acme answered with a redirect (HTTP 301), which klyth does not follow; set providers.acme.baseUrl to the URL it redirects to'],
    [{ body: sse({ choices: [{ index: 0, delta: { content: 'par' } }] }), cut: { kind: 'stall', detail: '600' } }, 'klyth: acme stalled (no data for 600 s); retry'],
  ]
  for (const [reply, text] of cases) {
    const { h, s } = fake([reply])
    const evs = await events(s)
    expect(evs.filter(e => e.type === 'error')).toEqual([{ type: 'error', kind: 'request', text }])
    expect(evs.at(-1)).toMatchObject({ type: 'stats', in: null, out: null, finish: 'error' })
    expect(h.logs.at(-1)).toContain(`finish=error error=${JSON.stringify(text)}`)
  }
})

const BUSY: Reply = { status: 503, body: '{"error":{"message":"upstream connect error or disconnect/reset before headers. reset reason: connection termination"}}' }
const TEN = 'klyth: acme HTTP 503: upstream connect error or disconnect/reset before headers. reset reason: connection termination; the provider failed after 10 attempts: retry, or pick another model'
// Runs `body` with Math.random fixed at `r`, so a wait is `r` times its ceiling.
async function withRandom(r: number, body: () => Promise<void>) {
  const random = spyOn(Math, 'random').mockReturnValue(r)
  try {
    await body()
  } finally {
    random.mockRestore()
  }
}

test('503 ten times ends the step with the failure text and the number of attempts; nine waits double from 1 s to 256 s, each a random share of its ceiling', async () => {
  for (const r of [0, 0.5, 0.999999]) {
    await withRandom(r, async () => {
      const { h, s } = fake([BUSY])
      const evs = await events(s)
      expect(errorOf(evs)).toBe(TEN)
      expect(evs.at(-1)).toMatchObject({ type: 'stats', finish: 'error' })
      expect(h.posts).toHaveLength(10)
      expect(h.slept).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000].map(ceiling => Math.round(r * ceiling)))
      expect(h.logs.slice(0, 9).map(l => l.replace(/ wait=\d+$/, ''))).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `klyth retry main → acme/m attempt=${n} after=http 503`))
      expect(h.logs.at(-1)).toContain('http=503')
    })
  }
})

test('an accounting summary retains every retry attempt before terminal events without changing the legacy stream', async () => {
  await withRandom(0, async () => {
    const id = crypto.randomUUID()
    const request: StepWire = { ...wire({ accounting: { purpose: 'step', owner: 'main' } }), accounting: { requestId: 'session:1:1', executionId: id } }
    const detailed = fake([BUSY, {}])
    const observed: unknown[] = []
    for await (const event of detailed.s.stepWithAccounting(request, new AbortController().signal)) observed.push(event)
    expect(observed[1]).toMatchObject({
      type: 'usage_summary', requestId: 'session:1:1', executionId: id, outcome: 'success',
      attempts: [{ sequence: 1, outcome: 'httpError' }, { sequence: 2, outcome: 'success', evidence: { finality: 'final', totalInput: { status: 'reported', count: 10 }, output: { status: 'reported', count: 2 } } }],
    })
    expect(observed.filter(event => (event as { type: string }).type !== 'usage_summary').map(event => (event as { type: string }).type)).toEqual(['text', 'usage', 'stop', 'stats'])
    expect(observed.findIndex(event => (event as { type: string }).type === 'usage_summary')).toBeLessThan(observed.findIndex(event => (event as { type: string }).type === 'stop'))
    const legacy = fake([BUSY, {}])
    expect((await events(legacy.s, request)).map(event => event.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  })
})

test('500, 502, 503, 504 and 529 are each sent again, with one wait and one debug line and the events of the answer alone; 400, 401, 403, 404, 422, 501 and 505 are not, and say nothing of attempts', async () => {
  for (const status of [500, 502, 503, 504, 529]) {
    await withRandom(0.5, async () => {
      const { h, s } = fake([{ status, body: '{"error":{"message":"down"}}' }, {}])
      expect((await events(s)).map(e => e.type), String(status)).toEqual(['text', 'usage', 'stop', 'stats'])
      expect([h.posts.length, h.slept]).toEqual([2, [500]])
      expect(h.logs).toEqual([`klyth retry main → acme/m attempt=2 after=http ${status} wait=500`, expect.stringMatching(/^klyth step main → acme\/m .* http=200 .* finish=stop$/)])
    })
  }
  for (const status of [400, 401, 403, 404, 422, 501, 505]) {
    const { h, s } = fake([{ status, body: '{"error":{"message":"no"}}' }, {}])
    const text = errorOf(await events(s)) ?? ''
    expect(text, String(status)).toMatch(new RegExp(`^klyth: acme (HTTP ${status}: no; |rejected its key \\(HTTP 401\\))`))
    expect(text).not.toContain('attempts')
    expect([h.posts.length, h.slept]).toEqual([1, []])
  }
})

test('a ChatGPT plan code in a 503 or a 429 is never sent again, and a 507 is sent again only for Envoy\'s retry-buffer text', async () => {
  for (const code of ['subscription_sharing_usage_unavailable', 'subscription_sharing_invalid_user', 'subscription_sharing_new_code', 'chatpass_v2', 'chatpass_other']) {
    const { h, s } = fake([{ status: 503, body: JSON.stringify({ error: { message: 'plan', code } }) }, {}])
    expect(errorOf(await events(s)), code).toMatch(/^klyth: acme HTTP 503: plan; /)
    expect([h.posts.length, h.slept]).toEqual([1, []])
  }
  const limit = fake([{ status: 429, body: JSON.stringify({ error: { message: 'plan', code: 'subscription_sharing_usage_limit_exceeded' } }), retryAfter: '1' }, {}])
  expect(errorOf(await events(limit.s))).toMatch(/^klyth: acme HTTP 429: plan; /)
  expect([limit.h.posts.length, limit.h.slept]).toEqual([1, []])
  const buffer = 'exceeded request buffer limit while retrying upstream'
  const { h, s } = fake([{ status: 507, body: buffer }, {}])
  expect((await events(s)).map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  expect(h.posts).toHaveLength(2)
  const down = fake([{ status: 507, body: buffer }])
  expect(errorOf(await events(down.s))).toBe(`klyth: acme HTTP 507: ${buffer}; the provider failed after 10 attempts: retry, or pick another model`)
  for (const body of ['insufficient storage', '{"error":{"message":"insufficient storage"}}', '']) {
    const plain = fake([{ status: 507, body }, {}])
    expect(errorOf(await events(plain.s)), body).toMatch(/^klyth: acme HTTP 507: /)
    expect([plain.h.posts.length, plain.h.slept]).toEqual([1, []])
  }
})

test('a retry-after, in seconds or as a GMT date, is waited out in full and the jittered backoff added; none past 8 s is: the step ends with the error at once; a 429 is sent again only with one', async () => {
  const date = (s: number) => new Date(s * 1000).toUTCString() // the fake clock reads 0
  const cases: [number, string | undefined, number | undefined][] = [
    [429, '2', 2500],
    [429, '1.5', 2000],
    [429, '8', 8500],
    [429, date(5), 5500],
    [503, '3', 3500],
    [503, '0', 500],
    [503, '-5', 500],
    [503, undefined, 500],
    [529, date(0), 500],
    [429, undefined, undefined],
    [429, '9', undefined],
    [429, 'soon', undefined],
    [429, '-5', undefined],
    [429, '1, 2', undefined],
    [429, date(30), undefined],
    [503, '9', undefined],
    [503, date(30), undefined],
  ]
  await withRandom(0.5, async () => {
    for (const [status, retryAfter, wait] of cases) {
      const { h, s } = fake([{ status, body: '{"error":{"message":"slow"}}', ...(retryAfter === undefined ? {} : { retryAfter }) }, {}])
      const evs = await events(s)
      expect([h.posts.length, h.slept], `${status} ${retryAfter}`).toEqual(wait === undefined ? [1, []] : [2, [wait]])
      if (wait === undefined) expect(errorOf(evs)).not.toContain('attempts')
    }
    const limited = fake([{ status: 429, body: '{"error":{"message":"slow"}}', retryAfter: '1' }])
    expect(errorOf(await events(limited.s))).toBe('klyth: acme HTTP 429: slow; rate limited after 10 attempts: wait, then retry')
    expect(limited.h.slept).toEqual([1500, 2000, 3000, 5000, 9000, 17000, 33000, 65000, 129000])
  })
})

test('a connection that failed or was reset before any answer is sent again; a connect timeout, a total timeout, a stall, a redirect, and a certificate, TLS or header fault are not', async () => {
  for (const before of [{ kind: 'reset', detail: 'Error: ECONNRESET' }, { kind: 'reset', detail: 'The socket connection was closed unexpectedly' }, { kind: 'connect', detail: 'klyth.invalid:443 ECONNREFUSED' }] as const) {
    const { h, s } = fake([{ before }, {}])
    expect((await events(s)).map(e => e.type), before.kind).toEqual(['text', 'usage', 'stop', 'stats'])
    expect([h.posts.length, h.slept.length]).toEqual([2, 1])
    expect(h.logs[0]).toMatch(new RegExp(`^klyth retry main → acme/m attempt=2 after=cut ${before.kind} wait=\\d+$`))
  }
  const refused = fake([{ before: { kind: 'connect', detail: 'klyth.invalid:443 ECONNREFUSED' } }])
  expect(errorOf(await events(refused.s))).toBe('klyth: acme could not connect (klyth.invalid:443 ECONNREFUSED) after 10 attempts; check the network or VPN, then retry')
  const reset = fake([{ before: { kind: 'reset', detail: 'ECONNRESET' } }])
  expect(errorOf(await events(reset.s))).toBe('klyth: acme request failed (ECONNRESET) after 10 attempts; retry, or see the debug log')
  expect(reset.h.posts).toHaveLength(10)
  for (const before of [
    { kind: 'connect-timeout', detail: '' },
    { kind: 'total', detail: '20' },
    { kind: 'stall', detail: '600' },
    { kind: 'redirect', detail: '301' },
    { kind: 'reset', detail: 'Error: self signed certificate DEPTH_ZERO_SELF_SIGNED_CERT' },
    { kind: 'reset', detail: 'Error: SSL routines:ssl3_read_bytes:tlsv1 alert' },
    { kind: 'reset', detail: 'TypeError: Header has invalid value' },
  ] as const) {
    const { h, s } = fake([{ before }, {}])
    expect(errorOf(await events(s)), `${before.kind} ${before.detail}`).not.toContain('attempts')
    expect([h.posts.length, h.slept]).toEqual([1, []])
  }
})

test('a failure after the first body byte is sent again never: a reset or a stall mid-stream ends the step with its error and one request', async () => {
  const half = sse({ choices: [{ index: 0, delta: { content: 'par' } }] })
  for (const [cut, text] of [
    [{ kind: 'reset', detail: 'ECONNRESET' }, 'klyth: acme request failed (ECONNRESET); retry, or see the debug log'],
    [{ kind: 'stall', detail: '600' }, 'klyth: acme stalled (no data for 600 s); retry'],
  ] as const) {
    const { h, s } = fake([{ body: half, cut }, {}])
    const evs = await events(s)
    expect(evs.filter(e => e.type === 'text')).toEqual([{ type: 'text', text: 'par' }])
    expect(errorOf(evs)).toBe(text)
    expect([h.posts.length, h.slept]).toEqual([1, []])
    expect(h.logs.filter(l => l.startsWith('klyth retry'))).toEqual([])
  }
})

test('an abort during the 256 s wait ends the step at once with no tenth send', () =>
  withRandom(0.999999, async () => {
    let now = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const { h, s } = fake([BUSY])
      const ac = new AbortController()
      const waiting = new Promise<void>(done => {
        h.onSleep = ms => {
          if (h.slept.length === 9) {
            h.hold = true
            done()
          } else now += ms
        }
      })
      const step = events(s, wire(), ac.signal)
      await waiting
      expect(h.slept.at(-1)).toBe(256000)
      ac.abort()
      expect(await step).toEqual([])
      expect(h.posts).toHaveLength(9)
      expect(h.logs.at(-1)).toContain('finish=aborted')
      expect(h.logs.at(-1)).not.toContain('error=')
    } finally {
      clock.mockRestore()
    }
  }))

test('a rejected cached key is replaced and the new request is then sent again after a 503, with the new key', () =>
  withRandom(0.5, async () => {
    const { h, s } = fake([{}, { status: 401, body: '{"error":{"message":"expired"}}' }, BUSY, {}])
    await events(s)
    expect((await events(s)).map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
    expect(h.posts.map(p => p.headers['authorization'])).toEqual([`Bearer ${KEY}-1`, `Bearer ${KEY}-1`, `Bearer ${KEY}-2`, `Bearer ${KEY}-2`])
    expect([h.runs.length, h.slept]).toEqual([2, [1000]])
  }))

test('a resend carries the same body and headers: the session id, the key and the User-Agent; the key helper runs once', async () => {
  const config = JSON.stringify({
    providers: { cached: { kind: 'openai', baseUrl: 'https://cached.invalid/v1', auth: { command: helper('cached') }, sessionHeader: 'Session_Id', headers: { 'X-Tag': 'klyth' }, models: { m: { contextWindow: 100_000, maxOutputTokens: 8000 } } } },
  })
  const approved = Object.values((parseConfig(config).config as Config).providers).map(fingerprint)
  const { h, s } = fake([BUSY, { before: { kind: 'reset', detail: 'ECONNRESET' } }, {}])
  const evs = await events(s, { token: 't', configText: config, approved, req: { ...REQ, target: 'cached/m', sessionId: 'conv-1' } })
  expect(evs.map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  expect(h.posts).toHaveLength(3)
  expect(h.posts[0]?.headers).toMatchObject({ session_id: 'conv-1', authorization: `Bearer ${KEY}-1`, 'user-agent': UA, 'x-tag': 'klyth' })
  for (const p of h.posts) expect(p).toEqual(h.posts[0] as UpstreamRequest)
  expect(h.runs).toHaveLength(1)
})

test('resends stay inside the time bound: each gets what is left of it, and no wait is taken that would cross it', async () => {
  const acme = (JSON.parse(CONFIG) as { providers: { acme: object } }).providers.acme
  const bounded = (timeoutMs: number): StepWire => ({ ...wire(), configText: JSON.stringify({ providers: { acme: { ...acme, timeoutMs } } }) })
  await withRandom(0.5, async () => {
    // Each send takes 1.5 s and each wait counts, on a 5 s bound, so the third leaves 0.5 s and the 2 s wait after it would cross the bound.
    let now = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const { h, s } = fake([BUSY])
      h.onPost = () => void (now += 1500)
      h.onSleep = ms => void (now += ms)
      expect(errorOf(await events(s, bounded(5000)))).toBe('klyth: acme HTTP 503: upstream connect error or disconnect/reset before headers. reset reason: connection termination; the provider failed after 3 attempts: retry, or pick another model')
      expect([h.posts.map(p => p.totalS), h.slept]).toEqual([[5, 3, 1], [500, 1000]])
      // The 128 s jittered wait after eight waits no longer fits a 200 s bound.
      now = 0
      const long = fake([BUSY])
      long.h.onSleep = ms => void (now += ms)
      expect(errorOf(await events(long.s, bounded(200000)))).toContain('after 9 attempts')
      expect([long.h.posts.length, long.h.slept]).toEqual([9, [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000]])
      // A wait that finishes late exhausts the bound before the next send.
      now = 0
      const overslept = fake([BUSY])
      overslept.h.onSleep = ms => void (now += overslept.h.slept.length === 8 ? 200000 : ms)
      expect(errorOf(await events(overslept.s, bounded(200000)))).toBe('klyth: acme timed out after 200 s; retry, or raise providers.acme.timeoutMs')
      expect([overslept.h.posts.length, overslept.h.slept.length]).toEqual([8, 8])
      // A cached key refused after the clock passed the bound is fetched again but not sent: the step ends as timed out after the bound, with no more posts.
      now = 0
      const late = fake([{}, BUSY, { status: 401, body: '{"error":{"message":"expired"}}' }, {}])
      await events(late.s, bounded(5000))
      late.h.onPost = () => void (now += 3000)
      late.h.onSleep = ms => void (now += ms)
      expect(errorOf(await events(late.s, bounded(5000)))).toBe('klyth: acme timed out after 5 s; retry, or raise providers.acme.timeoutMs')
      expect([late.h.posts.length, late.h.runs.length]).toEqual([3, 2])
    } finally {
      clock.mockRestore()
    }
    // A retry-after longer than the bound is no wait to take: the first answer ends the step.
    const { h, s } = fake([{ ...BUSY, retryAfter: '4' }, {}])
    expect(errorOf(await events(s, bounded(3000)))).not.toContain('attempts')
    expect([h.posts.length, h.slept]).toEqual([1, []])
    const fits = fake([{ ...BUSY, retryAfter: '2' }, {}])
    expect((await events(fits.s, bounded(3000))).map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
    expect(fits.h.slept).toEqual([2500])
  })
})

test('a tool-call id goes back as the provider own id to that provider only; another provider gets the minted id', async () => {
  const call = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'functions.Read:0', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
  const { h, s } = fake([{ body: call }, {}])
  const minted = ((await events(s)).find(e => e.type === 'tool_use') as { id: string }).id
  const transcript: StepRequest['transcript'] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: minted, name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: minted, content: 'x' }] },
  ]
  await events(s, wire({ transcript }))
  await events(s, wire({ target: 'other/m', transcript }))
  const ids = h.posts.slice(1).map(p => (JSON.parse(p.body) as { messages: { tool_calls?: { id: string }[] }[] }).messages[2]?.tool_calls?.[0]?.id)
  expect(ids).toEqual(['functions.Read:0', minted])
})

test('stats end every step; the one debug line per step holds no key and no body, and names an effort mapped to another level', async () => {
  const { h, s } = fake()
  const evs = await events(s, wire({ effort: 'max', transcript: [{ role: 'user', content: `secret prompt ${KEY}` }] }))
  expect(evs.at(-1)).toMatchObject({ type: 'stats', reqBytes: (new TextEncoder().encode(h.posts[0]?.body).length), in: 10, out: 2, finish: 'stop' })
  expect(h.logs).toEqual([expect.stringMatching(/^klyth step main → acme\/m kind=openai http=200 effort=max→high msgs=1 tools=0 bytes=\d+ ttfb=\d+ total=\d+ in=10 out=2 cache=0 wrote=0 reasoning=- load=[a-f0-9]{16} session=- system=[a-f0-9]{16} tools=[a-f0-9]{16} params=[a-f0-9]{16} historyTotal=1 historyOmitted=0 history=0:[a-f0-9]{16} firstMeta=[a-f0-9]{16} firstBlocksTotal=1 firstBlocksOmitted=0 firstBlocks=0:text:\d+:[a-f0-9]{16} store=memory restored=0\/0 finish=stop$/)])
  expect(h.logs.join('\n')).not.toContain(KEY)
  expect(h.logs.join('\n')).not.toContain('secret prompt')
})

test('a step whose client goes away stops reading, cancels its request and yields nothing more', async () => {
  const { h, s } = fake([{ body: sse(...Array.from({ length: 40 }, () => ({ choices: [{ index: 0, delta: { content: 'word ' } }] }))) }])
  const ac = new AbortController()
  const seen: StepEvent[] = []
  for await (const ev of s.step(wire(), ac.signal)) {
    seen.push(ev)
    ac.abort()
  }
  expect(seen).toHaveLength(1)
  expect(h.aborted).toBe(1)
  expect(h.logs.at(-1)).toContain('finish=aborted')
})

test('the request a rejected cached key got is cancelled before the retry, and one whose client left before it answered is cancelled unread', async () => {
  const rejected = fake([{}, { status: 401, body: '{"error":{"message":"expired"}}' }, {}])
  await events(rejected.s)
  await events(rejected.s)
  expect(rejected.h.cancelled).toBe(1)
  const { h, s } = fake()
  const ac = new AbortController()
  h.onPost = () => ac.abort()
  expect(await events(s, wire(), ac.signal)).toEqual([])
  expect(h.cancelled).toBe(1)
  expect(h.logs.at(-1)).toContain('finish=aborted')
})

test('a request cut because the client went away is no failure: no error event, no error in the debug line', async () => {
  const { h, s } = fake([{ before: { kind: 'reset', detail: 'AbortError: The operation was aborted.' } }])
  const ac = new AbortController()
  h.onPost = () => ac.abort()
  expect(await events(s, wire(), ac.signal)).toEqual([])
  expect(h.logs).toEqual([expect.stringMatching(/finish=aborted$/)])
})

test('status reads each provider key state from the request approvals, running nothing', async () => {
  const { h, s } = fake()
  await events(s)
  expect(s.status(wire())).toEqual([
    { provider: 'acme', key: 'cached' },
    { provider: 'other', key: 'not-run' },
    { provider: 'claude', key: 'not-run' },
    { provider: 'free', key: 'none' },
    { provider: 'freecl', key: 'none' },
  ])
  expect(s.status(wire({}, []))).toEqual([
    { provider: 'acme', key: 'not-run' },
    { provider: 'other', key: 'not-run' },
    { provider: 'claude', key: 'not-run' },
    { provider: 'free', key: 'none' },
    { provider: 'freecl', key: 'none' },
  ])
  expect(h.runs).toHaveLength(1)
})

// A provider of the anthropic kind whose model thinks (a manual budget) and caches for five minutes.
const THINKING_CONFIG = JSON.stringify({
  providers: { cl: { kind: 'anthropic', baseUrl: 'https://cl.invalid', auth: { command: helper('cl') }, models: { m: { contextWindow: 100_000, maxOutputTokens: 8000, cache: '5m', params: { thinking: { type: 'enabled', budget_tokens: 2048 } } }, n: { contextWindow: 100_000, maxOutputTokens: 8000 } } } },
})
const CL = fingerprint(((parseConfig(THINKING_CONFIG).config as Config).providers['cl']) as ProviderConfig)
const thinkingWire = (req: Partial<StepRequest>): StepWire => ({ token: 't', configText: THINKING_CONFIG, approved: [CL], req: { ...REQ, target: 'cl/m', ...req } })
const THINKING_TURN = sse(
  { type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 90 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'RED' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
)
const TEXT_TURN = sse(
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
)
const bodyOf = (r: UpstreamRequest | undefined) => JSON.parse(r?.body ?? '{}') as { thinking?: unknown; messages: { role: string; content: ({ type: string } & Record<string, unknown>)[] }[] }
const afterTool = (id: string): StepRequest['transcript'] => [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
]

test("a tool turn's signed thinking comes back first in its assistant turn on the next step, with the thinking param kept", async () => {
  const { h, s } = fake([{ body: THINKING_TURN }, { body: TEXT_TURN }])
  const first = await events(s, thinkingWire({ tools: [{ name: 'Read', description: 'r', schema: {} }] }))
  const id = (first.find(e => e.type === 'tool_use') as { id: string }).id
  expect(first.filter(e => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'hmm' }])
  expect(first.find(e => e.type === 'stats')).toMatchObject({ in: 100, out: 7, finish: 'tool_use' })
  expect(first.find(e => e.type === 'usage')).toMatchObject({ in: 10, cacheRead: 0, cacheWrite: 90 })
  await events(s, thinkingWire({ transcript: afterTool(id) }))
  const sent = bodyOf(h.posts[1])
  expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(sent.messages[1]?.content).toEqual([
    { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
    { type: 'redacted_thinking', data: 'RED' },
    { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} },
  ])
  const steps = h.logs.filter(l => l.startsWith('klyth step '))
  expect(steps).toHaveLength(2)
  expect(steps[0]).toContain(' thinking=2')
  expect(steps[1]).not.toContain('note=')
})

test('a tool turn whose thinking klythd no longer holds (a restart, or another model wrote it) goes out without the thinking param, with one note in the debug line, and the step still runs', async () => {
  const id = 'toolu_klyth_gone'
  const restarted = fake([{ body: TEXT_TURN }])
  expect((await events(restarted.s, thinkingWire({ transcript: afterTool(id) }))).map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  const sent = bodyOf(restarted.h.posts[0])
  expect('thinking' in sent).toBe(false)
  expect(sent.messages[1]?.content.map(b => b.type)).toEqual(['tool_use'])
  expect(restarted.h.logs).toEqual([expect.stringContaining('note="thinking param left out: the signed blocks of this tool turn are not held"')])
  // The thinking of model m is not given to model n of the same provider.
  const { h, s } = fake([{ body: THINKING_TURN }, { body: TEXT_TURN }])
  const minted = ((await events(s, thinkingWire({}))).find(e => e.type === 'tool_use') as { id: string }).id
  await events(s, thinkingWire({ target: 'cl/n', transcript: afterTool(minted) }))
  expect(bodyOf(h.posts[1]).messages[1]?.content.map(b => b.type)).toEqual(['tool_use'])
  // A turn after the tool turn is not one in progress: its thinking is not asked for.
  const later = [...afterTool(id), { role: 'assistant' as const, content: 'done' }, { role: 'user' as const, content: 'again' }]
  const next = fake([{ body: TEXT_TURN }])
  await events(next.s, thinkingWire({ transcript: later }))
  expect(bodyOf(next.h.posts[0]).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(next.h.logs[0]).not.toContain('note=')
})

test('a turn that called a tool without thinking is not a lost turn: the next step keeps the thinking param', async () => {
  const calls = THINKING_TURN.replace(/data: \{"type":"content_block_start","index":[01],.*?\n\n/gs, '').replace(/data: \{"type":"content_block_(delta|stop)","index":[01],.*?\n\n/gs, '')
  const { h, s } = fake([{ body: calls }, { body: TEXT_TURN }])
  const first = await events(s, thinkingWire({}))
  expect(first.map(e => e.type)).toContain('tool_use')
  await events(s, thinkingWire({ transcript: afterTool((first.find(e => e.type === 'tool_use') as { id: string }).id) }))
  expect(bodyOf(h.posts[1]).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(bodyOf(h.posts[1]).messages[1]?.content.map(b => b.type)).toEqual(['tool_use'])
  expect(h.logs.join('\n')).not.toMatch(/note=| thinking=/)
})

const thinkingBlock = (index: number, text: string, signature: string) => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index },
]

test('thinking interleaved with text and a call, [T1, A, T2, B], is sent back in that order on the next step', async () => {
  const turn = sse(
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    ...thinkingBlock(0, 'one', 'S1'),
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'A' } },
    { type: 'content_block_stop', index: 1 },
    ...thinkingBlock(2, 'two', 'S2'),
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
  )
  const { h, s } = fake([{ body: turn }, { body: TEXT_TURN }])
  const first = await events(s, thinkingWire({ tools: [{ name: 'Read', description: 'r', schema: {} }] }))
  const id = (first.find(e => e.type === 'tool_use') as { id: string }).id
  const transcript: StepRequest['transcript'] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'tool_use', id, name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
  ]
  await events(s, thinkingWire({ transcript }))
  expect(bodyOf(h.posts[1]).messages[1]?.content).toEqual([
    { type: 'thinking', thinking: 'one', signature: 'S1' },
    { type: 'text', text: 'A' },
    { type: 'thinking', thinking: 'two', signature: 'S2' },
    { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} },
  ])
})

test('the debug line counts thinking blocks only when they are kept: not for a turn with no calls, nor for a step that failed', async () => {
  const think = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }, ...thinkingBlock(0, 'hm', 'S')]
  const answered = fake([{ body: sse(...think, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) }])
  expect((await events(answered.s, thinkingWire({}))).map(e => e.type)).toContain('stop')
  expect(answered.h.logs[0]).not.toContain('thinking=')
  const cut = fake([{ body: sse(...think, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} } }) }])
  expect(errorOf(await events(cut.s, thinkingWire({})))).toContain('the stream ended inside a tool call')
  expect(cut.h.logs[0]).not.toContain('thinking=')
})

test('a finish reason carrying a newline and a forged step line is one debug line, with the placeholder token in the line and the stats', async () => {
  const forged = 'stop\nklyth step main → acme/m kind=openai http=200 finish=stop'
  const { h, s } = fake([{ body: sse({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: forged }] }, '[DONE]') }])
  const evs = await events(s)
  expect(evs.at(-1)).toMatchObject({ type: 'stats', finish: 'other' })
  expect(evs.find(e => e.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
  expect(h.logs.join('\n').split('\n')).toEqual([expect.stringMatching(/ finish=other note="finish_reason \\"other\\" read as end_turn"$/)])
})

test('a finish reason is read as a lowercase token of at most 64 characters, any other text as other; every known one still maps to its stop', () => {
  for (const [kind, codec] of Object.entries(CODECS)) {
    const end = (reason: string) => {
      const asm = assembler(codec, 'p', remoteIds())
      asm.feed([{ t: 'finish', reason }])
      return asm.end(providers['acme'] as ProviderConfig)
    }
    for (const [reason, stop] of Object.entries(codec.stops)) expect(end(reason), `${kind} ${reason}`).toEqual({ events: [{ type: 'stop', reason: stop }], finish: reason })
    expect(end('Tool_Use').finish).toBe('tool_use')
    expect(end('a'.repeat(64)).finish).toBe('a'.repeat(64))
    for (const hostile of ['', 'a'.repeat(65), 'a b', 'stop\nklyth step forged', 'stop\r', 'stop\u2028x', 'tool\u0000use', 'stöp', '\u001b[31mred', 'x'.repeat(1 << 20)]) {
      expect(end(hostile), `${kind} ${JSON.stringify(hostile.slice(0, 20))}`).toMatchObject({ events: [{ type: 'stop', reason: 'end_turn' }], finish: 'other' })
    }
  }
})

test('an in-stream error of a megabyte of whitespace ends the step at once with one response error on one line', async () => {
  const { h, s } = fake([{ body: sse({ error: { message: ' '.repeat(1 << 20) } }) }])
  const started = performance.now()
  const evs = await events(s)
  expect(performance.now() - started).toBeLessThan(2000)
  const text = errorOf(evs) as string
  expect(text).toMatch(/^klyth: acme response failed: .*; retry, or see the debug log$/)
  expect(text.length).toBeLessThan(500)
  expect(h.logs.join('\n').split('\n')).toHaveLength(1)
})

test("an in-stream error carrying a ChatGPT plan-usage code ends with that code's fix, one carrying none with the retry line", async () => {
  const cap = fake([{ body: sse({ error: { message: 'cap reached', code: 'subscription_sharing_usage_limit_exceeded' } }) }])
  expect(errorOf(await events(cap.s))).toBe("klyth: acme response failed: cap reached; your ChatGPT plan's usage limit for klyth is reached; wait for it to reset, or raise it in ChatGPT settings")
  const plain = fake([{ body: sse({ error: { message: 'boom', code: 'other' } }) }])
  expect(errorOf(await events(plain.s))).toBe('klyth: acme response failed: boom; retry, or see the debug log')
})

// A provider that keeps sending valid data (2000 more chunks) after `opening`, counting those read past it
// and the requests cancelled.
function endless(opening: string[]) {
  const h = { after: 0, cancelled: 0 }
  const more = sse({ choices: [{ index: 0, delta: { content: 'x' } }] })
  const post = async (): Promise<Answer> => {
    async function* body(): AsyncGenerator<Uint8Array, Cut | undefined> {
      for (const piece of opening) yield new TextEncoder().encode(piece)
      for (let i = 0; i < 2000; i++) {
        h.after++
        yield new TextEncoder().encode(more)
      }
      return undefined
    }
    return { status: 200, body: body(), cancel: () => void h.cancelled++ }
  }
  return { h, s: createStepper({ version: '0.2.0', post, run: async () => ({ exitCode: 0, stdout: '' }), sleep: async () => {}, now: () => 0, log: () => {} }) }
}

for (const [why, opening, said] of [
  ['an in-stream error', [sse({ error: { message: 'boom' } })], 'boom'],
  ['a line over 16 MiB', ['data: ', ...Array<string>(17).fill('a'.repeat(1 << 20))], 'a line over 16 MiB'],
  ['a tool call whose arguments are not an object', [sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '[1]' } }] }, finish_reason: 'tool_calls' }] })], 'not a JSON object'],
] as const) {
  test(`after ${why} the step cancels the request and reads none of the rest of the body, and ends with its one error`, async () => {
    const { h, s } = endless([...opening])
    const evs = await events(s, wire({ target: 'free/m' }))
    expect(h.after).toBe(0)
    expect(h.cancelled).toBe(1)
    expect(evs.map(e => e.type)).toEqual(['error', 'stats'])
    expect(errorOf(evs)).toContain(said)
    expect(evs.at(-1)).toMatchObject({ type: 'stats', finish: 'error' })
  })
}

test('the U+2028, U+2029 and bidirectional control characters of a provider text are escaped in the debug line, so it stays one line in order', async () => {
  const tricky = 'a\u2028b\u2029c\u202ed\u202ce\u2066f\u2069g'
  const { h, s } = fake([{ body: sse({ error: { message: tricky } }) }])
  expect(errorOf(await events(s))).toContain('a\u2028b')
  const line = h.logs.join('\n')
  expect(line).toContain('error="klyth: acme response failed: a\\u2028b\\u2029c\\u202ed\\u202ce\\u2066f\\u2069g;')
  expect(line).not.toMatch(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
  expect(line.split('\n')).toHaveLength(1)
})

const diagnostics = (line: string) => Object.fromEntries([...line.matchAll(/(load|session|system|tools|params|history)=([^ ]+)/g)].map(m => [m[1], m[2]]))

test('outbound fingerprints distinguish a daemon reload, session header, prompt, tool order, effort and each history item without logging their contents', async () => {
  const configText = JSON.stringify({ providers: { acme: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: 'none', sessionHeader: 'Session_ID', models: { m: MODEL } } } })
  expect(parseConfig(configText).errors).toEqual([])
  const approved = Object.values((parseConfig(configText).config as Config).providers).map(fingerprint)
  const req: Partial<StepRequest> = { sessionId: 'private-session-uuid', system: 'private-system', tools: [{ name: 'Read', description: 'private-description', schema: { type: 'object' } }, { name: 'Write', description: 'private-write', schema: {} }], transcript: [{ role: 'user', content: 'private-first' }, { role: 'assistant', content: 'private-second' }] }
  const { h, s } = fake()
  const send = async (patch: Partial<StepRequest> = {}) => { await events(s, { ...wire({ ...req, ...patch }, approved), configText }); return diagnostics(h.logs.at(-1) as string) }
  const first = await send()
  expect(await send()).toEqual(first)
  const appended = await send({ transcript: [...(req.transcript ?? []), { role: 'user', content: 'private-resume' }] })
  expect(appended.history?.split(',').slice(0, 2)).toEqual(first.history?.split(','))
  const changed = await send({ transcript: [{ role: 'user', content: 'private-changed' }, (req.transcript ?? [])[1]!] })
  expect(changed.history?.split(',')[0]).not.toBe(first.history?.split(',')[0])
  expect(changed.history?.split(',')[1]).toBe(first.history?.split(',')[1])
  expect((await send({ system: 'changed-system' })).system).not.toBe(first.system)
  expect((await send({ transcript: [{ role: 'user', content: 'private-first\n<postscript>changed metadata</postscript>' }, (req.transcript ?? [])[1]!] })).history?.split(',')[0]).not.toBe(first.history?.split(',')[0])
  expect((await send({ tools: [{ ...(req.tools ?? [])[0]!, description: 'changed-description' }, (req.tools ?? [])[1]!] })).tools).not.toBe(first.tools)
  expect((await send({ tools: [{ ...(req.tools ?? [])[0]!, schema: { type: 'object', properties: { changed: { type: 'string' } } } }, (req.tools ?? [])[1]!] })).tools).not.toBe(first.tools)
  expect((await send({ tools: [...(req.tools ?? [])].reverse() })).tools).not.toBe(first.tools)
  expect((await send({ effort: 'low' })).params).not.toBe(first.params)
  expect((await send({ sessionId: 'changed-session' })).session).not.toBe(first.session)
  expect((await send({ sessionId: undefined })).session).toBe('-')
  const reloaded = fake()
  await events(reloaded.s, { ...wire(req, approved), configText })
  expect(diagnostics(reloaded.h.logs[0] as string).load).not.toBe(first.load)
  expect(diagnostics(reloaded.h.logs[0] as string).system).not.toBe(first.system)
  expect(h.logs.join(' ')).not.toMatch(/private-|changed-system|changed-session|sk-klyth/)
  expect(h.posts[0]?.headers['session_id']).toBe(req.sessionId)
  expect(h.posts[0]?.body).toBe(h.posts[1]?.body)
})

test('fingerprints cover the encoded system, tools and history of every codec, not only Chat Completions', async () => {
  for (const kind of ['anthropic', 'bedrock', 'openai-responses'] as const) {
    const configText = JSON.stringify({ providers: { acme: { kind, baseUrl: 'https://klyth.invalid/v1', auth: { command: helper('acme') }, models: { m: { contextWindow: 100_000, maxOutputTokens: 8000 } } } } })
    expect(parseConfig(configText).errors).toEqual([])
    const approved = Object.values((parseConfig(configText).config as Config).providers).map(fingerprint)
    const { h, s } = fake()
    const send = async (patch: Partial<StepRequest> = {}) => { await events(s, { ...wire(patch, approved), configText }); return diagnostics(h.logs.at(-1) as string) }
    const first = await send()
    expect(first.system).toMatch(/^[a-f0-9]{16}$/)
    expect((await send({ system: 'changed' })).system).not.toBe(first.system)
    expect((await send({ tools: [{ name: 'Read', description: 'read', schema: {} }] })).tools).not.toBe(first.tools)
    expect((await send({ transcript: [{ role: 'user', content: 'changed' }] })).history).not.toBe(first.history)
  }
})

test('a thousand history items log only indexed head and tail samples, even on a long provider error', async () => {
  const transcript = Array.from({ length: 1000 }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: `private-item-${i}` }))
  const { h, s } = fake([{ body: sse({ error: { message: 'x'.repeat(4096) } }) }])
  await events(s, wire({ transcript }))
  const line = h.logs[0] as string
  expect(line).toContain('historyTotal=1000 historyOmitted=968')
  const sample: string[] = diagnostics(line).history?.split(',') ?? []
  expect(sample).toHaveLength(32)
  expect(sample.map(v => Number(v.split(':')[0]))).toEqual([...Array.from({ length: 16 }, (_, i) => i), ...Array.from({ length: 16 }, (_, i) => 984 + i)])
  expect(line.length).toBeLessThanOrEqual(7000)
  expect(line).toContain(' load=')
  expect(line).not.toContain('private-item-')
})

test('a fingerprint digest failure still sends the unchanged provider request', async () => {
  const digest = spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('fingerprint failure'))
  try {
    const { h, s } = fake()
    expect(errorOf(await events(s))).toBeUndefined()
    expect(h.posts).toHaveLength(1)
    expect(h.logs[0]).toContain('system=unavailable')
    expect(h.logs[0]).not.toContain('fingerprint failure')
  } finally { digest.mockRestore() }
})

test('first-item block diagnostics locate a transient reminder change without preserving stale context', async () => {
  const configText = JSON.stringify({ providers: { acme: { kind: 'openai-responses', baseUrl: 'https://klyth.invalid/v1', auth: 'none', models: { m: MODEL } } } })
  const approved = Object.values((parseConfig(configText).config as Config).providers).map(fingerprint)
  const { h, s } = fake([{ body: sse({ type: 'response.completed', response: {} }) }])
  const fields = (line: string) => Object.fromEntries([...line.matchAll(/(firstMeta|firstBlocksTotal|firstBlocksOmitted|firstBlocks)=([^ ]+)/g)].map(m => [m[1], m[2]]))
  const send = async (notice: string, resumed = false) => {
    await events(s, { ...wire({ transcript: [{ role: 'user', content: [{ type: 'text', text: notice }, { type: 'text', text: 'private-task' }] }, ...(resumed ? [{ role: 'assistant' as const, content: 'private-reply' }, { role: 'user' as const, content: 'private-resume' }] : [])] }, approved), configText })
    return fields(h.logs.at(-1) as string)
  }
  const notice = '<system-reminder>private-available-tools</system-reminder>'
  const first = await send(notice)
  const changed = await send('<system-reminder>private-permission-revoked</system-reminder>', true)
  expect(changed.firstMeta).toBe(first.firstMeta)
  expect(changed.firstBlocksTotal).toBe('2')
  expect(changed.firstBlocksOmitted).toBe('0')
  expect(changed.firstBlocks?.split(',')[0]).not.toBe(first.firstBlocks?.split(',')[0])
  expect(changed.firstBlocks?.split(',')[1]).toBe(first.firstBlocks?.split(',')[1])
  expect(await send(notice, true)).toEqual(first)
  expect(JSON.parse(h.posts[1]!.body).input[0].content[0].text).toBe('<system-reminder>private-permission-revoked</system-reminder>')
  expect(JSON.parse(h.posts[2]!.body).input[0]).toEqual(JSON.parse(h.posts[0]!.body).input[0])
  expect(h.logs.join(' ')).not.toMatch(/private-|system-reminder|sk-klyth/)
  expect(first.firstBlocks).toMatch(/^0:input_text:\d+:[a-f0-9]{16},1:input_text:\d+:[a-f0-9]{16}$/)
})

test('first-item block samples stay bounded and use only finite categories for untrusted block types', async () => {
  const transcript: StepRequest['transcript'] = [{ role: 'user', content: Array.from({ length: 1000 }, (_, i) => ({ type: i === 0 ? 'private-type\nINJECT' : 'text', text: `private-block-${i}` })) }, ...Array.from({ length: 999 }, (_, i) => ({ role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user', content: `history-${i}` }))]
  const configText = JSON.stringify({ providers: { acme: { kind: 'openai-responses', baseUrl: 'https://klyth.invalid/v1', auth: 'none', models: { m: MODEL } } } })
  const approved = Object.values((parseConfig(configText).config as Config).providers).map(fingerprint)
  const { h, s } = fake([{ status: 400, body: JSON.stringify({ error: { message: 'x'.repeat(4096) } }) }])
  await events(s, { ...wire({ transcript }, approved), configText })
  const line = h.logs[0] as string
  expect(line).toContain('firstBlocksTotal=1000 firstBlocksOmitted=984')
  const blocks = / firstBlocks=([^ ]+)/.exec(line)?.[1]?.split(',') ?? []
  expect(blocks).toHaveLength(16)
  expect(blocks.map(b => Number(b.split(':')[0]))).toEqual([...Array.from({ length: 8 }, (_, i) => i), ...Array.from({ length: 8 }, (_, i) => 992 + i)])
  expect(blocks.every(b => /^\d+:input_text:\d+:[a-f0-9]{16}$/.test(b))).toBe(true)
  expect(line).not.toMatch(/private-|INJECT/)
  expect(line.split('\n')).toHaveLength(1)
  expect(line).toContain('historyTotal=1000 historyOmitted=968')
  expect(/ history=([^ ]+)/.exec(line)?.[1]?.split(',')).toHaveLength(32)
  expect(line.length).toBeLessThanOrEqual(7000)
})

test('unknown encoded block labels are logged as other without changing the outgoing body', async () => {
  const original = CODECS.openai.encode
  const encode = spyOn(CODECS.openai, 'encode').mockImplementation((...args) => {
    const enc = original(...args), body = JSON.parse(enc.body)
    body.messages[1].content = [{ type: 'private-type\nINJECT', text: 'private-payload' }]
    return { ...enc, body: JSON.stringify(body) }
  })
  try {
    const { h, s } = fake()
    await events(s)
    expect(h.logs[0]).toMatch(/ firstBlocks=0:other:\d+:[a-f0-9]{16} /)
    expect(h.logs[0]).not.toMatch(/private-|INJECT/)
    expect(JSON.parse(h.posts[0]!.body).messages[1].content[0].type).toBe('private-type\nINJECT')
  } finally { encode.mockRestore() }
})

test('compaction refuses unsafe overrides, and sends quota failure only once', async () => {
  for (const req of [{ compaction: { outputTokens: 8001 } }, { compaction: { outputTokens: 0 } }, { compaction: { prefixMessages: -1 } }, { compaction: { prefixMessages: 2 } }]) {
    const f = fake()
    const received = await Array.fromAsync(f.s.step(wire(req), new AbortController().signal))
    expect(received.some(e => e.type === 'error')).toBe(true)
    expect(f.h.posts).toHaveLength(0)
  }
  const schema = fake()
  await events(schema.s, wire({ compaction: { outputTokens: 8000, prefixMessages: 0 }, tools: [{ name: 'Read', description: 'Reads', schema: { type: 'object' } }] }))
  expect(JSON.parse(schema.h.posts[0]!.body).tools[0].function.name).toBe('Read')
  const f = fake([{ status: 429, body: 'quota' }])
  const received = await Array.fromAsync(f.s.step(wire({ compaction: {} }), new AbortController().signal))
  expect(received.some(e => e.type === 'error')).toBe(true)
  expect(f.h.posts).toHaveLength(1)
  expect(f.h.slept).toEqual([])
  const auth = fake([{ status: 401, body: 'expired' }])
  await events(auth.s) // prime its cached key
  auth.h.posts.length = 0
  await events(auth.s, wire({ compaction: {} }))
  expect(auth.h.posts).toHaveLength(1)
})

const OVERLOAD_MESSAGE = 'Our servers are currently overloaded. Please try again later.'
const OVERLOAD = { type: 'response.failed', response: { error: { type: 'server_error', message: OVERLOAD_MESSAGE } } }
const RESPONSE_OK = sse(
  { type: 'response.output_text.delta', delta: 'recovered' },
  { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3 } } },
)
function responsesWire(req: Partial<StepRequest> = {}, provider: Record<string, unknown> = {}): StepWire {
  const original = JSON.parse(CONFIG).providers.acme
  return { ...wire(req), configText: JSON.stringify({ providers: { acme: { ...original, kind: 'openai-responses', sessionHeader: 'session_id', ...provider } } }), approved: [fingerprint({ ...providers['acme']!, kind: 'openai-responses' })] }
}

test('streamed overload before output recovers identically for main and child, discarding failed usage and closing before the wait', async () => {
  for (const who of ['main', 'child-1']) await withRandom(0.5, async () => {
    const { h, s } = fake([{ body: sse({ ...OVERLOAD, response: { ...OVERLOAD.response, usage: { input_tokens: 999, output_tokens: 999 } } }), retryAfter: '1' }, { body: RESPONSE_OK }])
    h.onSleep = () => expect(h.cancelled).toBe(1)
    const out = await events(s, responsesWire({ who, sessionId: 'same-session' }))
    expect(out).toEqual([
      { type: 'text', text: 'recovered' },
      { type: 'usage', in: 7, out: 3, cacheRead: 0, cacheWrite: 0 },
      { type: 'stop', reason: 'end_turn' },
      expect.objectContaining({ type: 'stats', in: 7, out: 3, finish: 'completed' }),
    ])
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1]).toEqual(h.posts[0]!)
    expect(h.posts[1]?.headers['session_id']).toBe('same-session')
    expect(h.runs).toHaveLength(1)
    expect(h.slept).toEqual([1500])
    expect(h.logs[0]).toBe(`klyth retry ${who} → acme/m attempt=2 after=stream server/overload wait=1500`)
    expect(h.logs.join('\n')).not.toContain(KEY)
    expect(h.logs.join('\n')).not.toContain(OVERLOAD_MESSAGE)
  })
})

test('metadata-only startup can retry, including multiple events and failure in one chunk', async () => {
  const metadata = sse({ type: 'response.created', response: { id: 'failed-id' } }, { type: 'response.in_progress', response: { id: 'failed-id' } })
  for (const pieces of [[metadata, sse(OVERLOAD)], [metadata + sse(OVERLOAD)]]) {
    const { h, s } = fake([{ pieces }, { body: RESPONSE_OK }])
    const out = await events(s, responsesWire())
    expect(errorOf(out)).toBeUndefined()
    expect(h.posts).toHaveLength(2)
    expect(JSON.stringify(out)).not.toContain('failed-id')
    expect(out.filter(e => e.type === 'usage')).toEqual([{ type: 'usage', in: 7, out: 3, cacheRead: 0, cacheWrite: 0 }])
  }
})

const ACTIVITY: [string, Record<string, unknown>][] = [
  ['successful finish', { type: 'response.completed', response: {} }],
  ['text', { type: 'response.output_text.delta', delta: 'partial' }],
  ['reasoning', { type: 'response.reasoning_text.delta', delta: 'considering' }],
  ['reasoning summary', { type: 'response.reasoning_summary_text.delta', delta: 'considering' }],
  ['reasoning part start', { type: 'response.reasoning_summary_part.added', part: {} }],
  ['sealed reasoning', { type: 'response.output_item.done', item: { type: 'reasoning', id: 'failed-reasoning', encrypted_content: 'opaque-failed' } }],
  ['refusal', { type: 'response.refusal.delta', delta: '' }],
  ['content part start', { type: 'response.content_part.added', part: { type: 'output_text', text: '' } }],
  ['tool start', { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'failed-call', name: 'Read', arguments: '' } }],
  ['partial arguments', { type: 'response.function_call_arguments.delta', delta: '{"file_path":' }],
  ['complete tool', { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'failed-call', name: 'Read', arguments: '{}' } }],
]
for (const [name, activity] of ACTIVITY) test(`${name} blocks replay before overload, separately and in the same chunk`, async () => {
  for (const pieces of [[sse(activity), sse(OVERLOAD)], [sse(activity, OVERLOAD)]]) {
    const { h, s } = fake([{ pieces }, { body: RESPONSE_OK }])
    const out = await events(s, responsesWire())
    expect(errorOf(out)).toContain(OVERLOAD_MESSAGE)
    expect(h.posts).toHaveLength(1)
    expect(h.slept).toEqual([])
    expect(h.cancelled).toBe(1)
    expect(out.filter(e => e.type === 'tool_use')).toHaveLength(name === 'complete tool' ? 1 : 0)
  }
})

test('output already attached to a failed response prevents replay even without earlier deltas', async () => {
  const failed = { ...OVERLOAD, response: { ...OVERLOAD.response, output: [{ type: 'function_call', call_id: 'partial-call', arguments: '{' }] } }
  const { h, s } = fake([{ body: sse(failed) }, { body: RESPONSE_OK }])
  expect(errorOf(await events(s, responsesWire()))).toContain(OVERLOAD_MESSAGE)
  expect(h.posts).toHaveLength(1)
})

test('HTTP, connection and streamed overload failures exhaust one ten-send budget', () => withRandom(0.5, async () => {
  const replies: Reply[] = Array.from({ length: 10 }, (_, i) => i % 3 === 0 ? BUSY : i % 3 === 1 ? { before: { kind: 'connect', detail: 'ECONNREFUSED' } } : { body: sse(OVERLOAD) })
  replies[9] = { body: sse(OVERLOAD) }
  replies.push({ body: RESPONSE_OK })
  const { h, s } = fake(replies)
  expect(errorOf(await events(s, responsesWire()))).toContain('after 10 attempts')
  expect(h.posts).toHaveLength(10)
  expect(h.slept).toEqual([500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000])
  expect(h.logs.filter(l => l.startsWith('klyth retry'))).toHaveLength(9)
}))

test('one cached-key refresh shares the send limit with HTTP and streamed failures', async () => {
  for (const busyCount of [8, 9]) {
    const { h, s } = fake([{ body: RESPONSE_OK }, ...Array.from({ length: busyCount }, () => BUSY), { status: 401, body: 'expired' }, { body: sse(OVERLOAD) }, { body: RESPONSE_OK }])
    await events(s, responsesWire())
    const out = await events(s, responsesWire())
    expect(errorOf(out)).toContain(busyCount === 8 ? 'after 10 attempts' : 'rejected its key (HTTP 401)')
    expect(h.posts).toHaveLength(11) // one prime, then ten sends for the failing step
    expect(h.runs).toHaveLength(busyCount === 8 ? 2 : 1)
    expect(h.posts.at(-1)?.headers['authorization']).toBe(`Bearer ${KEY}-${busyCount === 8 ? 2 : 1}`)
  }
})

test('unknown, permanent, malformed and missing-finish Responses errors do not retry', async () => {
  const permanent = ['unknown_error', 'insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key', 'authentication_error', 'content_policy_violation', 'invalid_request_error', 'subscription_sharing_usage_limit_exceeded', 'chatpass_v2']
  const bodies = [
    ...permanent.map(code => sse({ type: 'response.failed', response: { error: { type: 'server_error', code, message: OVERLOAD_MESSAGE } } })),
    sse({ type: 'response.failed', response: { error: { message: 'busy, please retry later' } } }),
    'data: {"type":"response.failed",bad}\n\n',
    sse({ type: 'response.output_text.delta', delta: 42 }),
    sse({ type: 'response.created', response: {} }),
  ]
  for (const body of bodies) {
    const { h, s } = fake([{ body }, { body: RESPONSE_OK }])
    expect(errorOf(await events(s, responsesWire())), body).toBeDefined()
    expect(h.posts, body).toHaveLength(1)
    expect(h.slept, body).toEqual([])
  }
})

test('cancel during streamed-overload backoff or pending read sends no further request', async () => {
  const ac = new AbortController()
  const waiting = fake([{ body: sse(OVERLOAD) }, { body: RESPONSE_OK }])
  waiting.h.onSleep = () => ac.abort()
  expect(await events(waiting.s, responsesWire(), ac.signal)).toEqual([])
  expect(waiting.h.posts).toHaveLength(1)
  expect(waiting.h.cancelled).toBe(1)
  expect(waiting.h.logs.at(-1)).toContain('finish=aborted')
  const reading = fake([{ pieces: [sse({ type: 'response.created', response: {} })], holdRead: true }, { body: RESPONSE_OK }])
  const readAbort = new AbortController()
  reading.h.onHold = () => readAbort.abort()
  expect(await events(reading.s, responsesWire(), readAbort.signal)).toEqual([])
  expect(reading.h.posts).toHaveLength(1)
  expect(reading.h.cancelled).toBe(1)
})

test('stream retries and request preparation consume the original provider or request deadline', () => withRandom(0.5, async () => {
  let now = 0
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  try {
    for (const byRequest of [false, true]) {
      now = 0
      const w = responsesWire(byRequest ? { timeoutMs: 3000 } : {}, { timeoutMs: byRequest ? 6000 : 3000 })
      const { h, s } = fake([{ body: sse(OVERLOAD) }, { body: RESPONSE_OK }])
      h.onPost = () => void (now += 2500)
      expect(errorOf(await events(s, w))).toContain(OVERLOAD_MESSAGE)
      expect(h.posts).toHaveLength(1)
      expect(h.slept).toEqual([]) // 500 ms wait does not fit the remaining 500 ms
      now = 0
      const late = fake([{ body: sse(OVERLOAD) }, { body: RESPONSE_OK }])
      late.h.onSleep = () => void (now += 3000)
      expect(errorOf(await events(late.s, w))).toContain(`timed out after 3 s; retry, or raise ${byRequest ? 'classifier.timeoutMs' : 'providers.acme.timeoutMs'}`)
      expect(late.h.posts).toHaveLength(1)
      now = 0
      const preparation = fake([{ body: RESPONSE_OK }])
      preparation.h.onRun = () => void (now += 3000)
      expect(errorOf(await events(preparation.s, w))).toContain('timed out after 3 s')
      expect(preparation.h.posts).toHaveLength(0)
      now = 0
      const read = fake([{ body: sse(OVERLOAD) }])
      read.h.onRead = () => void (now += 3000)
      expect(errorOf(await events(read.s, w))).toContain('timed out after 3 s')
      expect(read.h.posts).toHaveLength(1)
      expect(read.h.cancelled).toBe(1)
    }
  } finally { clock.mockRestore() }
}))

test('compaction and guarded dispatch remain single-attempt for streamed overload', async () => {
  for (const guarded of [false, true]) {
    const { h, s } = fake([{ body: sse(OVERLOAD) }, { body: RESPONSE_OK }])
    const w = responsesWire(guarded ? {} : { compaction: { outputTokens: 100 } })
    const out: StepEvent[] = []
    let ready = 0
    if (guarded) w.dispatch = 'dispatch-id'
    for await (const e of s.step(w, new AbortController().signal, async () => { ready++; return true })) out.push(e)
    expect(errorOf(out)).toContain(OVERLOAD_MESSAGE)
    expect(h.posts).toHaveLength(1)
    expect(h.slept).toEqual([])
    expect(ready).toBe(guarded ? 1 : 0)
  }
})

test('the verified text-only overload is sent again whatever the provider is named, whether the error is text or a message object', async () => {
  for (const error of [OVERLOAD_MESSAGE, { message: OVERLOAD_MESSAGE }]) {
    const { h, s } = fake([{ body: sse({ type: 'response.failed', response: { error } }) }, { body: RESPONSE_OK }])
    expect(errorOf(await events(s, responsesWire()))).toBeUndefined()
    expect(h.posts).toHaveLength(2)
  }
})

for (const message of ['Request blocked by content_filter due to a policy violation', 'Request denied by a guardrail', 'Moderation rejected the request', 'Content-filter refused the request', 'Content filter refused the request']) test(`streamed permanent policy message is not retried: ${message}`, async () => {
  const body = sse({ type: 'response.failed', response: { error: { type: 'server_error', message } } })
  const { h, s } = fake([{ body }, { body: RESPONSE_OK }])
  expect(errorOf(await events(s, responsesWire()))).toContain(message)
  expect(h.posts).toHaveLength(1)
  expect(h.slept).toEqual([])
})
