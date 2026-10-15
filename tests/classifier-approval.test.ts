import { expect, mock, test } from 'claude-code/testing'
import { createApproval, type ApprovalPort } from '../hooks/classifier-approval'
import { denied } from './fixtures/denied'
import { CONFIG_OBJECT, NOW, start, step, world } from './world'
import { approvalDetails, renderApprovalPane } from '../hooks/classifier-approval-pane'

function fixture() {
  let now = 0, placed = true, shown = true, remaining = 10000, valid = true, opens = 0, closes = 0
  const timers = new Set<{ at: number; fn(): void }>()
  const io: ApprovalPort = { monotonic: () => now, remaining: () => remaining,
    open: async () => { opens++; return { isPlaced: placed } }, showing: async () => shown,
    close: async () => { closes++ }, redraw: () => {},
    after: (ms, fn) => { const t = { at: now + ms, fn }; timers.add(t); return { cancel: () => { timers.delete(t) } } },
  }
  const controller = createApproval(), ac = new AbortController()
  const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
  return { io, controller, ac, settle, ask: (key = 'a') => controller.ask(io, key, 'exact details', async () => valid, ac.signal),
    flags: (v: { placed?: boolean; shown?: boolean; remaining?: number; valid?: boolean }) => { placed = v.placed ?? placed; shown = v.shown ?? shown; remaining = v.remaining ?? remaining; valid = v.valid ?? valid },
    advance: async (ms: number) => { now += ms; for (const t of [...timers]) if (t.at <= now) { timers.delete(t); t.fn() } await settle() },
    counts: () => ({ opens, closes, timers: timers.size }),
  }
}

for (const answer of ['allow', 'deny', 'cancelled', 'stale', 'unplaced', 'timeout'] as const) test(`approval settles once on ${answer}, with no live timer or late approval`, async () => {
  const f = fixture(), pending = f.ask()
  await f.settle()
  const view = f.controller.view()!
  if (answer === 'allow' || answer === 'deny') view.answer(answer)
  if (answer === 'cancelled') f.ac.abort()
  if (answer === 'stale') { f.flags({ valid: false }); await f.advance(1000) }
  if (answer === 'unplaced') { f.flags({ shown: false }); await f.advance(1000) }
  if (answer === 'timeout') { await f.advance(7999); expect(f.controller.view()?.seconds).toBe(1); await f.advance(1) }
  expect(await pending).toBe(answer)
  view.answer('allow')
  expect(f.counts()).toEqual({ opens: 1, closes: 1, timers: 0 })
})

test('a tick released after Deny leaves no timer or redraw behind', async () => {
  const f = fixture()
  let release = (_value: boolean) => {}, checks = 0, redraws = 0
  const held = new Promise<boolean>(resolve => { release = resolve })
  f.io.redraw = () => { redraws++ }
  const pending = f.controller.ask(f.io, 'a', 'exact details', () => ++checks === 1 ? Promise.resolve(true) : held, f.ac.signal)
  await f.settle()
  await f.advance(1000)
  f.controller.view()!.answer('deny')
  expect(await pending).toBe('deny')
  const closedRedraws = redraws
  release(true)
  await f.settle()
  expect(f.counts().timers).toBe(0)
  expect(redraws).toBe(closedRedraws)
})

test('identical approvals share one deadline, distinct ones are busy, and expiry wins a click', async () => {
  const f = fixture(), first = f.ask()
  await f.settle()
  await f.advance(3000)
  const same = f.ask()
  expect(await f.ask('other')).toBe('busy')
  const view = f.controller.view()!
  await f.advance(5000)
  view.answer('allow')
  expect(await first).toBe('timeout')
  expect(await same).toBe('timeout')
  expect(f.counts()).toEqual({ opens: 1, closes: 1, timers: 0 })
})

for (const phase of ['before', 'after', 'unplaced'] as const) test(`approval admission blocks ${phase} opening without a timeout`, async () => {
  const f = fixture()
  if (phase === 'before') f.flags({ remaining: 9499 })
  if (phase === 'after') { f.io.open = async () => { f.flags({ remaining: 9499 }); return { isPlaced: true } } }
  if (phase === 'unplaced') f.flags({ placed: false })
  expect(await f.ask()).toBe(phase === 'unplaced' ? 'unplaced' : 'budget')
  expect(f.controller.view()).toBeUndefined()
  expect(f.counts().timers).toBe(0)
})

test('native review preserves complete inert details, uses explicit controls and rejects secret masking', async ($, on) => {
  const details = approvalDetails({ actor: 'main', tool: 'Write', cwd: '/w', input: { file_path: '/w/a.md', content: 'line\n‮END' } })!
  expect(details).toContain('\\u202eEND')
  expect(approvalDetails({ actor: 'main', tool: 'Bash', cwd: '/w', input: { command: 'echo sk-secret' } })).toBeUndefined()
  let answer = ''
  on('ui.render', { component: 'Pane', requestId: 'review' }, ($, e) => renderApprovalPane($.ui.resolve(e), { details, seconds: 8, answer: v => { answer = v } }))
  const ui = await $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'review', props: { title: 'Review', isFocused: true, bodyColumns: 40, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain(details)
  await ui.press({ key: 'allow-once' })
  expect(answer).toBe('allow')
  await ui.press({ key: 'deny' })
  expect(answer).toBe('deny')
  await ui.unmount()
})

for (const [change, actor, context] of [['none', 'main', 'fresh'], ['none', 'main', 'fork'], ['none', 'sub1', 'fresh'], ['none', 'sub1', 'fork'], ['policy', 'main', 'fresh'], ['history', 'main', 'fresh'], ['mode', 'main', 'fresh'], ['session', 'main', 'fresh']] as const) test(`native Allow once reaches the exact single-use token seam: ${actor}/${context}; ${change} before consumption`, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let sessionId = 'session-one'
  const policy: Record<string, unknown> = {}
  const w = world(on, { approval: 'native', clock: 'mocked', config: JSON.stringify({ ...CONFIG_OBJECT, classifier: { context } }), routes: { sub1: { target: 'acme/model-b', label: 'strong', type: 'general-purpose', prompt: 'Fix the typo.' } }, pin: { turnId: 't', target: 'acme/model-b' }, submit: 'enters', messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the typo.' }] }], policy, sessionId: () => sessionId })
  on('tool.check', () => ({ decision: 'ask' }))
  on('ui.open', { id: 'klyth-classifier-approval' }, () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'klyth-classifier-approval', title: 'Review', isPlaced: true, isShown: true, isFocused: true }] }))
  on('ui.close', { id: 'klyth-classifier-approval' }, () => ({ value: undefined }))
  await start($)
  await $.prompt.submit({ text: 'Fix the typo.', wait: false, origin: { kind: 'composer' } })
  await step($, { turnId: 't', index: 0, ...(actor === 'main' ? {} : { agentId: actor }) })
  const input = { file_path: '/w/a.md', old_string: 'teh', new_string: 'the' }
  await $.tool.check({ tool: 'Edit', input, tool_use_id: 'toolu_klyth_review', ...(actor === 'main' ? {} : { agentId: actor }) } as never)
  const pending = $.classic.PermissionDenied(denied('Edit', input, 'toolu_klyth_review', actor === 'main' ? {} : { agent_id: actor }) as never)
  await clock.settle()
  const beforeTick = w.wires.length
  await clock.advance(1000)
  expect(w.wires.length).toBe(beforeTick)
  const ui = await $.ui.mount({ plugin: 'klyth', surface: 'terminal', component: 'Pane', requestId: 'klyth-classifier-approval', props: { title: 'Review', isFocused: true, bodyColumns: 40, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('"file_path": "/w/a.md"')
  await ui.press({ key: 'allow-once' })
  expect(await pending).toEqual({ retry: true })
  const before = w.wires.length
  await step($, { turnId: 't', index: 1, ...(actor === 'main' ? {} : { agentId: actor }) })
  if (change === 'policy') policy['autoMode'] = { hard_deny: ['editing'] }
  if (change === 'history') await $.prompt.submit({ text: 'Changed history.', wait: false, origin: { kind: 'composer' } })
  if (change === 'mode') await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: '', tool_use_id: 'toolu_x', permission_mode: 'default' })
  if (change === 'session') sessionId = 'session-two'
  const check = () => $.tool.check({ tool: 'Edit', input, tool_use_id: 'toolu_klyth_again', ...(actor === 'main' ? {} : { agentId: actor }) } as never)
  const verdict = await check()
  expect(verdict.decision, w.debug.join('\n')).toBe(change === 'none' ? 'allow' : 'ask')
  expect((await check()).decision).toBe('ask')
  expect(w.wires.length).toBe(before + 1)
  await ui.unmount()
})
