// A local dispatch decision is checked after startup and after every asynchronous provider preparation.
import { expect, spyOn, test } from 'bun:test'
import { createBackend } from '../hooks/backend'
import { fingerprint, parseConfig } from '../hooks/config'
import { dispatchGate, type DispatchReady } from '../hooks/dispatch-gate'
import type { StepEvent, StepWire } from '../hooks/protocol'
import { fakeDaemon } from '../tests/daemon-fake'
import { createStepper } from './step'
import type { Env } from './step'

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const configText = JSON.stringify({ providers: { p: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: { command: ['/credential'] }, sessionHeader: 'session_id', models: { m: { contextWindow: 200_000, maxOutputTokens: 32_000 } } } } })
const approved = [fingerprint(parseConfig(configText).config!.providers['p']!)]
const req = { target: 'p/m', system: 'summary', tools: [], transcript: [{ role: 'user' as const, content: 'data' }], who: 'compact:main', sessionId: 'session-fixture', compaction: { outputTokens: 8000 }, timeoutMs: 20_000 }
const sleep: Env['sleep'] = (_ms, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
const stream = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'summary' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'

for (const phase of ['credential', 'last fingerprint'] as const) for (const invalidation of ['disabled', 'cancelled', 'exception'] as const) test(`${phase} await cannot dispatch after ${invalidation}`, async () => {
  const reached = deferred<void>(), release = deferred<void>(), ac = new AbortController()
  let valid = true
  const daemon = fakeDaemon({ bun: '/fixture/bun', upstream: () => ({ pieces: [stream] }), helper: async () => { if (phase === 'credential') { reached.resolve(); await release.promise }; return { exitCode: 0, stdout: 'dummy-key' } }, log: () => {}, now: 0 })
  const backend = createBackend()({ root: '/fixture', debug: () => {}, run: async (argv, init) => ({ ...(daemon.run(argv, init.stdin) ?? { exitCode: 0, stdout: '/fixture/bun', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false }), spawn: r => daemon.spawn(r.argv, r.input)!, sleep })
  await backend.configure({ configText, approved })
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  const hash = phase === 'last fingerprint' ? spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (new TextDecoder().decode(data).endsWith('\0"session-fixture"')) { reached.resolve(); await release.promise }
    return digest(algorithm, data)
  }) : undefined
  const events: StepEvent[] = []
  const done = (async () => { for await (const ev of backend.step(req, ac.signal, { dispatchGuard: async () => { if (!valid && invalidation === 'exception') throw new Error('decision read failed'); return valid } })) events.push(ev) })()
  try {
    await reached.promise
    if (invalidation === 'cancelled') ac.abort()
    else valid = false
    release.resolve(); await done
    expect(daemon.requests).toHaveLength(0)
    expect(events.some(ev => 'dispatchReady' in ev)).toBe(false)
    if (invalidation !== 'cancelled') expect(events.some(ev => ev.type === 'error')).toBe(true)
  } finally { hash?.mockRestore(); release.resolve() }
})

function gateFixture() {
  let posts = 0
  const timers: (() => void)[] = []
  const env: Env = { version: '0.2.0', post: async () => { posts++; return { cut: { kind: 'reset', detail: 'fixture' } } }, run: async () => ({ exitCode: 0, stdout: 'dummy-key' }), now: () => 0, sleep, log: () => {} }
  const gate = dispatchGate(createStepper(env), (_ms, signal) => new Promise<void>(resolve => { timers.push(resolve); signal.addEventListener('abort', resolve, { once: true }) }))
  const wire = (): StepWire => ({ token: 'local-token', configText, approved, req, dispatch: crypto.randomUUID() })
  return { gate, wire, timers, posts: () => posts }
}

for (const decision of ['reject', 'timeout', 'cancel', 'approve'] as const) test(`one-shot dispatch ${decision} releases its entry and rejects replay`, async () => {
  const f = gateFixture(), w = f.wire(), ac = new AbortController()
  expect(f.gate.ack({ dispatch: w.dispatch, accepted: true }).status).toBe(409)
  const source = f.gate.step(w, ac.signal)
  const ready = await source.next()
  const id = (ready.value as DispatchReady).dispatchReady
  expect((ready.value as DispatchReady).request).toBe(w.dispatch!)
  expect(f.posts()).toBe(0)
  expect(f.gate.ack({ dispatch: crypto.randomUUID(), accepted: true }).status).toBe(409)
  expect(f.gate.ack({ dispatch: id, accepted: 'true' }).status).toBe(409)
  if (decision === 'timeout') f.timers[0]!()
  else if (decision === 'cancel') ac.abort()
  else expect(f.gate.ack({ dispatch: id, accepted: decision === 'approve' }).status).toBe(200)
  while (!(await source.next()).done) {}
  expect(f.posts()).toBe(decision === 'approve' ? 1 : 0)
  expect(f.gate.ack({ dispatch: id, accepted: true }).status).toBe(409)
})

test('dispatch authorization arriving before preparation completes cannot post', async () => {
  const reached = deferred<void>(), release = deferred<void>(); let posts = 0
  const gate = dispatchGate(createStepper({ version: '0.2.0', post: async () => { posts++; return { cut: { kind: 'reset', detail: 'fixture' } } }, run: async () => { reached.resolve(); await release.promise; return { exitCode: 0, stdout: 'dummy-key' } }, now: () => 0, sleep, log: () => {} }), sleep)
  const w = { token: 'local-token', configText, approved, req, dispatch: crypto.randomUUID() }, ac = new AbortController()
  const source = gate.step(w, ac.signal), next = source.next()
  await reached.promise
  expect(gate.ack({ dispatch: w.dispatch, accepted: true }).status).toBe(409)
  ac.abort(); release.resolve(); await next
  while (!(await source.next()).done) {}
  expect(posts).toBe(0)
  expect(gate.ack({ dispatch: w.dispatch, accepted: true }).status).toBe(409)
})

for (const failure of ['transport', 'malformed'] as const) test(`failed ${failure} acknowledgment cannot dispatch and leaves no retry`, async () => {
  const daemon = fakeDaemon({ bun: '/fixture/bun', upstream: () => ({ pieces: [stream] }), helper: () => ({ exitCode: 0, stdout: 'dummy-key' }), log: () => {}, now: 0 })
  let acknowledgments = 0
  const backend = createBackend()({ root: '/fixture', debug: () => {}, run: async (argv, init) => {
    if (argv.at(-1)?.endsWith('/dispatch')) { acknowledgments++; if (failure === 'transport') throw new Error('socket unavailable'); return { exitCode: 0, stdout: 'invalid response', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { ...(daemon.run(argv, init.stdin) ?? { exitCode: 0, stdout: '/fixture/bun', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false }
  }, spawn: r => daemon.spawn(r.argv, r.input)!, sleep })
  await backend.configure({ configText, approved })
  const events: StepEvent[] = []
  for await (const ev of backend.step(req, new AbortController().signal, { dispatchGuard: async () => true })) events.push(ev)
  expect(acknowledgments).toBe(1)
  expect(daemon.requests).toHaveLength(0)
  expect(events.some(ev => ev.type === 'error')).toBe(true)
})

test('successful guarded backend dispatch hides control frames and never serializes its callback', async () => {
  const daemon = fakeDaemon({ bun: '/fixture/bun', upstream: () => ({ pieces: [stream] }), helper: () => ({ exitCode: 0, stdout: 'dummy-key' }), log: () => {}, now: 0 })
  const backend = createBackend()({ root: '/fixture', debug: () => {}, run: async (argv, init) => ({ ...(daemon.run(argv, init.stdin) ?? { exitCode: 0, stdout: '/fixture/bun', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false }), spawn: r => daemon.spawn(r.argv, r.input)!, sleep })
  await backend.configure({ configText, approved })
  let checks = 0
  const events: StepEvent[] = []
  for await (const ev of backend.step(req, new AbortController().signal, { dispatchGuard: async () => { checks++; return true } })) events.push(ev)
  expect(checks).toBe(2)
  expect(daemon.requests).toHaveLength(1)
  expect(events.some(ev => ev.type === 'text')).toBe(true)
  expect(events.some(ev => 'dispatchReady' in ev)).toBe(false)
  expect(JSON.stringify(daemon.wires)).not.toContain('dispatchGuard')
  expect(daemon.wires.length).toBe(2)
})

test('duplicate active dispatch ids cannot replace the owner, while cancelled cleanup preserves a successor', async () => {
  const f = gateFixture(), w = f.wire(), ac = new AbortController()
  const old = f.gate.step(w, ac.signal)
  const oldId = ((await old.next()).value as DispatchReady).dispatchReady
  const duplicate = f.gate.step(w, new AbortController().signal)
  await expect(duplicate.next()).rejects.toThrow('duplicate dispatch id')
  ac.abort()
  const successor = f.gate.step(w, new AbortController().signal)
  const newId = ((await successor.next()).value as DispatchReady).dispatchReady
  expect(newId).not.toBe(oldId)
  expect(f.gate.ack({ dispatch: oldId, accepted: true }).status).toBe(409)
  while (!(await old.next()).done) {}
  expect(f.gate.ack({ dispatch: newId, accepted: true }).status).toBe(200)
  while (!(await successor.next()).done) {}
  expect(f.posts()).toBe(1)
})

test('dispatch acknowledgment after the request deadline fails closed even before its timer runs', async () => {
  let now = 0
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const f = gateFixture(), w = f.wire(), source = f.gate.step(w, new AbortController().signal)
    const id = ((await source.next()).value as DispatchReady).dispatchReady
    now = req.timeoutMs + 1
    expect(f.gate.ack({ dispatch: id, accepted: true }).status).toBe(200)
    while (!(await source.next()).done) {}
    expect(f.posts()).toBe(0)
    expect(f.gate.ack({ dispatch: id, accepted: true }).status).toBe(409)
  } finally { clock.mockRestore() }
})

test('provider deadline elapsed while dispatch awaits acknowledgment prevents post', async () => {
  let now = 0, posts = 0
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const object = JSON.parse(configText); object.providers.p.timeoutMs = 1000
    const text = JSON.stringify(object), trust = [fingerprint(parseConfig(text).config!.providers['p']!)]
    const stepper = createStepper({ version: '0.2.0', post: async () => { posts++; return { cut: { kind: 'reset', detail: 'fixture' } } }, run: async () => ({ exitCode: 0, stdout: 'dummy-key' }), now: () => 0, sleep, log: () => {} })
    for await (const _ of stepper.step({ token: 'local-token', configText: text, approved: trust, req, dispatch: crypto.randomUUID() }, new AbortController().signal, async () => { now = 1001; return true })) {}
    expect(posts).toBe(0)
  } finally { clock.mockRestore() }
})

test('bounded dispatch entries release after rejection and admit a new request', async () => {
  const f = gateFixture(), active = []
  for (let i = 0; i < 16; i++) {
    const source = f.gate.step(f.wire(), new AbortController().signal)
    const id = ((await source.next()).value as DispatchReady).dispatchReady
    active.push({ source, id })
  }
  await expect(f.gate.step(f.wire(), new AbortController().signal).next()).rejects.toThrow('dispatch id')
  for (const entry of active) { f.gate.ack({ dispatch: entry.id, accepted: false }); while (!(await entry.source.next()).done) {} }
  const next = f.gate.step(f.wire(), new AbortController().signal)
  const id = ((await next.next()).value as DispatchReady).dispatchReady
  expect(f.gate.ack({ dispatch: id, accepted: true }).status).toBe(200)
  while (!(await next.next()).done) {}
  expect(f.posts()).toBe(1)
})
