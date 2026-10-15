// Telling native Claude when the conversation leaves a klyth route. Native Claude reads the routed turns in its
// history as its own, and rewriting stored history is not possible, so the next main prompt carries a note.
// Pure over the Session.
import type { PromptSubmitInput, PromptSubmitResult } from 'claude-code'

import type { Session } from './session'
import { labelOf, modelOf } from './ui'

// Called when main's target changes, before `s.main` takes it. The route main leaves, when it answered turns, joins
// the routes owed a note (turns on the same route one after another add up); the turn count starts again.
export function switched(s: Session, target: string | null) {
  if (target === s.main) return
  if (s.main && s.routedTurns > 0) {
    const { config } = s.loaded
    const route = { label: labelOf(config, s.main), target: modelOf(config, s.main), turns: s.routedTurns }
    const last = s.left.at(-1)
    s.left = last?.label === route.label && last.target === route.target ? [...s.left.slice(0, -1), { ...route, turns: last.turns + route.turns }] : [...s.left, route]
  }
  s.routedTurns = 0
}

// The conversation the notes are about is over (session.end: /clear, a resume, an exit), so none is owed for it.
export function ended(s: Session) {
  s.left = []
  s.routedTurns = 0
}

// main's prompt.submit: the first one that reaches a native main after routes were left carries one context block
// saying so. A routed main's prompt, and a prompt delivered into a running routed turn (a model switch made
// mid-turn leaves that turn routed), carry none and leave the note owed. A prompt that did not enter (`drop`)
// leaves the note for the next. prompt.submit has no agent field: it is main's alone.
export async function leftNote(s: Session, e: PromptSubmitInput, next: (e: PromptSubmitInput) => Promise<PromptSubmitResult>): Promise<PromptSubmitResult> {
  const running = e.turnId !== undefined && e.turnId === s.pin?.turnId && s.pin.target !== null
  if (s.left.length === 0 || s.main || running) return next(e)
  const left = s.left
  const [total, several] = [left.reduce((n, l) => n + l.turns, 0), left.length > 1]
  const by = left.map(l => `${l.label === l.target ? l.target : `${l.label} (${l.target})`}${several ? ` for ${l.turns}` : ''}`)
  const who = several ? `${by.slice(0, -1).join(', ')} and ${by.at(-1)}` : by.join('')
  const turns = total === 1 ? 'the previous assistant turn was' : `the previous ${total} assistant turns were`
  const note = `klyth: ${turns} answered by ${who} through klyth, not by you; their self-descriptions are that model's, and any Agent calls among them were mcp__klyth__agent calls it made. From here you answer as yourself.`
  const context = [...(e.context ?? []), note]
  s.left = []
  const entered = await next({ ...e, context })
  if (entered.drop !== undefined) s.left = [...left, ...s.left]
  return entered
}
