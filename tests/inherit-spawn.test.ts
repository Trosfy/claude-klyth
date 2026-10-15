// Which spawns a routed parent's plain Agent call hands the parent's route, decided by inheritSpawn over a
// port: an agent type klyth can reproduce faithfully is claimed, one it cannot runs native (a custom agent
// klyth has no definition for, as with a plugin loaded with --plugin-dir or an --agents or SDK agent; a
// built-in type klyth cannot run (comment-thread-analyst); an agent whose definition isolates it
// in a worktree the engine did not make; a type with two definitions, agents being found by the `name:` of
// their files, not by file name; a spawn from a subagent in a worktree or with a cwd of its own), a model that differs from the parent's only
// in spelling is still the parent's, and a type a hook beneath rewrote is not claimed. A fork is claimed on its
// parent's target alone or refused: never left native under a routed parent, never run on another alias. The port
// gives a spawn an agentId, which the kit does not.
import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Route } from '../types'
import { toolFilter } from '../hooks/agents'
import { inheritSpawn, noteCall, routedFork } from '../hooks/inherit'
import { nativeMain } from '../hooks/native-step'
import { WRAPPER } from '../hooks/routing'
import { contested, definitionOf } from '../hooks/prompts'
import { createSession } from '../hooks/session'
import { parseConfig } from '../hooks/config'
import { dirEntries } from './dirs'
import { CONFIG } from './world'

const PARENT = 'claude-opus-5-5'
const agentFile = (name: string, model?: string, isolation?: string, body = 'BODY') =>
  `---\nname: ${name}\ndescription: d\n${model === undefined ? '' : `model: ${model}\n`}${isolation === undefined ? '' : `isolation: ${isolation}\n`}---\n${body}`

// What a command answers (`files` is the world's, for a command that writes one); a git work tree is /w.
type Run = (argv: readonly string[], files: Record<string, string>) => { exitCode: number; stdout?: string; stderr?: string } | undefined
// `stored`: the routes persisted in state, by agentId; `recorded`: the translated calls persisted in state, by `main` or agentId
type Options = { run?: Run; stored?: Record<string, Route>; recorded?: Record<string, Record<string, string>> }

// A session whose main runs on `fast`, over a port that reads `files` and lists the engine's agents as `listed` (a listing that fails when it is an Error).
function world(given: Record<string, string> = {}, listed: Record<string, string> | Error = {}, o: Options = {}) {
  const files: Record<string, string> = { ...given }
  const s = createSession()
  s.pin = { turnId: 't1', target: 'fast' }
  const debug: string[] = []
  const persisted: [string, Route][] = []
  const seen: AgentSpawnInput[] = [] // the event each spawn beneath was given
  const runs: [readonly string[], { timeoutMs?: number } | undefined][] = []
  const io = {
    configDir: async () => '/home/u/.claude',
    cwd: async () => '/w',
    exists: async (path: string) => Object.hasOwn(files, path),
    read: async (path: string) => files[path] as string,
    listDir: async (dir: string) => dirEntries(files, dir) ?? [],
    run: async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
      runs.push([argv, opts])
      const r = o.run?.(argv, files) ?? (argv.includes('--show-toplevel') ? { exitCode: 0, stdout: '/w\n' } : { exitCode: 1 })
      return { stdout: '', stderr: '', ...r }
    },
    now: async () => 0,
    compose: async () => [],
    debug: (line: string) => void debug.push(line),
    pin: async () => s.pin,
    route: async (id: string) => o.stored?.[id],
    setRoute: async (id: string, route: Route) => void persisted.push([id, route]),
    translated: async (who: string) => o.recorded?.[who],
    agentType: async (id: string) => {
      if (listed instanceof Error) throw listed
      return listed[id]
    },
  }
  const spawn = (type: string, o: { model?: string; parentModel?: string; started?: Partial<AgentSpawnResult>; event?: Partial<AgentSpawnInput> } = {}) => {
    const e = { tool_use_id: `u-${type}`, prompt: 'audit', description: 'd', subagentType: type, provider: { plugin: 'engine', tier: 'core' }, parentModel: o.parentModel ?? PARENT, background: true, fork: false, ...o.event } as AgentSpawnInput
    const started = { model: PARENT, agentId: `a-${type}`, ...o.started } as AgentSpawnResult
    return inheritSpawn(io, s, e, 'engine', async given => (seen.push(given), started))
  }
  return { s, io, debug, persisted, runs, seen, spawn }
}

for (const [why, files, type] of [
  ['a plugin agent whose plugin installed_plugins.json does not list (a --plugin-dir plugin)', {}, 'myplug:auditor'],
  ['an --agents or SDK agent, which has no file', {}, 'auditor'],
  ['an agent file whose frontmatter names another agent', { '/w/.claude/agents/auditor.md': agentFile('reviewer') }, 'auditor'],
  ['an agent file klyth cannot parse', { '/w/.claude/agents/auditor.md': 'no frontmatter' }, 'auditor'],
] as const) {
  test(`${why}: the spawn is not claimed, and one debug line says so`, async () => {
    const w = world(files)
    const started = await w.spawn(type)
    expect(started).toEqual({ model: PARENT, agentId: `a-${type}` })
    expect(w.s.routes.size).toBe(0)
    expect(w.persisted).toEqual([])
    expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([`klyth inherit: ${type} has no readable definition; it stays native`])
  })
}

test('an agent type klyth reproduces is claimed: a built-in with no file, and a custom one with model inherit, with none, and in an installed plugin', async () => {
  const installed = JSON.stringify({ plugins: { 'myplug@market': [{ installPath: '/cache/myplug' }] } })
  const w = world({
    '/w/.claude/agents/heir.md': agentFile('heir', 'inherit'),
    '/w/.claude/agents/bare.md': agentFile('bare'),
    '/home/u/.claude/plugins/installed_plugins.json': installed,
    '/cache/myplug/agents/auditor.md': agentFile('auditor'),
  })
  for (const type of ['Explore', 'general-purpose', 'heir', 'bare', 'myplug:auditor']) await w.spawn(type)
  expect([...w.s.routes].map(([id, r]) => [id, r.type, r.target])).toEqual(
    ['Explore', 'general-purpose', 'heir', 'bare', 'myplug:auditor'].map(t => [`a-${t}`, t, 'fast']),
  )
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
})

test('a custom agent whose definition names a model of its own is not claimed', async () => {
  const w = world({ '/w/.claude/agents/scout.md': agentFile('scout', 'sonnet') })
  await w.spawn('scout', { started: { model: 'claude-sonnet-5-5' } })
  expect(w.s.routes.size).toBe(0)
})

for (const [why, parentModel, resolved, claimed] of [
  ['the parent model is spelled with a context-size suffix', `${PARENT}[1m]`, PARENT, true],
  ['the resolved model is spelled with a context-size suffix', PARENT, `${PARENT}[1m]`, true],
  ['the two differ in case', PARENT, PARENT.toUpperCase(), true],
  ['the resolved model is another model', `${PARENT}[1m]`, 'claude-sonnet-5-5', false],
  ['the resolved model is another size of the same family name', PARENT, 'claude-opus-5', false],
] as const) {
  test(`${why}: the subagent is ${claimed ? 'the parent model\'s, so claimed' : 'on another model, so left native'}`, async () => {
    const w = world()
    await w.spawn('Explore', { parentModel, started: { model: resolved } })
    expect(w.s.routes.size).toBe(claimed ? 1 : 0)
  })
}

test('a type a hook beneath rewrote is not claimed, though klyth could claim the new one: one debug line says so', async () => {
  const w = world({}, { 'a-Explore': 'Plan' })
  const started = await w.spawn('Explore')
  expect(started).toEqual({ model: PARENT, agentId: 'a-Explore' })
  expect(w.s.routes.size).toBe(0)
  expect(w.persisted).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: a hook changed Explore to Plan; it stays native'])
})

test('the type a hook beneath rewrote to is not checked; an unlisted subagent keeps the type of the call', async () => {
  const w = world({ '/w/.claude/agents/scout.md': agentFile('scout') }, { 'a-scout': 'Explore' })
  await w.spawn('scout')
  expect(w.s.routes.size).toBe(0)
  expect(w.runs).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: a hook changed scout to Explore; it stays native'])
  const unlisted = world()
  await unlisted.spawn('Explore')
  expect(unlisted.s.routes.get('a-Explore')?.type).toBe('Explore')
})

test('a failing agent list does not stop the claim: the route keeps the type of the call', async () => {
  const w = world({}, new Error('list down'))
  await w.spawn('Explore')
  expect(w.s.routes.get('a-Explore')?.type).toBe('Explore')
})

const WT = '/w/.claude/worktrees/agent-a-iso'

test("a custom agent whose definition says isolation: worktree is claimed when the engine made the subagent's worktree, which is the route's cwd", async () => {
  const w = world({ '/w/.claude/agents/iso.md': agentFile('iso', undefined, 'worktree'), [WT]: '' })
  await w.spawn('iso')
  expect(w.s.routes.get('a-iso')?.worktree).toEqual({ path: WT, engine: true })
  expect(w.persisted.map(([id, r]) => [id, r.worktree?.path])).toEqual([['a-iso', WT]])
  expect(w.debug).toContain(`klyth spawn a-iso → fast inherited by iso from main effort=none cwd=${WT}`)
})

test('a custom agent whose definition says isolation: worktree is not claimed when the engine made no worktree, and one debug line says so', async () => {
  const w = world({ '/w/.claude/agents/iso.md': agentFile('iso', undefined, 'worktree') })
  const started = await w.spawn('iso')
  expect(started).toEqual({ model: PARENT, agentId: 'a-iso' })
  expect(w.s.routes.size).toBe(0)
  expect(w.persisted).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: the engine made no worktree for a-iso (iso); it stays native'])
})

test('a definition with no isolation is claimed with the session cwd, though a worktree is there', async () => {
  const w = world({ '/w/.claude/agents/iso.md': agentFile('iso'), [WT]: '' })
  await w.spawn('iso')
  expect(w.s.routes.get('a-iso')).toEqual({ target: 'fast', label: 'fast', type: 'iso', prompt: 'audit' })
})

test('comment-thread-analyst is not a type klyth can run: the spawn is not claimed, and one debug line says so', async () => {
  const w = world()
  const started = await w.spawn('comment-thread-analyst')
  expect(started).toEqual({ model: PARENT, agentId: 'a-comment-thread-analyst' })
  expect(w.s.routes.size).toBe(0)
  expect(w.persisted).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: comment-thread-analyst is not a type klyth can run; it stays native'])
  expect(w.s.notes).toEqual([])
})

test("a fork of a routed main is claimed on main's alias, whatever model its call names and whatever an agent file called fork says, and its route records the call that started it", async () => {
  const w = world({ '/w/.claude/agents/fork.md': agentFile('fork', 'sonnet') })
  await w.spawn('fork', { event: { fork: true, model: 'sonnet' } })
  expect(w.s.routes.get('a-fork')).toEqual({ target: 'fast', label: 'fast', type: 'fork', prompt: 'audit', forkOf: 'u-fork' })
  expect(w.persisted.map(([id, r]) => [id, r.target, r.type])).toEqual([['a-fork', 'fast', 'fork']])
  expect(w.debug).toEqual(['klyth spawn a-fork → fast inherited by fork from main effort=none'])
  expect(w.s.notes).toEqual([])
  expect(w.seen[0]?.model).toBe('sonnet')
})

test("a fork of a routed subagent is claimed on that subagent's alias, not main's, with the subagent as its parent", async () => {
  const w = world({}, {}, { stored: { par: { target: 'strong', label: 'strong', type: 'Explore' } } })
  await w.spawn('fork', { event: { fork: true, parentAgentId: 'par' } })
  expect(w.s.routes.get('a-fork')).toEqual({ target: 'strong', label: 'strong', type: 'fork', prompt: 'audit', parent: 'par', forkOf: 'u-fork' })
  expect(w.debug).toEqual(['klyth spawn a-fork → strong inherited by fork from par effort=none'])
})

test('a fork of a fork is claimed on the alias of the fork above it', async () => {
  const w = world({}, {}, { stored: { par: { target: 'strong', label: 'strong', type: 'fork', parent: 'top' } } })
  await w.spawn('fork', { event: { fork: true, parentAgentId: 'par' } })
  expect(w.s.routes.get('a-fork')).toMatchObject({ target: 'strong', type: 'fork', parent: 'par' })
})

test("a fork of a native main or of a native subagent stays native: it is not claimed, and klyth says nothing", async () => {
  const main = world()
  main.s.pin = { turnId: 't1', target: null }
  expect(await main.spawn('fork', { event: { fork: true } })).toEqual({ model: PARENT, agentId: 'a-fork' })
  const sub = world({}, {}, { stored: { nat: { target: null, label: 'haiku' } } })
  await sub.spawn('fork', { event: { fork: true, parentAgentId: 'nat' } })
  for (const w of [main, sub]) {
    expect(w.s.routes.size).toBe(0)
    expect(w.persisted).toEqual([])
    expect(w.debug).toEqual([])
    expect(w.seen).toHaveLength(1)
  }
})

const FORK_REFUSED = (why: string) => `klyth: this fork was refused: ${why}; a fork runs only on its parent's model, never natively under a routed parent`

// A fork carries its parent's whole conversation, so under a routed parent it runs on that parent's model or not at all.
for (const [why, o, reason] of [
  ['a fork of a subagent that works in a worktree', { stored: { par: { target: 'strong', label: 'strong', type: 'Explore', worktree: { path: WT, engine: true } } } }, 'it is spawned by a subagent in a worktree'],
  ['a fork of a resumed subagent that worked in a worktree', { stored: { par: { target: 'strong', label: 'strong', type: 'Explore', wasIsolated: true } } }, 'it is spawned by a subagent in a worktree'],
  ['an isolated fork', { isolated: true }, 'it asks for a worktree, and a fork cannot be isolated through klyth'],
  ['a fork isolated elsewhere', { elsewhere: 'remote' }, 'it runs isolated as remote'],
  ['a fork whose call sets a cwd', { event: { cwd: '/elsewhere' } }, 'it sets its own cwd (/elsewhere)'],
  ['a fork the engine started as a teammate', { event: { isTeammate: true } }, "it is a teammate, a workflow agent or another plugin's spawn"],
] as const) {
  test(`${why} under a routed parent is refused before it starts, never left native`, async () => {
    const stored = 'stored' in o ? o.stored : undefined
    const w = world({}, {}, stored === undefined ? {} : { stored })
    if ('isolated' in o) noteCall(w.s, { tool_use_id: 'u-fork', isolation: 'worktree' })
    if ('elsewhere' in o) noteCall(w.s, { tool_use_id: 'u-fork', isolation: o.elsewhere })
    const event = { fork: true, ...(stored === undefined ? {} : { parentAgentId: 'par' }), ...('event' in o ? o.event : {}) }
    expect(await w.spawn('fork', { event })).toEqual({ deny: FORK_REFUSED(reason) })
    expect(w.seen).toEqual([])
    expect(w.s.routes.size).toBe(0)
    expect(w.persisted).toEqual([])
  })
}

test("a fork that another plugin spawns under a routed main is refused; under a native main it is left alone", async () => {
  const w = world()
  const e = { tool_use_id: 'u-fork', prompt: 'audit', description: 'd', subagentType: 'fork', provider: { plugin: 'engine', tier: 'core' }, parentModel: PARENT, background: true, fork: true } as AgentSpawnInput
  const beneath = async () => ({ model: PARENT, agentId: 'x1' })
  expect(await inheritSpawn(w.io, w.s, e, 'other', beneath)).toEqual({ deny: FORK_REFUSED("it is a teammate, a workflow agent or another plugin's spawn") })
  w.s.pin = { turnId: 't1', target: null }
  expect(await inheritSpawn(w.io, w.s, e, 'other', beneath)).toEqual({ model: PARENT, agentId: 'x1' })
})

for (const [why, setup, reason] of [
  ['the route of its subagent parent cannot be read', (w: ReturnType<typeof world>) => void (w.io.route = async () => Promise.reject(new Error('state down'))), "klyth cannot read its parent's route (Error: state down); retry"],
  ["main's pin cannot be read", (w: ReturnType<typeof world>) => void ((w.s.pin = null), (w.io.pin = async () => Promise.reject(new Error('state down')))), "klyth cannot read its parent's route (Error: state down); retry"],
  ["main has no pin recorded", (w: ReturnType<typeof world>) => void ((w.s.pin = null), (w.io.pin = async () => null)), "klyth cannot read its parent's route (main's route for this turn is not recorded); retry"],
] as const) {
  test(`a fork whose parent's route is unknown (${why}) is refused before it starts, never left native`, async () => {
    const w = world()
    setup(w)
    const sub = why.includes('subagent')
    expect(await w.spawn('fork', { event: { fork: true, ...(sub ? { parentAgentId: 'par' } : {}) } })).toEqual({ deny: FORK_REFUSED(reason) })
    expect(w.seen).toEqual([])
    expect(w.debug).toEqual([`klyth inherit: the route of the parent of a fork cannot be read (${reason.slice(reason.indexOf('(') + 1, reason.lastIndexOf(')'))}); the call is refused`])
  })
}

test('a plain spawn whose parent route cannot be read stays native, as before: only a fork is refused on it', async () => {
  const w = world()
  w.io.route = async () => Promise.reject(new Error('state down'))
  expect(await w.spawn('Explore', { event: { parentAgentId: 'par' } })).toEqual({ model: PARENT, agentId: 'a-Explore' })
  expect(w.s.routes.size).toBe(0)
})

test("a fork of a native subagent that works in a worktree stays native: its parent is known to be native", async () => {
  const w = world({}, {}, { stored: { nat: { target: null, label: 'haiku', worktree: { path: WT, engine: true } } } })
  expect(await w.spawn('fork', { event: { fork: true, parentAgentId: 'nat' } })).toEqual({ model: PARENT, agentId: 'a-fork' })
  expect(w.s.routes.size).toBe(0)
  expect(w.debug).toEqual([])
})

for (const [why, noted, parent] of [
  ['another alias than its routed parent', 'strong', 'fast'],
  ['a native model under a routed parent', null, 'fast'],
  ['an alias under a native parent', 'strong', null],
] as const) {
  test(`a fork noted for ${why} is refused: a fork takes its parent's model only`, async () => {
    const w = world()
    w.s.pin = { turnId: 't1', target: parent }
    w.s.note('u-fork', { target: noted })
    expect(await w.spawn('fork', { event: { fork: true } })).toEqual({ deny: FORK_REFUSED(`it was asked for on ${noted ?? 'a native model'}, but its parent runs on ${parent ?? 'a native model'}`) })
    expect(w.seen).toEqual([])
    expect(w.s.routes.size).toBe(0)
  })
}

test('a fork whose recorded model (its note gone) names another alias than its parent is refused', async () => {
  const w = world({}, {}, { recorded: { main: { 'u-fork': 'strong' } } })
  configured(w)
  expect(await w.spawn('fork', { event: { fork: true } })).toEqual({ deny: FORK_REFUSED('it was asked for on strong, but its parent runs on fast') })
  expect(w.seen).toEqual([])
})

test("any spelling of fork the engine reads as one is held to the fork rule, though the engine's flag is unset", async () => {
  for (const type of ['Fork', 'FORK', 'for_k', ' fork ']) {
    const w = world()
    w.s.note(`u-${type}`, { target: 'strong' })
    expect(await w.spawn(type)).toEqual({ deny: FORK_REFUSED('it was asked for on strong, but its parent runs on fast') })
    const plain = world()
    await plain.spawn(type)
    expect(plain.s.routes.get(`a-${type}`)).toEqual({ target: 'fast', label: 'fast', type: 'fork', prompt: 'audit', forkOf: `u-${type}` })
  }
})

for (const [why, o, reason] of [
  ['the engine started on another model', { started: { model: 'claude-sonnet-5-5' } }, `the engine started it on claude-sonnet-5-5, not its parent's ${PARENT}`],
  ['the engine named no model for', { started: { model: undefined } }, 'the engine did not say which model it started it on'],
  ['a hook beneath listed as another type', { listed: { 'a-fork': 'Explore' } }, 'a hook changed fork to Explore'],
] as const) {
  test(`a fork under a routed parent that ${why} cannot be taken back: its route refuses, so its first step hands the reason back`, async () => {
    const w = world({}, 'listed' in o ? o.listed : {})
    await w.spawn('fork', { event: { fork: true }, ...('started' in o ? { started: o.started as Partial<AgentSpawnResult> } : {}) })
    const refused = FORK_REFUSED(`${reason}, so klyth did not run it on fast`)
    expect(w.s.routes.get('a-fork')).toEqual({ target: 'fast', label: 'fast', type: 'fork', prompt: 'audit', refused })
    expect(w.persisted).toEqual([['a-fork', { target: 'fast', label: 'fast', type: 'fork', prompt: 'audit', refused }]])
  })
}

test("a fork takes its parent's effort, never its call's: the engine ignores a fork's own", async () => {
  const w = world({}, {}, { stored: { par: { target: 'strong', label: 'strong', type: 'Explore', effort: 'low' } } })
  noteCall(w.s, { tool_use_id: 'u-fork', effort: 'max' })
  await w.spawn('fork', { event: { fork: true, parentAgentId: 'par' } })
  expect(w.s.routes.get('a-fork')).toEqual({ target: 'strong', label: 'strong', type: 'fork', prompt: 'audit', effort: 'low', parent: 'par', forkOf: 'u-fork' })
  const main = world()
  noteCall(main.s, { tool_use_id: 'u-fork', effort: 'max' })
  await main.spawn('fork', { event: { fork: true } })
  expect(main.s.routes.get('a-fork')).toEqual({ target: 'fast', label: 'fast', type: 'fork', prompt: 'audit', forkOf: 'u-fork' })
})

test("a fork the klyth agent tool asked for is claimed on the alias its call was noted for, started on its parent's engine model", async () => {
  const w = world()
  w.s.note('u-fork', { target: 'fast' })
  await w.spawn('fork', { event: { fork: true } })
  expect(w.s.routes.get('a-fork')).toMatchObject({ target: 'fast', type: 'fork' })
  expect(w.seen[0]?.model).toBe(PARENT)
  expect(w.debug).toEqual(['klyth spawn a-fork → fast requested by fork from main effort=none'])
})

test('Explore, Plan, general-purpose and claude are claimed with no agent file and no run of any command, and say nothing', async () => {
  const w = world()
  for (const type of ['Explore', 'Plan', 'general-purpose', 'claude']) await w.spawn(type)
  expect([...w.s.routes.values()].map(r => r.type)).toEqual(['Explore', 'Plan', 'general-purpose', 'claude'])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
  expect(w.s.notes).toEqual([])
  expect(w.runs).toEqual([])
})

test('a built-in type with one agent file follows the custom path: its model, isolation and tools apply; two files leave it native', async () => {
  const filed = world({ '/w/.claude/agents/x.md': agentFile('Explore', 'inherit') })
  await filed.spawn('Explore')
  expect(filed.s.routes.get('a-Explore')?.type).toBe('Explore')
  const modelled = world({ '/w/.claude/agents/x.md': agentFile('Explore', 'sonnet') })
  await modelled.spawn('Explore', { started: { model: 'claude-sonnet-5-5' } })
  expect(modelled.s.routes.size).toBe(0)
  const remote = world({ '/w/.claude/agents/x.md': agentFile('Plan', undefined, 'remote') })
  await remote.spawn('Plan')
  expect(remote.s.routes.size).toBe(0)
  expect(remote.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: Plan runs isolated as remote; it stays native'])
  const twice = world({ '/w/.claude/agents/a.md': agentFile('Explore'), '/home/u/.claude/agents/b.md': agentFile('Explore') })
  await twice.spawn('Explore')
  expect(twice.s.routes.size).toBe(0)
  expect(twice.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: Explore has more than one definition (two agent files name it, or klyth could not read them all); it stays native'])
})

test('a built-in type that sets its own model is left native', async () => {
  const w = world()
  await w.spawn('statusline-setup')
  expect(w.s.routes.size).toBe(0)
  expect(w.debug).toEqual([])
})

test('a claude subagent is claimed when an agent file names it once, and left native when the engine started it on another model', async () => {
  const filed = world({ '/w/.claude/agents/claude.md': agentFile('claude') })
  await filed.spawn('claude')
  expect(filed.s.routes.get('a-claude')?.type).toBe('claude')
  const other = world()
  expect(await other.spawn('claude', { started: { model: 'claude-haiku-5-5' } })).toEqual({ model: 'claude-haiku-5-5', agentId: 'a-claude' })
  expect(other.s.routes.size).toBe(0)
  expect(other.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([`klyth inherit: the engine resolved claude-haiku-5-5 for claude, not its parent's ${PARENT}; it stays native`])
})

// --- a spawn klyth would route without the directory the child works in ---------------------------------------

const KLYTH_WORKTREE = { path: '/w/.claude/worktrees/agent-x', branch: 'worktree-agent-x', base: 'base0', root: '/w' }
const ENGINE_WORKTREE = { path: '/w/.claude/worktrees/agent-x', engine: true as const }

for (const [why, worktree] of [
  ['a worktree klyth made', KLYTH_WORKTREE],
  ['a worktree the engine made', ENGINE_WORKTREE],
] as const) {
  test(`the parent is a routed subagent in ${why}: its child is not claimed, and one debug line says so`, async () => {
    const w = world()
    w.s.routes.set('parent', { target: 'fast', label: 'fast', type: 'Explore', worktree })
    const started = await w.spawn('Explore', { event: { parentAgentId: 'parent' } })
    expect(started).toEqual({ model: PARENT, agentId: 'a-Explore' })
    expect(w.s.routes.has('a-Explore')).toBe(false)
    expect(w.persisted).toEqual([])
    expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: Explore is spawned by a subagent in a worktree; it stays native'])
  })
}

test("a parent the session holds no route for (a hot reload) is read from state: one with a worktree has its child left native, one without hands its route on", async () => {
  const w = world({}, {}, { stored: { 'sub-wt': { target: 'fast', label: 'fast', type: 'Explore', worktree: ENGINE_WORKTREE }, 'sub-plain': { target: 'fast', label: 'fast', type: 'Explore' } } })
  await w.spawn('Explore', { event: { parentAgentId: 'sub-wt' } })
  expect(w.s.routes.size).toBe(0)
  await w.spawn('Plan', { event: { parentAgentId: 'sub-plain' } })
  expect([...w.s.routes].map(([id, r]) => [id, r.target])).toEqual([['a-Plan', 'fast']])
})

test('the parent is a resumed subagent whose worktree is gone from its route: its child is not claimed, and one debug line says so', async () => {
  const w = world({}, {}, { stored: { gone: { target: 'fast', label: 'fast', type: 'Explore', wasIsolated: true } } })
  const started = await w.spawn('Explore', { event: { parentAgentId: 'gone' } })
  expect(started).toEqual({ model: PARENT, agentId: 'a-Explore' })
  expect(w.s.routes.size).toBe(0)
  expect(w.persisted).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: Explore is spawned by a subagent in a worktree; it stays native'])
})

test('a call that sets a cwd is not claimed, and one debug line says so', async () => {
  const w = world()
  const started = await w.spawn('Explore', { event: { cwd: '/elsewhere' } })
  expect(started).toEqual({ model: PARENT, agentId: 'a-Explore' })
  expect(w.s.routes.size).toBe(0)
  expect(w.persisted).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: Explore sets its own cwd (/elsewhere); it stays native'])
})

// --- a type with more than one definition --------------------------------------------------------------------

const PROJECT = '/w/.claude/agents'
const USER = '/home/u/.claude/agents'
const CONTESTED = (type: string) => `klyth inherit: ${type} has more than one definition (two agent files name it, or klyth could not read them all); it stays native`

for (const [why, type, files] of [
  ['a built-in type that two agent files name', 'Explore', { [`${PROJECT}/Explore.md`]: agentFile('Explore'), [`${USER}/Explore.md`]: agentFile('Explore') }],
  ['a custom type with an agent file in the project and another in the configuration directory', 'twin', { [`${PROJECT}/twin.md`]: agentFile('twin'), [`${USER}/twin.md`]: agentFile('twin') }],
  ['a custom type whose second file does not read', 'twin', { [`${PROJECT}/twin.md`]: agentFile('twin'), [`${USER}/twin.md`]: '---\nname: twin\ndescription: |\n  multi\n---\nBODY' }],
] as const) {
  test(`${why}: the spawn is not claimed, and one debug line says so`, async () => {
    const w = world(files)
    const started = await w.spawn(type)
    expect(started).toEqual({ model: PARENT, agentId: `a-${type}` })
    expect(w.s.routes.size).toBe(0)
    expect(w.persisted).toEqual([])
    expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([CONTESTED(type)])
  })
}

test('a file of a built-in type\'s name whose frontmatter names another agent, and a second custom file that does, define nothing: both types are claimed', async () => {
  const w = world({
    [`${PROJECT}/general-purpose.md`]: agentFile('reviewer'),
    [`${PROJECT}/twin.md`]: agentFile('twin'),
    [`${USER}/twin.md`]: agentFile('other'),
  })
  await w.spawn('general-purpose')
  await w.spawn('twin')
  expect([...w.s.routes.keys()]).toEqual(['a-general-purpose', 'a-twin'])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
})

// --- agents are found by the `name:` of their files ------------------------------------------------------------

for (const [why, type, files] of [
  ['a custom type that a project file and a user file of other file names both define', 'scout', { [`${PROJECT}/scout-new.md`]: agentFile('scout'), [`${USER}/scout.md`]: agentFile('scout') }],
  ['a custom type that two project files define, each under a file name other than its own', 'scout', { [`${PROJECT}/a.md`]: agentFile('scout'), [`${PROJECT}/b.md`]: agentFile('scout') }],
] as const) {
  test(`${why}: the spawn is not claimed, and one debug line says so`, async () => {
    const w = world(files)
    const started = await w.spawn(type)
    expect(started).toEqual({ model: PARENT, agentId: `a-${type}` })
    expect(w.s.routes.size).toBe(0)
    expect(w.persisted).toEqual([])
    expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([CONTESTED(type)])
  })
}

test('one file that names a built-in type under another file name, in the configuration directory or a subdirectory, defines it: the spawn is claimed and its body is the definition', async () => {
  const w = world({ [`${USER}/gp-readonly.md`]: agentFile('general-purpose', undefined, undefined, 'GP BODY'), [`${PROJECT}/team/readonly.md`]: agentFile('Explore', undefined, undefined, 'EXPLORE BODY') })
  await w.spawn('general-purpose')
  await w.spawn('Explore')
  expect([...w.s.routes.keys()]).toEqual(['a-general-purpose', 'a-Explore'])
  expect((await definitionOf(w.io, w.s, 'general-purpose'))?.prompt).toBe('GP BODY')
  expect((await definitionOf(w.io, w.s, 'Explore'))?.prompt).toBe('EXPLORE BODY')
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
})

test('a built-in type with one agent file that does not read is not claimed (the file may define it), and /klyth says so', async () => {
  const w = world({ [`${PROJECT}/Plan.md`]: '---\nname: Plan\ndescription: |\n  multi\n---\nBODY' })
  const started = await w.spawn('Plan')
  expect(started).toEqual({ model: PARENT, agentId: 'a-Plan' })
  expect(w.s.routes.size).toBe(0)
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: Plan has one agent file klyth cannot read; it stays native'])
  expect(await definitionOf(w.io, w.s, 'Plan')).toBeUndefined()
  expect(w.s.notes).toEqual([`agents: Plan has one agent file klyth cannot read (${PROJECT}/Plan.md: line 3: "|" is a YAML form klyth does not read (only text and lists are)); a plain call stays native and a klyth agent call is refused`])
})

test("an unreadable Explore.md (a block scalar in tools) leaves a plain Explore spawn native, with the one debug line", async () => {
  const w = world({ '/w/.claude/agents/Explore.md': '---\nname: Explore\ndescription: d\ntools: |\n  Read\n---\nBODY' })
  await w.spawn('Explore')
  expect(w.s.routes.size).toBe(0)
  expect(w.persisted).toEqual([])
  expect(w.debug).toContain('klyth inherit: Explore has one agent file klyth cannot read; it stays native')
})

// Claude Code passes over a `.md` file with no frontmatter in an agents directory without a word, so klyth does too.
test('a file with no frontmatter in .claude/agents is passed over in silence: it defines nothing, and no lookup of a built-in type notes it', async () => {
  const w = world({ [`${PROJECT}/Plan.md`]: 'no frontmatter', [`${USER}/notes.md`]: '# just notes' })
  await w.spawn('Plan')
  await w.spawn('Explore')
  expect([...w.s.routes.keys()]).toEqual(['a-Plan', 'a-Explore'])
  expect(await definitionOf(w.io, w.s, 'Plan')).toBeUndefined()
  expect(await contested(w.io, w.s, 'Plan')).toBe(false)
  expect(w.s.notes).toEqual([])
  expect(w.debug.filter(l => l.includes('cannot be read') || l.startsWith('klyth inherit:'))).toEqual([])
})

test('a file that might define a built-in type under another file name but does not read is said in /klyth, once, whichever built-in type is asked about', async () => {
  const unread = `---\nname: Explore\ndescription: |\n  multi\n---\nBODY`
  const w = world({ [`${PROJECT}/explore-agent.md`]: unread })
  await w.spawn('Explore')
  await w.spawn('Plan')
  const say = `agents: ${PROJECT}/explore-agent.md cannot be read (line 3: "|" is a YAML form klyth does not read (only text and lists are)); if it defines a built-in agent type, that type runs on klyth's prompt instead of the file`
  expect(w.s.notes).toEqual([say])
  expect(w.debug).toContain(`klyth ${say}`)
  expect([...w.s.routes.keys()]).toEqual(['a-Explore', 'a-Plan'])
})

test('a built-in type that runs on an agent file is said in /klyth with the file, once', async () => {
  const w = world({ [`${USER}/readonly.md`]: agentFile('Explore', undefined, undefined, 'EXPLORE BODY') })
  await w.spawn('Explore')
  await w.spawn('Explore', { event: { tool_use_id: 'u2' } })
  expect(w.s.notes).toEqual([`agents: Explore runs on ${USER}/readonly.md, which overrides the built-in`])
})

test("a named spawn of a built-in type with one agent file runs on the requested alias, whatever the file's model: says", async () => {
  const w = world({ [`${PROJECT}/x.md`]: agentFile('Explore', 'sonnet') })
  w.s.note('u-Explore', { target: 'strong' })
  await w.spawn('Explore')
  expect(w.s.routes.get('a-Explore')).toMatchObject({ target: 'strong', type: 'Explore' })
  expect(w.seen[0]?.model).toBe(PARENT)
  const plain = world({ [`${PROJECT}/x.md`]: agentFile('Explore', 'sonnet') })
  await plain.spawn('Explore', { started: { model: 'claude-sonnet-5-5' } })
  expect(plain.s.routes.size).toBe(0)
})

// Claude Code requires a name and a description of a file in .claude/agents, and takes no agent from one without either.
for (const [why, text, said] of [
  ['no name', '---\ndescription: d\n---\nBODY', 'no name'],
  ['no description', '---\nname: Explore\n---\nBODY', 'no description'],
  ['neither', '---\ntools: Read\n---\nBODY', 'no name or description'],
  ['an empty name', '---\nname: ""\ndescription: d\n---\nBODY', 'no name'],
] as const) {
  test(`an agent file with ${why} is skipped as Claude Code skips it: Explore.md does not override the built-in, and /klyth says so`, async () => {
    const w = world({ [`${PROJECT}/Explore.md`]: text })
    await w.spawn('Explore')
    expect(w.s.routes.get('a-Explore')).toMatchObject({ type: 'Explore' })
    expect(await definitionOf(w.io, w.s, 'Explore')).toBeUndefined()
    expect(await contested(w.io, w.s, 'Explore')).toBe(false)
    expect(w.s.notes).toEqual([`agents: ${PROJECT}/Explore.md has ${said}, which Claude Code requires of a file in .claude/agents, so it skips the file and so does klyth`])
    expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
  })
}

test('a custom type whose only file lacks a description has no definition: the spawn stays native, as a missing file would', async () => {
  const w = world({ [`${PROJECT}/scout.md`]: '---\nname: scout\n---\nBODY' })
  await w.spawn('scout')
  expect(w.s.routes.size).toBe(0)
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: scout has no readable definition; it stays native'])
})

test('one file that names a custom type under another file name defines it: its body is the definition, and the spawn is claimed', async () => {
  const w = world({ [`${PROJECT}/finder-renamed.md`]: agentFile('finder', undefined, undefined, 'FINDER BODY'), [`${PROJECT}/finder.md`]: agentFile('other') })
  await w.spawn('finder')
  expect([...w.s.routes].map(([id, r]) => [id, r.type, r.target])).toEqual([['a-finder', 'finder', 'fast']])
  expect((await definitionOf(w.io, w.s, 'finder'))?.prompt).toBe('FINDER BODY')
  expect(w.debug).toContain(`klyth agent-def finder from ${PROJECT}/finder-renamed.md`)
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
})

test('a plugin agent is found by its name: in its plugin\'s agents directory, whatever its file is called', async () => {
  const installed = JSON.stringify({ plugins: { 'myplug@market': [{ installPath: '/cache/myplug' }] } })
  const w = world({ '/home/u/.claude/plugins/installed_plugins.json': installed, '/cache/myplug/agents/audit-v3.md': agentFile('auditor', undefined, undefined, 'AUDIT BODY') })
  await w.spawn('myplug:auditor')
  expect([...w.s.routes.keys()]).toEqual(['a-myplug:auditor'])
  expect((await definitionOf(w.io, w.s, 'myplug:auditor'))?.prompt).toBe('AUDIT BODY')
})

// Claude Code takes a plugin agent's name from its file name when the frontmatter has none, and gives it a default
// description, so a plugin agent file needs neither field.
test('a plugin agent file with tools: and no description (or no name) keeps its definition and its tool filter, and its spawn is claimed', async () => {
  const installed = JSON.stringify({ plugins: { 'myplug@market': [{ installPath: '/cache/myplug' }] } })
  const w = world({
    '/home/u/.claude/plugins/installed_plugins.json': installed,
    '/cache/myplug/agents/auditor.md': '---\ntools: Read, Grep\n---\nAUDIT BODY',
    '/cache/myplug/agents/check-v2.md': '---\nname: checker\ntools: [Read]\n---\nCHECK BODY',
  })
  await w.spawn('myplug:auditor')
  await w.spawn('myplug:checker')
  expect([...w.s.routes.keys()]).toEqual(['a-myplug:auditor', 'a-myplug:checker'])
  const auditor = await definitionOf(w.io, w.s, 'myplug:auditor')
  expect(auditor).toMatchObject({ prompt: 'AUDIT BODY', tools: ['Read', 'Grep'] })
  expect(['Read', 'Grep', 'Write', 'Bash'].filter(toolFilter('myplug:auditor', auditor))).toEqual(['Read', 'Grep'])
  expect((await definitionOf(w.io, w.s, 'myplug:checker'))?.prompt).toBe('CHECK BODY')
  expect(w.s.notes).toEqual([])
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
})

test('of two files that name a custom type, the project one is its definition for a routed step, though the spawn of the type is left native', async () => {
  const w = world({ [`${PROJECT}/scout-new.md`]: agentFile('scout', undefined, undefined, 'PROJECT BODY'), [`${USER}/scout.md`]: agentFile('scout', undefined, undefined, 'USER BODY') })
  expect((await definitionOf(w.io, w.s, 'scout'))?.prompt).toBe('PROJECT BODY')
})

test('an agents directory with more entries than klyth reads, and a directory that will not list, leave a type native: klyth cannot tell what they define', async () => {
  const many = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`${PROJECT}/a${i}.md`, agentFile(`a${i}`)]))
  const w = world({ ...many, [`${PROJECT}/scout.md`]: agentFile('scout') })
  await w.spawn('Explore')
  await w.spawn('scout')
  expect(w.s.routes.size).toBe(0)
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([CONTESTED('Explore'), 'klyth inherit: scout has no readable definition; it stays native'])
  const down = world({ [`${PROJECT}/scout.md`]: agentFile('scout') })
  down.io.listDir = async () => {
    throw new Error('EACCES')
  }
  await down.spawn('Explore')
  expect(down.s.routes.size).toBe(0)
  expect(down.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([CONTESTED('Explore')])
})

// --- a call klyth made of a routed model's klyth agent call ---------------------------------------------------------

test('a call noted with a klyth target is claimed for that target, whatever the parent runs on, and started on the parent\'s engine model', async () => {
  const w = world()
  w.s.calls.set('u-Explore', { target: 'strong', effort: 'high' })
  const started = await w.spawn('Explore')
  expect(started).toEqual({ model: PARENT, agentId: 'a-Explore' })
  expect(w.seen.map(e => e.model)).toEqual([PARENT])
  const route: Route = { target: 'strong', label: 'strong', type: 'Explore', prompt: 'audit', effort: 'high' }
  expect(w.s.routes.get('a-Explore')).toEqual(route)
  expect(w.persisted).toEqual([['a-Explore', route]])
  expect(w.s.calls.has('u-Explore')).toBe(false)
  expect(w.debug).toContain('klyth spawn a-Explore → strong requested by Explore from main effort=high')
  w.s.pin = { turnId: 't2', target: null }
  w.s.calls.set('u-Plan', { target: 'strong' })
  await w.spawn('Plan', { parentModel: 'claude-sonnet-5-5', started: { model: 'claude-sonnet-5-5' } })
  expect(w.s.routes.get('a-Plan')?.target).toBe('strong')
})

test('a call noted with a native target is started as it is and claimed by no one', async () => {
  const w = world()
  w.s.calls.set('u-Explore', { target: null })
  const started = await w.spawn('Explore', { event: { model: 'opus' }, started: { model: 'claude-opus-5-5' } })
  expect(started).toEqual({ model: 'claude-opus-5-5', agentId: 'a-Explore' })
  expect(w.seen.map(e => e.model)).toEqual(['opus'])
  expect(w.s.routes.size).toBe(0)
  expect(w.debug).toEqual([])
})

test('a noted call to a type klyth cannot run is refused, and the same type inherited stays native', async () => {
  const w = world()
  w.s.calls.set('u-comment-thread-analyst', { target: 'strong' })
  expect(await w.spawn('comment-thread-analyst')).toEqual({ deny: 'klyth agent: comment-thread-analyst is not a type klyth can run, so klyth cannot run it on strong; use another subagent_type or a native model' })
  expect(w.s.routes.size).toBe(0)
  expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual(['klyth inherit: comment-thread-analyst is not a type klyth can run; the call is refused'])
})

test('a noted call to a custom type with no readable definition is claimed, and /klyth says it runs as general-purpose; the same type inherited stays native', async () => {
  for (const type of ['auditor', 'myplug:auditor']) {
    const w = world()
    w.s.calls.set(`u-${type}`, { target: 'strong' })
    expect(await w.spawn(type)).toEqual({ model: PARENT, agentId: `a-${type}` })
    expect(w.s.routes.get(`a-${type}`)).toEqual({ target: 'strong', label: 'strong', type, prompt: 'audit' })
    expect(w.s.notes).toEqual([expect.stringMatching(new RegExp(`^agents: ${type} has no readable definition \\(.*\\); it runs as general-purpose$`))])
    expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([])
    const inherited = world()
    await inherited.spawn(type)
    expect(inherited.s.routes.size).toBe(0)
  }
})

for (const [why, files, type, event, reason] of [
  ['a built-in type that two agent files name', { '/w/.claude/agents/a.md': agentFile('Explore'), '/home/u/.claude/agents/b.md': agentFile('Explore') }, 'Explore', {}, 'has more than one definition'],
  ['a custom agent whose definition runs it isolated elsewhere', { '/w/.claude/agents/far.md': agentFile('far', undefined, 'remote') }, 'far', {}, 'runs isolated as remote'],
  ['a call that sets a cwd', {}, 'Explore', { cwd: '/elsewhere' }, 'sets its own cwd (/elsewhere)'],
  ['a call the engine started as a teammate', {}, 'Explore', { isTeammate: true }, 'is a teammate or a workflow agent'],
  ['a call from a subagent that works in a worktree', {}, 'Explore', { parentAgentId: 'parent' }, 'is spawned by a subagent in a worktree'],
] as const) {
  test(`${why}: the spawn is denied with one line, and nothing starts natively`, async () => {
    const w = world(files, {}, { stored: { parent: { target: 'fast', label: 'fast', type: 'Explore', worktree: { path: '/w/.claude/worktrees/agent-x', engine: true } } } })
    w.s.calls.set(`u-${type}`, { target: 'strong' })
    const started = await w.spawn(type, { event: event as Partial<AgentSpawnInput> })
    expect(started).toEqual({ deny: `klyth agent: ${type} ${reason}, so klyth cannot run it on strong; use another subagent_type or a native model` })
    expect(w.seen).toEqual([])
    expect(w.s.routes.size).toBe(0)
    expect(w.persisted).toEqual([])
    expect(w.s.pendingSpawns.size).toBe(0)
  })
}

test("a noted call to a custom type whose definition names a model of its own is claimed: the spawn starts on the parent's model, whatever the definition says", async () => {
  const w = world({ '/w/.claude/agents/scout.md': agentFile('scout', 'sonnet') })
  w.s.calls.set('u-scout', { target: 'strong' })
  const started = await w.spawn('scout')
  expect(started).toEqual({ model: PARENT, agentId: 'a-scout' })
  expect(w.seen.map(e => e.model)).toEqual([PARENT])
  expect(w.s.routes.get('a-scout')).toEqual({ target: 'strong', label: 'strong', type: 'scout', prompt: 'audit' })
  const inherited = world({ '/w/.claude/agents/scout.md': agentFile('scout', 'sonnet') })
  await inherited.spawn('scout', { started: { model: 'claude-sonnet-5-5' } })
  expect(inherited.s.routes.size).toBe(0)
  expect(inherited.seen.map(e => e.model)).toEqual([undefined])
})

// A routed session over the example config's aliases (strong, fast), for a call whose model has to resolve.
const configured = (w: ReturnType<typeof world>) => void (w.s.loaded = { config: parseConfig(CONFIG).config, text: CONFIG, errors: [], missing: false, path: '~/.claude/klyth.json' })
const REFUSED = (why: string) => `klyth agent: ${why}, so klyth did not run the subagent on strong; retry, or use a native model`

for (const [why, o, reason, line] of [
  [
    'started on another model than its parent\'s',
    { started: { model: 'claude-sonnet-5-5' }, files: {}, listed: {} },
    `the engine started it on claude-sonnet-5-5, not its parent's ${PARENT}`,
    `klyth inherit: the engine resolved claude-sonnet-5-5 for Explore, not its parent's ${PARENT}; its first step hands the failure back`,
  ],
  [
    'rewritten to another type by a hook beneath',
    { files: {}, listed: { 'a-Explore': 'Plan' } },
    'a hook changed Explore to Plan',
    'klyth inherit: a hook changed Explore to Plan; its first step hands the failure back',
  ],
  [
    'isolated, with no worktree made by the engine',
    { files: {}, listed: {}, note: { isolated: true } },
    'the engine made no worktree for the isolated subagent',
    'klyth inherit: the engine made no worktree for a-Explore (Explore); its first step hands the failure back',
  ],
] as const) {
  test(`a noted call whose subagent was ${why} cannot be taken back: its route refuses, so its first step hands the reason back, and it is persisted`, async () => {
    const w = world(o.files, o.listed)
    w.s.calls.set('u-Explore', { target: 'strong', ...('note' in o ? o.note : {}) })
    const started = await w.spawn('Explore', 'started' in o ? { started: o.started } : {})
    expect(started).toMatchObject({ agentId: 'a-Explore' })
    const route: Route = { target: 'strong', label: 'strong', type: 'Explore', prompt: 'audit', refused: REFUSED(reason) }
    expect(w.s.routes.get('a-Explore')).toEqual(route)
    expect(w.persisted).toEqual([['a-Explore', route]])
    expect(w.debug.filter(l => l.startsWith('klyth inherit:'))).toEqual([line])
    expect(w.debug.some(l => l.startsWith('klyth spawn '))).toBe(false)
  })
}

test('an inherited spawn that cannot be claimed after it started still runs native, as before: its caller named no model', async () => {
  const w = world({}, { 'a-Explore': 'Plan' })
  await w.spawn('Explore')
  expect(w.s.routes.size).toBe(0)
  expect(w.persisted).toEqual([])
})

// --- a klyth-made call whose note is gone ------------------------------------------------------------------------

test('a spawn whose note is gone (a hot reload, the cap) but whose call is recorded in state is claimed on the model that record names', async () => {
  const w = world({}, {}, { recorded: { main: { 'u-Explore': 'strong' }, sub1: { 'u-Plan': 'fast' } } })
  configured(w)
  await w.spawn('Explore')
  w.s.calls.set('u-Plan', { effort: 'high' })
  await w.spawn('Plan', { event: { parentAgentId: 'sub1' } })
  expect([...w.s.routes].map(([id, r]) => [id, r.target, r.effort])).toEqual([['a-Explore', 'strong', undefined], ['a-Plan', 'fast', 'high']])
  expect(w.seen.map(e => e.model)).toEqual([PARENT, PARENT])
  expect(w.s.translated.get('main')).toEqual({ 'u-Explore': 'strong' })
})

test('a spawn whose recorded model no longer resolves is denied with one line, and never takes its parent\'s route', async () => {
  const w = world({}, {}, { recorded: { main: { 'u-Explore': 'gone' } } })
  configured(w)
  expect(await w.spawn('Explore')).toEqual({ deny: 'klyth agent: gone is not configured any more, so the subagent did not start; fix ~/.claude/klyth.json and ask again' })
  expect(w.seen).toEqual([])
  expect(w.s.routes.size).toBe(0)
  const none = world({}, {}, { recorded: { main: { 'u-Explore': 'strong' } } })
  expect(await none.spawn('Explore')).toMatchObject({ deny: expect.stringContaining('strong is not configured any more') })
  expect(none.seen).toEqual([])
})

test('a recorded native model passes its spawn on untouched; a spawn with no record is a plain Agent call and inherits as before', async () => {
  const w = world({}, {}, { recorded: { main: { 'u-Explore': 'opus' } } })
  configured(w)
  await w.spawn('Explore', { event: { model: 'opus' }, started: { model: 'claude-opus-5-5' } })
  expect(w.seen.map(e => e.model)).toEqual(['opus'])
  expect(w.s.routes.size).toBe(0)
  const plain = world({}, {}, { recorded: { main: { other: 'strong' } } })
  await plain.spawn('Explore')
  expect([...plain.s.routes].map(([id, r]) => [id, r.target])).toEqual([['a-Explore', 'fast']])
  expect(plain.seen.map(e => e.model)).toEqual([undefined])
})

test('the note of a klyth-made call keeps its target when the Agent call adds its effort and isolation', () => {
  const s = createSession()
  s.calls.set('u', { target: 'strong' })
  noteCall(s, { tool_use_id: 'u', effort: 'high', isolation: 'worktree' })
  expect(s.calls.get('u')).toEqual({ target: 'strong', effort: 'high', isolated: true })
  noteCall(s, { tool_use_id: 'plain' })
  expect(s.calls.has('plain')).toBe(false)
})

// --- the Critical seen live (LV-N0): a loop klyth's own spawn started raises every dispatch with klyth as origin ----
test('a call noted with a klyth target from a loop klyth itself started (origin klyth, with a parentAgentId) is claimed, not left native', async () => {
  const w = world()
  w.s.calls.set('u-Explore', { target: 'strong' })
  const e = { tool_use_id: 'u-Explore', prompt: 'audit', description: 'd', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: PARENT, parentAgentId: 'child-of-tool', background: true, fork: false } as AgentSpawnInput
  const started = await inheritSpawn(w.io, w.s, e, 'klyth', async given => (w.seen.push(given), { model: PARENT, agentId: 'a-Explore' }))
  expect(started).toEqual({ model: PARENT, agentId: 'a-Explore' })
  expect(w.s.routes.get('a-Explore')?.target).toBe('strong')
  expect(w.seen.map(x => x.model)).toEqual([PARENT])
})

test("klyth's own direct spawn (origin klyth, no parentAgentId) is still never claimed", async () => {
  const w = world()
  const e = { tool_use_id: 'toolu_plugin_x', prompt: 'audit', description: 'd', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: PARENT, background: true, fork: false } as AgentSpawnInput
  await inheritSpawn(w.io, w.s, e, 'klyth', async given => (w.seen.push(given), { model: PARENT, agentId: 'a-Explore' }))
  expect(w.s.routes.size).toBe(0)
  expect(w.seen.map(x => x.model)).toEqual([undefined])
})

// --- the parent of a claimed child ----------------------------------------------------------------------------

test("a claimed child's route names the subagent that spawned it as its parent, inherited or requested, in memory and in what is persisted; a child of main has none", async () => {
  const w = world()
  w.s.routes.set('sub1', { target: 'fast', label: 'fast', type: 'general-purpose' })
  w.s.calls.set('u-Plan', { target: 'strong' })
  await w.spawn('Explore', { event: { parentAgentId: 'sub1' } })
  await w.spawn('Plan', { event: { parentAgentId: 'sub1' } })
  await w.spawn('general-purpose')
  const inherited: Route = { target: 'fast', label: 'fast', type: 'Explore', prompt: 'audit', parent: 'sub1' }
  const requested: Route = { target: 'strong', label: 'strong', type: 'Plan', prompt: 'audit', parent: 'sub1' }
  const ofMain: Route = { target: 'fast', label: 'fast', type: 'general-purpose', prompt: 'audit' }
  expect([...w.s.routes].slice(1)).toStrictEqual([['a-Explore', inherited], ['a-Plan', requested], ['a-general-purpose', ofMain]])
  expect(w.persisted).toStrictEqual([['a-Explore', inherited], ['a-Plan', requested], ['a-general-purpose', ofMain]])
})

test('routedFork names the target a native fork call would be claimed on, and nothing for any other call or a parent it cannot read', async () => {
  const strong: Route = { target: 'strong', label: 'strong' }
  const w = world({}, {}, { stored: { par: strong } })
  const fork = { input: { subagent_type: 'fork' } }
  expect(await routedFork(w.io, w.s, fork)).toBe('fast')
  expect(await routedFork(w.io, w.s, { ...fork, agentId: 'par' })).toBe('strong')
  expect(await routedFork(w.io, w.s, { ...fork, agentId: 'nat' })).toBeUndefined()
  const down = { ...w.io, route: async () => Promise.reject(new Error('state down')) }
  expect(await routedFork(down, w.s, { ...fork, agentId: 'par' })).toBeUndefined()
  w.s.pin = { turnId: 't1', target: null }
  expect(await routedFork(w.io, w.s, fork)).toBeUndefined()
  w.s.pin = { turnId: 't1', target: 'fast' }
  expect(await routedFork(w.io, w.s, { input: { subagent_type: 'Explore' } })).toBeUndefined()
  expect(await routedFork(w.io, w.s, { input: {} })).toBeUndefined()
})

// --- a native main's klyth agent call, made an Agent call by nativeMain (native-step.ts) ---------------------------

test('a native main call that nativeMain rewrote is claimed on its alias, its task vetted only as the call carried it', async () => {
  for (const [prompt, vetted] of [['audit', true], ['a task the call did not carry', false]] as const) {
    const w = world()
    w.s.pin = { turnId: 't1', target: null }
    w.s.loaded = { config: parseConfig(CONFIG).config, text: CONFIG, errors: [], missing: false, path: '~/.claude/klyth.json' }
    const call = JSON.stringify({ model: 'strong', prompt: 'audit', description: 'd', subagent_type: 'Explore' })
    async function* native() {
      yield { kind: 'tool', index: 0, id: 'u-Explore', name: WRAPPER } as const
      yield { kind: 'input', index: 0, json: call } as const
      return { turnId: 't1', index: 0, answer: '', toolUses: [{ name: WRAPPER, input: JSON.parse(call) as unknown }], stopReason: 'tool_use', usage: null } as const
    }
    const ports = { trusted: async () => true, translated: async () => undefined, setTranslated: async () => {}, debug: () => {}, list: async () => [{ name: 'Agent' }, { name: WRAPPER }] }
    const it = nativeMain(ports, w.s, native)
    for (let n = await it.next(); !n.done; n = await it.next());
    await w.spawn('Explore', { event: { prompt } })
    expect(w.s.routes.get('a-Explore')?.target, prompt).toBe('strong')
    expect(w.s.vettedSpawns.has('a-Explore'), prompt).toBe(vetted)
  }
})
