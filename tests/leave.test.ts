// Leaving a klyth route: the next main prompt carries one context block telling native Claude which turns another
// model answered; moving to another route, or a route that answered nothing, carries none.
import type { On, PromptSubmitInput } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CONFIG, model, start, step, klyth, world } from './world'

const note = (turns: number, who: string) =>
  `klyth: ${turns === 1 ? 'the previous assistant turn was' : `the previous ${turns} assistant turns were`} answered by ${who} through klyth, not by you; their self-descriptions are that model's, and any Agent calls among them were mcp__klyth__agent calls it made. From here you answer as yourself.`
const STRONG = 'strong (acme/model-b)'

// The bottom of prompt.submit: it records each prompt as it arrives there, and refuses the first `drops` of them.
function bottom(on: On, drops = 0) {
  const seen: PromptSubmitInput[] = []
  on('prompt.submit', ($, e) => (seen.push(e), seen.length <= drops ? { drop: 'blocked' } : { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))
  return { contexts: () => seen.map(e => e.context ?? []) }
}
const submit = ($: Engine, context?: readonly string[], turnId?: string) =>
  $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' }, ...(context === undefined ? {} : { context }), ...(turnId === undefined ? {} : { turnId }) })
const endSession = ($: Engine, reason: 'clear' | 'resume') => $.session.end({ reason, sessionId: 'old', resume: { id: 'old' } })
const turns = async ($: Engine, ...ids: string[]) => {
  for (const turnId of ids) await step($, { turnId, index: 0 })
}
const switchedFrom = (source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume') => ($: Engine) =>
  $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'sonnet', requested_model: null, source, context_tokens: 0, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0 } as never)

const leaves: [string, ($: Engine) => Promise<unknown>][] = [
  ['/model sonnet', $ => model($, 'sonnet')],
  ['the picker', $ => model($, '')],
  ['a command PostModelSwitch', switchedFrom('command')],
  ['a picker PostModelSwitch', switchedFrom('picker')],
  ['an sdk PostModelSwitch', switchedFrom('sdk')],
]
for (const [how, leave] of leaves) {
  test(`leaving a route through ${how} attaches one block to the next main prompt and none to the one after`, async ($, on) => {
    world(on, { picker: '' })
    const prompts = bottom(on)
    await start($)
    await model($, 'strong')
    await turns($, 't1', 't2')
    await leave($)
    await submit($)
    await submit($)
    expect(prompts.contexts()).toEqual([[note(2, STRONG)], []])
  })
}

test('a switch that does not leave klyth (auto, resume) attaches nothing', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await model($, 'strong')
  await turns($, 't1')
  await switchedFrom('auto')($)
  await switchedFrom('resume')($)
  await submit($)
  expect(prompts.contexts()).toEqual([[]])
})

test('a main prompt in a session that never left a route carries no block', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await model($, 'sonnet')
  await submit($)
  expect(prompts.contexts()).toEqual([[]])
})

test('a routed to routed switch attaches nothing to the routed prompt, and the note then names both routes with their turns', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await model($, 'strong')
  await turns($, 't1')
  await model($, 'fast')
  await submit($)
  await turns($, 't2', 't3')
  await model($, 'sonnet')
  await submit($)
  expect(prompts.contexts()).toEqual([
    [],
    [note(3, 'strong (acme/model-b) for 1 and fast (acme/model-a) for 2')],
  ])
})

test('turns on three routes are listed in order, and the same route twice running adds up', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await model($, 'strong')
  await turns($, 't1')
  await model($, 'fast')
  await turns($, 't2')
  await model($, 'acme/small')
  await turns($, 't3')
  await model($, 'sonnet')
  await model($, 'acme/small')
  await turns($, 't4')
  await model($, 'sonnet')
  await submit($)
  expect(prompts.contexts()).toEqual([[note(4, 'strong (acme/model-b) for 1, fast (acme/model-a) for 1 and acme/small for 2')]])
})

test('the count is of routed main turns: native turns and a turn\'s later steps are not counted', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await turns($, 'native-before')
  await model($, 'strong')
  await turns($, 't1')
  await step($, { turnId: 't1', index: 1 })
  await turns($, 't2')
  await model($, 'sonnet')
  await turns($, 'native-after')
  await submit($)
  expect(prompts.contexts()).toEqual([[note(2, STRONG)]])
})

test('a model with no alias is named once, and a route that answered no turn leaves nothing to say', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await model($, 'acme/small')
  await turns($, 't1')
  await model($, 'sonnet')
  await submit($)
  await model($, 'strong')
  await model($, 'sonnet')
  await submit($)
  expect(prompts.contexts()).toEqual([[note(1, 'acme/small')], []])
})

test('a route chosen again before the next prompt gets no block; the turns of both stretches are told once it is left', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await model($, 'strong')
  await turns($, 't1', 't2', 't3')
  await model($, 'sonnet')
  await model($, 'strong')
  await submit($)
  await turns($, 't4')
  await model($, 'sonnet')
  await submit($)
  await submit($)
  expect(prompts.contexts()).toEqual([[], [note(4, STRONG)], []])
})

for (const reason of ['clear', 'resume'] as const) {
  test(`a ${reason} ends the conversation the block was owed for, and the turns counted in it`, async ($, on) => {
    world(on)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    const prompts = bottom(on)
    await start($)
    await model($, 'strong')
    await turns($, 't1', 't2', 't3')
    await model($, 'sonnet')
    await endSession($, reason)
    await submit($)
    await model($, 'strong')
    await turns($, 't4', 't5')
    await endSession($, reason)
    await turns($, 't6')
    await model($, 'sonnet')
    await submit($)
    expect(prompts.contexts()).toEqual([[], [note(1, STRONG)]])
  })
}

test('a prompt delivered into a running routed turn carries no block and leaves it owed; one over a native turn, or after the turn, carries it', async ($, on) => {
  world(on)
  const prompts = bottom(on)
  await start($)
  await model($, 'strong')
  await turns($, 't1')
  await model($, 'sonnet')
  await submit($, undefined, 't1')
  await turns($, 'n1')
  await submit($, undefined, 'n1')
  await submit($)
  expect(prompts.contexts()).toEqual([[], [note(1, STRONG)], []])
})

test('/klyth reload keeps the block owed, naming the route as it was when it was left', async ($, on) => {
  let config = CONFIG
  world(on, { config: () => config })
  const prompts = bottom(on)
  await start($)
  await model($, 'strong')
  await turns($, 't1')
  await model($, 'sonnet')
  config = JSON.stringify({ providers: 5 })
  await klyth($, 'reload')
  await submit($)
  expect(prompts.contexts()).toEqual([[note(1, STRONG)]])
})

test('the block follows what an earlier hook attached, and is offered again when the prompt did not enter', async ($, on) => {
  world(on)
  const prompts = bottom(on, 1)
  await start($)
  await model($, 'strong')
  await turns($, 't1')
  await model($, 'sonnet')
  expect(await submit($, ['earlier'])).toEqual({ drop: 'blocked' })
  await submit($, ['earlier'])
  await submit($)
  expect(prompts.contexts()).toEqual([['earlier', note(1, STRONG)], ['earlier', note(1, STRONG)], []])
})
