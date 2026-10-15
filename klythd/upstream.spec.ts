// The provider transport against a local server on 127.0.0.1: the User-Agent exactly as given (never Bun's
// own), https only unless allowed, no redirect followed, a stall window before the headers and between
// reads, a bound on the whole request, a refused connection, and a cancel that reaches the server.
import { afterAll, expect, test } from 'bun:test'

import type { UpstreamRequest } from './step'
import { post } from './upstream'

const seen: { path: string; ua: string | null; auth: string | null }[] = []
const gone: string[] = [] // paths whose client went away
const enc = new TextEncoder()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    seen.push({ path, ua: req.headers.get('user-agent'), auth: req.headers.get('authorization') })
    req.signal.addEventListener('abort', () => void gone.push(path))
    if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/ok' } })
    if (path === '/late') await Bun.sleep(2500)
    const hold = path === '/stall' || path === '/held'
    return new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode('data: first\n\n'))
          if (path === '/ok' || path === '/late') return c.close()
          for (let i = 0; !hold && i < 40; i++) {
            await Bun.sleep(150)
            c.enqueue(enc.encode(': tick\n'))
          }
          if (hold) await new Promise(() => {})
          c.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
afterAll(() => void server.stop(true))

const base = `http://127.0.0.1:${server.port}`
const UA = 'claude-code/2.1.292 (cli)'
const req = (path: string, o: Partial<UpstreamRequest> = {}): UpstreamRequest => ({
  url: `${base}${path}`,
  allowHttp: true,
  headers: { 'content-type': 'application/json', 'user-agent': UA, authorization: 'Bearer k' },
  body: '{}',
  stallS: 600,
  totalS: 1800,
  ...o,
})
async function read(path: string, o: Partial<UpstreamRequest> = {}, signal = new AbortController().signal) {
  const started = performance.now()
  const a = await post(req(path, o), signal)
  if ('cut' in a) return { cut: a.cut, text: '', ms: performance.now() - started }
  let text = ''
  for (;;) {
    const piece = await a.body.next()
    if (piece.done) return { status: a.status, cut: piece.value, text, ms: performance.now() - started }
    text += new TextDecoder().decode(piece.value)
  }
}

test('a request carries the User-Agent exactly as given, never Bun/, and reads the whole body', async () => {
  const r = await read('/ok')
  expect(r).toMatchObject({ status: 200, cut: undefined, text: 'data: first\n\n' })
  expect(seen.filter(s => s.path === '/ok').map(s => s.ua)).toEqual([UA])
  expect(seen.some(s => s.ua?.includes('Bun/'))).toBe(false)
})

test('plain http is refused unless the provider allows it, before any connection', async () => {
  const before = seen.length
  expect((await read('/ok', { allowHttp: false })).cut).toEqual({ kind: 'connect', detail: 'http: is refused: https only, unless the provider sets allowHttp' })
  expect(seen.length).toBe(before)
})

test('a redirect is reported, never followed', async () => {
  const before = seen.filter(s => s.path === '/ok').length
  expect((await read('/redirect')).cut).toEqual({ kind: 'redirect', detail: '302' })
  expect(seen.filter(s => s.path === '/ok').length).toBe(before)
})

test('silence past the stall window cuts the body, and silence before the headers too', async () => {
  const stalled = await read('/stall', { stallS: 1 })
  expect(stalled).toMatchObject({ status: 200, cut: { kind: 'stall', detail: '1' }, text: 'data: first\n\n' })
  expect(stalled.ms).toBeLessThan(2500)
  const late = await read('/late', { stallS: 1 })
  expect(late.cut).toEqual({ kind: 'stall', detail: '1' })
})

test('the whole-request bound cuts a response that keeps trickling', async () => {
  const r = await read('/trickle', { totalS: 1 })
  expect(r.cut).toEqual({ kind: 'total', detail: '1' })
  expect(r.ms).toBeLessThan(2500)
})

test('a refused connection is a connect cut naming the origin', async () => {
  expect((await read('/ok', { url: 'http://127.0.0.1:1/ok' })).cut).toEqual({ kind: 'connect', detail: '127.0.0.1:1 ECONNREFUSED' })
})

test('a cancel mid-body closes the connection, which the server sees', async () => {
  const ac = new AbortController()
  const a = await post(req('/held'), ac.signal)
  if ('cut' in a) throw new Error('no answer')
  expect(new TextDecoder().decode((await a.body.next()).value as Uint8Array)).toBe('data: first\n\n')
  ac.abort()
  expect(await a.body.next()).toEqual({ done: true, value: undefined })
  for (let i = 0; i < 50 && !gone.includes('/held'); i++) await Bun.sleep(20)
  expect(gone).toContain('/held')
})

test('a signal that is already aborted sends no request, and the answer says it was cut', async () => {
  const before = seen.length
  const ac = new AbortController()
  ac.abort()
  expect(await post(req('/held'), ac.signal)).toHaveProperty('cut')
  await Bun.sleep(100)
  expect(seen.length).toBe(before)
})

test('cancel ends an answer whose body was never read: the server sees the client go', async () => {
  const a = await post(req('/held'), new AbortController().signal)
  if ('cut' in a) throw new Error('no answer')
  a.cancel()
  for (let i = 0; i < 50 && gone.filter(p => p === '/held').length < 2; i++) await Bun.sleep(20)
  expect(gone.filter(p => p === '/held')).toHaveLength(2)
})
