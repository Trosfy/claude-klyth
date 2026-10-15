// Klyth: routes the main conversation (`/model <alias>`) and subagents (the `mcp__klyth__agent` tool) to
// remote providers, answering their turn.step requests itself through the backend. Native requests pass
// through untouched. The composition root builds the ports each module works through and wires them
// to engine events (`$`) over one Session of memory.
import type { EngineInterface, Register } from 'claude-code'

import { createBackend } from './backend'
import { autoEnabled, createCompactAdapter, type CompactEnginePort } from './compact-adapter'
import { saveCompactDraft } from './compact-draft'
import { compactRows } from './compact-snapshot'
import type { Host } from './backend'
import { delivered } from './cache-history'
import { createHostWindowCoordinator, type HostWindowLifetimePort } from './host-window-lifetime'
import { APPROVAL_PANE } from './classifier-approval'
import { renderApprovalPane } from './classifier-approval-pane'
import { classifyDenied, consumeToken, countSteps, dropTokens, noteCheck, noteMode, notePrompt, plainAsk, turnDone, type ClassifierPort, type Check } from './classifier'
import { dropCall, inheritSpawn, noteCall, type InheritPort } from './inherit'
import { ended, leftNote } from './leave'
import { configDirectory, loadConfig, reload, type LoadPort, type ReloadPort } from './load'
import { currentContext } from './request'
import { persistMainChoice, restoreMainChoice, type MainChoicePort } from './main-choice'
import { asCommand, modelCommand, modelFailed, modelSwitched, type ModelPort } from './model'
import { guard, guardFailed } from './pool'
import type { PromptsPort } from './prompts'
import type { Backend } from './protocol'
import { stepFailed, turnStep, WRAPPER, type RouteStore, type Say, type Sleeper, type StepIo, type Transcripts } from './routing'
import { createSession, type Session } from './session'
import { AGENT_INTERNAL, agentCall, completed, untranslated, type AgentPort, type AgentTypes } from './spawn'
import { clearRecord, viaCommand, type RecordPort } from './statusline'
import { isTrusted, type TrustPort } from './trust'
import { report, showStatus, type ReportPort, type StatusPort } from './ui'
import { findTrash, type WorktreePort } from './worktree'
import { registerObservations } from './recovery-register'
import { createRecovery, type RecoveryPort } from './recovery-lifetime'
import { recoveryJournal } from './recovery-storage'
import { createUsageLifetime, UsageOwnershipConflict, type UsagePort } from './usage-lifetime'
import { usageCommand } from './usage-view'
import { validTranscriptPath } from './usage-retention'
import { validateUsageEnvelope } from './usage-ledger-codec'
import { changeUsagePane, openUsagePane, renderUsagePane } from './usage-pane'
import { runKlythCommand } from './klyth-command'
import { extraClient } from './extras'
import { scheduleLauncher, type LauncherPort } from './launcher-session'
import { createSetupSession } from './setup-session'
import { renderSetupPane, SETUP_PANE } from './setup-pane'
import { resolve } from './names'

const MAIN = { plugin: 'klyth', key: 'main' } as const
const MAIN_PIN = { plugin: 'klyth', key: 'mainPin' } as const
const ROUTED = { plugin: 'klyth', key: 'routed' } as const
const TRANSLATED = { plugin: 'klyth', key: 'translated' } as const
const USAGE = { plugin: 'klyth', key: 'usage' } as const
const SEAMS = { plugin: 'klyth', key: 'seams' } as const
const USAGE_PANE_STATE = { plugin: 'klyth', key: 'usagePane' } as const

const debug = ($: EngineInterface, text: string) => $.ui.log(text, { to: 'debug' })
const say = ($: EngineInterface): Say => ({ toast: text => $.ui.toast(text), debug: text => debug($, text) })
const launcherPort = ($: EngineInterface): LauncherPort => ({
  root: $.plugin.root,
  home: async () => (await $.env.get('HOME')) ?? '', path: async () => (await $.env.get('PATH')) ?? '',
  version: async () => { const value = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))); return value.version },
  exists: path => $.fs.exists(path), read: async path => String(await $.fs.read(path)), run: (argv, options) => $.process.run(argv, options),
  ...say($),
})
const recordPort = ($: EngineInterface): RecordPort => ({
  home: async () => (await $.env.get('HOME').catch(() => undefined)) ?? '',
  sessionId: () => $.session.id(),
  write: (path, text) => $.fs.write(path, text),
  run: run($),
  debug: text => debug($, text),
})
const statusPort = ($: EngineInterface): StatusPort => ({ status: text => $.ui.status(text), ...recordPort($) })

const compactEngine = ($: EngineInterface, s: Session): CompactEnginePort => ({
  status: text => $.ui.status(text),
  restoreStatus: () => { void showStatus(statusPort($), s) },
  engineModel: () => $.session.model(),
  estimate: preparation => currentContext({ ...stepIo($), ...routeStore($), engineModel: () => $.session.model() }, s, preparation),
  rows: agentId => compactRows(args => $.session.messages(args), agentId),
  saveDraft: draft => saveCompactDraft({ root: $.plugin.root, configDir: () => configDir($), sessionId: () => $.session.id(), run: (argv, init) => $.process.run(argv, init) }, draft),
  after: (ms, fn) => $.clock.after(ms, fn),
  enabled: valid => autoEnabled(async () => (await $.settings.read()).autoCompactEnabled !== false, async () => (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.isAutoCompactEnabled !== false, valid),
  run: instructions => $.command.run({ command: 'compact', args: instructions }),
  log: text => $.ui.log(text),
  ...say($),
})

const configDir = ($: EngineInterface) => configDirectory(() => $.env.get('CLAUDE_CONFIG_DIR'), () => $.env.get('HOME'))

// The scope klythd keeps this session's provider metadata under (its transcript: the one given, else the usage record's, which a reload keeps); none, said once, while the config dir is not absolute.
const bindSession = async ($: EngineInterface, s: Session, id: string, transcript?: string) => {
  const dir = await configDir($)
  s.transcriptPath = transcript ?? validateUsageEnvelope((await $.state.get(USAGE).catch(() => undefined))?.value)?.sessions.find(x => x.id === id)?.transcript?.path
  s.hostSession = dir.startsWith('/') ? { configDir: dir, id, ...(validTranscriptPath(s.transcriptPath) ? { transcript: s.transcriptPath } : {}) } : undefined
  if (s.hostSession === undefined) debug($, 'klyth: CLAUDE_CONFIG_DIR is not an absolute path, so klythd holds this session\'s response records in memory only')
}

// A routed child's cache-history opening is kept in host state, bound to its session, so a reload that clears memory does not end its repaired resume; one memory dropped (a compaction, a changed history) is saved as null by the hook that dropped it, so no later registration repairs from the stale copy.
const saveSeams = async ($: EngineInterface, s: Session, who: unknown, onlyDropped = false, mark = typeof who === 'string' ? s.cacheHistory.invalidated(who) : undefined) => {
  const opening = typeof who !== 'string' || (onlyDropped && mark === undefined) ? undefined : s.cacheHistory.snapshot(who) ?? (mark === undefined ? undefined : null)
  if (opening !== undefined) await $.session.id().then(sessionId => $.state.set({ ...SEAMS, id: who as string }, { version: 1, sessionId, opening })).then(() => s.cacheHistory.saved(who as string, mark), err => debug($, `klyth seams: could not save the opening of ${String(who)} (${String(err)})`))
}
const rejectedSeams = new WeakMap<Session, Set<string>>() // per registration: the loops whose saved opening was refused, read and said once
const restoreSeams = async ($: EngineInterface, s: Session, who: unknown, rejected = rejectedSeams.get(s) ?? rejectedSeams.set(s, new Set()).get(s)!, epoch = s.cacheHistory.epoch()) => {
  if (typeof who !== 'string' || s.cacheHistory.tracked(who) || s.cacheHistory.invalidated(who) || rejected.has(who)) return
  try {
    const saved = (await $.state.get({ ...SEAMS, id: who })).value
    if (saved === undefined || saved.opening === null) return
    if (saved.sessionId !== await $.session.id()) throw new Error('it belongs to another session')
    if (s.cacheHistory.epoch() === epoch && !s.cacheHistory.tracked(who)) s.cacheHistory.restore(who, saved.opening)
  } catch (err) { rejected.add(who); debug($, `klyth seams: ${who} proceeds without its saved opening (${String(err)})`) }
}

const run = ($: EngineInterface) => async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
  try {
    return await $.process.run(argv, opts)
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
  }
}

const host = ($: EngineInterface, s: Session): Host => ({
  run: (argv, init) => $.process.run(argv, init),
  spawn: req => $.process.spawn(req),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  debug: text => debug($, text),
  root: $.plugin.root,
  session: s.hostSession,
})

const loadPort = ($: EngineInterface): LoadPort => ({
  configDir: () => configDir($),
  home: async () => (await $.env.get('HOME').catch(() => undefined)) ?? '',
  exists: path => $.fs.exists(path),
  read: async path => String(await $.fs.read(path)),
  policy: () => $.settings.read({ source: 'policy' }),
})

const recoveryPort = ($: EngineInterface): RecoveryPort => ({
  sessionId: () => $.session.id(), agents: () => $.agent.list(), loaded: () => loadConfig(loadPort($)),
  storage: request => recoveryJournal({ root: $.plugin.root, configDir: () => configDir($), sessionId: () => $.session.id(), exists: path => $.fs.exists(path), run: (argv, init) => $.process.run(argv, init) }, request),
  log: text => $.ui.log(text), toast: text => $.ui.toast(text), debug: text => $.ui.log(text, { to: 'debug' }),
  ask: question => $.ui.ask(question, { header: 'Klyth recovery', options: ['Cancel', 'Confirm'] }),
  append: (text, recipient) => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, ...(recipient === 'main' ? {} : { agentId: recipient }) }),
  epoch: () => $.env.get('KLYTH_DELIVERY_RECOVERY_EPOCH'), setEpoch: value => $.env.set('KLYTH_DELIVERY_RECOVERY_EPOCH', value),
  notice: () => $.state.get({ plugin: 'klyth', key: 'recoveryNotice' }),
  setNotice: (value, ifVersion) => $.state.set({ plugin: 'klyth', key: 'recoveryNotice' }, value, { ifVersion }),
})

const hostWindowPort = ($: EngineInterface): HostWindowLifetimePort => ({
  sessionId: () => $.session.id(),
  environment: () => $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'),
  setEnvironment: value => $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', value),
  state: () => $.state.get({ plugin: 'klyth', key: 'hostWindow' }),
  setState: (value, ifVersion) => $.state.set({ plugin: 'klyth', key: 'hostWindow' }, value, { ifVersion }),
  handoff: () => $.env.get('KLYTH_HOST_WINDOW_HANDOFF'),
  setHandoff: value => $.env.set('KLYTH_HOST_WINDOW_HANDOFF', value),
  debug: text => $.ui.log(text, { to: 'debug' }),
})

const usagePort = ($: EngineInterface): UsagePort => ({
  sessionId: () => $.session.id(),
  now: () => $.clock.now(),
  transcriptExists: path => $.fs.exists(path),
  state: async () => { const saved = await $.state.get(USAGE); return { value: saved.value, version: saved.version } },
  setState: async (value, ifVersion) => {
    const result = await $.state.set(USAGE, value, { ifVersion })
    if (!result.isSet) throw new UsageOwnershipConflict('usage state version changed')
    return result.version
  },
  storeGet: key => $.store.get(key),
  storeSet: async (key, value) => { await $.store.set(key, value) },
  after: (ms, fn) => $.clock.after(ms, fn),
  context: async () => { try { return (await $.session.usage()).context.tokens } catch { return undefined } },
  log: text => $.ui.log(text),
})

const reloadPort = ($: EngineInterface, window: ReturnType<typeof createHostWindowCoordinator>): ReloadPort => ({
  ...loadPort($),
  pluginRoot: $.plugin.root,
  version: async () => (await $.session.version().catch(() => undefined))?.version,
  registerAgentTool: async (description, inputSchema) => void (await $.tool.register({ name: 'agent', description, inputSchema })),
  toast: text => $.ui.toast(text),
  hostWindow: value => window.apply(hostWindowPort($), value),
})

const trustPort = ($: EngineInterface): TrustPort => ({
  trusted: async key => (await $.store.get(key)) === true,
  remember: key => $.store.set(key, true),
  ask: (question, options) => $.ui.ask(question, { header: 'klyth', options: [...options] }),
})

const worktreePort = ($: EngineInterface): WorktreePort => ({
  run: run($),
  cwd: () => $.session.cwd(),
  toast: text => $.ui.toast(text),
  log: text => $.ui.log(text),
  debug: text => debug($, text),
})

const promptsPort = ($: EngineInterface): PromptsPort => ({
  compose: async (model, tools) => (await $.prompt.compose({ model, tools: [...tools] })).sections,
  cwd: () => $.session.cwd(),
  configDir: () => configDir($),
  exists: path => $.fs.exists(path),
  read: async path => String(await $.fs.read(path)),
  listDir: async dir => ((await $.fs.exists(dir)) ? $.fs.list(dir) : []),
  run: run($),
  now: () => $.clock.now(),
  debug: text => debug($, text),
})

const routeStore = ($: EngineInterface): RouteStore => ({
  main: async () => (await $.state.get(MAIN)).value,
  setMain: async target => void (await $.state.set(MAIN, target)),
  pin: async () => (await $.state.get(MAIN_PIN)).value,
  setPin: async pin => void (await $.state.set(MAIN_PIN, pin)),
  route: async agentId => (await $.state.get({ ...ROUTED, id: agentId })).value,
  setRoute: async (agentId, route) => void (await $.state.set({ ...ROUTED, id: agentId }, route)),
  translated: async who => (await $.state.get({ ...TRANSLATED, id: who })).value,
  setTranslated: async (who, calls) => void (await $.state.set({ ...TRANSLATED, id: who }, calls)),
})

// The agent type the engine lists a subagent as, which it started it as.
const agentTypes = ($: EngineInterface): AgentTypes => ({ agentType: async agentId => (await $.agent.list()).find(a => a.id === agentId)?.type })

const inheritPort = ($: EngineInterface): InheritPort => ({
  ...promptsPort($),
  ...routeStore($),
  ...agentTypes($),
})

const sleeper = ($: EngineInterface): Sleeper => ({ sleep: (ms, signal) => $.clock.sleep(ms, { signal }) })

const transcripts = ($: EngineInterface): Transcripts => ({
  transcript: agentId => (agentId === undefined ? $.session.messages({ as: 'api' }) : $.session.messages({ as: 'api', agentId })) as ReturnType<Transcripts['transcript']>,
})

const stepIo = ($: EngineInterface): StepIo => ({
  ...say($),
  ...promptsPort($),
  ...transcripts($),
  trusted: trustPort($).trusted,
  list: () => $.tool.list(), check: e => $.tool.check({ tool: e.tool, input: e.input as Record<string, unknown> }),
  loadedMcp: async () => new Set(((await $.session.usage({ breakdown: 'summary' })).context.breakdown?.mcpTools ?? []).filter(m => m.isLoaded).map(m => m.name)),
})

const choicePort = ($: EngineInterface): MainChoicePort => ({
  ...routeStore($),
  sessionId: () => $.session.id(),
  get: key => $.store.get(key),
  set: (key, value) => $.store.set(key, value),
  toast: text => $.ui.toast(text),
})
const modelPort = ($: EngineInterface, s: Session): ModelPort => ({
  ...trustPort($),
  ...statusPort($),
  ...say($),
  setMain: target => persistMainChoice(choicePort($), s, target),
  contextTokens: async () => (await $.session.usage()).context.tokens ?? 0,
})

const agentPort = ($: EngineInterface): AgentPort => ({
  ...trustPort($),
  ...promptsPort($),
  ...worktreePort($),
  ...agentTypes($),
  route: routeStore($).route,
  setRoute: routeStore($).setRoute,
  spawn: args => $.agent.spawn(args),
})

const classifierPort = ($: EngineInterface, s?: Session, remaining: () => number = () => 0): ClassifierPort => ({
  ...transcripts($),
  ...say($),
  pin: routeStore($).pin,
  route: routeStore($).route,
  translated: routeStore($).translated,
  trusted: trustPort($).trusted,
  log: text => $.ui.log(text),
  agents: () => $.agent.list(),
  roots: async () => [$.plugin.root, await configDir($)],
  configDir: () => configDir($),
  pluginRoot: $.plugin.root,
  ...(s === undefined ? {} : { review: {
    controller: s.review,
    session: () => $.session.id(),
    check: (e: Check) => $.tool.check({ tool: e.tool, input: e.input }),
    status: (text: string | undefined) => $.ui.status(text),
    io: { monotonic: () => performance.now(), remaining,
      open: () => $.ui.open({ id: APPROVAL_PANE, title: 'Review action', focus: true, closeOnEscape: true, rows: 20, columns: 72 }),
      showing: async () => (await $.ui.panes()).some(p => p.id === APPROVAL_PANE && p.isPlaced && p.isShown),
      close: () => $.ui.close({ id: APPROVAL_PANE }), redraw: () => $.ui.invalidate('ui.render'),
      after: (ms: number, fn: () => void) => $.clock.after(ms, fn),
    },
  } }),
  home: loadPort($).home,
  stat: async (path, resolve) => {
    try {
      const st = await $.fs.stat(path, { resolve })
      return st.realPath === undefined ? {} : { realPath: st.realPath }
    } catch {
      return undefined
    }
  },
  settings: source => $.settings.read({ source }),
  now: () => $.clock.now(),
  after: (ms, fn) => $.clock.after(ms, fn),
})

const reportPort = ($: EngineInterface, backend: Backend): ReportPort => ({
  engineModel: async () => {
    try {
      return await $.session.model()
    } catch {
      return 'unknown'
    }
  },
  keys: () => backend.status(),
  trusted: p => isTrusted(trustPort($), p),
})

const runtimeHost = ($: EngineInterface, s: Session, setup: ReturnType<typeof createSetupSession>): Host => ({ ...host($, s), launch: () => setup.daemonArgv() })
const reloadConfiguration = async ($: EngineInterface, s: Session, window: ReturnType<typeof createHostWindowCoordinator>, backend: Backend) => {
  dropTokens(say($), s, 'reload')
  await reload(reloadPort($, window), s, backend)
  await restoreMainChoice(choicePort($), s)
  $.ui.invalidate('tool.describe')
  await showStatus(statusPort($), s)
}

export const register: Register = on => {
  const s = createSession()
  const recovery = createRecovery()
  const usage = createUsageLifetime()
  registerObservations(on, s)
  const window = createHostWindowCoordinator()
  const backend = createBackend(usage.observer)
  const compaction = createCompactAdapter(s)
  const setup = createSetupSession()
  on('session.compact', async ($, e, next) => { try { return await compaction.compact({ ...compactEngine($, s), ...routeStore($), ...stepIo($) }, backend(runtimeHost($, s, setup)), e, next.signal, () => next(e)) } finally { await saveSeams($, s, e.agentId, true) } })
    .catch(($, e, next) => next.called ? next(e) : { skip: 'klyth: compaction failed safely; history kept; retry /klyth compact' })
  on('turn.start', ($, e, next) => { s.mainTurn = e.turnId; compaction.revision('main'); return next(e) })

  on('session.start', async ($, e, next) => {
    if (s.transcriptPath === undefined) await bindSession($, s, await $.session.id())
    const b = backend(runtimeHost($, s, setup))
    await reload(reloadPort($, window), s, b)
    await usage.start(usagePort($))
    await recovery.start(recoveryPort($))
    await $.command.register({ name: 'klyth', description: 'Set up Klyth, show routing and usage, or reload configuration', argumentHint: '[setup | reload | compact [instructions] | recovery [show|restore|dismiss id] | usage [text]]' })
    s.trashPath = await findTrash(worktreePort($))
    debug($, `klyth trash: ${s.trashPath ?? 'none'}`)
    await restoreMainChoice(choicePort($), s)
    s.configReady = true
    await showStatus(statusPort($), s)
    const started = await next(e)
    const launcher = scheduleLauncher(launcherPort($), callback => { $.clock.after(0, callback) })
    setup.start({ launcher,
      extraClient,
      root: $.plugin.root, home: await loadPort($).home(), configDir: await configDir($),
      exists: path => $.fs.exists(path), read: async path => String(await $.fs.read(path)),
      run: (argv, options) => $.process.run(argv, options), spawn: request => $.process.spawn(request),
      now: () => $.clock.now(), setTimer: (callback, ms) => { const timer = $.clock.after(ms, callback); return () => timer.cancel() },
      copy: async text => (await $.ui.copy({ text })).isCopied,
      ui: { redraw: () => $.ui.invalidate('ui.render'), closePane: () => { void $.ui.close({ id: SETUP_PANE }).catch(() => {}) } },
      failed: () => $.ui.toast('Klyth setup could not start. Run /klyth setup to retry.'),
      policy: () => $.settings.read({ source: 'policy' }),
      reload: async target => { await reloadConfiguration($, s, window, backend(runtimeHost($, s, setup))); return s.loaded.config !== undefined && resolve(s.loaded.config, target)?.kind === 'remote' },
      useModel: async target => {
        await $.command.run({ command: 'model', args: target })
        const expected = s.loaded.config && resolve(s.loaded.config, target)
        const selected = s.loaded.config && s.main && resolve(s.loaded.config, s.main)
        return expected?.kind === 'remote' && !!selected && selected.kind === 'remote' && expected.target === selected.target
      },
    })
    await b.start()
    await compaction.schedule(compactEngine($, s))
    return started
  })
  on('tool.describe', { tool: 'mcp__klyth__agent' }, ($, e) => ({ ...e, isDeferred: false }))

  // A routed conversation's call is made an Agent call at its step (routing.ts); this answers the rest. A hook-spawned
  // subagent's call raises the event beneath this hook (re-entry), where nothing can be read: its answer is the reason the step left it.
  on('tool.call', { tool: 'mcp__klyth__agent' }, ($, e, next) => agentCall(agentPort($), s, e, next.origin)).catch(($, e, next) =>
    next.error.kind === 're-entry'
      ? String(e.tool) === WRAPPER
        ? untranslated(s, e)
        : next(e)
      : { deny: AGENT_INTERNAL },
  )

  // A plain Agent call under a routed parent: its effort and worktree isolation are kept, and its spawn claims the parent's route.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    noteCall(s, e)
    const done = await next(e)
    dropCall(s, e, done)
    return done
  })
  on('agent.spawn', ($, e, next) => inheritSpawn(inheritPort($), s, e, next.origin.plugin, next))

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const backup = await recovery.capture(recoveryPort($), e)
    await restoreSeams($, s, e.to)
    const confirm = s.cacheHistory.begin(e.to, e.message, next.origin, typeof e.to === 'string' ? await routeStore($).route(e.to) : undefined)
    try {
      const done = await next(e)
      await recovery.observe(recoveryPort($), backup, done)
      if (delivered(done)) { confirm?.(); await saveSeams($, s, e.to) }
      else s.cacheHistory.failed(e.to)
      return done
    } catch (error) { s.cacheHistory.failed(e.to); throw error }
  }).catch(($, e, next) => { s.cacheHistory.failed(e.to); return next(e) })

  // Only a one-shot classifier token upgrades a plain ask. Agent wrappers and forks follow the same gate;
  // their spawns still claim the route or refuse, never falling back to a native loop. Explicit rules stand.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    await noteCheck(classifierPort($), s, e, next.origin, verdict)
    if (!plainAsk(verdict)) return verdict
    const spent = async () => ((await consumeToken(classifierPort($, s), s, e, next.origin)) ? { ...verdict, decision: 'allow' as const, reason: 'klyth classifier: allowed this call' } : verdict)
    return spent()
  }).catch(($, e, next) => (next.called || e.tool !== 'Agent' ? next(e) : { decision: 'deny', reason: 'klyth: could not check this Agent call, so it was denied; retry, or see the debug log' }))

  // A classifier that fails answers what the hooks beneath did: no retry of its own.
  on('classic.PermissionDenied', async ($, e, next) => ({ ...(await next(e)), ...(await classifyDenied(classifierPort($, s, () => next.budget.remainingMs), s, backend(runtimeHost($, s, setup)), e, next.signal)) })).catch(($, e, next) =>
    next.called ? next(e) : {},
  )

  on('ui.render', { component: 'Pane', requestId: APPROVAL_PANE }, ($, e) => renderApprovalPane($.ui.resolve(e), s.review.view()))
  on('ui.close', { id: APPROVAL_PANE }, ($, e, next) => { if (e.origin.kind !== 'plugin') s.review.cancel(); return next(e) })

  on('tool.call', async ($, e, next) => (await guard({ ...stepIo($), ...routeStore($) }, s, e)) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : (guardFailed(s, e) ?? next(e))))

  on('turn.complete', async ($, e, next) => {
    turnDone(say($), s, e.agentId ?? 'main')
    const done = await next(e)
    if (e.agentId === undefined) { s.mainTurn = undefined; await compaction.schedule(compactEngine($, s)) }
    if (e.agentId !== undefined) {
      if (s.cacheHistory.tracked(e.agentId)) {
        const read = await transcripts($).transcript(e.agentId).catch(() => undefined)
        if (read !== undefined && !('deny' in read)) { await s.cacheHistory.complete(e.agentId, read); await saveSeams($, s, e.agentId) }
      }
      await completed({ ...worktreePort($), ...routeStore($) }, s, e.agentId)
    }
    return done
  })

  on('turn.step', async function* ($, e, next) {
    compaction.revision(e.agentId ?? 'main')
    await restoreSeams($, s, e.agentId)
    try { return yield* turnStep({ ...stepIo($), ...routeStore($), ...sleeper($), ...agentTypes($) }, s, countSteps(s, backend(runtimeHost($, s, setup))), e, next.signal, () => next(e)) } finally { await saveSeams($, s, e.agentId, true) }
  }).catch(async function* ($, e, next) {
    if (next.called) return yield* next(e)
    return yield* stepFailed({ ...say($), ...transcripts($) }, s, e, next.error, () => next(e))
  })

  on('command.run', { command: 'model' }, async ($, e, next) => asCommand(await modelCommand(modelPort($, s), s, e, next)))
    .catch(async ($, e, next) => asCommand(await modelFailed(s, e, next.called, next)))

  on('command.run', { command: 'klyth' }, async ($, e) => {
    if (e.args.trim() === 'setup') {
      const opened = await $.ui.open({ id: SETUP_PANE, title: 'Set up Klyth', focus: true, closeOnEscape: true, rows: 22, columns: 68 })
      if (!opened.isPlaced) return { text: 'Klyth setup needs an attached native pane. Open /klyth setup in an interactive Claude terminal.' }
      setup.open()
      return {}
    }
    return runKlythCommand({
    recovery: args => recovery.command(recoveryPort($), args),
    compact: () => compaction.command(compactEngine($, s), e),
    usage: async args => {
      const words = args.trim().split(/\s+/).filter(Boolean)
      if (words[0] !== 'usage') return undefined
      const state = usage.snapshot()
      const current = state?.sessions.find(item => item.id === state.activeSessionId)
      if (words.length === 1) return openUsagePane(() => $.ui.open({ id: 'klyth-usage', title: 'Klyth usage', focus: true, closeOnEscape: true, rows: 18, columns: 72 }), () => usage.text(usagePort($)))
      return words.length === 2 && words[1] === 'text' ? usage.text(usagePort($)) : usageCommand(args, current)
    },
    reload: () => reloadConfiguration($, s, window, backend(runtimeHost($, s, setup))),
    report: () => report(reportPort($, backend(runtimeHost($, s, setup))), s),
    log: text => $.ui.log(text),
  }, e.args)
  })
  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, ($, e) => {
    const view = setup.view()
    const elements = $.ui.resolve(e)
    if (!('Input' in elements) || !('Select' in elements)) return elements.Text({ children: 'Open /klyth setup in an interactive Claude terminal.' })
    return view === undefined ? elements.Text({ children: 'Setup is closed. Run /klyth setup to reopen.' }) : renderSetupPane({ elements, dispatch: action => setup.dispatch(action), close: () => setup.close() }, view, e.props.bodyColumns)
  })
  on('ui.close', { id: SETUP_PANE }, ($, e, next) => { if (e.origin.kind !== 'plugin') setup.close(); return next(e) })

  on('ui.render', { component: 'Pane', requestId: 'klyth-usage' }, async ($, e) => {
    const sessionId = await $.session.id()
    const stored = await $.state.get(USAGE).catch(() => undefined)
    const published = validateUsageEnvelope(stored?.value)
    const live = usage.snapshot()
    const state = live?.activeSessionId === sessionId && (published === undefined || live.ownerGeneration >= published.ownerGeneration && live.revision > published.revision) ? live : published ?? live
    const current = state?.sessions.find(item => item.id === sessionId)
    const preferences = await $.state.get(USAGE_PANE_STATE).catch(() => undefined)
    const context = await usagePort($).context?.()
    return renderUsagePane({
      elements: $.ui.resolve(e),
      change: async action => {
        while (await $.session.id() === sessionId) {
          const saved = await $.state.get(USAGE_PANE_STATE)
          if (await $.session.id() !== sessionId) return
          const written = await $.state.set(USAGE_PANE_STATE, changeUsagePane(sessionId, saved.value, action), { ifVersion: saved.version })
          if (written.isSet) return
        }
      },
      close: async () => { await $.ui.close({ id: 'klyth-usage' }) },
      text: async () => { for (const line of await usage.text(usagePort($))) $.ui.log(line) },
    }, sessionId, current, preferences?.value, e.props.bodyColumns, context, usage.recordState())
  })

  // /clear and a resume end the conversation without a session.start, so the notes owed for it end with it, and the
  // route record of the session that ended is blanked. The session they move to starts with classic.SessionStart, which records the route anew.
  on('session.end', async ($, e, next) => {
    setup.reset()
    await usage.end(usagePort($))
    await window.end(hostWindowPort($), e.reason, e.sessionId)
    s.cacheHistory.clear()
    compaction.end()
    ended(s)
    await clearRecord(recordPort($), s)
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    noteMode(say($), s, e)
    if (e.agent_id === undefined) { await bindSession($, s, e.session_id ?? await $.session.id(), e.transcript_path); await usage.resume(usagePort($)); await usage.bindTranscript(usagePort($), e.session_id, e.transcript_path); await window.start(hostWindowPort($)); await recovery.start(recoveryPort($)) }
    if (!s.configReady) return next(e)
    if (e.agent_id === undefined) {
      await restoreMainChoice(choicePort($), s)
      if (viaCommand(s)) await showStatus(statusPort($), s)
    }
    const done = await next(e)
    if (e.agent_id === undefined) await compaction.schedule(compactEngine($, s))
    return done
  }).catch(($, e, next) => next(e))
  // The first main prompt after a route was left tells native Claude which turns another model answered. A prompt that entered
  // and that the person wrote, by the origin the engine stamped on it, is kept for the classifier (classifier.ts).
  on('prompt.submit', async ($, e, next) => {
    compaction.revision('main')
    const entered = await leftNote(s, e, next)
    notePrompt(s, e, entered)
    return entered
  }).catch(($, e, next) => next(e))

  // A switch made outside /model (the /config Model row, the SDK) leaves klyth too.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await modelSwitched(modelPort($, s), s, e.source)
    return next(e)
  })
}
