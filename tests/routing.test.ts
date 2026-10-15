// turn.step routing: native pass-through, the main conversation's per-turn pin, subagent routes, a custom
// agent type's own definition, the remote request as the provider receives it through klythd, the per-step
// tool set, dispatch checks, guards, failures (a subagent's handed back) and the .catch.
import type { TurnStepChunk } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { BUILTIN_NOTES, FORK_REPORT, GENERAL_PURPOSE_PROMPT, HANDBACK_GUIDANCE, HANDBACK_TOOL } from '../hooks/agents'
import { parseConfig } from '../hooks/config'
import type { StepWire } from '../hooks/protocol'
import { createSession } from '../hooks/session'
import { SCHEMAS } from '../hooks/schemas.gen'
import { agentCall } from '../hooks/spawn'
import type { AgentPort } from '../hooks/spawn'
import { SSE } from './fixtures/data.gen'
import { CONFIG_OBJECT, HANDBACK_REMINDER, HELPER, HOME, KEY, LOCAL_CONFIG, LOCAL_ORIGIN, LOCAL_TRUSTED, ORIGIN, model, sse, start, step, world } from './world'

const B_PIN = (turnId: string) => ({ turnId, target: 'acme/model-b' })
const FAST = { target: 'acme/model-a', label: 'fast', effort: 'high' as const }
const kinds = (chunks: readonly TurnStepChunk[]) => chunks.map(c => `${c.kind}${'index' in c ? c.index : ''}`)
const withProvider = (p: Record<string, unknown>, models: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...CONFIG_OBJECT,
    providers: { acme: { ...CONFIG_OBJECT.providers.acme, ...p, models: { ...CONFIG_OBJECT.providers.acme.models, ...models } } },
  })
const toolNames = (body: Record<string, unknown>) => ((body['tools'] as { function: { name: string } }[] | undefined) ?? []).map(t => t.function.name)

test('with no klyth target a main step passes through exactly', async ($, on) => {
  const w = world(on)
  await start($)
  const s = await step($, { turnId: 't1', index: 0 })
  expect(s.chunks).toEqual([
    { kind: 'text', index: 0, text: 'native' },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ])
  expect(s.result).toEqual({ turnId: 't1', index: 0, answer: 'native', toolUses: [], stopReason: 'end_turn', usage: null })
  expect(w.requests).toEqual([])
  expect(w.processes.filter(p => p.argv.includes('--unix-socket'))).toEqual([])
})

test('after /model strong a main step is answered by the provider through klythd and never reaches the engine', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  const s = await step($, { turnId: 't2', index: 0, effort: 'high' })
  expect(w.nativeSteps).toEqual([])
  expect(w.requests).toHaveLength(1)
  const { url, headers, body } = w.requests[0]!
  expect(headers['user-agent']).toBe('klyth/0.2.0')
  expect(url).toBe('https://klyth.invalid/v1/chat/completions')
  expect(body).toMatchObject({ model: 'model-b', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 128_000, reasoning_effort: 'high' })
  expect((body['messages'] as unknown[])[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' })
  expect(toolNames(body)).toEqual(['Read', 'Agent', 'mcp__klyth__agent'])
  const tools = body['tools'] as { function: { name: string; parameters: unknown } }[]
  expect(tools[0]?.function.parameters).toEqual(SCHEMAS['Read'])
  expect((tools[2]?.function.parameters as { properties: { model: { enum: string[] } } }).properties.model.enum).toContain('fast')
  expect(w.composes.at(-1)).toMatchObject({ model: 'claude-opus-5-5', tools: ['Read', 'Agent', 'mcp__klyth__agent'] })
  expect(s.chunks.filter(c => c.kind === 'text').map(c => (c as { text: string }).text).join('')).toBe('London is 31°C with light rain.')
  expect(s.result).toMatchObject({ turnId: 't2', index: 0, answer: 'London is 31°C with light rain.', stopReason: 'end_turn', usage: { input_tokens: 95, output_tokens: 14, model: 'acme/model-b' } })
  expect(w.debug.some(l => /^klyth step main → acme\/model-b kind=openai http=200 effort=high msgs=1 tools=3 bytes=\d+ ttfb=\d+ total=\d+ in=95 out=14 cache=0 wrote=0 reasoning=0 load=[a-f0-9]{16} session=- system=[a-f0-9]{16} tools=[a-f0-9]{16} params=[a-f0-9]{16} historyTotal=1 historyOmitted=0 history=0:[a-f0-9]{16} firstMeta=[a-f0-9]{16} firstBlocksTotal=1 firstBlocksOmitted=0 firstBlocks=0:text:\d+:[a-f0-9]{16} store=memory restored=0\/0 finish=stop$/.test(l))).toBe(true)
  expect(w.debug).toContain('klyth req main msgs=1 firstUser="hi" tools=3[Read|Agent|mcp__klyth__agent]')
})

test('after /model model.v1-mini a main step goes to the plain-http provider with its own key, limits and effort map', async ($, on) => {
  const w = world(on, { config: LOCAL_CONFIG, store: LOCAL_TRUSTED })
  await start($)
  await model($, 'model.v1-mini')
  const s = await step($, { turnId: 'q1', index: 0, effort: 'max' })
  const { url, headers, body } = w.requests[0]!
  expect(headers['authorization']).toBe(`Bearer ${KEY}`)
  expect(JSON.stringify([w.processes, w.wires, w.debug])).not.toContain(KEY)
  expect(url).toBe(`${LOCAL_ORIGIN}/v1/chat/completions`)
  expect(body).toMatchObject({ model: 'model-v1', stream: true, stream_options: { include_usage: true }, max_tokens: 65_536, reasoning_effort: 'medium' })
  expect(body).not.toHaveProperty('max_completion_tokens')
  expect(s.result).toMatchObject({ stopReason: 'end_turn', usage: { model: 'local/model-v1' } })
  expect(w.debug.some(l => /^klyth step main → local\/model-v1 kind=openai http=200 effort=max→medium /.test(l))).toBe(true)
})

// An anthropic provider whose model `m` sets a param and a header, and an alias `deep` that lays a thinking
// param, an effort map, a header and a one-hour cache over them.
const OVERLAY = JSON.stringify({
  providers: { cl: { kind: 'anthropic', baseUrl: ORIGIN, auth: { command: HELPER }, models: { m: { contextWindow: 200_000, maxOutputTokens: 8000, params: { top_k: 1 }, headers: { 'x-model': 'm' } } } } },
  aliases: { deep: { target: 'cl/m', params: { thinking: { type: 'adaptive' }, top_k: 2 }, effort: { high: { output_config: { effort: 'high' } } }, cache: '1h', headers: { 'x-alias': 'deep' } } },
})
const OVERLAY_TRUSTED = { [`trust:anthropic|${ORIGIN}|cmd:${JSON.stringify(HELPER)}`]: true }
const OVERLAY_ANSWER = sse(
  { type: 'message_start', message: { usage: { input_tokens: 5 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
)
// What the alias `deep` puts on the wire: its params, effort level, cache marks and header.
const DEEP = {
  body: { top_k: 2, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, system: [{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
  headers: { 'x-alias': 'deep', 'x-model': 'm' },
}

test('/model deep sends the alias overlay upstream (its params, effort level, cache marks and headers); /model cl/m sends the model alone', async ($, on) => {
  const w = world(on, { config: OVERLAY, store: OVERLAY_TRUSTED, upstream: () => ({ pieces: [OVERLAY_ANSWER] }) })
  await start($)
  expect(await model($, 'deep')).toEqual({ text: 'Set model to deep (cl/m)' })
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'deep' })
  await step($, { turnId: 'a', index: 0, effort: 'high' })
  expect(w.requests[0]?.body).toMatchObject(DEEP.body)
  expect(w.requests[0]?.headers).toMatchObject(DEEP.headers)
  expect(w.statuses.at(-1)).toBe('deep · cl')
  await model($, 'cl/m')
  await step($, { turnId: 'b', index: 0, effort: 'high' })
  expect(w.requests[1]?.body).toMatchObject({ top_k: 1, system: 'SYSTEM PROMPT' })
  expect(w.requests[1]?.body).not.toHaveProperty('thinking')
  expect(w.requests[1]?.headers).toMatchObject({ 'x-model': 'm' })
  expect(w.requests[1]?.headers).not.toHaveProperty('x-alias')
  // The pin of a turn already under way keeps its name across a later switch.
  expect(JSON.stringify(w.stateSets.filter(x => x.key === 'mainPin'))).toContain('"target":"deep"')
})

test('a klyth agent call routes the subagent by the name it was given, and its steps send the alias overlay upstream', async ($, on) => {
  const s = createSession()
  s.loaded = { config: parseConfig(OVERLAY).config, text: OVERLAY, errors: [], missing: false, path: '~/.claude/klyth.json' }
  const written: Record<string, unknown> = {}
  const io: AgentPort = {
    trusted: async () => true,
    remember: async () => {},
    ask: async () => 'Allow',
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    cwd: async () => '/w',
    toast: () => {},
    log: () => {},
    debug: () => {},
    compose: async () => [],
    configDir: async () => '/home/u/.claude',
    exists: async () => false,
    read: async () => '',
    listDir: async () => [],
    now: async () => 0,
    setRoute: async (id, route) => void (written[id] = route),
    spawn: async () => ({ agentId: 'sub1', model: 'inherit' }),
    agentType: async () => undefined,
    route: async () => undefined,
  }
  const called = await agentCall(io, s, { model: 'deep', prompt: 'look around', description: 'Look', subagent_type: 'Explore' }, { plugin: 'engine', tier: 'core' })
  expect(called).toMatchObject({ result: expect.stringContaining('started deep (cl/m) subagent sub1') })
  expect(written['sub1']).toMatchObject({ target: 'deep', label: 'deep', type: 'Explore', prompt: 'look around' })
  const w = world(on, { config: OVERLAY, store: OVERLAY_TRUSTED, upstream: () => ({ pieces: [OVERLAY_ANSWER] }), routes: written as never })
  await start($)
  await step($, { turnId: 's', index: 0, agentId: 'sub1', effort: 'high' })
  expect(w.requests[0]?.body).toMatchObject({ ...DEEP.body, system: [{ type: 'text', text: expect.stringContaining('Explore'), cache_control: { type: 'ephemeral', ttl: '1h' } }] })
  expect(w.requests[0]?.headers).toMatchObject(DEEP.headers)
})

test("each loop's routed steps and provider headers keep its own session id through repeated completion and resume", async ($, on) => {
  const w = world(on, { config: withProvider({ sessionHeader: 'session_id' }), routes: { sub1: FAST, sub2: FAST } })
  await start($)
  await model($, 'strong')
  await step($, { turnId: 'a', index: 0 })
  await step($, { turnId: 'a', index: 1 })
  await step($, { turnId: 'b', index: 0 })
  await step($, { turnId: 's', index: 0, agentId: 'sub1' })
  await step($, { turnId: 's', index: 1, agentId: 'sub1' })
  const ids = () => w.wires.flatMap(x => ((x as StepWire).req === undefined ? [] : [(x as StepWire).req.sessionId]))
  const [main, sub] = [ids()[0], ids()[3]]
  expect(main).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  expect(ids()).toEqual([main, main, main, sub, sub])
  expect(sub).not.toBe(main)
  expect(w.requests.map(r => r.headers['session_id'])).toEqual(ids())
  for (const [done, resumed] of [['s', 's2'], ['s2', 's3']] as const) {
    await $.turn.complete({ answer: 'report', reason: 'answer', durationMs: 1, isAborted: false, turnId: done, agentId: 'sub1' })
    await step($, { turnId: resumed, index: 0, agentId: 'sub1' })
    expect(ids().at(-1)).toBe(sub)
  }
  await step($, { turnId: 'c', index: 0 })
  await step($, { turnId: 'other', index: 0, agentId: 'sub2' })
  const other = ids().at(-1)
  expect(new Set([main, sub, other]).size).toBe(3)
  expect(ids()).toEqual([main, main, main, sub, sub, sub, sub, main, other])
  expect(w.requests.map(r => r.headers['session_id'])).toEqual(ids())
})

test('a provider with no sessionHeader is sent no session id header, though every request carries the id', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  await step($, { turnId: 'a', index: 0 })
  expect(w.wires.flatMap(x => ((x as StepWire).req === undefined ? [] : [(x as StepWire).req.sessionId]))).toEqual([expect.any(String)])
  expect(JSON.stringify(w.requests[0]?.headers)).not.toMatch(/session/i)
})

test('the main route is fixed per turn at its first step: a mid-turn switch takes effect from the next turn', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await step($, { turnId: 'a', index: 0 })).result.answer).toBe('native')
  await model($, 'strong')
  expect((await step($, { turnId: 'a', index: 1 })).result.answer).toBe('native')
  expect(w.requests).toHaveLength(0)
  await step($, { turnId: 'b', index: 0 })
  expect(w.requests).toHaveLength(1)
  await model($, 'opus')
  await step($, { turnId: 'b', index: 1 })
  expect(w.requests).toHaveLength(2)
  expect((await step($, { turnId: 'c', index: 0 })).result.answer).toBe('native')
})

test('a later step of a turn whose first step klyth never saw is native; a persisted pin for it is honoured', async ($, on) => {
  const w = world(on, { pin: B_PIN('t9') })
  await start($)
  await step($, { turnId: 't9', index: 2 })
  expect(w.requests).toHaveLength(1)
  expect((await step($, { turnId: 'unseen', index: 3 })).result.answer).toBe('native')
})

test('a routed subagent gets its own transcript, its route effort, the klyth agent tool and SubagentHandback', async ($, on) => {
  const w = world(on, { routes: { sub1: FAST } })
  await start($)
  await step($, { turnId: 'ts', index: 0, agentId: 'sub1', effort: 'low' })
  const body = w.requests[0]!.body
  expect(body).toMatchObject({ model: 'model-a', reasoning_effort: 'high' })
  expect(w.reads).toEqual(['sub1'])
  expect(toolNames(body)).toEqual(['Read', 'Agent', 'mcp__klyth__agent', 'SubagentHandback'])
  expect((body['tools'] as { function: unknown }[])[3]?.function).toEqual({ name: HANDBACK_TOOL.name, description: HANDBACK_TOOL.description, parameters: HANDBACK_TOOL.schema })
  // The engine validates a call by this shape (handbackState does too): one required string, nothing else.
  expect(HANDBACK_TOOL.schema).toEqual({ type: 'object', properties: { message: { type: 'string', description: expect.any(String) } }, required: ['message'], additionalProperties: false })
  expect(w.debug.some(l => l.startsWith('klyth step sub1 → acme/model-a kind=openai http=200'))).toBe(true)
})

// The task an Explore subagent was started with, and the routed Explore's route as the wrapper writes it.
const TASK = 'Search the fixture for retry logic.\nReport each finding with its file_path:line_number.'
const EXPLORE = { ...FAST, type: 'Explore', prompt: TASK }
const HELD_STEP = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_klyth_000000000000000000000001', name: 'Read', input: { file_path: '/w/retry.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_klyth_000000000000000000000001', content: 'retry(3)' }] },
]
const sentMessages = (body: Record<string, unknown>) => body['messages'] as { role: string; content: unknown }[]

test('a routed subagent whose session saved no transcript opens on its task at step 0 and keeps it after', async ($, on) => {
  let held: unknown[] = []
  const w = world(on, { routes: { ex1: EXPLORE }, messages: () => held })
  await start($)
  await step($, { turnId: 'te', index: 0, agentId: 'ex1', messageCount: 10 })
  expect(sentMessages(w.requests[0]!.body)).toEqual([
    { role: 'system', content: expect.stringContaining('running as the Explore subagent via the klyth alias fast.') },
    { role: 'user', content: TASK },
  ])
  held = HELD_STEP
  await step($, { turnId: 'te', index: 1, agentId: 'ex1', messageCount: 12 })
  expect(sentMessages(w.requests[1]!.body).map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
  expect(sentMessages(w.requests[1]!.body)[1]).toEqual({ role: 'user', content: TASK })
  expect(w.debug.filter(l => l.startsWith('klyth req ex1 ')).map(l => l.replace(/ tools=.*/, ''))).toEqual([
    'klyth req ex1 msgs=1 firstUser="Search the fixture for retry logic.\\nReport each finding with"',
    'klyth req ex1 msgs=3 firstUser="Search the fixture for retry logic.\\nReport each finding with"',
  ])
})

test('a routed subagent whose transcript holds its task and reminders sends exactly those messages, in order', async ($, on) => {
  const saved = [
    {
      role: 'user',
      content: [
        { type: 'text', text: TASK },
        { type: 'text', text: '<system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>' },
      ],
    },
    ...HELD_STEP,
  ]
  const w = world(on, { routes: { ex2: EXPLORE }, messages: () => saved })
  await start($)
  await step($, { turnId: 'tf', index: 1, agentId: 'ex2' })
  const sent = sentMessages(w.requests[0]!.body)
  expect(sent.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
  expect(sent[1]?.content).toBe(`${TASK}\n\n<system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>`)
})

// Main's tool list as `$.tool.list()` gives it, the tools Explore may not call among them.
const MAIN_TOOLS = ['Agent', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Artifact', 'ArtifactCheck', 'WebFetch', 'Write', 'mcp__klyth__agent'].map(name => ({
  name,
  description: name,
  mcp: name.startsWith('mcp__'),
}))

test('a routed Explore is offered every listed tool its type allows, plus SubagentHandback; a general-purpose one keeps all but the main-only ones, the klyth agent tool among them', async ($, on) => {
  const w = world(on, { routes: { ex3: EXPLORE, gp1: { ...FAST, type: 'general-purpose', prompt: TASK } }, tools: MAIN_TOOLS })
  await start($)
  await step($, { turnId: 'tx', index: 0, agentId: 'ex3' })
  expect(toolNames(w.requests[0]!.body)).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'SubagentHandback'])
  expect(w.debug).toContain('klyth req ex3 msgs=1 firstUser="hi" tools=6[Bash|Glob|Grep|Read|WebFetch|SubagentHandback]')
  const params = (name: string) => ((w.requests[0]!.body['tools'] as { function: { name: string; parameters: unknown } }[]).find(t => t.function.name === name))?.function.parameters
  expect([params('Glob'), params('Grep')]).toEqual([SCHEMAS['Glob'], SCHEMAS['Grep']])
  expect(w.composes).toEqual([])
  await step($, { turnId: 'tg', index: 0, agentId: 'gp1' })
  const all = [...MAIN_TOOLS.map(t => t.name).filter(n => n !== 'ExitPlanMode'), 'SubagentHandback']
  expect(toolNames(w.requests[1]!.body)).toEqual(all)
})

test('an agent type named like an Object property keeps its parent\'s tools but the main-only ones', async ($, on) => {
  const w = world(on, { routes: { odd: { ...FAST, type: 'constructor', prompt: TASK } }, tools: MAIN_TOOLS })
  await start($)
  await step($, { turnId: 'to', index: 0, agentId: 'odd' })
  expect(toolNames(w.requests[0]!.body)).toEqual([...MAIN_TOOLS.map(t => t.name).filter(n => n !== 'ExitPlanMode'), 'SubagentHandback'])
})

test('the klyth req line redacts what looks like a credential in the first user text', async ($, on) => {
  const w = world(on, { pin: B_PIN('cr'), messages: () => [{ role: 'user', content: [{ type: 'text', text: 'use key sk-live-abcdefghijklmnopqrstuvwx now' }] }] })
  await start($)
  await step($, { turnId: 'cr', index: 0 })
  const line = w.debug.find(l => l.startsWith('klyth req main ')) ?? ''
  expect(line).toContain('firstUser="use key [REDACTED] now"')
  expect(line).not.toContain('sk-live')
})

test('a subagent with no route, or a native route, passes through', async ($, on) => {
  const w = world(on, { routes: { nat: { target: null, label: 'haiku' } } })
  await start($)
  expect((await step($, { turnId: 'x', index: 0, agentId: 'stranger' })).result.answer).toBe('native')
  expect((await step($, { turnId: 'x', index: 0, agentId: 'nat' })).result.answer).toBe('native')
  expect(w.requests).toEqual([])
})

test('the tool set: loaded MCP tools only, over-long names dropped, the cap kept with a handback slot, all listed by /klyth', async ($, on) => {
  const long = 'mcp__plugin_product-management_amplitude-eu__complete_authentication'
  const w = world(on, {
    config: withProvider({ maxTools: 2 }),
    routes: { sub2: FAST },
    mcpTools: [{ name: 'mcp__a__loaded', isLoaded: true }, { name: 'mcp__a__deferred', isLoaded: false }, { name: long, isLoaded: true }],
    mcpFile: JSON.stringify({ mcp__a__loaded: { type: 'object', properties: { q: { type: 'string' } } } }),
    tools: [
      { name: 'Read', description: 'r', mcp: false },
      { name: 'mcp__a__loaded', description: 'l', mcp: true },
      { name: 'mcp__a__deferred', description: 'd', mcp: true },
      { name: long, description: 'x', mcp: true },
      { name: `B${'x'.repeat(63)}`, description: '64 chars', mcp: false },
      { name: 'NoSchemaTool', description: 'n', mcp: false },
    ],
  })
  await start($)
  await model($, 'strong')
  await step($, { turnId: 'm', index: 0 })
  expect(toolNames(w.requests[0]!.body)).toEqual(['Read', 'mcp__a__loaded'])
  expect((w.requests[0]!.body['tools'] as { function: { parameters: unknown } }[])[1]?.function.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } })
  await $.command.run({ command: 'klyth', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await step($, { turnId: 's', index: 0, agentId: 'sub2' })
  expect(toolNames(w.requests[1]!.body)).toEqual(['Read', 'SubagentHandback'])
  expect(w.transcript).toContain(`  tools dropped (name over 64 chars): ${long}`)
  expect(w.transcript).toContain(`  tools dropped (cap 2): B${'x'.repeat(63)}, NoSchemaTool`)
  expect(w.transcript).toContain(`  tools without schema (sent permissive): B${'x'.repeat(63)}, NoSchemaTool`)
})

// A ToolSearch result as the transcript holds it: a tool_result whose content references the tool it loaded.
const loadedBy = (tool: string, id: string) => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ToolSearch', input: { query: tool } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'tool_reference', tool_name: tool }] }] },
]

test("a subagent's tool_reference is offered on its next step, and a tool loaded for main alone is not", async ($, on) => {
  let messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: TASK }, HANDBACK_REMINDER] }]
  const w = world(on, {
    routes: { sub5: FAST },
    pin: B_PIN('lm'),
    tools: [
      { name: 'Read', description: 'r', mcp: false },
      { name: 'mcp__a__late', description: 'late', mcp: true },
      { name: 'mcp__a__main', description: 'main', mcp: true },
      { name: 'mcp__a__top', description: 'top', mcp: true },
    ],
    mcpTools: [{ name: 'mcp__a__main', isLoaded: true }],
    messages: (agentId: string | undefined) => (agentId === 'sub5' ? messages : [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, ...loadedBy('mcp__a__late', 'toolu_main_1')]),
  })
  await start($)
  await step($, { turnId: 'r', index: 0, agentId: 'sub5' })
  expect(toolNames(w.requests[0]!.body)).toEqual(['Read', 'SubagentHandback'])
  messages = [...messages, ...loadedBy('mcp__a__late', 'toolu_sub_1'), { role: 'user', content: [{ type: 'tool_reference', tool_name: 'mcp__a__top' }] }]
  await step($, { turnId: 'r', index: 1, agentId: 'sub5' })
  expect(toolNames(w.requests[1]!.body)).toEqual(['Read', 'mcp__a__late', 'mcp__a__top', 'SubagentHandback'])
  await step($, { turnId: 'lm', index: 0 })
  expect(toolNames(w.requests[2]!.body)).toEqual(['Read', 'mcp__a__late', 'mcp__a__main'])
})

// A fork's history holds a ToolSearch result for `mcp__a__top`; main's usage holds `mcp__a__late` loaded.
const FORK_CALL = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fork', name: 'Agent', input: { subagent_type: 'fork' } }] }
const FORKED_MCP = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ...loadedBy('mcp__a__top', 'toolu_ts'),
  FORK_CALL,
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fork', content: 'started' }] },
]
const FORK_MCP_WORLD = {
  tools: [
    { name: 'Read', description: 'r', mcp: false },
    { name: 'mcp__a__late', description: 'late', mcp: true },
    { name: 'mcp__a__top', description: 'top', mcp: true },
  ],
  mcpTools: [{ name: 'mcp__a__late', isLoaded: true }],
}
const forkOwn = [{ role: 'user', content: [{ type: 'text', text: 'the task' }] }]

test("a fork of main is offered the MCP tools main has loaded and those its inherited history references; a fork of a routed subagent only the referenced ones", async ($, on) => {
  const fork = { target: 'acme/model-a', label: 'fast', type: 'fork', prompt: 'the task', forkOf: 'toolu_fork' }
  const w = world(on, {
    ...FORK_MCP_WORLD,
    routes: { sub6: FAST, mf: fork, sf: { ...fork, parent: 'sub6' } },
    messages: (agentId: string | undefined) => (agentId === 'mf' || agentId === 'sf' ? forkOwn : FORKED_MCP),
  })
  await start($)
  await step($, { turnId: 'f', index: 0, agentId: 'mf' })
  expect(toolNames(w.requests[0]!.body)).toEqual(['Read', 'mcp__a__late', 'mcp__a__top'])
  await step($, { turnId: 'g', index: 0, agentId: 'sf' })
  expect(toolNames(w.requests[1]!.body)).toEqual(['Read', 'mcp__a__top'])
})

test('tools: false sends no tools, SubagentHandback included', async ($, on) => {
  const w = world(on, { config: withProvider({}, { 'model-a': { ...CONFIG_OBJECT.providers.acme.models['model-a'], tools: false } }), routes: { sub3: FAST } })
  await start($)
  await step($, { turnId: 's', index: 0, agentId: 'sub3' })
  expect('tools' in w.requests[0]!.body).toBe(false)
})

test('the tool set is computed per step, so a tool loaded at step 0 is offered at step 1', async ($, on) => {
  let loaded = false
  const w = world(on, {
    pin: B_PIN('p'),
    tools: () => [{ name: 'Read', description: 'r', mcp: false }, ...(loaded ? [{ name: 'mcp__a__late', description: 'late', mcp: true }] : [])],
    mcpTools: [{ name: 'mcp__a__late', isLoaded: true }],
  })
  await start($)
  await step($, { turnId: 'p', index: 0 })
  loaded = true
  await step($, { turnId: 'p', index: 1 })
  expect(w.requests.map(c => toolNames(c.body))).toEqual([['Read'], ['Read', 'mcp__a__late']])
  expect(w.composes.map(c => c.tools)).toEqual([['Read'], ['Read', 'mcp__a__late']])
})

test('a pinned target that lost its approval, or its config, sends nothing and never falls back to native', async ($, on) => {
  const w = world(on, { pin: B_PIN('u'), store: {} })
  await start($)
  const s = await step($, { turnId: 'u', index: 0 })
  expect(s.result).toMatchObject({ answer: 'klyth: provider acme is not approved; run /model strong to approve it. The step was not sent', stopReason: 'end_turn', usage: null })
  expect(w.requests).toEqual([])
  expect(w.nativeSteps).toEqual([])
})

test('a pinned target no longer in the config sends nothing', async ($, on) => {
  const w = world(on, { pin: { turnId: 'g', target: 'acme/gone' } })
  await start($)
  expect((await step($, { turnId: 'g', index: 0 })).result.answer).toBe(
    'klyth: acme/gone is not available (no longer configured); the step was not sent. Fix ~/.claude/klyth.json, run /klyth reload, or pick another model',
  )
  expect(w.requests).toEqual([])
  expect(w.nativeSteps).toEqual([])
})

test('the per-request guard refuses a request over 0.95 of the input budget, and names the tool schemas when they dominate', async ($, on) => {
  const w = world(on, {
    pin: { turnId: 'big', target: 'acme/small' },
    messages: () => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(500_000) }] }],
  })
  await start($)
  const s = await step($, { turnId: 'big', index: 0 })
  expect(s.result.answer).toMatch(/^klyth: context ~\d+k exceeds acme\/small's 95% safety threshold \(114k\) of its 120k configured input budget; run \/klyth compact between turns$/)
  expect(w.requests).toEqual([])
})

test('when tool schemas take over half the budget the guard suggests tools: false', async ($, on) => {
  const w = world(on, {
    pin: { turnId: 'wide', target: 'acme/small' },
    tools: [{ name: 'mcp__big__t', description: 'big', mcp: true }],
    mcpTools: [{ name: 'mcp__big__t', isLoaded: true }],
    mcpFile: JSON.stringify({ mcp__big__t: { type: 'object', description: 'y'.repeat(450_000) } }),
  })
  await start($)
  expect((await step($, { turnId: 'wide', index: 0 })).result.answer).toMatch(/^klyth: tool schemas alone take ~\d+k of acme\/small's 120k input budget; set "tools": false/)
  expect(w.requests).toEqual([])
})

test('an HTTP error answers one redacted text and an end_turn stop, with no toast (the text is the answer) and the status in the debug log', async ($, on) => {
  const w = world(on, {
    pin: B_PIN('e'),
    upstream: () => ({ status: 403, pieces: ['{"error":{"message":"key not allowed to access model","param":"sk-live-abcdefghijklmnopqrstuvwx"}}\n'] }),
  })
  await start($)
  const s = await step($, { turnId: 'e', index: 0 })
  expect(kinds(s.chunks)).toEqual(['text0', 'stop'])
  expect(s.result.answer).toBe("klyth: your key for acme can't use model-b. Pick an allowed model, or ask the gateway's admin for access")
  expect(s.result).toMatchObject({ stopReason: 'end_turn', usage: null })
  expect(JSON.stringify([s, w.debug])).not.toContain('sk-live')
  expect(w.toasts).toEqual([])
  expect(w.debug.some(l => l.startsWith('klyth step main → acme/model-b kind=openai http=403 ') && l.includes(' finish=error error='))).toBe(true)
})

test('a stall after a complete tool call keeps the call and stops tool_use', async ($, on) => {
  const call = (index: number, id: string, args: string) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { name: 'Read', arguments: args } }] } }] })
  world(on, { pin: B_PIN('st'), upstream: () => ({ pieces: [sse(call(0, 'c0', '{"file_path":"/a"}'), call(1, 'c1', '{"file_pa'))], cut: 'stall' }) })
  await start($)
  const s = await step($, { turnId: 'st', index: 0 })
  expect(kinds(s.chunks)).toEqual(['tool0', 'input0', 'text1', 'stop'])
  expect(s.result).toMatchObject({ stopReason: 'tool_use', toolUses: [{ name: 'Read', input: { file_path: '/a' } }], answer: 'klyth: acme stalled (no data for 600 s); retry' })
})

test('a remote call id round-trips: the next request sends the provider its own call id', async ($, on) => {
  let minted = ''
  const w = world(on, {
    pin: B_PIN('rt'),
    upstream: () => ({ pieces: [minted === '' ? (SSE['model-b-step1.sse'] as string) : (SSE['model-b-step2.sse'] as string)] }),
    messages: () =>
      minted === ''
        ? [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }]
        : [
            { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: minted, name: 'get_weather', input: { city: 'London' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: minted, content: '31°C' }] },
          ],
  })
  await start($)
  const first = await step($, { turnId: 'rt', index: 0 })
  minted = (first.chunks[0] as { id: string }).id
  expect(minted).toMatch(/^toolu_klyth_[0-9a-f]{24}$/)
  await step($, { turnId: 'rt', index: 1 })
  const sent = w.requests[1]!.body['messages'] as Record<string, unknown>[]
  expect(sent[2]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: expect.stringMatching(/^call_/) }] })
  expect(sent[3]).toMatchObject({ role: 'tool', tool_call_id: expect.stringMatching(/^call_/) })
})

// A response whose usage reports `prompt` tokens, for the guards.
const sized = (prompt: number) => () => ({
  pieces: [sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: prompt, completion_tokens: 1 } }, '[DONE]')],
})

test('a large remote prompt refuses a growing transcript, but not a shorter one, nor a switch back after leaving', async ($, on) => {
  let messages = [{ role: 'user', content: 'original' }, { role: 'assistant', content: 'answer' }]
  const w = world(on, { usageTokens: 2_000, upstream: sized(115_000), messages: () => messages })
  await start($)
  expect(await model($, 'acme/small')).toEqual({ text: 'Set model to acme/small' })
  await step($, { turnId: 'a', index: 0, messageCount: 40 })
  expect((await step($, { turnId: 'a', index: 1, messageCount: 42 })).result.answer).toBe("klyth: context ~115k exceeds acme/small's 95% safety threshold (114k) of its 120k configured input budget; run /klyth compact between turns")
  messages = messages.slice(0, 1)
  expect((await step($, { turnId: 'b', index: 0, messageCount: 2 })).result.answer).toBe('ok')
  expect(w.requests).toHaveLength(2)
  await model($, 'opus')
  expect(await model($, 'acme/small')).toEqual({ text: 'Set model to acme/small' })
})

test('the per-request guard counts the tokens a response wrote to the cache with those it read and those it left uncached', async ($, on) => {
  const config = JSON.stringify({ providers: { cl: { kind: 'anthropic', baseUrl: ORIGIN, auth: { command: HELPER }, models: { small: { contextWindow: 128_000, maxOutputTokens: 8000, cache: '5m' } } } } })
  const answer = sse(
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 35_000, cache_creation_input_tokens: 80_000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  )
  const w = world(on, { config, store: { [`trust:anthropic|${ORIGIN}|cmd:${JSON.stringify(HELPER)}`]: true }, usageTokens: 2_000, upstream: () => ({ pieces: [answer] }) })
  await start($)
  expect(await model($, 'cl/small')).toEqual({ text: 'Set model to cl/small' })
  expect((await step($, { turnId: 'a', index: 0, messageCount: 40 })).result).toMatchObject({ answer: 'ok', usage: { input_tokens: 100, cache_read_input_tokens: 35_000, cache_creation_input_tokens: 80_000 } })
  expect((await step($, { turnId: 'a', index: 1, messageCount: 42 })).result.answer).toBe("klyth: context ~115k exceeds cl/small's 95% safety threshold (114k) of its 120k configured input budget; run /klyth compact between turns")
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body['system']).toEqual([{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral', ttl: '5m' } }])
})

test("the per-request guard reads each conversation's own last prompt: main's does not refuse a subagent", async ($, on) => {
  const w = world(on, { upstream: sized(115_000), routes: { sub4: { target: 'acme/small', label: 'acme/small' } } })
  await start($)
  await model($, 'acme/small')
  await step($, { turnId: 'm', index: 0, messageCount: 5 })
  expect((await step($, { turnId: 's', index: 0, agentId: 'sub4', messageCount: 5 })).result.answer).toBe('ok')
  expect(w.requests).toHaveLength(2)
})

test('large-context selection warns using the last remote prompt when it exceeds the engine figure', async ($, on) => {
  const usage = { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 200_000, completion_tokens: 1 } }
  const finish = { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }
  world(on, { usageTokens: 0, upstream: () => ({ pieces: [sse(finish, usage, '[DONE]')] }) })
  await start($)
  await model($, 'strong')
  await step($, { turnId: 'g1', index: 0 })
  expect(await model($, 'acme/small')).toEqual({ text: "Set model to acme/small\nklyth: existing context ~200k tokens is large for acme/small's 120k input budget; run /compact before continuing. Normal requests still enforce the 95% safety threshold" })
})

test('a remote step that fails inside klyth answers the internal-error text and never asks the engine', async ($, on) => {
  const w = world(on, { pin: B_PIN('boom'), compose: 'throws' })
  await start($)
  const s = await step($, { turnId: 'boom', index: 0 })
  expect(s.result).toMatchObject({ answer: 'klyth: internal error on acme/model-b; the step was not sent to another model (see the debug log)', stopReason: 'end_turn', usage: null })
  expect(kinds(s.chunks)).toEqual(['text0', 'stop'])
  expect(w.nativeSteps).toEqual([])
  expect(w.requests).toEqual([])
})

test('a routed subagent step that fails inside klyth hands the internal-error text back and never reaches the engine', async ($, on) => {
  const w = world(on, {
    routes: { sub1: FAST },
    messages: () => {
      throw new Error('transcript unavailable')
    },
  })
  await start($)
  const s = await step($, { turnId: 'ts', index: 0, agentId: 'sub1' })
  const text = 'klyth: internal error on acme/model-a; the step was not sent to another model (see the debug log)'
  expect(kinds(s.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(s.result).toMatchObject({ answer: '', toolUses: [{ name: 'SubagentHandback', input: { message: text } }], stopReason: 'tool_use', usage: null })
  expect(w.nativeSteps).toEqual([])
  expect(w.requests).toEqual([])
})

test('a socket that fails after a yielded call and text: the error text takes the next index, the call is kept, the stop is tool_use', async ($, on) => {
  const read = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] } }] }
  const text = { choices: [{ index: 0, delta: { content: 'reading' } }] }
  world(on, { pin: B_PIN('k'), upstream: () => ({ pieces: [sse(read, text)] }), socketThrows: 'transport blew up' })
  await start($)
  const s = await step($, { turnId: 'k', index: 0 })
  expect(kinds(s.chunks)).toEqual(['tool0', 'input0', 'text1', 'text2', 'stop'])
  expect(s.chunks.at(-1)).toEqual({ kind: 'stop', stopReason: 'tool_use', usage: null })
  expect(s.result).toMatchObject({
    stopReason: 'tool_use',
    toolUses: [{ name: 'Read', input: { file_path: '/a' } }],
    answer: 'readingklyth: internal error on acme/model-b; the step was not sent to another model (see the debug log)',
  })
})

test('a native main step whose pin read fails before routing passes beneath unchanged', async ($, on) => {
  const w = world(on, { pinRead: 'fails' })
  await start($)
  const s = await step($, { turnId: 'nr', index: 0 })
  expect(s.chunks).toEqual([
    { kind: 'text', index: 0, text: 'native' },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ])
  expect(w.nativeSteps).toHaveLength(1)
})

// A plugin agent where installed_plugins.json puts its plugin, with a frontmatter that allows three tools
// (the klyth agent tool among them) and withholds one.
const PLUGIN_ROOT = '/plugins/cache/acme-agents/acme-agents/0.9.0'
const INSTALLED = JSON.stringify({ version: 2, plugins: { 'acme-agents@acme-agents': [{ scope: 'user', installPath: PLUGIN_ROOT, version: '0.9.0' }] } })
const REVIEWER_BODY = 'You are the REVIEWER. Review exactly the change handed to you.'
const REVIEWER = [
  '---',
  'name: reviewer',
  'description: "Reviews a change: edge cases and \\"logic\\" errors"',
  'tools: [Read, Grep, Bash, mcp__klyth__agent]',
  'disallowedTools:',
  '  - Bash',
  'model: claude-opus-5',
  'color: green',
  '---',
  '',
  REVIEWER_BODY,
  '',
].join('\n')
const agentFile = (name: string, body: string, extra: string[] = []) => ['---', `name: ${name}`, 'description: d', ...extra, '---', body].join('\n')
const withAgents = (extra: Record<string, string> = {}) => ({
  [`${HOME}/.claude/plugins/installed_plugins.json`]: INSTALLED,
  [`${PLUGIN_ROOT}/agents/reviewer.md`]: REVIEWER,
  ...extra,
})
const typed = (type: string) => ({ ...FAST, type, prompt: TASK })
const systemText = (body: Record<string, unknown>) => sentMessages(body)[0]?.content as string
const ALL_SUB_TOOLS = [...MAIN_TOOLS.map(t => t.name).filter(n => n !== 'ExitPlanMode'), 'SubagentHandback']

test("a routed plugin agent's system prompt is its definition's body, the subagent notes, the environment, the handback and who answers, and its tools are its frontmatter's", async ($, on) => {
  const w = world(on, { routes: { rv1: typed('acme-agents:reviewer') }, tools: MAIN_TOOLS, files: withAgents() })
  await start($)
  await step($, { turnId: 'pa', index: 0, agentId: 'rv1' })
  const body = w.requests[0]!.body
  expect(sentMessages(body)[0]).toEqual({
    role: 'system',
    content: [
      REVIEWER_BODY,
      BUILTIN_NOTES,
      "# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /w\n - Platform: darwin\n - Today's date: 2026-10-07",
      HANDBACK_GUIDANCE,
      'You are powered by model-a served by the acme provider, running as the acme-agents:reviewer subagent via the klyth alias fast.',
    ].join('\n\n'),
  })
  expect(JSON.stringify(body)).not.toContain('SYSTEM PROMPT')
  expect(w.composes).toEqual([])
  expect(toolNames(body)).toEqual(['Grep', 'Read', 'SubagentHandback'])
  expect(sentMessages(body)[1]?.content).toMatch(/^hi\n\n<system-reminder>\nYour final report is delivered through SubagentHandback/)
  expect(w.debug).toContain(`klyth agent-def acme-agents:reviewer from ${PLUGIN_ROOT}/agents/reviewer.md`)
})

test("a project agent is read from the session's .claude/agents before the user's, a user agent from ~/.claude/agents, and a file defining another name is passed over", async ($, on) => {
  const w = world(on, {
    routes: { p1: typed('scout'), u1: typed('helper'), l1: typed('lens') },
    tools: MAIN_TOOLS,
    files: {
      '/w/.claude/agents/scout.md': agentFile('scout', 'PROJECT SCOUT', ['disallowedTools: Write, Edit']),
      '/home/u/.claude/agents/scout.md': agentFile('scout', 'USER SCOUT'),
      '/home/u/.claude/agents/helper.md': agentFile('helper', 'USER HELPER', ['tools:', '  - Read', '  - Glob']),
      '/w/.claude/agents/lens.md': agentFile('telescope', 'PROJECT TELESCOPE'),
      '/home/u/.claude/agents/lens.md': agentFile('lens', 'USER LENS'),
    },
  })
  await start($)
  for (const [turnId, agentId] of [['ts', 'p1'], ['tu', 'u1'], ['tl', 'l1']] as const) await step($, { turnId, index: 0, agentId })
  expect(w.requests.map(c => systemText(c.body).split('\n')[0])).toEqual(['PROJECT SCOUT', 'USER HELPER', 'USER LENS'])
  expect(toolNames(w.requests[0]!.body)).toEqual(ALL_SUB_TOOLS.filter(n => n !== 'Edit' && n !== 'Write'))
  expect(toolNames(w.requests[1]!.body)).toEqual(['Glob', 'Read', 'SubagentHandback'])
  expect(toolNames(w.requests[2]!.body)).toEqual(ALL_SUB_TOOLS)
  expect(w.composes).toEqual([])
})

test("a custom agent whose definition is missing, malformed or in no installed plugin runs as general-purpose, with one debug line saying why", async ($, on) => {
  const broken = ['---', 'name: broken', 'description: |', '  two lines', '---', 'BROKEN BODY'].join('\n')
  const w = world(on, {
    routes: { g1: typed('ghost'), m1: typed('acme-agents:broken'), n1: typed('nowhere:thing') },
    tools: MAIN_TOOLS,
    files: withAgents({ [`${PLUGIN_ROOT}/agents/broken.md`]: broken }),
  })
  await start($)
  for (const index of [0, 1]) await step($, { turnId: 'fg', index, agentId: 'g1' })
  await step($, { turnId: 'fm', index: 0, agentId: 'm1' })
  await step($, { turnId: 'fn', index: 0, agentId: 'n1' })
  expect(w.requests).toHaveLength(4)
  for (const c of w.requests) {
    expect(systemText(c.body).startsWith(GENERAL_PURPOSE_PROMPT)).toBe(true)
    expect(toolNames(c.body)).toEqual(ALL_SUB_TOOLS)
  }
  expect(w.debug.filter(l => l.startsWith('klyth agent-def '))).toEqual([
    'klyth agent-def ghost: no definition found (no agent file in /w/.claude/agents or /home/u/.claude/agents has the name ghost)',
    `klyth agent-def acme-agents:broken: ${PLUGIN_ROOT}/agents/broken.md: line 3: "|" is a YAML form klyth does not read (only text and lists are)`,
    'klyth agent-def nowhere:thing: /home/u/.claude/plugins/installed_plugins.json: plugin nowhere is not installed',
  ])
})

test("a built-in type with one agent file runs on the file's body and tools; with two files it runs on klyth's prompt and the type's own tool filter", async ($, on) => {
  const w = world(on, {
    routes: { ex4: EXPLORE, gp2: typed('general-purpose') },
    tools: MAIN_TOOLS,
    files: { '/w/.claude/agents/Explore.md': agentFile('Explore', 'EXPLORE FILE', ['tools: Read']), '/w/.claude/agents/gp.md': agentFile('general-purpose', 'GP ONE'), '/home/u/.claude/agents/gp.md': agentFile('general-purpose', 'GP TWO') },
  })
  await start($)
  await step($, { turnId: 'bx', index: 0, agentId: 'ex4' })
  await step($, { turnId: 'bg', index: 0, agentId: 'gp2' })
  expect(systemText(w.requests[0]!.body).startsWith('EXPLORE FILE\n\n')).toBe(true)
  expect(toolNames(w.requests[0]!.body)).toEqual(['Read', 'SubagentHandback'])
  expect(systemText(w.requests[1]!.body).startsWith(GENERAL_PURPOSE_PROMPT)).toBe(true)
  expect(toolNames(w.requests[1]!.body)).toEqual(ALL_SUB_TOOLS)
})

test("a built-in type with no agent file runs on klyth's prompt and the type's own tool filter, and says nothing", async ($, on) => {
  const w = world(on, { routes: { ex4: EXPLORE }, tools: MAIN_TOOLS })
  await start($)
  await step($, { turnId: 'bx', index: 0, agentId: 'ex4' })
  expect(systemText(w.requests[0]!.body)).toContain('read-only search agent')
  expect(toolNames(w.requests[0]!.body)).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'SubagentHandback'])
  expect(w.debug.some(l => l.startsWith('klyth agent-def'))).toBe(false)
})

test('a definition is read once per session and read again after /klyth reload', async ($, on) => {
  const w = world(on, { routes: { rv2: typed('acme-agents:reviewer') }, files: withAgents() })
  await start($)
  await step($, { turnId: 'c', index: 0, agentId: 'rv2' })
  await step($, { turnId: 'c', index: 1, agentId: 'rv2' })
  const readsOf = (p: string) => w.fsReads.filter(r => r === p).length
  const file = `${PLUGIN_ROOT}/agents/reviewer.md`
  const installed = `${HOME}/.claude/plugins/installed_plugins.json`
  expect([readsOf(file), readsOf(installed)]).toEqual([1, 1])
  await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await step($, { turnId: 'c', index: 2, agentId: 'rv2' })
  expect([readsOf(file), readsOf(installed)]).toEqual([2, 2])
  expect(w.requests.every(c => systemText(c.body).startsWith(REVIEWER_BODY))).toBe(true)
})

// A routed custom agent whose klyth agent call gave no effort.
const noEffort = (type: string) => ({ target: FAST.target, label: FAST.label, type, prompt: TASK })

test("a custom agent's definition effort is its effort when its call gave none, mapped to the model's nearest declared level; its frontmatter model is ignored", async ($, on) => {
  const w = world(on, {
    routes: { ef1: noEffort('deep') },
    files: { '/w/.claude/agents/deep.md': agentFile('deep', 'DEEP BODY', ['effort: xhigh', 'model: claude-opus-5']) },
  })
  await start($)
  await step($, { turnId: 'ef', index: 0, agentId: 'ef1', effort: 'low' })
  expect(w.requests[0]!.body).toMatchObject({ model: 'model-a', reasoning_effort: 'high' })
  expect(w.debug.some(l => l.startsWith('klyth step ef1 → acme/model-a kind=openai http=200 effort=xhigh→high '))).toBe(true)
})

test("the effort the klyth agent call gave beats its definition's, and a definition effort that names no level, or none, leaves the step's own", async ($, on) => {
  const w = world(on, {
    routes: { ef2: { ...noEffort('deep'), effort: 'low' }, ef3: noEffort('vague'), ef4: noEffort('plain') },
    files: {
      '/w/.claude/agents/deep.md': agentFile('deep', 'DEEP BODY', ['effort: high']),
      '/w/.claude/agents/vague.md': agentFile('vague', 'VAGUE BODY', ['effort: turbo']),
      '/w/.claude/agents/plain.md': agentFile('plain', 'PLAIN BODY'),
    },
  })
  await start($)
  for (const [turnId, agentId] of [['eg', 'ef2'], ['eh', 'ef3'], ['ei', 'ef4']] as const) await step($, { turnId, index: 0, agentId, effort: 'medium' })
  expect(w.requests.map(c => c.body['reasoning_effort'])).toEqual(['low', 'medium', 'medium'])
})

// klyth.json, installed_plugins.json and the user's agents are under $CLAUDE_CONFIG_DIR when it is set and not
// empty, else under $HOME/.claude; the other directory holds a decoy of each, which a misplaced read would take.
for (const [when, env, dir, other] of [
  ['set', { CLAUDE_CONFIG_DIR: '/cfg/work' }, '/cfg/work', `${HOME}/.claude`],
  ['unset', {}, `${HOME}/.claude`, '/cfg/work'],
  ['set but empty', { CLAUDE_CONFIG_DIR: '' }, `${HOME}/.claude`, '/cfg/work'],
] as const) {
  test(`with CLAUDE_CONFIG_DIR ${when}, klyth.json, installed_plugins.json and the user's agents are read from ${dir}`, async ($, on) => {
    const w = world(on, {
      env,
      routes: { rv3: typed('acme-agents:reviewer'), u2: typed('helper') },
      files: {
        [`${other}/klyth.json`]: '{ not json',
        [`${dir}/plugins/installed_plugins.json`]: INSTALLED,
        [`${other}/plugins/installed_plugins.json`]: JSON.stringify({ version: 2, plugins: {} }),
        [`${PLUGIN_ROOT}/agents/reviewer.md`]: REVIEWER,
        [`${dir}/agents/helper.md`]: agentFile('helper', 'USER HELPER'),
        [`${other}/agents/helper.md`]: agentFile('helper', 'DECOY HELPER'),
      },
    })
    await start($)
    await step($, { turnId: 'cd1', index: 0, agentId: 'rv3' })
    await step($, { turnId: 'cd2', index: 0, agentId: 'u2' })
    expect(w.requests.map(c => systemText(c.body).split('\n')[0])).toEqual([REVIEWER_BODY, 'USER HELPER'])
    expect(w.fsReads).toEqual([`${dir}/klyth.json`, `${dir}/plugins/installed_plugins.json`, `${PLUGIN_ROOT}/agents/reviewer.md`, `${dir}/agents/helper.md`])
  })
}

// A gateway refusing every request.
const FORBIDDEN = { status: 403, pieces: ['{"error":{"message":"Access denied for this route"}}\n'] }
const FORBIDDEN_TEXT = 'klyth: acme HTTP 403: Access denied for this route; ask the acme admin for access, or store another key with bun run auth login acme'

test('a routed subagent step that fails at HTTP is answered with one SubagentHandback call carrying the failure text', async ($, on) => {
  const w = world(on, { routes: { hb1: FAST }, upstream: () => FORBIDDEN })
  await start($)
  const s = await step($, { turnId: 'hb', index: 0, agentId: 'hb1' })
  expect(kinds(s.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(s.chunks[0]).toEqual({ kind: 'tool', index: 0, id: expect.stringMatching(/^toolu_klyth_[0-9a-f]{24}$/), name: 'SubagentHandback' })
  expect(JSON.parse((s.chunks[1] as { json: string }).json)).toEqual({ message: FORBIDDEN_TEXT })
  expect(s.chunks[2]).toEqual({ kind: 'stop', stopReason: 'tool_use', usage: null })
  expect(s.result).toEqual({ turnId: 'hb', index: 0, answer: '', toolUses: [{ name: 'SubagentHandback', input: { message: FORBIDDEN_TEXT } }], stopReason: 'tool_use', usage: null })
  expect(w.toasts).toContain(FORBIDDEN_TEXT)
  expect(w.debug.some(l => l.startsWith('klyth step hb1 → acme/model-a kind=openai http=403 '))).toBe(true)
})

test('a failed subagent step keeps the error text when its request offered no SubagentHandback, after it yielded a tool call, or when the stream reports the error', async ($, on) => {
  const read = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] } }] }
  const text = { choices: [{ index: 0, delta: { content: 'reading' } }] }
  const w = world(on, {
    config: withProvider({}, { 'model-a': { ...CONFIG_OBJECT.providers.acme.models['model-a'], tools: false } }),
    routes: { nt1: FAST, tc1: { target: 'acme/model-b', label: 'strong' }, se1: { target: 'acme/small', label: 'acme/small' } },
    // nt1's engine did not say it delivers through SubagentHandback, so a tools: false model is offered none.
    messages: (agentId: string | undefined) => (agentId === 'nt1' ? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] : undefined),
    upstream: r => {
      const m = r.body['model']
      if (m === 'model-b') return { pieces: [sse(read, text)], cut: 'stall' }
      return m === 'small' ? { pieces: [sse({ error: { message: 'upstream overloaded' } })] } : FORBIDDEN
    },
  })
  await start($)
  const none = await step($, { turnId: 'nt', index: 0, agentId: 'nt1' })
  expect(kinds(none.chunks)).toEqual(['text0', 'stop'])
  expect(none.result).toMatchObject({ answer: FORBIDDEN_TEXT, toolUses: [], stopReason: 'end_turn' })
  const after = await step($, { turnId: 'tc', index: 0, agentId: 'tc1' })
  expect(kinds(after.chunks)).toEqual(['tool0', 'input0', 'text1', 'text2', 'stop'])
  expect(after.result).toMatchObject({ answer: 'readingklyth: acme stalled (no data for 600 s); retry', toolUses: [{ name: 'Read', input: { file_path: '/a' } }], stopReason: 'tool_use' })
  const inStream = await step($, { turnId: 'se', index: 0, agentId: 'se1' })
  expect(toolNames(w.requests[2]!.body)).toContain('SubagentHandback')
  expect(kinds(inStream.chunks)).toEqual(['text0', 'stop'])
  expect(inStream.result).toMatchObject({ answer: 'klyth: acme response failed: upstream overloaded; retry, or see the debug log', toolUses: [], stopReason: 'end_turn' })
  expect(w.requests).toHaveLength(3)
})

// The SubagentHandback call a step was answered with, as its tool-use input.
const handedBack = (s: { chunks: readonly TurnStepChunk[] }) => JSON.parse((s.chunks[1] as { json: string }).json) as { message: string }

test('a routed subagent whose provider lost its approval hands the not-approved text back, and nothing is sent', async ($, on) => {
  const w = world(on, { routes: { na1: FAST }, store: {} })
  await start($)
  const s = await step($, { turnId: 'na', index: 0, agentId: 'na1' })
  const text = 'klyth: provider acme is not approved; run /model fast to approve it. The step was not sent'
  expect(kinds(s.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(s.chunks[0]).toEqual({ kind: 'tool', index: 0, id: expect.stringMatching(/^toolu_klyth_[0-9a-f]{24}$/), name: 'SubagentHandback' })
  expect(handedBack(s)).toEqual({ message: text })
  expect(s.result).toEqual({ turnId: 'na', index: 0, answer: '', toolUses: [{ name: 'SubagentHandback', input: { message: text } }], stopReason: 'tool_use', usage: null })
  expect(w.toasts).toContain(text)
  expect(w.requests).toEqual([])
  expect(w.nativeSteps).toEqual([])
})

test('a routed subagent whose target is gone, whose transcript is unreadable, or that is over its input budget hands the failure back', async ($, on) => {
  const w = world(on, {
    routes: { gone1: { target: 'acme/gone', label: 'acme/gone' }, ur1: FAST, big1: { target: 'acme/small', label: 'acme/small' } },
    messages: (agentId: string | undefined) => (agentId === 'ur1' ? { deny: 'no saved transcript for ur1' } : agentId === 'big1' ? [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(500_000) }, HANDBACK_REMINDER] }] : undefined),
  })
  await start($)
  const gone = await step($, { turnId: 'g', index: 0, agentId: 'gone1' })
  expect(kinds(gone.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(handedBack(gone)).toEqual({
    message: 'klyth: acme/gone is not available (no longer configured); the step was not sent. Fix ~/.claude/klyth.json, run /klyth reload, or pick another model',
  })
  const unreadable = await step($, { turnId: 'u', index: 0, agentId: 'ur1' })
  expect(kinds(unreadable.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(handedBack(unreadable)).toEqual({ message: 'klyth: the transcript of ur1 is unreadable (no saved transcript for ur1); the step was not sent; retry' })
  const big = await step($, { turnId: 'b', index: 0, agentId: 'big1' })
  expect(kinds(big.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(handedBack(big).message).toMatch(/^klyth: context ~\d+k exceeds acme\/small's 95% safety threshold \(114k\) of its 120k configured input budget; run \/klyth compact between turns$/)
  expect(w.requests).toEqual([])
})

// A transcript whose last step called SubagentHandback, and the engine refused the call.
const REFUSED = [
  { role: 'user', content: [{ type: 'text', text: TASK }, HANDBACK_REMINDER] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_klyth_000000000000000000000009', name: 'SubagentHandback', input: { message: FORBIDDEN_TEXT } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_klyth_000000000000000000000009', content: 'No such tool available: SubagentHandback', is_error: true }] },
]

test('a subagent whose last handback was refused answers the next failure as text, so its run ends', async ($, on) => {
  const w = world(on, { routes: { rf1: FAST }, store: {}, messages: () => REFUSED })
  await start($)
  const unapproved = await step($, { turnId: 'r', index: 0, agentId: 'rf1' })
  expect(kinds(unapproved.chunks)).toEqual(['text0', 'stop'])
  expect(unapproved.result).toMatchObject({ answer: 'klyth: provider acme is not approved; run /model fast to approve it. The step was not sent', toolUses: [], stopReason: 'end_turn' })
  expect(w.requests).toEqual([])
})

test('a transcript ending in a refused handback, then an HTTP 403, answers the 403 as text', async ($, on) => {
  const w = world(on, { routes: { rf3: FAST }, upstream: () => FORBIDDEN, messages: () => REFUSED })
  await start($)
  const s = await step($, { turnId: 'r', index: 0, agentId: 'rf3' })
  expect(toolNames(w.requests[0]!.body)).not.toContain('SubagentHandback')
  expect(kinds(s.chunks)).toEqual(['text0', 'stop'])
  expect(s.result).toMatchObject({ answer: FORBIDDEN_TEXT, toolUses: [], stopReason: 'end_turn' })
  expect(w.requests).toHaveLength(1)
})

// The same refusal with the run gone on since: the engine has refused SubagentHandback, so it is offered no more.
const REFUSED_LATER = [...REFUSED, { role: 'assistant', content: [{ type: 'text', text: 'retrying' }] }, { role: 'user', content: [{ type: 'text', text: 'go on' }] }]

test('a subagent the engine once refused SubagentHandback is offered it no more, is not told of it, and answers a failure as text', async ($, on) => {
  const w = world(on, { routes: { rf4: FAST }, upstream: () => FORBIDDEN, messages: () => REFUSED_LATER })
  await start($)
  const s = await step($, { turnId: 'r', index: 0, agentId: 'rf4' })
  expect(toolNames(w.requests[0]!.body)).not.toContain('SubagentHandback')
  expect(JSON.stringify((w.requests[0]!.body['messages'] as { content: unknown }[])[0])).not.toContain(JSON.stringify(HANDBACK_GUIDANCE).slice(1, -1))
  expect(w.debug.find(l => l.startsWith('klyth req rf4 '))).not.toContain('SubagentHandback')
  expect(w.debug).toContain('klyth: rf4 is offered no SubagentHandback (the engine refused a call of it)')
  expect(s.result).toMatchObject({ answer: FORBIDDEN_TEXT, toolUses: [], stopReason: 'end_turn' })
})

// What the engine says about SubagentHandback decides whether it is offered (handbackState): the reminder after the task
// says it delivers through it, a refused schema-valid call withdraws it, an enforce marker restores it.
const QUIET = [{ role: 'user', content: [{ type: 'text', text: TASK }] }]
const WITH = { role: 'user', content: [{ type: 'text', text: TASK }, HANDBACK_REMINDER] }
const CALL = (message: unknown) => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'hb9', name: 'SubagentHandback', input: message === undefined ? {} : { message } }] })
const REFUSAL = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'hb9', content: 'No such tool available: SubagentHandback', is_error: true }] }
const systemOfReq = (w: { requests: readonly { body: Record<string, unknown> }[] }, n: number) => String(sentMessages(w.requests[n]!.body)[0]?.content)
const NOT_SAID = 'klyth: sg1 is offered no SubagentHandback (the engine did not say it delivers through it; its final text is its report)'

test('a subagent whose transcript lacks the engine\'s reminder is offered no SubagentHandback, is not told of it, says so once, and has its failure answered as text', async ($, on) => {
  const w = world(on, { routes: { sg1: FAST }, upstream: () => FORBIDDEN, messages: () => QUIET })
  await start($)
  const first = await step($, { turnId: 'sg', index: 0, agentId: 'sg1' })
  await step($, { turnId: 'sg', index: 1, agentId: 'sg1' })
  for (const n of [0, 1]) {
    expect(toolNames(w.requests[n]!.body)).not.toContain('SubagentHandback')
    expect(systemOfReq(w, n)).not.toContain(HANDBACK_GUIDANCE)
  }
  expect(w.debug.filter(l => l.startsWith('klyth req sg1 ')).every(l => !l.includes('SubagentHandback'))).toBe(true)
  expect(w.debug.filter(l => l.includes('is offered no SubagentHandback'))).toEqual([NOT_SAID])
  expect(kinds(first.chunks)).toEqual(['text0', 'stop'])
  expect(first.result).toMatchObject({ answer: FORBIDDEN_TEXT, toolUses: [], stopReason: 'end_turn' })
})

test('a subagent whose call of SubagentHandback was refused is offered it no more, with one debug line over two steps', async ($, on) => {
  const messages = [WITH, CALL('r'), REFUSAL, { role: 'assistant', content: [{ type: 'text', text: 'retrying' }] }, { role: 'user', content: [{ type: 'text', text: 'go on' }] }]
  const w = world(on, { routes: { sg2: FAST }, upstream: () => FORBIDDEN, messages: () => messages })
  await start($)
  await step($, { turnId: 'sg', index: 0, agentId: 'sg2' })
  await step($, { turnId: 'sg', index: 1, agentId: 'sg2' })
  for (const n of [0, 1]) {
    expect(toolNames(w.requests[n]!.body)).not.toContain('SubagentHandback')
    expect(systemOfReq(w, n)).not.toContain(HANDBACK_GUIDANCE)
  }
  expect(w.debug.filter(l => l.includes('is offered no SubagentHandback'))).toEqual(['klyth: sg2 is offered no SubagentHandback (the engine refused a call of it)'])
})

test('a refused call that was not schema-valid (no message) leaves SubagentHandback offered', async ($, on) => {
  const w = world(on, { routes: { sg3: FAST }, messages: () => [WITH, CALL(undefined), REFUSAL] })
  await start($)
  await step($, { turnId: 'sg', index: 0, agentId: 'sg3' })
  expect(toolNames(w.requests[0]!.body)).toContain('SubagentHandback')
  expect(systemOfReq(w, 0)).toContain(HANDBACK_GUIDANCE)
  expect(w.debug.some(l => l.includes('is offered no SubagentHandback'))).toBe(false)
})

test('an enforce marker after a refused call offers SubagentHandback again', async ($, on) => {
  const enforce = { role: 'user', content: [{ type: 'text', text: '[handback-send-enforce] Call SubagentHandback.' }] }
  const w = world(on, { routes: { sg4: FAST }, messages: () => [WITH, CALL('r'), REFUSAL, { role: 'assistant', content: [{ type: 'text', text: 'text' }] }, enforce] })
  await start($)
  await step($, { turnId: 'sg', index: 0, agentId: 'sg4' })
  expect(toolNames(w.requests[0]!.body)).toContain('SubagentHandback')
})

test('a route klyth refused answers a subagent whose engine did not say it hands back as text, and one whose engine did as one SubagentHandback call', async ($, on) => {
  const w = world(on, { routes: { sg5: { ...FAST, refused: 'x' }, sg6: { ...FAST, refused: 'x' } }, messages: (agentId: string | undefined) => (agentId === 'sg5' ? QUIET : [WITH]) })
  await start($)
  const quiet = await step($, { turnId: 'sg', index: 0, agentId: 'sg5' })
  expect(kinds(quiet.chunks)).toEqual(['text0', 'stop'])
  expect(quiet.result).toMatchObject({ answer: 'x', toolUses: [], stopReason: 'end_turn' })
  const said = await step($, { turnId: 'sg', index: 0, agentId: 'sg6' })
  expect(said.result).toMatchObject({ answer: '', toolUses: [{ name: 'SubagentHandback', input: { message: 'x' } }], stopReason: 'tool_use' })
})

for (const [id, read, handed] of [['sg7', QUIET, 0], ['sg8', [WITH], 1]] as const) {
  test(`a step that failed inside klyth is ${handed ? 'handed back' : 'answered as text'} when the engine ${handed ? 'said' : 'did not say'} it hands back (${id})`, async ($, on) => {
    let reads = 0
    const w = world(on, {
      routes: { [id]: FAST },
      messages: () => {
        if (reads++ === 0) throw new Error('transcript unavailable')
        return read
      },
    })
    await start($)
    const s = await step($, { turnId: 'sg', index: 0, agentId: id })
    expect(s.result.toolUses.length).toBe(handed)
    expect(w.requests).toEqual([])
  })
}

// A `tools: false` model is offered no tool and no handback guidance; where the engine delivers through SubagentHandback,
// klyth hands its text-only end back as one call of it (step.ts).
const TEXT_END = sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'report' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }, '[DONE]')
const NO_TOOLS = withProvider({}, { 'model-a': { ...CONFIG_OBJECT.providers.acme.models['model-a'], tools: false } })
const SYNTH = (who: string) => `klyth: ${who} ended on text; klyth handed it back as one SubagentHandback call (tools: false)`

test('a tools: false subagent is offered no tool and no guidance, and its text-only end is handed back as one SubagentHandback call when the engine said it hands back', async ($, on) => {
  const w = world(on, { config: NO_TOOLS, routes: { tf1: FAST }, messages: () => [WITH], upstream: () => ({ pieces: [TEXT_END] }) })
  await start($)
  const s = await step($, { turnId: 'tf', index: 0, agentId: 'tf1' })
  const body = w.requests[0]!.body
  expect(body).not.toHaveProperty('tools')
  expect(body).not.toHaveProperty('toolConfig')
  expect(systemOfReq(w, 0)).not.toContain(HANDBACK_GUIDANCE)
  expect(w.debug.find(l => l.startsWith('klyth req tf1 '))).toContain('tools=0[]')
  expect(kinds(s.chunks)).toEqual(['text0', 'tool1', 'input1', 'stop'])
  expect(JSON.parse((s.chunks[2] as { json: string }).json)).toEqual({ message: 'report' })
  expect(s.result).toMatchObject({ answer: 'report', toolUses: [{ name: 'SubagentHandback', input: { message: 'report' } }], stopReason: 'tool_use' })
  expect(w.debug).toContain(SYNTH('tf1'))
})

test('a tools: false subagent whose engine did not say it hands back ends on its text, with no synthesis', async ($, on) => {
  const w = world(on, { config: NO_TOOLS, routes: { tf2: FAST }, messages: () => QUIET, upstream: () => ({ pieces: [TEXT_END] }) })
  await start($)
  const s = await step($, { turnId: 'tf', index: 0, agentId: 'tf2' })
  expect(kinds(s.chunks)).toEqual(['text0', 'stop'])
  expect(s.result).toMatchObject({ answer: 'report', toolUses: [], stopReason: 'end_turn' })
  expect(w.debug.some(l => l.includes('handed it back as one'))).toBe(false)
})

test('a tools: false subagent is handed an HTTP 403 as one call too', async ($, on) => {
  const w = world(on, { config: NO_TOOLS, routes: { tf3: FAST }, messages: () => [WITH], upstream: () => FORBIDDEN })
  await start($)
  const s = await step($, { turnId: 'tf', index: 0, agentId: 'tf3' })
  expect(kinds(s.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(handedBack(s)).toEqual({ message: FORBIDDEN_TEXT })
})

test('a tools: false subagent whose provider is not approved is handed that line as one call, and nothing is sent', async ($, on) => {
  const bare = world(on, { config: NO_TOOLS, routes: { tf4: FAST }, messages: () => [WITH], store: {} })
  await start($)
  const u = await step($, { turnId: 'tf', index: 0, agentId: 'tf4' })
  expect(kinds(u.chunks)).toEqual(['tool0', 'input0', 'stop'])
  expect(handedBack(u).message).toContain('provider acme is not approved')
  expect(bare.requests).toEqual([])
})

test('klyth\'s own handback calls leave the transcript a tools: false model is sent: the call and its result, with its text kept', async ($, on) => {
  const done = [WITH, { role: 'assistant', content: [{ type: 'text', text: 'report' }, { type: 'tool_use', id: 'hbX', name: 'SubagentHandback', input: { message: 'report' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'hbX', content: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'more' }] }]
  const w = world(on, { config: NO_TOOLS, routes: { tf5: FAST, tf6: FAST }, messages: (agentId: string | undefined) => (agentId === 'tf5' ? done : [WITH, CALL(FORBIDDEN_TEXT), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'hb9', content: 'ok' }] }]), upstream: () => ({ pieces: [TEXT_END] }) })
  await start($)
  await step($, { turnId: 'tf', index: 0, agentId: 'tf5' })
  await step($, { turnId: 'tf', index: 0, agentId: 'tf6' })
  const wire = (n: number) => JSON.stringify(sentMessages(w.requests[n]!.body))
  expect(wire(0)).not.toMatch(/tool_calls|"role":"tool"|tool_use|tool_result|"name":"SubagentHandback"/)
  expect(wire(0)).toContain('report')
  expect(wire(0)).toContain('more')
  expect(wire(1)).not.toMatch(/tool_calls|"role":"tool"|"name":"SubagentHandback"/)
  expect(wire(1)).toContain(FORBIDDEN_TEXT)
  const last = sentMessages(w.requests[1]!.body).at(-1)
  expect(last?.role).toBe('user')
  expect(JSON.stringify(last?.content)).toContain('SubagentHandback: ok')
})

// Gaps a mutation run showed: who is handed a text-only end back as a call, and what is sent of a handback the model was offered.
const FORK_OF_SUB = { ...FAST, type: 'fork', prompt: 'the task', forkOf: 'toolu_fork', parent: 'sub6' }
const FORK_WITH_REMINDER = [{ role: 'user', content: [{ type: 'text', text: 'the task' }, HANDBACK_REMINDER] }]

test('a routed fork on a tools: false model, whose history carries the engine\'s reminder, ends on its text with no SubagentHandback synthesized', async ($, on) => {
  const w = world(on, { ...FORK_MCP_WORLD, config: NO_TOOLS, routes: { sub6: FAST, fk1: FORK_OF_SUB }, messages: (agentId: string | undefined) => (agentId === 'fk1' ? FORK_WITH_REMINDER : FORKED_MCP), upstream: () => ({ pieces: [TEXT_END] }) })
  await start($)
  const s = await step($, { turnId: 'fk', index: 0, agentId: 'fk1' })
  expect(w.requests).toHaveLength(1)
  expect(kinds(s.chunks)).toEqual(['text0', 'stop'])
  expect(s.result).toMatchObject({ answer: 'report', toolUses: [], stopReason: 'end_turn' })
  expect(w.debug).not.toContain(SYNTH('fk1'))
})

test('a tools: true subagent offered SubagentHandback whose upstream ends on text alone ends on that text, with no call synthesized', async ($, on) => {
  const w = world(on, { routes: { tt1: FAST }, messages: () => [WITH], upstream: () => ({ pieces: [TEXT_END] }) })
  await start($)
  const s = await step($, { turnId: 'tt', index: 0, agentId: 'tt1' })
  expect(toolNames(w.requests[0]!.body)).toContain('SubagentHandback')
  expect(kinds(s.chunks)).toEqual(['text0', 'stop'])
  expect(s.result).toMatchObject({ answer: 'report', toolUses: [], stopReason: 'end_turn' })
  expect(w.debug).not.toContain(SYNTH('tt1'))
})

test('a tools: true subagent is sent the SubagentHandback call and the refusal its transcript holds, unchanged', async ($, on) => {
  const w = world(on, { routes: { tt2: FAST }, messages: () => [WITH, CALL('r'), REFUSAL, { role: 'user', content: [{ type: 'text', text: 'go on' }] }], upstream: () => ({ pieces: [TEXT_END] }) })
  await start($)
  await step($, { turnId: 'tt', index: 0, agentId: 'tt2' })
  const wire = JSON.stringify(sentMessages(w.requests[0]!.body))
  expect(wire).toContain('"tool_calls"')
  expect(wire).toContain('"name":"SubagentHandback"')
  expect(wire).toContain('"role":"tool"')
  expect(wire).toContain('"tool_call_id":"hb9"')
})

test('a routed fork whose step fails inside klyth is answered as text, not as a SubagentHandback call', async ($, on) => {
  const w = world(on, {
    ...FORK_MCP_WORLD,
    routes: { sub6: FAST, fk2: FORK_OF_SUB },
    messages: () => {
      throw new Error('transcript unavailable')
    },
  })
  await start($)
  const s = await step($, { turnId: 'fk', index: 0, agentId: 'fk2' })
  expect(kinds(s.chunks)).toEqual(['text0', 'stop'])
  expect(s.result).toMatchObject({ answer: 'klyth: internal error on acme/model-a; the step was not sent to another model (see the debug log)', toolUses: [], stopReason: 'end_turn' })
  expect(w.requests).toEqual([])
})

test('a pinned routed main step logs no line saying main is offered no SubagentHandback', async ($, on) => {
  const w = world(on, { pin: B_PIN('mh') })
  await start($)
  await step($, { turnId: 'mh', index: 0 })
  expect(w.debug.filter(l => /^klyth: main is offered no SubagentHandback/.test(l))).toEqual([])
})

// A transcript that cannot be read hides whether the engine refused the last handback, so the step that
// repeats in the same turn is told by klyth's own record of having handed back.
for (const [how, messages, text] of [
  [
    'is denied',
    (agentId: string | undefined) => ({ deny: `no saved transcript for ${agentId}` }),
    'klyth: the transcript of ub1 is unreadable (no saved transcript for ub1); the step was not sent; retry',
  ],
  [
    'throws',
    () => {
      throw new Error('transcript store down')
    },
    'klyth: internal error on acme/model-a; the step was not sent to another model (see the debug log)',
  ],
] as const) {
  test(`a subagent whose transcript read ${how} on a step and on its repeat is handed the failure once, then answered it as text, and nothing is sent`, async ($, on) => {
    const w = world(on, { routes: { ub1: FAST }, messages })
    await start($)
    const first = await step($, { turnId: 'ub', index: 0, agentId: 'ub1' })
    expect(kinds(first.chunks)).toEqual(['tool0', 'input0', 'stop'])
    expect(handedBack(first)).toEqual({ message: text })
    const repeat = await step($, { turnId: 'ub', index: 1, agentId: 'ub1' })
    expect(kinds(repeat.chunks)).toEqual(['text0', 'stop'])
    expect(repeat.result).toMatchObject({ answer: text, toolUses: [], stopReason: 'end_turn' })
    const resumed = await step($, { turnId: 'ub-resumed', index: 0, agentId: 'ub1' })
    expect(kinds(resumed.chunks)).toEqual(['tool0', 'input0', 'stop'])
    expect(handedBack(resumed)).toEqual({ message: text })
    expect(w.requests).toEqual([])
    expect(w.nativeSteps).toEqual([])
  })
}

test('an agent type that climbs out of the agents directory is no agent file: no file is read, and it runs as general-purpose', async ($, on) => {
  const path = '/w/.claude/agents/../../etc/evil.md'
  const w = world(on, { routes: { tr1: typed('../../etc/evil') }, tools: MAIN_TOOLS, files: { [path]: agentFile('../../etc/evil', 'EVIL') } })
  await start($)
  await step($, { turnId: 'tr', index: 0, agentId: 'tr1' })
  expect(systemText(w.requests[0]!.body).startsWith(GENERAL_PURPOSE_PROMPT)).toBe(true)
  expect(w.fsReads).not.toContain(path)
  expect(w.debug).toContain('klyth agent-def ../../etc/evil: "../../etc/evil" is not an agent file name')
})

test('the klyth req line redacts before it cuts at 60 characters, so no part of a credential across the cut shows', async ($, on) => {
  const HEX = '0123456789abcdef0123456789abcdef'
  const w = world(on, { pin: B_PIN('cut'), messages: () => [{ role: 'user', content: [{ type: 'text', text: `${'word '.repeat(9)}${HEX}` }] }] })
  await start($)
  await step($, { turnId: 'cut', index: 0 })
  const line = w.debug.find(l => l.startsWith('klyth req main ')) ?? ''
  expect(line).toContain(`firstUser="${'word '.repeat(9)}[REDACTED]"`)
  expect(line).not.toContain('0123456789')
})

test('a large remote prompt refuses a transcript of the same length as the request it counted', async ($, on) => {
  const w = world(on, { usageTokens: 2_000, upstream: sized(115_000) })
  await start($)
  await model($, 'acme/small')
  await step($, { turnId: 'a', index: 0, messageCount: 40 })
  expect((await step($, { turnId: 'a', index: 1, messageCount: 40 })).result.answer).toBe("klyth: context ~115k exceeds acme/small's 95% safety threshold (114k) of its 120k configured input budget; run /klyth compact between turns")
  expect(w.requests).toHaveLength(1)
})

// Claude Code saves a fork of main as its own messages alone. klyth rebuilds main's history up to the turn whose Agent
// call started the fork (fork.ts); a fork it cannot rebuild is not sent, and no fork is offered SubagentHandback.
test("a fork of a routed main is sent main's history up to the call that started it, joined to its own turn, with no SubagentHandback; one with no recorded call fails as text and sends nothing", async ($, on) => {
  let main = [
    { role: 'user', content: [{ type: 'text', text: 'remember the code word lark' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fork', name: 'Agent', input: { subagent_type: 'fork' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fork', content: 'started' }] },
  ]
  const fork = { target: 'acme/model-a', label: 'fast', type: 'fork', prompt: 'What is the code word?' }
  const w = world(on, { routes: { f1: { ...fork, forkOf: 'toolu_fork' }, f2: fork }, messages: (agentId: string | undefined) => (agentId === undefined ? main : [{ role: 'user', content: [{ type: 'text', text: 'What is the code word?' }] }]) })
  await start($)
  await step($, { turnId: 't1', index: 0, agentId: 'f1' })
  expect(w.debug).toContain('klyth req f1 msgs=3 firstUser="remember the code word lark" tools=3[Read|Agent|mcp__klyth__agent]')
  const sent = JSON.stringify(w.requests[0]?.body['messages'])
  for (const part of ['remember the code word lark', 'toolu_fork', 'What is the code word?', FORK_REPORT]) expect(sent).toContain(JSON.stringify(part).slice(1, -1))
  expect(JSON.stringify(w.requests[0]?.body['tools'])).not.toContain('SubagentHandback')
  const failed = await step($, { turnId: 't2', index: 0, agentId: 'f2' })
  expect(failed.result).toMatchObject({ toolUses: [], answer: expect.stringContaining("klyth: this fork's inherited history could not be read, so the step was not sent") })
  expect(w.requests).toHaveLength(1)
  // Main then drops the call (a /compact): the running fork is still sent, from the history kept at its first step.
  main = [{ role: 'user', content: [{ type: 'text', text: 'summary of the session' }] }]
  await step($, { turnId: 't1', index: 1, agentId: 'f1' })
  expect(w.requests).toHaveLength(2)
  expect(JSON.stringify(w.requests[1]?.body['messages'])).not.toContain("inherited history could not be read")
  expect(JSON.stringify(w.requests[1]?.body['messages'])).toContain('remember the code word lark')
})
