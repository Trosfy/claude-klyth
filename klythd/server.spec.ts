// klythd end to end, as the mod runs it: `bun klythd/main.ts` answers `ready <socket> <token>` from a fresh
// 0700 directory; a call without the token is refused and sends nothing; a step goes in on curl's stdin and
// comes back one event per line, its provider request carrying the key and the Klyth
// User-Agent, or the one the provider configures; killing curl cancels the provider request; the in-flight
// cap answers an error; a 503 is sent again after the wait its retry-after names, and killing curl during that wait
// ends the step with no further request; status runs nothing; and klythd exits, removing its directory, on SIGTERM and
// when its parent goes away.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fingerprint, parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import type { StepEvent } from '../hooks/protocol'

const MAIN = join(import.meta.dir, 'main.ts')
const KEY = 'sk-klyth-e2e-0123456789abcdef'
const UA = 'klyth/0.2.0'
const seen: { path: string; ua: string | null; auth: string | null }[] = []
let cancelled = 0
let flaky = 0
const enc = new TextEncoder()
// The provider, on the IPv6 loopback that klyth.localhost resolves to.
const provider = Bun.serve({
  hostname: '::1',
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const body = (await req.json()) as { model: string }
    seen.push({ path: new URL(req.url).pathname, ua: req.headers.get('user-agent'), auth: req.headers.get('authorization') })
    req.signal.addEventListener('abort', () => void cancelled++)
    if (body.model === 'slow') await Bun.sleep(1500)
    if (body.model === 'flaky' && ++flaky === 1) return Response.json({ error: { message: 'edge' } }, { status: 503, headers: { 'retry-after': '0' } })
    if (body.model === 'down') return Response.json({ error: { message: 'edge' } }, { status: 503, headers: { 'retry-after': '6' } })
    const chunk = (delta: Record<string, unknown>, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`
    return new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(chunk({ content: 'hello' })))
          if (body.model === 'held') return void (await new Promise(() => {}))
          c.enqueue(enc.encode(chunk({ content: ' world' }, { finish_reason: 'stop' }) + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`))
          c.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
const CONFIG = JSON.stringify({
  providers: {
    loc: {
      kind: 'openai',
      baseUrl: `http://klyth.localhost:${provider.port}/v1`,
      allowHttp: true,
      auth: { command: ['/bin/echo', KEY] },
      models: { m: { contextWindow: 10_000, maxOutputTokens: 100 }, held: { contextWindow: 10_000, maxOutputTokens: 100 }, flaky: { contextWindow: 10_000, maxOutputTokens: 100 }, down: { contextWindow: 10_000, maxOutputTokens: 100 }, slow: { contextWindow: 10_000, maxOutputTokens: 100 } },
    },
  },
})
const APPROVED = [fingerprint((parseConfig(CONFIG).config as Config).providers['loc'] as ProviderConfig)]

type Klythd = { proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>; sock: string; token: string; dir: string; stderr: () => Promise<string>; closed: () => Promise<void> }
const running: Klythd[] = []
afterAll(() => {
  for (const d of running) d.proc.kill()
  void provider.stop(true)
})

// Starts klythd (through `/bin/sh -c` when `orphan`, which exits at once and leaves klythd to launchd) and
// reads its ready line.
async function startKlythd(orphan = false, executable?: { path: string; cwd: string }): Promise<Klythd> {
  const argv = executable ? [executable.path, '__daemon'] : orphan ? ['/bin/sh', '-c', `"${process.execPath}" "${MAIN}" &`] : [process.execPath, MAIN]
  const proc = Bun.spawn(argv, { ...(executable ? { cwd: executable.cwd } : {}), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const reader = proc.stdout.getReader()
  let out = ''
  while (!out.includes('\n')) {
    const r = await reader.read()
    if (r.done) throw new Error(`klythd ended before ready: ${out}`)
    out += new TextDecoder().decode(r.value)
  }
  const [word, sock, token] = out.trim().split(' ') as [string, string, string]
  expect(word).toBe('ready')
  // Resolves when klythd's stdout closes: when it has exited.
  const closed = async () => {
    while (!(await reader.read()).done);
  }
  const d = { proc, sock, token, dir: sock.slice(0, sock.lastIndexOf('/')), stderr: () => new Response(proc.stderr).text(), closed }
  running.push(d)
  return d
}

const curl = (d: Klythd, call: string, body: unknown) =>
  Bun.spawn(['/usr/bin/curl', '-q', '-sS', '-N', '-w', '\n%{http_code}', '--unix-socket', d.sock, '--data-binary', '@-', `http://klythd/${call}`], {
    stdin: enc.encode(JSON.stringify(body)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
async function call(d: Klythd, path: string, body: unknown): Promise<{ status: string; lines: string[] }> {
  const out = await new Response(curl(d, path, body).stdout).text()
  const lines = out.split('\n')
  return { status: lines.pop() ?? '', lines: lines.filter(l => l !== '') }
}
const stepBody = (d: Klythd, model = 'm') => ({
  token: d.token,
  configText: CONFIG,
  approved: APPROVED,
  req: { target: `loc/${model}`, system: 'SYS', tools: [], transcript: [{ role: 'user', content: 'hi' }], who: 'main' },
})

test('klythd answers ready from a fresh 0700 directory it owns, with a 0600 socket under 100 bytes of path', async () => {
  const d = await startKlythd()
  const dir = statSync(d.dir)
  expect([dir.mode & 0o777, dir.uid]).toEqual([0o700, process.getuid?.() ?? -1])
  expect(statSync(d.sock).mode & 0o777).toBe(0o600)
  expect(d.sock.length).toBeLessThanOrEqual(100)
  expect(d.token).toMatch(/^[0-9a-f]{64}$/)
})

test('a call without the token, or with another, is refused with 401 and sends nothing', async () => {
  const d = await startKlythd()
  const before = seen.length
  for (const token of [undefined, 'x'.repeat(64), d.token.slice(0, 63)]) {
    const r = await call(d, 'step', { ...stepBody(d), token })
    expect(r.status).toBe('401')
    expect(r.lines.map(l => (JSON.parse(l) as StepEvent).type)).toEqual(['error', 'stats'])
  }
  expect((await call(d, 'status', { configText: CONFIG, approved: APPROVED })).status).toBe('401')
  expect(seen.length).toBe(before)
})

test('a step streams one event per line; the provider gets the key and exactly the Klyth User-Agent; the log line holds no key', async () => {
  const d = await startKlythd()
  const r = await call(d, 'step', stepBody(d))
  expect(r.status).toBe('200')
  const events = r.lines.map(l => JSON.parse(l) as StepEvent)
  expect(events.flatMap(e => (e.type === 'text' ? [e.text] : [])).join('')).toBe('hello world')
  expect(events.filter(e => e.type !== 'text').slice(0, 2)).toEqual([
    { type: 'usage', in: 7, out: 2, cacheRead: 0, cacheWrite: 0 },
    { type: 'stop', reason: 'end_turn' },
  ])
  expect(events.at(-1)).toMatchObject({ type: 'stats', in: 7, out: 2, finish: 'stop' })
  expect(seen.at(-1)).toEqual({ path: '/v1/chat/completions', ua: UA, auth: `Bearer ${KEY}` })
  expect(JSON.parse((await call(d, 'status', { token: d.token, configText: CONFIG, approved: APPROVED })).lines[0] ?? '[]')).toEqual([{ provider: 'loc', key: 'cached' }])
  d.proc.kill('SIGTERM')
  const log = await d.stderr()
  expect(log).toMatch(/^klyth step main → loc\/m kind=openai http=200 effort=none msgs=1 tools=0 bytes=\d+ ttfb=\d+ total=\d+ in=7 out=2 cache=0 wrote=0 reasoning=- load=[0-9a-f]{16} session=- /)
  expect(log).toMatch(/system=[0-9a-f]{16} tools=[0-9a-f]{16} params=[0-9a-f]{16} historyTotal=1 historyOmitted=0 history=0:[0-9a-f]{16} firstMeta=[0-9a-f]{16} firstBlocksTotal=1 firstBlocksOmitted=0 firstBlocks=0:text:4:[0-9a-f]{16} store=memory restored=0\/0 finish=stop\n$/)
  expect(log).not.toContain(KEY)
  expect(log).not.toContain('SYS')
})

test('a provider that configures a User-Agent sends it in place of the mod\'s; one that does not sends exactly the mod\'s; none sends Bun/', async () => {
  const d = await startKlythd()
  const own = 'klyth/0.0.0-test (testos)'
  const config = JSON.stringify({ providers: { loc: { ...JSON.parse(CONFIG).providers.loc, headers: { 'User-Agent': own, originator: 'klyth' } } } })
  const approved = [fingerprint((parseConfig(config).config as Config).providers['loc'] as ProviderConfig)]
  const before = seen.length
  expect((await call(d, 'step', { ...stepBody(d), configText: config, approved })).status).toBe('200')
  expect(seen.at(-1)?.ua).toBe(own)
  expect((await call(d, 'step', stepBody(d))).status).toBe('200')
  expect(seen.at(-1)?.ua).toBe(UA)
  expect(seen.slice(before).map(s => s.ua)).toEqual([own, UA])
  expect(seen.map(s => s.ua).join('\n')).not.toContain('Bun/')
})

test('a key helper that exits 3 with a line on stderr fails the step with that line, redacted, in the failure text', async () => {
  const d = await startKlythd()
  const command = ['/bin/sh', '-c', `echo 'sign-in expired; token=${KEY}' >&2; yes noise | head -c 1048576 >&2; exit 3`]
  const config = JSON.stringify({ providers: { loc: { ...JSON.parse(CONFIG).providers.loc, auth: { command } } } })
  const approved = [fingerprint((parseConfig(config).config as Config).providers['loc'] as ProviderConfig)]
  const r = await call(d, 'step', { ...stepBody(d), configText: config, approved })
  const text = r.lines.map(l => JSON.parse(l) as StepEvent).find(e => e.type === 'error')
  expect(text).toMatchObject({ type: 'error', text: 'klyth: loc key helper failed (exit 3): sign-in expired; token=[REDACTED]' })
  expect(r.lines.join('\n')).not.toContain(KEY)
})

test('killing curl mid-step cancels the provider request', async () => {
  const d = await startKlythd()
  const before = cancelled
  const c = curl(d, 'step', stepBody(d, 'held'))
  const reader = c.stdout.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(JSON.parse(first.split('\n')[0] ?? '')).toEqual({ type: 'text', text: 'hello' })
  c.kill()
  for (let i = 0; i < 100 && cancelled === before; i++) await Bun.sleep(20)
  expect(cancelled).toBe(before + 1)
})

test('a client that goes away before the provider answers leaves one aborted step line and no failure in the log', async () => {
  const d = await startKlythd()
  const c = curl(d, 'step', stepBody(d, 'slow'))
  await Bun.sleep(300)
  c.kill()
  await c.exited
  await Bun.sleep(2200)
  d.proc.kill('SIGTERM')
  const log = await d.stderr()
  expect(log).toMatch(/^klyth step main → loc\/slow kind=openai http=- .* finish=aborted\n$/)
  expect(log).not.toMatch(/failed inside klythd|error=/)
})

test('a 503 with a retry-after is sent again by the real transport and the step ends with the answer, one retry line in the log', async () => {
  const d = await startKlythd()
  const before = seen.length
  const r = await call(d, 'step', stepBody(d, 'flaky'))
  const events = r.lines.map(l => JSON.parse(l) as StepEvent)
  expect(events.flatMap(e => (e.type === 'text' ? [e.text] : [])).join('')).toBe('hello world')
  expect(events.some(e => e.type === 'error')).toBe(false)
  expect(seen.length - before).toBe(2)
  d.proc.kill('SIGTERM')
  const log = await d.stderr()
  expect(log).toMatch(/^klyth retry main → loc\/flaky attempt=2 after=http 503 wait=\d+\nklyth step main → loc\/flaky .* http=200 .* finish=stop\n$/)
})

test('killing curl during the wait before a resend ends the step at once: one request reached the provider and the log shows an aborted step, no failure', async () => {
  const d = await startKlythd()
  const before = seen.length
  const c = curl(d, 'step', stepBody(d, 'down'))
  for (let i = 0; i < 100 && seen.length === before; i++) await Bun.sleep(20)
  await Bun.sleep(300)
  c.kill()
  await c.exited
  await Bun.sleep(300)
  d.proc.kill('SIGTERM')
  const log = await d.stderr()
  expect(seen.length - before).toBe(1)
  expect(log).toMatch(/^klyth retry main → loc\/down attempt=2 after=http 503 wait=[67]\d{3}\nklyth step main → loc\/down kind=openai http=503 .* finish=aborted\n$/)
  expect(log).not.toMatch(/failed inside klythd|error=/)
})

test('past 16 steps in flight a step is answered with one error line and stats', async () => {
  const d = await startKlythd()
  const held = Array.from({ length: 16 }, () => curl(d, 'step', stepBody(d, 'held')))
  for (const c of held) await c.stdout.getReader().read()
  const body = stepBody(d)
  const executionId = crypto.randomUUID()
  const r = await call(d, 'step', { ...body, accounting: { requestId: `request:${executionId}`, executionId }, req: { ...body.req, accounting: { purpose: 'step', owner: 'main' } } })
  expect(r.lines.map(l => JSON.parse(l) as Record<string, unknown>)).toEqual([
    { type: 'usage_summary', requestId: `request:${executionId}`, executionId, outcome: 'refused', attempts: [] },
    { type: 'error', kind: 'request', text: 'klyth: 16 routed steps are already in flight; retry when one ends' },
    { type: 'stats', ttfbMs: null, totalMs: 0, reqBytes: 0, in: null, out: null, finish: 'error' },
  ])
  for (const c of held) c.kill()
})

test('klythd exits on SIGTERM and when its parent goes away, removing its directory', async () => {
  const d = await startKlythd()
  d.proc.kill('SIGTERM')
  expect(await d.proc.exited).toBe(0)
  expect(existsSync(d.dir)).toBe(false)
  const orphan = await startKlythd(true)
  await Promise.race([orphan.closed(), Bun.sleep(8000)])
  expect(existsSync(orphan.dir)).toBe(false)
}, 15_000)

test('the real compiled CLI daemon uses its build version from an unrelated working directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'klyth-compiled-daemon-'))
  const cwd = join(root, 'unrelated')
  mkdirSync(cwd)
  const out = join(root, 'release')
  const build = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/build-release.ts'), '--out', out, '--version', '2.4.1', '--artifact-base-url', 'https://downloads.example/releases/v2.4.1'], { cwd, stdout: 'pipe', stderr: 'pipe' })
  expect(new TextDecoder().decode(build.stderr)).not.toContain('error:')
  expect(build.exitCode).toBe(0)
  const d = await startKlythd(false, { path: join(out, 'klyth'), cwd })
  const result = await call(d, 'step', stepBody(d))
  expect(result.status).toBe('200')
  expect(seen.at(-1)?.ua).toBe('klyth/2.4.1')
  d.proc.kill()
  await d.closed()
}, 60_000)
