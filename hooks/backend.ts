// The Backend of this build: a client of klythd (klythd/main.ts), the per-session helper process that holds
// the codecs, the credential helpers and their keys, and the provider connections. The engine ends a child
// with the dispatch in whose async context it was spawned, whichever `$` made the call, so a klythd spawned
// while a step runs ends when that step is aborted (Esc, TaskStop) and takes every other routed step with
// it. `start`, called in session.start, therefore sets going a loop that lives as long as the session, and
// every spawn of klythd (the first, and each after a crash, an idle exit or a hot reload) is made in that
// loop, on use when it is gone. A step klythd dies under before yielding anything is sent once more, unless
// klythd crashed or the step asked to be sent `once`. klythd answers `ready <socket> <token>` and is reached
// through curl over that socket; the token goes only in each call's body, on curl's stdin, never in an argv,
// an environment or a file. A step streams the events klythd writes, one per line; closing the stream kills
// curl, which cancels the provider request.
import type { ProcessRunInit, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'

import { parseConfig } from './config'
import { resolve } from './names'
import type { Cache } from './config'
import type { Pricing } from './pricing'
import { validateUsageSummary } from './usage-evidence'
import type { UsageExecutionSummary } from './usage-evidence'
import { PRODUCT } from './product'
import { failedStep } from './protocol'
import type { Backend, ProviderStatus, SessionScope, StepEvent, StepRequest, StepWire } from './protocol'
import { firstLine } from './redact'

// The host as the backend reaches it: a command run to its end, a command spawned and streamed, a wait, the
// debug log, the mod's directory, the User-Agent of provider requests and the session scope of its steps. The hooks module builds it
// from `$`, which no other module may take.
export type Host = {
  run(argv: readonly string[], init: ProcessRunInit): Promise<ProcessRunResult>
  spawn(req: ProcessSpawnRequest): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  debug(text: string): void
  root: string
  launch?(): Promise<readonly string[] | undefined>
  session?: SessionScope
}

export type UsageTargetSnapshot = { target: string; label: string; pricing?: Pricing; cache?: Cache }
export type BackendUsageObserver = {
  begin(meta: NonNullable<StepRequest['accounting']> & { target: string }): string | undefined
  dispatch(requestId: string, executionId: string, snapshot: UsageTargetSnapshot): void
  summary(requestId: string, summary: UsageExecutionSummary): void
  missing(requestId: string, executionId: string): void
  settle(requestId: string, outcome: 'complete' | 'aborted' | 'interrupted'): void
  gap(requestId?: string): void
}

// A klythd that answered ready: its socket and token, and (once it has exited) whether it crashed.
type Daemon = { sock: string; token: string; exited: Promise<boolean> }
type Failed = { error: string }
// A klythd this module spawned: its handshake, the socket and token once it answered ready, whether it exited
// in a crash, whether klyth stopped it, and how to stop it.
type Launch = { ready: Promise<Daemon | Failed>; daemon?: Daemon; exited: Promise<boolean>; stopped: boolean; stop(): void }

export const NO_BUN = 'klyth: bun not found — install bun (https://bun.sh), then retry'
const NO_START = 'klyth: klythd did not start (see the debug log); run /klyth reload, then retry'
const PAUSED = 'klyth: klythd crashed twice; routed models paused until /klyth reload'
const READY_MS = 3000
const EXIT_MS = 1000
const CRASH_WINDOW_MS = 60_000
const curl = (sock: string, call: 'step' | 'status' | 'dispatch') => ['/usr/bin/curl', '-q', '-sS', '-N', '--unix-socket', sock, '--data-binary', '@-', `http://${PRODUCT.daemon}/${call}`]
const notify = (observer: BackendUsageObserver | undefined, action: () => void, requestId?: string) => {
  try { action() } catch { try { observer?.gap(requestId) } catch {} }
}

// curl's stderr on one line: its own error line when it printed one.
const curlLine = (stderr: string) => (stderr.split('\n').find(l => l.startsWith('curl: (')) ?? stderr).replace(/\s+/g, ' ').trim().slice(0, 200)

// Where bun is: on PATH, else bun's own install directory; null when it is nowhere, or the lookup cannot run.
export async function findBun(run: (argv: readonly string[], init: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>): Promise<string | null> {
  try {
    const r = await run(['/bin/sh', '-c', 'command -v bun || { test -x "$HOME/.bun/bin/bun" && echo "$HOME/.bun/bin/bun"; }'], { timeoutMs: 5000 })
    const path = firstLine(r.stdout)
    return r.exitCode === 0 && path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

const failure = (text: string, started: number) => failedStep(text, Math.round(performance.now() - started))

// What `p` settles to, or `late` once `ms` have passed (the wait ends with `p`).
async function within<T, L>(host: Host, ms: number, p: Promise<T>, late: L): Promise<T | L> {
  const timer = new AbortController()
  const after = host.sleep(ms, timer.signal).then(
    () => late,
    () => late,
  )
  const result = await Promise.race([p, after])
  timer.abort()
  return result
}

// The backend's memory is one registration's: the config text and approvals every call carries, the bun
// found, the klythd in use, and the crashes counted. `createBackend()` makes it; the result works through
// the host of each call.
export function createBackend(observer?: BackendUsageObserver) {
  let configText = '{}'
  let approved: readonly string[] = []
  let bun: string | null | undefined // the bun path; null when none was found
  let launch: Launch | undefined // the klythd spawned last, until it exits
  let crashes: number[] = [] // when klythd exited on its own with a failure, within the window
  let paused = false
  let home: Host | undefined // the host of the session.start that ran `start`; its loop spawns klythd
  let starting: Promise<Launch> | undefined // the spawn of klythd the loop was last asked for, until it is made
  const jobs: (() => void)[] = [] // what the loop was asked to run, oldest first
  let wake = () => {}

  // Reads a spawned klythd for its life: its ready line (answered once), its stderr into the debug log, and how
  // it ended (told to `exited`). An exit on its own with a failure counts as a crash; a second within a minute
  // pauses routing.
  async function watch(host: Host, child: AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>, l: Launch, answer: (d: Daemon | Failed) => void, exited: (crashed: boolean) => void) {
    let out = ''
    let err = ''
    let end: ProcessSpawnResult | undefined
    try {
      for (;;) {
        const piece = await child.next()
        if (piece.done) {
          end = piece.value
          break
        }
        if (piece.value.stream === 'stderr') {
          const lines = (err + piece.value.text).split('\n')
          err = (lines.pop() ?? '').slice(-8192)
          for (const line of lines) if (line !== '') host.debug(line)
        } else if (l.daemon === undefined) {
          out = (out + piece.value.text).slice(0, 4096)
          const ready = /^ready (\S+) (\S+)\n/.exec(out)
          if (ready === null) continue
          answer((l.daemon = { sock: ready[1] as string, token: ready[2] as string, exited: l.exited }))
          host.debug(`klyth klythd ready at ${l.daemon.sock}`)
        }
      }
    } catch (e) {
      host.debug(`klyth klythd: ${firstLine(String(e))}`)
    }
    if (launch === l) launch = undefined
    answer({ error: NO_START })
    host.debug(`klyth klythd exited (code ${end?.code ?? '-'}, signal ${end?.signal ?? '-'})`)
    // An idle or orphaned exit, a kill from outside (the engine ending the child) and klyth's own stop are no crash.
    const crashed = !(l.stopped || (end !== undefined && (end.code === 0 || end.signal !== null)))
    if (crashed) {
      const now = performance.now()
      crashes = [...crashes.filter(t => now - t < CRASH_WINDOW_MS), now]
      if (crashes.length >= 2) paused = true
    }
    exited(crashed)
  }

  // Spawns klythd with the bun at `exe`, read for its life by a loop that runs on after the calling hook returns. It runs in
  // the session's directory, where the key helpers have always run, with bunfig and .env loading disabled and inherited
  // BUN_OPTIONS cleared: klythd holds the keys, and a project's files are the routed model's to write.
  function spawnKlythd(host: Host, argv: readonly string[]): Launch {
    const child = host.spawn({ argv, env: { BUN_OPTIONS: '' } })
    let answer: (d: Daemon | Failed) => void = () => {}
    let exited: (crashed: boolean) => void = () => {}
    const l: Launch = {
      ready: new Promise(resolve => (answer = resolve)),
      exited: new Promise(resolve => (exited = resolve)),
      stopped: false,
      stop() {
        l.stopped = true
        if (launch === l) launch = undefined
        void child.return(undefined as never).catch(() => {})
      },
    }
    void watch(host, child, l, answer, exited)
    return l
  }

  // Sets going, once, the loop that runs what `inSession` is given, in the dispatch this is called in (the
  // session.start whose host this is, which the session outlives).
  function hold(host: Host) {
    if (home !== undefined) return
    home = host
    void (async () => {
      for (;;) {
        for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) job()
        await new Promise<void>(resolve => (wake = resolve))
      }
    })()
  }

  // Runs `job` in that loop, with the host the loop belongs to, so that a child it spawns lasts as long as the
  // session and not as long as the step asking. With no loop (`start` not called) it runs here, with `host`.
  function inSession<T>(host: Host, job: (host: Host) => T): Promise<T> {
    const owner = home
    if (owner === undefined) return Promise.resolve().then(() => job(host))
    return new Promise<T>((resolve, reject) => {
      jobs.push(() => {
        try {
          resolve(job(owner))
        } catch (e) {
          reject(e)
        }
      })
      wake()
    })
  }

  // The klythd in use, spawned (not waited for) when there is none.
  async function launched(host: Host): Promise<Launch | Failed> {
    if (launch !== undefined) return launch
    if (paused) return { error: PAUSED }
    let argv: readonly string[] | undefined
    try { argv = await host.launch?.() } catch { return { error: 'klyth: version-matched helper unavailable; run /klyth setup' } }
    if (argv === undefined) {
      const exe = bun ?? (await findBun(host.run))
      if (exe === null) return { error: NO_BUN }
      bun = exe
      argv = [exe, '--config=/dev/null', '--no-env-file', `${host.root}/${PRODUCT.daemon}/main.ts`]
    }
    return (starting ??= inSession(host, h => (launch ??= spawnKlythd(h, argv))).finally(() => (starting = undefined)))
  }

  // The klythd in use, once it has said ready (at most 3 s after it was spawned).
  async function ensure(host: Host): Promise<Daemon | Failed> {
    const l = await launched(host)
    if ('error' in l) return l
    if (l.daemon !== undefined) return l.daemon
    const result = await within<Daemon | Failed, Failed>(host, READY_MS, l.ready, { error: NO_START })
    if ('error' in result) {
      host.debug(`klyth klythd: no ready line within ${READY_MS} ms`)
      l.stop()
    }
    return result
  }

  // One call of /step: the events klythd writes, ended with an error and stats of its own when its answer
  // stopped short. Returns 'gone' when nothing came back, klythd is gone without a crash and `last` is not set:
  // the caller sends the step again.
  async function* call(host: Host, d: Daemon, req: StepRequest, signal: AbortSignal, started: number, last: boolean, requestId?: string, dispatchGuard?: () => Promise<boolean>): AsyncGenerator<StepEvent, 'gone' | undefined> {
    const executionId = requestId === undefined ? undefined : crypto.randomUUID()
    const accounting = requestId === undefined || executionId === undefined ? undefined : { requestId, executionId }
    const wire: StepWire = { token: d.token, configText, approved, ...(host.session === undefined ? {} : { session: host.session }), req, ...(dispatchGuard === undefined ? {} : { dispatch: crypto.randomUUID() }), ...(accounting === undefined ? {} : { accounting }) }
    const configured = parseConfig(wire.configText).config
    const target = configured === undefined ? undefined : resolve(configured, req.target)
    if (requestId !== undefined && executionId !== undefined) notify(observer, () => observer?.dispatch(requestId, executionId, { target: target?.kind === 'remote' ? target.target : req.target, label: target?.kind === 'remote' ? target.label : req.target, ...(target?.kind === 'remote' && target.model.pricing !== undefined ? { pricing: target.model.pricing } : {}), ...(target?.kind === 'remote' && target.model.cache !== undefined ? { cache: target.model.cache } : {}) }), requestId)
    const child = host.spawn({ argv: curl(d.sock, 'step'), input: JSON.stringify(wire) })
    let buf = ''
    let stderr = ''
    let yielded = false
    let ended: ProcessSpawnResult | undefined
    let finished = false
    let complete = false
    let summarySeen = false
    const close = () => void child.return(undefined as never).catch(() => {})
    signal.addEventListener('abort', close, { once: true })
    try {
      for (;;) {
        if (signal.aborted) return undefined
        const piece = await child.next()
        if (piece.done) {
          ended = piece.value
          break
        }
        if (piece.value.stream === 'stderr') {
          stderr = (stderr + piece.value.text).slice(-4096)
          continue
        }
        const lines = (buf + piece.value.text).split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines) {
          if (signal.aborted) return undefined
          if (l.trim() === '') continue
          let ev: StepEvent | UsageExecutionSummary | { dispatchReady: string; request: string }
          try {
            ev = JSON.parse(l) as StepEvent | UsageExecutionSummary | { dispatchReady: string; request: string }
          } catch {
            host.debug(`klyth klythd sent an unreadable line: ${JSON.stringify(l.slice(0, 120))}`)
            continue
          }
          if ('type' in ev && ev.type === 'usage_summary') {
            const summary = validateUsageSummary(ev)
            if (summary === undefined || accounting === undefined || summary.requestId !== accounting.requestId || summary.executionId !== accounting.executionId) {
              const invalidRequestId = accounting?.requestId
              notify(observer, () => observer?.gap(invalidRequestId), invalidRequestId)
              continue
            }
            summarySeen = true
            notify(observer, () => observer?.summary(accounting.requestId, summary), accounting.requestId)
            continue
          }
          if ('dispatchReady' in ev) {
            let accepted = false
            try { accepted = ev.request === wire.dispatch && typeof ev.dispatchReady === 'string' && /^[a-f0-9-]{36}$/.test(ev.dispatchReady) && !signal.aborted && await dispatchGuard?.() === true && !signal.aborted } catch { /* a failed decision rejects dispatch */ }
            let acknowledged = false
            try {
              const ack = await host.run(curl(d.sock, 'dispatch'), { stdin: JSON.stringify({ token: d.token, configText, approved, dispatch: ev.dispatchReady, accepted }), timeoutMs: 5000 })
              acknowledged = ack.exitCode === 0 && ack.stdout === 'acknowledged'
            } catch { /* closing the step rejects an undelivered decision */ }
            if (!acknowledged) return yield* failure('klyth: dispatch acknowledgment failed; the request was not confirmed', started)
            continue
          }
          if (ev.type === 'stop' || ev.type === 'error') finished = true
          if (ev.type === 'stats') complete = true
          yielded = true
          yield ev
        }
      }
    } finally {
      signal.removeEventListener('abort', close)
      if (ended === undefined) close()
      if (accounting !== undefined && !summarySeen) notify(observer, () => observer?.missing(accounting.requestId, accounting.executionId), accounting.requestId)
    }
    if (complete || signal.aborted) return undefined
    // klythd is gone when curl could not connect (7), its connection closed with no reply (52) or curl was
    // killed; any other end (a plain-text reply and exit 0, say) leaves a live klythd alone.
    const how = ended.code ?? ended.signal
    const resend = !yielded && !last && (ended.signal !== null || ended.code === 7 || ended.code === 52)
    // A connection that closed on this step was klythd ending under it: if that was a crash the step is not
    // sent again, or the step that crashed klythd would crash the next one too and pause routing.
    const crashed = resend && ended.code !== 7 && (await within(host, EXIT_MS, d.exited, false))
    if (resend && !crashed) return 'gone'
    host.debug(`klyth klythd call ended short (curl exit ${how}${stderr === '' ? '' : `: ${curlLine(stderr)}`})`)
    const text =
      yielded || crashed
        ? 'klyth: klythd stopped during the step; retry'
        : ended.code === 0
          ? 'klyth: klythd sent a reply klyth could not read (see the debug log); run /klyth reload, then retry'
          : `klyth: klythd did not answer (curl exit ${how}); run /klyth reload, then retry`
    const tail = failure(text, started)
    yield* finished ? tail.slice(1) : tail
    return undefined
  }

  async function* step(host: Host, req: StepRequest, signal: AbortSignal, opts?: { once?: true; dispatchGuard?(): Promise<boolean> }): AsyncGenerator<StepEvent, void> {
    const started = performance.now()
    let requestId: string | undefined
    let completed = false
    if (observer !== undefined && req.accounting !== undefined) notify(observer, () => { requestId = observer.begin({ ...req.accounting!, target: req.target }) })
    try {
      for (let attempt = 0; !signal.aborted; attempt++) {
        const d = await ensure(host)
        if ('error' in d) { yield* failure(d.error, started); completed = true; return }
        if (opts?.dispatchGuard !== undefined) {
          let valid = false
          try { valid = !signal.aborted && await opts.dispatchGuard() && !signal.aborted } catch { /* a failed decision rejects dispatch */ }
          if (!valid) { yield* failure('klyth: compaction dispatch is stale or cancelled; the request was not sent', started); completed = true; return }
        }
        if ((yield* call(host, d, req, signal, started, opts?.dispatchGuard !== undefined || opts?.once === true || attempt > 0, requestId, opts?.dispatchGuard)) !== 'gone') { completed = true; return }
        // A klythd that answered nothing is gone: started again, and the step sent to it once.
        if (launch?.daemon === d) launch = undefined
      }
    } finally {
      if (requestId !== undefined) notify(observer, () => observer?.settle(requestId!, signal.aborted ? 'aborted' : completed ? 'complete' : 'interrupted'), requestId)
    }
  }

  // Each provider's key state as klythd holds it; with no klythd running, no helper has run (a keyless provider has none to run).
  async function status(host: Host): Promise<ProviderStatus[]> {
    const none = Object.values(parseConfig(configText).config?.providers ?? {}).map(p => ({ provider: p.id, key: p.auth === 'none' ? ('none' as const) : ('not-run' as const) }))
    const d = launch?.daemon
    if (d === undefined) return none
    try {
      const r = await host.run(curl(d.sock, 'status'), { stdin: JSON.stringify({ token: d.token, configText, approved }), timeoutMs: 5000 })
      const states: unknown = JSON.parse(r.stdout)
      return r.exitCode === 0 && Array.isArray(states) ? (states as ProviderStatus[]) : none
    } catch {
      return none
    }
  }

  // Takes the config and the approved fingerprints, sent with every call. A configure approving nothing (a
  // reload) also lifts a crash pause and looks for bun again.
  function configure(c: { configText: string; approved: readonly string[] }) {
    configText = c.configText
    approved = [...c.approved]
    if (approved.length > 0) return
    paused = false
    crashes = []
    if (bun === null) bun = undefined
  }

  return (host: Host): Backend => ({
    configure: async c => configure(c),
    start: async () => {
      hold(host)
      if (Object.keys(parseConfig(configText).config?.providers ?? {}).length === 0) return
      try {
        await launched(host)
      } catch (e) {
        host.debug(`klyth klythd: ${firstLine(String(e))}`)
      }
    },
    step: (req, signal, opts) => step(host, req, signal, opts),
    status: () => status(host),
  })
}
