// The messages a routed loop is sent (historyOf, asSent), and how a routed fork's are rebuilt. Natively a fork
// continues its parent's conversation: the parent's history up to and including the assistant turn whose Agent call
// started the fork, then the fork's own turns. Claude Code saves a fork of main as its own messages alone, with only a
// link to main, so the engine's read of such a fork lacks main's history. klyth rebuilds it from the parent's read, cut
// at the turn that holds the call recorded at the claim (`Route.forkOf`), keeps the rebuilt prefix from the fork's
// first step (a later /compact of the parent does not stop a running fork), and refuses to send a fork's request that
// it cannot rebuild or that does not hold together. Pure over ports.
import type { Route } from '../types'
import { FORK_REPORT, HANDBACK_TOOL, isFork } from './agents'
import type { Target } from './config'
import { withIdentity } from './prompts'
import type { ApiMessage } from './protocol'
import type { RouteStore, Transcripts } from './routing'
import type { Session } from './session'
import { blocksOf, str, withoutTool, withTask } from './transcript'

type Block = ReturnType<typeof blocksOf>[number]
export type ForkIo = Transcripts & Pick<RouteStore, 'route'>

// The line a fork's step fails with when its history cannot be rebuilt.
export const FORK_HISTORY = "klyth: this fork's inherited history could not be read, so the step was not sent; use another subagent_type than fork"
// What a rebuilt fork reads as the result of each call in the turn that started it, when its own read has none.
const FORK_STARTED = 'The fork started and runs in the background.'
// What it reads as the result of a call of that turn that is not the fork's own, when the parent's next turn has none.
const FORK_UNANSWERED = 'This call was made by the conversation that started the fork; its result is not available to the fork.'
// How far up a chain of forks klyth follows parents: further is taken as a loop.
const FORK_DEPTH = 16

const isResult = (b: Block) => b.type === 'tool_result'
const usesOf = (m: ApiMessage | undefined) => (m?.role === 'assistant' ? blocksOf(m).flatMap(b => (b.type === 'tool_use' ? [str(b['id'])] : [])) : [])
// The index of the assistant turn that holds the tool_use `id`, or -1.
const holding = (messages: readonly ApiMessage[], id: string) => messages.findIndex(m => usesOf(m).includes(id))

// The route a fork's prompt comes from: its nearest ancestor that is not a fork (a fork of a fork has its
// grandparent's), absent when that is main. Undefined when a route above cannot be read, or the chain loops.
export async function forkParent(io: Pick<RouteStore, 'route'>, s: Session, route: Route): Promise<{ route?: Route } | undefined> {
  let at = route
  for (let hops = 0; isFork(at.type); hops++) {
    if (at.parent === undefined) return {}
    const up = hops < FORK_DEPTH ? (s.routes.get(at.parent) ?? (await io.route(at.parent))) : undefined
    if (up === undefined) return undefined
    at = up
  }
  return { route: at }
}

// Messages with no two of one role in a row: a run of one role is joined into one message, its tool results first
// (the Messages API takes them only at the head of a user turn). A transcript that already alternates is returned as is.
export function alternate(messages: readonly ApiMessage[]): readonly ApiMessage[] {
  if (messages.every((m, i) => messages[i - 1]?.role !== m.role)) return messages
  const out: ApiMessage[] = []
  for (const m of messages) {
    const last = out.at(-1)
    if (last?.role !== m.role) {
      out.push(m)
      continue
    }
    const blocks = [...blocksOf(last), ...blocksOf(m)]
    out[out.length - 1] = { role: m.role, content: m.role === 'user' ? [...blocks.filter(isResult), ...blocks.filter(b => !isResult(b))] : blocks }
  }
  return out
}

// Whether messages make a request the Messages API takes: they open on a user turn with no tool result, alternate,
// and pair every tool call of an assistant turn with a result in the next turn and every result with a call in the
// turn before.
export function wellFormed(messages: readonly ApiMessage[]): boolean {
  if (messages[0]?.role !== 'user') return false
  return messages.every((m, i) => {
    const before = messages[i - 1]
    if (before?.role === m.role) return false
    if (m.role === 'assistant') return true
    const results = blocksOf(m).flatMap(b => (isResult(b) ? [str(b['tool_use_id'])] : []))
    const uses = usesOf(before)
    return results.every(id => uses.includes(id)) && uses.every(id => results.includes(id))
  })
}

// The fork's own turns joined after `cut`, the assistant turn that started it: the first user turn of `tail` carries
// a result for each call of `cut`. For the call `forkOf` that started the fork: its own where it has one, else
// FORK_STARTED (the result in `after`, the parent's turn after `cut`, acknowledges the launch to the parent, not
// to the fork). For any other call: its own, else the one in `after`, else FORK_UNANSWERED. It drops a result for any other
// call, and keeps its text, or is given `task` when it has none, then `extra`. A tail that opens on no user turn gets one.
export function seam(cut: ApiMessage, after: ApiMessage | undefined, tail: readonly ApiMessage[], task: string | undefined, extra: readonly string[], forkOf: string): ApiMessage[] {
  const [first, ...rest] = tail
  const opening = first?.role === 'user' ? blocksOf(first) : []
  const next = after?.role === 'user' ? blocksOf(after) : []
  const resultOf = (blocks: readonly Block[], id: string) => blocks.find(b => isResult(b) && str(b['tool_use_id']) === id)
  const results = usesOf(cut).map(id => resultOf(opening, id) ?? (id === forkOf ? undefined : resultOf(next, id)) ?? { type: 'tool_result', tool_use_id: id, content: id === forkOf ? FORK_STARTED : FORK_UNANSWERED })
  const others = opening.filter(b => !isResult(b))
  const said = others.some(b => b.type === 'text') || (task?.trim() ?? '') === '' ? others : [...others, { type: 'text', text: task as string }]
  const opened: ApiMessage = { role: 'user', content: [...results, ...said, ...extra.map(text => ({ type: 'text', text }))] }
  return [opened, ...(first?.role === 'user' ? rest : tail)]
}

// The history a routed fork (`who`, on `route`) is sent, from its own read `own`; undefined when it cannot be
// rebuilt whole, which fails the step.
// - A fork of a subagent that is not a fork: the engine's read of it holds the inherited history and the turn that
//   started it, so it is sent as read, its joining turn closed by `extra`.
// - A fork of main or of another fork: its parent's history (main's read, or the parent fork's rebuilt history) up to
//   and including the turn that holds `forkOf`, then its own turns after that turn (all of them when its read lacks
//   the turn), joined by `seam`, whose joining turn closes with `extra`. The parent's history through the turn after
//   the cut is kept at the first rebuild (`Session.forkPrefixes`) and used from then on, so a parent that has since
//   been compacted does not stop the fork.
// Every fork is told there how it reports (FORK_REPORT), so its system prompt is its parent's, composed for the tools
// it is offered. A route with no `forkOf`, a parent route or read that cannot be had, a parent history without the
// turn, and a result that is not well formed are all undefined (nothing is kept then).
export async function forkHistory(io: ForkIo, s: Session, who: string, route: Route, own: readonly ApiMessage[], extra: readonly string[], depth = 0): Promise<readonly ApiMessage[] | undefined> {
  const at = route.forkOf
  if (at === undefined || depth > FORK_DEPTH) return undefined
  const parent = route.parent === undefined ? undefined : (s.routes.get(route.parent) ?? (await io.route(route.parent).catch(() => undefined)))
  if (route.parent !== undefined && parent === undefined) return undefined
  const inherits = parent !== undefined && !isFork(parent.type)
  const ownCut = holding(own, at)
  if (inherits && ownCut >= 0) {
    const whole = alternate([...own.slice(0, ownCut + 1), ...seam(own[ownCut] as ApiMessage, undefined, own.slice(ownCut + 1), route.prompt, extra, at)])
    return wellFormed(whole) ? whole : undefined
  }
  const kept = s.forkPrefixes.get(who)
  let above: readonly ApiMessage[] | undefined = kept?.messages
  let cut = kept?.cut ?? -1
  if (kept === undefined) {
    const read = await io.transcript(route.parent).catch(() => undefined)
    if (!Array.isArray(read)) return undefined
    above =
      parent !== undefined && isFork(parent.type)
        ? await forkHistory(io, s, route.parent as string, parent, read, extra, depth + 1)
        : inherits ? withTask(read, parent?.prompt) : read
    cut = above === undefined ? -1 : holding(above, at)
  }
  if (above === undefined || cut < 0) return undefined
  const after = above[cut + 1]
  const joined = alternate([...above.slice(0, cut + 1), ...seam(above[cut] as ApiMessage, after, ownCut >= 0 ? own.slice(ownCut + 1) : own, route.prompt, extra, at)])
  if (!wellFormed(joined)) return undefined
  // Only the fork itself keeps a prefix; a parent fork rebuilt on its behalf does not.
  if (kept === undefined && depth === 0) s.forkPrefixes.set(who, { messages: above.slice(0, cut + 2), cut })
  return joined
}

// The history a routed loop (main, or the subagent `agentId` on `route`) is sent, from its read `read`: a fork's
// rebuilt as above and told there how it reports; any other loop's as read, a subagent's opening on its task.
// Undefined when a fork's cannot be rebuilt.
export async function historyOf(io: ForkIo, s: Session, agentId: string | undefined, route: Route | undefined, read: readonly ApiMessage[]): Promise<readonly ApiMessage[] | undefined> {
  if (route !== undefined && isFork(route.type)) return forkHistory(io, s, agentId ?? 'main', route, read, [FORK_REPORT])
  return agentId === undefined ? read : withTask(read, route?.prompt)
}

// A history as a request to `t` carries it: Claude Code's line naming the model it runs on names `t`'s model, and a
// model offered no tools is sent no SubagentHandback call.
export const asSent = (history: readonly ApiMessage[], t: Extract<Target, { kind: 'remote' }>) => withIdentity(t.model.tools ? history : withoutTool(history, HANDBACK_TOOL.name), t.model.id, t.provider.id)
