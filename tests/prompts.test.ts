// The routed system prompt: main's composed prompt with the routed model's identity, the prompts klyth writes for
// the built-in subagent types, an agent file that names a built-in type, a custom agent with no definition, and
// the main-only tools no subagent is offered.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BUILTIN_NOTES, FORK_REPORT, GENERAL_PURPOSE_PROMPT, GENERIC_PROMPT, HANDBACK_GUIDANCE, SEARCH_WITH_BASH, SEARCH_WITH_TOOLS, SUBAGENT_DENIED, toolFilter } from '../hooks/agents'
import { rewriteMain, systemFor, withIdentity } from '../hooks/prompts'
import { createSession } from '../hooks/session'
import { HANDBACK_REMINDER, HOME, model, start, step, klyth, world } from './world'

const ENGINE_IDENTITY = 'You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.'
const tools = (...names: string[]) => names.map(name => ({ name, description: name, mcp: false }))
const route = (type: string, more: Record<string, unknown> = {}) => ({ target: 'acme/model-a', label: 'fast', type, prompt: 'Find the retry logic.', ...more })
const sent = (w: ReturnType<typeof world>, i = 0) => w.requests[i]!.body['messages'] as { role: string; content: unknown }[]
const systemOf = (w: ReturnType<typeof world>, i = 0) => sent(w, i)[0]?.content as string
const offered = (w: ReturnType<typeof world>, i = 0) => ((w.requests[i]!.body['tools'] as { function: { name: string } }[] | undefined) ?? []).map(t => t.function.name)
const notes = async ($: Engine, w: ReturnType<typeof world>) => {
  w.transcript.length = 0
  await klyth($)
  return w.transcript.filter(l => l.startsWith('  agents: '))
}
// The tail every routed subagent's prompt ends with, for a subagent in /w on darwin offered SubagentHandback.
const tail = (notesText: string, type: string) =>
  [
    notesText,
    '# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /w\n - Platform: darwin\n - Today\'s date: 2026-10-07',
    HANDBACK_GUIDANCE,
    `You are powered by model-a served by the acme provider, running as the ${type} subagent via the klyth alias fast.`,
  ].join('\n\n')
test('the main prompt names the routed model: env_info_model replaced, identity sections and the cutoff and model-family lines dropped, the rest as composed', () => {
  const sections = [
    { id: 'intro', text: 'You are an interactive agent. Assistant knowledge cutoff is June 2026 stays outside the environment.' },
    { id: 'fable_identity', text: 'This iteration of Claude is a fixture model.' },
    { id: 'env_info_simple', text: '# Environment\n - The most recent Claude models are the fixture family. Model IDs: x.\n - Claude Code is available as a CLI.' },
    { id: 'env_info_model', text: 'A model notice a prompt.section hook wrote.' },
    { id: 'env_info_static', text: 'You are powered by the model claude-fixture-1. Assistant knowledge cutoff is May 2026.' },
    { id: 'memory', text: 'MEMORY' },
  ]
  expect(rewriteMain(sections, 'You are powered by model-a served by the acme provider.')).toBe(
    [
      'You are an interactive agent. Assistant knowledge cutoff is June 2026 stays outside the environment.',
      '# Environment\n - Claude Code is available as a CLI.',
      'You are powered by model-a served by the acme provider.',
      'You are powered by model-a served by the acme provider.',
      'MEMORY',
    ].join('\n\n'),
  )
})

test("a routed main step's transcript names the routed model where the engine's model notice named its own; other messages are sent as they are", async ($, on) => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${ENGINE_IDENTITY}\n</system-reminder>` }, { type: 'text', text: 'Which model are you?' }] },
    { role: 'assistant', content: [{ type: 'text', text: ENGINE_IDENTITY }] },
    { role: 'user', content: 'You are powered by the model claude-fixture-1.' },
  ]
  const w = world(on, { messages })
  await start($)
  await model($, 'strong')
  await step($, { turnId: 't', index: 0 })
  const [first, reply, last] = sent(w).slice(1).map(m => JSON.stringify(m.content))
  expect(first).toContain('You are powered by model-b served by the acme provider.')
  expect(first).toContain('Which model are you?')
  expect(first).not.toContain('Opus')
  expect(reply).toContain(ENGINE_IDENTITY)
  expect(last).toBe(JSON.stringify('You are powered by model-b served by the acme provider.'))
  expect(systemOf(w)).toBe('SYSTEM PROMPT')
  const plain = [{ role: 'assistant' as const, content: ENGINE_IDENTITY }, { role: 'user' as const, content: 'hi' }]
  expect(withIdentity(plain, 'm', 'p')).toBe(plain)
})

test('a routed Explore is given the Glob and Grep guidance when it is offered both, and the Bash guidance when it is not', async ($, on) => {
  const withTools = world(on, { routes: { e1: route('Explore') }, tools: tools('Bash', 'Glob', 'Grep', 'Read') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'e1' })
  expect(systemOf(withTools)).toContain(SEARCH_WITH_TOOLS)
  expect(systemOf(withTools)).not.toContain(SEARCH_WITH_BASH)
  expect(offered(withTools)).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'SubagentHandback'])
})

test('a routed Explore offered no Glob and Grep, or only one of them, is given the Bash guidance', async ($, on) => {
  const w = world(on, { routes: { e1: route('Explore') }, tools: tools('Bash', 'Grep', 'Read') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'e1' })
  expect(systemOf(w)).toContain(SEARCH_WITH_BASH)
  expect(systemOf(w)).not.toContain(SEARCH_WITH_TOOLS)
  expect(systemOf(w).endsWith(tail(BUILTIN_NOTES, 'Explore'))).toBe(true)
})

test("a routed Plan has the critical-files section, the tool guidance, then the notes, its environment, the handback and who answers", async ($, on) => {
  const w = world(on, { routes: { p1: route('Plan') }, tools: tools('Bash', 'Glob', 'Grep', 'Read') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'p1' })
  expect(systemOf(w)).toMatch(/Critical Files for Implementation/)
  expect(systemOf(w)).toContain(SEARCH_WITH_TOOLS)
  expect(systemOf(w).endsWith(tail(BUILTIN_NOTES, 'Plan'))).toBe(true)
})

test('general-purpose, and a type no file names that is not built in, run on the general-purpose prompt with the notes', async ($, on) => {
  const w = world(on, { routes: { g1: route('general-purpose') }, tools: tools('Bash', 'Read') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'g1' })
  expect(systemOf(w)).toBe(`${GENERAL_PURPOSE_PROMPT}\n\n${tail(BUILTIN_NOTES, 'general-purpose')}`)
  expect(JSON.stringify(w.runs)).not.toContain('scripts/')
})

test('statusline-setup, claude-code-guide and web-fetch get the generic prompt, and /klyth says nothing about it', async ($, on) => {
  const w = world(on, {
    routes: { g1: route('claude-code-guide'), s1: route('statusline-setup'), f1: route('web-fetch') },
    tools: tools('Bash', 'Edit', 'Read', 'WebFetch'),
  })
  await start($)
  for (const [i, agentId] of ['g1', 's1', 'f1'].entries()) await step($, { turnId: `t${i}`, index: 0, agentId })
  for (const [i, type] of ['claude-code-guide', 'statusline-setup', 'web-fetch'].entries()) {
    expect(systemOf(w, i)).toBe(`${GENERIC_PROMPT}\n\n${tail(BUILTIN_NOTES, type)}`)
  }
  expect(await notes($, w)).toEqual([])
})

test("a routed claude subagent gets main's rewritten prompt, then the notes, its environment, the handback and who answers", async ($, on) => {
  const w = world(on, { routes: { k1: route('claude') }, tools: tools('AskUserQuestion', 'Bash', 'Read', 'TodoWrite', 'Write') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'k1' })
  expect(systemOf(w)).toBe(`SYSTEM PROMPT\n\n${tail(BUILTIN_NOTES, 'claude')}`)
  expect(offered(w)).toEqual(['Bash', 'Read', 'Write', 'SubagentHandback'])
  expect(w.composes.map(c => c.tools)).toEqual([['Bash', 'Read', 'Write', 'SubagentHandback']])
  expect(JSON.stringify(w.runs)).not.toContain('scripts/')
  expect(await notes($, w)).toEqual([])
  expect(w.transcript.some(l => l.endsWith('· prompt main'))).toBe(true)
})

const HANDBACK = HANDBACK_GUIDANCE

// Every conversation reads back the turn whose Agent call started the forks below, so each fork's history rebuilds.
const FORKED = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }, HANDBACK_REMINDER] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'fork-call', name: 'Agent', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fork-call', content: 'started' }, { type: 'text', text: 'go' }] },
]

test("a fork of a routed main is sent main's rewritten prompt alone; a fork of a subagent, the prompt that subagent is sent, told to end on its report instead of SubagentHandback", async ($, on) => {
  const scout = '---\nname: scout\ndescription: d\n---\nSCOUT BODY'
  const fork = (parent?: string) => route('fork', { forkOf: 'fork-call', ...(parent === undefined ? {} : { parent }) })
  const w = world(on, {
    files: { '/w/.claude/agents/scout.md': scout },
    routes: { p1: route('Explore'), f1: fork('p1'), c1: route('scout'), f2: fork('c1'), m1: fork(), f3: fork('f1') },
    tools: tools('Bash', 'Glob', 'Grep', 'Read'),
    messages: FORKED,
  })
  await start($)
  for (const [i, agentId] of ['p1', 'f1', 'c1', 'f2', 'm1', 'f3'].entries()) await step($, { turnId: `t${i}`, index: 0, agentId })
  const asFork = (parent: string) => parent.replace(`${HANDBACK}\n\n`, '')
  expect(systemOf(w, 0)).toContain(HANDBACK)
  expect(systemOf(w, 1)).toBe(asFork(systemOf(w, 0)))
  expect(systemOf(w, 1)).toContain(SEARCH_WITH_TOOLS)
  for (const n of [1, 3, 4, 5]) expect(systemOf(w, n)).not.toContain(FORK_REPORT)
  expect(systemOf(w, 3)).toBe(asFork(systemOf(w, 2)))
  expect(systemOf(w, 3)).toContain('SCOUT BODY')
  expect(systemOf(w, 4)).toBe('SYSTEM PROMPT')
  expect(systemOf(w, 5)).toBe(systemOf(w, 1))
  for (const n of [1, 3, 4, 5]) expect(systemOf(w, n)).not.toContain('SubagentHandback(')
  w.transcript.length = 0
  await klyth($)
  expect(w.transcript.filter(l => l.includes('prompt fork of ')).map(l => l.slice(l.indexOf('prompt ')))).toEqual(expect.arrayContaining(['prompt fork of main', 'prompt fork of klyth', 'prompt fork of custom']))
})

test("a fork whose parent's route cannot be read is not sent: its step hands back one line", async ($, on) => {
  const w = world(on, { routes: { f1: route('fork', { parent: 'ghost' }) }, tools: tools('Read') })
  await start($)
  await step($, { turnId: 't', index: 0, agentId: 'f1' })
  expect(w.requests).toEqual([])
  expect(w.toasts).toEqual(['klyth: the route of the parent of this fork cannot be read; the step was not sent; retry'])
})

// systemFor over a port whose composed main prompt holds environment sections that name the session's directory
// (/w) and the engine's own model, as `claude` is sent main's sections.
const COMPOSED = [
  { id: 'intro', text: 'INTRO' },
  { id: 'env_info_simple', text: '# Environment\n - Primary working directory: /w\n - Is a git repository: true\n - Claude Code is available as a CLI.' },
  { id: 'env_info_model', text: ENGINE_IDENTITY },
  { id: 'env_info_static', text: `${ENGINE_IDENTITY} Static facts.` },
  { id: 'memory', text: 'MEMORY' },
]
const composing = (sections = COMPOSED) => {
  const files: Record<string, string> = {}
  const io = {
    compose: async () => sections,
    cwd: async () => '/w',
    configDir: async () => `${HOME}/.claude`,
    exists: async (path: string) => Object.hasOwn(files, path),
    read: async (path: string) => files[path] as string,
    listDir: async () => [],
    run: async () => ({ exitCode: 0, stdout: 'Darwin\n', stderr: '' }),
    now: async () => Date.UTC(2026, 9, 7),
    debug: () => {},
  }
  return (r: ReturnType<typeof route>) => systemFor(io, createSession(), { route: r, engineModel: 'claude-opus-5-5', target: 'acme/model-a', model: 'model-a', provider: 'acme', tools: ['Read'] })
}
const IDENTITY = 'You are powered by model-a served by the acme provider.'
const cwdLines = (text: string) => text.split('\n').filter(l => l.includes('Primary working directory'))

test("a claude subagent in a worktree is told the worktree alone as its directory: main's environment sections are left out, the model notice is the routed identity", async () => {
  const worktree = { path: '/w/.claude/worktrees/agent-1', branch: 'klyth/agent-1', base: 'base0', root: '/w' }
  const { text, source } = await composing()(route('claude', { worktree }))
  expect(source).toBe('main')
  expect(cwdLines(text)).toEqual([' - Primary working directory: /w/.claude/worktrees/agent-1'])
  expect(text.startsWith(`INTRO\n\n${IDENTITY}\n\nMEMORY\n\n${BUILTIN_NOTES}\n\n# Environment\n`)).toBe(true)
  expect(text).not.toContain('Is a git repository')
  expect(text).not.toContain('Opus')
})

test("a claude subagent in the session's directory keeps main's environment sections, with the routed identity where they named the engine's model", async () => {
  const { text, source } = await composing()(route('claude'))
  expect(source).toBe('main')
  expect(cwdLines(text)).toEqual([' - Primary working directory: /w', ' - Primary working directory: /w'])
  expect(text.startsWith(`INTRO\n\n# Environment\n - Primary working directory: /w\n - Is a git repository: true\n - Claude Code is available as a CLI.\n\n${IDENTITY}\n\n${IDENTITY} Static facts.\n\nMEMORY\n\n${BUILTIN_NOTES}\n\n`)).toBe(true)
  expect(text).not.toContain('Opus')
})

test("a built-in type with one agent file that names it runs on the file's body, and /klyth names the file; two files, or none, leave it on klyth's prompt", async ($, on) => {
  const file = (body: string) => `---\nname: Explore\ndescription: d\n---\n${body}`
  const one = world(on, { files: { '/w/.claude/agents/x.md': file('EXPLORE FILE BODY'), '/w/.claude/agents/claude.md': '---\nname: claude\ndescription: d\n---\nCLAUDE FILE BODY' }, routes: { e1: route('Explore'), k1: route('claude') }, tools: tools('Bash', 'Glob', 'Grep', 'Read') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'e1' })
  await step($, { turnId: 'b', index: 0, agentId: 'k1' })
  expect(systemOf(one)).toBe(`EXPLORE FILE BODY\n\n${tail(BUILTIN_NOTES, 'Explore')}`)
  expect(systemOf(one, 1)).toBe(`CLAUDE FILE BODY\n\n${tail(BUILTIN_NOTES, 'claude')}`)
  expect(one.composes).toEqual([])
  expect(await notes($, one)).toEqual([
    '  agents: Explore runs on /w/.claude/agents/x.md, which overrides the built-in',
    '  agents: claude runs on /w/.claude/agents/claude.md, which overrides the built-in',
  ])
})

test("a built-in type that two agent files name is not read from either: it runs on klyth's prompt", async ($, on) => {
  const file = '---\nname: Explore\ndescription: d\n---\nEXPLORE FILE BODY'
  const w = world(on, { files: { '/w/.claude/agents/a.md': file, [`${HOME}/.claude/agents/b.md`]: file }, routes: { e1: route('Explore') }, tools: tools('Bash', 'Read') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'e1' })
  expect(systemOf(w)).not.toContain('EXPLORE FILE BODY')
  expect(systemOf(w)).toContain(SEARCH_WITH_BASH)
})

test('a custom agent type with no definition runs as general-purpose, its prompt and tools, and says so once in /klyth', async ($, on) => {
  const w = world(on, { routes: { c1: route('ghost') }, tools: tools('AskUserQuestion', 'Bash', 'ExitPlanMode', 'Read', 'TodoWrite') })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'c1' })
  await step($, { turnId: 'a', index: 1, agentId: 'c1' })
  expect(systemOf(w)).toBe(`${GENERAL_PURPOSE_PROMPT}\n\n${tail(BUILTIN_NOTES, 'ghost')}`)
  expect(offered(w)).toEqual(['Bash', 'Read', 'SubagentHandback'])
  expect(await notes($, w)).toEqual([
    '  agents: ghost has no readable definition (no definition found (no agent file in /w/.claude/agents or /home/u/.claude/agents has the name ghost)); it runs as general-purpose',
  ])
})

test("a custom agent's prompt is its definition's body, then the native notes, its worktree, the handback and who answers", async ($, on) => {
  const worktree = { path: '/w/.claude/worktrees/agent-1', branch: 'klyth/agent-1', base: 'base0', root: '/w' }
  const w = world(on, {
    files: { '/w/.claude/agents/scout.md': '---\nname: scout\ndescription: d\n---\nSCOUT BODY' },
    routes: { c1: route('scout', { worktree }) },
    tools: tools('Bash', 'Read'),
  })
  await start($)
  await step($, { turnId: 'a', index: 0, agentId: 'c1' })
  expect(systemOf(w)).toBe(`SCOUT BODY\n\n${tail(BUILTIN_NOTES, 'scout').replace('directory: /w\n', 'directory: /w/.claude/worktrees/agent-1\n')}`)
})

test('no subagent is offered a main-only tool; a built-in type that lists its tools gets those alone; Explore and Plan lose the editing tools', () => {
  const main = ['Agent', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Read', 'TaskCreate', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write']
  const keep = (type: string | undefined, def?: { prompt: string; tools?: string[] }) => main.filter(toolFilter(type, def))
  expect(keep('general-purpose')).toEqual(['Agent', 'Bash', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Write'])
  expect(keep('Explore')).toEqual(['Bash', 'Read', 'WebFetch', 'WebSearch'])
  expect(keep('statusline-setup')).toEqual(['Edit', 'Read'])
  expect(keep('claude-code-guide')).toEqual(['Bash', 'Read', 'WebFetch', 'WebSearch'])
  expect(keep('web-fetch')).toEqual(['WebFetch'])
  expect(keep('scout', { prompt: 'p' })).toEqual(keep('general-purpose'))
  expect(keep('scout', { prompt: 'p', tools: ['AskUserQuestion', 'Read'] })).toEqual(['Read'])
  expect(SUBAGENT_DENIED).toEqual(expect.arrayContaining(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TodoWrite']))
})
