// Real registration over process-owned environment and session-held, dispatch-frozen state. No provider requests.
import { register } from '../../hooks/register'
import { fakeDaemon } from '../daemon-fake'

declare const console: { log(text: string): void }
let assertions = 0
const equal = (actual: unknown, expected: unknown, why: string) => {
  assertions++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}
type Hook = { event: string; matcher?: Record<string, unknown>; hook: any }
const hooks: Hook[] = [], state = new Map<string, { value: unknown; version: number }>()
const environment = new Map<string, string>([['HOME', '/home/u'], ['DISABLE_AUTO_COMPACT', '1'], ['DISABLE_COMPACT', '1'], ['MAX_CONTEXT_TOKENS', '872000']])
const writes: string[] = [], debug: string[] = []
let config: string | undefined = '{}', sessionId = 'fixture-0', sessionNumber = 0
let beforeStateWrite: ((value: any) => Promise<void>) | undefined
let refuseSeed = false, failFinal = false, failHandoffConsume = false, failHandoffWrite = false
const daemon = fakeDaemon({ bun: '/opt/bin/bun', now: 0, helper: () => ({ exitCode: 0, stdout: '' }), log: text => { debug.push(text) }, upstream: () => { throw new Error('no real or fake inference expected') } })
const $: any = {
  plugin: { root: '/klyth', name: 'klyth' },
  env: {
    get: async (name: string) => environment.get(name),
    set: async (name: string, value: string | undefined) => {
      if (name === 'KLYTH_HOST_WINDOW_HANDOFF' && value !== undefined && failHandoffWrite) throw new Error('handoff write denied')
      if (name === 'KLYTH_HOST_WINDOW_HANDOFF' && value === undefined && failHandoffConsume) throw new Error('handoff unavailable')
      writes.push(name); if (value === undefined) environment.delete(name); else environment.set(name, value) },
  },
  state: {
    get: async (ref: any) => state.get(ref.key) ?? { value: undefined, version: 0 },
    set: async (ref: any, value: unknown, opts?: { ifVersion: number }) => {
      await beforeStateWrite?.(value)
      const version = state.get(ref.key)?.version ?? 0
      if (ref.key === 'hostWindow' && ((refuseSeed && version === 0) || (failFinal && value && !(value as { pending?: true }).pending && version > 0))) return { isSet: false, version }
      if (opts && opts.ifVersion !== version) return { isSet: false, version }
      state.set(ref.key, { value, version: version + 1 }); return { isSet: true, version: version + 1 }
    },
  },
  fs: { exists: async (path: string) => path.endsWith('/klyth.json') && config !== undefined, read: async () => config, write: async () => {} },
  settings: { read: async () => ({ autoCompactEnabled: false }) },
  store: { get: async () => undefined, set: async () => { throw new Error('host window must not use the persistent store') } },
  session: { version: async () => ({ version: '2.1.296' }), id: async () => sessionId, model: async () => 'sonnet', cwd: async () => '/w', usage: async () => ({ context: { tokens: 0, window: 1_000_000 } }) },
  command: { register: async () => ({}) }, tool: { register: async () => ({}) },
  ui: { log: (text: string) => { debug.push(text) }, toast: () => {}, status: () => {}, invalidate: () => {} },
  clock: { now: async () => 0, sleep: async () => {}, after: () => ({ cancel() {} }) },
  process: {
    run: async (argv: string[], options?: any) => daemon.run(argv, options?.stdin) ?? { exitCode: 0, stdout: argv[2]?.includes('bun') ? '/opt/bin/bun\n' : '', stderr: '' },
    spawn: async function* (input: any) { return yield* daemon.spawn(input.argv, input.input, new AbortController().signal)! },
  },
}
function registration() {
  hooks.length = 0
  const on: any = (event: string, a: any, b?: any) => { hooks.push(b ? { event, matcher: a, hook: b } : { event, hook: a }); return { catch() {} } }
  register(on, {} as never)
}
const fire = async (event: string, e: Record<string, unknown> = {}) => {
  const hook = hooks.find(h => h.event === event && Object.entries(h.matcher ?? {}).every(([key, value]) => e[key] === value))
  if (!hook) throw new Error(`no ${event} hook`)
  const snapshot = new Map(state), id = sessionId, text = config
  const dispatch = { ...$,
    state: { ...$.state, get: async (ref: any) => snapshot.get(ref.key) ?? { value: undefined, version: 0 } },
    session: { ...$.session, id: async () => id },
    fs: { ...$.fs, read: async () => text },
  }
  return hook.hook(dispatch, e, async () => ({}))
}
const window = () => environment.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
const reload = () => fire('command.run', { command: 'klyth', args: 'reload' })
registration()
await fire('session.start')
equal(window(), '777000', 'default acquired on valid load')
equal(state.get('hostWindow')?.value, { original: null, applied: '777000' }, 'unset baseline saved')
await reload()
equal(writes.length, 1, 'identical reload writes no environment')
config = '{"compaction":{"hostWindow":800000}}'
await reload()
equal(window(), '800000', 'custom config applies live')
registration()
await fire('session.start')
equal(state.get('hostWindow')?.value, { original: null, applied: '800000' }, 'code reload preserves baseline')
config = '{}'
await reload()
equal(window(), '777000', 'removing custom section returns to default')
await fire('session.end', { reason: 'clear', sessionId })
state.clear(); sessionId = `fixture-${++sessionNumber}`
await fire('classic.SessionStart', { source: 'clear', session_id: sessionId })
config = '{"compaction":{"hostWindow":false}}'
await reload()
equal(window(), undefined, 'false after clear restores unset')
for (const broken of ['{"unknown":true}', undefined]) {
  config = '{}'; await reload()
  config = broken; await reload()
  equal(window(), undefined, 'invalid or missing config restores unset')
}
environment.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '900000')
config = '{}'; await reload()
registration(); await fire('session.start')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(window(), '900000', 'existing baseline survives code reload')
config = '{}'; await reload()
environment.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '600000')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(window(), '600000', 'independent write not clobbered')
equal(writes.every(name => ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'KLYTH_HOST_WINDOW_HANDOFF'].includes(name)), true, 'only window and transient handoff names written')
equal(environment.get('DISABLE_AUTO_COMPACT'), '1', 'auto disable unchanged')
equal(environment.get('DISABLE_COMPACT'), '1', 'compact disable unchanged')
equal(environment.get('MAX_CONTEXT_TOKENS'), '872000', 'full context environment unchanged')
equal(daemon.requests.length, 0, 'no inference requests')


const handoff = () => environment.get('KLYTH_HOST_WINDOW_HANDOFF')
async function fresh(initial: string | undefined, text = '{}') {
  state.clear()
  environment.delete('KLYTH_HOST_WINDOW_HANDOFF')
  if (initial === undefined) environment.delete('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  else environment.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', initial)
  sessionId = `fixture-${++sessionNumber}`
  config = text
  beforeStateWrite = undefined
  refuseSeed = failFinal = failHandoffConsume = failHandoffWrite = false
  registration()
  await fire('session.start')
}
async function leave(reason: 'clear' | 'resume') {
  await fire('session.end', { reason, sessionId })
  state.clear()
  sessionId = `fixture-${++sessionNumber}`
}
async function arrive(reason: 'clear' | 'resume') {
  await fire('classic.SessionStart', { source: reason, session_id: sessionId })
}

// Each clear/resume really disposes the old state map. A registration reload loses the coordinator too.
for (const initial of [undefined, '900000', ''] as const) {
  for (const reason of ['clear', 'resume'] as const) {
    for (const codeReload of [false, true]) {
      await fresh(initial)
      config = '{"compaction":{"hostWindow":666000}}'; await reload()
      await leave(reason)
      equal(JSON.parse(handoff()!).owner, { original: initial ?? null, applied: '666000' }, 'end transfers original and applied')
      if (codeReload) {
        registration()
        await fire('session.start')
      }
      await arrive(reason)
      equal(handoff(), undefined, 'successor consumes the exact handoff')
      config = '{"compaction":{"hostWindow":false}}'; await reload()
      equal(window(), initial, 'false after disposed state and optional code reload restores original')
    }
  }
}

// A successful no-op must invalidate an older dispatch, without touching the environment.
for (const initial of [undefined, '900000'] as const) {
  await fresh(initial, initial === undefined ? '{"compaction":{"hostWindow":false}}' : '{}')
  let paused!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { paused = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  beforeStateWrite = async value => {
    if (value?.pending && value.applied === '800000') { paused(); await held }
  }
  config = '{"compaction":{"hostWindow":800000}}'
  const older = reload()
  await entered
  const before = writes.length
  config = initial === undefined ? '{"compaction":{"hostWindow":false}}' : '{}'
  await reload()
  equal(writes.length, before, 'newer no-op performs no environment write')
  release(); await older
  equal(window(), initial === undefined ? undefined : '777000', 'newer false/default fences the older enabled/update dispatch')
  equal(writes.length, before, 'losing older dispatch performs no environment write')
  beforeStateWrite = undefined
}

// The end snapshot predates a paused admitted update: the coordinator drains it and fences its final version.
await fresh('900000')
let updatePaused!: () => void, releaseUpdate!: () => void
const updating = new Promise<void>(resolve => { updatePaused = resolve })
const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve })
beforeStateWrite = async value => { if (value?.pending && value.applied === '666000') { updatePaused(); await updateGate } }
config = '{"compaction":{"hostWindow":666000}}'
const oldUpdate = reload()
await updating
const ending = leave('clear')
releaseUpdate(); await oldUpdate; await ending
beforeStateWrite = undefined
await arrive('clear')
equal(state.get('hostWindow')?.value, { original: '900000', applied: '666000' }, 'end does not overwrite the admitted successor ownership')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(window(), '900000', 'racing end keeps the first baseline')

await fresh('900000')
failFinal = true
config = '{"compaction":{"hostWindow":666000}}'; await reload()
failFinal = false
await leave('resume')
registration(); await fire('session.start'); await arrive('resume')
equal(state.get('hostWindow')?.value, { original: '900000', applied: '666000', pending: true }, 'pending ownership crosses disposal and code reload intact')
const pendingWrites = writes.length
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(writes.length, pendingWrites, 'pending handoff never authorizes restoration')
equal(window(), '666000', 'pending outcome requires restart')

await fresh('900000')
await leave('clear')
const retained = handoff()
refuseSeed = true
await arrive('clear')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(handoff(), retained, 'failed seed retains handoff')
equal(window(), '777000', 'failed seed does not recapture or restore')
refuseSeed = false
await arrive('clear'); await arrive('clear')
equal(handoff(), undefined, 'successful and duplicate starts consume once')
await reload()
equal(window(), '900000', 'retry after failed seed uses the transferred original')

await fresh('900000')
await leave('clear')
failHandoffConsume = true
await arrive('clear')
equal(state.get('hostWindow')?.value, { original: '900000', applied: '777000' }, 'failed consume leaves ownership safely seeded')
equal(handoff() !== undefined, true, 'failed consume retains exact marker')
registration(); failHandoffConsume = false
config = '{"compaction":{"hostWindow":false}}'; await fire('session.start')
equal(window(), '900000', 'code reload finishes duplicate transfer without recapturing original')
equal(handoff(), undefined, 'duplicate transfer consumes retained marker')

await fresh('900000')
await leave('clear')
environment.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '600000')
await arrive('clear')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(window(), '600000', 'independent window after end is never restored over')

const unexpected = [
  'not json',
  'x'.repeat(8193),
  JSON.stringify({ sessionId: 'previous', reason: 'clear', owner: { original: null, applied: '0777000' } }),
  JSON.stringify({ sessionId: 'previous', reason: 'clear', owner: { original: null, applied: '777000', pending: false } }),
  JSON.stringify({ sessionId: 'previous', reason: 'clear', owner: { original: 'x'.repeat(1025), applied: '777000' } }),
]
for (const text of unexpected) {
  await fresh(undefined, '{"compaction":{"hostWindow":false}}')
  environment.set('KLYTH_HOST_WINDOW_HANDOFF', text)
  config = '{}'; await reload()
  equal(window(), undefined, 'malformed marker grants no ownership')
  equal(handoff(), text, 'malformed marker is not destructively consumed')
}
await fresh(undefined, '{"compaction":{"hostWindow":false}}')
const stale = JSON.stringify({ sessionId, reason: 'clear', owner: { original: null, applied: '777000' } })
environment.set('KLYTH_HOST_WINDOW_HANDOFF', stale)
config = '{}'; await reload()
equal(window(), undefined, 'same-session marker cannot seed ownership')
equal(handoff(), stale, 'same-session marker is retained for diagnosis')

await fresh('900000')
await leave('clear')
beforeStateWrite = async value => {
  if (value && !value.pending) environment.set('KLYTH_HOST_WINDOW_HANDOFF', 'independent marker')
}
await arrive('clear')
equal(handoff(), 'independent marker', 'observed independent marker is not consumed')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(window(), '777000', 'changed marker prevents further policy decisions')
beforeStateWrite = undefined

await fresh('900000')
await leave('resume')
await Promise.all([arrive('resume'), arrive('resume')])
equal(handoff(), undefined, 'concurrent duplicate starts transfer ownership only once')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(window(), '900000', 'concurrent duplicate seeds retain the original baseline')

await fresh('900000')
await leave('clear')
const conflicting = handoff()
state.set('hostWindow', { value: null, version: 1 })
await arrive('clear')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(state.get('hostWindow')?.value, null, 'handoff never overwrites a successor decision')
equal(handoff(), conflicting, 'unexpected successor state leaves the handoff for diagnosis')
equal(window(), '777000', 'unexpected successor state declines environment mutation')

await fresh('900000')
failHandoffWrite = true
const diagnosticsBeforeFailure = debug.length
await leave('clear')
await arrive('clear')
config = '{"compaction":{"hostWindow":false}}'; await reload()
equal(window(), '777000', 'failed handoff write leaves the owned environment unchanged')
equal(handoff(), undefined, 'failed handoff write cannot claim a saved baseline')
equal(state.get('hostWindow'), undefined, 'failed handoff write plus disposal leaves no engine baseline')
equal(debug.slice(diagnosticsBeforeFailure).some(text => text.includes('restart Claude Code')), true, 'failed handoff write requires restart with an explicit diagnostic')
failHandoffWrite = false

equal(daemon.requests.length, 0, 'all lifetime and concurrency tests avoid inference')
console.log(`PASS host window: ${assertions} behavioral assertions; disposed session state, clear/resume/reload handoff matrix, pending/failure/duplicate/independent markers and frozen no-op concurrency`)
