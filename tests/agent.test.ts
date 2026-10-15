// The klyth agent tool: its checks, the arguments it hands $.agent.spawn, trust, worktree isolation and its
// cleanup at the subagent's completion, re-entry and the spawn barrier. The kit hands a plugin's own
// $.agent.spawn no agentId (the host keeps that field for a spawn core started), so here every wrapper
// spawn ends "did not start"; the launch line and a written route are live evidence (LV3).
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Route } from '../types'
import { CONFIG_OBJECT, CWD, HELPER, HOME, LOCAL_CONFIG, LOCAL_HELPER, LOCAL_ORIGIN, start, step, TRASH, world } from './world'
import type { Git } from './world'

const NOT_STARTED = { deny: 'klyth agent: the subagent did not start; retry, or use Agent' }
const BAD_INPUT = 'klyth agent: invalid input: prompt and description must be text, subagent_type and name text when given, effort one of low, medium, high, xhigh, max, run_in_background true or false'
const FORK = "klyth agent: a fork runs on its parent's model, and this conversation is native; to fork natively use Agent"
const NATIVE_SUB = { deny: 'klyth agent: not available from a native subagent or from inside a spawn; use Agent here' }
const call = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__klyth__agent', model: 'fast', prompt: 'list the files', description: 'List files', subagent_type: 'Explore', ...input })
const complete = ($: Engine, agentId: string | undefined, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer: 'report', reason, durationMs: 1, isAborted: reason === 'aborted', turnId: 't', ...(agentId ? { agentId } : {}) })
const gitCalls = (runs: string[][]) => runs.filter(r => r[0] === 'git').map(r => r.slice(1).join(' '))
const WT = { path: `${CWD}/.claude/worktrees/agent-1234abcd`, branch: 'worktree-agent-1234abcd', base: 'base0', root: CWD }
const ISOLATED: Route = { target: 'acme/model-a', label: 'fast', worktree: WT }
const kept = (who: string) => `kept worktree ${WT.path} (branch ${WT.branch}) of subagent ${who}`
const NEXT = `; merge ${WT.branch} or remove the worktree`

test('unsupported parameters, an unknown model, bad input, a fork, native effort and remote isolation are denied before any spawn', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await call($, { team_name: 't', mode: 'plan' })).toEqual({ deny: 'klyth agent: unsupported parameter(s) team_name, mode; use Agent for them' })
  expect(await call($, { model: 'zeus' })).toEqual({
    deny: 'klyth agent: unknown model "zeus"; valid: acme/model-a, acme/model-b, acme/small, fable, fast, haiku, opus, sonnet, strong',
  })
  // A native main's forks are always denied, so it is not told a fork may omit the model.
  expect(await call($, { model: undefined })).toEqual({ deny: 'klyth agent: model is required; valid: acme/model-a, acme/model-b, acme/small, fable, fast, haiku, opus, sonnet, strong' })
  for (const model of ['constructor', 'acme/toString']) expect((await call($, { model })) as { deny?: string }).toMatchObject({ deny: expect.stringContaining(`unknown model "${model}"`) })
  expect(await call($, { effort: 'extreme' })).toEqual({
    deny: BAD_INPUT,
  })
  expect(await call($, { run_in_background: 'no' })).toEqual({ deny: BAD_INPUT })
  expect(await call($, { subagent_type: 'fork' })).toEqual({ deny: FORK })
  expect(await call($, { subagent_type: 'fork', model: 'haiku' })).toEqual({ deny: FORK })
  expect(await call($, { model: 'haiku', effort: 'high' })).toEqual({ deny: 'klyth agent: effort cannot be set for a native model through klyth; omit effort, or use Agent' })
  expect(await call($, { isolation: 'remote' })).toEqual({ deny: 'klyth agent: isolation "remote" is not available through klyth; omit it or use "worktree"' })
  expect(w.spawns).toEqual([])
  expect(gitCalls(w.runs)).toEqual([])
})

test("a klyth agent call made in a subagent's loop never spawns: it is denied with why it could not become an Agent call, else because the subagent is native", async ($, on) => {
  const w = world(on, { config: JSON.stringify({ ...CONFIG_OBJECT, aliases: { ...CONFIG_OBJECT.aliases, quick: 'native/claude-haiku-4-5' } }) })
  await start($)
  expect(await call($, { agentId: 'sub-x' })).toEqual(NATIVE_SUB)
  expect(await call($, { agentId: 'sub-x', model: 'haiku' })).toEqual(NATIVE_SUB)
  expect(await call($, { agentId: 'sub-x', model: 'zeus' })).toMatchObject({ deny: expect.stringContaining('unknown model "zeus"') })
  expect(await call($, { agentId: 'sub-x', subagent_type: 'fork' })).toEqual({ deny: FORK })
  expect(await call($, { agentId: 'sub-x', model: 'quick' })).toEqual({
    deny: 'klyth agent: quick is not a native alias the Agent tool takes (fable, haiku, opus, sonnet); use one of those, or a klyth alias',
  })
  expect(w.spawns).toEqual([])
  expect(w.asks).toEqual([])
})

test("a klyth agent call from a subagent for a provider not approved says how to approve it, and asks nothing", async ($, on) => {
  const w = world(on, { store: {} })
  await start($)
  expect(await call($, { agentId: 'sub-x' })).toEqual({ deny: 'klyth agent: provider acme is not approved; run /model fast once and choose Allow' })
  expect(await call($, { agentId: 'sub-x', model: 'acme/model-b' })).toEqual({ deny: 'klyth agent: provider acme is not approved; run /model acme/model-b once and choose Allow' })
  expect(await call($, { agentId: 'sub-x', model: 'haiku' })).toEqual(NATIVE_SUB)
  expect(w.asks).toEqual([])
  expect(w.spawns).toEqual([])
})

test('run_in_background true is main\'s own spawn, which runs in the background; false is denied there', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await call($, { run_in_background: true })).toEqual(NOT_STARTED)
  expect(w.spawns).toHaveLength(1)
  expect(await call($, { run_in_background: false })).toEqual({ deny: 'klyth agent: run_in_background false needs a conversation that klyth routes; omit it, and the subagent runs in the background' })
  expect(w.spawns).toHaveLength(1)
})

test('the wrapper never runs a key helper, before the trust dialog or after an approval: only a routed step does', async ($, on) => {
  const w = world(on, { store: {}, keyFails: true })
  await start($)
  expect(await call($, {})).toEqual(NOT_STARTED)
  expect(w.asks).toHaveLength(1)
  expect(w.spawns).toHaveLength(1)
  expect(w.runs.filter(r => r[0] === HELPER[0])).toEqual([])
})

test('with a broken config the klyth agent tool denies with the config error', async ($, on) => {
  const w = world(on, { config: JSON.stringify({ ...CONFIG_OBJECT, aliases: { fast: 'acme/none' } }) })
  await start($)
  expect(await call($, {})).toEqual({
    deny: 'klyth agent: unavailable (config error: aliases.fast → "none" is not declared under provider acme (declared: model-a, model-b, small)); use Agent',
  })
  expect(w.spawns).toEqual([])
})

test('a remote target is approved in the wrapper before any spawn; a rejection spawns nothing', async ($, on) => {
  const w = world(on, { store: {}, answer: 'Keep native' })
  await start($)
  expect(await call($, {})).toEqual({ deny: 'klyth agent: provider acme is not approved; use Agent for a native model' })
  expect(w.asks).toHaveLength(1)
  expect(w.spawns).toEqual([])
})

// The kit raises a plugin's $.agent.spawn in the Agent tool's argument shape (`subagent_type`).
test('a remote call hands the spawn its prompt, description, type and name, and no model, effort or consent', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await call($, { effort: 'high', consent: 'pressed', name: 'scout' })).toEqual(NOT_STARTED)
  expect(w.spawns[0]).toMatchObject({ prompt: 'list the files', description: 'List files', subagent_type: 'Explore', name: 'scout' })
  expect(Object.keys(w.spawns[0] ?? {}).filter(k => ['model', 'effort', 'consent', 'agentId', 'cwd'].includes(k))).toEqual([])
})

test('a dotted alias is a valid wrapper model: offered in the schema, asked about as plain http, and spawned', async ($, on) => {
  const w = world(on, { config: LOCAL_CONFIG, store: {} })
  await start($)
  const schema = w.registered[0]?.inputSchema as { properties: { model: { enum: string[] } } }
  expect(schema.properties.model.enum).toEqual(['fable', 'haiku', 'local/model-v1', 'model.v1-mini', 'opus', 'sonnet'])
  expect(w.registered[0]?.description).toContain('- model.v1-mini: local/model-v1 — a dotted alias on a plain-http provider')
  expect(await call($, { model: 'model.v1-mini', effort: 'max' })).toEqual(NOT_STARTED)
  expect(w.asks).toEqual([
    `Plain http: the API key and your data travel unencrypted unless the network itself is private or encrypted. Route klyth requests to ${LOCAL_ORIGIN}, with the key printed by ${JSON.stringify(LOCAL_HELPER)}?`,
  ])
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]).toMatchObject({ prompt: 'list the files', subagent_type: 'Explore' })
  expect(await call($, { model: 'model.v1-mnii' })).toEqual({
    deny: 'klyth agent: unknown model "model.v1-mnii"; valid: fable, haiku, local/model-v1, model.v1-mini, opus, sonnet',
  })
})

test('native targets hand the spawn the native model: an alias, native/<m>, and an alias to a full id', async ($, on) => {
  const w = world(on, { config: JSON.stringify({ ...CONFIG_OBJECT, aliases: { ...CONFIG_OBJECT.aliases, quick: 'native/claude-haiku-4-5' } }) })
  await start($)
  for (const model of ['haiku', 'native/haiku', 'quick']) await call($, { model })
  expect(w.spawns.map(s => s['model'])).toEqual(['haiku', 'haiku', 'claude-haiku-4-5'])
})

test('a refused spawn is relayed, and a rejected one answers the generic deny', async ($, on) => {
  const w = world(on, { spawn: () => ({ deny: 'no agents today' }) })
  await start($)
  expect(await call($, {})).toEqual({ deny: 'no agents today' })
  expect(w.debug.some(l => l.startsWith('klyth spawn '))).toBe(false)
})

test('a spawn nothing answers reaches the .catch deny; an isolated one has its worktree removed first', async ($, on) => {
  const w = world(on, { spawn: 'unanswered' })
  await start($)
  expect(await call($, { isolation: 'worktree' })).toEqual({ deny: 'klyth agent: internal error (see the debug log); use Agent' })
  expect(gitCalls(w.runs).some(c => c.includes('branch -d'))).toBe(true)
  expect((await step($, { turnId: 'r', index: 0, agentId: 'r1' })).result.answer).toBe('native')
  expect(w.debug.some(l => l.startsWith('klyth spawn-wait'))).toBe(false)
})

test('isolation outside a git work tree is denied before any spawn', async ($, on) => {
  const w = world(on, { cwd: '/tmp/plain', git: args => (args.includes('--show-toplevel') ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : undefined) })
  await start($)
  expect(await call($, { isolation: 'worktree' })).toEqual({ deny: 'klyth agent: isolation "worktree" needs a git work tree, and /tmp/plain is not inside one; omit isolation' })
  expect(w.spawns).toEqual([])
  expect(gitCalls(w.runs).some(c => c.includes('worktree add'))).toBe(false)
})

test('isolation makes a worktree from HEAD on a new branch and spawns in it; one whose spawn fails is moved to the Trash', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await call($, { isolation: 'worktree' })).toEqual(NOT_STARTED)
  const calls = gitCalls(w.runs)
  const add = calls.find(c => c.includes('worktree add')) ?? ''
  const m = /^-C \/w worktree add -b (worktree-agent-[0-9a-f]{8}) (\/w\/\.claude\/worktrees\/agent-[0-9a-f]{8}) base0$/.exec(add)
  expect(m).not.toBeNull()
  const [, branch, path] = m as RegExpExecArray
  expect(branch?.slice('worktree-agent-'.length)).toBe(path?.slice(-8))
  expect(w.spawns[0]?.['cwd']).toBe(path)
  expect(w.runs).toContainEqual([TRASH, path as string])
  expect(calls.slice(calls.indexOf(add) + 1)).toEqual([`-C ${path} status --porcelain`, `-C ${path} rev-list --count base0..HEAD`, '-C /w worktree prune', `-C /w branch -d ${branch}`])
  expect(w.runs.flat().some(a => a === '--force' || a === '-D' || a === '-f')).toBe(false)
})

// A native main's call is held to the rules a routed caller's Agent call meets at its spawn (inherit.ts), so the same
// call is answered the same from either; tests/harness/post-spawn.ts compares the two paths end to end.
const agentFile = (name: string, extra = '') => `---\nname: ${name}\ndescription: d\n${extra}---\nBODY`
const CANNOT = (type: string, why: string, alias = 'fast') => ({ deny: `klyth agent: ${type} ${why}, so klyth cannot run it on ${alias}; use another subagent_type or a native model` })

test('a type klyth cannot run, a built-in type two agent files name, and a built-in type whose file isolates it elsewhere are denied for a klyth model; a native model is not held to them', async ($, on) => {
  const w = world(on, { files: { '/w/.claude/agents/a.md': agentFile('Explore'), [`${HOME}/.claude/agents/b.md`]: agentFile('Explore'), '/w/.claude/agents/p.md': agentFile('Plan', 'isolation: remote\n') } })
  await start($)
  expect(await call($, { subagent_type: 'comment-thread-analyst' })).toEqual(CANNOT('comment-thread-analyst', 'is not a type klyth can run'))
  expect(await call($, { subagent_type: 'Explore' })).toEqual(CANNOT('Explore', 'has more than one definition'))
  expect(await call($, { subagent_type: 'Plan' })).toEqual(CANNOT('Plan', 'runs isolated as remote'))
  expect(await call($, { subagent_type: 'comment-thread-analyst', model: 'acme/model-b' })).toEqual(CANNOT('comment-thread-analyst', 'is not a type klyth can run', 'acme/model-b'))
  expect(w.spawns).toEqual([])
  expect(await call($, { subagent_type: 'comment-thread-analyst', model: 'haiku' })).toEqual(NOT_STARTED)
  expect(w.spawns).toHaveLength(1)
})

test('a built-in type whose one agent file klyth cannot read is denied for a klyth model, and a native model is not held to it', async ($, on) => {
  const w = world(on, { files: { '/w/.claude/agents/Explore.md': '---\nname: Explore\ndescription: d\ntools: |\n  Read\n---\nBODY' } })
  await start($)
  expect(await call($, { subagent_type: 'Explore' })).toEqual(CANNOT('Explore', 'has one agent file klyth cannot read'))
  expect(w.spawns).toEqual([])
  expect(await call($, { subagent_type: 'Explore', model: 'haiku' })).toEqual(NOT_STARTED)
})

test('every spelling of fork the engine reads as one is denied from a native main, on any alias, and nothing spawns', async ($, on) => {
  const w = world(on)
  await start($)
  for (const subagent_type of ['Fork', 'FORK', 'for_k', ' fork ', 'ｆｏｒｋ']) {
    for (const model of ['fast', 'strong', undefined]) expect(await call($, { subagent_type, model })).toEqual({ deny: FORK })
  }
  expect(w.spawns).toEqual([])
})

test("a fork that reaches the tool untranslated from a routed conversation is denied without calling that conversation native; a routed main's call without a model is told a fork may omit it", async ($, on) => {
  const w = world(on, { pin: { turnId: 't', target: 'fast' }, routes: { sub1: { target: 'acme/model-a', label: 'fast', type: 'general-purpose' } } })
  await start($)
  await step($, { turnId: 't', index: 0 })
  const UNTRANSLATED = { deny: 'klyth agent: this fork could not be made an Agent call, so it did not start (see the debug log); retry, or fork with Agent' }
  expect(await call($, { subagent_type: 'fork', model: undefined })).toEqual(UNTRANSLATED)
  expect(await call($, { subagent_type: 'Fork', model: 'fast' })).toEqual(UNTRANSLATED)
  expect(await $.tool.call({ tool: 'mcp__klyth__agent', agentId: 'sub1', prompt: 'p', description: 'd', subagent_type: 'fork' })).toEqual(UNTRANSLATED)
  expect(await call($, { model: undefined })).toEqual({
    deny: "klyth agent: model is required, except for a fork, which runs on this conversation's model; valid: acme/model-a, acme/model-b, acme/small, fable, fast, haiku, opus, sonnet, strong",
  })
  expect(w.spawns).toEqual([])
})

test('the type is resolved as the engine resolves an Agent call\'s: another casing of a known type spawns and is checked as that type, and a spelling two types share is denied with both', async ($, on) => {
  const w = world(on, { files: { '/w/.claude/agents/s1.md': agentFile('scout'), [`${HOME}/.claude/agents/s2.md`]: agentFile('Scout') } })
  await start($)
  for (const subagent_type of ['explore', 'EXPLORE', 'Explore']) expect(await call($, { subagent_type })).toEqual(NOT_STARTED)
  expect(w.spawns.map(e => e['subagent_type'])).toEqual(['Explore', 'Explore', 'Explore'])
  expect(await call($, { subagent_type: 'Comment-Thread-Analyst' })).toEqual(CANNOT('comment-thread-analyst', 'is not a type klyth can run'))
  expect(await call($, { subagent_type: 'SCOUT' })).toEqual({ deny: 'klyth agent: subagent_type "SCOUT" matches more than one agent type (Scout, scout); name one of them exactly' })
  expect(await call($, { subagent_type: 'scout' })).toEqual(NOT_STARTED)
  expect(w.spawns.map(e => e['subagent_type'])).toEqual(['Explore', 'Explore', 'Explore', 'scout'])
})

test('a call denied for its type asks no approval of its provider first', async ($, on) => {
  const w = world(on, { store: {} })
  await start($)
  expect(await call($, { subagent_type: 'comment-thread-analyst' })).toEqual(CANNOT('comment-thread-analyst', 'is not a type klyth can run'))
  expect(w.asks).toEqual([])
  expect(w.spawns).toEqual([])
})

test("an override file's isolation: worktree makes the worktree the subagent works in, as the engine makes one for a routed caller's Agent call; its model: is ignored for the requested alias", async ($, on) => {
  const w = world(on, { files: { '/w/.claude/agents/x.md': agentFile('Explore', 'model: sonnet\nisolation: worktree\n') } })
  await start($)
  expect(await call($, { subagent_type: 'Explore' })).toEqual(NOT_STARTED)
  expect(w.spawns).toHaveLength(1)
  expect(String(w.spawns[0]?.['cwd'])).toMatch(/^\/w\/\.claude\/worktrees\/agent-[0-9a-f]{8}$/)
  expect(w.spawns[0]).not.toHaveProperty('model')
})

test('a failed git worktree add is denied with its message and spawns nothing', async ($, on) => {
  const w = world(on, { git: args => (args.includes('add') ? { exitCode: 128, stdout: '', stderr: "fatal: a branch named 'x' already exists\n" } : undefined) })
  await start($)
  expect(await call($, { isolation: 'worktree' })).toEqual({ deny: "klyth agent: git worktree add failed: fatal: a branch named 'x' already exists; fix the repository or omit isolation" })
  expect(w.spawns).toEqual([])
})

test("an isolated subagent's clean worktree is moved to the Trash at completion, then pruned, and its branch deleted with -d; the route says it was isolated", async ($, on) => {
  const w = world(on, { routes: { iso1: ISOLATED } })
  await start($)
  await complete($, 'iso1')
  expect(gitCalls(w.runs)).toEqual([
    `-C ${WT.path} status --porcelain`,
    `-C ${WT.path} rev-list --count base0..HEAD`,
    '-C /w worktree prune',
    `-C /w branch -d ${WT.branch}`,
  ])
  expect(w.runs).toContainEqual([TRASH, WT.path])
  expect(w.stateSets).toContainEqual({ key: 'routed', id: 'iso1', value: { target: 'acme/model-a', label: 'fast', wasIsolated: true } })
  expect(w.toasts.some(t => t.includes('kept worktree'))).toBe(false)
})

test("a worktree the engine made is dropped from the route when the subagent finishes, which then says it was isolated, and is neither touched nor trashed by klyth", async ($, on) => {
  const engine = { path: `${CWD}/.claude/worktrees/agent-p1`, engine: true as const }
  const w = world(on, { routes: { p1: { target: 'acme/model-a', label: 'fast', type: 'Explore', prompt: 'audit', worktree: engine } } })
  await start($)
  await complete($, 'p1')
  expect(w.stateSets).toContainEqual({ key: 'routed', id: 'p1', value: { target: 'acme/model-a', label: 'fast', type: 'Explore', prompt: 'audit', wasIsolated: true } })
  expect(gitCalls(w.runs)).toEqual([])
  expect(w.runs.some(r => r[0] === TRASH)).toBe(false)
  expect(w.toasts).toEqual([])
})

test('with no trash on PATH a clean worktree is kept and toasted; git never removes it', async ($, on) => {
  const w = world(on, { routes: { iso2: ISOLATED }, trash: null })
  await start($)
  await complete($, 'iso2')
  expect(gitCalls(w.runs)).toEqual([`-C ${WT.path} status --porcelain`, `-C ${WT.path} rev-list --count base0..HEAD`])
  expect(w.toasts).toContain(`klyth: ${kept('iso2')}: no trash command was found to move it with${NEXT}`)
  expect(w.stateSets.some(s => s.key === 'routed')).toBe(false)
})

test('a worktree whose state cannot be checked is kept and toasted, and nothing is moved or removed', async ($, on) => {
  const failing = (a: readonly string[]): Git | undefined => (a.includes('--porcelain') ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' } : undefined)
  const w = world(on, { routes: { gone: ISOLATED }, git: failing })
  await start($)
  await complete($, 'gone')
  expect(w.toasts).toContain(`klyth: ${kept('gone')}: it could not be checked (fatal: not a git repository)${NEXT}`)
  expect(w.runs.some(r => r[0] === TRASH)).toBe(false)
  expect(gitCalls(w.runs).some(c => c.includes('prune') || c.includes('remove') || c.includes('branch'))).toBe(false)
})

for (const [why, git] of [
  ['uncommitted changes', (a: readonly string[]): Git | undefined => (a.includes('--porcelain') ? { exitCode: 0, stdout: ' M retry.ts\n', stderr: '' } : undefined)],
  ['new commits', (a: readonly string[]): Git | undefined => (a.includes('rev-list') ? { exitCode: 0, stdout: '2\n', stderr: '' } : undefined)],
] as const) {
  test(`a worktree with ${why} is kept, and its path and branch are logged and toasted`, async ($, on) => {
    const w = world(on, { routes: { dirty: ISOLATED }, git })
    await start($)
    await complete($, 'dirty', 'aborted')
    const text = `${kept('dirty')}: it has changes${NEXT}`
    expect(w.transcript).toContain(text)
    expect(w.toasts).toContain(`klyth: ${text}`)
    expect(gitCalls(w.runs).some(c => c.includes('prune') || c.includes('remove') || c.includes('branch'))).toBe(false)
    expect(w.runs.some(r => r[0] === TRASH)).toBe(false)
  })
}

test('completions of unrouted subagents, of routes without a worktree and of main touch no git', async ($, on) => {
  const w = world(on, { routes: { plain: { target: 'acme/model-a', label: 'fast' } } })
  await start($)
  for (const id of ['stranger', 'plain', undefined]) await complete($, id)
  expect(gitCalls(w.runs)).toEqual([])
})

test(
  'the re-entry handler denies a klyth agent call raised beneath its own spawn and lets other tools through',
  {
    plugins: [
      {
        name: 'nester',
        register(on) {
          on('agent.spawn', async ($, e, next) => {
            const wrapper = await $.tool.call({ tool: 'mcp__klyth__agent', model: 'fast', prompt: 'nested', description: 'n' })
            const read = await $.tool.call({ tool: 'Read', file_path: '/w/notes.txt' })
            $.ui.log(`nester ${JSON.stringify({ wrapper, read })}`)
            return next(e)
          })
        },
      },
    ],
  },
  async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'file text' }))
    await start($)
    expect(await call($, {})).toEqual(NOT_STARTED)
    expect(w.transcript).toContain(`nester ${JSON.stringify({ wrapper: NATIVE_SUB, read: { result: 'file text' } })}`)
  },
)

test('a child step raised while the wrapper spawn is held waits for the spawn to settle', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const inside = new Promise<void>(resolve => (entered = resolve))
  const w = world(on, { clock: 'mocked', spawn: async () => (entered(), await gate, { model: 'inherit' }) })
  await start($)
  const pending = call($, {})
  await inside
  const early = step($, { turnId: 'b', index: 0, agentId: 'b1' })
  await clock.settle()
  expect(w.debug.some(l => l.startsWith('klyth spawn-wait'))).toBe(false)
  release()
  expect((await early).result.answer).toBe('native')
  expect(w.debug).toContain('klyth spawn-wait b1 outcome=settled routed=false')
  expect(await pending).toEqual(NOT_STARTED)
})

test('a wrapper spawn held past SPAWN_WAIT_MS ends the wait at the bound, and the step passes through', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const inside = new Promise<void>(resolve => (entered = resolve))
  const w = world(on, { clock: 'mocked', spawn: async () => (entered(), await gate, { model: 'inherit' }) })
  await start($)
  const pending = call($, {})
  await inside
  const early = step($, { turnId: 'h', index: 0, agentId: 'h1' })
  await clock.advance(5000)
  expect((await early).result.answer).toBe('native')
  expect(w.debug).toContain('klyth spawn-wait h1 outcome=timeout routed=false')
  release()
  expect(await pending).toEqual(NOT_STARTED)
})

test('with no config file the klyth agent tool names the config directory it looked in', async ($, on) => {
  world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' }, config: null })
  await start($)
  expect(await call($, {})).toEqual({ deny: 'klyth agent: unavailable (no /cfg/klyth.json); use Agent' })
})
