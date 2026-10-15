// Real registration and private storage with a synthetic host; no provider requests or fixture deletion.
import { register } from '../../hooks/register'
import type { RecoveryRecord } from '../../hooks/delivery-recovery'
import { fakeDaemon } from '../daemon-fake'

declare const console: { log(text: string): void }
let assertions = 0
function equal(actual: unknown, expected: unknown, why: string): void {
  assertions++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}
// Keep Node/Bun fixture types out of the host-only TypeScript project.
const fixtureModule = '../../klythd/fixtures/recovery-harness.ts'
const fixture: { configDir: string; root: string; records(sessionId: string): RecoveryRecord[]; run(stdin: string): { exitCode: number; stdout: string; stderr: string } } = (await import(fixtureModule)).recoveryFixture()
const { configDir, root } = fixture
const hooks: { event: string; matcher?: Record<string, unknown>; hook: any; catcher?: any }[] = []
const state = new Map<string, { value: unknown; version: number }>(), env = new Map([['HOME', configDir], ['CLAUDE_CONFIG_DIR', configDir]])
const logs: string[] = [], toasts: string[] = [], asks: string[] = [], appends: any[] = []
let sessionId = 'session-main', config = '{}', forwarded = 0, allow = true, answer = 'Confirm', appendRefused = false, failReceipt = false
let agents = [{ id: 'child', description: 'local child', type: 'fixture', status: 'running' }, { id: 'peer', description: 'local peer', type: 'fixture', status: 'running' }]
const daemon = fakeDaemon({ bun: '/fixture/bun', now: 0, helper: () => ({ exitCode: 0, stdout: '' }), log: text => { logs.push(text) }, upstream: () => { throw new Error('recovery must not request a provider') } })
const records = () => fixture.records(sessionId)
let beforeOriginal: (() => void) | undefined
let throwOriginal = false, failCapture = false
const $: any = {
  plugin: { root, name: 'klyth' },
  env: { get: async (name: string) => env.get(name), set: async (name: string, value: string | undefined) => { if (value === undefined) env.delete(name); else env.set(name, value) } },
  state: {
    get: async (ref: any) => { equal(ref.plugin, 'klyth', 'state reads belong to Klyth'); return state.get(ref.member === undefined ? ref.key : `${ref.key}:${ref.member}`) ?? { value: undefined, version: 0 } },
    set: async (ref: any, value: unknown, options?: { ifVersion: number }) => {
      equal(ref.plugin, 'klyth', 'state writes belong to Klyth')
      const key = ref.member === undefined ? ref.key : `${ref.key}:${ref.member}`, version = state.get(key)?.version ?? 0
      if (options && options.ifVersion !== version) return { isSet: false, version }
      state.set(key, { value, version: version + 1 }); return { isSet: true, version: version + 1 }
    },
  },
  fs: { exists: async (path: string) => path.endsWith('/klyth.json') || (path.includes('/klyth/delivery-recovery/') && records().length > 0), read: async () => config, write: async () => {} },
  settings: { read: async () => ({ autoCompactEnabled: false }) },
  store: { get: async () => undefined, set: async () => { throw new Error('no message bodies in plugin store') } },
  agent: { list: async () => agents },
  session: {
    id: async () => sessionId, version: async () => ({ version: '2.1.296' }), model: async () => 'sonnet', cwd: async () => '/fixture',
    usage: async () => ({ context: { tokens: 0, window: 1_000_000 } }),
    append: async (input: any) => { if (appendRefused) return { deny: 'stopped' }; appends.push(input); return { uuid: `plugin-row-${appends.length}`, message: input.message } },
  },
  command: { register: async () => ({}) }, tool: { register: async () => ({}) },
  ui: { log: (text: string) => { logs.push(text) }, toast: (text: string) => { toasts.push(text) }, status: () => {}, invalidate: () => {}, ask: async (question: string) => { asks.push(question); if (answer === 'headless') throw new Error('no interactive surface'); return answer } },
  clock: { now: async () => 0, sleep: async () => {}, after: () => ({ cancel() {} }) },
  process: {
    run: async (argv: string[], options?: any) => {
      if (argv.some(part => part.endsWith('/scripts/delivery-recovery.ts'))) {
        if ((failReceipt && JSON.parse(options.stdin).action === 'finish') || (failCapture && JSON.parse(options.stdin).action === 'capture')) return { exitCode: 1, stdout: '', stderr: 'simulated receipt failure' }
        return fixture.run(options.stdin)
      }
      return daemon.run(argv, options?.stdin) ?? { exitCode: 0, stdout: argv[2]?.includes('bun') ? '/fixture/bun\n' : '', stderr: '' }
    },
    spawn: async function* (input: any) { return yield* daemon.spawn(input.argv, input.input, new AbortController().signal)! },
  },
}
function registration() {
  hooks.length = 0
  const on: any = (event: string, a: any, b?: any) => {
    const record = b ? { event, matcher: a, hook: b, catcher: undefined as any } : { event, hook: a, catcher: undefined as any }
    hooks.push(record); return { catch(fn: any) { record.catcher = fn } }
  }
  register(on, {} as never)
}
async function fire(event: string, input: any = {}) {
  const hook = hooks.find(item => item.event === event && Object.entries(item.matcher ?? {}).every(([key, value]) => input[key] === value))
  if (!hook) throw new Error(`no ${event} hook`)
  let pending: Promise<any> | undefined
  const next: any = (e: any) => pending ??= (async () => {
    next.called = true
    if (event === 'tool.call') { equal(e, input, 'original tool arguments unchanged'); forwarded++; beforeOriginal?.(); if (throwOriginal) throw new Error('original interrupted'); return allow ? { result: { success: true, message: "Message queued for the main conversation's next turn." }, text: 'Message queued', isReadOnly: true } : { deny: 'ordinary permission refusal' } }
    return event === 'session.start' ? { cwd: '/fixture' } : {}
  })()
  next.origin = { plugin: 'engine', tier: 'core' }; next.signal = new AbortController().signal
  try { return await hook.hook($, input, next) }
  catch (error) { if (!hook.catcher) throw error; next.error = error; return hook.catcher($, input, next) }
}
const send = (id: string, to = 'main', message = 'same private text', agentId: string | undefined = 'child') => fire('tool.call', { tool: 'SendMessage', tool_use_id: id, agentId, to, message })
const command = (args: string) => fire('command.run', { command: 'klyth', args })
registration()
await fire('session.start', { cwd: '/fixture', surface: null, isInteractive: false })
beforeOriginal = () => equal(records().length, 1, 'write-ahead backup precedes original send')
await send('tool-1'); beforeOriginal = undefined
await send('tool-2')
equal(forwarded, 2, 'one normal forward per call')
equal(records().length, 2, 'identical texts retain separate call identities')
equal(records().every(item => item.outcome === 'queued'), true, 'queued is an observation, not delivery receipt')
await send('tool-1'); equal(records().length, 2, 'same-call idempotency')
await send('child-recipient', 'peer', 'peer-only', undefined)
equal(records().find(item => item.backup.text === 'peer-only')!.backup.recipient, 'peer', 'recipient rather than sender namespace')
await send('uncovered', 'friendly-name'); equal(records().length, 3, 'ambiguous recipient not captured'); equal(forwarded, 5, 'uncovered original still forwards')
allow = false; await send('refused'); allow = true
equal(records().find(item => item.backup.toolUseId === 'refused')!.outcome, 'refused', 'normal permission refusal retained')
const id = records()[0]!.backup.id
await command(`recovery show ${id}`); equal(appends.length, 0, 'UI-only preview has no append'); equal(asks.length, 0, 'preview has no consent dialog')
answer = 'headless'; await command(`recovery restore ${id}`); equal(appends.length, 0, 'headless cannot approve'); equal(records()[0]!.attempts.length, 0, 'headless has no attempt claim')
answer = 'Cancel'; await command(`recovery restore ${id}`); equal(appends.length, 0, 'cancellation is a no-op')
answer = 'Confirm'; await command(`recovery restore ${id}`)
equal(appends.length, 1, 'one explicitly confirmed copy'); equal(appends[0].agentId, undefined, 'main copy stays main')
equal(appends[0].message.content[0].text.includes(`[klyth-recovery:${id}]`), true, 'labeled plugin context marker')
equal(records()[0]!.attempts[0]!.uuid, 'plugin-row-1', 'new append UUID retained separately')
await command(`recovery restore ${id}`); equal(appends.length, 1, 'completed receipt blocks replay')
const peerRecord = records().find(item => item.backup.recipient === 'peer')!
await command(`recovery restore ${peerRecord.backup.id}`); equal(appends[1].agentId, 'peer', 'exact child recipient retained')
const uncertain = records().find(item => item.backup.toolUseId === 'tool-2')!
failReceipt = true; await command(`recovery restore ${uncertain.backup.id}`); failReceipt = false
const copyCount = appends.length
equal(records().find(item => item.backup.id === uncertain.backup.id)!.attempts[0]!.status, 'unknown', 'append/receipt interruption leaves uncertainty')
await command(`recovery restore ${uncertain.backup.id}`); equal(appends.length, copyCount, 'same-lifetime unresolved attempt never repeats')
const noticeBefore = toasts.length
registration(); await fire('session.start', { cwd: '/fixture', surface: null, isInteractive: false }); equal(toasts.length, noticeBefore, 'hot reload does not multiply notice')
env.delete('KLYTH_DELIVERY_RECOVERY_EPOCH'); state.delete('recoveryNotice'); registration()
await fire('session.start', { cwd: '/fixture', surface: null, isInteractive: false })
equal(appends.length, copyCount, 'resume never automatically appends')
equal(toasts[toasts.length - 1]!.includes('1 current-session'), true, 'resume count excludes refused/restored records')
equal(toasts[toasts.length - 1]!.includes('same private text'), false, 'notice excludes message bodies')
const asksBefore = asks.length
await command(`recovery restore ${uncertain.backup.id}`)
equal(asks.length, asksBefore + 2, 'uncertain retry has an additional duplicate-risk confirmation')
sessionId = 'cleared-session'; await fire('classic.SessionStart', { agent_id: undefined })
equal(records().length, 0, 'clear does not import other session evidence')
const countBefore = forwarded
config = '{"compaction":{"deliveryRecovery":false}}'; await send('disabled'); equal(forwarded, countBefore + 1, 'opt-out send preserved'); equal(records().length, 0, 'explicit opt-out')
config = '{"compaction":{"deliveryRecovery":"invalid"}}'; await send('invalid-config'); equal(records().length, 0, 'invalid config disables capture')
config = '{}'; await send('enabled-again'); equal(records().length, 1, 'removing opt-out restores default capture through validated config loader')
await command(`recovery dismiss ${records()[0]!.backup.id}`); equal(records()[0]!.dismissed, true, 'dismissal receipt retained'); equal(records()[0]!.backup.text, 'same private text', 'dismissal preserves bytes')
const beforeFailure = forwarded
throwOriginal = true
try { await send('interrupted-original') } catch { /* The original tool exception remains observable. */ }
throwOriginal = false
equal(forwarded, beforeFailure + 1, 'original exception never duplicates forwarding')
equal(records().find(item => item.backup.toolUseId === 'interrupted-original')!.outcome, 'unknown', 'interrupted original has no queue receipt')
const beforeDiskFailure = records().length
failCapture = true; await send('disk-failure'); failCapture = false
equal(records().length, beforeDiskFailure, 'failed publication adds no fabricated backup')
equal(forwarded, beforeFailure + 2, 'failed publication does not block original')
await send('oversized', 'main', 'x'.repeat(65_537))
equal(records().length, beforeDiskFailure, 'oversize never silently truncates')
equal(forwarded, beforeFailure + 3, 'oversize still forwards unchanged')
equal(daemon.requests.length, 0, 'no inference requests')
console.log(`delivery-recovery harness: ${assertions} assertions passed; fixtures preserved`)
