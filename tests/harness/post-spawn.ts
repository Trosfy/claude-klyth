// The post-spawn path of a routed subagent, which `claude plugin test` cannot reach: the kit strips the
// agentId from a plugin's own $.agent.spawn result, so every kit spawn ends "did not start". This drives
// the real register() with an emulated `$` whose spawn answers an agentId, and checks, for the klyth agent
// tool, the launch line, the `routed` member written to memory and to state (type, task, effort, worktree),
// the spawn debug line (a spawn makes no toast), the spawn barrier, the task reaching a child whose
// transcript reads back empty, a custom agent type's child getting its own definition, a child step whose
// route read fails as its spawn settles (answered by the turn.step .catch), the tool.call guard's .catch
// (the kit cannot make a hook fail), and two calls with the same prompt. For a plain Agent call under a
// routed parent: the agent.spawn hook claims the parent's route for a subagent the engine put on its
// parent's model (and no other), the child's steps are answered by klythd with its type's prompt, the call's
// effort, the guard and a hot reload apply, and a subagent of a routed subagent follows its parent (not one in a worktree, nor a spawn that sets a cwd) and is offered no tool the parent is not. An
// isolated Agent call, or one of an agent whose definition says `isolation: worktree`, is claimed only when the
// engine made the subagent's worktree, and the subagent's prompt then names it; the notes kept for Agent calls
// are capped, and a denied call's goes at once. An agent type klyth cannot resolve (no definition it can read)
// is not claimed, nor is a built-in type klyth cannot run (comment-thread-analyst), nor one that two agent
// files name (agents are found by their files' `name:`; one file that names a built-in type is its definition), nor a child of a resumed subagent
// that worked in a worktree. For a routed subagent's klyth agent call: the step ends on an Agent call with the
// call's id, which the engine runs from that subagent, so its spawn is claimed on the other alias with the
// subagent as parent and never goes through $.agent.spawn, its next step shows the call it made, and a call
// that cannot become an Agent call is denied; the same call gets the same answer from a native main's tool and from a
// routed subagent's translated call. A routed main's klyth agent call reads as the provider made it after a full restart of
// Claude Code too, and a fork of main is sent it so. A fork runs on its parent's alias with its parent's prompt, offered no
// SubagentHandback; a fork of main is sent main's history up to the call that started it, after a hot reload too;
// a klyth agent call for a fork on another alias is denied; a fork whose claim outlasts the wait is handed back, never run native, and
// so is a step the engine lists as a fork while a fork's spawn has not yet returned. A klyth agent call that spells a
// known type in another case runs as that type from either path, and main's own spawn that the engine lists as
// another type hands that back. The classifier on a routed subagent's refusal: a task whose spawn was vetted (a native main's
// own klyth agent call, an Agent call that spent a fresh classifier's allow on that task) counts as a request, and any other
// is data; and a git worktree under klyth's own root is classified as its own project.
//
//   bun tests/harness/post-spawn.ts      (bun run test:harness)
//
// It prints one PASS or FAIL line per scenario and exits 1 when any fails.
import type { SessionMessage } from 'claude-code'
import { BUILTIN_NOTES, EXPLORE_PROMPT, FORK_REPORT, GENERAL_PURPOSE_PROMPT, HANDBACK_GUIDANCE } from '../../hooks/agents'
import type { ApiMessage, StepRequest, StepWire } from '../../hooks/protocol'
import { register } from '../../hooks/register'
import { memoryStore } from '../../klythd/responses'
import { fakeDaemon } from '../daemon-fake'
import { dirEntries } from '../dirs'
import { SSE } from '../fixtures/data.gen'
import { denied } from '../fixtures/denied'
import { HANDBACK_REMINDER } from '../fixtures/handback'

// Bun's globals; the type environment is the hooks module's, which has none of them.
declare const console: { log(text: string): void }
declare const process: { exit(code: number): never }
declare function setTimeout(fn: () => void, ms: number): unknown

type Hook = { event: string; matcher?: Record<string, unknown>; hook: any; rescue?: any }
type StateWrite = { key: string; id?: string; value: unknown }
type World = {
  compactRows?: readonly SessionMessage[]
  spawnId?: string
  messages?: unknown[] | ((agentId: string | undefined) => unknown[]) // what $.session.messages reads back; absent, one user message
  files?: Record<string, string> // files beside the config, by absolute path
  stateSetFails?: boolean
  listFails?: boolean // $.tool.list throws
  gate?: Promise<void>
  routedRead?: Promise<void> // a read of a `routed` member waits for it, then fails
  listed?: { id: string; type: string }[] // what $.agent.list reads back; absent, nothing
  tools?: { name: string; mcp?: boolean }[] // what $.tool.list reads back; absent, Read
  listGate?: Promise<void> // $.agent.list waits for it
  upstream?: () => { pieces: string[] } // what the provider answers; absent, model-a-step2.sse
  approvalShown: boolean
  debug: string[]
  toasts: string[]
  sets: StateWrite[]
  spawns: Record<string, unknown>[]
  klythd: ReturnType<typeof fakeDaemon> // klythd and curl over its socket; its provider answers model-a-step2.sse
  runs: string[][]
  store: Map<string, unknown>
  state: Map<string, unknown>
  entered: () => void // called when a spawn starts, before it awaits `gate`
  sleeping: () => void // called when a step starts its spawn wait
  elapse: () => void // ends the wait a step started: the wait reaches its bound
  reading: () => void // called when a read of a `routed` member starts, before it awaits `routedRead`
}

const hooks: Hook[] = []
const on: any = (event: string, a: any, b?: any) => {
  const h: Hook = b ? { event, matcher: a, hook: b } : { event, hook: a }
  hooks.push(h)
  return { catch: (rescue: unknown) => void (h.rescue = rescue) }
}
// A fresh registration of the hooks: klyth's memory starts empty, as after a hot reload.
function registerAgain() {
  hooks.length = 0
  register(on, {} as never)
}
const findHook = (event: string, e: Record<string, unknown>) => {
  const h = hooks.find(x => x.event === event && Object.entries(x.matcher ?? {}).every(([k, v]) => e[k] === v))
  if (h === undefined) throw new Error(`no ${event} hook`)
  return h
}
const find = (event: string, e: Record<string, unknown>) => findHook(event, e).hook

const CONFIG = JSON.stringify({
  providers: {
    acme: {
      kind: 'openai',
      baseUrl: 'https://klyth.invalid/v1',
      auth: { command: ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'acme', '-w'] },
      models: {
        'model-a': { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000, maxTokensParam: 'max_completion_tokens', effort: { high: { reasoning_effort: 'high' } } },
      },
    },
  },
  aliases: { fast: 'acme/model-a' },
})
// A plain-http provider behind a dotted alias; its model takes `max_tokens` and effort levels up to medium.
const PLAIN_HTTP_CONFIG = JSON.stringify({
  providers: {
    local: {
      kind: 'openai',
      baseUrl: 'http://klyth.invalid:8080/v1',
      allowHttp: true,
      auth: { command: ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'local', '-w'] },
      models: {
        'model-v1': { contextWindow: 327_680, maxInputTokens: 262_144, maxOutputTokens: 65_536, maxTokensParam: 'max_tokens', effort: { low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' } } },
      },
    },
  },
  aliases: { 'model.v1-mini': 'local/model-v1' },
})

let w: World
// A fresh world over a fresh registration of the hooks. Its klythd keeps one response store across respawns, as the
// session's file does.
function reset(o: { spawnId?: string; stateSetFails?: boolean; gate?: Promise<void>; routedRead?: Promise<void>; messages?: World['messages']; files?: Record<string, string>; tools?: World['tools']; upstream?: World['upstream'] } = {}) {
  const records = memoryStore()
  const klythd = fakeDaemon({
    bun: '/opt/bin/bun',
    upstream: () => o.upstream?.() ?? { pieces: [SSE['model-a-step2.sse'] as string] },
    helper: argv => (w.runs.push(argv), { exitCode: 0, stdout: 'sk-klyth-test-key\n' }),
    log: text => void w.debug.push(text),
    now: new Date(2026, 9, 7, 12).getTime(),
    responses: () => records,
  })
  w = { ...o, approvalShown: false, debug: [], toasts: [], sets: [], spawns: [], klythd, runs: [], state: new Map(), store: new Map(), entered: () => {}, sleeping: () => {}, elapse: () => {}, reading: () => {} }
  registerAgain()
}

const $: any = {
  plugin: { name: 'klyth', root: '/klyth' },
  env: { get: async (n: string) => (n === 'HOME' ? '/home/u' : undefined) },
  fs: {
    exists: async (p: string) => p === '/home/u/.claude/klyth.json' || Object.hasOwn(w.files ?? {}, p) || dirEntries(w.files ?? {}, p) !== undefined,
    read: async (p: string) => (w.files !== undefined && Object.hasOwn(w.files, p) ? w.files[p] : CONFIG),
    list: async (p: string) => (dirEntries(w.files ?? {}, p) ?? []).map(entry => ({ ...entry, size: 0, mtimeMs: 0, isLink: false })),
    // Every path is there, and lands on itself.
    stat: async (p: string, o?: { resolve?: boolean }) => ({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...(o?.resolve ? { realPath: p } : {}) }),
  },
  settings: { read: async () => ({}) },
  session: {
    id: async () => 'fixture',
    version: async () => ({ version: '2.1.292' }),
    cwd: async () => '/w',
    model: async () => 'claude-opus-5-5',
    usage: async () => ({ context: { window: 1, breakdown: { mcpTools: [] } } }),
    messages: async (o?: { agentId?: string; as?: string }) => o?.as !== 'api' && w.compactRows !== undefined ? w.compactRows : (typeof w.messages === 'function' ? w.messages(o?.agentId) : w.messages) ?? [{ role: 'user', content: o?.agentId === undefined ? [{ type: 'text', text: 'hi' }] : [{ type: 'text', text: 'hi' }, HANDBACK_REMINDER] }],
  },
  tool: {
    check: async (e: { tool: string; input: unknown }) => find('tool.check', e)($, e, Object.assign(next(() => ({ decision: 'ask' })), { origin: { plugin: 'klyth', tier: 'user' } })),
    register: async () => ({ tool: 'mcp__klyth__agent' }),
    list: async () => {
      if (w.listFails) throw new Error('tool list unavailable')
      return (w.tools ?? [{ name: 'Read' }]).map(x => ({ name: x.name, description: x.name, mcp: x.mcp ?? false }))
    },
  },
  command: { register: async () => ({ command: 'klyth' }) },
  prompt: { compose: async () => ({ sections: [{ id: 'intro', text: 'SYS' }] }) },
  store: { get: async (key: string) => key.startsWith('trust:') ? true : w.store.get(key), set: async (key: string, value: unknown) => { w.store.set(key, value) } },
  state: {
    get: async (ref: { key: string; id?: string }) => {
      if (ref.key === 'routed' && w.routedRead !== undefined) {
        w.reading()
        await w.routedRead
        throw new Error('state down')
      }
      return { value: w.state.get(`${ref.key}:${ref.id ?? ''}`), version: 1 }
    },
    set: async (ref: { key: string; id?: string }, value: unknown) => {
      if (w.stateSetFails && ref.key === 'routed') throw new Error('state down')
      w.sets.push({ key: ref.key, ...(ref.id === undefined ? {} : { id: ref.id }), value })
      w.state.set(`${ref.key}:${ref.id ?? ''}`, value)
      return { isSet: true, version: 1 }
    },
  },
  agent: {
    list: async () => (await w.listGate, w.listed ?? []),
    spawn: async (args: Record<string, unknown>) => {
      const n = w.spawns.push(args)
      w.entered()
      await w.gate
      return { model: args['model'] ?? 'inherit', agentId: w.spawnId ?? `id${n}` }
    },
  },
  // Reads noon, local time, on 2026-10-07. A wait elapses only when a scenario calls `w.elapse()`, and rejects
  // when aborted.
  clock: {
    now: async () => new Date(2026, 9, 7, 12).getTime(),
    sleep: (ms: number, o?: { signal?: AbortSignal }) => {
      w.sleeping()
      return new Promise<void>((resolve, reject) => {
        w.elapse = resolve
        o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    },
    // Model lanes emit a synthetic visible-approval expiry, not eight seconds of wall time.
    // Countdown redraws and classifier request bounds do not expire in these scenarios.
    after: (ms: number, fn: () => void) => {
      let cancelled = false
      if (ms === 8000) void Promise.resolve().then(() => { if (!cancelled) fn() })
      return { cancel: () => { cancelled = true } }
    },
  },
  process: {
    run: async (argv: string[], init?: { stdin?: string }) => {
      w.runs.push(argv)
      if (argv.some(a => a.endsWith('/scripts/compact-draft.ts'))) return { exitCode: 0, stdout: '/home/u/.claude/klyth/compactions/fixture/draft.json', stderr: '' }
      const klythd = w.klythd.run(argv, init?.stdin)
      if (klythd !== undefined) return klythd
      if (argv[0] === '/bin/sh') return { exitCode: 0, stdout: argv[2]?.startsWith('command -v bun') ? '/opt/bin/bun\n' : '/opt/bin/trash\n', stderr: '' }
      if (argv[0] === '/usr/bin/uname') return { exitCode: 0, stdout: 'Darwin\n', stderr: '' }
      if (argv[0] === '/usr/bin/security') return { exitCode: 0, stdout: 'sk-klyth-test-key\n', stderr: '' }
      if (argv.includes('--show-toplevel')) return { exitCode: 0, stdout: '/w\n', stderr: '' }
      if (argv.includes('--verify')) return { exitCode: 0, stdout: 'base0\n', stderr: '' }
      if (argv.includes('rev-list')) return { exitCode: 0, stdout: '0\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    spawn: (req: { argv: readonly string[]; input?: string }) =>
      w.klythd.spawn(req.argv, req.input) ??
      (async function* () {
        return { code: 0, signal: null }
      })(),
  },
  ui: {
    open: async () => { w.approvalShown = true; return { isPlaced: true } },
    panes: async () => w.approvalShown ? [{ id: 'klyth-classifier-approval', title: 'Review action', isPlaced: true, isShown: true, isFocused: true }] : [],
    close: async () => { w.approvalShown = false },
    log: (t: string, o?: { to?: string }) => void (o?.to === 'debug' ? w.debug : []).push(t),
    toast: (t: string) => void w.toasts.push(t),
    status: () => {},
    ask: async () => 'Allow',
    invalidate: () => {},
  },
}
const next = (fn: unknown) => Object.assign(fn as object, { origin: { plugin: 'engine', tier: 'core' }, signal: new AbortController().signal, budget: { ms: 10000, remainingMs: 10000 } })

const startSession = () => find('session.start', {})($, { cwd: '/w' }, next((e: unknown) => e))
const wrap = (input: Record<string, unknown>) =>
  find('tool.call', { tool: 'mcp__klyth__agent' })(
    $,
    { tool: 'mcp__klyth__agent', tool_use_id: 't', model: 'fast', prompt: 'p', description: 'd', subagent_type: 'Explore', ...input },
    next(() => {
      throw new Error('the wrapper must not call next')
    }),
  )
// The native turn.step beneath klyth's: one text chunk, the answer "native".
const nativeStep = () =>
  next(() =>
    (async function* () {
      yield { kind: 'text', index: 0, text: 'native' }
      return { answer: 'native' }
    })(),
  )
type StepResult = { answer: string; toolUses?: { name: string; input: { message?: string } }[] }
async function drain(gen: AsyncGenerator<unknown, unknown>) {
  for (;;) {
    const r = await gen.next()
    if (r.done) return r.value as StepResult
  }
}
const stepEvent = (agentId: string) => ({ turnId: `t-${agentId}`, index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId })
const stepOf = (agentId: string) => drain(find('turn.step', {})($, stepEvent(agentId), nativeStep()))
// A child step whose hook threw, answered as the engine answers it: by the hook's .catch handler, on a
// `next` the hook had not called.
async function caughtStepOf(agentId: string) {
  const turnStep = findHook('turn.step', {})
  try {
    return await drain(turnStep.hook($, stepEvent(agentId), nativeStep()))
  } catch (err) {
    const failed = Object.assign(nativeStep(), { called: false, error: { kind: 'throw', message: String(err), budget: 1000 } })
    return await drain(turnStep.rescue($, stepEvent(agentId), failed))
  }
}
const complete = (agentId: string) =>
  find('turn.complete', {})($, { agentId, answer: 'r', reason: 'answer', turnId: 't', durationMs: 1, isAborted: false }, next((e: { answer: string }) => ({ text: e.answer })))
const LAUNCH = (label: string, shown: string, id: string) =>
  `klyth: started ${label} (${shown}) subagent ${id} in the background. Its report arrives as a separate message when it finishes. Stop it with TaskStop ${id}; message it with SendMessage to ${id}.`
const routed = () => w.sets.filter(s => s.key === 'routed')

// Equality over plain data, key order ignored.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => (typeof x === 'object' && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))
function eq(actual: unknown, expected: unknown, what: string) {
  if (canon(actual) !== canon(expected)) throw new Error(`${what}: got ${canon(actual)}, expected ${canon(expected)}`)
}
function ok(cond: boolean, what: string) {
  if (!cond) throw new Error(what)
}

// Settles with `waited`, or fails when `instead` settles first: a wait that would never end.
const before = (waited: Promise<void>, instead: Promise<unknown>, what: string) =>
  Promise.race([waited, instead.then(() => Promise.reject(new Error(what)))])

const results: string[] = []
async function scenario(name: string, fn: () => Promise<void>) {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('did not finish within 5 s')), 5000))])
    results.push(`PASS ${name}`)
  } catch (err) {
    results.push(`FAIL ${name}: ${(err as Error).message.split('\n')[0]}`)
  }
}

await scenario('remote: launch line, route written and persisted with its effort, spawn line, no toast, child routed', async () => {
  reset({ spawnId: 'r1' })
  await startSession()
  eq(await wrap({ effort: 'high', name: 'scout' }), { result: LAUNCH('fast', 'acme/model-a', 'r1') }, 'tool result')
  eq(w.spawns, [{ prompt: 'p', description: 'd', subagentType: 'Explore', name: 'scout' }], 'spawn arguments')
  eq(routed(), [{ key: 'routed', id: 'r1', value: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'p', effort: 'high' } }], 'routed member')
  ok(w.debug.includes('klyth spawn r1 → acme/model-a effort=high'), `spawn line missing: ${w.debug.join(' | ')}`)
  eq(w.toasts, [], 'toasts')
  eq((await stepOf('r1')).answer, 'London is 31°C with light rain.', 'child answer')
  eq(w.klythd.requests.length, 1, 'requests')
  eq(w.klythd.requests[0]?.body['reasoning_effort'], 'high', 'request effort')
})

await scenario('a dotted alias on a plain-http provider: launch line, route written, and the child request goes over http with that provider\'s body', async () => {
  reset({ spawnId: 'd1', files: { '/home/u/.claude/klyth.json': PLAIN_HTTP_CONFIG } })
  await startSession()
  eq(await wrap({ model: 'model.v1-mini', effort: 'max' }), { result: LAUNCH('model.v1-mini', 'local/model-v1', 'd1') }, 'tool result')
  eq(routed(), [{ key: 'routed', id: 'd1', value: { target: 'model.v1-mini', label: 'model.v1-mini', type: 'Explore', prompt: 'p', effort: 'max' } }], 'routed member')
  eq(w.toasts, [], 'toasts')
  await stepOf('d1')
  const { url, body } = w.klythd.requests[0] ?? { url: '', body: {} as Record<string, unknown> }
  eq(url, 'http://klyth.invalid:8080/v1/chat/completions', 'request URL')
  eq([body['model'], body['max_tokens'], body['reasoning_effort']], ['model-v1', 65536, 'medium'], 'request: max resolves to the highest level the model declares')
})

await scenario('an alias that carries request keys: the route keeps the alias, and the child request carries its params, effort level and headers', async () => {
  const overlay = JSON.parse(CONFIG) as { aliases: Record<string, unknown> }
  overlay.aliases = { deep: { target: 'acme/model-a', params: { top_p: 0.5 }, effort: { high: { reasoning_effort: 'low' } }, headers: { 'x-alias': 'deep' } } }
  reset({ spawnId: 'o1', files: { '/home/u/.claude/klyth.json': JSON.stringify(overlay) } })
  await startSession()
  eq(await wrap({ model: 'deep', effort: 'high' }), { result: LAUNCH('deep', 'acme/model-a', 'o1') }, 'tool result')
  eq(routed(), [{ key: 'routed', id: 'o1', value: { target: 'deep', label: 'deep', type: 'Explore', prompt: 'p', effort: 'high' } }], 'routed member')
  await stepOf('o1')
  const { headers, body } = w.klythd.requests[0] ?? { headers: {} as Record<string, string>, body: {} as Record<string, unknown> }
  eq([body['top_p'], body['reasoning_effort'], headers['x-alias']], [0.5, 'low', 'deep'], 'request: the alias params, its effort level and its header')
})

await scenario('native: the launch line names the native model; no route, no spawn line, the child passes through', async () => {
  reset({ spawnId: 'n1' })
  await startSession()
  eq(await wrap({ model: 'haiku' }), { result: LAUNCH('haiku', 'native haiku', 'n1') }, 'tool result')
  eq(w.spawns[0]?.['model'], 'haiku', 'spawn model')
  eq(routed(), [], 'routed members')
  ok(!w.debug.some(l => l.startsWith('klyth spawn ')), 'a spawn line was logged')
  eq(w.toasts, [], 'toasts')
  eq((await stepOf('n1')).answer, 'native', 'child answer')
})

await scenario('worktree: spawns in it, records it in the route, says so, and moves it to the Trash at completion', async () => {
  reset({ spawnId: 'w1' })
  await startSession()
  const r = (await wrap({ isolation: 'worktree' })) as { result: string }
  const path = String(w.spawns[0]?.['cwd'])
  ok(/^\/w\/\.claude\/worktrees\/agent-[0-9a-f]{8}$/.test(path), `spawn cwd ${path}`)
  const branch = `worktree-agent-${path.slice(-8)}`
  eq(r.result, `${LAUNCH('fast', 'acme/model-a', 'w1')} It works in the git worktree ${path} (branch ${branch}), which is removed if it finishes with no changes.`, 'tool result')
  eq(w.toasts, [], 'toasts')
  eq(routed(), [{ key: 'routed', id: 'w1', value: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'p', worktree: { path, branch, base: 'base0', root: '/w' } } }], 'routed member')
  await complete('w1')
  ok(w.runs.some(a => a[0] === '/opt/bin/trash' && a[1] === path), 'the worktree was not moved to the Trash')
  eq(routed().at(-1), { key: 'routed', id: 'w1', value: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'p', wasIsolated: true } }, 'routed member after cleanup')
})

await scenario('a rejected route persist after the spawn still answers the launch line, logs once, and routes from memory', async () => {
  reset({ spawnId: 'p1', stateSetFails: true })
  await startSession()
  eq(await wrap({}), { result: LAUNCH('fast', 'acme/model-a', 'p1') }, 'tool result')
  eq(w.debug.filter(l => l.startsWith('klyth: could not persist the route of p1')).length, 1, 'persist failure lines')
  await stepOf('p1')
  eq(w.klythd.requests.length, 1, 'requests')
})

await scenario('barrier: a child step raised while the spawn is held waits for it, then routes', async () => {
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  reset({ spawnId: 'b1', gate })
  await startSession()
  const inside = new Promise<void>(r => (w.entered = r))
  const waiting = new Promise<void>(r => (w.sleeping = r))
  const call = wrap({})
  await before(inside, call, 'the wrapper answered without spawning')
  const early = stepOf('b1')
  await before(waiting, early, 'the child step did not wait for the held spawn')
  release()
  eq((await early).answer, 'London is 31°C with light rain.', 'child answer')
  ok(w.debug.includes('klyth spawn-wait b1 outcome=settled routed=true'), `spawn-wait line missing: ${w.debug.join(' | ')}`)
  eq(await call, { result: LAUNCH('fast', 'acme/model-a', 'b1') }, 'tool result')
})

await scenario('a child step whose route read fails as its spawn settles is answered with the internal error for the spawned route, not passed to the native model', async () => {
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  let failRead = () => {}
  const routedRead = new Promise<void>(r => (failRead = r))
  reset({ spawnId: 'f1', gate, routedRead })
  await startSession()
  const inside = new Promise<void>(r => (w.entered = r))
  const waiting = new Promise<void>(r => (w.sleeping = r))
  const reading = new Promise<void>(r => (w.reading = r))
  const call = wrap({})
  await before(inside, call, 'the wrapper answered without spawning')
  const early = caughtStepOf('f1')
  await before(waiting, early, 'the child step did not wait for the held spawn')
  w.elapse()
  await before(reading, early, 'the child step did not read its persisted route after the wait reached its bound')
  release()
  eq(await call, { result: LAUNCH('fast', 'acme/model-a', 'f1') }, 'tool result')
  failRead()
  const answer = await early
  const text = 'klyth: internal error on fast; the step was not sent to another model (see the debug log)'
  eq(answer.toolUses, [{ name: 'SubagentHandback', input: { message: text } }], 'tool calls')
  eq(w.klythd.requests.length, 0, 'requests')
  ok(
    w.debug.includes('klyth: turn.step f1:t-f1:0 failed (throw: Error: state down); answered with the internal-error text for fast'),
    `failure line missing: ${w.debug.join(' | ')}`,
  )
})

await scenario('a child whose transcript reads back empty (no saved transcript) is sent the task the wrapper spawned it with', async () => {
  reset({ spawnId: 't1', messages: [] })
  await startSession()
  await wrap({ prompt: 'find the retry logic' })
  await stepOf('t1')
  const sent = (w.klythd.requests[0]?.body as { messages: unknown[] }).messages
  eq(sent[1], { role: 'user', content: 'find the retry logic' }, 'request task')
  ok(String((sent[0] as { content?: unknown }).content).startsWith(EXPLORE_PROMPT.slice(0, 40)), `system prompt: ${JSON.stringify(sent[0]).slice(0, 80)}`)
  ok(w.debug.some(l => l.startsWith('klyth req t1 msgs=1 firstUser="find the retry logic" tools=1[Read]')), `req line missing: ${w.debug.join(' | ')}`)
  // No saved transcript: the engine has not said it delivers through SubagentHandback, so the child is offered none and told nothing of it.
  ok(!String((sent[0] as { content?: unknown }).content).includes(HANDBACK_GUIDANCE), 'system prompt carries no handback guidance')
})

await scenario("a custom agent type: the child is sent its definition's body and tools, not the main prompt", async () => {
  reset({ spawnId: 'c1', files: { '/w/.claude/agents/scout.md': '---\nname: scout\ndescription: d\ndisallowedTools: Read\n---\nSCOUT BODY' } })
  await startSession()
  eq(await wrap({ subagent_type: 'scout' }), { result: LAUNCH('fast', 'acme/model-a', 'c1') }, 'tool result')
  eq(routed(), [{ key: 'routed', id: 'c1', value: { target: 'fast', label: 'fast', type: 'scout', prompt: 'p' } }], 'routed member')
  await stepOf('c1')
  const sent = w.klythd.requests[0]?.body as { messages: { content: string }[]; tools?: { function: { name: string } }[] }
  const system = sent.messages[0]?.content ?? ''
  ok(system.startsWith('SCOUT BODY\n') && !system.includes('SYS'), `system prompt: ${JSON.stringify(system.slice(0, 80))}`)
  ok(system.endsWith('running as the scout subagent via the klyth alias fast.'), `identity line: ${JSON.stringify(system.slice(-90))}`)
  eq(sent.tools?.map(t => t.function.name), ['SubagentHandback'], 'tools')
  ok(w.debug.includes('klyth agent-def scout from /w/.claude/agents/scout.md'), `agent-def line missing: ${w.debug.join(' | ')}`)
})

await scenario('two parallel calls with the same prompt get their own routes', async () => {
  reset()
  await startSession()
  const rs = (await Promise.all([wrap({}), wrap({ effort: 'high' })])) as { result: string }[]
  eq(rs.map(r => /subagent (id\d)/.exec(r.result)?.[1]).sort(), ['id1', 'id2'], 'agent ids')
  eq(routed().map(s => [s.id, (s.value as { effort?: string }).effort ?? 'none']).sort(), [['id1', 'none'], ['id2', 'high']], 'routes')
})

await scenario("guard: a routed child is denied a tool it was not offered; a failed check denies a routed child and passes a native agent", async () => {
  reset({ spawnId: 'g1' })
  await startSession()
  await wrap({ subagent_type: 'Explore' })
  await stepOf('g1')
  const guard = findHook('tool.call', { tool: 'Write' })
  const call = (tool: string, agentId: string) => guard.hook($, { tool, agentId, tool_use_id: 'u' }, next(() => 'beneath'))
  eq(await call('Write', 'g1'), { deny: 'klyth: Write is not available to the Explore subagent' }, 'a tool the step did not offer')
  eq(await call('Read', 'g1'), 'beneath', 'a tool the step offered')
  eq(await call('Write', 'native1'), 'beneath', 'a native agent')
  const failed = Object.assign(next(() => 'beneath'), { called: false, error: { kind: 'throw', message: 'boom', budget: 1000 } })
  const rescued = (agentId: string) => guard.rescue($, { tool: 'Read', agentId, tool_use_id: 'u' }, failed)
  eq(await rescued('g1'), { deny: 'klyth: could not check Read for this subagent, so it was denied; retry, or see the debug log' }, 'a failed check, routed child')
  eq(await rescued('native1'), 'beneath', 'a failed check, native agent')
})

await scenario('guard after a reload: a routed child with no memory is held by its type, and a failed rebuild denies it; a failure after the tool ran denies nothing', async () => {
  reset()
  await startSession()
  const route = { target: 'acme/model-a', label: 'fast', type: 'Explore', prompt: 'p' }
  w.state.set('routed:g2', route)
  w.state.set('routed:g3', route)
  const guard = findHook('tool.call', { tool: 'Write' })
  const call = (tool: string, agentId: string) => guard.hook($, { tool, agentId, tool_use_id: 'u' }, next(() => 'beneath'))
  eq(await call('Write', 'g2'), { deny: 'klyth: Write is not available to the Explore subagent' }, 'a tool its rebuilt set lacks')
  eq(await call('Read', 'g2'), 'beneath', 'a tool its rebuilt set has')
  w.listFails = true
  let threw = false
  await call('Read', 'g3').catch(() => void (threw = true))
  ok(threw, 'the guard did not fail when main\'s tools could not be listed')
  const failed = (called: boolean) => Object.assign(next(() => 'beneath'), { called, error: { kind: 'throw', message: 'boom', budget: 1000 } })
  const rescued = (called: boolean) => guard.rescue($, { tool: 'Read', agentId: 'g3', tool_use_id: 'u' }, failed(called))
  eq(await rescued(false), { deny: 'klyth: could not check Read for this subagent, so it was denied; retry, or see the debug log' }, 'a rebuild that failed')
  eq(await rescued(true), 'beneath', 'a failure after next ran')
})

// --- a plain Agent call under a routed parent ------------------------------------------------------------

const PARENT = 'claude-opus-5-5'
const agentFile = (name: string, model?: string, isolation?: string, body = 'SCOUT BODY') =>
  `---\nname: ${name}\ndescription: d\n${model === undefined ? '' : `model: ${model}\n`}${isolation === undefined ? '' : `isolation: ${isolation}\n`}---\n${body}`
const spawnEvent = (o: Record<string, unknown> = {}) => ({
  tool_use_id: 'u1',
  prompt: 'p',
  description: 'd',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: PARENT,
  permissionMode: 'default',
  background: true,
  fork: false,
  ...o,
})
// The engine's agent.spawn for `e`, raised by plugin `by`: klyth's hook over a core that answers `started` once
// `hold` settles.
const agentSpawn = (e: Record<string, unknown>, started: Record<string, unknown> = { model: PARENT, agentId: 'p1' }, o: { by?: string; hold?: Promise<void> } = {}) =>
  find('agent.spawn', {})($, e, Object.assign(async () => (w.entered(), await o.hold, started), { origin: { plugin: o.by ?? 'engine', tier: 'core' }, signal: new AbortController().signal }))
// The Agent tool's call, as the hook that notes its effort and isolation receives it, over a tool that goes on.
const agentCall = (e: Record<string, unknown>, beneath: () => unknown = () => 'beneath') => find('tool.call', { tool: 'Agent' })($, { tool: 'Agent', prompt: 'p', description: 'd', ...e }, next(beneath))
// Main selected on `fast`, and its turn pinned by a first step, as /model fast and a first main step leave it.
async function mainOnFast(o: Parameters<typeof reset>[0] = {}) {
  reset(o)
  await startSession()
  await find('command.run', { command: 'model' })($, { command: 'model', args: 'fast' }, next(() => { throw new Error('native model must not run') }))
  await drain(find('turn.step', {})($, { turnId: 'm1', index: 0, model: PARENT, messageCount: 1 }, nativeStep()))
  w.klythd.requests.length = 0
}
const system = (n = 0) => (w.klythd.requests[n]?.body as { messages: { content: string }[] }).messages[0]?.content ?? ''
const unrouted = async (id: string) => {
  eq(routed(), [], 'routed members')
  eq((await stepOf(id)).answer, 'native', 'child answer')
  eq(w.klythd.requests.length, 0, 'requests')
}

await scenario("main routed, Agent with no model: the subagent takes main's route, written and persisted, and its steps run on it with its type's prompt", async () => {
  await mainOnFast()
  eq(await agentSpawn(spawnEvent()), { model: PARENT, agentId: 'p1' }, 'the spawn answer')
  eq(routed(), [{ key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'p' } }], 'routed member')
  ok(w.debug.includes('klyth spawn p1 → fast inherited by Explore from main effort=none'), `spawn line missing: ${w.debug.join(' | ')}`)
  eq(w.toasts, [], 'toasts')
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'child answer')
  ok(system().startsWith(EXPLORE_PROMPT.slice(0, 40)) && system().includes(BUILTIN_NOTES) && system().endsWith('running as the Explore subagent via the klyth alias fast.'), `system prompt: ${JSON.stringify(system().slice(0, 60))}`)
  eq(w.klythd.requests[0]?.body['model'], 'model-a', 'request model')
  ok(w.debug.some(l => l.startsWith('klyth req p1 ') && l.includes('tools=2[Read|SubagentHandback]')), `req line missing: ${w.debug.join(' | ')}`)
})

await scenario('main routed: an explicit model, a definition that names a model, and a built-in type that does stay native; a definition with model: inherit and one with none route', async () => {
  await mainOnFast({ files: { '/w/.claude/agents/scout.md': agentFile('scout', 'sonnet'), '/w/.claude/agents/heir.md': agentFile('heir', 'inherit'), '/w/.claude/agents/bare.md': agentFile('bare') } })
  await agentSpawn(spawnEvent({ model: 'haiku' }), { model: 'claude-haiku-5-5', agentId: 'n1' })
  await agentSpawn(spawnEvent({ subagentType: 'scout' }), { model: 'claude-sonnet-5-5', agentId: 'n2' })
  await agentSpawn(spawnEvent({ subagentType: 'scout' }), { model: PARENT, agentId: 'n3' })
  await agentSpawn(spawnEvent({ subagentType: 'statusline-setup' }), { model: PARENT, agentId: 'n4' })
  eq(routed(), [], 'routed members')
  for (const id of ['n1', 'n2', 'n3', 'n4']) eq((await stepOf(id)).answer, 'native', `${id} answer`)
  await agentSpawn(spawnEvent({ subagentType: 'heir' }), { model: PARENT, agentId: 'h1' })
  await agentSpawn(spawnEvent({ subagentType: 'bare' }), { model: PARENT, agentId: 'h2' })
  eq(routed().map(s => [s.id, (s.value as { type: string }).type]), [['h1', 'heir'], ['h2', 'bare']], 'routed members')
  await stepOf('h1')
  ok(system().startsWith('SCOUT BODY\n'), `system prompt: ${JSON.stringify(system().slice(0, 40))}`)
})

await scenario('main native: the spawn is untouched, with no route, no barrier and no log', async () => {
  reset()
  await startSession()
  eq(await agentSpawn(spawnEvent()), { model: PARENT, agentId: 'p1' }, 'the spawn answer')
  eq(w.sets.filter(s => s.key === 'routed'), [], 'routed members')
  ok(!w.debug.some(l => l.startsWith('klyth inherit') || l.startsWith('klyth spawn ')), `log: ${w.debug.join(' | ')}`)
  eq((await stepOf('p1')).answer, 'native', 'child answer')
  eq(w.klythd.requests.length, 0, 'requests')
})

await scenario("the Agent call's effort goes with its subagent to the provider, a call with none carries none", async () => {
  await mainOnFast()
  eq(await agentCall({ tool_use_id: 'u5', effort: 'high' }), 'beneath', 'the Agent call goes on')
  await agentCall({ tool_use_id: 'u6' })
  await agentCall({ tool_use_id: 'u7', effort: 'extreme' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u5' }), { model: PARENT, agentId: 'e1' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u6' }), { model: PARENT, agentId: 'e2' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u7' }), { model: PARENT, agentId: 'e3' })
  eq(routed().map(s => [s.id, (s.value as { effort?: string }).effort ?? 'none']), [['e1', 'high'], ['e2', 'none'], ['e3', 'none']], 'route efforts')
  await stepOf('e1')
  eq(w.klythd.requests[0]?.body['reasoning_effort'], 'high', 'request effort')
})

await scenario("the notes kept for Agent calls hold the latest 64, and a spawn takes its call's note whether it is claimed or passes", async () => {
  await mainOnFast()
  for (let i = 0; i <= 64; i++) await agentCall({ tool_use_id: `c${i}`, effort: 'high' })
  await agentSpawn(spawnEvent({ tool_use_id: 'c0' }), { model: PARENT, agentId: 'k0' })
  await agentSpawn(spawnEvent({ tool_use_id: 'c1' }), { model: PARENT, agentId: 'k1' })
  await agentSpawn(spawnEvent({ tool_use_id: 'c64' }), { model: PARENT, agentId: 'k64' })
  await agentSpawn(spawnEvent({ tool_use_id: 'c1' }), { model: PARENT, agentId: 'k2' })
  await agentSpawn(spawnEvent({ tool_use_id: 'c2', model: 'haiku' }), { model: 'claude-haiku-5-5', agentId: 'k3' })
  await agentSpawn(spawnEvent({ tool_use_id: 'c2' }), { model: PARENT, agentId: 'k4' })
  eq(routed().map(s => [s.id, (s.value as { effort?: string }).effort ?? 'none']), [['k0', 'none'], ['k1', 'high'], ['k64', 'high'], ['k2', 'none'], ['k4', 'none']], 'route efforts')
})

await scenario("a denied or failed Agent call's note goes with the call, an answered call's stays for its spawn", async () => {
  await mainOnFast()
  await agentCall({ tool_use_id: 'u1', effort: 'high' }, () => ({ deny: 'no agents today' }))
  await agentCall({ tool_use_id: 'u2', effort: 'high' }, () => ({ isError: true, result: 'bad input' }))
  await agentCall({ tool_use_id: 'u3', effort: 'high' })
  for (const id of ['u1', 'u2', 'u3']) await agentSpawn(spawnEvent({ tool_use_id: id }), { model: PARENT, agentId: `n-${id}` })
  eq(routed().map(s => [s.id, (s.value as { effort?: string }).effort ?? 'none']), [['n-u1', 'none'], ['n-u2', 'none'], ['n-u3', 'high']], 'route efforts')
})

await scenario('an agent type klyth cannot resolve (no plugin entry, no file, a file named for another agent) stays native and says so; a type it resolves is still claimed', async () => {
  await mainOnFast({ files: { '/w/.claude/agents/mislabeled.md': agentFile('another'), '/w/.claude/agents/bare.md': agentFile('bare') } })
  const types = ['myplug:auditor', 'ghost', 'mislabeled']
  for (const [i, subagentType] of types.entries()) await agentSpawn(spawnEvent({ subagentType }), { model: PARENT, agentId: `g${i}` })
  eq(routed(), [], 'routed members')
  for (const type of types) ok(w.debug.includes(`klyth inherit: ${type} has no readable definition; it stays native`), `line for ${type} missing: ${w.debug.join(' | ')}`)
  ok(!w.debug.some(l => l.startsWith('klyth spawn ')), 'a spawn line was logged')
  for (const i of types.keys()) eq((await stepOf(`g${i}`)).answer, 'native', `g${i} answer`)
  eq(w.klythd.requests.length, 0, 'requests')
  await agentSpawn(spawnEvent({ subagentType: 'bare' }), { model: PARENT, agentId: 'b1' })
  eq(routed().map(s => [s.id, (s.value as { type: string }).type]), [['b1', 'bare']], 'routed members')
})

await scenario("agents are found by the name: of their files, not by file name: two that name one custom agent stay native and say so; one file of another name is claimed with its body, a built-in type's too", async () => {
  await mainOnFast({
    files: {
      '/home/u/.claude/agents/explore-readonly.md': agentFile('Explore', undefined, undefined, 'OVERRIDE'),
      '/w/.claude/agents/scout-new.md': agentFile('scout'),
      '/home/u/.claude/agents/scout.md': agentFile('scout'),
      '/w/.claude/agents/finder-renamed.md': agentFile('finder', undefined, undefined, 'FINDER BODY'),
    },
  })
  await agentSpawn(spawnEvent(), { model: PARENT, agentId: 'o1' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', subagentType: 'scout' }), { model: PARENT, agentId: 'o2' })
  eq(routed().map(s => [s.id, (s.value as { type: string }).type]), [['o1', 'Explore']], 'routed members')
  ok(w.debug.includes('klyth agent-def Explore from /home/u/.claude/agents/explore-readonly.md'), `agent-def line missing: ${w.debug.join(' | ')}`)
  await stepOf('o1')
  ok(system().startsWith('OVERRIDE\n'), `system prompt: ${JSON.stringify(system().slice(0, 40))}`)
  ok(w.debug.includes('klyth inherit: scout has more than one definition (two agent files name it, or klyth could not read them all); it stays native'), `line for scout missing: ${w.debug.join(' | ')}`)
  eq((await stepOf('o2')).answer, 'native', 'o2 answer')
  await agentSpawn(spawnEvent({ tool_use_id: 'u3', subagentType: 'finder' }), { model: PARENT, agentId: 'f1' })
  eq(routed().map(s => [s.id, (s.value as { type: string }).type]), [['o1', 'Explore'], ['f1', 'finder']], 'routed members')
  ok(w.debug.includes('klyth agent-def finder from /w/.claude/agents/finder-renamed.md'), `agent-def line missing: ${w.debug.join(' | ')}`)
  await stepOf('f1')
  ok(system(1).startsWith('FINDER BODY\n'), `system prompt: ${JSON.stringify(system(1).slice(0, 40))}`)
})

await scenario("a parent model the engine spells with a context-size suffix still is the parent's model", async () => {
  await mainOnFast()
  await agentSpawn(spawnEvent({ parentModel: `${PARENT}[1m]` }), { model: PARENT, agentId: 'm1' })
  eq(routed().map(s => s.id), ['m1'], 'routed members')
})

// The worktree the engine makes beneath the spawn of subagent p1 of an isolated Agent call.
const WT = '/w/.claude/worktrees/agent-p1'

await scenario("an isolated Agent call whose worktree the engine made: the subagent is claimed with the worktree as its cwd, in its route and its prompt, klyth leaves the worktree to the engine, and drops it from the route at completion, leaving the mark that it was isolated", async () => {
  await mainOnFast({ files: { [WT]: '' } })
  await agentCall({ tool_use_id: 'u1', isolation: 'worktree' })
  await agentSpawn(spawnEvent())
  eq(routed(), [{ key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'p', worktree: { path: WT, engine: true } } }], 'routed member')
  ok(w.debug.includes(`klyth spawn p1 → fast inherited by Explore from main effort=none cwd=${WT}`), `spawn line missing: ${w.debug.join(' | ')}`)
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'child answer')
  ok(system().includes(`\n - Primary working directory: ${WT}\n`), `system prompt: ${JSON.stringify(system().slice(system().indexOf('# Environment')))}`)
  await complete('p1')
  ok(!w.runs.some(a => a[0] === '/opt/bin/trash' || a.includes('worktree') || a.includes('branch')), `the engine's worktree was touched: ${JSON.stringify(w.runs.filter(a => a[0] === '/opt/bin/trash' || a.includes('worktree')))}`)
  eq(w.toasts, [], 'toasts')
  eq(routed().at(-1), { key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'p', wasIsolated: true } }, 'route after completion')
  eq(routed().length, 2, 'route writes')
})

await scenario('an isolated Agent call whose worktree is not there stays native and says so; a call with no isolation is claimed with the session cwd, though a worktree is there', async () => {
  await mainOnFast({ files: { [WT]: '' } })
  await agentCall({ tool_use_id: 'u1', isolation: 'worktree' })
  await agentSpawn(spawnEvent(), { model: PARENT, agentId: 'p2' })
  ok(w.debug.includes('klyth inherit: the engine made no worktree for p2 (Explore); it stays native'), `line missing: ${w.debug.join(' | ')}`)
  ok(!w.debug.some(l => l.startsWith('klyth spawn ')), 'a spawn line was logged')
  await unrouted('p2')
  await agentCall({ tool_use_id: 'u2' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u2' }), { model: PARENT, agentId: 'p1' })
  eq(routed(), [{ key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'Explore', prompt: 'p' } }], 'routed member')
  await stepOf('p1')
  ok(system().includes('\n - Primary working directory: /w\n'), `system prompt: ${JSON.stringify(system().slice(system().indexOf('# Environment')))}`)
})

await scenario('an Agent call or a definition asking for remote isolation stays native and says so: klyth can reproduce only a worktree', async () => {
  await mainOnFast({ files: { '/w/.claude/agents/faraway.md': agentFile('faraway', undefined, 'remote') } })
  await agentCall({ tool_use_id: 'u1', isolation: 'remote' })
  await agentSpawn(spawnEvent(), { model: PARENT, agentId: 'p1' })
  ok(w.debug.includes('klyth inherit: Explore runs isolated as remote; it stays native'), `line missing: ${w.debug.join(' | ')}`)
  await unrouted('p1')
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', subagentType: 'faraway' }), { model: PARENT, agentId: 'p2' })
  ok(w.debug.includes('klyth inherit: faraway runs isolated as remote; it stays native'), `line missing: ${w.debug.join(' | ')}`)
  await unrouted('p2')
  ok(!w.debug.some(l => l.startsWith('klyth spawn ')), 'a spawn line was logged')
})

await scenario("an agent whose definition says isolation: worktree is claimed with the worktree the engine made as its cwd, in its route and its prompt", async () => {
  await mainOnFast({ files: { '/w/.claude/agents/isolated.md': agentFile('isolated', undefined, 'worktree'), [WT]: '' } })
  await agentSpawn(spawnEvent({ subagentType: 'isolated' }))
  eq(routed(), [{ key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'isolated', prompt: 'p', worktree: { path: WT, engine: true } } }], 'routed member')
  ok(w.debug.includes(`klyth spawn p1 → fast inherited by isolated from main effort=none cwd=${WT}`), `spawn line missing: ${w.debug.join(' | ')}`)
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'child answer')
  ok(system().startsWith('SCOUT BODY\n') && system().includes(`\n - Primary working directory: ${WT}\n`), `system prompt: ${JSON.stringify(system().slice(system().indexOf('# Environment')))}`)
  eq(w.toasts, [], 'toasts')
})

await scenario('an agent whose definition says isolation: worktree stays native and says so when the engine made no worktree; a definition with none is claimed with the session cwd', async () => {
  await mainOnFast({ files: { '/w/.claude/agents/isolated.md': agentFile('isolated', undefined, 'worktree'), '/w/.claude/agents/bare.md': agentFile('bare'), [WT]: '' } })
  await agentSpawn(spawnEvent({ subagentType: 'isolated' }), { model: PARENT, agentId: 'p2' })
  ok(w.debug.includes('klyth inherit: the engine made no worktree for p2 (isolated); it stays native'), `line missing: ${w.debug.join(' | ')}`)
  ok(!w.debug.some(l => l.startsWith('klyth spawn ')), 'a spawn line was logged')
  await unrouted('p2')
  await agentSpawn(spawnEvent({ subagentType: 'bare' }))
  eq(routed().map(s => [s.id, (s.value as { worktree?: unknown }).worktree]), [['p1', undefined]], 'routed members')
  await stepOf('p1')
  ok(system().includes('\n - Primary working directory: /w\n'), `system prompt: ${JSON.stringify(system().slice(system().indexOf('# Environment')))}`)
})

await scenario('a type klyth cannot run stays native and says so; Explore and web-fetch are claimed', async () => {
  await mainOnFast()
  await agentSpawn(spawnEvent({ subagentType: 'comment-thread-analyst' }), { model: PARENT, agentId: 's0' })
  eq(routed(), [], 'routed members')
  ok(w.debug.includes('klyth inherit: comment-thread-analyst is not a type klyth can run; it stays native'), `line missing: ${w.debug.join(' | ')}`)
  eq((await stepOf('s0')).answer, 'native', 's0 answer')
  eq(w.klythd.requests.length, 0, 'requests')
  await agentSpawn(spawnEvent())
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', subagentType: 'web-fetch' }), { model: PARENT, agentId: 'p2' })
  eq(routed().map(s => [s.id, (s.value as { type: string }).type]), [['p1', 'Explore'], ['p2', 'web-fetch']], 'routed members')
})

await scenario("a claude subagent is claimed from its routed parent and sent main's prompt", async () => {
  await mainOnFast()
  await agentSpawn(spawnEvent({ subagentType: 'claude' }))
  eq(routed(), [{ key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'claude', prompt: 'p' } }], 'routed member')
  ok(w.debug.includes('klyth spawn p1 → fast inherited by claude from main effort=none'), `spawn line missing: ${w.debug.join(' | ')}`)
  ok(!w.debug.some(l => l.startsWith('klyth inherit:')), `inherit line: ${w.debug.join(' | ')}`)
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'child answer')
  ok(system().startsWith(`SYS\n\n${BUILTIN_NOTES}\n\n`) && system().endsWith('running as the claude subagent via the klyth alias fast.'), `system prompt: ${JSON.stringify(system().slice(0, 40))}`)
})

await scenario("a subagent of a routed subagent takes its parent's route; one of a native subagent stays native", async () => {
  await mainOnFast()
  await agentSpawn(spawnEvent())
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', parentAgentId: 'p1' }), { model: PARENT, agentId: 'q1' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u3', parentAgentId: 'nat1' }), { model: PARENT, agentId: 'q2' })
  eq(routed().map(s => [s.id, (s.value as { target: string }).target]), [['p1', 'fast'], ['q1', 'fast']], 'routed members')
  ok(w.debug.includes('klyth spawn q1 → fast inherited by Explore from p1 effort=none'), `spawn line missing: ${w.debug.join(' | ')}`)
  eq((await stepOf('q2')).answer, 'native', 'native grandchild answer')
  eq((await stepOf('q1')).answer, 'London is 31°C with light rain.', 'routed grandchild answer')
})

await scenario("a subagent of a routed subagent in a worktree stays native and says so, as does a spawn that sets a cwd; the worktree subagent itself is claimed", async () => {
  await mainOnFast({ files: { [WT]: '' } })
  await agentCall({ tool_use_id: 'u1', isolation: 'worktree' })
  await agentSpawn(spawnEvent())
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', parentAgentId: 'p1' }), { model: PARENT, agentId: 'q1' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u3', cwd: '/elsewhere' }), { model: PARENT, agentId: 'q2' })
  eq(routed().map(s => s.id), ['p1'], 'routed members')
  ok(w.debug.includes('klyth inherit: Explore is spawned by a subagent in a worktree; it stays native'), `line missing: ${w.debug.join(' | ')}`)
  ok(w.debug.includes('klyth inherit: Explore sets its own cwd (/elsewhere); it stays native'), `line missing: ${w.debug.join(' | ')}`)
  for (const id of ['q1', 'q2']) eq((await stepOf(id)).answer, 'native', `${id} answer`)
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'worktree subagent answer')
})

await scenario("a resumed subagent that worked in a worktree the engine has since removed has its plain child left native; the child of one that never did takes its route", async () => {
  await mainOnFast({ files: { [WT]: '' } })
  await agentCall({ tool_use_id: 'u1', isolation: 'worktree' })
  await agentSpawn(spawnEvent())
  await complete('p1')
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', parentAgentId: 'p1' }), { model: PARENT, agentId: 'q1' })
  ok(w.debug.includes('klyth inherit: Explore is spawned by a subagent in a worktree; it stays native'), `line missing: ${w.debug.join(' | ')}`)
  eq(routed().filter(s => s.id === 'q1'), [], 'routed members of the child')
  eq((await stepOf('q1')).answer, 'native', 'child answer')
  await agentSpawn(spawnEvent({ tool_use_id: 'u3' }), { model: PARENT, agentId: 'p2' })
  await complete('p2')
  await agentSpawn(spawnEvent({ tool_use_id: 'u4', parentAgentId: 'p2' }), { model: PARENT, agentId: 'q2' })
  eq(routed().filter(s => s.id === 'q2').map(s => (s.value as { target: string }).target), ['fast'], 'routed members of the second child')
})

await scenario("a subagent the engine put on another model than its parent's stays native and says so; a deny passes through", async () => {
  await mainOnFast()
  await agentSpawn(spawnEvent(), { model: 'claude-sonnet-5-5', agentId: 'd1' })
  ok(w.debug.includes("klyth inherit: the engine resolved claude-sonnet-5-5 for Explore, not its parent's claude-opus-5-5; it stays native"), `line missing: ${w.debug.join(' | ')}`)
  eq(await agentSpawn(spawnEvent(), { deny: 'no agents today' }), { deny: 'no agents today' }, 'a refused spawn')
  await unrouted('d1')
})

for (const [why, e, by] of [
  ['a teammate', { isTeammate: true }, undefined],
  ['a workflow agent', { workflow: { runId: 'wf_1', agentIndex: 1 } }, undefined],
  ["the klyth agent tool's own spawn", {}, 'klyth'],
  ["another plugin's spawn", {}, 'other'],
] as const) {
  await scenario(`main routed: ${why} is not claimed`, async () => {
    await mainOnFast()
    await agentSpawn(spawnEvent(e), { model: PARENT, agentId: 'x1' }, { by })
    await unrouted('x1')
  })
}

await scenario('a spawn held in the engine holds its subagent\'s first step, which then routes', async () => {
  await mainOnFast()
  let release = () => {}
  const hold = new Promise<void>(r => (release = r))
  const inside = new Promise<void>(r => (w.entered = r))
  const waiting = new Promise<void>(r => (w.sleeping = r))
  const call = agentSpawn(spawnEvent(), { model: PARENT, agentId: 'b2' }, { hold })
  await before(inside, call, 'the engine was never asked to start the subagent')
  const early = stepOf('b2')
  await before(waiting, early, 'the child step did not wait for the held spawn')
  release()
  eq((await early).answer, 'London is 31°C with light rain.', 'child answer')
  ok(w.debug.includes('klyth spawn-wait b2 outcome=settled routed=true'), `spawn-wait line missing: ${w.debug.join(' | ')}`)
  await call
})

await scenario('the guard holds an inherited subagent to its type, before and after a hot reload', async () => {
  await mainOnFast()
  await agentSpawn(spawnEvent())
  await stepOf('p1')
  const denied = { deny: 'klyth: Write is not available to the Explore subagent' }
  const guard = (tool: string, agentId: string) => findHook('tool.call', { tool: 'Write' }).hook($, { tool, agentId, tool_use_id: 'u' }, next(() => 'beneath'))
  eq(await guard('Write', 'p1'), denied, 'a tool the step did not offer')
  eq(await guard('Read', 'p1'), 'beneath', 'a tool the step offered')
  registerAgain()
  await startSession()
  eq(await guard('Write', 'p1'), denied, 'a tool its rebuilt set lacks')
  eq(await guard('Read', 'p1'), 'beneath', 'a tool its rebuilt set has')
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'child answer after the reload')
  eq(w.klythd.requests.length, 2, 'requests')
})

// --- a routed subagent's klyth agent call ---------------------------------------------------------------------

const sseOf = (...events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
// A provider's answer that calls the klyth agent tool with `input`.
const callAnswer = (input: Record<string, unknown>) =>
  sseOf(
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'mcp__klyth__agent', arguments: JSON.stringify(input) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    '[DONE]',
  )
// A routed step read to its end: its chunks, and the step's result.
async function chunksFor(event: Record<string, unknown>) {
  const gen = find('turn.step', {})($, event, nativeStep()) as AsyncGenerator<{ kind: string; id?: string; name?: string; json?: string }, StepResult>
  const chunks: { kind: string; id?: string; name?: string; json?: string }[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}
const chunksOf = (agentId: string) => chunksFor(stepEvent(agentId))
const TWO_ALIASES = JSON.stringify({ ...JSON.parse(CONFIG), aliases: { fast: 'acme/model-a', deep: 'acme/model-a' } })
const TOOLS = [{ name: 'Read' }, { name: 'Agent' }, { name: 'mcp__klyth__agent', mcp: true }]
const requestCalls = (n: number) =>
  ((w.klythd.requests[n]?.body as { messages: { role: string; tool_calls?: { function: { name: string; arguments: string } }[] }[] }).messages ?? []).flatMap(m => (m.role === 'assistant' ? (m.tool_calls ?? []) : []))

await scenario("a routed subagent's klyth agent call: its step ends on an Agent call with the call's id; the engine runs it from that subagent, and the child is claimed on the other alias with the subagent as parent, without $.agent.spawn; the subagent's next step shows its own call", async () => {
  let n = 0
  const asked = { model: 'deep', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'Explore', effort: 'high' }
  reset({
    spawnId: 'r1',
    tools: TOOLS,
    files: { '/home/u/.claude/klyth.json': TWO_ALIASES },
    upstream: () => ({ pieces: [n++ === 0 ? callAnswer(asked) : (SSE['model-a-step2.sse'] as string)] }),
  })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  const { chunks, result } = await chunksOf('r1')
  const tool = chunks.find(c => c.kind === 'tool')
  const input = JSON.parse(chunks.find(c => c.kind === 'input')?.json ?? 'null') as Record<string, unknown>
  const id = tool?.id ?? ''
  eq([tool?.name, input], ['Agent', { description: 'Audit', prompt: 'audit the retry code', subagent_type: 'Explore', effort: 'high', run_in_background: false }], "the step's call: a subagent's call waits for the report")
  eq(result.toolUses?.map(u => u.name), ['Agent'], 'the step result')
  ok(id.startsWith('toolu_klyth_'), `call id ${id}`)
  eq(w.sets.filter(s => s.key === 'translated'), [{ key: 'translated', id: 'r1', value: { [id]: 'deep' } }], 'translated calls written')
  // The engine runs the call from r1's loop: the guard, the note, the check, and the spawn.
  const guard = findHook('tool.call', { tool: 'Write' }).hook
  eq(await guard($, { tool: 'Agent', agentId: 'r1', tool_use_id: id }, next(() => 'beneath')), 'beneath', 'the guard lets the Agent call through')
  eq(await agentCall({ tool_use_id: id, agentId: 'r1', ...input }, () => ({ result: 'launched' })), { result: 'launched' }, 'the Agent call goes on')
  const check = findHook('tool.check', { tool: 'Agent' })
  eq(await check.hook($, { tool: 'Agent', input, tool_use_id: id, agentId: 'r1' }, next(() => ({ decision: 'ask', reason: 'classifier' }))), { decision: 'ask', reason: 'classifier' }, 'the check')
  eq(await check.hook($, { tool: 'Agent', input, tool_use_id: 'toolu_other', agentId: 'r1' }, next(() => ({ decision: 'ask' }))), { decision: 'ask' }, 'the check of another call')
  eq(await check.hook($, { tool: 'Agent', input: { ...input, subagent_type: 'fork' }, tool_use_id: 'toolu_nf', agentId: 'r1' }, next(() => ({ decision: 'ask', reason: 'classifier' }))), { decision: 'ask', reason: 'classifier' }, 'the check of a native fork call from a routed subagent')
  const failed = (called: boolean) => Object.assign(next(() => ({ decision: 'ask' })), { called, error: { kind: 'throw', message: 'boom', budget: 1000 } })
  eq(await check.rescue($, { tool: 'Agent', input, tool_use_id: id }, failed(false)), { decision: 'deny', reason: 'klyth: could not check this Agent call, so it was denied; retry, or see the debug log' }, 'a check that failed before next ran')
  eq(await check.rescue($, { tool: 'Agent', input, tool_use_id: id }, failed(true)), { decision: 'ask' }, 'a check that failed after next ran')
  eq(await check.hook($, { tool: 'Agent', input, tool_use_id: id, agentId: 'r1' }, next(() => ({ decision: 'allow', rule: 'Agent' }))), { decision: 'allow', rule: 'Agent' }, 'an explicit permission rule admits the spawn')
  const seen: Record<string, unknown>[] = []
  const core = Object.assign(async (given: Record<string, unknown>) => (seen.push(given), { model: PARENT, agentId: 'c1' }), { origin: { plugin: 'engine', tier: 'core' }, signal: new AbortController().signal })
  eq(await find('agent.spawn', {})($, spawnEvent({ tool_use_id: id, parentAgentId: 'r1', permissionMode: 'auto', prompt: asked.prompt }), core), { model: PARENT, agentId: 'c1' }, 'the spawn answer')
  eq(seen.map(e => [e['model'], e['parentAgentId'], e['permissionMode']]), [[PARENT, 'r1', 'auto']], 'the spawn the engine started')
  eq(w.spawns.length, 1, 'spawns through $.agent.spawn: only the first subagent')
  eq(routed().at(-1), { key: 'routed', id: 'c1', value: { target: 'deep', label: 'deep', type: 'Explore', prompt: asked.prompt, effort: 'high', parent: 'r1' } }, 'the child route')
  ok(w.debug.includes('klyth spawn c1 → deep requested by Explore from r1 effort=high'), `spawn line missing: ${w.debug.join(' | ')}`)
  await stepOf('c1')
  ok(system(1).endsWith('running as the Explore subagent via the klyth alias deep.'), `child system prompt: ${JSON.stringify(system(1).slice(-80))}`)
  w.messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
  ]
  await stepOf('r1')
  eq(requestCalls(2).map(c => [c.function.name, JSON.parse(c.function.arguments)]), [['mcp__klyth__agent', asked]], "the subagent's next request: its call as it made it")
  registerAgain()
  await startSession()
  await stepOf('r1')
  eq(requestCalls(3).map(c => c.function.name), ['mcp__klyth__agent'], 'after a hot reload')
  eq(w.toasts, [], 'toasts')
})

// The engine's messages after routed main's klyth agent call `id` ran as the Agent call `input`, and the step that follows.
const afterCall = (id: string, input: unknown) => [
  { role: 'user', content: [{ type: 'text', text: 'go' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
]
const mainStep = (turnId: string) => drain(find('turn.step', {})($, { turnId, index: 0, model: PARENT, messageCount: 3 }, nativeStep()))
const sentTranscript = () => (w.klythd.wires.findLast(x => 'req' in x) as StepWire).req.transcript

await scenario("routed main's klyth agent call reaches the provider as it was made after a full restart of Claude Code too: the provider's body and the transcript the host sends are unchanged", async () => {
  const asked = { model: 'fast', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'Explore', effort: 'high' }
  const queue: string[] = []
  await mainOnFast({ tools: TOOLS, upstream: () => ({ pieces: [queue.shift() ?? (SSE['model-a-step2.sse'] as string)] }) })
  queue.push(callAnswer(asked))
  const { chunks } = await chunksFor({ turnId: 'm2', index: 0, model: PARENT, messageCount: 1 })
  const id = chunks.find(c => c.kind === 'tool')?.id ?? ''
  eq(chunks.find(c => c.kind === 'tool')?.name, 'Agent', "the step's call")
  w.messages = afterCall(id, JSON.parse(chunks.find(c => c.kind === 'input')?.json ?? 'null'))
  await mainStep('m3')
  const [body, sent] = [w.klythd.requests.at(-1)?.body, sentTranscript()]
  eq(requestCalls(w.klythd.requests.length - 1).map(c => [c.function.name, JSON.parse(c.function.arguments)]), [['mcp__klyth__agent', asked]], "the next request: the call as it was made")
  registerAgain()
  w.state.clear()
  await startSession()
  eq(w.klythd.daemons, 2, 'klythd processes')
  await mainStep('m4')
  eq(w.klythd.requests.at(-1)?.body, body, 'the provider body after the restart')
  eq(sentTranscript(), sent, 'the transcript the host sent after the restart')
})

await scenario("a routed subagent's klyth agent call that cannot become an Agent call stays a klyth agent call and is denied with its reason, and nothing is spawned", async () => {
  reset({ spawnId: 'r1', tools: TOOLS, upstream: () => ({ pieces: [callAnswer({ model: 'zeus', prompt: 'p', description: 'd' })] }) })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  const { chunks } = await chunksOf('r1')
  const tool = chunks.find(c => c.kind === 'tool')
  eq(tool?.name, 'mcp__klyth__agent', "the step's call")
  eq(w.sets.filter(s => s.key === 'translated'), [], 'translated calls written')
  const valid = 'acme/model-a, fable, fast, haiku, opus, sonnet'
  const e = { tool: 'mcp__klyth__agent', tool_use_id: tool?.id ?? '', agentId: 'r1', model: 'zeus', prompt: 'p', description: 'd' }
  const tooled = findHook('tool.call', { tool: 'mcp__klyth__agent' })
  const denied = { deny: `klyth agent: unknown model "zeus"; valid: ${valid}` }
  eq(await tooled.hook($, e, next(() => { throw new Error('the tool must not call next') })), denied, 'the tool')
  const reentry = Object.assign(next(() => 'beneath'), { called: false, error: { kind: 're-entry', budget: 1000 } })
  eq(await tooled.rescue($, e, reentry), denied, 'the tool, raised beneath the spawning hook')
  eq(await tooled.hook($, { ...e, tool_use_id: 'toolu_unseen', model: 'haiku' }, next(() => 'beneath')), { deny: 'klyth agent: not available from a native subagent or from inside a spawn; use Agent here' }, 'a valid call that was not translated')
  eq(w.spawns.length, 1, 'spawns through $.agent.spawn: only the first subagent')
  eq(w.toasts, [], 'toasts')
})

await scenario("a hot reload between a routed subagent's step and the spawn of its klyth agent call loses the note, and the spawn is still claimed on the model its call named, read back from state", async () => {
  const asked = { model: 'deep', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'Explore', effort: 'high' }
  reset({
    spawnId: 'r1',
    tools: TOOLS,
    files: { '/home/u/.claude/klyth.json': TWO_ALIASES },
    upstream: () => ({ pieces: [callAnswer(asked)] }),
  })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  const id = (await chunksOf('r1')).chunks.find(c => c.kind === 'tool')?.id ?? ''
  registerAgain()
  await startSession()
  const { model, ...input } = asked
  await agentCall({ tool_use_id: id, agentId: 'r1', ...input }, () => ({ result: 'launched' }))
  const seen: Record<string, unknown>[] = []
  const core = Object.assign(async (given: Record<string, unknown>) => (seen.push(given), { model: PARENT, agentId: 'c1' }), { origin: { plugin: 'engine', tier: 'core' }, signal: new AbortController().signal })
  await find('agent.spawn', {})($, spawnEvent({ tool_use_id: id, parentAgentId: 'r1', prompt: asked.prompt }), core)
  eq(model, 'deep', 'the model the call named')
  eq(seen.map(e => e['model']), [PARENT], 'the spawn the engine started')
  eq(routed().at(-1), { key: 'routed', id: 'c1', value: { target: 'deep', label: 'deep', type: 'Explore', prompt: asked.prompt, effort: 'high', parent: 'r1' } }, 'the child route')
  eq(w.spawns.length, 1, 'spawns through $.agent.spawn: only the first subagent')
})

await scenario("a spawn asked for on an alias that the engine's slow list holds past the wait: the child's first step hands back one line, never runs native, and the spawn still claims its route", async () => {
  const asked = { prompt: 'audit', description: 'Audit', subagent_type: 'Explore' }
  reset({
    spawnId: 'r1',
    tools: TOOLS,
    files: { '/home/u/.claude/klyth.json': TWO_ALIASES },
    upstream: () => ({ pieces: [callAnswer({ model: 'deep', ...asked })] }),
  })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  const id = (await chunksOf('r1')).chunks.find(c => c.kind === 'tool')?.id ?? ''
  await agentCall({ tool_use_id: id, agentId: 'r1', ...asked })
  let release = () => {}
  w.listGate = new Promise<void>(r => (release = r))
  w.listed = [{ id: 'c1', type: 'Explore' }]
  const inside = new Promise<void>(r => (w.entered = r))
  const waiting = new Promise<void>(r => (w.sleeping = r))
  const spawning = agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', prompt: asked.prompt }), { model: PARENT, agentId: 'c1' })
  await before(inside, spawning, 'the engine was never asked to start the subagent')
  const early = stepOf('c1')
  await before(waiting, early, 'the child step did not wait for the spawn')
  w.elapse()
  const stepped = await early
  eq(stepped.toolUses?.map(u => [u.name, u.input.message]), [['SubagentHandback', 'klyth agent: the subagent on deep was still starting, so this step was not run; retry']], 'the child step')
  eq(w.klythd.requests.length, 1, 'requests: only the first subagent step')
  release()
  await spawning
  eq(routed().at(-1), { key: 'routed', id: 'c1', value: { target: 'deep', label: 'deep', type: 'Explore', prompt: asked.prompt, parent: 'r1' } }, 'the child route')
})

await scenario("an unrelated native subagent whose first step waits out a requested spawn's slow claim runs native, as before; the requested child alone is refused", async () => {
  const asked = { prompt: 'audit', description: 'Audit', subagent_type: 'Explore' }
  reset({
    spawnId: 'r1',
    tools: TOOLS,
    files: { '/home/u/.claude/klyth.json': TWO_ALIASES },
    upstream: () => ({ pieces: [callAnswer({ model: 'deep', ...asked })] }),
  })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  const id = (await chunksOf('r1')).chunks.find(c => c.kind === 'tool')?.id ?? ''
  await agentCall({ tool_use_id: id, agentId: 'r1', ...asked })
  let release = () => {}
  w.listGate = new Promise<void>(r => (release = r))
  w.listed = [{ id: 'c1', type: 'Explore' }]
  const inside = new Promise<void>(r => (w.entered = r))
  const waiting = new Promise<void>(r => (w.sleeping = r))
  const spawning = agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', prompt: asked.prompt }), { model: PARENT, agentId: 'c1' })
  await before(inside, spawning, 'the engine was never asked to start the subagent')
  const early = stepOf('n1')
  await before(waiting, early, 'the native step did not wait for the spawn')
  w.elapse()
  eq((await early).answer, 'native', "the native child's step")
  eq(w.klythd.requests.length, 1, 'requests: only the first subagent step')
  release()
  await spawning
  eq(routed().at(-1), { key: 'routed', id: 'c1', value: { target: 'deep', label: 'deep', type: 'Explore', prompt: asked.prompt, parent: 'r1' } }, 'the child route')
})

await scenario("an inherited spawn held past the wait by the engine's slow list keeps today's way: the child's first step runs native", async () => {
  await mainOnFast()
  let release = () => {}
  w.listGate = new Promise<void>(r => (release = r))
  w.listed = [{ id: 'p1', type: 'Explore' }]
  const inside = new Promise<void>(r => (w.entered = r))
  const waiting = new Promise<void>(r => (w.sleeping = r))
  const spawning = agentSpawn(spawnEvent())
  await before(inside, spawning, 'the engine was never asked to start the subagent')
  const early = stepOf('p1')
  await before(waiting, early, 'the child step did not wait for the spawn')
  w.elapse()
  eq((await early).answer, 'native', 'the child step')
  eq(w.klythd.requests.length, 0, 'requests')
  release()
  await spawning
})

await scenario("a klyth agent call for a built-in type with no prompt of its own, for claude, and for a custom type with no definition, gives the same routed subagent from main's tool and from a routed subagent's translated call: the generic, main's and the general-purpose prompts", async () => {
  const queue: string[] = []
  reset({
    spawnId: 'd1',
    tools: TOOLS,
    upstream: () => ({ pieces: [queue.shift() ?? (SSE['model-a-step2.sse'] as string)] }),
  })
  await startSession()
  const types = ['web-fetch', 'claude', 'auditor']
  // main's tool: d1, d2 and d3 (requests 0, 1 and 2)
  for (const [i, subagent_type] of types.entries()) {
    w.spawnId = `d${i + 1}`
    await wrap({ subagent_type })
    await stepOf(`d${i + 1}`)
  }
  // a routed subagent's calls, made Agent calls and spawned by the engine: c1, c2 and c3 (requests 4, 6 and 8)
  w.spawnId = 'r1'
  await wrap({ subagent_type: 'general-purpose' })
  for (const [i, subagent_type] of types.entries()) {
    queue.push(callAnswer({ model: 'fast', prompt: 'p', description: 'd', subagent_type }))
    const id = (await chunksOf('r1')).chunks.find(c => c.kind === 'tool')?.id ?? ''
    await agentCall({ tool_use_id: id, agentId: 'r1', prompt: 'p', description: 'd', subagent_type })
    await agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', subagentType: subagent_type }), { model: PARENT, agentId: `c${i + 1}` })
    await stepOf(`c${i + 1}`)
  }
  eq(routed().filter(r => r.id?.startsWith('c')).map(r => [r.id, (r.value as { target: string; type: string }).target, (r.value as { type: string }).type]), [['c1', 'fast', 'web-fetch'], ['c2', 'fast', 'claude'], ['c3', 'fast', 'auditor']], 'translated routes')
  ok(system(0).startsWith('You are a subagent inside a coding session'), `web-fetch prompt: ${JSON.stringify(system(0).slice(0, 60))}`)
  ok(system(1).startsWith(`SYS\n\n${BUILTIN_NOTES}\n\n`) && system(1).endsWith('running as the claude subagent via the klyth alias fast.'), `claude prompt: ${JSON.stringify(system(1).slice(0, 40))}`)
  ok(system(2).startsWith(GENERAL_PURPOSE_PROMPT) && system(2).endsWith('running as the auditor subagent via the klyth alias fast.'), `auditor prompt: ${JSON.stringify(system(2).slice(-70))}`)
  for (const [i, type] of types.entries()) eq(system(4 + 2 * i), system(i), `${type}: translated and direct prompts`)
})

await scenario("a nested restricted chain: a routed custom agent with no Bash starts a child through the klyth agent tool; the child's request offers no Bash, its Bash call is denied, and so it is after a hot reload", async () => {
  const asked = { model: 'deep', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'general-purpose' }
  let n = 0
  const scout = '---\nname: scout\ndescription: d\ntools: Read, Agent, mcp__klyth__agent\n---\nSCOUT BODY'
  reset({
    spawnId: 'r1',
    tools: [{ name: 'Read' }, { name: 'Bash' }, { name: 'Agent' }, { name: 'mcp__klyth__agent', mcp: true }],
    files: { '/home/u/.claude/klyth.json': TWO_ALIASES, '/w/.claude/agents/scout.md': scout },
    upstream: () => ({ pieces: [n++ === 0 ? callAnswer(asked) : (SSE['model-a-step2.sse'] as string)] }),
  })
  await startSession()
  await wrap({ subagent_type: 'scout' })
  const offeredIn = (i: number) => (w.klythd.requests[i]?.body as { tools?: { function: { name: string } }[] }).tools?.map(x => x.function.name)
  const { chunks } = await chunksOf('r1')
  const id = chunks.find(c => c.kind === 'tool')?.id ?? ''
  const input = JSON.parse(chunks.find(c => c.kind === 'input')?.json ?? 'null') as Record<string, unknown>
  eq(offeredIn(0), ['Read', 'Agent', 'mcp__klyth__agent', 'SubagentHandback'], "the scout's request: no Bash")
  await agentCall({ tool_use_id: id, agentId: 'r1', ...input })
  await agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', subagentType: 'general-purpose', prompt: asked.prompt }), { model: PARENT, agentId: 'c1' })
  eq(routed().at(-1), { key: 'routed', id: 'c1', value: { target: 'deep', label: 'deep', type: 'general-purpose', prompt: asked.prompt, parent: 'r1' } }, 'the child route')
  await stepOf('c1')
  eq(offeredIn(1), ['Read', 'Agent', 'mcp__klyth__agent', 'SubagentHandback'], "the child's request: no Bash, though its type allows it")
  const guard = (tool: string, agentId: string) => findHook('tool.call', { tool }).hook($, { tool, agentId, tool_use_id: 'u' }, next(() => 'beneath'))
  const denied = { deny: 'klyth: Bash is not available to the general-purpose subagent' }
  eq(await guard('Bash', 'c1'), denied, "the child's Bash call")
  eq(await guard('Read', 'c1'), 'beneath', "the child's Read call")
  registerAgain()
  await startSession()
  eq(await guard('Bash', 'c1'), denied, "the child's Bash call, its set rebuilt from state through the scout's route")
  eq(await guard('Read', 'c1'), 'beneath', "the child's Read call, its set rebuilt from state")
})

// --- the same call from either path -------------------------------------------------------------------------

await scenario("the same klyth agent call gets the same answer from a native main's tool and from a routed subagent's translated call: a type klyth cannot run, a built-in type two agent files name, and one whose file isolates it elsewhere", async () => {
  const queue: string[] = []
  const file = (name: string, extra = '') => `---\nname: ${name}\ndescription: d\n${extra}---\nBODY`
  reset({
    spawnId: 'r1',
    tools: TOOLS,
    files: { '/w/.claude/agents/a.md': file('Explore'), '/home/u/.claude/agents/b.md': file('Explore'), '/w/.claude/agents/p.md': file('Plan', 'isolation: remote\n') },
    upstream: () => ({ pieces: [queue.shift() ?? (SSE['model-a-step2.sse'] as string)] }),
  })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  for (const subagent_type of ['comment-thread-analyst', 'Explore', 'Plan']) {
    const direct = await wrap({ subagent_type })
    ok(typeof (direct as { deny?: string }).deny === 'string' && (direct as { deny: string }).deny.includes(`${subagent_type} `), `${subagent_type}: the direct call was not denied for its type: ${canon(direct)}`)
    queue.push(callAnswer({ model: 'fast', prompt: 'p', description: 'd', subagent_type }))
    const id = (await chunksOf('r1')).chunks.find(c => c.kind === 'tool')?.id ?? ''
    await agentCall({ tool_use_id: id, agentId: 'r1', prompt: 'p', description: 'd', subagent_type })
    const translated = await agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', subagentType: subagent_type }), { model: PARENT, agentId: `c-${subagent_type}` })
    eq(translated, direct, `${subagent_type}: the translated call and the direct call`)
  }
  eq(w.spawns.length, 1, 'spawns through $.agent.spawn: only the first subagent')
})

// --- forks -------------------------------------------------------------------------------------------------

// The turns every conversation reads back below: Agent calls u1 and u2 (the calls that start the forks) and their results.
const FORKED = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Agent', input: {} }, { type: 'tool_use', id: 'u2', name: 'Agent', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'started' }, { type: 'tool_result', tool_use_id: 'u2', content: 'started' }] },
]
// The same turns for a conversation whose engine delivers a subagent's report through SubagentHandback.
const FORKED_SAID = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, HANDBACK_REMINDER] }, ...FORKED.slice(1)]
const requestTools = (n: number) => ((w.klythd.requests[n]?.body['tools'] as { function: { name: string } }[] | undefined) ?? []).map(t => t.function.name)

await scenario("main routed: a fork is claimed on main's alias with the call that started it, and sent main's prompt and main's history joined to its own turn, which says how a fork reports; it is offered no SubagentHandback", async () => {
  // The fork's own read holds only its task, so the joining turn is built from main's turn after the cut (`after`).
  await mainOnFast({ messages: id => (id === 'p1' ? [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] : FORKED) })
  await agentSpawn(spawnEvent({ subagentType: 'fork', fork: true, model: 'sonnet' }))
  eq(routed(), [{ key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'fork', prompt: 'p', forkOf: 'u1' } }], 'routed member')
  ok(w.debug.includes('klyth spawn p1 → fast inherited by fork from main effort=none'), `spawn line missing: ${w.debug.join(' | ')}`)
  ok(!w.debug.some(l => l.startsWith('klyth inherit:')), `inherit line: ${w.debug.join(' | ')}`)
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'child answer')
  eq(system(), 'SYS', 'system prompt')
  const sent = JSON.stringify(w.klythd.requests[0]?.body['messages'])
  ok(sent.includes(JSON.stringify(FORK_REPORT).slice(1, -1)) && sent.includes('"hi"'), `fork messages: ${sent.slice(0, 300)}`)
  const joining = (w.klythd.requests[0]?.body['messages'] as { role: string; content?: unknown }[]).filter(m => m.role === 'tool').map(m => m.content)
  eq(joining, ['The fork started and runs in the background.', 'started'], "the joining turn answers the fork's own call as started, not with the acknowledgement main's turn holds, and a sibling call from main's next turn")
  ok(!requestTools(0).includes('SubagentHandback'), `fork tools: ${requestTools(0).join('|')}`)
})

await scenario("a fork of a routed main after a hot reload: its route and the call that started it are read from state, and main's history up to that call is sent as main's own request sends it", async () => {
  await mainOnFast({ messages: FORKED })
  await agentSpawn(spawnEvent({ subagentType: 'fork', fork: true }))
  registerAgain()
  await startSession()
  await drain(find('turn.step', {})($, { turnId: 'm2', index: 0, model: PARENT, messageCount: 3 }, nativeStep()))
  eq((await stepOf('p1')).answer, 'London is 31°C with light rain.', 'fork answer after the reload')
  const [main, fork] = [0, 1].map(n => (w.klythd.requests[n]?.body as { messages: unknown[] }).messages)
  eq(fork?.slice(1, 3), main?.slice(1, 3), "the fork's history is main's, as main's request sends it")
})

await scenario("a fork of routed main is sent main's klyth agent call as main made it", async () => {
  const asked = { model: 'fast', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'Explore' }
  const queue: string[] = []
  let main: unknown[] = []
  await mainOnFast({ tools: TOOLS, upstream: () => ({ pieces: [queue.shift() ?? (SSE['model-a-step2.sse'] as string)] }), messages: id => (id === 'p1' ? [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] : main) })
  queue.push(callAnswer(asked))
  const { chunks } = await chunksFor({ turnId: 'm2', index: 0, model: PARENT, messageCount: 1 })
  main = [...afterCall(chunks.find(c => c.kind === 'tool')?.id ?? '', JSON.parse(chunks.find(c => c.kind === 'input')?.json ?? 'null')), ...FORKED.slice(1)]
  await agentSpawn(spawnEvent({ subagentType: 'fork', fork: true }))
  await stepOf('p1')
  eq(requestCalls(1).map(c => c.function.name), ['mcp__klyth__agent', 'Agent', 'Agent'], "the fork's request: main's calls up to the one that started it")
  eq(JSON.parse(requestCalls(1)[0]?.function.arguments ?? 'null'), asked, "main's klyth agent call as main made it")
})

await scenario("a fork of a routed subagent is claimed with the subagent as parent and sent the prompt the subagent is sent, told to end on its report instead of SubagentHandback; one of a native main or subagent stays native", async () => {
  await mainOnFast({ messages: FORKED_SAID })
  await agentSpawn(spawnEvent())
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', subagentType: 'fork', fork: true, parentAgentId: 'p1' }), { model: PARENT, agentId: 'q1' })
  eq(routed().map(s => [s.id, (s.value as { target: string; type: string; parent?: string }).type, (s.value as { parent?: string }).parent]), [['p1', 'Explore', undefined], ['q1', 'fork', 'p1']], 'routed members')
  await stepOf('p1')
  await stepOf('q1')
  ok(system(0).includes(HANDBACK_GUIDANCE), "the parent's prompt says how to hand back")
  eq(system(1), system(0).replace(`${HANDBACK_GUIDANCE}\n\n`, ''), "the fork's prompt is its parent's less the handback guidance")
  ok(JSON.stringify(w.klythd.requests[1]?.body['messages']).includes(JSON.stringify(FORK_REPORT).slice(1, -1)), "the fork is told how it reports in its messages")
  ok(requestTools(0).includes('SubagentHandback') && !requestTools(1).includes('SubagentHandback'), `tools: ${requestTools(0).join('|')} / ${requestTools(1).join('|')}`)
  ok(system(1).endsWith('running as the Explore subagent via the klyth alias fast.'), `fork prompt: ${JSON.stringify(system(1).slice(-70))}`)
  reset()
  await startSession()
  // A native main's first step pins its turn as native, as every main turn's first step does.
  await drain(find('turn.step', {})($, { turnId: 'm1', index: 0, model: PARENT, messageCount: 1 }, nativeStep()))
  await agentSpawn(spawnEvent({ subagentType: 'fork', fork: true }), { model: PARENT, agentId: 'n1' })
  await agentSpawn(spawnEvent({ tool_use_id: 'u2', subagentType: 'fork', fork: true, parentAgentId: 'nat1' }), { model: PARENT, agentId: 'n2' })
  eq(routed(), [], 'routed members of forks of native parents')
  eq((await stepOf('n1')).answer, 'native', 'native fork answer')
  eq(w.debug.filter(l => l.startsWith('klyth inherit:') || l.startsWith('klyth spawn')), [], 'klyth says nothing')
})

await scenario("a klyth agent call for a fork: from a native main it is denied (Agent forks natively); from a routed subagent it runs on the subagent's alias, named or not, and any other alias is denied", async () => {
  const queue: string[] = []
  reset({ spawnId: 'r1', tools: TOOLS, files: { '/home/u/.claude/klyth.json': TWO_ALIASES }, upstream: () => ({ pieces: [queue.shift() ?? (SSE['model-a-step2.sse'] as string)] }) })
  await startSession()
  const denied = "klyth agent: a fork runs on its parent's model, and this conversation is native; to fork natively use Agent"
  eq(await wrap({ subagent_type: 'fork', model: 'fast' }), { deny: denied }, 'a native main, named')
  eq(await wrap({ subagent_type: 'fork', model: undefined }), { deny: denied }, 'a native main, unnamed')
  eq(w.spawns.length, 0, 'spawns')
  await wrap({ subagent_type: 'general-purpose' })
  const tooled = findHook('tool.call', { tool: 'mcp__klyth__agent' })
  queue.push(callAnswer({ model: 'deep', prompt: 'p', description: 'd', subagent_type: 'fork' }))
  const other = (await chunksOf('r1')).chunks.find(c => c.kind === 'tool')
  eq(other?.name, 'mcp__klyth__agent', 'a fork on another alias stays a klyth agent call')
  eq(
    await tooled.hook($, { tool: 'mcp__klyth__agent', tool_use_id: other?.id ?? '', agentId: 'r1', model: 'deep', prompt: 'p', description: 'd', subagent_type: 'fork' }, next(() => 'beneath')),
    { deny: "klyth agent: a fork runs on its parent's model (fast), not on deep; omit model, or name fast" },
    'the tool',
  )
  for (const [i, model] of [undefined, 'fast'].entries()) {
    queue.push(callAnswer({ ...(model === undefined ? {} : { model }), prompt: 'p', description: 'd', subagent_type: 'fork' }))
    const { chunks } = await chunksOf('r1')
    const id = chunks.find(c => c.kind === 'tool')?.id ?? ''
    const input = JSON.parse(chunks.find(c => c.kind === 'input')?.json ?? 'null') as Record<string, unknown>
    eq([chunks.find(c => c.kind === 'tool')?.name, input], ['Agent', { description: 'd', prompt: 'p', subagent_type: 'fork', run_in_background: false }], 'the Agent call of a fork')
    await agentCall({ tool_use_id: id, agentId: 'r1', ...input })
    await agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', subagentType: 'fork', fork: true, prompt: 'p' }), { model: PARENT, agentId: `c${i + 1}` })
    eq(routed().at(-1), { key: 'routed', id: `c${i + 1}`, value: { target: 'fast', label: 'fast', type: 'fork', prompt: 'p', parent: 'r1', forkOf: id } }, 'the fork route')
    ok(w.debug.includes(`klyth spawn c${i + 1} → fast requested by fork from r1 effort=none`), `spawn line missing: ${w.debug.join(' | ')}`)
  }
  eq(w.spawns.length, 1, 'spawns through $.agent.spawn: only the first subagent')
})

await scenario("a fork of a routed main whose claim the engine's slow list holds past the wait: its first step hands back one line, never runs native, and the spawn still claims its route", async () => {
  await mainOnFast()
  let release = () => {}
  w.listGate = new Promise<void>(r => (release = r))
  w.listed = [{ id: 'p1', type: 'fork' }]
  const inside = new Promise<void>(r => (w.entered = r))
  const waiting = new Promise<void>(r => (w.sleeping = r))
  const spawning = agentSpawn(spawnEvent({ subagentType: 'fork', fork: true }))
  await before(inside, spawning, 'the engine was never asked to start the fork')
  const early = stepOf('p1')
  await before(waiting, early, 'the fork step did not wait for the claim')
  w.elapse()
  const stepped = await early
  // A fork is offered no SubagentHandback, so the refusal is its answer: its final message.
  eq([stepped.answer, stepped.toolUses ?? []], ['klyth: this fork of a conversation on fast was still being claimed, so its step was not run natively; retry', []], 'the fork step')
  eq(w.klythd.requests.length, 0, 'requests')
  release()
  await spawning
  eq(routed().at(-1), { key: 'routed', id: 'p1', value: { target: 'fast', label: 'fast', type: 'fork', prompt: 'p', forkOf: 'u1' } }, 'the fork route')
})

await scenario("a fork of a routed main whose spawn the engine holds past the wait, its id not yet known: a step the engine lists as a fork is refused, and one it lists as another type runs native as before", async () => {
  await mainOnFast()
  let release = () => {}
  const hold = new Promise<void>(r => (release = r))
  w.listed = [{ id: 'p1', type: 'fork' }, { id: 'n1', type: 'Explore' }]
  const inside = new Promise<void>(r => (w.entered = r))
  const spawning = agentSpawn(spawnEvent({ subagentType: 'fork', fork: true }), { model: PARENT, agentId: 'p1' }, { hold })
  await before(inside, spawning, 'the engine was never asked to start the fork')
  for (const [id, expected] of [['p1', 'klyth: this fork of a conversation on fast was still being claimed, so its step was not run natively; retry'], ['n1', 'native']] as const) {
    const waiting = new Promise<void>(r => (w.sleeping = r))
    const early = stepOf(id)
    await before(waiting, early, `the step of ${id} did not wait for the claim`)
    w.elapse()
    const stepped = await early
    eq(stepped.toolUses?.[0]?.name ?? stepped.answer, expected, `the step of ${id}`)
  }
  eq(w.klythd.requests.length, 0, 'requests')
  release()
  await spawning
})

await scenario("a klyth agent call that spells a known type in another case runs as that type from either path: main's tool resolves it as the engine resolves the Agent call it becomes in a routed subagent", async () => {
  const queue: string[] = []
  reset({ spawnId: 'd1', tools: TOOLS, upstream: () => ({ pieces: [queue.shift() ?? (SSE['model-a-step2.sse'] as string)] }) })
  await startSession()
  eq(await wrap({ subagent_type: 'explore' }), { result: LAUNCH('fast', 'acme/model-a', 'd1') }, 'the direct call')
  eq(w.spawns.at(-1)?.['subagentType'], 'Explore', 'the type the direct spawn names')
  await stepOf('d1')
  w.spawnId = 'r1'
  await wrap({ subagent_type: 'general-purpose' })
  queue.push(callAnswer({ model: 'fast', prompt: 'p', description: 'd', subagent_type: 'EXPLORE' }))
  const { chunks } = await chunksOf('r1')
  const id = chunks.find(c => c.kind === 'tool')?.id ?? ''
  await agentCall({ tool_use_id: id, agentId: 'r1', prompt: 'p', description: 'd', subagent_type: 'EXPLORE' })
  await agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', subagentType: 'Explore' }), { model: PARENT, agentId: 'c1' })
  await stepOf('c1')
  eq(routed().filter(r => r.id === 'd1' || r.id === 'c1').map(r => [r.id, (r.value as { type: string }).type]), [['d1', 'Explore'], ['c1', 'Explore']], 'the types of both routes')
  eq(system(2), system(0), 'the translated and direct prompts')
  ok(system(0).startsWith(EXPLORE_PROMPT.slice(0, 40)), `the Explore prompt: ${JSON.stringify(system(0).slice(0, 60))}`)
})

await scenario("main's own spawn that the engine lists as another type than the one resolved is not run on that type's prompt: its first step hands the reason back", async () => {
  reset({ spawnId: 'd1' })
  await startSession()
  w.listed = [{ id: 'd1', type: 'Plan' }]
  eq(await wrap({ subagent_type: 'Explore' }), { result: LAUNCH('fast', 'acme/model-a', 'd1') }, 'the direct call')
  const stepped = await stepOf('d1')
  eq(stepped.toolUses?.map(u => u.input.message), ['klyth agent: the engine started Explore as Plan, so klyth did not run it on fast; retry'], 'the first step')
  eq(w.klythd.requests.length, 0, 'requests')
})

// --- the classifier on a routed subagent's refusal ---------------------------------------------------------------

// The config with the classifier on (`classifier`) over `base`, and a provider that answers every request with an allow.
const classifying = (classifier: Record<string, unknown> = {}, base = CONFIG) => ({
  files: { '/home/u/.claude/klyth.json': JSON.stringify({ ...JSON.parse(base), classifier }) },
  upstream: () => ({ pieces: [SSE['classifier-allow.sse'] as string] }),
})
const TASK = 'Fix the README typo.'
const EDIT = { file_path: '/w/README.md', old_string: 'teh', new_string: 'the' }
const AS_REQUEST = 'The task this subagent was given, checked when it was spawned, a request of its own, as one JSON string:'
// The engine's refusal of the subagent `agentId`'s call `id` for want of auto mode's verdict, in `cwd`.
const refuse = async (tool: string, input: Record<string, unknown>, id: string, agentId: string, cwd = '/w') => {
  await find('tool.check', { tool })($, { tool, input, tool_use_id: id, agentId }, next(() => ({ decision: 'ask' })))
  return find('classic.PermissionDenied', {})($, denied(tool, input, id, { agent_id: agentId, cwd }), next(() => ({})))
}
// The classifier requests sent; and a request's last text: the fresh context's one message, or the fork context's question.
const classifierReqs = () => w.klythd.wires.flatMap(x => ((x as StepWire).req?.who.startsWith('classifier:') ? [(x as StepWire).req] : []))
const questionOf = (req: StepRequest | undefined) => ((req?.transcript.at(-1)?.content ?? []) as readonly { text?: string }[]).at(-1)?.text ?? ''
// Whether the classifier was told `task` is a request of the subagent's, or was shown it as data only.
const asRequest = (text: string, task: string) => text.includes(`${AS_REQUEST}\n${JSON.stringify(task)}\n`) || text.includes(`"spawnTask":${JSON.stringify(task)}`)
const asData = (text: string, task: string) => !text.includes(AS_REQUEST) && !text.includes('"spawnTask"') && text.includes(`"subagentTask":${JSON.stringify(task)}`)

for (const context of ['fresh', 'fork'] as const) {
  await scenario(`a native main's own klyth agent call vets its subagent's task: the ${context} classifier counts it among the person's requests, under the rules that let it call for actions`, async () => {
    reset({ spawnId: 'r1', ...classifying({ context }) })
    await startSession()
    await wrap({ prompt: TASK })
    await stepOf('r1')
    eq(await refuse('Edit', EDIT, 'toolu_klyth_1', 'r1'), { retry: true }, 'the refusal')
    const [req] = classifierReqs()
    const text = questionOf(req)
    ok(asRequest(text, TASK) && !text.includes('subagentTask'), `the request: ${text}`)
    ok((context === 'fresh' ? (req?.system ?? '') : text).includes("when the person's requests, or the task this subagent was given (checked when it was spawned), authorise the action or an ordinary, bounded step to carry them out"), `the rules: ${req?.system ?? text}`)
  })
}

await scenario("a subagent's end forgets that its spawn was vetted: a refusal after it (a resumed subagent) quotes its task as data", async () => {
  reset({ spawnId: 'r1', ...classifying() })
  await startSession()
  await wrap({ prompt: TASK })
  eq(await refuse('Edit', EDIT, 'toolu_klyth_1', 'r1'), { retry: true }, 'the refusal before the end')
  await complete('r1')
  eq(await refuse('Write', { file_path: '/w/a.md', content: 'x' }, 'toolu_klyth_2', 'r1'), { retry: true }, 'the refusal after it')
  const [before, after] = classifierReqs().map(questionOf)
  ok(asRequest(before ?? '', TASK), `before: ${before}`)
  ok(asData(after ?? '', TASK), `after: ${after}`)
})

await scenario('a klyth agent call under an id a routed step minted, or one another plugin made, does not vet its subagent\'s task: it is data', async () => {
  reset(classifying())
  await startSession()
  await wrap({ prompt: TASK, tool_use_id: 'toolu_klyth_m' })
  const byPlugin = Object.assign(next(() => ({})), { origin: { plugin: 'other', tier: 'user' } })
  await find('tool.call', { tool: 'mcp__klyth__agent' })($, { tool: 'mcp__klyth__agent', tool_use_id: 't2', model: 'fast', prompt: TASK, description: 'd', subagent_type: 'Explore' }, byPlugin)
  for (const [i, who] of ['id1', 'id2'].entries()) eq(await refuse('Edit', EDIT, `toolu_klyth_${i + 1}`, who), { retry: true }, `the refusal in ${who}`)
  eq(classifierReqs().length, 2, 'classifier requests')
  for (const text of classifierReqs().map(questionOf)) ok(asData(text, TASK), `the request: ${text}`)
})

await scenario("route metadata grants no permission or vetted task: translated Agent calls and forks keep a plain ask, and an external permission rule admits their spawns", async () => {
  const asked = { model: 'deep', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'Explore' }
  const forked = { description: 'Again', prompt: 'look again', subagent_type: 'fork' }
  let n = 0
  reset({ spawnId: 'r1', tools: TOOLS, ...classifying({}, TWO_ALIASES), upstream: () => ({ pieces: [n++ === 0 ? callAnswer(asked) : (SSE['classifier-allow.sse'] as string)] }) })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  const { chunks } = await chunksOf('r1')
  const id = chunks.find(c => c.kind === 'tool')?.id ?? ''
  const input = JSON.parse(chunks.find(c => c.kind === 'input')?.json ?? 'null') as Record<string, unknown>
  const check = findHook('tool.check', {}).hook
  eq(await check($, { tool: 'Agent', input, tool_use_id: id, agentId: 'r1' }, next(() => ({ decision: 'ask' }))), { decision: 'ask' }, 'the check of the call klyth made')
  eq(await check($, { tool: 'Agent', input: forked, tool_use_id: 'toolu_klyth_f', agentId: 'r1' }, next(() => ({ decision: 'ask' }))), { decision: 'ask' }, 'the check of the fork')
  for (const [callId, args] of [[id, input], ['toolu_klyth_f', forked]]) {
    const rule = { decision: 'allow', rule: 'Agent' }
    eq(await check($, { tool: 'Agent', input: args, tool_use_id: callId, agentId: 'r1' }, next(() => rule)), rule, 'external permission rule stands unchanged')
  }
  await agentSpawn(spawnEvent({ tool_use_id: id, parentAgentId: 'r1', prompt: asked.prompt }), { model: PARENT, agentId: 'c1' })
  await agentSpawn(spawnEvent({ tool_use_id: 'toolu_klyth_f', parentAgentId: 'r1', prompt: forked.prompt, subagentType: 'fork', fork: true }), { model: PARENT, agentId: 'f1' })
  eq(routed().slice(-2).map(s => s.id), ['c1', 'f1'], 'the children claimed')
  eq(await refuse('Edit', EDIT, 'toolu_klyth_c', 'c1'), { retry: true }, "the klyth-made child's refusal")
  eq(await refuse('Edit', EDIT, 'toolu_klyth_g', 'f1'), { retry: true }, "the fork's refusal")
  const [made, fork] = classifierReqs().map(questionOf)
  ok(asData(made ?? '', asked.prompt), `the klyth-made child: ${made}`)
  ok(asData(fork ?? '', forked.prompt), `the fork: ${fork}`)
})

const SPAWN = { description: 'Audit', prompt: 'audit the retry code', subagent_type: 'Explore' }
// r1, which a native main started on TASK, refuses an Agent spawn of SPAWN, which the `context` classifier allows; the
// re-issued call spends the allow in r1's next step, and the engine starts c1 with `prompt`. c1's refusal is classified too.
// The questions the classifier was asked: r1's, then c1's.
async function allowedChild(context: 'fresh' | 'fork', prompt = SPAWN.prompt) {
  reset({ spawnId: 'r1', tools: TOOLS, ...classifying({ tools: 'all', context }) })
  await startSession()
  await wrap({ prompt: TASK, subagent_type: 'general-purpose' })
  await stepOf('r1')
  eq(await refuse('Agent', SPAWN, 'toolu_klyth_a1', 'r1'), { retry: true }, "the classifier allows r1's spawn")
  await stepOf('r1')
  const check = findHook('tool.check', {}).hook
  eq(await check($, { tool: 'Agent', input: SPAWN, tool_use_id: 'toolu_klyth_a2', agentId: 'r1' }, next(() => ({ decision: 'ask' }))), { decision: 'allow', reason: 'klyth classifier: allowed this call' }, 'the re-issued call spends the allow')
  eq(await agentCall({ tool_use_id: 'toolu_klyth_a2', agentId: 'r1', ...SPAWN }, () => ({ result: 'launched' })), { result: 'launched' }, 'the Agent call goes on')
  await agentSpawn(spawnEvent({ tool_use_id: 'toolu_klyth_a2', parentAgentId: 'r1', prompt }), { model: PARENT, agentId: 'c1' })
  await stepOf('c1')
  eq(await refuse('Edit', EDIT, 'toolu_klyth_c', 'c1'), { retry: true }, "the child's refusal")
  return classifierReqs().map(questionOf)
}

await scenario("an Agent spawn whose call spent a fresh classifier's allow is vetted: its subagent counts its own task as a request, never its parent's", async () => {
  const [parent = '', child = ''] = await allowedChild('fresh')
  ok(asRequest(parent, TASK), `r1's own vetted task is a request of r1's: ${parent}`)
  ok(asRequest(child, SPAWN.prompt) && !child.includes(JSON.stringify(TASK)), `the child's request: ${child}`)
})

await scenario("a fork context's allow vets no spawn, as the loop's own model gave it on its own conversation: the child's task is no request", async () => {
  const [parent = '', child = ''] = await allowedChild('fork')
  ok(asRequest(parent, TASK), `r1's own vetted task is a request of r1's: ${parent}`)
  ok(!child.includes('"spawnTask"') && !child.includes(AS_REQUEST), `the child's question: ${child}`)
})

await scenario('a spawn whose task is not the one the classifier allowed is not vetted: the task it started with is data', async () => {
  const [, child = ''] = await allowedChild('fresh', 'audit everything else')
  ok(asData(child, 'audit everything else'), `the child's request: ${child}`)
})

await scenario('a vetted task over 16 KiB is not classified, rather than cut', async () => {
  reset({ spawnId: 'r1', ...classifying() })
  await startSession()
  await wrap({ prompt: 'x'.repeat(17_000) })
  eq(await refuse('Edit', EDIT, 'toolu_klyth_1', 'r1'), {}, 'the refusal')
  eq(classifierReqs().length, 0, 'classifier requests')
  ok(w.debug.includes("klyth classifier r1 Edit toolu_klyth_1: not classified (the subagent's task is too large to classify (17 KiB))"), `the reason: ${w.debug.join(' | ')}`)
})

await scenario('a vetted task never makes a path or a URL typed: a write outside the working directory and a fetch that it names are not classified', async () => {
  reset({ spawnId: 'r1', ...classifying() })
  await startSession()
  await wrap({ prompt: 'write the log to /tmp/x/run.log, then read https://example.com/docs' })
  eq(await refuse('Write', { file_path: '/tmp/x/run.log', content: 'log' }, 'toolu_klyth_1', 'r1'), {}, 'the write')
  eq(await refuse('WebFetch', { url: 'https://example.com/docs', prompt: 'x' }, 'toolu_klyth_2', 'r1'), {}, 'the fetch')
  eq(classifierReqs().length, 0, 'classifier requests')
  eq(await refuse('Edit', EDIT, 'toolu_klyth_3', 'r1'), { retry: true }, 'an edit inside the working directory')
  ok(asRequest(questionOf(classifierReqs()[0]), 'write the log to /tmp/x/run.log, then read https://example.com/docs'), 'the task is vetted, a request of its own')
  ok(w.debug.includes('klyth classifier r1 Write toolu_klyth_1: not classified (it writes outside /w)'), `the write: ${w.debug.join(' | ')}`)
  ok(w.debug.includes('klyth classifier r1 WebFetch toolu_klyth_2: not classified (it fetches a URL you did not type)'), `the fetch: ${w.debug.join(' | ')}`)
})

await scenario("a git worktree under klyth's own root is classified as its own project; the root, its other files and the worktree's own .git are not", async () => {
  reset({ spawnId: 'r1', ...classifying() })
  await startSession()
  await wrap({})
  const wt = '/klyth/.claude/worktrees/x'
  eq(await refuse('Edit', { ...EDIT, file_path: `${wt}/src/a.ts` }, 'toolu_klyth_1', 'r1', wt), { retry: true }, 'an edit in the worktree')
  eq(await refuse('Edit', { ...EDIT, file_path: '/klyth/hooks/x.ts' }, 'toolu_klyth_2', 'r1', wt), {}, "an edit to the root's code from the worktree")
  eq(await refuse('Edit', { ...EDIT, file_path: `${wt}/.git/config` }, 'toolu_klyth_3', 'r1', wt), {}, "an edit to the worktree's .git")
  eq(await refuse('Edit', { ...EDIT, file_path: '/klyth/README.md' }, 'toolu_klyth_4', 'r1', '/klyth'), {}, 'an edit in the root')
  eq(classifierReqs().length, 1, 'classifier requests')
  for (const line of ['toolu_klyth_2: not classified (it touches a protected path (/klyth))', 'toolu_klyth_3: not classified (it touches a protected path (.git))', 'toolu_klyth_4: not classified (it writes in a working directory that is a protected path (/klyth))']) {
    ok(w.debug.includes(`klyth classifier r1 Edit ${line}`), `${line} missing: ${w.debug.join(' | ')}`)
  }
})

await scenario('all-mode translated Agent tasks and routed forks are classified before permission admits their route-claimed spawns', async () => {
  const asked = { model: 'deep', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'Explore' }
  let n = 0
  reset({ spawnId: 'r1', tools: TOOLS, ...classifying({ tools: 'all' }, TWO_ALIASES), upstream: () => ({ pieces: [n++ % 2 === 0 ? callAnswer(asked) : (SSE['classifier-allow.sse'] as string)] }) })
  await startSession()
  await wrap({ subagent_type: 'general-purpose' })
  const { chunks } = await chunksOf('r1')
  const id = chunks.find(c => c.kind === 'tool')?.id ?? ''
  const input = JSON.parse(chunks.find(c => c.kind === 'input')?.json ?? 'null') as Record<string, unknown>
  const check = findHook('tool.check', {}).hook
  const admission = (input: Record<string, unknown>, tool_use_id: string) => check($, { tool: 'Agent', input, tool_use_id, agentId: 'r1' }, next(() => ({ decision: 'ask' })))
  eq(await admission(input, id), { decision: 'ask' }, 'routing grants nothing')
  eq(await refuse('Agent', input, id, 'r1'), { retry: true }, 'translated task classified')
  const retried = await chunksOf('r1')
  const retryId = retried.chunks.find(c => c.kind === 'tool')?.id ?? ''
  const made = { ...input }
  eq(await admission(made, retryId), { decision: 'allow', reason: 'klyth classifier: allowed this call' }, 'one exact permission retry')
  eq(await admission(made, retryId), { decision: 'ask' }, 'second retry cannot spawn')
  await agentCall({ tool_use_id: retryId, agentId: 'r1', ...made }, () => ({ result: 'launched' }))
  await agentSpawn(spawnEvent({ tool_use_id: retryId, parentAgentId: 'r1', prompt: asked.prompt }), { model: PARENT, agentId: 'c1' })
  const fork = { description: 'Again', prompt: 'continue the same audit', subagent_type: 'fork' }
  eq(await admission(fork, 'toolu_klyth_f1'), { decision: 'ask' }, 'fork routing grants nothing')
  eq(await refuse('Agent', fork, 'toolu_klyth_f1', 'r1'), { retry: true }, 'fork task classified')
  await stepOf('r1')
  eq(await admission(fork, 'toolu_klyth_f2'), { decision: 'allow', reason: 'klyth classifier: allowed this call' }, 'fork exact retry')
  await agentCall({ tool_use_id: 'toolu_klyth_f2', agentId: 'r1', ...fork }, () => ({ result: 'launched' }))
  await agentSpawn(spawnEvent({ tool_use_id: 'toolu_klyth_f2', parentAgentId: 'r1', prompt: fork.prompt, subagentType: 'fork', fork: true }), { model: PARENT, agentId: 'f1' })
  eq(classifierReqs().length, 2, 'both tasks reviewed')
  eq(routed().slice(-2).map(row => [row.id, (row.value as { target: string }).target]), [['c1', 'deep'], ['f1', 'fast']], 'both children claimed on a routed target')
  eq(w.spawns.length, 1, 'only native main spawned through $.agent.spawn; no permission fallback')
})

for (const context of ['fresh', 'fork'] as const) {
  for (const retryTarget of ['nearby', 'distant'] as const) {
    await scenario(`${context} Agent allow binds the actual translated provider target: retry on ${retryTarget}`, async () => {
      const base = JSON.parse(CONFIG)
      base.providers.other = { ...base.providers.acme, baseUrl: 'https://other.invalid/v1' }
      base.aliases = { ...base.aliases, nearby: 'acme/model-a', distant: 'other/model-a' }
      const boundary = 'Delegate the audit only to nearby; never send the task to distant.'
      const task = { model: 'nearby', prompt: 'audit the retry code', description: 'Audit', subagent_type: 'Explore' }
      const pieces = [callAnswer(task), SSE['classifier-allow.sse'] as string, callAnswer({ ...task, model: retryTarget })]
      reset({ spawnId: 'r1', tools: TOOLS, ...classifying({ tools: 'all', context }, JSON.stringify(base)), upstream: () => ({ pieces: [pieces.shift() ?? (SSE['classifier-allow.sse'] as string)] }) })
      await startSession()
      await find('prompt.submit', {})($, { text: boundary, origin: { kind: 'composer' } }, next(async () => ({ text: boundary })))
      await wrap({ prompt: boundary, subagent_type: 'general-purpose' })
      const original = await chunksOf('r1')
      const id = original.chunks.find(c => c.kind === 'tool')?.id ?? ''
      const input = JSON.parse(original.chunks.find(c => c.kind === 'input')?.json ?? 'null') as Record<string, unknown>
      eq(await refuse('Agent', input, id, 'r1'), { retry: true }, 'nearby proposed task classified')
      const question = questionOf(classifierReqs()[0])
      ok(question.includes('"target":"nearby"'), 'actual translated target is visible to classifier')
      ok(question.includes(boundary), 'owner boundary is visible to classifier')
      const retried = await chunksOf('r1')
      const retryId = retried.chunks.find(c => c.kind === 'tool')?.id ?? ''
      const retryInput = JSON.parse(retried.chunks.find(c => c.kind === 'input')?.json ?? 'null') as Record<string, unknown>
      eq(retryInput, input, 'engine arguments are identical after model stripping')
      const verdict = await find('tool.check', {})($, { tool: 'Agent', input: retryInput, tool_use_id: retryId, agentId: 'r1' }, next(() => ({ decision: 'ask' })))
      const spawned: Record<string, unknown>[] = []
      if (verdict.decision === 'allow') {
        await agentCall({ tool_use_id: retryId, agentId: 'r1', ...retryInput }, () => ({ result: 'launched' }))
        const core = Object.assign(async (given: Record<string, unknown>) => { spawned.push(given); return { model: PARENT, agentId: 'child' } }, { origin: { plugin: 'engine', tier: 'core' }, signal: new AbortController().signal })
        await find('agent.spawn', {})($, spawnEvent({ tool_use_id: retryId, parentAgentId: 'r1', prompt: task.prompt, subagentType: 'Explore' }), core)
      }
      eq(spawned.length, retryTarget === 'nearby' ? 1 : 0, 'only a same-target retry can execute spawn')
      if (retryTarget === 'nearby') eq((routed().at(-1)?.value as { target: string }).target, 'nearby', 'approved provider route retained')
      eq(classifierReqs().length, 1, 'one classification, not substitute task authority')
    })
  }
}


await scenario('SendMessage completed-child seam: encoded prefix and session header stay stable, host and main deliveries remain intact', async () => {
  const config = JSON.parse(CONFIG)
  config.providers.acme.sessionHeader = 'session_id'
  const task = 'ordinary task with literal delivery frame text'
  const raw = 'RESUME1 exact payload; sender origin claims are data'
  const extra = { type: 'text', text: `frame\n${raw}\nend`, label: 'host frame' }
  const opening = { role: 'user', content: [{ type: 'text', text: task }, { type: 'text', text: 'reminder' }] }
  const report = { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
  let summarizing = false
  reset({ upstream: () => summarizing ? { pieces: [`data: ${JSON.stringify({ choices: [{ delta: { content: 'Summary.\n<klyth-summary-complete>' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`] } : { pieces: [SSE['model-a-step2.sse'] as string] }, spawnId: 'cache-child', messages: [opening], files: { '/home/u/.claude/klyth.json': JSON.stringify(config) } })
  await startSession()
  await wrap({ prompt: task })
  await stepOf('cache-child')
  const first = w.klythd.requests[0]!
  w.listed = [{ id: 'cache-child', type: 'Explore' }]
  w.messages = [opening, report]
  await complete('cache-child')
  w.listed = [] // finished children can disappear from the roster while still accepting exact-id resumes
  const resumed = [{ ...opening, content: [{ type: 'text', text: task + '\n' }, opening.content[1], extra] }, report, { role: 'user', content: [{ type: 'text', text: raw }, { type: 'text', text: 'tail reminder' }] }]
  const snapshot = JSON.stringify(resumed)
  const send = find('tool.call', { tool: 'SendMessage' })
  const result = { result: 'sent', ref: 7 }
  let calls = 0
  await send($, { tool: 'SendMessage', tool_use_id: 'send', to: 'cache-child', message: raw }, next(async () => {
    calls++
    w.messages = resumed
    await stepOf('cache-child') // the child can race the call's confirmation
    return result
  }))
  eq(calls, 1, 'successful delivery forwarded once')
  eq(w.klythd.wires.filter(x => 'req' in x).length >= 1, true, 'real encoded requests reached daemon')
  const advanced = [...resumed, { role: 'assistant', content: [{ type: 'tool_use', id: 'read-next', name: 'Read', input: { file_path: '/fixture' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-next', content: 'file contents' }] }]
  const advancedSnapshot = JSON.stringify(advanced)
  w.messages = advanced
  await stepOf('cache-child')
  const repaired = w.klythd.requests.at(-1)!
  eq((repaired.body.messages as unknown[]).slice(0, 2), (first.body.messages as unknown[]).slice(0, 2), 'system and opening encoded byte-prefix')
  eq(repaired.headers.session_id, first.headers.session_id, 'encoded session header')
  eq(JSON.stringify(resumed), snapshot, 'host history never mutated')
  eq(JSON.stringify(advanced), advancedSnapshot, 'tool-step host history never mutated')
  const wire = w.klythd.wires.findLast(x => 'req' in x) as StepWire
  eq(wire.req.transcript[2], { ...resumed[2], content: [{ ...extra, text: '\n' + extra.text }, ...resumed[2]!.content] }, 'wrapper stays on original delivery turn after tool result')
  eq(wire.req.transcript[4], advanced[4], 'tool result untouched')
  ok(JSON.stringify(repaired.body.messages).includes(JSON.stringify('\n' + extra.text).slice(1, -1)), 'wrapper and LF kept at tail')
  ok(w.debug.some(x => x.includes('apply=moved')), 'seam diagnostic')
  await complete('cache-child')
  const second = [...advanced, report, { role: 'user', content: [{ type: 'text', text: 'RESUME2' }] }]
  second[0] = opening
  w.messages = second
  eq(await send($, { tool: 'SendMessage', tool_use_id: 'send-main', agentId: 'cache-child', to: 'main', message: raw, origin: { plugin: 'engine' } }, next(() => result)), result, 'child to main result preserved')
  eq(await send($, { tool: 'SendMessage', tool_use_id: 'send-other', to: 'other-session [ref]', message: raw }, next(() => result)), result, 'cross-session result preserved')
  const secondSnapshot = JSON.stringify(second)
  await stepOf('cache-child')
  eq(JSON.stringify(second), secondSnapshot, 'main and cross-session sends do not create child candidates')
  w.messages = [...second, report]
  await complete('cache-child')
  const raw3 = 'RESUME3'
  await send($, { tool: 'SendMessage', tool_use_id: 'send-third', to: 'cache-child', message: raw3 }, next(() => result))
  const compacting = [...w.messages, { role: 'user', content: [{ type: 'text', text: raw3 }] }]
  compacting[0] = { ...opening, content: [{ type: 'text', text: task + '\n' }, opening.content[1]!, { type: 'text', text: `frame ${raw3}` }] }
  w.messages = compacting
  const skipped = await find('session.compact', {})($, { trigger: 'auto', agentId: 'cache-child', messages: [] }, next(() => { throw new Error('routed compact must not reach native') }))
  ok(skipped.skip.includes('no older history'), 'empty compaction preserves history without native inference')
  await stepOf('cache-child')
  const afterCompaction = w.klythd.wires.findLast(x => 'req' in x) as StepWire
  eq(afterCompaction.req.transcript[0], opening, 'skipped compaction preserves the completed-child cache ledger')
  // Establish a sibling opening; successful compaction must not clear a different child's snapshot.
  w.spawnId = 'cache-sibling'
  w.messages = [opening]
  await wrap({ prompt: task })
  await stepOf('cache-sibling')
  w.messages = [opening, report]
  await complete('cache-sibling')
  const siblingRaw = 'SIBLING RESUME', siblingFrame = { type: 'text', text: `frame ${siblingRaw}` }
  await send($, { tool: 'SendMessage', tool_use_id: 'sibling-send', to: 'cache-sibling', message: siblingRaw }, next(() => result))
  const sibling = [{ ...opening, content: [{ type: 'text', text: task + '\n' }, opening.content[1]!, siblingFrame] }, report, { role: 'user', content: siblingRaw }]
  w.messages = (id: string | undefined) => id === 'cache-sibling' ? sibling : compacting
  w.compactRows = compacting.map((m, i) => ({ role: (m as { role: 'user' | 'assistant' }).role as 'user' | 'assistant', text: `row ${i}`, toolUses: [], handle: `compact-h${i}` }))
  summarizing = true
  const success = await find('session.compact', {})($, { trigger: 'manual', agentId: 'cache-child', messages: w.compactRows }, next(() => { throw new Error('routed summary must not reach native') }))
  ok(success.messages !== undefined, 'registered routed success returns replacement')
  const encodedSummary = w.klythd.requests.at(-1)!
  eq(encodedSummary.headers.session_id, first.headers.session_id, 'real compact codec sends the original child session header')
  eq((encodedSummary.body.messages as unknown[]).slice(0, 2), (first.body.messages as unknown[]).slice(0, 2), 'real compact codec preserves system and repaired opening prefix')
  eq(encodedSummary.body.tools, first.body.tools, 'real compact codec preserves original tool schema bytes')
  eq(success.messages[1].handle, 'compact-h3', 'recent tail preserves engine handles')
  summarizing = false
  await stepOf('cache-child')
  const invalidated = w.klythd.wires.findLast(x => 'req' in x) as StepWire
  eq(invalidated.req.transcript[0], compacting[0], 'successful compaction invalidates the affected child opening')
  await stepOf('cache-sibling')
  const unaffected = w.klythd.wires.findLast(x => 'req' in x) as StepWire
  eq(unaffected.req.transcript[0], opening, 'successful child compaction preserves sibling opening and delivery attestation')

})


await scenario('registered SendMessage ledger repairs an unlisted finished child through three accumulated resumes and tool results', async () => {
  const config = JSON.parse(CONFIG)
  config.providers.acme.sessionHeader = 'session_id'
  const task = 'accumulated ordinary child task'
  const opening: ApiMessage = { role: 'user', content: [{ type: 'text', text: task }, { type: 'text', text: 'opening reminder' }] }
  reset({ spawnId: 'ledger-child', messages: [opening], files: { '/home/u/.claude/klyth.json': JSON.stringify(config) } })
  await startSession()
  await wrap({ prompt: task })
  w.listed = [{ id: 'ledger-child', type: 'Explore' }]
  await stepOf('ledger-child')
  const first = w.klythd.requests[0]!
  let host: ApiMessage[] = [opening, { role: 'assistant', content: 'initial report' }]
  const wrappers: { type: string; text: string; label: string }[] = []
  const positions: number[] = []
  const send = find('tool.call', { tool: 'SendMessage' })
  for (let n = 1; n <= 3; n++) {
    w.messages = host
    await complete('ledger-child')
    w.listed = [] // completion does not erase the engine-observed loop identity
    const raw = `REGISTERED-RESUME-${n}`
    eq(await send($, { tool: 'SendMessage', tool_use_id: `send-ledger-${n}`, to: 'ledger-child', message: raw }, next(() => ({ result: 'sent' }))), { result: 'sent' }, 'delivery result preserved')
    wrappers.push({ type: 'text', text: `frame ${raw} end`, label: `frame-${n}` })
    const extras = wrappers.map((b, i) => ({ ...b, text: b.text + (i < n - 1 ? '\n' : '') }))
    positions.push(host.length)
    host = [{ ...opening, content: [{ type: 'text', text: task + '\n' }, { type: 'text', text: 'opening reminder' }, ...extras] }, ...host.slice(1), { role: 'user', content: [{ type: 'text', text: raw }, { type: 'text', text: 'tail reminder' }] }]
    const snapshot = JSON.stringify(host)
    w.messages = host
    await stepOf('ledger-child')
    let wire = w.klythd.wires.findLast(x => 'req' in x) as StepWire
    eq(wire.req.transcript[0], opening, `resume ${n} opening restored`)
    for (let i = 0; i < n; i++) eq((wire.req.transcript[positions[i]!]!.content as object[])[0], { ...extras[i], text: (i === 0 ? '\n' : '') + extras[i]!.text }, `resume ${n} wrapper ${i} kept at its own delivery`)
    eq((w.klythd.requests.at(-1)!.body.messages as unknown[]).slice(0, 2), (first.body.messages as unknown[]).slice(0, 2), `resume ${n} encoded opening prefix`)
    eq(w.klythd.requests.at(-1)!.headers.session_id, first.headers.session_id, `resume ${n} session header`)
    eq(JSON.stringify(host), snapshot, `resume ${n} host untouched`)
    host = [...host, { role: 'assistant', content: [{ type: 'tool_use', id: `ledger-read-${n}`, name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `ledger-read-${n}`, content: 'read result' }] }]
    w.messages = host
    await stepOf('ledger-child')
    wire = w.klythd.wires.findLast(x => 'req' in x) as StepWire
    eq(wire.req.transcript[0], opening, `resume ${n} next tool-result step remains normalized`)
    eq(wire.req.transcript.at(-1), host.at(-1), `resume ${n} tool result unchanged`)
    host = [...host, { role: 'assistant', content: `report ${n}` }]
  }
})

console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
