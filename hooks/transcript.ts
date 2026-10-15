// Reading the engine's transcript where routing needs it: the first user text, a subagent's opening task,
// whether the engine delivers its report through SubagentHandback or has refused a call of it; the
// text of a value, and a message's blocks, which klythd reads the transcript by too. Pure.
import { isObject } from './config'
import type { ApiMessage } from './protocol'

type Block = { type: string } & Record<string, unknown>

export const str = (v: unknown) => (typeof v === 'string' ? v : '')
// A message's blocks; a message whose content is text rather than blocks is one text block.
export const blocksOf = (msg: ApiMessage): readonly Block[] => (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content)

// The first text of the transcript's first user message that has text, or ''.
export function firstUserText(messages: readonly ApiMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const text = blocksOf(msg).find(b => b.type === 'text' && typeof b['text'] === 'string')
    if (text !== undefined) return text['text'] as string
  }
  return ''
}

// A subagent's transcript, opening on a user turn. The engine's read of an agent is the transcript the
// session saved for it plus what its loop has produced since, so where no transcript is saved (a session
// run without persistence) it holds no opening user turn; `task`, the prompt klyth gave the spawn, then
// opens the transcript. A transcript the engine opens on a user turn (the task as the engine started the
// agent with it, whatever another hook made of it, or a compaction summary) is returned as is.
export function withTask(messages: readonly ApiMessage[], task: string | undefined): readonly ApiMessage[] {
  if ((task?.trim() ?? '') === '' || messages[0]?.role === 'user') return messages
  return [{ role: 'user', content: [{ type: 'text', text: task as string }] }, ...messages]
}

// Whether the engine delivers a subagent's report through the tool `name`, from its transcript. 'unsaid': the engine
// has not said so (a user turn's own text block opening on a system-reminder that names the tool, or on the
// enforce marker), so the tool does not exist for the agent. 'refused': since the last such marker the engine
// answered a schema-valid call of the tool, in the very next user turn, with an error. Else 'offered'. Never
// reads inside a tool_result.
export function handbackState(messages: readonly ApiMessage[], name: string): 'offered' | 'unsaid' | 'refused' {
  let said = false
  let refused = false
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      if (blocksOf(m).some(b => b.type === 'text' && isSaying(str(b['text']).trim(), name))) {
        said = true
        refused = false
      }
      return
    }
    const ids = new Set(blocksOf(m).flatMap(b => (b.type === 'tool_use' && b['name'] === name && isObject(b['input']) && typeof b['input']['message'] === 'string' ? [str(b['id'])] : [])))
    const next = messages.slice(i + 1).find(x => x.role === 'user')
    if (ids.size > 0 && next !== undefined && blocksOf(next).some(b => b.type === 'tool_result' && ids.has(str(b['tool_use_id'])) && b['is_error'] === true)) refused = true
  })
  return !said ? 'unsaid' : refused ? 'refused' : 'offered'
}
const isSaying = (text: string, name: string) => text.startsWith(`<system-reminder>\nYour final report is delivered through ${name}`) || text.startsWith('[handback-send-enforce]')

// A transcript without klyth's own calls of the tool `name`, for a model offered no tool: each such call and its result is
// dropped. An assistant turn left with no text says what its calls carried, as text; a user turn left with no block says
// what the engine answered, as text, so the request still ends on a user turn and a refusal is not lost (it is joined to
// the user turn after it). The same array when nothing changed.
export function withoutTool(messages: readonly ApiMessage[], name: string): readonly ApiMessage[] {
  const dropped = new Set<string>()
  const made = new Set<ApiMessage>()
  let changed = false
  const out: ApiMessage[] = []
  const push = (m: ApiMessage) => {
    const last = out.at(-1)
    if (last === undefined || !made.has(last) || last.role !== 'user' || m.role !== 'user') return void out.push(m)
    const blocks = [...blocksOf(last), ...blocksOf(m)]
    out[out.length - 1] = { role: 'user', content: [...blocks.filter(b => b.type === 'tool_result'), ...blocks.filter(b => b.type !== 'tool_result')] }
  }
  for (const m of messages) {
    if (typeof m.content === 'string') {
      push(m)
      continue
    }
    const said: string[] = []
    const answered: string[] = []
    const content = m.content.filter(b => {
      if (m.role === 'assistant' && b.type === 'tool_use' && b['name'] === name) {
        dropped.add(str(b['id']))
        said.push(isObject(b['input']) ? str(b['input']['message']) : '')
        return false
      }
      if (m.role === 'user' && b.type === 'tool_result' && dropped.has(str(b['tool_use_id']))) {
        const c = b['content']
        answered.push(typeof c === 'string' ? c : Array.isArray(c) ? c.flatMap(x => (isObject(x) && x['type'] === 'text' ? [str(x['text'])] : [])).join('\n') : '')
        return false
      }
      return true
    })
    if (content.length === m.content.length) {
      push(m)
      continue
    }
    changed = true
    if (m.role === 'assistant') {
      const text = said.filter(x => x !== '').join('\n\n')
      push({ ...m, content: content.some(b => b.type === 'text') || (text === '' && content.length > 0) ? content : [...content, { type: 'text', text }] })
    } else if (content.length > 0) push({ ...m, content })
    else {
      const turn: ApiMessage = { role: 'user', content: [{ type: 'text', text: `${name}: ${answered.join('\n')}` }] }
      made.add(turn)
      push(turn)
    }
  }
  return changed ? out : messages
}
