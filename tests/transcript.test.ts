// Reading the engine's transcript where routing needs it: a subagent's opening task, whether the engine delivers through
// SubagentHandback, and the first user text.
import { expect, test } from 'claude-code/testing'

import type { ApiMessage } from '../hooks/protocol'
import { firstUserText, handbackState, withTask, withoutTool } from '../hooks/transcript'
import { HANDBACK_REMINDER } from './fixtures/handback'

// A subagent's transcript as the engine reads it back: the task, the engine's handback reminder and an
// attachment, then the loop's own steps.
const TASK = 'Search the fixture for retry logic.\nReport each finding with its file_path:line_number.'
const SAVED: ApiMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: TASK },
      HANDBACK_REMINDER,
      { type: 'text', text: '<system-reminder>\nThe following skills are available…\n</system-reminder>' },
    ],
  },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_klyth_000000000000000000000001', name: 'Grep', input: { pattern: 'retry' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_klyth_000000000000000000000001', content: 'retry.ts:3' }] },
]

test('a subagent transcript that opens on its task is carried exactly, reminders included', () => {
  expect(withTask(SAVED, TASK)).toBe(SAVED)
  expect(withTask(SAVED, `  ${TASK}\n`)).toBe(SAVED)
})

test('a subagent transcript missing its task (no saved transcript) opens on the task it was started with', () => {
  expect(withTask([], TASK)).toEqual([{ role: 'user', content: [{ type: 'text', text: TASK }] }])
  const held = SAVED.slice(1)
  expect(withTask(held, TASK)).toEqual([{ role: 'user', content: [{ type: 'text', text: TASK }] }, ...held])
  expect(withTask(held, undefined)).toBe(held)
  expect(withTask(held, '  ')).toBe(held)
})

test('an opening user turn the engine holds is kept as is, whatever another hook made of the task or a compaction left', () => {
  const rewritten: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Fix the login bug. Customer record: [redacted]' }, { type: 'text', text: '<system-reminder>\nhandback\n</system-reminder>' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ]
  expect(withTask(rewritten, 'Fix the login bug. Customer record: jane@example.com, card 4111 1111 1111 1111')).toBe(rewritten)
  const scrubbed: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: '' }] }, ...SAVED.slice(1)]
  expect(withTask(scrubbed, TASK)).toBe(scrubbed)
  const compacted: ApiMessage[] = [{ role: 'user', content: 'This session is being continued from a previous conversation. Primary request: find the retry logic.' }]
  expect(withTask(compacted, TASK)).toBe(compacted)
})

const NAME = 'SubagentHandback'
const REMINDER = { type: 'text', text: '<system-reminder>\nYour final report is delivered through SubagentHandback: call it.\n</system-reminder>' }
const call = (id: string, input: unknown = { message: 'r' }, name = NAME): ApiMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'tool_use', id, name, input }] })
const result = (id: string, isError: boolean): ApiMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'No such tool available: SubagentHandback', ...(isError ? { is_error: true } : {}) }] })
const later: ApiMessage[] = [{ role: 'assistant', content: 'retrying' }, { role: 'user', content: 'go on' }, { role: 'assistant', content: 'more' }]

test('handbackState: offered only when the engine said it delivers through the tool, unsaid otherwise', () => {
  expect(handbackState(SAVED, NAME)).toBe('offered')
  expect(handbackState([{ role: 'user', content: [{ type: 'text', text: TASK }] }], NAME)).toBe('unsaid')
  expect(handbackState([{ role: 'user', content: [{ type: 'text', text: `${TASK}\nYour report is delivered through SubagentHandback.` }] }], NAME)).toBe('unsaid')
  expect(handbackState([{ role: 'user', content: [{ type: 'text', text: TASK }, REMINDER] }], NAME)).toBe('offered')
  expect(handbackState([{ role: 'user', content: `${TASK}\n` }], NAME)).toBe('unsaid')
  expect(handbackState([{ role: 'user', content: REMINDER.text }], NAME)).toBe('offered')
  expect(handbackState([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: REMINDER.text }] }], NAME)).toBe('unsaid')
  expect(handbackState([], NAME)).toBe('unsaid')
})

test('handbackState: a schema-valid call the next user turn answers with an error is refused, whatever followed', () => {
  expect(handbackState([...SAVED, call('h1'), result('h1', true)], NAME)).toBe('refused')
  expect(handbackState([...SAVED, call('h1'), result('h1', true), ...later], NAME)).toBe('refused')
  expect(handbackState([...SAVED, call('h1', {}), result('h1', true)], NAME)).toBe('offered')
  expect(handbackState([...SAVED, call('h1', { message: 42 }), result('h1', true)], NAME)).toBe('offered')
  expect(handbackState([...SAVED, call('h1'), result('h1', false)], NAME)).toBe('offered')
  expect(handbackState([...SAVED, call('h1', { message: 'r' }, 'Read'), result('h1', true)], NAME)).toBe('offered')
  expect(handbackState([...SAVED, call('h1'), result('h2', true)], NAME)).toBe('offered')
  expect(handbackState([...SAVED, call('h1')], NAME)).toBe('offered')
})

test('handbackState: a refusal is the immediately following user turn; a later error result does not count', () => {
  const between: ApiMessage[] = [{ role: 'user', content: 'wait' }, { role: 'assistant', content: 'ok' }]
  expect(handbackState([...SAVED, call('h1'), ...between, result('h1', true)], NAME)).toBe('offered')
  expect(handbackState([...SAVED, call('h1'), result('h1', true)], NAME)).toBe('refused')
})

test('handbackState: an enforce marker after a refusal offers the tool again', () => {
  const enforce: ApiMessage = { role: 'user', content: [{ type: 'text', text: '[handback-send-enforce] Call SubagentHandback.' }] }
  expect(handbackState([...SAVED, call('h1'), result('h1', true), { role: 'assistant', content: 'text' }, enforce], NAME)).toBe('offered')
  expect(handbackState([{ role: 'user', content: TASK }, enforce], NAME)).toBe('offered')
})

test('handbackState: an attachment reminder that merely mentions the tool says nothing; the engine\'s own opening does, even inside tool_result content arrays it does not', () => {
  const attachment: ApiMessage = { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nFile changed: notes.md, delivered through SubagentHandback as a note.\n</system-reminder>' }] }
  expect(handbackState([attachment], NAME)).toBe('unsaid')
  expect(handbackState([{ role: 'user', content: [{ type: 'text', text: TASK }, REMINDER] }], NAME)).toBe('offered')
  expect(handbackState([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: REMINDER.text }] }] }], NAME)).toBe('unsaid')
})

test('handbackState: consecutive assistant rows around the call do not hide the refusal in the next user turn', () => {
  const said: ApiMessage = { role: 'assistant', content: 'thinking' }
  expect(handbackState([...SAVED, said, call('h1'), said, result('h1', true)], NAME)).toBe('refused')
  expect(handbackState([...SAVED, call('h1'), said, result('h1', true)], NAME)).toBe('refused')
  expect(handbackState([...SAVED, said, call('h1'), result('h1', true)], NAME)).toBe('refused')
})

test('withoutTool drops the tool\'s calls and their results, keeps the text a call carried, and is the same array when there is nothing to drop', () => {
  const hb = (id: string, message: string): ApiMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: NAME, input: { message } }] })
  const done = (id: string): ApiMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] })
  const mixed: ApiMessage = { role: 'assistant', content: [{ type: 'text', text: 'report' }, { type: 'tool_use', id: 'a', name: NAME, input: { message: 'report' } }] }
  const more: ApiMessage = { role: 'user', content: [{ type: 'text', text: 'more' }] }
  expect(withoutTool([SAVED[0] as ApiMessage, mixed, done('a'), more], NAME)).toEqual([
    SAVED[0],
    { role: 'assistant', content: [{ type: 'text', text: 'report' }] },
    { role: 'user', content: [{ type: 'text', text: `${NAME}: ok` }, { type: 'text', text: 'more' }] },
  ])
  expect(withoutTool([SAVED[0] as ApiMessage, hb('b', 'klyth: acme HTTP 403'), done('b')], NAME)).toEqual([
    SAVED[0],
    { role: 'assistant', content: [{ type: 'text', text: 'klyth: acme HTTP 403' }] },
    { role: 'user', content: [{ type: 'text', text: `${NAME}: ok` }] },
  ])
  const keeps: ApiMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'x' }, { type: 'text', text: 'k' }] }
  expect(withoutTool([hb('c', 'm'), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }, { type: 'text', text: 'k' }] }, keeps], NAME)[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'k' }] })
  const plain = [...SAVED, call('r', { message: 'x' }, 'Read'), result('r', false)]
  expect(withoutTool(plain, NAME)).toBe(plain)
  expect(withoutTool([], NAME)).toEqual([])
})

test('withoutTool keeps the engine\'s refusal of a dropped call, a thinking-only turn and several calls in one turn as text', () => {
  const hb = (id: string, message: string): { type: string } & Record<string, unknown> => ({ type: 'tool_use', id, name: NAME, input: { message } })
  const refusal = '<tool_use_error>Error: No such tool available: SubagentHandback</tool_use_error>'
  const refused = withoutTool([SAVED[0] as ApiMessage, { role: 'assistant', content: [hb('d', 'report')] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd', is_error: true, content: refusal }] }], NAME)
  const last = refused.at(-1) as ApiMessage
  expect(last.role).toBe('user')
  expect(JSON.stringify(last.content)).toContain('No such tool available')
  const thought = { type: 'thinking', thinking: 'hm', signature: 's' }
  expect(withoutTool([{ role: 'assistant', content: [thought, hb('e', 'msg')] }], NAME)).toEqual([{ role: 'assistant', content: [thought, { type: 'text', text: 'msg' }] }])
  expect(withoutTool([{ role: 'assistant', content: [hb('f', 'one'), hb('g', 'two')] }], NAME)).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'one\n\ntwo' }] }])
  const arr = withoutTool([{ role: 'assistant', content: [hb('h', 'x')] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }], NAME)
  expect(arr[1]).toEqual({ role: 'user', content: [{ type: 'text', text: `${NAME}: a\nb` }] })
  const plain = [SAVED[0] as ApiMessage, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } as ApiMessage]
  expect(withoutTool(plain, NAME)).toBe(plain)
})

test('the first user text is the first text of the first user message that has text', () => {
  expect(firstUserText(SAVED)).toBe(TASK)
  expect(firstUserText([SAVED[2] as ApiMessage, { role: 'user', content: 'later' }])).toBe('later')
  expect(firstUserText([])).toBe('')
})
