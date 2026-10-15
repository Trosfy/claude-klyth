// The quiet UI (U13): nothing toasted when healthy, the status line one short segment while routed, every
// failure one line with its fix, and the details on demand in /klyth.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { statsLine, statusText } from '../hooks/ui'
import { EXAMPLE_CONFIG, SSE } from './fixtures/data.gen'
import { denied } from './fixtures/denied'
import type { WorldOptions } from './world'
import { CONFIG, CONFIG_OBJECT, HELPER, LOCAL_CONFIG, model, ORIGIN, start, step, klyth, world } from './world'
import type { Git } from './world'

const EXAMPLE_HELPER = JSON.stringify(['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'openai', '-w'])
const EXAMPLE_TRUSTED = { [`trust:openai|https://api.openai.com|cmd:${EXAMPLE_HELPER}`]: true }
const PIN = (turnId: string, target = 'acme/model-b') => ({ turnId, target })
// The acme provider with auth "none", and the approval of that fingerprint.
const NONE_CONFIG = JSON.stringify({ ...CONFIG_OBJECT, providers: { acme: { ...CONFIG_OBJECT.providers.acme, auth: 'none' } } })
const NONE_TRUSTED = { [`trust:openai|${ORIGIN}|none`]: true }
const FAST = { target: 'acme/model-a', label: 'fast' }
const FORBIDDEN = { status: 403, pieces: ['{"error":{"message":"Access denied for this route"}}\n'] }
const FORBIDDEN_TEXT = 'klyth: acme HTTP 403: Access denied for this route; ask the acme admin for access, or store another key with klyth auth login api-key acme'
const call = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__klyth__agent', model: 'fast', prompt: 'list the files', description: 'List files', subagent_type: 'Explore', ...input })
const deny = async ($: Engine, input: Record<string, unknown>) => ((await call($, input)) as { deny?: string }).deny

const config = (text: string) => parseConfig(text).config as Config

test('the status text is the alias then the provider, the target then the provider when no alias names it, and nothing when native', () => {
  expect(statusText(config(EXAMPLE_CONFIG), 'openai/gpt-5')).toBe('gpt · openai')
  expect(statusText(config(LOCAL_CONFIG), 'local/model-v1')).toBe('model.v1-mini · local')
  expect(statusText(config(CONFIG), 'acme/model-a')).toBe('fast · acme')
  // A route made with an alias shows the same; with no config to resolve the alias there is no provider to show.
  expect(statusText(config(CONFIG), 'fast')).toBe('fast · acme')
  expect(statusText(config(CONFIG), 'strong')).toBe('strong · acme')
  expect(statusText(undefined, 'fast')).toBe('fast')
  expect(statusText(config(CONFIG), 'acme/small')).toBe('acme/small · acme')
  expect(statusText(undefined, 'acme/small')).toBe('acme/small · acme')
  expect(statusText(config(CONFIG), null)).toBeUndefined()
  expect(statusText(config(CONFIG), undefined)).toBeUndefined()
})

test('a step reads as time to the first byte, total time, tokens in and out, and how it ended', () => {
  expect(statsLine({ ttfbMs: 1234, totalMs: 4500, reqBytes: 10, in: 95, out: 14, finish: 'stop' })).toBe('ttfb 1.2 s · total 4.5 s · in 95 · out 14 · stop')
  expect(statsLine({ ttfbMs: 40, totalMs: 999, reqBytes: 10, in: 1, out: 2, finish: 'tool_calls' })).toBe('ttfb 40 ms · total 999 ms · in 1 · out 2 · tool_calls')
  expect(statsLine({ ttfbMs: null, totalMs: 3, reqBytes: 0, in: null, out: null, finish: 'error' })).toBe('ttfb – · total 3 ms · in – · out – · error')
})

for (const [what, o] of [['a config', {}], ['the example config', { config: EXAMPLE_CONFIG, store: EXAMPLE_TRUSTED }], ['no config', { config: null }]] as const) {
  test(`a healthy session.start with ${what} makes no toast and no status`, async ($, on) => {
    const w = world(on, o)
    await start($)
    expect(w.toasts).toEqual([])
    expect(w.statuses.at(-1)).toBeUndefined()
  })
}

test('/model <alias> makes no toast and prints one line, and the status is exactly <alias> · <provider> while routed, undefined when native', async ($, on) => {
  const w = world(on, { config: EXAMPLE_CONFIG, store: EXAMPLE_TRUSTED, usageTokens: 84_000 })
  await start($)
  const set = await model($, 'gpt')
  expect(set).toEqual({ text: 'Set model to gpt (openai/gpt-5)' })
  expect(set.text?.split('\n')).toHaveLength(1)
  expect(w.toasts).toEqual([])
  expect(w.statuses.at(-1)).toBe('gpt · openai')
  await model($, 'opus')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.toasts).toEqual([])
})

test('with no alias naming the target the status is <provider>/<model> · <provider>', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'acme/small')
  expect(w.statuses.at(-1)).toBe('acme/small · acme')
})

test('a failed main step shows its text as the answer and makes no toast; a failed subagent step toasts it once', async ($, on) => {
  const w = world(on, { pin: PIN('m'), routes: { sub1: FAST }, upstream: () => FORBIDDEN })
  await start($)
  const main = await step($, { turnId: 'm', index: 0 })
  expect(main.result.answer).toBe(FORBIDDEN_TEXT)
  expect(w.toasts).toEqual([])
  await step($, { turnId: 's', index: 0, agentId: 'sub1' })
  expect(w.toasts).toEqual([FORBIDDEN_TEXT])
})

test('a refused main step makes no toast; a refused subagent step toasts its line', async ($, on) => {
  const w = world(on, { pin: PIN('m'), routes: { sub1: FAST }, store: {} })
  await start($)
  await step($, { turnId: 'm', index: 0 })
  expect(w.toasts).toEqual([])
  await step($, { turnId: 's', index: 0, agentId: 'sub1' })
  expect(w.toasts).toEqual(['klyth: provider acme is not approved; run /model fast to approve it. The step was not sent'])
})

test('/klyth shows providers with kind, key state and approval, the aliases, and the last routed step per conversation', async ($, on) => {
  const w = world(on, { routes: { sub1: FAST } })
  await start($)
  await model($, 'strong')
  await klyth($)
  expect(w.transcript.some(l => l.startsWith('  last step'))).toBe(false)
  w.transcript.length = 0
  await step($, { turnId: 'm', index: 0 })
  await step($, { turnId: 's', index: 0, agentId: 'sub1' })
  await step($, { turnId: 'm', index: 1 })
  await klyth($)
  expect(w.transcript.slice(0, 7)).toEqual([
    'klyth · main: strong → acme/model-b',
    '  PROVIDER  KIND    ORIGIN                 KEY         APPROVED',
    '  acme      openai  https://klyth.invalid  cmd cached  yes',
    '  ALIAS   TARGET        EFFORT           NOTE',
    '  fast    acme/model-a  low medium high  cheap, fast explorer for read-only sweeps',
    '  strong  acme/model-b  low medium high  strong generalist',
    '  routed subagents: sub1 → fast',
  ])
  const last = w.transcript.filter(l => l.startsWith('  last step'))
  expect(last).toHaveLength(2)
  expect(last[0]).toMatch(/^ {2}last step sub1 → fast: ttfb \d+ ms · total \d+ ms · in 95 · out 14 · stop · prompt klyth$/)
  expect(last[1]).toMatch(/^ {2}last step main → strong: ttfb \d+ ms · total \d+ ms · in 95 · out 14 · stop · prompt main$/)
})

test('/klyth shows none in the KEY column of a keyless provider, before and after a step, and runs no helper', async ($, on) => {
  const w = world(on, { config: NONE_CONFIG, store: NONE_TRUSTED })
  await start($)
  await model($, 'strong')
  await klyth($)
  expect(w.transcript.slice(0, 3)).toEqual(['klyth · main: strong → acme/model-b', '  PROVIDER  KIND    ORIGIN                 KEY   APPROVED', '  acme      openai  https://klyth.invalid  none  yes'])
  w.transcript.length = 0
  await step($, { turnId: 'm', index: 0 })
  await klyth($)
  expect(w.transcript[2]).toBe('  acme      openai  https://klyth.invalid  none  yes')
  expect(w.runs.filter(argv => argv[0] === HELPER[0])).toEqual([])
})

test('/klyth shows none for a keyless provider even when klythd is not running to say so', async ($, on) => {
  const w = world(on, { config: NONE_CONFIG, store: NONE_TRUSTED, klythd: 'exits' })
  await start($)
  await klyth($)
  expect(w.transcript[2]).toBe('  acme      openai  https://klyth.invalid  none  yes')
})

test('/klyth shows the classifier only when klyth.json turns it on: its model, context and tools, then the actions it allowed, did not allow and was not asked about', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const reply = (body: string) => (body.includes('/w/a') ? 'classifier-allow.sse' : 'classifier-ask.sse')
  const upstream = (r: { body: Record<string, unknown> }) => (JSON.stringify(r.body).includes("klyth's permission classifier") ? { pieces: [SSE[reply(JSON.stringify(r.body))] as string] } : undefined)
  const w = world(on, { config: JSON.stringify({ ...CONFIG_OBJECT, classifier: { model: 'fast' } }), pin: PIN('t'), upstream })
  await start($)
  await klyth($)
  expect(w.transcript).toContain('  classifier: fast · fresh context · bounded tools · 0 allowed · 0 asked · 0 not classified')
  await step($, { turnId: 't', index: 0 })
  const refuse = async (input: Record<string, unknown>, id: string, tool = 'Edit') => {
    await $.tool.check({ tool, input, tool_use_id: id } as never)
    return $.classic.PermissionDenied(denied(tool, input, id) as never)
  }
  expect(await refuse({ file_path: '/w/a.md', old_string: 'a', new_string: 'b' }, 'toolu_klyth_1')).toEqual({ retry: true })
  expect(await refuse({ file_path: '/w/a2.md', old_string: 'a', new_string: 'b' }, 'toolu_klyth_4')).toEqual({ retry: true })
  expect(await refuse({ file_path: '/w/b.md', old_string: 'a', new_string: 'b' }, 'toolu_klyth_2')).toEqual({})
  expect(await refuse({ command: 'ls' }, 'toolu_klyth_3', 'Bash')).toEqual({})
  w.transcript.length = 0
  await klyth($)
  const at = w.transcript.indexOf('  classifier: fast · fresh context · bounded tools · 2 allowed · 1 asked · 1 not classified · last ineligible (Bash: Bash is not classified; allow it with a /permissions rule or switch modes (Shift+Tab))')
  expect(w.transcript[at + 1]).toBe('  worktree cleanup: to the Trash (/opt/bin/trash)')
})

test('/klyth shows no classifier line when klyth.json has no classifier key', async ($, on) => {
  const w = world(on)
  await start($)
  await klyth($)
  expect(w.transcript.filter(l => l.startsWith('  classifier'))).toEqual([])
})

test('/klyth reports a step that failed before it was sent: no first byte, no tokens, finish error', async ($, on) => {
  const w = world(on, { keyFails: true })
  await start($)
  await model($, 'strong')
  await step($, { turnId: 'k', index: 0 })
  await klyth($)
  expect(w.transcript.find(l => l.startsWith('  last step'))).toMatch(/^ {2}last step main → strong: ttfb – · total \d+ ms · in – · out – · error · prompt main$/)
})

// Every user-visible failure of klyth's own, as the person reads it: one line, naming what failed and the fix.
// `act` raises it and answers the text; `fix` is the part of the line that says what to do.
// A `command` row is a /model result: the engine shows it under the mod's name, so the text has no "klyth: " of its own.
type Row = {
  name: string
  opts?: WorldOptions
  act: ($: Engine, w: ReturnType<typeof world>) => Promise<string | undefined>
  text: string | RegExp
  fix: string
  command?: true
}
const brokenConfig = JSON.stringify({ ...CONFIG_OBJECT, aliases: { strong: 'acme9/model-b' } })
const answer = async ($: Engine, e: Parameters<typeof step>[1]) => (await step($, e)).result.answer
const handedBack = async ($: Engine, e: Parameters<typeof step>[1]) => ((await step($, e)).result.toolUses[0]?.input as { message: string }).message
const big = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(500_000) }] }]
const dirty = (a: readonly string[]): Git | undefined => (a.includes('--porcelain') ? { exitCode: 0, stdout: ' M retry.ts\n', stderr: '' } : undefined)
const WT = { path: '/w/.claude/worktrees/agent-1234abcd', branch: 'worktree-agent-1234abcd', base: 'base0', root: '/w' }
const noGit = (flag: string) => (a: readonly string[]): Git | undefined => (a.includes(flag) ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : undefined)

const FAILURES: Row[] = [
  {
    name: 'a config error at session start',
    opts: { config: brokenConfig },
    act: async (_, w) => w.toasts[0],
    text: 'klyth: routing off, config error: aliases.strong → provider "acme9" is not declared (declared: acme). Fix ~/.claude/klyth.json, then run /klyth reload',
    fix: 'run /klyth reload',
  },
  {
    name: '/model while the config is broken',
    opts: { config: brokenConfig },
    act: async $ => (await model($, 'strong')).text,
    text: 'can\'t switch to strong: config error, aliases.strong → provider "acme9" is not declared (declared: acme). Native model unchanged; fix ~/.claude/klyth.json, then run /klyth reload',
    fix: 'fix ~/.claude/klyth.json, then run /klyth reload',
    command: true,
  },
  {
    name: '/model with an undeclared model',
    act: async $ => (await model($, 'acme/gpt-6')).text,
    text: '"gpt-6" is not declared under provider acme (declared: model-a, model-b, small)',
    fix: '(declared: model-a, model-b, small)',
    command: true,
  },
  {
    name: '/model with a provider not approved',
    opts: { store: {}, answer: 'Keep native' },
    act: async $ => (await model($, 'strong')).text,
    text: 'provider acme not approved; native model unchanged. Run /model strong again and choose Allow',
    fix: 'Run /model strong again and choose Allow',
    command: true,
  },
  {
    name: '/model failing inside klyth',
    opts: { store: 'fails' },
    act: async $ => (await model($, 'strong')).text,
    text: "couldn't switch to strong (internal error; see the debug log). Native model unchanged",
    fix: 'see the debug log',
    command: true,
  },
  {
    name: 'a step whose target is no longer configured',
    opts: { pin: PIN('g', 'acme/gone') },
    act: $ => answer($, { turnId: 'g', index: 0 }),
    text: 'klyth: acme/gone is not available (no longer configured); the step was not sent. Fix ~/.claude/klyth.json, run /klyth reload, or pick another model',
    fix: 'run /klyth reload',
  },
  {
    name: 'a step whose provider is not approved',
    opts: { pin: PIN('u'), store: {} },
    act: $ => answer($, { turnId: 'u', index: 0 }),
    text: 'klyth: provider acme is not approved; run /model strong to approve it. The step was not sent',
    fix: 'run /model strong to approve it',
  },
  {
    name: 'a step whose transcript cannot be read',
    opts: { pin: PIN('r'), messages: { deny: 'no saved transcript' } },
    act: $ => answer($, { turnId: 'r', index: 0 }),
    text: 'klyth: the transcript of main is unreadable (no saved transcript); the step was not sent; retry',
    fix: 'retry',
  },
  {
    name: 'a step past the input budget',
    opts: { pin: PIN('b', 'acme/small'), messages: big },
    act: $ => answer($, { turnId: 'b', index: 0 }),
    text: /^klyth: context ~\d+k exceeds acme\/small's 95% safety threshold \(114k\) of its 120k configured input budget; run \/klyth compact between turns$/,
    fix: 'run /klyth compact',
  },
  {
    name: 'a step whose tool schemas fill the budget',
    opts: {
      pin: PIN('t', 'acme/small'),
      tools: [{ name: 'mcp__big__t', description: 'big', mcp: true }],
      mcpTools: [{ name: 'mcp__big__t', isLoaded: true }],
      mcpFile: JSON.stringify({ mcp__big__t: { type: 'object', description: 'y'.repeat(450_000) } }),
    },
    act: $ => answer($, { turnId: 't', index: 0 }),
    text: /^klyth: tool schemas alone take ~\d+k of acme\/small's 120k input budget; set "tools": false on the model or use a larger one$/,
    fix: 'set "tools": false on the model',
  },
  {
    name: 'a step failing inside klyth',
    opts: { pin: PIN('i'), compose: 'throws' },
    act: $ => answer($, { turnId: 'i', index: 0 }),
    text: 'klyth: internal error on acme/model-b; the step was not sent to another model (see the debug log)',
    fix: 'see the debug log',
  },
  {
    name: 'a subagent step failing inside klyth, handed back',
    opts: {
      routes: { sub1: FAST },
      messages: () => {
        throw new Error('transcript unavailable')
      },
    },
    act: $ => handedBack($, { turnId: 'i', index: 0, agentId: 'sub1' }),
    text: 'klyth: internal error on acme/model-a; the step was not sent to another model (see the debug log)',
    fix: 'see the debug log',
  },
  {
    name: 'a key helper that fails',
    opts: { pin: PIN('k'), keyFails: true },
    act: $ => answer($, { turnId: 'k', index: 0 }),
    text: 'klyth: acme key helper failed (exit 1): keychain locked, or no key stored? Run klyth auth login api-key acme',
    fix: 'Run klyth auth login api-key acme',
  },
  {
    name: 'a key helper that cannot run',
    opts: {
      pin: PIN('k'),
      run: argv => {
        if (argv[0] === HELPER[0]) throw new Error('spawn failed')
        return undefined
      },
    },
    act: $ => answer($, { turnId: 'k', index: 0 }),
    text: /^klyth: acme key helper did not finish \(.+\); unlock the keychain or fix auth\.command, then retry$/,
    fix: 'unlock the keychain or fix auth.command, then retry',
  },
  {
    name: 'a rejected key',
    opts: { pin: PIN('x'), upstream: () => ({ status: 401, pieces: ['{"error":{"message":"bad key"}}\n'] }) },
    act: $ => answer($, { turnId: 'x', index: 0 }),
    text: 'klyth: acme rejected its key (HTTP 401). Store a valid one with klyth auth login api-key acme, then retry',
    fix: 'klyth auth login api-key acme, then retry',
  },
  {
    name: 'a keyless provider that wants a key',
    opts: { pin: PIN('n'), config: NONE_CONFIG, store: NONE_TRUSTED, upstream: () => ({ status: 401, pieces: ['{"error":{"message":"missing key"}}\n'] }) },
    act: $ => answer($, { turnId: 'n', index: 0 }),
    text: 'klyth: acme wants a key (HTTP 401) but auth is "none". Run klyth auth login api-key acme and set auth.command, then retry',
    fix: 'Run klyth auth login api-key acme and set auth.command, then retry',
  },
  {
    name: 'a stalled response',
    opts: { pin: PIN('s'), upstream: () => ({ cut: 'stall' }) },
    act: $ => answer($, { turnId: 's', index: 0 }),
    text: 'klyth: acme stalled (no data for 600 s); retry',
    fix: 'retry',
  },
  {
    name: 'a provider that cannot be reached',
    opts: { pin: PIN('c'), upstream: () => ({ refused: 'connect' }) },
    act: $ => answer($, { turnId: 'c', index: 0 }),
    text: 'klyth: acme could not connect (klyth.invalid:443 ECONNREFUSED) after 10 attempts; check the network or VPN, then retry',
    fix: 'check the network or VPN, then retry',
  },
  {
    name: 'a provider failing with a server error',
    opts: { pin: PIN('f'), upstream: () => ({ status: 502, pieces: ['{"error":{"message":"bad gateway"}}'] }) },
    act: $ => answer($, { turnId: 'f', index: 0 }),
    text: 'klyth: acme HTTP 502: bad gateway; the provider failed after 10 attempts: retry, or pick another model',
    fix: 'retry, or pick another model',
  },
  {
    name: 'a step with no bun to start klythd',
    opts: { pin: PIN('n'), bun: null },
    act: $ => answer($, { turnId: 'n', index: 0 }),
    text: 'klyth: bun not found — install bun (https://bun.sh), then retry',
    fix: 'install bun (https://bun.sh), then retry',
  },
  {
    name: 'a step whose klythd exits before it is ready',
    opts: { pin: PIN('d'), klythd: 'exits' },
    act: $ => answer($, { turnId: 'd', index: 0 }),
    text: 'klyth: klythd did not start (see the debug log); run /klyth reload, then retry',
    fix: 'run /klyth reload, then retry',
  },
  {
    name: 'a step after klythd crashed twice',
    opts: { pin: PIN('p'), klythd: 'exits' },
    act: async $ => {
      for (const index of [0, 1]) await answer($, { turnId: 'p', index })
      return answer($, { turnId: 'p', index: 2 })
    },
    text: 'klyth: klythd crashed twice; routed models paused until /klyth reload',
    fix: 'paused until /klyth reload',
  },
  {
    name: 'an agent call with an unsupported parameter',
    act: $ => deny($, { team_name: 't' }),
    text: 'klyth agent: unsupported parameter(s) team_name; use Agent for them',
    fix: 'use Agent for them',
  },
  {
    name: 'an agent call naming an unknown model',
    act: $ => deny($, { model: 'zeus' }),
    text: 'klyth agent: unknown model "zeus"; valid: acme/model-a, acme/model-b, acme/small, fable, fast, haiku, opus, sonnet, strong',
    fix: 'valid: acme/model-a',
  },
  {
    name: 'an agent call with invalid input',
    act: $ => deny($, { effort: 'extreme' }),
    text: 'klyth agent: invalid input: prompt and description must be text, subagent_type and name text when given, effort one of low, medium, high, xhigh, max, run_in_background true or false',
    fix: 'run_in_background true or false',
  },
  {
    name: 'an agent call for a fork',
    act: $ => deny($, { subagent_type: 'fork' }),
    text: "klyth agent: a fork runs on its parent's model, and this conversation is native; to fork natively use Agent",
    fix: 'to fork natively use Agent',
  },
  {
    name: 'an agent call setting effort on a native model',
    act: $ => deny($, { model: 'haiku', effort: 'high' }),
    text: 'klyth agent: effort cannot be set for a native model through klyth; omit effort, or use Agent',
    fix: 'omit effort, or use Agent',
  },
  {
    name: 'an agent call with another isolation',
    act: $ => deny($, { isolation: 'remote' }),
    text: 'klyth agent: isolation "remote" is not available through klyth; omit it or use "worktree"',
    fix: 'omit it or use "worktree"',
  },
  {
    name: 'an agent call made in a native subagent',
    act: $ => deny($, { agentId: 'sub-x' }),
    text: 'klyth agent: not available from a native subagent or from inside a spawn; use Agent here',
    fix: 'use Agent here',
  },
  {
    name: 'an agent call made in a subagent for a provider not approved',
    opts: { store: {} },
    act: $ => deny($, { agentId: 'sub-x' }),
    text: 'klyth agent: provider acme is not approved; run /model fast once and choose Allow',
    fix: 'run /model fast once and choose Allow',
  },
  {
    name: 'an agent call while the config is broken',
    opts: { config: brokenConfig },
    act: $ => deny($, {}),
    text: 'klyth agent: unavailable (config error: aliases.strong → provider "acme9" is not declared (declared: acme)); use Agent',
    fix: 'use Agent',
  },
  {
    name: 'an agent call for a provider not approved',
    opts: { store: {}, answer: 'Keep native' },
    act: $ => deny($, {}),
    text: 'klyth agent: provider acme is not approved; use Agent for a native model',
    fix: 'use Agent for a native model',
  },
  {
    name: 'an agent call whose subagent did not start',
    act: $ => deny($, {}),
    text: 'klyth agent: the subagent did not start; retry, or use Agent',
    fix: 'retry, or use Agent',
  },
  {
    name: 'an agent call failing inside klyth',
    opts: { spawn: 'unanswered' },
    act: $ => deny($, {}),
    text: 'klyth agent: internal error (see the debug log); use Agent',
    fix: 'use Agent',
  },
  {
    name: 'worktree isolation outside a git work tree',
    opts: { cwd: '/tmp/plain', git: noGit('--show-toplevel') },
    act: $ => deny($, { isolation: 'worktree' }),
    text: 'klyth agent: isolation "worktree" needs a git work tree, and /tmp/plain is not inside one; omit isolation',
    fix: 'omit isolation',
  },
  {
    name: 'worktree isolation in a repository with no commit',
    opts: { git: noGit('--verify') },
    act: $ => deny($, { isolation: 'worktree' }),
    text: 'klyth agent: isolation "worktree" needs a commit to start from, and /w has none; make a commit or omit isolation',
    fix: 'make a commit or omit isolation',
  },
  {
    name: 'a worktree git cannot add',
    opts: { git: a => (a.includes('add') ? { exitCode: 128, stdout: '', stderr: "fatal: a branch named 'x' already exists\n" } : undefined) },
    act: $ => deny($, { isolation: 'worktree' }),
    text: "klyth agent: git worktree add failed: fatal: a branch named 'x' already exists; fix the repository or omit isolation",
    fix: 'fix the repository or omit isolation',
  },
  {
    name: 'a worktree kept with changes in it',
    opts: { routes: { dirty: { target: 'acme/model-a', label: 'fast', worktree: WT } }, git: dirty },
    act: async ($, w) => {
      await $.turn.complete({ answer: 'report', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', agentId: 'dirty' })
      return w.toasts[0]
    },
    text: `klyth: kept worktree ${WT.path} (branch ${WT.branch}) of subagent dirty: it has changes; merge ${WT.branch} or remove the worktree`,
    fix: `merge ${WT.branch} or remove the worktree`,
  },
]

for (const row of FAILURES) {
  test(`failure: ${row.name} is one line with its fix`, async ($, on) => {
    const w = world(on, row.opts)
    await start($)
    const text = await row.act($, w)
    if (typeof row.text === 'string') expect(text).toBe(row.text)
    else expect(text).toMatch(row.text)
    expect(text).toMatch(row.command ? /^(?!klyth: )/ : /^klyth/)
    expect(text).not.toContain('\n')
    expect(text).toContain(row.fix)
  })
}


test('large-context selection reports success plus recovery warning without a toast or provider send', async ($, on) => {
  const w = world(on, { usageTokens: 310_000 })
  await start($)
  const chosen = await model($, 'acme/small')
  expect(chosen.text).toBe("Set model to acme/small\nklyth: existing context ~310k tokens is large for acme/small's 120k input budget; run /compact before continuing. Normal requests still enforce the 95% safety threshold")
  expect(w.statuses.at(-1)).toBe('acme/small · acme')
  expect(w.toasts).toEqual([])
  expect(w.requests).toEqual([])
  expect(w.native).toEqual([])
})
