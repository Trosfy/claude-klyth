// The klyth agent tool in a conversation klyth routes: a call in a routed step (main's or a subagent's) leaves the
// step as an Agent call with the same id, which the engine runs from the calling loop; the note, the history
// that shows the model its own call, the auto-mode allow, and the tool still answering what could not be made
// an Agent call. A native main keeps the tool's own spawn.
import type { TurnStepChunk } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/config'
import { WRAPPER } from '../hooks/routing'
import { createSession } from '../hooks/session'
import { translate, translatedOf, translateUse, unstarted, untranslated, whileSpawning } from '../hooks/spawn'
import { CONFIG, CONFIG_OBJECT, TRUSTED, sse, start, step, world } from './world'

const PIN = (turnId: string) => ({ turnId, target: 'acme/model-b' })
const GP = { target: 'acme/model-a', label: 'fast', type: 'general-purpose', prompt: 'Do the work.' }
// What a model asks the klyth agent tool for, and the provider's answer carrying that call.
const ask = (input: Record<string, unknown> = {}) => ({ model: 'fast', prompt: 'list the files', description: 'List files', subagent_type: 'Explore', ...input })
const answer = (input: Record<string, unknown>) =>
  sse(
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: WRAPPER, arguments: JSON.stringify(input) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    '[DONE]',
  )
// A provider that asks for `input` at every step.
const asking = (input: Record<string, unknown>) => () => ({ pieces: [answer(input)] })
const first = (chunks: readonly TurnStepChunk[]) => {
  const tool = chunks.find(c => c.kind === 'tool') as { id: string; name: string }
  const json = (chunks.find(c => c.kind === 'input') as { json: string } | undefined)?.json
  return { id: tool.id, name: tool.name, input: json === undefined ? undefined : (JSON.parse(json) as Record<string, unknown>) }
}

// A second provider no one approved, a native alias to a full model id, and acme as approved.
const FAR_HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'far', '-w']
const TWO = JSON.stringify({
  providers: {
    ...CONFIG_OBJECT.providers,
    far: { kind: 'openai', baseUrl: 'https://far.invalid/v1', auth: { command: FAR_HELPER }, models: { m: CONFIG_OBJECT.providers.acme.models['model-a'] } },
  },
  aliases: { ...CONFIG_OBJECT.aliases, distant: 'far/m', quick: 'native/claude-haiku-4-5' },
})

test('an alias call in a routed main step leaves as an Agent call with the same id and no model', async ($, on) => {
  const input = ask({ effort: 'high', name: 'scout', isolation: 'worktree', run_in_background: false })
  const w = world(on, { pin: PIN('t'), upstream: asking(input) })
  await start($)
  const s = await step($, { turnId: 't', index: 0 })
  expect(s.chunks.map(c => c.kind)).toEqual(['tool', 'input', 'stop'])
  const call = first(s.chunks)
  expect(call.id).toMatch(/^toolu_klyth_[0-9a-f]{24}$/)
  expect(call.name).toBe('Agent')
  expect(call.input).toEqual({
    description: 'List files',
    prompt: 'list the files',
    subagent_type: 'Explore',
    name: 'scout',
    isolation: 'worktree',
    run_in_background: false,
    effort: 'high',
  })
  expect(s.result).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'Agent', input: call.input }] })
  expect(w.spawns).toEqual([])
})

test('a native target keeps its model on the Agent call: a native alias and native/<model>', async ($, on) => {
  let model = 'haiku'
  world(on, { pin: PIN('t'), upstream: () => ({ pieces: [answer(ask({ model }))] }) })
  await start($)
  for (const [i, name] of ['haiku', 'native/sonnet', 'opus'].entries()) {
    model = name
    const call = first((await step($, { turnId: 't', index: i })).chunks)
    expect(call.name).toBe('Agent')
    expect(call.input?.['model']).toBe(name.replace('native/', ''))
  }
})

const UNMADE = [
  ['an unknown model', { model: 'zeus' }, /^klyth agent: unknown model "zeus"; valid: /],
  ['invalid input', { effort: 'extreme' }, /^klyth agent: invalid input: /],
  ['a fork on another alias than its parent', { subagent_type: 'fork' }, /^klyth agent: a fork runs on its parent's model \(acme\/model-b\), not on fast; omit model, or name acme\/model-b$/],
  ['a fork of a native model', { model: 'haiku', subagent_type: 'fork' }, /^klyth agent: a fork runs on its parent's model \(acme\/model-b\), not on haiku;/],
  ['an isolated fork', { model: 'acme/model-b', subagent_type: 'fork', isolation: 'worktree' }, /^klyth agent: a fork cannot be isolated through klyth; omit isolation$/],
  ['effort on a native model', { model: 'haiku', effort: 'high' }, /^klyth agent: effort cannot be set for a native model/],
  ['isolation other than worktree', { isolation: 'remote' }, /^klyth agent: isolation "remote" is not available through klyth/],
  ['a parameter the tool does not take', { team_name: 't' }, /^klyth agent: unsupported parameter\(s\) team_name; use Agent for them$/],
  ['a native alias to a model the Agent tool does not take', { model: 'quick' }, null],
] as const

for (const [why, extra, line] of UNMADE) {
  test(`${why}: the call leaves the step unchanged, and the tool answers it`, async ($, on) => {
    const w = world(on, { config: TWO, pin: PIN('t'), upstream: asking(ask(extra)) })
    await start($)
    const call = first((await step($, { turnId: 't', index: 0 })).chunks)
    expect(call).toMatchObject({ name: WRAPPER, input: ask(extra) })
    const denied = await $.tool.call({ tool: WRAPPER, ...(line === null ? {} : { tool_use_id: call.id }), ...ask(extra) })
    if (line === null) {
      // Main's own spawn takes a native alias the Agent tool cannot name.
      expect(w.spawns.map(s => s['model'])).toEqual(['claude-haiku-4-5'])
    } else {
      expect(denied).toEqual({ deny: expect.stringMatching(line) })
      expect(w.spawns).toEqual([])
    }
  })
}

test('a provider no one approved: the call stays a klyth agent call; main is asked once, a subagent is told how to approve it', async ($, on) => {
  const w = world(on, { config: TWO, store: TRUSTED, answer: 'Keep native', pin: PIN('t'), routes: { sub1: GP }, upstream: asking(ask({ model: 'distant' })) })
  await start($)
  expect(first((await step($, { turnId: 't', index: 0 })).chunks).name).toBe(WRAPPER)
  expect(first((await step($, { turnId: 's', index: 0, agentId: 'sub1' })).chunks).name).toBe(WRAPPER)
  expect(w.asks).toEqual([])
  expect(await $.tool.call({ tool: WRAPPER, agentId: 'sub1', ...ask({ model: 'distant' }) })).toEqual({ deny: 'klyth agent: provider far is not approved; run /model distant once and choose Allow' })
  expect(w.asks).toEqual([])
  expect(await $.tool.call({ tool: WRAPPER, ...ask({ model: 'distant' }) })).toEqual({ deny: 'klyth agent: provider far is not approved; use Agent for a native model' })
  expect(w.asks).toHaveLength(1)
  expect(w.spawns).toEqual([])
})

test("a routed subagent's step makes the same Agent call, which state keeps under the subagent's id", async ($, on) => {
  const w = world(on, { routes: { sub1: GP }, upstream: asking(ask()) })
  await start($)
  const call = first((await step($, { turnId: 's', index: 0, agentId: 'sub1' })).chunks)
  expect(call).toMatchObject({ name: 'Agent', input: { description: 'List files', prompt: 'list the files', subagent_type: 'Explore' } })
  expect(call.input).not.toHaveProperty('model')
  expect(w.stateSets).toContainEqual({ key: 'translated', id: 'sub1', value: { [call.id]: 'fast' } })
  expect(w.stateSets.filter(s => s.id === 'main')).toEqual([])
})

test('a native main keeps the tool\'s own spawn: its call is spawned through $.agent.spawn, not turned into an Agent call', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await $.tool.call({ tool: WRAPPER, ...ask() })).toEqual({ deny: 'klyth agent: the subagent did not start; retry, or use Agent' })
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]).toMatchObject({ prompt: 'list the files', subagent_type: 'Explore' })
})

test('a routed main step makes an Agent call and spawns nothing, with the engine running the call', async ($, on) => {
  const w = world(on, { pin: PIN('t'), upstream: asking(ask()) })
  await start($)
  const s = await step($, { turnId: 't', index: 0 })
  expect(first(s.chunks).name).toBe('Agent')
  expect(w.spawns).toEqual([])
  expect(w.asks).toEqual([])
})

test("a subagent's call that leaves run_in_background unset waits for the report (false); main's stays the engine's default, and an explicit true stays true", async ($, on) => {
  let input: Record<string, unknown> = ask()
  const w = world(on, { pin: PIN('t'), routes: { sub1: GP }, upstream: () => ({ pieces: [answer(input)] }) })
  await start($)
  const inSub = async (turnId: string) => first((await step($, { turnId, index: 0, agentId: 'sub1' })).chunks).input
  expect((await inSub('a'))?.['run_in_background']).toBe(false)
  input = ask({ run_in_background: true })
  expect((await inSub('b'))?.['run_in_background']).toBe(true)
  input = ask({ run_in_background: false })
  expect((await inSub('c'))?.['run_in_background']).toBe(false)
  input = ask()
  expect(first((await step($, { turnId: 't', index: 0 })).chunks).input).not.toHaveProperty('run_in_background')
  expect(w.requests).toHaveLength(4)
})

// --- history ---------------------------------------------------------------------------------------------------------

const sentCalls = (body: Record<string, unknown>) =>
  (body['messages'] as { role: string; tool_calls?: { function: { name: string; arguments: string } }[] }[]).flatMap(m => (m.role === 'assistant' ? (m.tool_calls ?? []) : [])).map(c => ({
    name: c.function.name,
    input: JSON.parse(c.function.arguments) as Record<string, unknown>,
  }))
// A transcript holding two Agent calls the engine ran, `made` among them.
const history = (made: string) => [
  { role: 'user', content: [{ type: 'text', text: 'go' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: made, name: 'Agent', input: { description: 'List files', prompt: 'list the files', subagent_type: 'Explore' } },
      { type: 'tool_use', id: 'toolu_plain', name: 'Agent', input: { description: 'Plain', prompt: 'plain' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: made, content: 'started' }] },
]

test('the next step shows the routed model its own call: the Agent call it made is the klyth agent call, with its model', async ($, on) => {
  let id = ''
  const w = world(on, { pin: PIN('t'), upstream: asking(ask()), messages: () => (id === '' ? undefined : history(id)) })
  await start($)
  id = first((await step($, { turnId: 't', index: 0 })).chunks).id
  expect(w.stateSets).toContainEqual({ key: 'translated', id: 'main', value: { [id]: 'fast' } })
  await step($, { turnId: 't', index: 1 })
  expect(sentCalls(w.requests[1]!.body)).toEqual([
    { name: WRAPPER, input: { description: 'List files', prompt: 'list the files', subagent_type: 'Explore', model: 'fast' } },
    { name: 'Agent', input: { description: 'Plain', prompt: 'plain' } },
  ])
})

// --- the allow in auto mode --------------------------------------------------------------------------------------

test('tool.check preserves a plain ask for an Agent call klyth made; a deny, a rule\'s ask and a hook\'s ask beneath stand', async ($, on) => {
  let beneath: { decision: 'ask' | 'deny' | 'allow'; rule?: string; hook?: string } = { decision: 'ask' }
  on('tool.check', { tool: 'Agent' }, () => beneath)
  world(on, { pin: PIN('t'), upstream: asking(ask()) })
  await start($)
  const id = first((await step($, { turnId: 't', index: 0 })).chunks).id
  const check = async (tool_use_id: string) => (await $.tool.check({ tool: 'Agent', input: {}, tool_use_id })).decision
  expect(await check(id)).toBe('ask')
  expect(await check('toolu_other')).toBe('ask')
  for (const [verdict, expected] of [
    [{ decision: 'deny' }, 'deny'],
    [{ decision: 'ask', rule: 'Agent' }, 'ask'],
    [{ decision: 'ask', hook: 'PreToolUse' }, 'ask'],
    [{ decision: 'allow' }, 'allow'],
  ] as const) {
    beneath = verdict
    expect(await check(id), JSON.stringify(verdict)).toBe(expected)
  }
})

test('tool.check preserves a plain ask for routed Agent forks in every spelling', async ($, on) => {
  let beneath: { decision: 'ask' | 'deny' | 'allow'; rule?: string; hook?: string } = { decision: 'ask' }
  on('tool.check', { tool: 'Agent' }, () => beneath)
  const w = world(on, { pin: PIN('t'), routes: { sub1: GP } })
  await start($)
  const check = async (input: unknown, agentId?: string) => (await $.tool.check({ tool: 'Agent', input, tool_use_id: 'toolu_native', ...(agentId === undefined ? {} : { agentId }) } as never)).decision
  expect(await check({ subagent_type: 'fork' })).toBe('ask')
  expect(await check({ subagent_type: 'Fork' })).toBe('ask')
  expect(await check({ subagent_type: 'fork_' })).toBe('ask')
  expect(await check({ subagent_type: 'fork' }, 'sub1')).toBe('ask')
  expect(await check({ subagent_type: 'general-purpose' })).toBe('ask')
  expect(await check({})).toBe('ask')
  expect(await check({ subagent_type: 'fork' }, 'native1')).toBe('ask')
  expect(w.debug.filter(l => l.startsWith('klyth check '))).toEqual([])
  for (const [verdict, expected] of [
    [{ decision: 'deny' }, 'deny'],
    [{ decision: 'ask', rule: 'Agent' }, 'ask'],
    [{ decision: 'ask', hook: 'PreToolUse' }, 'ask'],
    [{ decision: 'allow' }, 'allow'],
  ] as const) {
    beneath = verdict
    expect(await check({ subagent_type: 'fork' }), JSON.stringify(verdict)).toBe(expected)
  }
})

for (const [how, opts] of [
  ['main is native', { pin: { turnId: 't', target: null } }],
  ['main has no pin', {}],
  ['the pin cannot be read', { pinRead: 'fails' as const }],
] as const) {
  test(`a native Agent fork call stays an ask when ${how}`, async ($, on) => {
    on('tool.check', { tool: 'Agent' }, () => ({ decision: 'ask' }))
    const w = world(on, opts)
    await start($)
    expect((await $.tool.check({ tool: 'Agent', input: { subagent_type: 'fork' }, tool_use_id: 'toolu_native' } as never)).decision).toBe('ask')
    expect(w.debug.some(l => l.startsWith('klyth check '))).toBe(false)
  })
}

test('a routed main\'s call the step left as it was, with run_in_background false, is denied with the real reason, not the foreground line', async ($, on) => {
  const input = ask({ model: 'distant', run_in_background: false })
  const w = world(on, { config: TWO, store: TRUSTED, pin: PIN('t'), upstream: asking(input) })
  await start($)
  const call = first((await step($, { turnId: 't', index: 0 })).chunks)
  expect(call.name).toBe(WRAPPER)
  expect(await $.tool.call({ tool: WRAPPER, tool_use_id: call.id, ...input })).toEqual({ deny: 'klyth agent: provider far is not approved; run /model distant once and choose Allow' })
  expect(await $.tool.call({ tool: WRAPPER, tool_use_id: 'toolu_new', ...ask({ run_in_background: false }) })).toEqual({
    deny: 'klyth agent: run_in_background false needs a conversation that klyth routes; omit it, and the subagent runs in the background',
  })
  expect(w.spawns).toEqual([])
  expect(w.asks).toEqual([])
})

test('after a hot reload translated Agent calls still require a classifier allow', async ($, on) => {
  let beneath: { decision: 'ask' | 'deny'; rule?: string } = { decision: 'ask' }
  on('tool.check', { tool: 'Agent' }, () => beneath)
  world(on, { translated: { main: { toolu_m: 'fast' }, sub1: { toolu_s: 'strong' } } })
  await start($)
  const check = async (tool_use_id: string, agentId?: string) => (await $.tool.check({ tool: 'Agent', input: {}, tool_use_id, ...(agentId === undefined ? {} : { agentId }) })).decision
  expect(await check('toolu_m')).toBe('ask')
  expect(await check('toolu_s', 'sub1')).toBe('ask')
  expect(await check('toolu_s')).toBe('ask')
  expect(await check('toolu_other', 'sub1')).toBe('ask')
  beneath = { decision: 'ask', rule: 'Agent' }
  expect(await check('toolu_m')).toBe('ask')
  beneath = { decision: 'deny' }
  expect(await check('toolu_m')).toBe('deny')
})

// --- the tool set ----------------------------------------------------------------------------------------------

const MAIN_TOOLS = ['Agent', 'Read', 'Write', 'mcp__klyth__agent'].map(name => ({ name, description: name, mcp: name.startsWith('mcp__') }))
const toolsOf = (body: Record<string, unknown>) => ((body['tools'] as { function: { name: string; parameters: { properties: Record<string, unknown> } } }[] | undefined) ?? []).map(t => t.function)

test('the klyth agent tool is offered to every routed loop that may call Agent: main and a general-purpose subagent, not Explore or an agent whose tools lack Agent', async ($, on) => {
  const w = world(on, {
    pin: PIN('m'),
    routes: { gp: GP, ex: { ...GP, type: 'Explore' }, rv: { ...GP, type: 'reviewer' } },
    tools: MAIN_TOOLS,
    files: { '/w/.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: d\ntools: Read, mcp__klyth__agent\n---\nREVIEW' },
  })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  for (const agentId of ['gp', 'ex', 'rv']) await step($, { turnId: agentId, index: 0, agentId })
  const names = w.requests.map(r => toolsOf(r.body).map(t => t.name))
  expect(names).toEqual([
    ['Agent', 'Read', 'Write', WRAPPER],
    ['Agent', 'Read', 'Write', WRAPPER, 'SubagentHandback'],
    ['Read', 'SubagentHandback'],
    ['Read', 'SubagentHandback'],
  ])
  const wrapper = toolsOf(w.requests[1]!.body).find(t => t.name === WRAPPER)
  expect(Object.keys(wrapper?.parameters.properties ?? {})).toEqual(['description', 'prompt', 'subagent_type', 'model', 'effort', 'name', 'isolation', 'run_in_background'])
})

const wrapped = (names: string[]) => names.includes(WRAPPER)
const SCOUT = (extra: string) => `---\nname: scout\ndescription: d\n${extra}\n---\nSCOUT`

test('a definition that disallows the klyth agent tool, or lists tools without it, is offered no klyth agent tool', async ($, on) => {
  const w = world(on, {
    routes: { dis: { ...GP, type: 'scout' }, only: { ...GP, type: 'only' } },
    tools: MAIN_TOOLS,
    files: { '/w/.claude/agents/scout.md': SCOUT('disallowedTools: mcp__klyth__agent'), '/w/.claude/agents/only.md': SCOUT('tools: Agent, Read').replace('name: scout', 'name: only') },
  })
  await start($)
  for (const agentId of ['dis', 'only']) await step($, { turnId: agentId, index: 0, agentId })
  expect(w.requests.map(r => toolsOf(r.body).map(t => t.name))).toEqual([
    ['Agent', 'Read', 'Write', 'SubagentHandback'],
    ['Agent', 'Read', 'SubagentHandback'],
  ])
})

test('a tool list with no Agent in it (a policy removed it) leaves the klyth agent tool out, and a call of it untranslated', async ($, on) => {
  const w = world(on, { pin: PIN('m'), tools: MAIN_TOOLS.filter(t => t.name !== 'Agent'), upstream: asking(ask()) })
  await start($)
  const s = await step($, { turnId: 'm', index: 0 })
  expect(toolsOf(w.requests[0]!.body).map(t => t.name)).toEqual(['Read', 'Write'])
  expect(first(s.chunks).name).toBe(WRAPPER)
})

test('a klyth agent call a step did not offer is not translated: it stays a klyth agent call, and a routed subagent is denied it', async ($, on) => {
  const w = world(on, { routes: { ex: { ...GP, type: 'Explore' } }, tools: MAIN_TOOLS, upstream: asking(ask()) })
  await start($)
  const s = await step($, { turnId: 'e', index: 0, agentId: 'ex' })
  expect(wrapped(toolsOf(w.requests[0]!.body).map(t => t.name))).toBe(false)
  const call = first(s.chunks)
  expect(call).toMatchObject({ name: WRAPPER, input: ask() })
  expect(w.stateSets.filter(x => x.key === 'translated')).toEqual([])
  expect(await $.tool.call({ tool: WRAPPER, tool_use_id: call.id, agentId: 'ex', ...ask() })).toEqual({ deny: 'klyth agent: not offered to the Explore subagent; use a tool it has' })
  expect(w.spawns).toEqual([])
})

test('a routed main is offered the main-only tools, which a routed subagent is not', async ($, on) => {
  const tools = ['AskUserQuestion', 'TodoWrite', 'CronCreate', 'ExitPlanMode', 'Agent', 'Read', 'mcp__klyth__agent'].map(name => ({ name, description: name, mcp: name.startsWith('mcp__') }))
  const w = world(on, { pin: PIN('m'), routes: { gp: GP }, tools })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  await step($, { turnId: 'g', index: 0, agentId: 'gp' })
  expect(w.requests.map(r => toolsOf(r.body).map(t => t.name))).toEqual([
    ['AskUserQuestion', 'TodoWrite', 'CronCreate', 'ExitPlanMode', 'Agent', 'Read', WRAPPER],
    ['Agent', 'Read', WRAPPER, 'SubagentHandback'],
  ])
})

test('a subagent klyth started but could not run on the model asked for hands the reason back as its report, and sends no request', async ($, on) => {
  const refused = 'klyth agent: the engine made no worktree for the isolated subagent, so klyth did not run the subagent on fast; retry, or use a native model'
  const w = world(on, { routes: { r1: { ...GP, refused } } })
  await start($)
  const s = await step($, { turnId: 'r', index: 0, agentId: 'r1' })
  expect(first(s.chunks)).toMatchObject({ name: 'SubagentHandback', input: { message: refused } })
  expect(s.result).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'SubagentHandback', input: { message: refused } }] })
  expect(w.requests).toEqual([])
  expect(w.toasts).toEqual([refused])
})

// A hook that calls the klyth agent tool for a routed subagent from inside the spawn of another call: the event rises
// beneath the hook that carries the tool, so the .catch answers it, from the checks that need no engine.
test(
  "the re-entry handler answers a routed subagent's call from the checks that need no engine",
  {
    plugins: [
      {
        name: 'nester',
        register(on) {
          on('agent.spawn', async ($, e, next) => {
            const nested = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__klyth__agent', agentId: 'sub1', model: 'fast', prompt: 'p', description: 'd', ...input })
            $.ui.log(`nester ${JSON.stringify([await nested({ model: 'zeus' }), await nested({})])}`)
            return next(e)
          })
        },
      },
    ],
  },
  async ($, on) => {
    const w = world(on, { routes: { sub1: GP } })
    await start($)
    await $.tool.call({ tool: WRAPPER, ...ask() })
    const [unknown, valid] = JSON.parse((w.transcript.find(l => l.startsWith('nester ')) ?? 'nester []').slice(7)) as { deny: string }[]
    expect(unknown?.deny).toContain('unknown model "zeus"')
    expect(valid).toEqual({ deny: 'klyth agent: not available from a native subagent or from inside a spawn; use Agent here' })
  },
)

test('untranslated answers with the reason the step noted for the call, else the checks that need no engine, else that the subagent is native', async () => {
  const s = loaded()
  const io = { ...trust(false), debug: () => {}, translated: async () => undefined, setTranslated: async () => {} }
  await translateUse(io, s, 'sub1', 'fast', use(ask({ model: 'strong' }), 'toolu_far'), true)
  expect(await untranslated(s, { tool_use_id: 'toolu_far', agentId: 'sub1', ...ask({ model: 'strong' }) })).toEqual({ deny: 'klyth agent: provider acme is not approved; run /model strong once and choose Allow' })
  expect((await untranslated(s, { tool_use_id: 'toolu_new', ...ask({ model: 'zeus' }) })).deny).toContain('unknown model "zeus"')
  expect(await untranslated(s, { tool_use_id: 'toolu_new', ...ask() })).toEqual({ deny: 'klyth agent: not available from a native subagent or from inside a spawn; use Agent here' })
})

// --- translate and translateUse, over ports --------------------------------------------------------------------------

const loaded = (text = CONFIG) => {
  const s = createSession()
  s.loaded = { config: parseConfig(text).config, text, errors: [], missing: false, path: '~/.claude/klyth.json' }
  return s
}
const trust = (yes: boolean) => ({ trusted: async () => yes })
const use = (input: Record<string, unknown>, id = 'toolu_u') => ({ type: 'tool_use' as const, id, name: WRAPPER, input })

test('translate: a klyth target is a call without a model, noted with its label, effort and isolation; a native one names its model', async () => {
  const s = loaded()
  expect(await translate(trust(true), s, ask({ effort: 'low', isolation: 'worktree' }), 'fast')).toEqual({
    use: { name: 'Agent', input: { description: 'List files', prompt: 'list the files', subagent_type: 'Explore', isolation: 'worktree', effort: 'low' } },
    note: { target: 'fast', effort: 'low', isolated: true },
    model: 'fast',
  })
  expect(await translate(trust(true), s, ask({ model: 'acme/model-b', subagent_type: undefined }), 'fast')).toMatchObject({ note: { target: 'acme/model-b' }, model: 'acme/model-b' })
  expect(await translate(trust(false), s, ask({ model: 'sonnet' }), 'fast')).toMatchObject({ use: { input: { model: 'sonnet' } }, note: { target: null } })
})

test("translate: a fork takes its caller's alias, named or not; another alias, and a caller that is native, are denied", async () => {
  const s = loaded()
  const fork = (extra: Record<string, unknown> = {}) => ask({ subagent_type: 'fork', model: undefined, ...extra })
  const unnamed = await translate(trust(true), s, fork(), 'strong')
  expect(unnamed).toEqual({
    use: { name: 'Agent', input: { description: 'List files', prompt: 'list the files', subagent_type: 'fork' } },
    note: { target: 'strong' },
    model: 'strong',
  })
  expect(await translate(trust(true), s, fork({ model: 'strong' }), 'strong')).toEqual(unnamed)
  expect(await translate(trust(true), s, fork({ model: 'fast' }), 'strong')).toEqual({ deny: "klyth agent: a fork runs on its parent's model (strong), not on fast; omit model, or name strong" })
  expect(await translate(trust(true), s, fork({ model: 'haiku' }), 'strong')).toEqual({ deny: "klyth agent: a fork runs on its parent's model (strong), not on haiku; omit model, or name strong" })
  expect(await translate(trust(false), s, fork(), 'strong')).toEqual({ deny: 'klyth agent: provider acme is not approved; run /model strong once and choose Allow' })
})

test('translate: every spelling of fork the engine reads as one is a fork: on another alias it is denied, on its own it leaves spelled fork, and its effort is dropped as the engine drops it', async () => {
  const s = loaded()
  for (const subagent_type of ['Fork', 'FORK', 'for_k', ' fork ', 'ｆｏｒｋ']) {
    expect(await translate(trust(true), s, ask({ subagent_type, model: 'fast' }), 'strong')).toEqual({ deny: "klyth agent: a fork runs on its parent's model (strong), not on fast; omit model, or name strong" })
    expect(await translate(trust(true), s, ask({ subagent_type, model: undefined, effort: 'high' }), 'strong')).toEqual({
      use: { name: 'Agent', input: { description: 'List files', prompt: 'list the files', subagent_type: 'fork' } },
      note: { target: 'strong' },
      model: 'strong',
    })
  }
})

test('untranslated: a fork from a routed subagent is denied without calling it native; one from a native subagent is told it is native', async () => {
  const s = loaded()
  s.routes.set('sub1', GP)
  expect(await untranslated(s, { tool: WRAPPER, tool_use_id: 'x', agentId: 'sub1', prompt: 'p', description: 'd', subagent_type: 'FORK' })).toEqual({
    deny: 'klyth agent: this fork could not be made an Agent call, so it did not start (see the debug log); retry, or fork with Agent',
  })
  expect(await untranslated(s, { tool: WRAPPER, tool_use_id: 'y', agentId: 'nat1', prompt: 'p', description: 'd', subagent_type: 'fork' })).toEqual({
    deny: "klyth agent: a fork runs on its parent's model, and this conversation is native; to fork natively use Agent",
  })
})

test("a routed main's fork call leaves as a fork Agent call that names no model, noted for main's alias", async ($, on) => {
  const w = world(on, { pin: PIN('t'), upstream: asking(ask({ subagent_type: 'fork', model: 'acme/model-b' })) })
  await start($)
  const call = first((await step($, { turnId: 't', index: 0 })).chunks)
  expect(call).toMatchObject({ name: 'Agent', input: { subagent_type: 'fork', description: 'List files', prompt: 'list the files' } })
  expect(call.input).not.toHaveProperty('model')
  expect(w.spawns).toEqual([])
})

test('translate: a call from a subagent leaves nothing unset that the engine would background', async () => {
  const s = loaded()
  const input = async (extra: Record<string, unknown>, sub: boolean) => ((await translate(trust(true), s, ask(extra), 'fast', sub)) as { use: { input: Record<string, unknown> } }).use.input
  expect(await input({}, true)).toHaveProperty('run_in_background', false)
  expect(await input({ run_in_background: true }, true)).toHaveProperty('run_in_background', true)
  expect(await input({}, false)).not.toHaveProperty('run_in_background')
})

test('whileSpawning keeps a spawn asked for on a klyth target apart, and unstarted refuses for it only while it is pending', async () => {
  const s = loaded()
  expect(unstarted(s, 'c1')).toBeUndefined()
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  const asked = whileSpawning(s, async started => (started('c1'), held), 'deep')
  const plain = whileSpawning(s, async started => (started('p1'), held))
  expect(s.pendingSpawns.size).toBe(2)
  expect(unstarted(s, 'c1')).toEqual({ target: 'deep', label: 'deep', refused: 'klyth agent: the subagent on deep was still starting, so this step was not run; retry' })
  // Any other agent (a native child, an inherited one, one the engine has not started) is never refused.
  expect([unstarted(s, 'p1'), unstarted(s, 'native-1')]).toEqual([undefined, undefined])
  const unknown = whileSpawning(s, () => held, 'strong')
  expect(unstarted(s, 'native-2')).toBeUndefined()
  release()
  await Promise.all([asked, plain, unknown])
  expect(unstarted(s, 'c1')).toBeUndefined()
  expect([s.pendingSpawns.size, s.requested.size]).toEqual([0, 0])
  const only = whileSpawning(s, () => held)
  expect(unstarted(s, 'c1')).toBeUndefined()
  await only
})

test('translate: trust is read, never asked, and an unapproved provider is the reason', async () => {
  const asked: string[] = []
  const io = { trusted: async (k: string) => (asked.push(k), false), ask: async () => 'Allow', remember: async () => {} }
  expect(await translate(io, loaded(), ask(), 'fast')).toEqual({ deny: 'klyth agent: provider acme is not approved; run /model fast once and choose Allow' })
  expect(asked).toHaveLength(1)
})

test('translateUse notes the call for its spawn, keeps it with the conversation in memory and state, and returns the Agent call', async () => {
  const s = loaded()
  const persisted: [string, Record<string, string>][] = []
  const debug: string[] = []
  const io = { ...trust(true), debug: (t: string) => void debug.push(t), translated: async () => undefined, setTranslated: async (who: string, calls: Record<string, string>) => void persisted.push([who, calls]) }
  const out = await translateUse(io, s, 'sub1', 'fast', use(ask({ effort: 'high' })), true)
  expect(out).toMatchObject({ type: 'tool_use', id: 'toolu_u', name: 'Agent' })
  expect(s.calls.get('toolu_u')).toEqual({ target: 'fast', effort: 'high' })
  expect(persisted).toEqual([['sub1', { toolu_u: 'fast' }]])
  expect(s.translated.get('sub1')).toEqual({ toolu_u: 'fast' })
  await translateUse(io, s, 'sub1', 'fast', use(ask({ model: 'strong' }), 'toolu_v'), true)
  expect(persisted.at(-1)).toEqual(['sub1', { toolu_u: 'fast', toolu_v: 'strong' }])
  expect(debug).toEqual([])
})

test('translateUse leaves a call it cannot make, and one whose check throws, as the klyth agent call, with one debug line', async () => {
  const s = loaded()
  const debug: string[] = []
  const io = { trusted: async () => true, debug: (t: string) => void debug.push(t), translated: async () => undefined, setTranslated: async () => {} }
  const bad = use(ask({ model: 'zeus' }))
  expect(await translateUse(io, s, 'main', 'fast', bad, true)).toBe(bad)
  const down = use(ask())
  expect(
    await translateUse(
      {
        ...io,
        trusted: async () => {
          throw new Error('store down')
        },
      },
      s,
      'main',
      'fast',
      down,
      true,
    ),
  ).toBe(down)
  expect(debug).toHaveLength(2)
  expect(debug[0]).toMatch(/^klyth translate toolu_u: left as a klyth agent call \(klyth agent: unknown model "zeus"/)
  expect(debug[1]).toBe('klyth translate toolu_u: failed (Error: store down); left as a klyth agent call')
  expect(s.calls.get('toolu_u')).toEqual({ deny: expect.stringContaining('unknown model "zeus"') })
  expect(s.translated.size).toBe(0)
})

test('a state that will not take the translated calls is logged, and the call is still made; one that will not be read gives none', async () => {
  const s = loaded()
  const debug: string[] = []
  const io = {
    ...trust(true),
    debug: (t: string) => void debug.push(t),
    translated: async () => {
      throw new Error('read down')
    },
    setTranslated: async () => {
      throw new Error('write down')
    },
  }
  expect(await translateUse(io, s, 'main', 'fast', use(ask()), true)).toMatchObject({ name: 'Agent' })
  expect(debug.some(l => l.includes('could not persist the translated calls of main (Error: write down)'))).toBe(true)
  expect(debug.some(l => l.includes('could not read the translated calls of main (Error: read down)'))).toBe(true)
  expect(s.translated.get('main')).toEqual({ toolu_u: 'fast' })
  expect(await translatedOf(io, createSession(), 'other')).toEqual({})
})

test('every translated call of a conversation is kept: none is forgotten past 200, and nothing is said', async () => {
  const s = loaded()
  const debug: string[] = []
  const io = { ...trust(true), debug: (t: string) => void debug.push(t), translated: async () => undefined, setTranslated: async () => {} }
  for (let i = 0; i < 205; i++) await translateUse(io, s, 'main', 'fast', use(ask(), `toolu_${i}`), true)
  const kept = Object.keys(s.translated.get('main') ?? {})
  expect(kept).toHaveLength(205)
  expect([kept[0], kept.at(-1)]).toEqual(['toolu_0', 'toolu_204'])
  expect(debug).toHaveLength(0)
})

test('the tool.check upgrade reads only the notes of calls klyth made: a plain Agent call noted for its effort stays an ask', async ($, on) => {
  on('tool.check', { tool: 'Agent' }, () => ({ decision: 'ask' }))
  world(on)
  await start($)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_plain', description: 'd', prompt: 'p', effort: 'high' } as never).catch(() => undefined)
  expect((await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 'toolu_plain' })).decision).toBe('ask')
})
