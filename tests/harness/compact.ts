// Drive real registration with engine-owned rows, own-plugin operation re-entry, an idle built-in
// command queue and atomic installation. The kit alone does not model these public noun boundaries.
declare const console: { log(text: string): void }
declare const Bun: { sleep(ms: number): Promise<void> }
const assert = {
  equal(a: unknown, b: unknown, why = 'values differ') { if (a !== b) throw new Error(why + `: ${String(a)} != ${String(b)}`) },
  match(text: string, pattern: RegExp) { if (!pattern.test(text)) throw new Error(`expected ${pattern}, got ${text}`) },
}

import { choiceFor, mainChoiceKey } from '../../hooks/main-choice'
import { createSession } from '../../hooks/session'
import { parseConfig } from '../../hooks/config'
import { register } from '../../hooks/register'
import { fakeDaemon } from '../daemon-fake'

type Hook = { event: string; matcher?: Record<string, unknown>; hook: any }
const config = JSON.stringify({ providers: { acme: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: 'none', models: { m: { contextWindow: 1_000_000, maxInputTokens: 872_000, maxOutputTokens: 128_000, maxTokensParam: 'max_completion_tokens' } } } }, aliases: { fast: 'acme/m' } })
const rows = () => Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text: `message ${i}`, toolUses: [], handle: `h${i}` }))
const stream = (text: string, tokens = 90) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: tokens, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`

async function scenario(options: { earlyClassic?: boolean; missingConfig?: boolean; coalesced?: boolean; auto?: boolean; cold?: boolean; restart?: boolean; migrate?: boolean; blocked?: boolean; resume?: boolean; disabled?: boolean; engineDisabled?: boolean; queuedDisabled?: boolean; queuedStale?: boolean; queuedRewind?: 'shrink' | 'edit'; fail?: boolean; stale?: boolean; busy?: boolean; toolReply?: boolean; projection?: boolean; storageFailure?: boolean } = {}) {
  const hooks: Hook[] = []
  const on: any = (event: string, a: any, b?: any) => { const h = b === undefined ? { event, hook: a } : { event, matcher: a, hook: b }; hooks.push(h); return { catch() {} } }
  register(on, {} as never)
  let history = rows(), active = false, heldCommand = false, native = 0, installs = 0, mode = options.auto ? 'step' : 'summary'
  if (options.coalesced) history.push({ role: 'user', text: '<local-command-stdout>ready</local-command-stdout>', toolUses: [], handle: 'stdout' })
  if (options.cold) history[0]!.text = 'cold oversized history '.repeat(150_000)
  if (options.projection) (history[1]!.toolUses as any[]).push({ tool_use_id: 'read', tool: 'Read', input: { path: '/fixture' } })
  const state = new Map<string, unknown>()
  const selected = createSession()
  selected.loaded.config = parseConfig(config).config!
  const store = new Map<string, unknown>((options.restart || options.migrate) ? [] : [[mainChoiceKey('fixture'), await choiceFor(selected, 'fixture', 'fast')]])
  let preparingRestart = options.restart === true
  const debug: string[] = [], lines: string[] = [], toasts: string[] = [], statuses: (string | undefined)[] = []
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const idleCommands: (() => Promise<unknown>)[] = []
  let commandQueued!: () => void
  const queuedCommand = new Promise<void>(resolve => { commandQueued = resolve })
  let compactSuffix: ReturnType<typeof rows>[number] | undefined
  let builtinCommands = 0, directOperations = 0
  let engineEnabled = !options.engineDisabled
  const visibleHistory = () => compactSuffix === undefined ? history : [...history, compactSuffix]
  const apiHistory = () => {
    if (!options.coalesced) return visibleHistory().map(({ role, text }) => ({ role, content: text }))
    return history.map(({ role, text }, i) => ({ role, content: i === history.length - 1 ? [
      { type: 'text', text: '/fixture-snapshot typed-seeded' },
      { type: 'text', text: text + (compactSuffix ? '\n' : '') },
      ...(compactSuffix ? [{ type: 'text', text: compactSuffix.text }] : []),
    ] : text }))
  }
  const daemon = fakeDaemon({ bun: '/opt/bin/bun', now: 0, helper: () => ({ exitCode: 0, stdout: '' }), log: text => void debug.push(text), upstream: () => options.toolReply && mode === 'summary' ? { pieces: [`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-summary', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`] } : options.fail && mode === 'summary' ? { status: 429, pieces: ['quota'] } : { pieces: [stream(mode === 'step' ? 'Turn done.' : 'Summary.\n<klyth-summary-complete>', mode === 'step' ? 790_000 : 90)] } })
  const signal = new AbortController().signal
  const find = (event: string, e: Record<string, unknown> = {}) => hooks.find(h => h.event === event && Object.entries(h.matcher ?? {}).every(([k, v]) => e[k] === v))!.hook
  const $: any = {
    plugin: { root: '/klyth', name: 'klyth' }, env: { get: async (n: string) => n === 'HOME' ? '/home/u' : undefined },
    fs: { exists: async (p: string) => !options.missingConfig && p.endsWith('klyth.json'), read: async () => config, stat: async () => ({ kind: 'dir', realPath: '/w' }) },
    settings: { read: async () => ({ autoCompactEnabled: !options.disabled && !preparingRestart && !options.migrate }) }, store: { get: async (key: string) => key.startsWith('trust:') ? true : store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } },
    state: { get: async (r: any) => ({ value: state.get(r.key) }), set: async (r: any, v: unknown) => { state.set(r.key, v); return { value: v } } },
    session: {
      version: async () => ({ version: '2.1.293' }), model: async () => 'native', cwd: async () => '/w', id: async () => 'fixture', usage: async (args: any) => ({ context: { tokens: options.migrate ? 900_000 : 0, window: 200_000, ...(args?.breakdown === 'summary' ? { breakdown: { mcpTools: [], isAutoCompactEnabled: engineEnabled } } : {}) } }),
      messages: async (args: any) => args?.as === 'api' ? apiHistory() : visibleHistory().map(({ handle: _handle, ...row }) => options.projection ? { text: row.text, role: row.role, toolUses: row.toolUses.map((use: any) => ({ ...use, text: 'completed result', result: { bytes: 5 } })), toolResults: [] } : row),
      // Public operations from Klyth skip that plugin's own hooks, including from clock callbacks.
      compact: async () => { directOperations++; native++; throw new Error('native weekly quota exhausted: own-plugin re-entry skipped') },
    },
    tool: { register: async () => ({}), list: async () => [] }, prompt: { compose: async () => ({ sections: [{ id: 'intro', text: 'SYSTEM' }] }) },
    command: { register: async () => ({}), run: async (e: any) => new Promise((resolve, reject) => { idleCommands.push(async () => {
      try {
        assert.equal(active, false, 'public command dispatch waits for idle')
        assert.equal(heldCommand, false, 'never await an idle command while its calling hook is held')
        if (e.command !== 'compact') {
          // A plugin's own command hook is skipped too: queueing /klyth cannot call our adapter.
          throw new Error('own-plugin command re-entry skipped')
        }
        builtinCommands++
        const old = history
        const instructions = e.args || undefined
        compactSuffix = { role: 'user', text: `/compact${instructions ? ` ${instructions}` : ''}`, toolUses: [], handle: 'command' }
        const done = await find('session.compact')($, { trigger: 'manual', instructions, messages: history }, Object.assign(async () => { native++; throw new Error('native weekly quota exhausted') }, { signal }))
        if (done.messages !== undefined) { history = done.messages; installs++ } else assert.equal(history, old)
        compactSuffix = undefined
        // Core owns the final notice; its CommandRunResult is not SessionCompactResult.
        lines.push(done.skip ?? 'Conversation compacted.')
        resolve({ text: 'localized engine output, not an outcome discriminator' })
      } catch (error) { reject(error) }
    }); commandQueued() }) },
    clock: { now: async () => 0, sleep: async (_ms: number, o: any) => new Promise<void>(resolve => o?.signal.addEventListener('abort', () => resolve())), after: (ms: number, fn: () => void) => { const t = { ms, fn, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true } } } },
    ui: { log: (text: string, o?: any) => void (o?.to === 'debug' ? debug : lines).push(text), toast: (text: string) => void toasts.push(text), status: (text: string | undefined) => { statuses.push(text) } },
    process: {
      run: async (argv: string[], o?: any) => (argv.some(a => a.endsWith('/scripts/compact-draft.ts')) ? { exitCode: options.storageFailure ? 1 : 0, stdout: '/home/u/.claude/klyth/compactions/fixture/draft.json', stderr: '' } : daemon.run(argv, o?.stdin)) ?? { exitCode: 0, stdout: argv[2]?.includes('bun') ? '/opt/bin/bun\n' : argv[2]?.includes('trash') ? '/opt/bin/trash\n' : argv[0]?.includes('uname') ? 'Darwin\n' : '', stderr: '' },
      spawn: async function* (e: any) { return yield* daemon.spawn(e.argv, e.input, signal)! },
    },
  }
  const command = async (args: string, origin = { kind: 'composer' } as any) => {
    heldCommand = true
    try { return await find('command.run', { command: 'klyth' })($, { command: 'klyth', args, origin }) } finally { heldCommand = false }
  }
  if (options.earlyClassic) {
    await find('classic.SessionStart')($, { source: 'resume' }, async () => ({}))
    assert.equal(toasts.length, 0, 'early classic must not validate a choice against unloaded config')
    assert.equal(timers.length, 0, 'early classic must not schedule automatic work')
  }
  await find('session.start')($, { cwd: '/w', surface: null }, async () => ({}))
  // The launcher timer does not queue a compaction command.
  timers.splice(timers.findIndex(t => t.ms === 0), 1)[0]?.fn()
  if (options.missingConfig) {
    assert.equal(toasts.some(text => text.includes('saved main route could not be restored')), true, 'loaded missing config still blocks saved route')
    assert.equal(state.get('main'), '!klyth-main-choice-blocked')
    assert.equal(daemon.requests.length, 0)
    return
  }
  if (options.earlyClassic) {
    assert.equal(state.get('main'), 'fast', 'start restores the configured durable route')
    assert.equal(toasts.length, 0, 'valid startup emits no false restore failure')
  }
  if (options.restart) {
    const chosen = await find('command.run', { command: 'model' })($, { command: 'model', args: 'fast' }, async () => { throw new Error('selection must not call native') })
    assert.match(chosen.text, /Set model to fast/)
    await find('session.end')($, {}, async () => ({}))
    state.clear()
    hooks.length = 0
    register(on, {} as never)
    preparingRestart = false
    await find('session.start')($, { cwd: '/w', surface: null }, async () => ({}))
    // The launcher timer does not queue a compaction command.
    timers.splice(timers.findIndex(t => t.ms === 0), 1)[0]?.fn()
    assert.equal(state.get('main'), 'fast', 'fresh registration restores from durable store before scheduling')
  }
  if (options.migrate) {
    assert.equal(state.get('main'), undefined, 'legacy session without a saved choice starts native')
    const chosen = await find('command.run', { command: 'model' })($, { command: 'model', args: 'fast' }, async () => { throw new Error('selection must not call native') })
    assert.match(chosen.text, /Set model to fast.*\n.*run \/compact before continuing/)
    assert.equal(state.get('main'), 'fast')
    assert.equal((store.get(mainChoiceKey('fixture')) as any).label, 'fast', 'large selection persists before compaction')
    assert.equal(daemon.requests.length, 0, 'selecting a route never sends a provider request')
    const normal = find('turn.step')($, { turnId: 'migration', index: 0, model: 'native', messageCount: 12 }, { signal })
    let step
    do { step = await normal.next() } while (!step.done)
    assert.match(step.value.answer, /95% safety threshold/)
    assert.equal(daemon.requests.length, 0, 'large normal request still refuses before any provider send')
    await find('turn.complete')($, { turnId: 'migration', answer: 'blocked', durationMs: 1, isAborted: false }, async () => ({}))
    assert.match((await command('compact preserve migration restrictions')).text, /queued/)
  }
  if (options.resume) {
    await find('session.end')($, {}, async () => ({}))
    await find('classic.SessionStart')($, { source: 'resume' }, async () => ({}))
  }
  if (options.auto && (!options.cold || options.blocked)) {
    active = true
    const gen = find('turn.step')($, { turnId: 't', index: 0, model: 'native', messageCount: 12 }, { signal })
    while (!(await gen.next()).done) {}
    if (options.blocked) assert.equal(daemon.requests.length, 0, 'cold oversized normal step is blocked before a paid send')
    await find('turn.complete')($, { turnId: 't', answer: 'done', durationMs: 1, isAborted: false }, async () => ({}))
    assert.equal(installs, 0)
    active = false; mode = 'summary'
  } else if (!options.cold) {
    assert.match((await command('compact keep restrictions')).text, /queued/)
    assert.match((await command('compact')).text, /already/)
  }
  if (options.cold) mode = 'summary'
  if (options.stale) await find('prompt.submit')($, { text: 'new request', origin: { kind: 'composer' } }, async (e: any) => e)
  if (options.busy) active = true
  // Run callbacks after the hook returns; public command.run waits until idle before its hook starts.
  for (let i = 0; i < timers.length; i++) {
    const timer = timers[i]!
    if (timer.ms !== 0 || timer.cancelled) continue
    timer.fn()
    if (!options.disabled && !options.engineDisabled && !options.stale) await queuedCommand
    if (options.busy && idleCommands.length > 0) {
      assert.equal(installs, 0, 'compaction remains queued during the racing turn')
      active = false
    }
    if (options.queuedDisabled && idleCommands.length > 0) engineEnabled = false
    if (options.queuedRewind && idleCommands.length > 0) history = options.queuedRewind === 'shrink' ? history.slice(0, 10) : history.map((m, i) => i === 0 ? { ...m, text: 'edited while waiting for idle' } : m)
    if (options.queuedStale && idleCommands.length > 0) await find('prompt.submit')($, { text: 'changed while waiting for idle', origin: { kind: 'composer' } }, async (e: any) => e)
    for (const queued of idleCommands.splice(0)) await queued()
    await Bun.sleep(20)
  }
  assert.equal(native, 0)
  assert.equal(directOperations, 0)
  const succeeds = !options.disabled && !options.engineDisabled && !options.queuedDisabled && !options.queuedStale && !options.queuedRewind && !options.fail && !options.stale && !options.toolReply && !options.storageFailure
  assert.equal(installs, succeeds ? 1 : 0)
  if (succeeds) {
    assert.match(history[0]!.text, /context data/)
    assert.equal(history[1]!.handle, options.coalesced ? 'h7' : 'h6')
    assert.equal(toasts.some(text => text.includes('/compactions/fixture/draft.json')), true, 'saved draft path is visible')
    assert.equal(lines.at(-1), 'Conversation compacted.')
    assert.equal(lines.filter(text => text === 'Conversation compacted.').length, 1, 'core final notice is not duplicated')
    assert.equal(builtinCommands, 1)
    assert.equal(daemon.requests.at(-1)!.body['max_completion_tokens'], 8000)
    assert.equal(daemon.requests.at(-1)!.body['tools'], undefined)
  }
  if (succeeds || options.fail || options.toolReply) {
    assert.equal(statuses.some(text => text?.includes('Compacting ')), true, 'registered main progress is pinned')
    assert.equal(statuses.at(-1), 'fast · acme', 'normal route status restored')
    assert.equal(timers.filter(t => t.ms === 1000).every(t => t.cancelled), true, 'progress heartbeat released')
    assert.equal(lines.some(text => text.includes('Compacting ')), false, 'progress never appends transcript lines')
    assert.equal(debug.some(text => text.includes(options.cold ? 'large-history summary' : 'conversation summary')), true, 'path milestone stays in debug only')
  }
  if (options.fail) {
    assert.equal(daemon.requests.length, options.auto ? 2 : 1)
    assert.match(lines.at(-1)!, /history kept/)
    await find('turn.complete')($, { turnId: 't2', answer: 'done', durationMs: 1, isAborted: false }, async () => ({}))
    assert.equal(timers.filter(t => t.ms === 0).length, 1, 'cooldown prevents another automatic attempt')
  }
  if (options.queuedRewind) {
    assert.match(lines.at(-1)!, /stale/)
    assert.equal(daemon.requests.length, options.auto && !options.cold ? 1 : 0, 'rewind at actual dispatch rejects before summarization')
  }
  if (options.storageFailure) { assert.match(lines.at(-1)!, /private draft storage failed/); assert.match(lines.at(-1)!, /history kept/) }
  if (options.toolReply) { assert.equal(daemon.requests.length, 1); assert.match(lines.at(-1)!, /history kept/) }
}

for (const [name, options] of [
  ['early classic before config load restores once and auto installs coalesced API history', { earlyClassic: true, auto: true, cold: true, coalesced: true }],
  ['loaded missing config still blocks saved choice after early classic', { earlyClassic: true, missingConfig: true }],
  ['coalesced cold queued auto still rejects a genuine earlier-row edit', { auto: true, cold: true, coalesced: true, queuedRewind: 'edit' }],
  ['manual instruction-bearing coalesced compact installs through public dispatch', { coalesced: true }],
  ['legacy oversized history permits explicit durable selection, blocks normal sends and supports manual compaction', { cold: true, migrate: true }],
  ['manual deferred public operation, instructions and coalescing', {}],
  ['auto queues outside active turn before the 95% guard', { auto: true }],
  ['fresh registration restores explicit selection and compacts cold history after enabling auto', { auto: true, cold: true, restart: true }],
  ['cold restored history queues automatic compaction at the first safe idle boundary', { auto: true, cold: true }],
  ['cold oversized normal step sends nothing then replaces stale startup work at idle', { auto: true, cold: true, blocked: true }],
  ['classic resume reestimates history and queues outside its hook', { auto: true, cold: true, resume: true }],
  ['late classic resume respects disabled automatic compaction', { auto: true, cold: true, resume: true, disabled: true }],
  ['cold automatic disabled setting dispatches nothing', { auto: true, cold: true, disabled: true }],
  ['auto disabled by user setting', { auto: true, disabled: true }],
  ['auto failure retains history with cooldown and no native fallback', { auto: true, fail: true }],
  ['manual route/history snapshot becomes stale before callback', { stale: true }],
  ['built-in compact waits for a racing active turn to become idle', { busy: true }],
  ['manual queued operation rejects stale history at actual core dispatch', { queuedStale: true }],
  ['automatic queued operation rejects stale history at actual core dispatch', { auto: true, queuedStale: true }],
  ['queued manual shrink is detected without a rewind event', { queuedRewind: 'shrink' }],
  ['queued automatic same-count edit rejects before a paid summary', { auto: true, queuedRewind: 'edit' }],
  ['auto disabled by effective public engine switch', { auto: true, engineDisabled: true }],
  ['auto disabled while waiting for idle refuses at core dispatch', { auto: true, queuedDisabled: true }],
  ['public getter projection enrichment preserves handled installation', { projection: true }],
  ['private draft storage failure retains the active conversation', { storageFailure: true }],
  ['a summarizer tool call never executes or installs a replacement', { toolReply: true }],
] as const) {
  await scenario(options)
  console.log(`PASS ${name}`)
}
