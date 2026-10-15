// A plain Agent call under a routed main: which spawns klyth claims for the parent's route, seen through the
// spawn barrier. A claimed spawn holds its subagent's first step until the spawn settles; any other passes
// untouched and holds nothing. The kit hands a spawn no agentId (the host keeps that field for a spawn core
// started), so no route is written here: the harness (tests/harness/post-spawn.ts) follows a claimed spawn on
// to its routed steps.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HOME, model, start, step, klyth, world } from './world'
import type { WorldOptions } from './world'

const AGENT = (model: string | undefined) => `---\nname: scout\ndescription: d\n${model === undefined ? '' : `model: ${model}\n`}---\nSCOUT BODY`
const scout = (m?: string): WorldOptions => ({ files: { '/w/.claude/agents/scout.md': AGENT(m) } })
const spawn = ($: Engine, input: Record<string, unknown> = {}) => $.agent.spawn({ prompt: 'list the files', description: 'List files', subagentType: 'Explore', ...input } as never)

// Main on `strong` with its turn pinned, a spawn held until `release`, and the first step of its child `c1`.
async function held($: Engine, on: Parameters<typeof world>[0], o: WorldOptions, input: Record<string, unknown>, routed = true) {
  const clock = mock.clock(on)
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const inside = new Promise<void>(resolve => (entered = resolve))
  const w = world(on, { ...o, clock: 'mocked', spawn: async () => (entered(), await gate, { model: 'inherit' }) })
  await start($)
  if (routed) {
    await model($, 'strong')
    await step($, { turnId: 'm', index: 0 })
  }
  const pending = spawn($, input)
  await inside
  const early = step($, { turnId: 'c', index: 0, agentId: 'c1' })
  await clock.settle()
  return { w, early, release, pending }
}

for (const [why, o, input, routed] of [
  ['main is native', {}, {}, false],
  ['the call names a model', {}, { model: 'haiku' }, true],
  ['a custom agent type sets its own model', scout('sonnet'), { subagentType: 'scout' }, true],
  ['a built-in type sets its own model', {}, { subagentType: 'statusline-setup' }, true],
] as const) {
  test(`${why}: the spawn passes untouched and holds no step`, async ($, on) => {
    const { w, early, release, pending } = await held($, on, o, input, routed)
    expect((await early).result.answer).toBe('native')
    release()
    await pending
    expect(w.spawns).toHaveLength(1)
    expect(w.debug.some(l => l.startsWith('klyth spawn-wait') || l.startsWith('klyth inherit'))).toBe(false)
  })
}

for (const [why, o, input] of [
  ['an Agent call with no model', {}, {}],
  ['a custom agent type with model: inherit', scout('inherit'), { subagentType: 'scout' }],
  ['a custom agent type with no model', scout(), { subagentType: 'scout' }],
  ['a call that names inherit', {}, { model: 'inherit' }],
] as const) {
  test(`main is routed and ${why}: its first step waits for the spawn to settle`, async ($, on) => {
    const { w, early, release, pending } = await held($, on, o, input)
    expect(w.debug.some(l => l.startsWith('klyth spawn-wait'))).toBe(false)
    release()
    expect((await early).result.answer).toBe('native')
    expect(w.debug).toContain('klyth spawn-wait c1 outcome=settled routed=false')
    await pending
  })
}

test('main is routed and the type is one klyth cannot run (comment-thread-analyst): the spawn passes untouched, holds no step, and one debug line says so', async ($, on) => {
  const { w, early, release, pending } = await held($, on, {}, { subagentType: 'comment-thread-analyst' })
  expect((await early).result.answer).toBe('native')
  release()
  await pending
  expect(w.spawns).toHaveLength(1)
  expect(w.debug.some(l => l.startsWith('klyth spawn-wait'))).toBe(false)
  expect(w.debug.filter(l => l.startsWith('klyth inherit'))).toEqual(['klyth inherit: comment-thread-analyst is not a type klyth can run; it stays native'])
})

test('main is routed and Explore has no agent file: the spawn is claimed, and nothing is said', async ($, on) => {
  const { w, early, release, pending } = await held($, on, {}, { subagentType: 'Explore' })
  release()
  expect((await early).result.answer).toBe('native')
  await pending
  expect(w.debug).toContain('klyth spawn-wait c1 outcome=settled routed=false')
  expect(w.debug.filter(l => /^klyth (inherit: Explore (has|is|names|runs)|agent-def)/.test(l))).toEqual([])
})

test('main is routed and the call sets a cwd: the spawn passes untouched and holds no step, and one debug line says so', async ($, on) => {
  const { w, early, release, pending } = await held($, on, {}, { cwd: '/elsewhere' })
  expect((await early).result.answer).toBe('native')
  release()
  await pending
  expect(w.spawns).toHaveLength(1)
  expect(w.debug.some(l => l.startsWith('klyth spawn-wait'))).toBe(false)
  expect(w.debug.filter(l => l.startsWith('klyth inherit'))).toEqual(['klyth inherit: Explore sets its own cwd (/elsewhere); it stays native'])
})

test("the klyth agent tool's own spawn is not claimed for main's route", async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  await step($, { turnId: 'm', index: 0 })
  await $.tool.call({ tool: 'mcp__klyth__agent', model: 'fast', prompt: 'list the files', description: 'List files', subagent_type: 'Explore' })
  expect(w.spawns).toHaveLength(1)
  expect(w.debug.some(l => l.startsWith('klyth inherit'))).toBe(false)
})
