// The tools a routed subagent may be offered, and the tool.call guard that holds it to them. Claude Code builds a
// native subagent's tool pool from the context that spawned it, so a routed one is given no tool its caller lacks:
// its pool is what its agent type allows, less what the routed subagent that started it (`Route.parent`) is not
// allowed, up the chain to main, whose tools are the whole list. Pure over ports.
import { HANDBACK_TOOL, isFork, toolFilter } from './agents'
import { definitionOf } from './prompts'
import type { PromptsPort } from './prompts'
import type { RouteStore, StepIo } from './routing'
import type { Session } from './session'

// Whether the tool of a given name is one a routed subagent may be offered. It tests names alone, so main's
// tool list, which can change between steps, is read where the pool is used.
export type Pool = (tool: string) => boolean
type PoolIo = PromptsPort & Pick<RouteStore, 'route'>

// What a subagent is offered when the route of a subagent above it cannot be read: SubagentHandback, so it can
// still report, and nothing else. A pool built without that route could exceed the caller's.
const CLOSED: Pool = tool => tool === HANDBACK_TOOL.name

// The pool of `agentId` from its route (memory, else state) and the routes above it, or undefined when one of
// them is missing, native or loops. A pool is kept per agent until the agent is forgotten or the config is
// reloaded. A route read from state is not put in memory (a finished subagent above would be listed as routed
// again): only the pool drawn from it is kept.
async function derive(io: PoolIo, s: Session, agentId: string, above: ReadonlySet<string>): Promise<Pool | undefined> {
  const kept = s.pools.get(agentId)
  if (kept !== undefined) return kept
  const route = s.routes.get(agentId) ?? (await io.route(agentId))
  if (route === undefined || route.target == null || above.has(agentId)) return undefined
  const own = toolFilter(route.type, await definitionOf(io, s, route.type))
  const caller = route.parent === undefined ? undefined : await derive(io, s, route.parent, new Set([...above, agentId]))
  if (route.parent !== undefined && caller === undefined) return undefined
  // Claude Code offers a fork no SubagentHandback, so a fork's pool holds none.
  const hands = !isFork(route.type)
  const pool: Pool = tool => (tool === HANDBACK_TOOL.name ? hands : own(tool) && (caller?.(tool) ?? true))
  s.pools.set(agentId, pool)
  return pool
}

// The tools the routed subagent `agentId` may be offered: SubagentHandback, and the tools its type allows that
// the subagent which started it (if any) may be offered too. When a route above it cannot be read (it is in
// neither memory nor state, as after a reload that followed a refused write; it is native; or the chain loops),
// SubagentHandback alone, so a missing route never widens a pool; that pool is not kept, and the next step reads
// again. A rejected read of state is not caught: the step or the guard that asked fails and answers as it does
// for any internal error.
export async function poolOf(io: PoolIo, s: Session, agentId: string): Promise<Pool> {
  const pool = await derive(io, s, agentId, new Set())
  if (pool === undefined) io.debug(`klyth pool ${agentId}: the route of a subagent above it cannot be read, so it is offered SubagentHandback alone`)
  return pool ?? CLOSED
}

// Denies a routed subagent a tool its last remote step did not offer: the engine would run it, since a
// subagent's tools are cut from main's by klyth alone. Main and native agents pass. A routed agent with no
// offered set in memory (a hot reload emptied it) has its route read back from state and its set rebuilt
// from main's tools by its pool; it is denied when that cannot be done. An agent with no route in
// state is native, and kept in memory as such until it is forgotten, so its tool calls read no state again.
export async function guard(io: PoolIo & Pick<StepIo, 'list'>, s: Session, e: { tool: string; agentId?: string }): Promise<{ deny: string } | undefined> {
  if (e.agentId === undefined) return undefined
  // The engine is the authority on SubagentHandback: it runs or refuses the call itself.
  if (e.tool === HANDBACK_TOOL.name) {
    io.debug(`klyth guard ${e.agentId} SubagentHandback passed to the engine`)
    return undefined
  }
  let offered = s.offered.get(e.agentId)
  if (offered === undefined) {
    const route = s.routes.get(e.agentId) ?? (await io.route(e.agentId)) ?? { target: null, label: 'native' }
    s.routes.set(e.agentId, route)
    if (route.target == null) return undefined
    const pool = await poolOf(io, s, e.agentId)
    offered = new Set([HANDBACK_TOOL.name, ...(await io.list()).map(t => t.name)].filter(pool))
    s.offered.set(e.agentId, offered)
  }
  const allowed = offered.has(e.tool)
  io.debug(`klyth guard ${e.agentId} ${e.tool} ${allowed ? 'allowed' : 'denied'}`)
  return allowed ? undefined : { deny: `klyth: ${e.tool} is not available to the ${s.routes.get(e.agentId)?.type ?? 'general-purpose'} subagent` }
}

// What the guard answers when it fails: a deny for a routed subagent or one klyth has not cached (its route read
// may be what failed), so a failed check never lets a call through; undefined for main and for an agent known
// to be native, whose call goes on.
export function guardFailed(s: Session, e: { tool: string; agentId?: string }): { deny: string } | undefined {
  const routed = e.agentId !== undefined && (s.offered.has(e.agentId) || s.routes.get(e.agentId)?.target !== null)
  return routed ? { deny: `klyth: could not check ${e.tool} for this subagent, so it was denied; retry, or see the debug log` } : undefined
}
