// A native main step's klyth agent calls, made Agent calls before the engine runs them, as a routed step's are
// (`translateUse`): one spawn path for every main, so the engine runs, draws and reports the subagent as its own and
// the agent.spawn hook claims it on its target. From the first klyth agent call on, the step's chunks are held until
// it ends, then sent on with each call rewritten. A call stays as the model made it, and the tool answers it as
// before, when the check on the tool is not an allow or Claude Code's own ask for a tool nobody granted (the Agent
// call's check stands in for that one; a rule's or a plugin hook's ask keeps the call), `translate` refuses it (an
// unapproved provider among others, which the tool asks for), Agent is not offered, its input does not parse, or a
// port fails for it. A query runs no classic hook, so a PreToolUse hook on the tool meets the Agent call instead, as on
// a routed main. Pure over ports.
import type { TurnStepChunk, TurnStepResult } from 'claude-code'

import { isObject } from './config'
import { PRODUCT } from './product'
import type { Session } from './session'
import { remember, translate } from './spawn'
import type { RememberPort } from './spawn'

type Step = AsyncGenerator<TurnStepChunk, TurnStepResult>
type Verdict = { decision: string; reason?: string; rule?: string }
export type NativeIo = RememberPort & { list(): Promise<readonly { name: string }[]>; check?(e: { tool: string; input: unknown }): Promise<Verdict> }

const WRAPPER = PRODUCT.qualifiedTool
// Claude Code's ask for a tool no rule grants, as 2.1.299 words it; another wording keeps every ask on the tool.
const UNGRANTED = `Claude requested permissions to use ${WRAPPER}, but you haven't granted it yet.`
const rewritable = (v: Verdict | undefined) => v === undefined || v.decision === 'allow' || (v.decision === 'ask' && v.rule === undefined && v.reason === UNGRANTED)
const isWrapper = (c: TurnStepChunk) => c.kind === 'tool' && c.name === WRAPPER

export async function* nativeMain(io: NativeIo, s: Session, native: () => Step): Step {
  const it = native()
  const held: TurnStepChunk[] = []
  const at = new Map<number, number>() // a tool block's index → its place among the step's tool calls
  let n = await it.next()
  try {
    for (; !n.done; n = await it.next()) {
      if (n.value.kind === 'tool') at.set(n.value.index, at.size)
      if (held.length === 0 && !isWrapper(n.value)) yield n.value
      else held.push(n.value)
    }
  } finally {
    if (!n.done) await it.return(undefined as never) // a consumer that stopped reading closes the step beneath
  }
  if (held.length === 0) return n.value
  let made = new Map<number, Record<string, unknown>>()
  try {
    made = await rewrite(io, s, held)
  } catch (err) {
    io.debug(`klyth: main's klyth agent calls were left as they were (${String(err)}); the tool answers them`)
  }
  const sent = new Set<number>()
  for (const c of held) {
    const input = c.kind === 'tool' || c.kind === 'input' ? made.get(c.index) : undefined
    if (input === undefined) yield c
    else if (c.kind === 'tool') yield { ...c, name: 'Agent' }
    else if (c.kind === 'input') {
      yield { ...c, json: sent.has(c.index) ? '' : JSON.stringify(input) }
      sent.add(c.index)
    }
  }
  const byPlace = new Map([...made].map(([index, input]) => [at.get(index), input]))
  return { ...n.value, toolUses: n.value.toolUses.map((u, k) => byPlace.get(k) === undefined ? u : { name: 'Agent', input: byPlace.get(k) }) }
}

// The Agent input of each held klyth agent call that becomes one, by its block index.
async function rewrite(io: NativeIo, s: Session, held: readonly TurnStepChunk[]): Promise<Map<number, Record<string, unknown>>> {
  const made = new Map<number, Record<string, unknown>>()
  if (!(await io.list()).some(t => t.name === 'Agent')) return made
  for (const c of held) {
    if (c.kind !== 'tool' || c.name !== WRAPPER) continue
    try {
      const input: unknown = JSON.parse(held.map(x => (x.kind === 'input' && x.index === c.index ? x.json : '')).join(''))
      if (!isObject(input) || !rewritable(await io.check?.({ tool: WRAPPER, input }))) continue
      const done = await translate(io, s, { run_in_background: true, ...input }, null)
      if ('deny' in done) continue
      await remember(io, s, 'main', c.id, done, typeof input['prompt'] === 'string' ? input['prompt'] : undefined)
      made.set(c.index, done.use.input)
    } catch (err) {
      io.debug(`klyth: main's klyth agent call ${c.id} was left as it was (${String(err)}); the tool answers it`)
    }
  }
  return made
}
