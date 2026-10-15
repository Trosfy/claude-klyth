// The real step feeding the real transport: the whole-request bound the step sends is the one the transport arms.
import { expect, spyOn, test } from 'bun:test'
import { createStepper, type UpstreamRequest } from './step'
import { post } from './upstream'
import { fingerprint, parseConfig } from '../hooks/config'
import type { StepWire } from '../hooks/protocol'

// Fake timers, connect, clock and fetch. Each streamed chunk moves the clock 500 s, so five chunks pass the old 1,800 s cap.
async function ports(run: (fire: (ms: number) => void, delays: number[]) => Promise<void>, hangingConnect = false) {
  let id = 0, now = 0
  const timers = new Map<number, { ms: number; run: () => void }>(), delays: number[] = []
  const st = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms: number) => (delays.push(ms), timers.set(++id, { ms, run }), id)) as unknown as typeof setTimeout)
  const ct = spyOn(globalThis, 'clearTimeout').mockImplementation(h => { timers.delete(Number(h)) })
  const connect = spyOn(Bun, 'connect').mockImplementation((() => (hangingConnect ? new Promise(() => {}) : Promise.resolve({}))) as unknown as typeof Bun.connect)
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    let count = 0
    return new Response(new ReadableStream({
      start(c) { init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }) },
      pull(c) {
        now += 500_000
        if (count++ === 5) return c.close()
        const finish = count === 5 ? { finish_reason: 'stop' } : {}
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'tick' }, ...finish }] })}\n\n`))
      },
    }))
  }) as typeof fetch)
  const fire = (ms: number) => {
    const found = [...timers].find(([, t]) => t.ms === ms)
    expect(found).toBeDefined()
    timers.delete(found![0])
    found![1].run()
  }
  try { await run(fire, delays) } finally { fetcher.mockRestore(); clock.mockRestore(); connect.mockRestore(); ct.mockRestore(); st.mockRestore() }
}

function wire(providerMs?: number, requestMs?: number): StepWire {
  const configText = JSON.stringify({ providers: { p: { kind: 'openai', baseUrl: 'https://offline.invalid', auth: 'none', ...(providerMs ? { timeoutMs: providerMs } : {}), models: { m: { contextWindow: 10000, maxOutputTokens: 1000 } } } } })
  const p = parseConfig(configText).config!.providers.p!
  return { token: 't', configText, approved: [fingerprint(p)], req: { target: 'p/m', system: '', tools: [], transcript: [{ role: 'user', content: 'hi' }], who: 'main', ...(requestMs ? { timeoutMs: requestMs } : {}) } }
}

test('with no timeoutMs the stream runs past 1,800 s; a provider or request bound reaches the transport, the smaller one winning', async () => {
  for (const [providerMs, requestMs, total] of [[undefined, undefined, undefined], [5000, undefined, 5], [900000, 20000, 20]] as const) {
    await ports(async (_fire, delays) => {
      const sent: UpstreamRequest[] = []
      const s = createStepper({ version: '0.2.0', post: (r, signal) => (sent.push(r), post(r, signal)), run: async () => ({ exitCode: 0, stdout: '' }), sleep: async () => {}, now: () => 0, log: () => {} })
      const events = []
      for await (const ev of s.step(wire(providerMs, requestMs), new AbortController().signal)) events.push(ev)
      expect(sent).toHaveLength(1)
      if (total === undefined) {
        expect(sent[0]).not.toHaveProperty('totalS')
        expect(events.filter(e => e.type === 'text')).toHaveLength(5)
        expect(events.some(e => e.type === 'error')).toBe(false)
        expect(events.some(e => e.type === 'stop')).toBe(true)
        expect(delays.every(ms => ms === 15000 || ms === 600000)).toBe(true) // connect and stall timers only
      } else {
        expect(sent[0]!.totalS).toBe(total)
        expect(delays).toContain(total * 1000)
        expect(events.some(e => e.type === 'error' && e.text.includes(`timed out after ${total} s`))).toBe(true)
      }
    })
  }
})

test('with no whole-request bound a connect that never answers is still cut at 15 s', () => ports(async (fire, delays) => {
  const pending = post({ url: 'https://offline.invalid', allowHttp: false, headers: {}, body: '{}', stallS: 600 }, new AbortController().signal)
  expect(delays).toEqual([15000])
  fire(15000)
  expect(await pending).toEqual({ cut: { kind: 'connect-timeout', detail: '' } })
}, true))
