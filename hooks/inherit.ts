// A plain Agent call under a routed parent. Natively a subagent with no model of its own runs on its parent's
// model, but the engine believes a routed parent is native, so klyth claims the spawn: when the parent (main
// for the turn under way, or a routed subagent) is routed, the subagent gets the parent's route, which the
// turn.step hook then answers as it answers a klyth agent tool subagent's. What the Agent tool decided itself
// stands: an explicit model, a definition's own model, a cwd, a teammate and a workflow agent stay native, and so
// does a subagent the engine resolved to any model but its parent's. So does one klyth cannot reproduce faithfully,
// which stays native with one debug line: a custom type it has no definition for (no prompt or tool list) or finds
// more than one of, a built-in type klyth cannot run (NOT_REPRODUCED), a built-in type that more than one agent file
// names, a type a hook beneath rewrote, a spawn from a subagent that works in a worktree, and an isolated subagent
// whose worktree the engine did not make.
// A fork is held to a stricter rule, because it carries its parent's whole conversation: under a routed parent it
// runs on that parent's own target, with its parent's prompt, or it is refused. It never runs natively there and
// never on another target. Only a fork whose parent is known to be native is left alone, as the engine runs it.
// Pure over a port.
import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import type { Effort, Route } from '../types'
import { FORK, isFork } from './agents'
import { EFFORTS, own } from './config'
import { resolve } from './names'
import { claimable } from './prompts'
import type { PromptsPort } from './prompts'
import type { RouteStore } from './routing'
import type { CallNote, Session } from './session'
import { persistRoute, translatedOf, unclaimable, whileSpawning } from './spawn'
import { engineWorktree } from './worktree'

export type InheritPort = PromptsPort &
  Pick<RouteStore, 'pin' | 'route' | 'setRoute' | 'translated'> & {
    // The agent type the engine started the subagent `agentId` as, when it lists it.
    agentType(agentId: string): Promise<string | undefined>
  }

const INHERIT = 'inherit'

// Keeps an Agent call's `effort` and isolation until its spawn takes them (an isolation other than
// `worktree`, such as `remote`, is one klyth cannot reproduce, so that spawn stays native): the spawn event
// carries neither. They go beside what the call already has noted (the target of a call klyth made). A call
// refused or failed is dropped by `dropCall`; any other that never spawns leaves its note behind, so only
// the latest 64 stay.
export function noteCall(s: Session, e: { tool_use_id: string; effort?: unknown; isolation?: unknown }) {
  const iso = typeof e.isolation === 'string' ? e.isolation : undefined
  const note: CallNote = {
    ...s.calls.get(e.tool_use_id),
    ...(EFFORTS.includes(e.effort as Effort) ? { effort: e.effort as Effort } : {}),
    ...(iso === 'worktree' ? { isolated: true } : iso === undefined ? {} : { elsewhere: iso }),
  }
  if (Object.keys(note).length > 0) s.note(e.tool_use_id, note)
}

// Forgets the note of an Agent call whose result is a refusal or an error: no spawn follows it.
export function dropCall(s: Session, e: { tool_use_id: string }, result: { deny?: unknown; isError?: unknown }) {
  if (result.deny !== undefined || result.isError === true) s.calls.delete(e.tool_use_id)
}

type ParentRoute = Pick<Route, 'target' | 'effort' | 'worktree' | 'wasIsolated'>

// The route the spawning agent runs on, with no `route` when it is native: main's for the turn under way (its
// pin, else the persisted one), or the route of the subagent that spawns (a subagent klyth holds no route for runs
// natively). `unreadable` says why it is not known: a read that failed, or main with no pin recorded. A plain spawn
// takes that as native, as it always has; a fork is refused on it, since it may carry a routed conversation.
async function parentRoute(io: Pick<InheritPort, 'pin' | 'route'>, s: Session, parent: string | undefined): Promise<{ route?: ParentRoute } | { unreadable: string }> {
  try {
    if (parent !== undefined) {
      const route = s.routes.get(parent) ?? (await io.route(parent))
      return route === undefined ? {} : { route }
    }
    const pin = s.pin ?? (await io.pin())
    if (pin === null || pin === undefined) return { unreadable: "main's route for this turn is not recorded" }
    return pin.target === null ? {} : { route: { target: pin.target } }
  } catch (err) {
    return { unreadable: String(err) }
  }
}

// The klyth target a native Agent fork call `e` would be claimed on: its type is a fork (any spelling isFork reads) and
// its parent (main for the turn under way (pin), or the subagent that calls (route)) runs on a klyth target that can be
// read. Such a fork is claimed on that target or refused at its spawn, never run natively, so the auto-mode check may
// allow it as it allows a call klyth made. Undefined for any other type, a native parent, or a parent whose route cannot be read.
export async function routedFork(io: Pick<InheritPort, 'pin' | 'route'>, s: Session, e: { input?: unknown; agentId?: string }): Promise<string | undefined> {
  if (!isFork((e.input as Record<string, unknown> | undefined)?.['subagent_type'])) return undefined
  const read = await parentRoute(io, s, e.agentId)
  return 'route' in read && typeof read.route?.target === 'string' ? read.route.target : undefined
}

// The line a fork under a routed parent is refused with, before it starts, and the one its first step hands back
// when it started but could not be claimed. Either way it does not run, natively or on another target.
const forkDenied = (why: string) => `klyth: this fork was refused: ${why}; a fork runs only on its parent's model, never natively under a routed parent`
const forkElsewhere = (asked: string | null, at: string | null) => forkDenied(`it was asked for on ${asked ?? 'a native model'}, but its parent runs on ${at ?? 'a native model'}`)

// A model id without its context-size suffix (`[1m]`), lowercase.
const bare = (model: string) => model.replace(/\[[^\]]*\]$/, '').trim().toLowerCase()
const sameModel = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && bare(a) === bare(b)

// The note of an Agent call klyth made whose note is gone from memory (a hot reload, or the cap): the target of
// the model the call's record in state names; a refusal when that model no longer resolves. Undefined for a
// call that has no record, which is any other Agent call.
async function recovered(io: InheritPort, s: Session, e: AgentSpawnInput): Promise<{ target: string | null } | { deny: string } | undefined> {
  const model = own(await translatedOf(io, s, e.parentAgentId ?? 'main'), e.tool_use_id)
  if (model === undefined) return undefined
  const t = s.loaded.config === undefined ? undefined : resolve(s.loaded.config, model)
  if (t === undefined) return { deny: `klyth agent: ${model} is not configured any more, so the subagent did not start; fix ${s.loaded.path} and ask again` }
  return { target: t.kind === 'remote' ? t.label : null }
}

// An agent.spawn: `spawn` starts the subagent beneath (with the event it is given), and `origin` names the
// plugin that raised the spawn. Only the Agent tool's own (`engine`) is claimed, never klyth's agent tool's. A
// subagent that claims a route has it written in memory before its first step looks, then persisted like the
// klyth agent tool's. A subagent isolated by the call (`isolation: "worktree"`) or by its definition's
// frontmatter is claimed only when the engine made its worktree, which then is the route's `worktree`: the
// directory the subagent's prompt names as its own. The route of a child of a subagent names it as `parent`
// (a child of main has none), which holds the child's tools within the parent's (pool.ts). A call noted with a
// klyth target (an Agent call klyth made of a klyth agent call) is claimed for that target, whatever its parent
// runs on, and started on its parent's engine model; when klyth cannot claim it before it starts, the spawn is
// denied with one line. A fork under a routed parent is claimed on that parent's target alone, whatever was noted
// for it, with the parent's effort (the engine ignores a fork's own); what stops the claim refuses it, before it
// starts or at its first step, and a parent whose route cannot be read refuses it too.
export async function inheritSpawn(io: InheritPort, s: Session, e: AgentSpawnInput, origin: string, spawn: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> {
  let note = s.calls.get(e.tool_use_id)
  s.calls.delete(e.tool_use_id)
  // The model's own Agent call: the engine's, or one the engine attributes to klyth because the loop it was made in
  // was started by klyth's own spawn (every dispatch of that loop carries klyth as its origin); klyth's own spawn is
  // the one with no parent loop.
  const own = origin === 'engine' || (origin === 'klyth' && e.parentAgentId !== undefined)
  if (note?.target === undefined && own && e.workflow === undefined) {
    const back = await recovered(io, s, e)
    if (back !== undefined && 'deny' in back) return back
    if (back !== undefined) note = { ...note, ...back }
  }
  // The engine starts any spelling of `fork` as a fork; either sign makes this spawn one.
  const fork = e.fork || isFork(e.subagentType)
  // A fork takes no model of its own (the engine ignores it), so a fork is as plain as a call that names none.
  const plain = own && (e.model === undefined || e.model === INHERIT || fork) && e.isTeammate === undefined && e.workflow === undefined
  const read = plain || fork ? await parentRoute(io, s, e.parentAgentId) : {}
  const parent = 'route' in read ? read.route : undefined
  const noted = own ? note?.target : undefined
  if (fork) {
    if ('unreadable' in read) {
      io.debug(`klyth inherit: the route of the parent of a fork cannot be read (${read.unreadable}); the call is refused`)
      return { deny: forkDenied(`klyth cannot read its parent's route (${read.unreadable}); retry`) }
    }
    // A noted target is what a klyth agent call asked for; a fork takes its parent's model only, so any other is refused.
    if (noted !== undefined && noted !== (parent?.target ?? null)) return { deny: forkElsewhere(noted, parent?.target ?? null) }
    if ((parent?.target ?? null) === null) return spawn(e)
  }
  // The target a spawn must run on or be refused: a fork's parent's, else the one a klyth agent call asked for.
  const chosen = fork ? (parent?.target ?? undefined) : typeof noted === 'string' ? noted : undefined
  const effort = fork ? parent?.effort : note?.effort
  const target = chosen ?? parent?.target ?? null
  // The child's prompt would name the session's directory, not its parent's worktree or the call's cwd, and its
  // edits would leave that directory: a child of a subagent that works in a worktree (or worked in one that is
  // gone, as a resumed subagent did), and a call that sets a cwd, are left to the engine, and a fork is refused.
  const unlike =
    (parent?.worktree !== undefined || parent?.wasIsolated === true
      ? 'is spawned by a subagent in a worktree'
      : e.cwd !== undefined
        ? `sets its own cwd (${e.cwd})`
        : note?.elsewhere !== undefined
          ? `runs isolated as ${note.elsewhere}`
          : fork && note?.isolated === true
            ? 'asks for a worktree, and a fork cannot be isolated through klyth'
            : undefined) ?? (chosen !== undefined && !plain ? (fork ? "is a teammate, a workflow agent or another plugin's spawn" : 'is a teammate or a workflow agent') : undefined)
  const fate = chosen === undefined ? 'it stays native' : 'the call is refused'
  const after = chosen === undefined ? 'it stays native' : 'its first step hands the failure back'
  if (target !== null && unlike !== undefined) io.debug(`klyth inherit: ${e.subagentType} ${unlike}; ${fate}`)
  if (fork && unlike !== undefined) return { deny: forkDenied(`it ${unlike}`) }
  const asked = target === null ? undefined : unlike !== undefined ? { no: unlike } : await claimable(io, s, e.subagentType, fate, chosen !== undefined)
  if (target === null || asked === undefined || 'no' in asked) {
    if (chosen !== undefined && asked !== undefined && 'no' in asked) return { deny: unclaimable(e.subagentType, asked.no, chosen) }
    return spawn(e)
  }
  const { started, claim } = await whileSpawning(s, async (started): Promise<{ started: AgentSpawnResult; claim?: { id: string; route: Route } }> => {
    const spawned = await spawn(typeof noted === 'string' ? { ...e, model: e.parentModel } : e)
    if (spawned.agentId !== undefined) started(spawned.agentId)
    // A started subagent klyth cannot claim runs native when it inherits a route; one asked for on a klyth model, and
    // a fork under a routed parent, are given a route that refuses, so the first step hands `why` back as its report
    // instead of answering on the engine's model. Native would not be what the caller asked for, and a fork would
    // carry a routed conversation there.
    const unclaimed = (why: string) => {
      const id = spawned.agentId
      if (chosen === undefined || id === undefined) return { started: spawned }
      const refused = fork ? forkDenied(`${why}, so klyth did not run it on ${chosen}`) : `klyth agent: ${why}, so klyth did not run the subagent on ${chosen}; retry, or use a native model`
      const route: Route = { target: chosen, label: chosen, type: fork ? FORK : e.subagentType, prompt: e.prompt, refused }
      s.routes.set(id, route)
      return { started: spawned, claim: { id, route } }
    }
    if (spawned.agentId === undefined || !sameModel(spawned.model, e.parentModel)) {
      // Nothing started, or (for any spawn but a fork, which must not run unclaimed) the engine named no model.
      if (spawned.agentId === undefined || (spawned.model === undefined && !fork)) return { started: spawned }
      const on = spawned.model === undefined ? 'named no model' : `resolved ${spawned.model}`
      io.debug(`klyth inherit: the engine ${on} for ${e.subagentType}, not its parent's ${e.parentModel}; ${after}`)
      return unclaimed(spawned.model === undefined ? 'the engine did not say which model it started it on' : `the engine started it on ${spawned.model}, not its parent's ${e.parentModel}`)
    }
    const id = spawned.agentId
    // A hook beneath this one may have rewritten the agent type, which the engine lists as it started it. klyth
    // checked the type of the call only, so a type that differs is not claimed.
    const listed = await io.agentType(id).catch(() => undefined)
    if (listed !== undefined && (fork ? !isFork(listed) : listed !== e.subagentType)) {
      io.debug(`klyth inherit: a hook changed ${e.subagentType} to ${listed}; ${after}`)
      return unclaimed(`a hook changed ${e.subagentType} to ${listed}`)
    }
    const isolated = note?.isolated === true || asked.isolated
    const worktree = isolated ? await engineWorktree(io, id) : undefined
    if (isolated && worktree === undefined) {
      io.debug(`klyth inherit: the engine made no worktree for ${id} (${e.subagentType}); ${after}`)
      return unclaimed('the engine made no worktree for the isolated subagent')
    }
    const route: Route = { target, label: target, type: fork ? FORK : e.subagentType, prompt: e.prompt, ...(effort === undefined ? {} : { effort }), ...(worktree === undefined ? {} : { worktree }), ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }), ...(fork ? { forkOf: e.tool_use_id } : {}) }
    s.routes.set(id, route)
    // An Agent call that spent a fresh classifier allow on this very task vets it: the subagent's classifier counts it as a request.
    if (note?.vetted === e.prompt) s.vettedSpawns.add(id)
    return { started: spawned, claim: { id, route } }
  }, chosen, fork)
  if (claim !== undefined) {
    const { id, route } = claim
    if (route.refused === undefined) io.debug(`klyth spawn ${id} → ${target} ${typeof noted === 'string' ? 'requested' : 'inherited'} by ${route.type} from ${e.parentAgentId ?? 'main'} effort=${effort ?? 'none'}${route.worktree ? ` cwd=${route.worktree.path}` : ''}`)
    await persistRoute(io, id, route)
  }
  return started
}
