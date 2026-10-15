// The klythd client: klythd started at session start with the bun found (reading no bunfig.toml or .env), quietly, and again on use when it is
// gone, every time in the session's own dispatch so that no step's abort takes it down; its ready handshake,
// a step streamed over curl on its socket, the token carried on curl's stdin alone, a cancelled step
// cancelling the provider request and leaving klythd and every other step alone, a step sent once more when
// klythd dies before it yielded anything (unless it crashed or the step asked to be sent `once`), a reply
// that is no event stream leaving a live klythd alone, event lines split across spawn pieces, and the key
// never reaching an argv, an environment or a log.
import type { ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { createBackend, NO_BUN } from '../hooks/backend'
import type { Host } from '../hooks/backend'
import type { StepEvent, StepRequest, StepWire } from '../hooks/protocol'
import { BUN, CONFIG, HELPER, KEY, model, start, step, klyth, world } from './world'

const PIN = { turnId: 'm', target: 'acme/model-b' }
const KLYTHD = /^\/.+\/klythd\/main\.ts$/
const daemonSpawns = (w: ReturnType<typeof world>) => w.processes.filter(p => p.argv[0] === BUN)
const curlSpawns = (w: ReturnType<typeof world>) => w.processes.filter(p => p.argv.includes('--unix-socket'))

test('klythd starts at session start, quietly, when the config declares a provider, and one klythd serves every routed step', async ($, on) => {
  const w = world(on, { pin: PIN })
  await start($)
  expect(w.daemons).toBe(1)
  expect([w.toasts, w.transcript]).toEqual([[], []])
  await step($, { turnId: 'm', index: 0 })
  await step($, { turnId: 'm', index: 1 })
  expect(w.daemons).toBe(1)
  expect(daemonSpawns(w)).toHaveLength(1)
  // In the session's directory, with bunfig and .env loading disabled and inherited Bun startup options cleared.
  expect(daemonSpawns(w)[0]).toEqual({ argv: [BUN, '--config=/dev/null', '--no-env-file', expect.stringMatching(KLYTHD)], env: { BUN_OPTIONS: '' } })
  expect(w.requests).toHaveLength(2)
  expect(w.runs.filter(r => r[0] === '/bin/sh' && r[2]?.startsWith('command -v bun'))).toHaveLength(1)
})

for (const [name, config] of [
  ['it declares no provider', JSON.stringify({ providers: {}, aliases: {} })],
  ['it has errors', '{ broken'],
  ['there is none', null],
] as const) {
  test(`no klythd starts at session start when ${name}`, async ($, on) => {
    const w = world(on, { config })
    await start($)
    expect(w.daemons).toBe(0)
  })
}

test("a step goes to klythd as curl's stdin over its socket: the token in the body only, nothing in the environment", async ($, on) => {
  const w = world(on, { pin: PIN })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  const c = curlSpawns(w)[0]
  expect(c?.argv).toEqual(['/usr/bin/curl', '-q', '-sS', '-N', '--unix-socket', '/tmp/klythd-1/d.sock', '--data-binary', '@-', 'http://klythd/step'])
  expect(c?.env).toBeUndefined()
  expect(JSON.parse(c?.input ?? '{}')).toMatchObject({ token: 'token-1', approved: [expect.stringContaining('openai|https://klyth.invalid|cmd:')], req: { target: 'acme/model-b', who: 'main' } })
  for (const p of w.processes) expect(JSON.stringify([p.argv, p.env ?? {}])).not.toContain('token-1')
  expect(JSON.stringify([w.debug, w.transcript, w.toasts])).not.toContain('token-1')
})

test('the key reaches the provider request alone: never an argv, an environment, a curl body, a log line or a toast', async ($, on) => {
  const w = world(on, { pin: PIN, routes: { sub1: { target: 'acme/model-a', label: 'fast' } } })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  await step($, { turnId: 's', index: 0, agentId: 'sub1' })
  await klyth($)
  expect(w.requests.map(r => r.headers['authorization'])).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`])
  expect(w.runs.filter(r => r[0] === HELPER[0])).toEqual([HELPER])
  expect(JSON.stringify([w.processes, w.wires, w.runs, w.debug, w.toasts, w.transcript])).not.toContain(KEY)
})

test('a cancelled step closes curl, and klythd cancels the provider request', async ($, on) => {
  const w = world(on, { pin: PIN, upstream: () => ({ pieces: ['data: {"choices":[{"index":0,"delta":{"content":"thinking about it"}}]}\n\n'], hold: true }) })
  await start($)
  const stream = $.turn.step({ turnId: 'm', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  expect((await stream.next()).value).toEqual({ kind: 'text', index: 0, text: 'thinking about it' })
  expect(w.aborted).toBe(0)
  await stream.return(undefined as never)
  for (let i = 0; i < 50 && w.aborted === 0; i++) await Promise.resolve()
  expect(w.aborted).toBe(1)
})

test('a klythd that crashed is started again at the next step, silently', async ($, on) => {
  const w = world(on, { pin: PIN })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  w.kill()
  const s = await step($, { turnId: 'm', index: 1 })
  expect(s.result.answer).toBe('London is 31°C with light rain.')
  expect(w.daemons).toBe(2)
  expect(w.toasts).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth klythd '))).toEqual(['klyth klythd ready at /tmp/klythd-1/d.sock', 'klyth klythd exited (code 1, signal -)', 'klyth klythd ready at /tmp/klythd-2/d.sock'])
})

test('a klythd whose socket is gone while it still seems to run is started again, and the step sent to the new one', async ($, on) => {
  const w = world(on, { pin: PIN })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  w.kill('socket')
  const s = await step($, { turnId: 'm', index: 1 })
  expect(s.result.answer).toBe('London is 31°C with light rain.')
  expect(w.daemons).toBe(2)
  expect(curlSpawns(w).map(c => c.argv[5])).toEqual(['/tmp/klythd-1/d.sock', '/tmp/klythd-1/d.sock', '/tmp/klythd-2/d.sock'])
  expect(w.requests).toHaveLength(2)
})

test('a klythd that never says ready fails the step after 3 s with one line, and the next step tries again', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { pin: PIN, clock: 'mocked', klythd: 'silent' })
  await start($)
  const pending = step($, { turnId: 'm', index: 0 })
  await clock.advance(2999)
  await clock.advance(1)
  expect((await pending).result.answer).toBe('klyth: klythd did not start (see the debug log); run /klyth reload, then retry')
  expect(w.debug).toContain('klyth klythd: no ready line within 3000 ms')
  const again = step($, { turnId: 'm', index: 1 })
  await clock.advance(3000)
  await again
  expect(w.daemons).toBe(2)
})

test('with no bun every routed step says so in one line and looks for bun again, so installing bun needs no reload', async ($, on) => {
  const w = world(on, { pin: PIN, bun: null })
  await start($)
  const lookups = () => w.runs.filter(r => r[2]?.startsWith('command -v bun')).length
  const before = lookups()
  expect((await step($, { turnId: 'm', index: 0 })).result.answer).toBe(NO_BUN)
  expect((await step($, { turnId: 'm', index: 1 })).result.answer).toBe(NO_BUN)
  expect(lookups()).toBe(before + 2)
  expect(w.daemons).toBe(0)
})

test('/klyth reads key states from the running klythd and starts none itself', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  await klyth($)
  expect(w.transcript).toContain('  acme      openai  https://klyth.invalid  cmd not yet run  yes')
  expect(w.daemons).toBe(1)
  await step($, { turnId: 'm', index: 0 })
  w.transcript.length = 0
  await klyth($)
  expect(w.transcript).toContain('  acme      openai  https://klyth.invalid  cmd cached  yes')
  expect(w.wires.at(-1)).toMatchObject({ token: 'token-1' })
  expect(w.wires.at(-1)).not.toHaveProperty('req')
})

test('/klyth starts no klythd and runs no helper when none runs', async ($, on) => {
  const w = world(on, { bun: null })
  await start($)
  await model($, 'strong')
  await klyth($)
  expect(w.transcript).toContain('  acme      openai  https://klyth.invalid  cmd not yet run  yes')
  expect([w.daemons, w.runs.filter(r => r[0] === HELPER[0])]).toEqual([0, []])
})

// A child as the engine streams it, driven by the test: `out` writes to its stdout, `end` ends it, and
// closing the stream (`return()`) kills it at once, even while a read waits.
class Pipe {
  private pieces: IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>[] = []
  private wake = () => {}
  private ended: ProcessSpawnResult | undefined
  private ends: (() => void)[] = []
  out(text: string, stream: 'stdout' | 'stderr' = 'stdout') {
    this.pieces.push({ done: false, value: { stream, text } })
    this.wake()
  }
  end(result: ProcessSpawnResult) {
    if (this.ended !== undefined) return
    this.ended = result
    this.wake()
    for (const f of this.ends) f()
  }
  get dead() {
    return this.ended !== undefined
  }
  onEnd(f: () => void) {
    this.ends.push(f)
  }
  stream(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    const gen: AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> = {
      next: async () => {
        for (;;) {
          const piece = this.pieces.shift()
          if (piece !== undefined) return piece
          if (this.ended !== undefined) return { done: true, value: this.ended }
          await new Promise<void>(resolve => (this.wake = resolve))
        }
      },
      return: async () => (this.end({ code: null, signal: 'SIGTERM' }), { done: true, value: this.ended as ProcessSpawnResult }),
      throw: async e => Promise.reject(e),
      [Symbol.asyncIterator]: () => gen,
    }
    return gen
  }
}

// The engine around klythd: each `host(signal)` is one hook dispatch, whose spawns end when `signal` aborts
// (index.d.ts:3492-3494). The real engine ties a child to the dispatch whose async context spawns it, whichever
// `$` made the call (measured on 2.1.292), which this fake cannot see: it ties a spawn to the host it is made
// through, so it tells a klythd spawned through a step's host from one spawned through the session's. A klythd
// answers ready at once; a curl call to it ends with curl's exit 52 (empty reply) when klythd ends, and with 7
// when it already has.
function fakeEngine() {
  const klythds: Pipe[] = []
  const curls: { pipe: Pipe; wire: StepWire }[] = []
  const log: string[] = [] // the debug lines of every host
  const host = (signal: AbortSignal): Host => ({
    run: async () => ({ exitCode: 0, stdout: `${BUN}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
    spawn: req => {
      const pipe = new Pipe()
      if (req.argv[0] === BUN) pipe.out(`ready /tmp/s${klythds.push(pipe)}/d.sock t${klythds.length}\n`)
      else {
        const daemon = klythds[Number(/\/s(\d+)\//.exec(req.argv[req.argv.indexOf('--unix-socket') + 1] ?? '')?.[1]) - 1]
        curls.push({ pipe, wire: JSON.parse(req.input ?? '{}') as StepWire })
        if (daemon?.dead !== false) pipe.end({ code: 7, signal: null })
        else daemon.onEnd(() => pipe.end({ code: 52, signal: null }))
      }
      signal.addEventListener('abort', () => pipe.end({ code: null, signal: 'SIGTERM' }), { once: true })
      return pipe.stream()
    },
    sleep: () => new Promise(() => {}),
    debug: text => void log.push(text),
    root: '/klyth',
  })
  // Ends every process, as the session ending does, so the next test starts from no klythd.
  const stop = () => [...klythds, ...curls.map(c => c.pipe)].forEach(p => p.end({ code: 0, signal: null }))
  return { klythds, curls, log, host, stop }
}

const REQ: StepRequest = { target: 'acme/m', system: '', tools: [], transcript: [], who: 'main' }
const wireOf = (e: StepEvent) => `${JSON.stringify(e)}\n`
const TEXT = (text: string): StepEvent => ({ type: 'text', text })
const STOP: StepEvent = { type: 'stop', reason: 'end_turn' }
const STATS: StepEvent = { type: 'stats', ttfbMs: 1, totalMs: 2, reqBytes: 3, in: 4, out: 5, finish: 'stop' }
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 1000 && !until(); i++) await Promise.resolve()
  expect(until()).toBe(true)
}
async function all(events: AsyncIterable<StepEvent>) {
  const out: StepEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

test('a step aborted with Esc leaves klythd, started at session start, and every other step running', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    await backend(eng.host(new AbortController().signal)).configure({ configText: CONFIG, approved: [] })
    await backend(eng.host(new AbortController().signal)).start()
    const [esc, other] = [new AbortController(), new AbortController()]
    const stepEsc = backend(eng.host(esc.signal)).step(REQ, esc.signal)[Symbol.asyncIterator]()
    const stepOther = backend(eng.host(other.signal)).step(REQ, other.signal)[Symbol.asyncIterator]()
    const [firstEsc, firstOther] = [stepEsc.next(), stepOther.next()]
    await settle(() => eng.curls.length === 2)
    for (const c of eng.curls) c.pipe.out(wireOf(TEXT('a')))
    expect([(await firstEsc).value, (await firstOther).value]).toEqual([TEXT('a'), TEXT('a')])
    esc.abort()
    const rest = all({ [Symbol.asyncIterator]: () => stepOther })
    for (const ev of [TEXT('b'), STOP, STATS]) eng.curls[1]?.pipe.out(wireOf(ev))
    eng.curls[1]?.pipe.end({ code: 0, signal: null })
    expect(await rest).toEqual([TEXT('b'), STOP, STATS])
    expect(eng.klythds.map(s => s.dead)).toEqual([false])
  } finally {
    eng.stop()
  }
})

test('a step whose signal aborts while it waits on klythd kills curl at once, and leaves klythd up', async () => {
  const eng = fakeEngine()
  try {
    const ac = new AbortController()
    const pending = createBackend()(eng.host(new AbortController().signal)).step(REQ, ac.signal)[Symbol.asyncIterator]().next()
    await settle(() => eng.curls.length === 1)
    ac.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect([eng.curls[0]?.pipe.dead, eng.klythds[0]?.dead]).toEqual([true, false])
  } finally {
    eng.stop()
  }
})

test('a step is sent once more, unseen, when klythd exits without a crash before it yielded anything', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    const events = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
    await settle(() => eng.curls.length === 1)
    eng.klythds[0]?.end({ code: 0, signal: null })
    await settle(() => eng.curls.length === 2)
    expect(eng.klythds).toHaveLength(2)
    for (const ev of [TEXT('hi'), STOP, STATS]) eng.curls[1]?.pipe.out(wireOf(ev))
    eng.curls[1]?.pipe.end({ code: 0, signal: null })
    expect(await events).toEqual([TEXT('hi'), STOP, STATS])
    expect(eng.curls.map(c => c.wire.token)).toEqual(['t1', 't2'])
    expect(eng.curls[1]?.wire.req).toEqual(REQ)
  } finally {
    eng.stop()
  }
})

test('a step sent `once` is not sent again when klythd exits without a crash before it yielded anything: it ends with one line', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    let got: StepEvent[] | undefined
    void all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal, { once: true })).then(evs => (got = evs))
    await settle(() => eng.curls.length === 1)
    eng.klythds[0]?.end({ code: 0, signal: null })
    await settle(() => got !== undefined || eng.curls.length === 2)
    expect(got?.[0]).toEqual({ type: 'error', kind: 'request', text: 'klyth: klythd did not answer (curl exit 52); run /klyth reload, then retry' })
    expect([eng.curls.length, eng.klythds.length]).toEqual([1, 1])
  } finally {
    eng.stop()
  }
})

test('a step that already yielded an event is not sent again when klythd dies: it ends with one line', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    const events = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
    await settle(() => eng.curls.length === 1)
    eng.curls[0]?.pipe.out(wireOf(TEXT('par')))
    await settle(() => eng.curls[0]?.pipe.dead === false)
    eng.klythds[0]?.end({ code: 1, signal: null })
    const got = await events
    expect(got.map(e => e.type)).toEqual(['text', 'error', 'stats'])
    expect(got[1]).toEqual({ type: 'error', kind: 'request', text: 'klyth: klythd stopped during the step; retry' })
    expect([eng.curls.length, eng.klythds.length]).toEqual([1, 1])
  } finally {
    eng.stop()
  }
})

test('a step whose second send also fails ends with one line naming curl, after exactly two sends', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    const events = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
    await settle(() => eng.curls.length === 1)
    eng.klythds[0]?.end({ code: 0, signal: null })
    await settle(() => eng.curls.length === 2)
    eng.klythds[1]?.end({ code: 0, signal: null })
    const got = await events
    expect(got[0]).toEqual({ type: 'error', kind: 'request', text: 'klyth: klythd did not answer (curl exit 52); run /klyth reload, then retry' })
    expect([eng.curls.length, eng.klythds.length]).toEqual([2, 2])
  } finally {
    eng.stop()
  }
})

test('a step klythd crashed under is not sent again: one line and one crash credit, and the next step starts klythd', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    const events = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
    await settle(() => eng.curls.length === 1)
    eng.klythds[0]?.end({ code: 1, signal: null })
    const got = await events
    expect(got[0]).toEqual({ type: 'error', kind: 'request', text: 'klyth: klythd stopped during the step; retry' })
    expect([eng.curls.length, eng.klythds.length]).toEqual([1, 1])
    const next = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
    await settle(() => eng.curls.length === 2)
    expect(eng.klythds).toHaveLength(2)
    for (const ev of [TEXT('ok'), STOP, STATS]) eng.curls[1]?.pipe.out(wireOf(ev))
    eng.curls[1]?.pipe.end({ code: 0, signal: null })
    expect(await next).toEqual([TEXT('ok'), STOP, STATS])
  } finally {
    eng.stop()
  }
})

// What curl prints and how it exits when klythd answers with a plain-text 4xx (`-sS` without `-f`: exit 0), and
// when its answer is cut by a reset (56).
for (const [name, reply, code, text] of [
  ['a plain-text reply with curl exit 0', 'klythd: no such call\n', 0, 'klyth: klythd sent a reply klyth could not read (see the debug log); run /klyth reload, then retry'],
  ['a reset reply with curl exit 56', '', 56, 'klyth: klythd did not answer (curl exit 56); run /klyth reload, then retry'],
] as const) {
  test(`${name} leaves a live klythd running and the step unsent a second time`, async () => {
    const eng = fakeEngine()
    const backend = createBackend()
    try {
      const events = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
      await settle(() => eng.curls.length === 1)
      if (reply !== '') eng.curls[0]?.pipe.out(reply)
      eng.curls[0]?.pipe.end({ code, signal: null })
      const got = await events
      expect(got[0]).toEqual({ type: 'error', kind: 'request', text })
      expect([eng.curls.length, eng.klythds.length, eng.klythds[0]?.dead]).toEqual([1, 1, false])
      const next = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
      await settle(() => eng.curls.length === 2)
      for (const ev of [TEXT('ok'), STOP, STATS]) eng.curls[1]?.pipe.out(wireOf(ev))
      eng.curls[1]?.pipe.end({ code: 0, signal: null })
      expect(await next).toEqual([TEXT('ok'), STOP, STATS])
      expect(eng.curls.map(c => c.wire.token)).toEqual(['t1', 't1'])
    } finally {
      eng.stop()
    }
  })
}

type Setup = { eng: ReturnType<typeof fakeEngine>; backend: ReturnType<typeof createBackend>; session: AbortSignal }

// Two steps are sent at once after `ahead` has run (klythd gone, say); the first starts klythd, and is aborted
// while both wait on their answers. The other must still be answered, by the klythd the first started.
async function aliveAfterStarterAborted(ahead: (t: Setup) => Promise<void>) {
  const eng = fakeEngine()
  const backend = createBackend()
  const session = new AbortController()
  try {
    await ahead({ eng, backend, session: session.signal })
    const [esc, other] = [new AbortController(), new AbortController()]
    const known = eng.klythds.length
    const turn = (c: AbortController) => backend(eng.host(c.signal)).step(REQ, c.signal)[Symbol.asyncIterator]()
    const [stepEsc, stepOther] = [turn(esc), turn(other)]
    const [firstEsc, firstOther] = [stepEsc.next(), stepOther.next()]
    await settle(() => eng.curls.length === 2)
    for (const c of eng.curls) c.pipe.out(wireOf(TEXT('a')))
    expect([(await firstEsc).value, (await firstOther).value]).toEqual([TEXT('a'), TEXT('a')])
    expect(eng.klythds).toHaveLength(known + 1)
    esc.abort()
    const rest = all({ [Symbol.asyncIterator]: () => stepOther })
    for (const ev of [TEXT('b'), STOP, STATS]) eng.curls[1]?.pipe.out(wireOf(ev))
    eng.curls[1]?.pipe.end({ code: 0, signal: null })
    expect(await rest).toEqual([TEXT('b'), STOP, STATS])
    expect(eng.klythds.slice(known).map(s => s.dead)).toEqual([false])
  } finally {
    session.abort()
    eng.stop()
  }
}

for (const [name, exit] of [
  ['an idle exit', { code: 0, signal: null }],
  ['a crash', { code: 1, signal: null }],
] as const) {
  test(`after ${name} of klythd, aborting the step that starts it again ends no other step`, async () => {
    await aliveAfterStarterAborted(async ({ eng, backend, session }) => {
      const b = backend(eng.host(session))
      await b.configure({ configText: CONFIG, approved: [] })
      await b.start()
      expect(eng.klythds).toHaveLength(1)
      eng.klythds[0]?.end(exit)
      await settle(() => eng.log.some(l => l.startsWith('klyth klythd exited')))
    })
  })
}

test('with no provider at session start, a reload that declares one and a first step that is then aborted leave klythd to the other step', async () => {
  await aliveAfterStarterAborted(async ({ eng, backend, session }) => {
    const b = backend(eng.host(session))
    await b.start()
    expect(eng.klythds).toHaveLength(0)
    await b.configure({ configText: CONFIG, approved: [] })
  })
})

test('event lines split across spawn pieces are read whole, and a last line with no newline waits for its end', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    const events = all(backend(eng.host(new AbortController().signal)).step(REQ, new AbortController().signal))
    await settle(() => eng.curls.length === 1)
    const line = wireOf(TEXT('héllo wörld'))
    const cut = [3, 17, 18, line.length]
    let at = 0
    for (const to of cut) {
      eng.curls[0]?.pipe.out(line.slice(at, to))
      at = to
    }
    eng.curls[0]?.pipe.out(wireOf(STOP).slice(0, 5))
    eng.curls[0]?.pipe.out(wireOf(STOP).slice(5) + wireOf(STATS).slice(0, 9))
    eng.curls[0]?.pipe.out(wireOf(STATS).slice(9))
    eng.curls[0]?.pipe.end({ code: 0, signal: null })
    expect(await events).toEqual([TEXT('héllo wörld'), STOP, STATS])
  } finally {
    eng.stop()
  }
})

test('starting klythd at session start never throws: a spawn that cannot be made is a debug line', async () => {
  const eng = fakeEngine()
  const lines: string[] = []
  const host: Host = {
    ...eng.host(new AbortController().signal),
    spawn: () => {
      throw new Error('spawn refused')
    },
    debug: text => void lines.push(text),
  }
  const backend = createBackend()(host)
  await backend.configure({ configText: CONFIG, approved: [] })
  await backend.start()
  expect(lines).toEqual(['klyth klythd: Error: spawn refused'])
})

test('bounded diagnostic stderr split into chunks and a separate newline preserves the whole prefix', async () => {
  const eng = fakeEngine()
  const backend = createBackend()
  try {
    await backend(eng.host(new AbortController().signal)).configure({ configText: CONFIG, approved: [] })
    await backend(eng.host(new AbortController().signal)).start()
    await settle(() => eng.klythds.length === 1)
    const line = 'klyth step main → acme/m load=0123456789abcdef session=abcdef0123456789 system=0123456789abcdef ' + 'x'.repeat(6800)
    const pipe = eng.klythds[0]!
    for (let i = 0; i < line.length; i += 1000) pipe.out(line.slice(i, i + 1000), 'stderr')
    pipe.out('\n', 'stderr')
    await settle(() => eng.log.includes(line))
    expect(eng.log.filter(l => l.startsWith('klyth step'))).toEqual([line])
  } finally { eng.stop() }
})
