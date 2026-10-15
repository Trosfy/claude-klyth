// Agent definition files (frontmatter and body), the plugin directory installed_plugins.json records, the
// tool filter a definition sets, and the system prompt a routed custom subagent gets.
import { expect, test } from 'claude-code/testing'

import { agentSystem, allowsTool, BUILTIN_AGENTS, builtinPrompt, dateOf, GENERAL_PURPOSE_PROMPT, GENERIC_PROMPT, HANDBACK_GUIDANCE, NOT_REPRODUCED, parseAgentFile, parseInstalled, pluginRoot, SEARCH_WITH_BASH, SEARCH_WITH_TOOLS } from '../hooks/agents'
import type { AgentDef } from '../hooks/agents'

const file = (...lines: string[]) => lines.join('\n')

test('an agent file: plain, double- and single-quoted scalars, both list styles, comma-separated tools, unknown keys, and the body', () => {
  const text = file(
    '---',
    'name: scout',
    'description: "Finds \\"things\\"\\nfast"',
    "model: 'claude-opus-5' # pinned",
    'effort: xhigh',
    'isolation: worktree',
    'color: green',
    'memory: project',
    '# a comment',
    '',
    'tools: Read, Grep, Bash(git:*), Agent(worker, researcher)',
    'disallowedTools:',
    '  - Write',
    '- "Edit"',
    '---',
    '',
    'Body line 1',
    '',
    'Body line 3',
    '',
  )
  expect(parseAgentFile(text)).toEqual({
    name: 'scout',
    description: 'Finds "things"\nfast',
    model: 'claude-opus-5',
    effort: 'xhigh',
    isolation: 'worktree',
    tools: ['Read', 'Grep', 'Bash', 'Agent'],
    disallowedTools: ['Write', 'Edit'],
    prompt: 'Body line 1\n\nBody line 3',
  })
  expect(parseAgentFile('﻿---\r\nname: a\r\ntools: [Read, "Grep", \'Glob\']\r\n---\r\nB\r\n')).toEqual({ name: 'a', tools: ['Read', 'Grep', 'Glob'], prompt: 'B' })
  expect(parseAgentFile(file('---', 'name: a', "description: 'it''s here'", 'tools: []', 'disallowedTools:', '---', 'B'))).toEqual({ name: 'a', description: "it's here", tools: [], prompt: 'B' })
})

test('a [list] item whose rule holds commas stays one tool, so Bash(git:*, npm:*) keeps Bash', () => {
  const def = parseAgentFile(file('---', 'name: a', 'tools: [Read, Bash(git:*, npm:*), "Agent(worker, researcher)"]', 'disallowedTools: [Write]', '---', 'B'))
  expect(def).toEqual({ name: 'a', tools: ['Read', 'Bash', 'Agent'], disallowedTools: ['Write'], prompt: 'B' })
  expect(['Read', 'Bash', 'Agent', 'Write'].map(t => allowsTool(def as AgentDef, t))).toEqual([true, true, true, false])
})

test('anything but text and lists in the frontmatter is a named error, never a throw', () => {
  const cases: [string, string][] = [
    [file('name: a', '---', 'B'), 'no frontmatter (the file must open with a --- line)'],
    [file('---', 'name: a', 'B'), 'the frontmatter has no closing --- line'],
    [file('---', 'description: |', '  two', '  lines', '---', 'B'), 'line 2: "|" is a YAML form klyth does not read (only text and lists are)'],
    [file('---', 'description: >-', '  folded', '---', 'B'), 'line 2: ">-" is a YAML form klyth does not read (only text and lists are)'],
    [file('---', 'mcpServers: {a: 1}', '---', 'B'), 'line 2: "{a: 1}" is a YAML form klyth does not read (only text and lists are)'],
    [file('---', 'model: &m opus', '---', 'B'), 'line 2: "&m opus" is a YAML form klyth does not read (only text and lists are)'],
    [file('---', 'tools: [Read, [Grep]]', '---', 'B'), 'line 2: "[Grep]" is a YAML form klyth does not read (only text and lists are)'],
    [file('---', 'tools: [Read, Grep', '---', 'B'), 'line 2: a [list] that does not close on its line'],
    [file('---', 'hooks:', '  PreToolUse: x', '---', 'B'), 'line 3: not a "key: value" line, a "- item" of a list, or a comment'],
    [file('---', 'name:a', '---', 'B'), 'line 2: not a "key: value" line, a "- item" of a list, or a comment'],
    [file('---', 'name: a', 'name: b', '---', 'B'), 'line 3: name is given twice'],
    [file('---', '- Read', '---', 'B'), 'line 2: a list item with no key above it'],
    [file('---', 'name: a', '- Read', '---', 'B'), 'line 3: a list item with no key above it'],
    [file('---', 'description: "open', '---', 'B'), 'line 2: a quoted value that does not close on its line, or has an escape JSON does not know'],
    [file('---', "description: 'open", '---', 'B'), 'line 2: a quoted value that does not close on its line, or has an escape JSON does not know'],
    [file('---', 'description: "bad \\q escape"', '---', 'B'), 'line 2: a quoted value that does not close on its line, or has an escape JSON does not know'],
    [file('---', 'name: [a, b]', '---', 'B'), 'name must be text, not a list'],
    [file('---', 'name: a', '---', '', '  '), 'the body (the system prompt) is empty'],
  ]
  for (const [text, error] of cases) expect(parseAgentFile(text), text).toEqual({ error })
})

test('a definition allows the tools it lists (all when it lists none, or "*"), less those it withholds', () => {
  const def = (d: Partial<AgentDef>): AgentDef => ({ prompt: 'p', ...d })
  expect(['Read', 'Bash'].map(t => allowsTool(def({}), t))).toEqual([true, true])
  expect(['Read', 'Bash'].map(t => allowsTool(def({ tools: ['Read'] }), t))).toEqual([true, false])
  expect(['Read', 'Bash'].map(t => allowsTool(def({ tools: ['*'], disallowedTools: ['Bash'] }), t))).toEqual([true, false])
  expect(['Read', 'Bash'].map(t => allowsTool(def({ disallowedTools: ['Read'] }), t))).toEqual([false, true])
  expect(allowsTool(def({ tools: [] }), 'Read')).toBe(false)
})

const INSTALLS = {
  'acme-agents@acme-agents': [
    { scope: 'project', installPath: '/p/project/', projectPath: '/w' },
    { scope: 'user', installPath: '/p/user' },
  ],
  'acme-agents-extra@x': [{ scope: 'user', installPath: '/p/extra' }],
  'twice@one': [{ scope: 'user', installPath: '/p/one' }],
  'twice@two': [{ scope: 'user', installPath: '/p/two' }],
  'elsewhere@m': [{ scope: 'project', installPath: '/p/else', projectPath: '/other' }],
  'relative@m': [{ scope: 'user', installPath: 'cache/rel' }],
}

test('a plugin directory is the install installed_plugins.json records: this project\'s first, else one for every project', () => {
  const parsed = parseInstalled(JSON.stringify({ version: 2, plugins: INSTALLS }))
  if ('error' in parsed) throw new Error(parsed.error)
  const { plugins } = parsed
  expect(pluginRoot(plugins, 'acme-agents', '/w')).toEqual({ root: '/p/project' })
  expect(pluginRoot(plugins, 'acme-agents', '/elsewhere')).toEqual({ root: '/p/user' })
  expect(pluginRoot(plugins, 'acme-agents-extra', '/w')).toEqual({ root: '/p/extra' })
  expect(pluginRoot(plugins, 'twice', '/w')).toEqual({ error: 'plugin twice is installed from more than one marketplace (twice@one, twice@two)' })
  expect(pluginRoot(plugins, 'elsewhere', '/w')).toEqual({ error: 'plugin elsewhere@m has no install for /w' })
  expect(pluginRoot(plugins, 'relative', '/w')).toEqual({ error: 'plugin relative@m has no install for /w' })
  expect(pluginRoot(plugins, 'agent', '/w')).toEqual({ error: 'plugin agent is not installed' })
  expect(parseInstalled('{')).toMatchObject({ error: expect.stringContaining('not JSON') })
  expect(parseInstalled('{"version":2}')).toEqual({ error: 'no plugins object' })
  expect(parseInstalled('{"plugins":{"a@b":{}}}')).toEqual({ error: 'plugins.a@b is not a list of installs' })
})

test("a project's install covers a session in a directory beneath the project, not one in a sibling sharing its prefix", () => {
  const parsed = parseInstalled(JSON.stringify({ version: 2, plugins: INSTALLS }))
  if ('error' in parsed) throw new Error(parsed.error)
  expect(pluginRoot(parsed.plugins, 'acme-agents', '/w/hooks/deep')).toEqual({ root: '/p/project' })
  expect(pluginRoot(parsed.plugins, 'acme-agents', '/wx')).toEqual({ root: '/p/user' })
  expect(pluginRoot(parsed.plugins, 'elsewhere', '/other/sub')).toEqual({ root: '/p/else' })
  expect(pluginRoot(parsed.plugins, 'elsewhere', '/otherwise')).toEqual({ error: 'plugin elsewhere@m has no install for /otherwise' })
})

test("of several installs that cover the session's directory, the one with the longest projectPath is the plugin's root, wherever it is listed", () => {
  const outer = { scope: 'project', installPath: '/p/outer', projectPath: '/w' }
  const inner = { scope: 'project', installPath: '/p/inner', projectPath: '/w/hooks' }
  const everywhere = { scope: 'user', installPath: '/p/everywhere' }
  const plugins = { 'outer-first@m': [outer, inner, everywhere], 'inner-first@m': [inner, everywhere, outer] }
  for (const plugin of ['outer-first', 'inner-first']) {
    expect(pluginRoot(plugins, plugin, '/w/hooks'), plugin).toEqual({ root: '/p/inner' })
    expect(pluginRoot(plugins, plugin, '/w/hooks/deep'), plugin).toEqual({ root: '/p/inner' })
    expect(pluginRoot(plugins, plugin, '/w/tests'), plugin).toEqual({ root: '/p/outer' })
    expect(pluginRoot(plugins, plugin, '/w/hooks-extra'), plugin).toEqual({ root: '/p/outer' })
    expect(pluginRoot(plugins, plugin, '/elsewhere'), plugin).toEqual({ root: '/p/everywhere' })
  }
})

test('the system prompt is the body, the notes, the environment, the handback when offered, and one line naming the model, provider, type and alias', () => {
  const at = { cwd: '/w/.claude/worktrees/agent-1', date: '2026-10-07', model: 'model-a', provider: 'acme', type: 'scout', notes: 'NOTES', handback: true }
  expect(agentSystem('BODY', { ...at, platform: 'linux', alias: 'fast' })).toBe(
    file(
      'BODY',
      '',
      'NOTES',
      '',
      '# Environment',
      'You have been invoked in the following environment:',
      ' - Primary working directory: /w/.claude/worktrees/agent-1',
      ' - Platform: linux',
      " - Today's date: 2026-10-07",
      '',
      HANDBACK_GUIDANCE,
      '',
      'You are powered by model-a served by the acme provider, running as the scout subagent via the klyth alias fast.',
    ),
  )
  const bare = agentSystem('BODY', { ...at, handback: false })
  expect(bare).not.toContain('Platform:')
  expect(bare).not.toContain('SubagentHandback')
  expect(bare.split('\n').at(-1)).toBe('You are powered by model-a served by the acme provider, running as the scout subagent via klyth.')
})

test('dates are local YYYY-MM-DD, and the built-in agent types are the engine\'s own', () => {
  expect(dateOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
  expect([...BUILTIN_AGENTS].sort()).toEqual(['Explore', 'Plan', 'claude', 'claude-code-guide', 'comment-thread-analyst', 'fork', 'general-purpose', 'statusline-setup', 'web-fetch'])
})

test('builtinPrompt gives Explore and Plan the Glob and Grep guidance only when both are offered, else the Bash guidance', () => {
  for (const type of ['Explore', 'Plan']) {
    const both = builtinPrompt(type, new Set(['Bash', 'Glob', 'Grep', 'Read']))
    expect(both).toContain(SEARCH_WITH_TOOLS)
    expect(both).not.toContain(SEARCH_WITH_BASH)
    for (const offered of [['Bash', 'Read'], ['Bash', 'Grep', 'Read'], ['Glob', 'Read']]) {
      const prompt = builtinPrompt(type, new Set(offered))
      expect(prompt, `${type} ${offered}`).toContain(SEARCH_WITH_BASH)
      expect(prompt).not.toContain(SEARCH_WITH_TOOLS)
    }
  }
})

test('builtinPrompt: Plan has the critical-files heading, general-purpose its prompt, and any other type the generic one', () => {
  expect(builtinPrompt('Plan', new Set())).toMatch(/Critical Files for Implementation/)
  expect(builtinPrompt('Explore', new Set())).not.toMatch(/Critical Files for Implementation/)
  expect(builtinPrompt('general-purpose', new Set(['Glob', 'Grep']))).toBe(GENERAL_PURPOSE_PROMPT)
  for (const type of ['statusline-setup', 'claude-code-guide', 'web-fetch', 'anything-else']) expect(builtinPrompt(type, new Set())).toBe(GENERIC_PROMPT)
})

test('NOT_REPRODUCED names the types klyth cannot run, all of them built in', () => {
  expect([...NOT_REPRODUCED].sort()).toEqual(['comment-thread-analyst'])
  for (const type of NOT_REPRODUCED) expect(BUILTIN_AGENTS).toContain(type)
})
