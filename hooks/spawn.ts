// The klyth agent tool (`mcp__klyth__agent`). In a conversation klyth routes (main or a subagent), a call is
// made an Agent call before the engine sees it (`translate`), which the engine runs from the calling loop
// and the agent.spawn hook (inherit.ts) claims; the tool itself, for a native main, checks a call, makes
// the worktree an isolated subagent works in, spawns the subagent on its model and records its route. Also
// the cleanup when a routed subagent finishes. A call is held to the same rules on either path: a native main's
// call is checked as the Agent call of a routed one is when it spawns (`claimable`). Pure over ports.
import type { AgentSpawnArgs, AgentSpawnResult } from 'claude-code'

import type { Effort, Route, Worktree } from '../types'
import { modelNames } from './advert'
import { FORK, isFork } from './agents'
import { EFFORTS, NATIVE_MODELS } from './config'
import type { ProviderConfig, Target } from './config'
import { resolve } from './names'
import { claimable, resolveType } from './prompts'
import type { PromptsPort } from './prompts'
import { ROUTED_ID } from './protocol'
import type { StepEvent } from './protocol'
import type { RouteStore, Say } from './routing'
import type { CallNote, Session } from './session'
import { ensureTrust, isTrusted } from './trust'
import type { TrustPort } from './trust'
import { makeWorktree, settleWorktree } from './worktree'
import type { WorktreePort } from './worktree'

export const NATIVE_SUB = 'klyth agent: not available from a native subagent or from inside a spawn; use Agent here'
const FORK_NATIVE = "klyth agent: a fork runs on its parent's model, and this conversation is native; to fork natively use Agent"
const FORK_UNTRANSLATED = 'klyth agent: this fork could not be made an Agent call, so it did not start (see the debug log); retry, or fork with Agent'
const FORK_ISOLATED = 'klyth agent: a fork cannot be isolated through klyth; omit isolation'
const forkOther = (caller: string, model: string) => `klyth agent: a fork runs on its parent's model (${caller}), not on ${model}; omit model, or name ${caller}`
const NATIVE_EFFORT_DENY = 'klyth agent: effort cannot be set for a native model through klyth; omit effort, or use Agent'
const BAD_INPUT =
  'klyth agent: invalid input: prompt and description must be text, subagent_type and name text when given, effort one of low, medium, high, xhigh, max, run_in_background true or false'
const FOREGROUND = 'klyth agent: run_in_background false needs a conversation that klyth routes; omit it, and the subagent runs in the background'
const NOT_STARTED = 'klyth agent: the subagent did not start; retry, or use Agent'
export const AGENT_INTERNAL = 'klyth agent: internal error (see the debug log); use Agent'

// The agent type the engine started the subagent `agentId` as, when it lists it.
export type AgentTypes = { agentType(agentId: string): Promise<string | undefined> }
export type AgentPort = TrustPort & WorktreePort & PromptsPort & AgentTypes & Pick<RouteStore, 'route' | 'setRoute'> & { spawn(args: AgentSpawnArgs): Promise<AgentSpawnResult> }

// Why a subagent of `type` cannot run on the klyth model `label`, for `no` as `claimable` gives it: the line a plain
// Agent call under a routed parent is refused with, which the klyth agent tool says too.
export const unclaimable = (type: string, no: string, label: string) => `klyth agent: ${type} ${no}, so klyth cannot run it on ${label}; use another subagent_type or a native model`

const isText = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string'

// Runs `start`, which spawns a subagent and writes its route into memory, with the spawn barrier raised: a
// step of the new subagent waits for `start` to settle before it looks its route up. `requested` names the
// klyth target of a subagent a klyth agent call asked for, or of a fork under a routed parent (`fork`), which
// `unstarted` refuses a step for rather than run native.
export async function whileSpawning<T>(s: Session, start: (started: (id: string) => void) => Promise<T>, requested?: string, fork = false): Promise<T> {
  let settle = () => {}
  const barrier = new Promise<void>(resolve => (settle = resolve))
  s.pendingSpawns.add(barrier)
  const entry: { target: string; id?: string; fork?: boolean } | undefined = requested === undefined ? undefined : { target: requested, ...(fork ? { fork } : {}) }
  if (entry !== undefined) s.requested.set(barrier, entry)
  try {
    return await start(id => void (entry !== undefined && (entry.id = id)))
  } finally {
    settle()
    s.pendingSpawns.delete(barrier)
    s.requested.delete(barrier)
  }
}

// The route of a step of `agentId` that gave up waiting for a spawn while the one asked for on a klyth target that
// started it was still being claimed: a route that refuses, so the step hands one line back rather than run native
// on the engine's model. Undefined for any other agent, whose step goes on as before: a spawn whose id is not yet
// known has most likely not started its subagent. A fork is held closer, by `unclaimedFork`, because a native step
// of a fork would carry a routed conversation.
export function unstarted(s: Session, agentId: string): Route | undefined {
  for (const r of s.requested.values()) if (r.id === agentId) return { target: r.target, label: r.target, ...(r.fork ? { type: FORK } : {}), refused: r.fork ? forkStarting(r.target) : `klyth agent: the subagent on ${r.target} was still starting, so this step was not run; retry` }
  return undefined
}

const forkStarting = (target: string) => `klyth: this fork of a conversation on ${target} was still being claimed, so its step was not run natively; retry`

// The route of a step that gave up waiting while a fork under a routed parent was being claimed and its id is not
// yet known: a fork carries its parent's whole conversation, so a step that may be the fork's must not run native.
// The engine's list tells the step's agent type; a step it lists as no fork goes on as before (undefined), and one
// it lists as a fork, or does not list, is refused.
export async function unclaimedFork(io: AgentTypes, s: Session, agentId: string): Promise<Route | undefined> {
  const pending = [...s.requested.values()].find(r => r.fork === true && r.id === undefined)
  if (pending === undefined) return undefined
  const type = await io.agentType(agentId).catch(() => undefined)
  return type !== undefined && !isFork(type) ? undefined : { target: pending.target, label: pending.target, type: FORK, refused: forkStarting(pending.target) }
}

// Writes a subagent's route to state; a refusal is logged, and the route then holds in memory until a reload.
export async function persistRoute(io: Pick<RouteStore, 'setRoute'> & Pick<WorktreePort, 'debug'>, agentId: string, route: Route) {
  try {
    await io.setRoute(agentId, route)
  } catch (err) {
    io.debug(`klyth: could not persist the route of ${agentId} (${String(err)}); it holds until a reload`)
  }
}

// A klyth agent call, as the hook receives it: the Agent tool's arguments beside `tool`, `tool_use_id`,
// `consent` and the loop's `agentId`.
type AgentCall = { agentId?: string } & Record<string, unknown>
// A call that passed the checks every path shares: the model it names, and its arguments.
type Vetted = {
  t: Target
  model: string
  prompt: string
  description: string
  subagent_type: string | undefined
  name: string | undefined
  effort: Effort | undefined
  worktree: boolean
  background: boolean | undefined
}

// The checks of a call that need no engine: its parameters, the config, its model, its input, effort,
// isolation and fork. Trust is not among them. `caller` is the klyth target the calling conversation runs on, null
// when it is native, and undefined when it is routed but its call reached the tool untranslated. A fork runs on its
// caller's model, so it takes no other; a native caller's is denied (Agent forks natively), and so is one that was
// not translated, since only translation claims it on its caller's model. The engine reads any spelling of `fork`
// as a fork (`isFork`), and ignores a fork's effort, so a fork leaves vet spelled `fork` and with no effort.
function vet(s: Session, e: AgentCall, caller: string | null | undefined): Vetted | { deny: string } {
  const { tool, tool_use_id, agentId, consent, model, effort, prompt, description, subagent_type, name, isolation, run_in_background, ...rest } = e
  const unsupported = Object.keys(rest)
  if (unsupported.length > 0) return { deny: `klyth agent: unsupported parameter(s) ${unsupported.join(', ')}; use Agent for them` }
  const snap = s.loaded
  if (snap.config === undefined) return { deny: `klyth agent: unavailable (${snap.errors[0] ? `config error: ${snap.errors[0]}` : `no ${snap.path}`}); use Agent` }
  const fork = isFork(subagent_type)
  if (fork && caller === null) return { deny: FORK_NATIVE }
  if (fork && caller === undefined) return { deny: FORK_UNTRANSLATED }
  if (fork && model !== undefined && model !== caller) return { deny: forkOther(String(caller), String(model)) }
  const named = fork ? (caller as string) : model
  const except = caller === null ? '' : ", except for a fork, which runs on this conversation's model"
  if (named === undefined) return { deny: `klyth agent: model is required${except}; valid: ${modelNames(snap.config).join(', ')}` }
  const t = typeof named === 'string' ? resolve(snap.config, named) : undefined
  if (typeof named !== 'string' || t === undefined) return { deny: `klyth agent: unknown model ${JSON.stringify(named)}; valid: ${modelNames(snap.config).join(', ')}` }
  if (typeof prompt !== 'string' || typeof description !== 'string' || !isText(subagent_type) || !isText(name)) return { deny: BAD_INPUT }
  if (effort !== undefined && !EFFORTS.includes(effort as Effort)) return { deny: BAD_INPUT }
  if (run_in_background !== undefined && typeof run_in_background !== 'boolean') return { deny: BAD_INPUT }
  if (isolation !== undefined && isolation !== 'worktree') return { deny: `klyth agent: isolation ${JSON.stringify(isolation)} is not available through klyth; omit it or use "worktree"` }
  if (fork && isolation !== undefined) return { deny: FORK_ISOLATED }
  if (t.kind !== 'remote' && effort !== undefined) return { deny: NATIVE_EFFORT_DENY }
  return { t, model: named, prompt, description, subagent_type: fork ? FORK : subagent_type, name, effort: fork ? undefined : (effort as Effort | undefined), worktree: isolation === 'worktree', background: run_in_background }
}

// What `vet` takes for the conversation a call reached the tool from untranslated: null when it is native, and
// undefined when it is routed, as main's pin for the turn under way or the subagent's route (`known`) says.
const untranslatedCaller = (s: Session, agentId: string | undefined, known = agentId === undefined ? undefined : s.routes.get(agentId)) =>
  (agentId === undefined ? s.pin?.target : known?.target) ? undefined : null

type Trusted = (p: ProviderConfig) => boolean | Promise<boolean>

// Why a vetted call cannot become an Agent call: its provider is not approved (`trusted` says), or its native
// model is not one the Agent tool takes. Undefined when it can.
async function unfit(v: Vetted, trusted: Trusted): Promise<string | undefined> {
  if (v.t.kind === 'remote') return (await trusted(v.t.provider)) ? undefined : `klyth agent: provider ${v.t.provider.id} is not approved; run /model ${v.model} once and choose Allow`
  return NATIVE_MODELS.includes(v.t.model) ? undefined : `klyth agent: ${v.model} is not a native alias the Agent tool takes (${NATIVE_MODELS.join(', ')}); use one of those, or a klyth alias`
}

// The answer to a subagent's vetted klyth agent call that did not become an Agent call: the reason it could
// not, else that the subagent is native. A subagent's call never spawns here: a spawn from a hook attaches to main.
async function refuse(v: Vetted, trusted: Trusted): Promise<{ deny: string }> {
  return { deny: (await unfit(v, trusted)) ?? NATIVE_SUB }
}

// The answer to a klyth agent call that reached the tool from a subagent where no trust can be read (raised
// beneath the spawn of a hook): why translation left it as it was, which translating it noted, else the
// checks that need no engine, else that the subagent is native.
export async function untranslated(s: Session, e: AgentCall): Promise<{ deny: string }> {
  const said = s.calls.get(String(e.tool_use_id))?.deny
  if (said !== undefined) return { deny: said }
  const v = vet(s, e, untranslatedCaller(s, e.agentId))
  return 'deny' in v ? v : refuse(v, () => true)
}

// The tool's answer to a call: the subagent started on its model in the background, or a one-line deny. Only
// main's call is spawned here; a call from a subagent is denied, which a routed one has made an Agent call of.
// The reason the step left a call as it was, when it noted one, is the real one. A routed subagent started by the model's
// own call (`origin` the engine's) of a native step (an id klyth did not mint) has its spawn vetted: a native model wrote its
// task, and Claude Code's own permission check, in whatever mode the session was in, passed the call.
export async function agentCall(io: AgentPort, s: Session, e: AgentCall, origin: { plugin: string; tier: string }): Promise<{ result: string } | { deny: string }> {
  const said = s.calls.get(String(e.tool_use_id))?.deny
  if (said !== undefined) return { deny: said }
  // A subagent's route may be in state only (a hot reload); a read that fails leaves the memory's answer.
  const known = e.agentId === undefined ? undefined : (s.routes.get(e.agentId) ?? (await io.route(e.agentId).catch(() => undefined)))
  const v = vet(s, e, untranslatedCaller(s, e.agentId, known))
  if ('deny' in v) return v
  if (e.agentId !== undefined) return refuse(v, p => isTrusted(io, p))
  if (v.background === false) return { deny: FOREGROUND }
  const { t, prompt, description, name, effort } = v
  const remote = t.kind === 'remote'
  // The type the engine will run, as it resolves an Agent call's; `$.agent.spawn` takes only that spelling.
  const resolved = await resolveType(io, s, v.subagent_type)
  if ('deny' in resolved) return resolved
  const type = resolved.type
  // The rules a routed caller's Agent call meets at its spawn (inherit.ts): a type klyth cannot run, a built-in type
  // two agent files name, and an agent file's isolation: apply here too. A native target runs natively, whatever its
  // type. They are checked before trust, so no approval is asked for a call that is denied anyway.
  const fit = remote ? await claimable(io, s, type, 'the call is refused', true) : undefined
  if (fit !== undefined && 'no' in fit) return { deny: unclaimable(type, fit.no, t.label) }
  if (remote && !(await ensureTrust(io, t.provider))) return { deny: `klyth agent: provider ${t.provider.id} is not approved; use Agent for a native model` }
  let wt: Worktree | undefined
  if (v.worktree || fit?.isolated) {
    const made = await makeWorktree(io)
    if ('error' in made) return { deny: made.error }
    wt = made
  }
  const args: AgentSpawnArgs = {
    prompt,
    description,
    ...(v.subagent_type ? { subagentType: type } : {}),
    ...(name ? { name } : {}),
    ...(remote ? {} : { model: t.model }),
    ...(wt ? { cwd: wt.path } : {}),
  }
  const route: Route = {
    target: remote ? t.label : null,
    label: t.label,
    type,
    ...(remote ? { prompt } : {}),
    ...(effort ? { effort } : {}),
    ...(wt ? { worktree: wt } : {}),
  }
  const kept = remote || wt !== undefined
  const vetted = origin.plugin === 'engine' && origin.tier === 'core' && !String(e.tool_use_id).startsWith(ROUTED_ID)

  // A subagent the engine lists as another type than the one resolved (a hook beneath rewrote it) is not the one
  // klyth checked, so its route refuses and its first step hands that back rather than run on another prompt.
  const start = async (began: (id: string) => void = () => {}) => {
    const spawned = await io.spawn(args)
    const id = spawned.agentId
    if (id === undefined || !kept) return spawned
    began(id)
    const listed = remote ? await io.agentType(id).catch(() => undefined) : undefined
    const other = listed !== undefined && listed !== type ? `klyth agent: the engine started ${type} as ${listed}, so klyth did not run it on ${t.label}; retry` : undefined
    s.routes.set(id, other === undefined ? route : { ...route, refused: other })
    if (remote && other === undefined && vetted) s.vettedSpawns.add(id)
    return spawned
  }
  let started
  try {
    started = await (remote ? whileSpawning(s, start, t.label) : start())
  } catch (err) {
    if (wt) await settleWorktree(io, s.trashPath, wt, 'that did not start').catch(() => 'kept')
    throw err
  }
  if (started.deny !== undefined || started.agentId === undefined) {
    if (wt) await settleWorktree(io, s.trashPath, wt, 'that did not start').catch(() => 'kept')
    return { deny: started.deny ?? NOT_STARTED }
  }
  const id = started.agentId
  if (kept) await persistRoute(io, id, s.routes.get(id) ?? route)
  const where = remote ? t.target : `native ${t.model}`
  try {
    if (remote) io.debug(`klyth spawn ${id} → ${t.target} effort=${effort ?? 'none'}${wt ? ` cwd=${wt.path}` : ''}`)
  } catch {}
  const isolated = wt ? ` It works in the git worktree ${wt.path} (branch ${wt.branch}), which is removed if it finishes with no changes.` : ''
  return {
    result: `klyth: started ${t.label} (${where}) subagent ${id} in the background. Its report arrives as a separate message when it finishes. Stop it with TaskStop ${id}; message it with SendMessage to ${id}.${isolated}`,
  }
}

// A subagent's finished turn: its worktree moved to the Trash when it holds no work, and then dropped from
// its route (kept and said so otherwise), and what the session remembers of it forgotten. A worktree the
// engine made (an inherited Agent call's) is the engine's to remove, so klyth only drops it from the route: a
// resumed subagent's prompt must not name a directory that may be gone. The route then says `wasIsolated`, so
// a plain Agent call of the resumed subagent is still known to come from a subagent that worked in a worktree.
export async function completed(io: WorktreePort & Pick<RouteStore, 'route' | 'setRoute'>, s: Session, agentId: string) {
  try {
    const route = s.routes.get(agentId) ?? (await io.route(agentId))
    if (route?.worktree !== undefined && ('engine' in route.worktree || (await settleWorktree(io, s.trashPath, route.worktree, agentId)) === 'removed')) {
      const { worktree, ...rest } = route
      const gone = { ...rest, wasIsolated: true as const }
      s.routes.set(agentId, gone)
      await io.setRoute(agentId, gone)
    }
  } catch (err) {
    io.debug(`klyth: worktree check for ${agentId} failed (${String(err)})`)
  } finally {
    s.forget(agentId)
  }
}

// --- the klyth agent tool in a conversation klyth routes ------------------------------------------------------

type ToolUse = Extract<StepEvent, { type: 'tool_use' }>
// A klyth agent call as an Agent call: the same arguments, with `model` left out for a klyth target (the call is
// claimed on `note.target`) and set for a native one; the note its spawn reads; the model the call named.
export type Translation = { use: { name: 'Agent'; input: Record<string, unknown> }; note: CallNote; model: string }

// A klyth agent call's input as the Agent call that stands in for it, or the reason it stays a klyth agent call,
// which the tool then answers. Trust is read from the store and never asked: the hook that carries this has
// a short budget, and the tool asks main once. A call from a subagent that leaves `run_in_background` unset is
// made to wait (false): at depth the engine would background it, and the small subagent would end its turn
// before the report arrived; main's unset value is the engine's default. `caller` is the klyth target the calling
// conversation runs on, which a fork runs on too; null for a native main (native-step.ts).
export async function translate(io: Pick<TrustPort, 'trusted'>, s: Session, input: Record<string, unknown>, caller: string | null, inSubagent = false): Promise<Translation | { deny: string }> {
  const v = vet(s, input, caller)
  if ('deny' in v) return v
  const why = await unfit(v, p => isTrusted(io, p))
  if (why !== undefined) return { deny: why }
  const { t, model, prompt, description, subagent_type, name, effort, worktree, background } = v
  const remote = t.kind === 'remote'
  return {
    use: {
      name: 'Agent',
      input: {
        description,
        prompt,
        ...(subagent_type ? { subagent_type } : {}),
        ...(name ? { name } : {}),
        ...(worktree ? { isolation: 'worktree' } : {}),
        ...(background === undefined && !inSubagent ? {} : { run_in_background: background ?? false }),
        ...(effort ? { effort } : {}),
        ...(remote ? {} : { model: t.model }),
      },
    },
    note: { target: remote ? t.label : null, ...(effort ? { effort } : {}), ...(worktree ? { isolated: true } : {}) },
    model,
  }
}

type TranslatedPort = Pick<RouteStore, 'translated'> & Pick<Say, 'debug'>
export type RememberPort = TranslatedPort & Pick<TrustPort, 'trusted'> & Pick<RouteStore, 'setTranslated'>

// The Agent calls klyth made of `who`'s klyth agent calls (tool_use id → the model named): memory, else state.
export async function translatedOf(io: TranslatedPort, s: Session, who: string): Promise<Readonly<Record<string, string>>> {
  const hit = s.translated.get(who)
  if (hit !== undefined) return hit
  try {
    const read = (await io.translated(who)) ?? {}
    s.translated.set(who, read)
    return read
  } catch (err) {
    io.debug(`klyth: could not read the translated calls of ${who} (${String(err)}); a spawn after a reload and the classifier go without their targets`)
    return {}
  }
}

// A routed step's tool_use (`who`'s, on the klyth target `caller`): a klyth agent call becomes the Agent call that
// `translate` makes of it, noted for its spawn and remembered with `who`'s state (kept across a reload) for a spawn
// whose note a reload cleared and for the classifier's view of its target; any other tool_use, a call the step did
// not `offered` (the tool answers it) and a call `translate` refuses, is returned as it is.
export async function translateUse(io: RememberPort, s: Session, who: string, caller: string, use: ToolUse, offered: boolean): Promise<ToolUse> {
  if (!offered) {
    s.note(use.id, { deny: `klyth agent: not offered to ${who === 'main' ? 'main in this step' : `the ${s.routes.get(who)?.type ?? 'general-purpose'} subagent`}; use a tool it has` })
    return use
  }
  try {
    const done = await translate(io, s, use.input, caller, who !== 'main')
    if ('deny' in done) {
      s.note(use.id, { deny: done.deny })
      io.debug(`klyth translate ${use.id}: left as a klyth agent call (${done.deny})`)
      return use
    }
    await remember(io, s, who, use.id, done)
    return { ...use, ...done.use }
  } catch (err) {
    io.debug(`klyth translate ${use.id}: failed (${String(err)}); left as a klyth agent call`)
    return use
  }
}

// A translated call `id` of `who`, noted for its spawn and remembered with `who`'s state (kept across a reload) for a
// spawn whose note a reload cleared and for the classifier's view of its target. `vetted` is the task of a native
// main's own call, which Claude Code's permission check passes as an Agent call before the spawn that reads it.
export async function remember(io: RememberPort, s: Session, who: string, id: string, done: Translation, vetted?: string): Promise<void> {
  s.note(id, vetted === undefined ? done.note : { ...done.note, vetted })
  const kept = Object.fromEntries([...Object.entries(await translatedOf(io, s, who)), [id, done.model] as const])
  s.translated.set(who, kept)
  await io.setTranslated(who, kept).catch(err => io.debug(`klyth: could not persist the translated calls of ${who} (${String(err)}); they hold until a reload`))
}
