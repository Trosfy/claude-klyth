// klythd: the per-session helper process that answers the mod's routed steps (`bun klythd/main.ts`). It
// binds a Unix socket in a fresh 0700 directory, mints a token, prints `ready <socket> <token>` once, and
// serves two calls, each a JSON body carrying the token (a call without it is refused, 401):
//   POST /step    a step's request in; its StepEvents out, one JSON object per line, as they come
//   POST /status  each provider's key state, running nothing
// It exits, removing its directory, when its parent goes away, after 10 minutes idle (longer when a model or
// alias sets a one-hour cache: see idleLimit), or on a signal.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import type { Config } from '../hooks/config'
import plugin from '../.claude-plugin/plugin.json'
declare const KLYTH_VERSION: string
import { extraClient } from '../hooks/extras'
import { failedStep } from '../hooks/protocol'
import type { StepEvent, StepWire } from '../hooks/protocol'
import { USAGE_UUID } from '../hooks/usage-evidence'
import type { UsageExecutionSummary } from '../hooks/usage-evidence'
import { dispatchGate } from '../hooks/dispatch-gate'
import { firstLine, redact } from '../hooks/redact'
import type { Runner } from './auth'
import { createStepper } from './step'
import type { Env } from './step'
import { post } from './upstream'
import { responseStores } from './responses-file'

const IN_FLIGHT_MAX = 16
const IDLE_EXIT_MS = 600_000
const POLL_MS = 5_000

// How long klythd waits idle before it exits for `config`: ten minutes, or 65 (five past the hour) when a model
// or alias sets a one-hour cache. The signed thinking it holds in memory for a step without a session scope is
// lost when it exits, and matters while the provider's cache could still hold that turn.
export const idleLimit = (config: Config) =>
  [...Object.values(config.providers).flatMap(p => Object.values(p.models)), ...Object.values(config.aliases)].some(x => x.cache === '1h') ? 65 * 60_000 : IDLE_EXIT_MS

type OutputEvent = StepEvent | UsageExecutionSummary | { dispatchReady: string; request: string }
const line = (ev: OutputEvent) => new TextEncoder().encode(`${JSON.stringify(ev)}\n`)
const ndjson = (body: AsyncIterable<Uint8Array> | OutputEvent[], status = 200) =>
  new Response(Array.isArray(body) ? body.map(e => JSON.stringify(e)).join('\n') + '\n' : body, { status, headers: { 'content-type': 'application/x-ndjson' } })
const emptySummary = (w: StepWire): UsageExecutionSummary[] =>
  w.accounting === undefined || !USAGE_UUID.test(w.accounting.executionId) || w.accounting.requestId.length > 256
    ? []
    : [{ type: 'usage_summary', ...w.accounting, outcome: 'refused', attempts: [] }]

// A credential helper run with no shell, its stdin closed, killed after `timeoutMs`. Its stderr is read as it
// runs, and only its first line is kept: redacted, at most 120 characters.
export const runHelper: Runner = async (argv, timeoutMs) => {
  const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (child.signalCode === 'SIGTERM') throw new Error(`timed out after ${timeoutMs} ms`)
  return { exitCode, stdout, stderr: redact(firstLine(stderr)).slice(0, 120) }
}

// Serves the socket at `sock` for callers holding `token`. `idleMs` reads how long nothing has been in flight,
// and `limitMs` how long that may last before klythd exits: it starts at ten minutes and grows to what the
// config of any call needs, never shrinking, so a step in flight keeps the limit its config set.
export function serve(sock: string, token: string, env: Env) {
  const stepper = dispatchGate(createStepper(env), env.sleep)
  const expected = Buffer.from(token)
  let inFlight = 0
  let since = Date.now()
  let limit = IDLE_EXIT_MS
  // bun-types lists idleTimeout for port servers only; a unix-socket server honours it too, and without it
  // cuts a response that stays silent for 10 s.
  // @ts-expect-error
  const server = Bun.serve({
    unix: sock,
    idleTimeout: 0,
    async fetch(req) {
      let w: StepWire
      try {
        w = (await req.json()) as StepWire
      } catch {
        return new Response('klythd: the body is not JSON\n', { status: 400 })
      }
      const given = Buffer.from(typeof w?.token === 'string' ? w.token : '')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return ndjson(failedStep('klyth: klythd refused a call without its token; run /klyth reload'), 401)
      const path = new URL(req.url).pathname
      if (path === '/dispatch') {
        const ack = stepper.ack(w)
        return new Response(ack.body, { status: ack.status })
      }
      const config = stepper.config(w.configText)
      if (config !== undefined) limit = Math.max(limit, idleLimit(config))
      if (path === '/status') return Response.json(stepper.status(w))
      if (path !== '/step') return new Response('klythd: no such call\n', { status: 404 })
      if (inFlight >= IN_FLIGHT_MAX) return ndjson([...emptySummary(w), ...failedStep(`klyth: ${IN_FLIGHT_MAX} routed steps are already in flight; retry when one ends`)])
      inFlight++
      let open = true
      const done = () => void (open && ((open = false), inFlight--, (since = Date.now())))
      const ac = new AbortController()
      req.signal.addEventListener('abort', () => ac.abort())
      return ndjson(
        (async function* () {
          try {
            for await (const ev of stepper.step(w, ac.signal)) yield line(ev)
          } catch (err) {
            // A client that went away while a read waited has closed the stream: no failure to log.
            if (!ac.signal.aborted) {
              env.log(`klyth step failed inside klythd: ${firstLine(redact(String(err)))}`)
              for (const ev of failedStep('klyth: internal error in klythd (see the debug log); retry')) yield line(ev)
            }
          } finally {
            ac.abort()
            done()
          }
        })(),
      )
    },
  })
  return { server, idleMs: () => (inFlight > 0 ? 0 : Date.now() - since), limitMs: () => limit }
}

export function startDaemon(): void {
  // The socket path stays under the ~100-byte limit of Unix socket names.
  const base = tmpdir().replace(/\/+$/, '')
  const dir = mkdtempSync(`${base.length > 70 ? '/tmp' : base}/klythd-`)
  const sock = `${dir}/d.sock`
  const token = randomBytes(32).toString('hex')
  const log = (text: string) => void process.stderr.write(`${text}\n`)
  const env: Env = { version: typeof KLYTH_VERSION === 'string' ? KLYTH_VERSION : plugin.version, post, run: runHelper, now: () => Date.now(), sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}), log, requestHeaders: p => extraClient && p.baseUrl === extraClient.baseUrl ? extraClient.requestHeaders(process.env) : {}, responses: responseStores(log), ...(process.env['KLYTH_PREFIX_TRACE'] === '1' ? { trace: true as const } : {}) }
  const { server, idleMs, limitMs } = serve(sock, token, env)
  chmodSync(sock, 0o600)
  const parent = process.ppid
  const quit = () => {
    void server.stop(true)
    rmSync(dir, { recursive: true, force: true })
    process.exit(0)
  }
  setInterval(() => (process.ppid !== parent || process.ppid === 1 || idleMs() >= limitMs()) && quit(), POLL_MS)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, quit)
  process.stdout.write(`ready ${sock} ${token}\n`)
}

if (import.meta.main) startDaemon()
