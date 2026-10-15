// The tool.call guard that holds a routed subagent to the tools its last remote step offered, what a
// config reload leaves alone, and the one reset it performs.
import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Route } from '../types'
import { guardFailed } from '../hooks/pool'
import type { StepStats } from '../hooks/protocol'
import { createSession } from '../hooks/session'
import { HANDBACK_REMINDER, start, step, klyth, world } from './world'

// Main's tool list as `$.tool.list()` gives it, the tools Explore may not call among them.
const MAIN_TOOLS = ['Agent', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Artifact', 'ArtifactCheck', 'WebFetch', 'Write', 'mcp__klyth__agent'].map(name => ({
  name,
  description: name,
  mcp: name.startsWith('mcp__'),
}))
const EXPLORE = { target: 'acme/model-a', label: 'fast', type: 'Explore', prompt: 'Search the fixture for retry logic.' }
const write = ($: Engine, agentId?: string) => $.tool.call({ tool: 'Write', file_path: '/w/a.txt', content: 'x', ...(agentId === undefined ? {} : { agentId }) })
const read = ($: Engine, agentId?: string) => $.tool.call({ tool: 'Read', file_path: '/w/a.txt', ...(agentId === undefined ? {} : { agentId }) })
const bash = ($: Engine, agentId?: string) => $.tool.call({ tool: 'Bash', command: 'ls', ...(agentId === undefined ? {} : { agentId }) })
// What a tool does when nothing denies it.
const runs = (on: On) => {
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'file text' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }))
}

test('a routed subagent is denied a tool its step did not offer, and runs the ones it did', async ($, on) => {
  runs(on)
  const w = world(on, { routes: { ex1: EXPLORE }, tools: MAIN_TOOLS })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'ex1' })
  expect(await write($, 'ex1')).toEqual({ deny: 'klyth: Write is not available to the Explore subagent' })
  expect(await read($, 'ex1')).toEqual({ result: 'file text' })
  expect(w.debug).toContain('klyth guard ex1 Write denied')
  expect(w.debug).toContain('klyth guard ex1 Read allowed')
})

test('a native subagent and the main conversation pass the guard, even while klyth routes main', async ($, on) => {
  runs(on)
  const w = world(on, { routes: { nat: { target: null, label: 'haiku' }, ex1: EXPLORE }, tools: MAIN_TOOLS, pin: { turnId: 'm', target: 'acme/model-b' } })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  await step($, { turnId: 's', index: 0, agentId: 'ex1' })
  await step($, { turnId: 'n', index: 0, agentId: 'nat' })
  expect(await write($, 'nat')).toEqual({ result: 'written' })
  expect(await write($)).toEqual({ result: 'written' })
  expect(await write($, 'stranger')).toEqual({ result: 'written' })
  expect(w.debug.filter(l => l.startsWith('klyth guard'))).toEqual([])
})

test('a subagent with no route is native: its route is looked up once, not at every tool call, until its turn finishes', async ($, on) => {
  runs(on)
  const w = world(on, { tools: MAIN_TOOLS })
  await start($)
  for (let i = 0; i < 3; i++) expect(await write($, 'nat1')).toEqual({ result: 'written' })
  expect(w.routeReads).toEqual(['nat1'])
  await $.turn.complete({ answer: 'report', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', agentId: 'nat1' })
  for (let i = 0; i < 2; i++) expect(await write($, 'nat1')).toEqual({ result: 'written' })
  expect(w.routeReads).toEqual(['nat1', 'nat1'])
})

test('a general-purpose subagent is offered every tool its type allows, so the guard lets them run', async ($, on) => {
  runs(on)
  world(on, { routes: { gp1: { ...EXPLORE, type: 'general-purpose' } }, tools: MAIN_TOOLS })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'gp1' })
  expect(await write($, 'gp1')).toEqual({ result: 'written' })
  expect(await read($, 'gp1')).toEqual({ result: 'file text' })
})

test('the offered set follows each step: a tool that was not offered at step 0 is allowed once a step offers it', async ($, on) => {
  runs(on)
  let tools = MAIN_TOOLS.filter(t => t.name === 'Read')
  world(on, { routes: { gp1: { ...EXPLORE, type: 'general-purpose' } }, tools: () => tools })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'gp1' })
  expect(await write($, 'gp1')).toEqual({ deny: 'klyth: Write is not available to the general-purpose subagent' })
  tools = MAIN_TOOLS
  await step($, { turnId: 't', index: 1, agentId: 'gp1' })
  expect(await write($, 'gp1')).toEqual({ result: 'written' })
})

test('a failed check denies a routed subagent and lets any other agent go on', () => {
  const s = createSession()
  s.routes.set('ex1', EXPLORE)
  s.routes.set('nat', { target: null, label: 'haiku' })
  s.offered.set('known', new Set(['Read']))
  const denied = { deny: 'klyth: could not check Write for this subagent, so it was denied; retry, or see the debug log' }
  expect(guardFailed(s, { tool: 'Write', agentId: 'ex1' })).toEqual(denied)
  expect(guardFailed(s, { tool: 'Write', agentId: 'known' })).toEqual(denied)
  expect(guardFailed(s, { tool: 'Write', agentId: 'nat' })).toBeUndefined()
  // an agent klyth has not cached is denied: a failed route read must not let a restricted child through
  expect(guardFailed(s, { tool: 'Write', agentId: 'stranger' })).toEqual(denied)
  expect(guardFailed(s, { tool: 'Write' })).toBeUndefined()
})

test('a /klyth reload mid-run keeps the routes and the offered sets, so the guard still denies', async ($, on) => {
  runs(on)
  const w = world(on, { routes: { ex1: EXPLORE }, tools: MAIN_TOOLS })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'ex1' })
  await klyth($, 'reload')
  expect(await write($, 'ex1')).toEqual({ deny: 'klyth: Write is not available to the Explore subagent' })
  expect(await read($, 'ex1')).toEqual({ result: 'file text' })
  w.transcript.length = 0
  await klyth($)
  expect(w.transcript).toContain('  routed subagents: ex1 → fast')
  expect(w.transcript.some(l => l.startsWith('  last step ex1 → fast'))).toBe(true)
})

test('a /klyth reload mid-run keeps main routed: a turn pinned before it still goes remote', async ($, on) => {
  const w = world(on, { pin: { turnId: 'm', target: 'acme/model-b' } })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  await klyth($, 'reload')
  await step($, { turnId: 'm', index: 1 })
  expect(w.requests).toHaveLength(2)
  expect(w.nativeSteps).toEqual([])
})

test('resetForReload clears what the config text decides, and nothing a running turn needs', () => {
  const s = createSession()
  const stats: StepStats = { ttfbMs: 1, totalMs: 2, reqBytes: 3, in: 4, out: 5, finish: 'stop' }
  s.agentFiles.set('/a.md', null)
  s.agentNotes.add('scout')
  s.approved.add('openai|https://x|cmd:[]')
  s.mcpSchemas = { t: {} }
  s.notes.push('a note')
  s.toolReport = { schemaless: ['A'], capped: ['B'], long: ['C'], cap: 2 }
  const route = { target: 'acme/model-a', label: 'fast' }
  const pending = Promise.resolve()
  s.routes.set('ex1', route)
  s.pendingSpawns.add(pending)
  s.steps.set('main:t:0', { target: 'acme/model-a' })
  s.offered.set('ex1', new Set(['Read']))
  s.pools.set('ex1', () => true)
  s.promptTokens.set('main', { tokens: 10, messageCount: 2 })
  s.lastSteps.set('main', { target: 'acme/model-a', stats, prompt: 'main' })
  s.blindHandbacks.set('ex1', 't')
  s.goodAliases = ['fast']
  s.main = 'acme/model-a'
  s.pin = { turnId: 't', target: 'acme/model-a' }
  s.trashPath = '/opt/bin/trash'
  s.platform = 'darwin'
  const loaded = s.loaded

  s.resetForReload()

  expect([s.agentFiles.size, s.agentNotes.size, s.pools.size, s.approved.size, s.notes.length]).toEqual([0, 0, 0, 0, 0])
  expect(s.mcpSchemas).toEqual({})
  expect(s.toolReport).toEqual({ schemaless: [], capped: [], long: [], cap: 0 })
  expect(s.routes.get('ex1')).toBe(route)
  expect(s.pendingSpawns.has(pending)).toBe(true)
  expect(s.steps.has('main:t:0')).toBe(true)
  expect([...(s.offered.get('ex1') ?? [])]).toEqual(['Read'])
  expect(s.promptTokens.get('main')).toEqual({ tokens: 10, messageCount: 2 })
  expect(s.lastSteps.get('main')?.stats).toBe(stats)
  expect(s.blindHandbacks.get('ex1')).toBe('t')
  expect([s.goodAliases, s.main, s.pin, s.trashPath, s.platform, s.loaded]).toEqual([['fast'], 'acme/model-a', { turnId: 't', target: 'acme/model-a' }, '/opt/bin/trash', 'darwin', loaded])
})

test('after a hot reload the guard still holds a routed subagent: its route is read back from state and its offered set rebuilt from its type', async ($, on) => {
  runs(on)
  const w = world(on, { routes: { ex1: EXPLORE }, tools: MAIN_TOOLS })
  await start($)
  expect(await write($, 'ex1')).toEqual({ deny: 'klyth: Write is not available to the Explore subagent' })
  expect(await read($, 'ex1')).toEqual({ result: 'file text' })
  expect(w.debug).toContain('klyth guard ex1 Write denied')
  expect(await write($, 'nat')).toEqual({ result: 'written' })
  expect(await write($)).toEqual({ result: 'written' })
})

test("a custom agent type's set is rebuilt from its definition after a reload, and SubagentHandback stays allowed", async ($, on) => {
  runs(on)
  // The engine's own tool for a subagent, which no tool name type lists.
  on('tool.call', { tool: 'SubagentHandback' as never }, () => ({ result: 'handed back' }))
  world(on, {
    routes: { c1: { target: 'acme/model-a', label: 'fast', type: 'scout' } },
    tools: MAIN_TOOLS,
    files: { '/w/.claude/agents/scout.md': '---\nname: scout\ndescription: d\ntools: Read\n---\nSCOUT BODY' },
  })
  await start($)
  expect(await write($, 'c1')).toEqual({ deny: 'klyth: Write is not available to the scout subagent' })
  expect(await read($, 'c1')).toEqual({ result: 'file text' })
  expect(await $.tool.call({ tool: 'SubagentHandback', message: 'done', agentId: 'c1' } as never)).toEqual({ result: 'handed back' })
})

test("a subagent's finished turn forgets what the session held of it; a later message to it routes again and the guard rebuilds its set", async ($, on) => {
  runs(on)
  const w = world(on, { routes: { ex1: EXPLORE }, tools: MAIN_TOOLS })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'ex1' })
  await klyth($)
  expect(w.transcript).toContain('  routed subagents: ex1 → fast')
  expect(w.transcript.some(l => l.startsWith('  last step ex1 → fast'))).toBe(true)
  w.transcript.length = 0
  await $.turn.complete({ answer: 'report', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', agentId: 'ex1' })
  await klyth($)
  expect(w.transcript).toContain('  routed subagents: none')
  expect(w.transcript.some(l => l.startsWith('  last step ex1'))).toBe(false)
  await step($, { turnId: 't2', index: 0, agentId: 'ex1' })
  expect(w.requests).toHaveLength(2)
  expect(await write($, 'ex1')).toEqual({ deny: 'klyth: Write is not available to the Explore subagent' })
})

test('forget drops one subagent from every map, an unfinished step of it included, and leaves the others', () => {
  const s = createSession()
  const stats: StepStats = { ttfbMs: 1, totalMs: 2, reqBytes: 3, in: 4, out: 5, finish: 'stop' }
  for (const id of ['ex1', 'ex10']) {
    s.routes.set(id, EXPLORE)
    s.offered.set(id, new Set(['Read']))
    s.pools.set(id, () => true)
    s.lastSteps.set(id, { target: 'acme/model-a', stats, prompt: 'main' })
    s.promptTokens.set(id, { tokens: 1, messageCount: 1 })
    s.blindHandbacks.set(id, 't')
    s.translated.set(id, { toolu_x: 'fast' })
    s.steps.set(`${id}:t:0`, { target: 'acme/model-a' })
  }
  s.steps.set('main:t:0', { target: 'acme/model-a' })
  s.forget('ex1')
  for (const m of [s.routes, s.offered, s.pools, s.lastSteps, s.promptTokens, s.blindHandbacks, s.translated]) expect([...m.keys()], 'a map').toEqual(['ex10'])
  expect([...s.steps.keys()]).toEqual(['ex10:t:0', 'main:t:0'])
})

// A routed subagent whose agent file allows Read alone, and children of it whose own type, general-purpose, allows
// every tool but main's own.
const SCOUT_FILES = { '/w/.claude/agents/scout.md': '---\nname: scout\ndescription: d\ntools: Read\n---\nSCOUT BODY' }
const SCOUT = { target: 'acme/model-a', label: 'fast', type: 'scout' }
const kid = (parent?: string): Route => ({ target: 'acme/model-a', label: 'fast', type: 'general-purpose', ...(parent === undefined ? {} : { parent }) })
// The tool names the nth provider request offered.
const offeredIn = (w: ReturnType<typeof world>, n: number) => ((w.requests[n]?.body['tools'] as { function: { name: string } }[] | undefined) ?? []).map(t => t.function.name)
const EVERY = [...MAIN_TOOLS.map(t => t.name).filter(name => name !== 'ExitPlanMode'), 'SubagentHandback']

test('a child of a routed parent restricted to Read is offered no Bash, and is denied it with the line it would be denied anywhere', async ($, on) => {
  runs(on)
  const w = world(on, { routes: { par: SCOUT, kid: kid('par') }, tools: MAIN_TOOLS, files: SCOUT_FILES })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'kid' })
  expect(offeredIn(w, 0)).toEqual(['Read', 'SubagentHandback'])
  expect(await bash($, 'kid')).toEqual({ deny: 'klyth: Bash is not available to the general-purpose subagent' })
  expect(await write($, 'kid')).toEqual({ deny: 'klyth: Write is not available to the general-purpose subagent' })
  expect(await read($, 'kid')).toEqual({ result: 'file text' })
})

test("a child's pool follows the whole chain, from state alone after a hot reload: a grandchild of a Read-only agent gets Read, and Bash is denied", async ($, on) => {
  runs(on)
  const w = world(on, { routes: { par: SCOUT, mid: kid('par'), low: kid('mid') }, tools: MAIN_TOOLS, files: SCOUT_FILES })
  await start($)
  expect(await bash($, 'low')).toEqual({ deny: 'klyth: Bash is not available to the general-purpose subagent' })
  expect(await read($, 'low')).toEqual({ result: 'file text' })
  expect(w.debug).toContain('klyth guard low Bash denied')
  // Each route of the chain is read from state once.
  expect(w.routeReads).toEqual(['low', 'mid', 'par'])
})

test("a child of main is unchanged by the pools of other agents, and so is a child of a parent that has every tool its type allows", async ($, on) => {
  runs(on)
  const w = world(on, { routes: { par: SCOUT, free: kid(), gp: kid(), kid1: kid('gp') }, tools: MAIN_TOOLS, files: SCOUT_FILES })
  await start($)
  for (const [n, id] of ['free', 'gp', 'kid1'].entries()) {
    await step($, { turnId: 't', index: 0, agentId: id })
    expect(offeredIn(w, n), id).toEqual(EVERY)
    expect(await bash($, id), id).toEqual({ result: 'ran' })
    expect(await write($, id), id).toEqual({ result: 'written' })
  }
  expect(await bash($, 'par')).toEqual({ deny: 'klyth: Bash is not available to the scout subagent' })
})

test("an Explore whose override file has a tools: line is held to it: Write is not offered and the guard denies it, as it denies Edit; Read and Bash run", async ($, on) => {
  runs(on)
  const files = { '/w/.claude/agents/x.md': '---\nname: Explore\ndescription: d\ntools: Read, Bash\n---\nEXPLORE FILE BODY' }
  const w = world(on, { routes: { ex1: EXPLORE }, tools: MAIN_TOOLS, files })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'ex1' })
  expect(offeredIn(w, 0)).toEqual(['Bash', 'Read', 'SubagentHandback'])
  expect(await write($, 'ex1')).toEqual({ deny: 'klyth: Write is not available to the Explore subagent' })
  expect(await $.tool.call({ tool: 'Edit', file_path: '/w/a.txt', old_string: 'a', new_string: 'b', agentId: 'ex1' } as never)).toEqual({ deny: 'klyth: Edit is not available to the Explore subagent' })
  expect(await read($, 'ex1')).toEqual({ result: 'file text' })
  expect(await bash($, 'ex1')).toEqual({ result: 'ran' })
})

// Every conversation reads back the turn whose Agent call started the forks below, so each fork's history rebuilds.
const FORKED = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'fork-call', name: 'Agent', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fork-call', content: 'started' }, { type: 'text', text: 'go' }] },
]

test("a fork's pool is capped by its parent's and holds no SubagentHandback, though a call of it reaches the engine: a fork of a Read-only agent is offered Read, and Bash and Write are denied; a fork of main has every tool a subagent may but that", async ($, on) => {
  runs(on)
  on('tool.call', { tool: 'SubagentHandback' as never }, () => ({ result: 'engine says' }))
  const fork = (parent?: string): Route => ({ target: 'acme/model-a', label: 'fast', type: 'fork', forkOf: 'fork-call', ...(parent === undefined ? {} : { parent }) })
  const w = world(on, { routes: { par: SCOUT, fk: fork('par'), fk2: fork('fk'), mfk: fork() }, tools: MAIN_TOOLS, files: SCOUT_FILES, messages: FORKED })
  await start($)
  for (const id of ['fk', 'fk2', 'mfk']) await step($, { turnId: 't', index: 0, agentId: id })
  expect(offeredIn(w, 0)).toEqual(['Read'])
  expect(offeredIn(w, 1)).toEqual(['Read'])
  expect(offeredIn(w, 2)).toEqual(EVERY.filter(name => name !== 'SubagentHandback'))
  expect(await $.tool.call({ tool: 'SubagentHandback', message: 'done', agentId: 'fk' } as never)).toEqual({ result: 'engine says' })
  expect(w.debug).toContain('klyth guard fk SubagentHandback passed to the engine')
  expect(await bash($, 'fk')).toEqual({ deny: 'klyth: Bash is not available to the fork subagent' })
  expect(await write($, 'fk2')).toEqual({ deny: 'klyth: Write is not available to the fork subagent' })
  expect(await read($, 'fk')).toEqual({ result: 'file text' })
  expect(await write($, 'mfk')).toEqual({ result: 'written' })
})

test('a subagent the engine refused SubagentHandback is offered it no more, and a call of it still reaches the engine', async ($, on) => {
  runs(on)
  on('tool.call', { tool: 'SubagentHandback' as never }, () => ({ result: 'engine says' }))
  const refused = [
    { role: 'user', content: [{ type: 'text', text: 'Search the fixture for retry logic.' }, HANDBACK_REMINDER] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: 'r' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: 'No such tool available: SubagentHandback', is_error: true }] },
    { role: 'assistant', content: [{ type: 'text', text: 'retrying' }] },
    { role: 'user', content: [{ type: 'text', text: 'go on' }] },
  ]
  const w = world(on, { routes: { ex2: EXPLORE }, tools: MAIN_TOOLS, messages: () => refused })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'ex2' })
  expect(offeredIn(w, 0)).not.toContain('SubagentHandback')
  expect(await $.tool.call({ tool: 'SubagentHandback', message: 'done', agentId: 'ex2' } as never)).toEqual({ result: 'engine says' })
  expect(w.debug).toContain('klyth guard ex2 SubagentHandback passed to the engine')
})

test('SubagentHandback stays offered to a child of a parent whose own list leaves it out, in the request and in the guard rebuilt after a reload', async ($, on) => {
  runs(on)
  on('tool.call', { tool: 'SubagentHandback' as never }, () => ({ result: 'handed back' }))
  const w = world(on, { routes: { par: SCOUT, kid: kid('par'), kid2: kid('par') }, tools: MAIN_TOOLS, files: SCOUT_FILES })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'kid' })
  expect(offeredIn(w, 0)).toContain('SubagentHandback')
  expect(await $.tool.call({ tool: 'SubagentHandback', message: 'done', agentId: 'kid' } as never)).toEqual({ result: 'handed back' })
  expect(await $.tool.call({ tool: 'SubagentHandback', message: 'done', agentId: 'kid2' } as never)).toEqual({ result: 'handed back' })
})

test("a pool is kept per agent: the routes above a subagent are read from state once, not at each of its steps, and its finished turn drops its pool", async ($, on) => {
  const w = world(on, { routes: { par: SCOUT, kid: kid('par') }, tools: MAIN_TOOLS, files: SCOUT_FILES })
  await start($)
  for (let index = 0; index < 3; index++) await step($, { turnId: 't', index, agentId: 'kid' })
  expect(w.routeReads).toEqual(['kid', 'par'])
  await $.turn.complete({ answer: 'report', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', agentId: 'kid' })
  await step($, { turnId: 't2', index: 0, agentId: 'kid' })
  expect(w.routeReads).toEqual(['kid', 'par', 'kid'])
  expect(offeredIn(w, 3)).toEqual(['Read', 'SubagentHandback'])
})

for (const [why, routes, above] of [
  ['has no route in memory or state', { kid: kid('ghost') }, 'ghost'],
  ['is a native subagent', { kid: kid('nat'), nat: { target: null, label: 'haiku' } }, 'nat'],
  ['is its own descendant', { kid: kid('top'), top: kid('kid') }, 'top'],
] as const) {
  test(`when the subagent above a child ${why}, the child is offered SubagentHandback alone, in the request and in the guard, until the route can be read`, async ($, on) => {
    runs(on)
    on('tool.call', { tool: 'SubagentHandback' as never }, () => ({ result: 'handed back' }))
    const stored: Record<string, Route> = { ...routes }
    const w = world(on, { routes: stored, tools: MAIN_TOOLS, files: SCOUT_FILES })
    await start($)
    await step($, { turnId: 't', index: 0, agentId: 'kid' })
    expect(offeredIn(w, 0)).toEqual(['SubagentHandback'])
    expect(w.debug).toContain('klyth pool kid: the route of a subagent above it cannot be read, so it is offered SubagentHandback alone')
    expect(await read($, 'kid')).toEqual({ deny: 'klyth: Read is not available to the general-purpose subagent' })
    expect(await $.tool.call({ tool: 'SubagentHandback', message: 'none', agentId: 'kid' } as never)).toEqual({ result: 'handed back' })
    // A pool that failed closed is not kept: once the route above can be read, the next step is offered its tools.
    stored[above] = SCOUT
    await step($, { turnId: 't', index: 1, agentId: 'kid' })
    expect(offeredIn(w, 1)).toEqual(['Read', 'SubagentHandback'])
  })
}
