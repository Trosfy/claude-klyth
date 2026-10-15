// Stand-ins for the engine beneath klyth, shared by the hook-level tests: a filesystem holding the config
// and any further files, the store, settings, the session, a fixed clock, the native turn.step and /model,
// git, trash, uname and the bun lookup via process.run (any of them answered by `run` instead), fs.stat, the
// classic events the classifier listens on (each answered `{}`, an attachment with its own text), and klythd:
// its process (it answers ready and stays up until `kill`) and curl over its socket, whose calls run
// klythd's own step and status logic in-process. That logic runs the key helper (`run` and `keyFails`
// answer it) and sends its provider requests to `upstream`, which records them. Every call is recorded.
import type { AgentSpawnInput, On, PromptComposeInput, PromptSubmitInput, PromptSubmitResult, SessionUsage, ToolInfo, ToolSpec, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { MainPin, Route } from '../types'
import { fakeDaemon } from './daemon-fake'
import type { Request, Upstream } from './daemon-fake'
import { dirEntries } from './dirs'
import { SSE } from './fixtures/data.gen'
import { HANDBACK_REMINDER } from './fixtures/handback'

export { HANDBACK_REMINDER }
export const HOME = '/home/u'
export const CWD = '/w'
// What $.session.id() answers, and the route file klyth writes for it in command mode.
export const SESSION_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
export const ROUTE_FILE = `${HOME}/.cache/klyth/statusline/${SESSION_ID}`
export const TRASH = '/opt/bin/trash'
export const BUN = '/opt/bin/bun'
export const ORIGIN = 'https://klyth.invalid'
// What $.clock.now() answers: noon, local time, on 2026-10-07.
export const NOW = new Date(2026, 9, 7, 12).getTime()
// The acme provider's credential helper, and the key it prints.
export const HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'acme', '-w']
export const KEY = 'sk-klyth-test-0123456789abcdef'
export const TRUSTED = { [`trust:openai|${ORIGIN}|cmd:${JSON.stringify(HELPER)}`]: true }
const GPT = {
  contextWindow: 1_050_000,
  maxInputTokens: 922_000,
  maxOutputTokens: 128_000,
  maxTokensParam: 'max_completion_tokens',
  effort: { low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } },
}
export const CONFIG_OBJECT = {
  providers: {
    acme: {
      kind: 'openai',
      baseUrl: `${ORIGIN}/v1`,
      auth: { command: HELPER },
      models: { 'model-a': GPT, 'model-b': GPT, small: { contextWindow: 128_000, maxOutputTokens: 8000, maxTokensParam: 'max_tokens' } },
    },
  },
  aliases: {
    fast: { target: 'acme/model-a', note: 'cheap, fast explorer for read-only sweeps' },
    strong: { target: 'acme/model-b', note: 'strong generalist' },
  },
}
export const CONFIG = JSON.stringify(CONFIG_OBJECT)

// A plain-http provider (allowHttp) behind a dotted alias; its model takes `max_tokens` and effort levels up to medium.
export const LOCAL_ORIGIN = 'http://klyth.invalid:8080'
export const LOCAL_HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'local', '-w']
export const LOCAL_CONFIG = JSON.stringify({
  providers: {
    local: {
      kind: 'openai',
      baseUrl: `${LOCAL_ORIGIN}/v1`,
      allowHttp: true,
      auth: { command: LOCAL_HELPER },
      models: {
        'model-v1': {
          contextWindow: 327_680,
          maxInputTokens: 262_144,
          maxOutputTokens: 65_536,
          maxTokensParam: 'max_tokens',
          effort: { low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' } },
        },
      },
    },
  },
  aliases: { 'model.v1-mini': { target: 'local/model-v1', note: 'a dotted alias on a plain-http provider' } },
})
export const LOCAL_TRUSTED = { [`trust:openai|${LOCAL_ORIGIN}|cmd:${JSON.stringify(LOCAL_HELPER)}`]: true }

export type Git = { exitCode: number; stdout: string; stderr: string }
// A tool as `tool.register` hands it on, less `isDeferred`: 2.1.292 types the event `Required<ToolSpec>` without it,
// and 2.1.293 as a spec with an optional `isDeferred`, so no `Required<ToolSpec>` takes both.
type Registered = Required<Pick<ToolSpec, 'name' | 'description' | 'inputSchema'>>
export type WorldOptions = {
  config?: string | null | (() => string | null) // null: no config file; a function is read at each load
  store?: Record<string, unknown> | 'fails'
  policy?: Record<string, unknown> | 'fails'
  settings?: Partial<Record<'user' | 'project' | 'local' | 'flag', Record<string, unknown>>> | 'fails' // each source's settings but policy; 'fails': reading them is refused
  keyFails?: boolean // every credential helper exits 1
  mainClear?: 'fails' | (() => Promise<void>) // writes that clear the `main` state key are refused, or wait on the function
  picker?: string | (() => string) // what the native bare /model (the picker) answers; a function is called as it runs
  version?: string
  usageTokens?: number
  mcpTools?: { name: string; isLoaded: boolean }[]
  tools?: ToolInfo[] | (() => ToolInfo[])
  messages?: unknown | ((agentId: string | undefined) => unknown)
  compose?: 'throws'
  submit?: 'enters' | ((e: PromptSubmitInput) => PromptSubmitResult) // answers prompt.submit beneath klyth: 'enters' lets the prompt in as it came; left alone when not given
  system?: string // the text of the composed system prompt's one section; 'SYSTEM PROMPT' when not given
  pinRead?: 'fails'
  answer?: string | null // null: the dialog is dismissed
  cwd?: string
  sessionId?: string | (() => string) // what $.session.id() answers; SESSION_ID when not given, a function is called at each ask
  git?: (args: readonly string[]) => Git | undefined
  // Answers a process.run first: a result (stdout and stderr default to empty), undefined to leave it to the
  // defaults below, or a throw, which rejects the call.
  run?: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined
  trash?: string | null
  upstream?: (req: Request) => Upstream | undefined // undefined: the recorded weather answer
  nativeStep?: (e: TurnStepInput) => { chunks: TurnStepChunk[]; result: TurnStepResult } | undefined // the native model's response
  bun?: string | null // the bun the lookup finds; null: none
  klythd?: 'silent' | 'exits' // klythd never answers ready, or exits with a failure before it
  socketThrows?: string // curl over klythd's socket fails after streaming what klythd wrote (daemon-fake.ts)
  routes?: Record<string, Route>
  translated?: Record<string, Record<string, string>> // the translated calls kept in state, by `main` or agentId
  pin?: MainPin
  mcpFile?: string
  files?: Record<string, string> // further files, by absolute path (their directories exist and list them)
  // What fs.stat finds at a path: where it lands (its real path), or null for a link that leads nowhere, which a stat
  // asked to resolve rejects as missing (as the engine's may) and one not asked finds as a link. A path not listed is
  // itself when it is the working directory, a file or a directory of `files`, and missing otherwise.
  stats?: Record<string, string | null>
  onStat?: (path: string) => Promise<void> // runs as each fs.stat is asked, before it is answered
  deniedBeneath?: () => { retry?: true } // what the settings hooks beneath classic.PermissionDenied answer; `{}` when not given
  env?: Record<string, string> // further environment variables; CLAUDE_CONFIG_DIR moves the config file to <dir>/klyth.json
  approval?: 'native' // leaves approval placement and timer events to the test
  clock?: 'mocked' // the test answers $.clock itself (mock.clock)
  spawn?: ((e: AgentSpawnInput) => { model: string } | { deny: string } | Promise<{ model: string } | { deny: string }>) | 'unanswered'
}

export function world(on: On, o: WorldOptions = {}) {
  const daemon = fakeDaemon({
    bun: o.bun ?? BUN,
    upstream: r => o.upstream?.(r) ?? { pieces: [SSE['model-a-step2.sse'] as string] },
    helper: argv => (w.runs.push(argv), command(argv)),
    log: text => void w.debug.push(text),
    now: NOW,
    ...(o.klythd === undefined ? {} : { klythd: o.klythd }),
    ...(o.socketThrows === undefined ? {} : { socketThrows: o.socketThrows }),
  })
  const w = {
    debug: [] as string[],
    transcript: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    registered: [] as Registered[],
    commands: [] as string[],
    asks: [] as string[],
    native: [] as string[],
    nativeSteps: [] as TurnStepInput[],
    composes: [] as PromptComposeInput[],
    runs: [] as string[][], // every command run: by the engine, and the key helper klythd runs
    processes: [] as { argv: readonly string[]; cwd?: string; env?: Record<string, string>; input?: string }[], // every spawn
    requests: daemon.requests, // the provider requests klythd sent
    wires: daemon.wires, // what curl carried to klythd
    get daemons() {
      return daemon.daemons // klythd processes started
    },
    get aborted() {
      return daemon.aborted // provider requests cancelled by their client going away
    },
    kill: (how?: 'socket') => daemon.kill(how), // ends the running klythd; `socket` closes its socket alone
    spawns: [] as Record<string, unknown>[],
    invalidated: [] as string[],
    reads: [] as (string | undefined)[],
    fsReads: [] as string[],
    written: {} as Record<string, string>, // files $.fs.write left, by path, after the mv the engine ran on them
    stateSets: [] as { key: string; id?: string; value: unknown }[],
    routeReads: [] as (string | undefined)[], // the agentId of every read of a `routed` state member
  }
  const config = () => (typeof o.config === 'function' ? o.config() : o.config === undefined ? CONFIG : o.config)
  const file = (path: string) => (o.files !== undefined && Object.hasOwn(o.files, path) ? o.files[path] : undefined)
  if (o.store === 'fails') {
    on('store.get', () => ({ deny: 'store unavailable' }))
    on('store.set', () => ({ deny: 'store unavailable' }))
  } else mock.store(on, o.store ?? TRUSTED)
  if (o.approval !== 'native') {
    // Existing model-lane tests receive a synthetic expiry, never a claimed real-time wait.
    on('ui.open', { id: 'klyth-classifier-approval' }, () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [{ id: 'klyth-classifier-approval', title: 'Review action', isPlaced: true, isShown: true, isFocused: true }] }))
    on('ui.close', { id: 'klyth-classifier-approval' }, () => ({ value: undefined }))
    on('clock.after', { ms: 8000 }, () => ({ value: undefined }))
    on('clock.after', { ms: 1000 }, ($, e, next) => new Promise(resolve => next.signal.addEventListener('abort', () => resolve({ value: undefined }), { once: true })))
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  mock.env(on, { HOME, CLAUDE_CODE_ENTRYPOINT: 'cli', ...o.env })
  const configPath = `${o.env?.['CLAUDE_CONFIG_DIR'] || `${HOME}/.claude`}/klyth.json`
  on('fs.exists', ($, e) => ({
    value:
      file(e.path) !== undefined ||
      dirEntries(o.files ?? {}, e.path) !== undefined ||
      (e.path === configPath && config() !== null) ||
      (e.path.endsWith('/hooks/schemas.mcp.gen.json') && o.mcpFile !== undefined),
  }))
  on('fs.list', ($, e) => ({ value: (dirEntries(o.files ?? {}, e.path) ?? []).map(entry => ({ ...entry, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.write', ($, e) => ((w.written[e.path] = e.text), { value: undefined }))
  on('fs.stat', async ($, e) => {
    await o.onStat?.(e.path)
    const listed = o.stats !== undefined && Object.hasOwn(o.stats, e.path) ? o.stats[e.path] : undefined
    const real = listed !== undefined ? listed : e.path === (o.cwd ?? CWD) || file(e.path) !== undefined || dirEntries(o.files ?? {}, e.path) !== undefined ? e.path : undefined
    if (real === undefined || (real === null && e.resolve)) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    if (real === null) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } }
    return { value: { kind: file(e.path) === undefined ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: real !== e.path, ...(e.resolve ? { realPath: real } : {}) } }
  })
  on('fs.read', ($, e) => (w.fsReads.push(e.path), { value: file(e.path) ?? (e.path.endsWith('/hooks/schemas.mcp.gen.json') ? (o.mcpFile as string) : (config() as string)) }))
  if (o.clock !== 'mocked') {
    on('clock.now', () => ({ value: NOW }))
    // A wait that ends only when its caller gives it up: nothing a test runs waits on real time.
    on('clock.sleep', ($, e, next) => new Promise(resolve => next.signal.addEventListener('abort', () => resolve({ value: undefined }), { once: true })))
  }
  on('settings.read', ($, e) => {
    const [fromPolicy, fromOthers] = [o.policy === 'fails' ? undefined : (o.policy ?? {}), o.settings === 'fails' ? undefined : (o.settings?.[e?.source as 'user'] ?? {})]
    const value = e?.source === undefined || e.source === 'policy' ? fromPolicy : fromOthers
    return value === undefined ? { deny: 'settings unavailable' } : { value }
  })
  on('session.version', () => ({ value: { version: o.version ?? '2.1.292' } }))
  on('session.cwd', () => ({ value: o.cwd ?? CWD }))
  on('session.id', () => ({ value: typeof o.sessionId === 'function' ? o.sessionId() : (o.sessionId ?? SESSION_ID) }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { tokens: o.usageTokens, window: 200_000, breakdown: { mcpTools: o.mcpTools ?? [] } } } as unknown as SessionUsage,
  }))
  on('session.messages', ($, e) => {
    const agentId = (e as { agentId?: string }).agentId
    w.reads.push(agentId)
    const m = typeof o.messages === 'function' ? (o.messages as (a: string | undefined) => unknown)(agentId) : o.messages
    return { value: (m ?? [{ role: 'user', content: agentId === undefined ? [{ type: 'text', text: 'hi' }] : [{ type: 'text', text: 'hi' }, HANDBACK_REMINDER] }]) as never }
  })
  on('tool.list', () => ({
    value: (typeof o.tools === 'function' ? o.tools() : o.tools) ?? [
      { name: 'Read', description: 'Reads a file', mcp: false },
      { name: 'Agent', description: 'Starts a subagent', mcp: false },
      { name: 'mcp__klyth__agent', description: 'advert', mcp: true },
    ],
  }))
  on('tool.register', ($, e) => (w.registered.push(e), { value: { tool: `mcp__klyth__${e.name}` } }))
  on('command.register', ($, e) => (w.commands.push(e.name), { value: { command: e.name } }))
  on('ui.log', ($, e) => ((e.to === 'debug' ? w.debug : w.transcript).push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (w.statuses.push(e.text), { value: undefined }))
  on('ui.invalidate', ($, e) => (w.invalidated.push(e.event), { value: undefined }))
  on('state.set', async ($, e, next) => {
    if (e.key === 'main' && e.value === null && o.mainClear === 'fails') return { deny: 'state unavailable' }
    if (e.key === 'main' && e.value === null && typeof o.mainClear === 'function') await o.mainClear()
    w.stateSets.push({ key: e.key, ...(e.id === undefined ? {} : { id: e.id }), value: e.value })
    return next(e)
  })
  on('state.get', ($, e, next) => {
    if (e.key === 'routed') w.routeReads.push(e.id)
    if (e.key === 'routed' && e.id !== undefined && o.routes?.[e.id] !== undefined) return { value: { value: o.routes[e.id], version: 1 } }
    if (e.key === 'translated' && e.id !== undefined && o.translated?.[e.id] !== undefined) return { value: { value: o.translated[e.id], version: 1 } }
    if (e.key === 'mainPin' && o.pinRead === 'fails') return { deny: 'state unavailable' }
    if (e.key === 'mainPin' && o.pin !== undefined) return { value: { value: o.pin, version: 1 } }
    return next(e)
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    w.asks.push(e.questions.map(q => q.question).join(' | '))
    if (o.answer === null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, o.answer ?? 'Allow'])) } }
  })
  const picker = () => (typeof o.picker === 'function' ? o.picker() : o.picker)
  on('command.run', ($, e) => (w.native.push(`/${e.command} ${e.args}`), { text: e.args === '' && o.picker !== undefined ? picker() : `native /${e.command} ${e.args}` }))
  on('classic.PostModelSwitch', () => ({}))
  for (const event of ['classic.SessionStart', 'classic.UserPromptSubmit', 'classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PermissionRequest'] as const) on(event, () => ({}))
  on('classic.PermissionDenied', () => o.deniedBeneath?.() ?? {})
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.compose', ($, e) => {
    w.composes.push(e)
    if (o.compose === 'throws') throw new Error('compose unavailable')
    return { sections: [{ id: 'intro', text: o.system ?? 'SYSTEM PROMPT', scope: 'shared' }] }
  })
  on('turn.step', async function* ($, e) {
    w.nativeSteps.push(e)
    const made = o.nativeStep?.(e)
    if (made !== undefined) {
      yield* made.chunks
      return made.result
    }
    yield { kind: 'text', index: 0, text: 'native' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'native', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const submit = o.submit
  if (submit !== undefined) on('prompt.submit', ($, e) => (submit === 'enters' ? { text: e.text } : submit(e)))
  const answer = o.spawn
  if (answer !== 'unanswered') {
    on('agent.spawn', async ($, e) => (w.spawns.push(e as unknown as Record<string, unknown>), (await answer?.(e)) ?? { model: e.model ?? 'inherit' }))
  }
  // A command as the engine or klythd runs it: a result, or a throw for one that cannot start.
  const command = (argv: string[]): { exitCode: number; stdout: string; stderr: string } => {
    const custom = o.run?.(argv)
    if (custom !== undefined) return { stdout: '', stderr: '', ...custom }
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
    const fail = { exitCode: 1, stdout: '', stderr: '' }
    if (argv[0] === '/bin/sh' && argv[2] === 'command -v trash') return o.trash === null ? fail : ok(`${o.trash ?? TRASH}\n`)
    if (argv[0] === '/bin/sh' && argv[2]?.startsWith('command -v bun')) return o.bun === null ? fail : ok(`${o.bun ?? BUN}\n`)
    if (argv[0] === '/usr/bin/security') return o.keyFails === true ? fail : ok(`${KEY}\n`)
    if (argv[0] === '/usr/bin/uname') return ok('Darwin\n')
    // mv -f <from> <to>, over the files $.fs.write left.
    const [from = '', to = ''] = argv.slice(2)
    if (argv[0] === '/bin/mv') return ((w.written[to] = w.written[from] ?? ''), delete w.written[from], ok())
    if (argv[0] === 'git') return o.git?.(argv.slice(1)) ?? defaultGit(argv.slice(1))
    return ok()
  }

  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    return { value: { ...(daemon.run(argv, e.init?.stdin) ?? command(argv)), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e, next) {
    w.processes.push({ argv: e.argv, ...(e.cwd === undefined ? {} : { cwd: e.cwd }), ...(e.env === undefined ? {} : { env: e.env }), ...(e.input === undefined ? {} : { input: e.input }) })
    const child = daemon.spawn(e.argv, e.input, next.signal)
    return { value: child === undefined ? { code: 0, signal: null } : yield* child } as never
  })
  return w
}

// git as a clean repository at CWD whose HEAD is `base0`.
function defaultGit(args: readonly string[]): Git {
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  if (args.includes('--show-toplevel')) return ok(`${CWD}\n`)
  if (args.includes('--verify')) return ok('base0\n')
  if (args.includes('rev-list')) return ok('0\n')
  return ok()
}

export const start = ($: Engine) => $.session.start({ cwd: CWD, surface: null, isInteractive: true })
export const model = ($: Engine, args: string) => $.command.run({ command: 'model', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
export const klyth = ($: Engine, args = '') => $.command.run({ command: 'klyth', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
// Whether the debug log says the classifier allowed the refusal `id` of `tool` in the loop `who` for `reason`: an allow is in the debug log alone.
export const allowedIn = (w: { debug: readonly string[] }, reason: string, tool = 'Edit', id = 'toolu_klyth_1', who = 'main') => w.debug.some(l => l.startsWith(`klyth classifier ${who} ${tool} ${id}: allow (${reason}) in `))

// Reads a turn.step stream to its end: its chunks and the generator's return value.
export async function step($: Engine, e: Partial<TurnStepInput> & Pick<TurnStepInput, 'turnId' | 'index'>) {
  const stream = $.turn.step({ model: 'claude-opus-5-5', messageCount: 1, ...e })
  const chunks: TurnStepChunk[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) return { chunks, result: next.value as TurnStepResult }
    chunks.push(next.value)
  }
}

export const sse = (...events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
