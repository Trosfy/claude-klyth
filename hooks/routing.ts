// Which model answers: main's per-turn pin (/model selects its target: model.ts), each subagent's route, the remote
// step (the request it builds, its guards, its events as chunks, a klyth agent call among them made an Agent call),
// and the failures that end a step. Pure over ports.
import type { ToolInfo, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import type { MainPin, Route } from '../types'
import { HANDBACK_TOOL, isFork } from './agents'
import { FORK_HISTORY, asSent, historyOf } from './fork'
import { inputBudget } from './config'
import { resolve } from './names'
import type { PromptsPort } from './prompts'
import type { ApiMessage, Backend, StepRequest } from './protocol'
import { firstLine, redact } from './redact'
import { contextEstimate, historyPrefix, reconcileHistory } from './history-context'
import { normalHeader } from './request'
import type { Assembler, Session, StepRecord } from './session'
import { translateUse, unclaimedFork, unstarted } from './spawn'
import type { AgentTypes } from './spawn'
import { nativeMain } from './native-step'
import { createAssembler } from './step'
import { guardedPort } from './compact-decision'
import { firstUserText, handbackState } from './transcript'
import { approve, isTrusted } from './trust'
import type { TrustPort } from './trust'
import { k, labelOf } from './ui'

export const WRAPPER = 'mcp__klyth__agent'
// Half of HookBudget.ms (10_000): both the module-promise await and $.clock.sleep spend the hook's budget.
const SPAWN_WAIT_MS = 5000

type StepResult = AsyncGenerator<TurnStepChunk, TurnStepResult>

export type Say = { toast(text: string): void; debug(text: string): void }
// What routing keeps in the engine's state: main's target and its pin for a turn, each subagent's route, and
// the model each klyth agent call of a conversation named once klyth made it an Agent call (`who`: main, or an agentId).
export type RouteStore = {
  main(): Promise<string | null | undefined>
  setMain(target: string | null): Promise<void>
  pin(): Promise<MainPin | null | undefined>
  setPin(pin: MainPin): Promise<void>
  route(agentId: string): Promise<Route | undefined>
  setRoute(agentId: string, route: Route): Promise<void>
  translated(who: string): Promise<Readonly<Record<string, string>> | undefined>
  setTranslated(who: string, calls: Readonly<Record<string, string>>): Promise<void>
}
// The tools main has, and which of its MCP tools are loaded.
type ToolSource = { list(): Promise<readonly ToolInfo[]>; loadedMcp(): Promise<ReadonlySet<string>>; check?(e: { tool: string; input: unknown }): Promise<{ decision: string; rule?: string }> }
// A conversation's transcript in the Messages API's form (main's, or an agent's), or why it cannot be read.
export type Transcripts = { transcript(agentId: string | undefined): Promise<readonly ApiMessage[] | { deny: string }> }
export type Sleeper = { sleep(ms: number, signal: AbortSignal): Promise<void> }
export type StepIo = Say & ToolSource & Transcripts & PromptsPort & Pick<TrustPort, 'trusted'>

const stepKey = (e: Pick<TurnStepInput, 'agentId' | 'turnId' | 'index'>) => `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`

// --- main and subagent routes ----------------------------------------------------------------------------

// The main conversation's route for this step: fixed per turn at its first step and persisted, so a later
// selection or a reload never changes a turn already under way.
async function mainRoute(io: Pick<RouteStore, 'main' | 'pin' | 'setPin'>, s: Session, e: TurnStepInput, alive: () => boolean): Promise<string | null> {
  if (s.pin?.turnId === e.turnId) return s.pin.target
  const persisted = await io.pin()
  if (!alive()) return null
  if (persisted?.turnId === e.turnId) return (s.pin = persisted).target
  if (e.index > 0) return null
  if (s.main === undefined) {
    const main = await io.main()
    if (!alive()) return null
    s.main = main ?? null
  }
  s.pin = { turnId: e.turnId, target: s.main }
  if (s.main !== null) s.routedTurns++
  await io.setPin(s.pin)
  return s.pin.target
}

// A subagent's route: memory, else (while a klyth spawn is in flight) a bounded wait, else the persisted one; else, when
// the wait ran out with a spawn asked for on a klyth target (or a fork under a routed parent) still starting, a route
// that refuses.
async function subRoute(io: Pick<RouteStore, 'route'> & Sleeper & AgentTypes & Pick<Say, 'debug'>, s: Session, agentId: string, signal: AbortSignal): Promise<Route | undefined> {
  const hit = s.routes.get(agentId)
  if (hit !== undefined) return hit
  let timedOut = false
  if (s.pendingSpawns.size > 0) {
    const ac = new AbortController()
    const outcome = await Promise.race([
      Promise.allSettled([...s.pendingSpawns]).then(() => 'settled'),
      io.sleep(SPAWN_WAIT_MS, AbortSignal.any([ac.signal, signal])).then(
        () => 'timeout',
        () => 'aborted',
      ),
    ])
    ac.abort()
    const after = s.routes.get(agentId)
    io.debug(`klyth spawn-wait ${agentId} outcome=${outcome} routed=${after !== undefined}`)
    if (after !== undefined) return after
    timedOut = outcome === 'timeout'
  }
  const persisted = await io.route(agentId)
  if (persisted !== undefined) s.routes.set(agentId, persisted)
  return persisted ?? (timedOut ? (unstarted(s, agentId) ?? (await unclaimedFork(io, s, agentId))) : undefined)
}

// --- remote steps ----------------------------------------------------------------------------------------

// The tool that delivers a subagent step's failure as its report: SubagentHandback, when the step's request
// offers it (`offered`) and the subagent's transcript (`read`, else read here) says the engine delivers
// through it and shows no call of it refused since, so a run hands back at most once. A transcript that cannot be
// read cannot show a refusal, so klyth's own record stands in: the first failure of a turn is handed back, and
// the failure of a later step of that turn, which the engine only runs after refusing the call, is not.
// Undefined for main and otherwise: the failure is then answered as text.
async function handbackFor(io: Transcripts, s: Session, e: TurnStepInput, offered: boolean, read?: unknown): Promise<string | undefined> {
  if (e.agentId === undefined || !offered) return undefined
  let messages: unknown
  try {
    messages = read ?? (await io.transcript(e.agentId))
  } catch {}
  if (Array.isArray(messages)) return handbackState(messages as ApiMessage[], HANDBACK_TOOL.name) === 'offered' ? HANDBACK_TOOL.name : undefined
  if (s.blindHandbacks.get(e.agentId) === e.turnId) return undefined
  s.blindHandbacks.set(e.agentId, e.turnId)
  return HANDBACK_TOOL.name
}

// Answers a step with `text` in place of a response, after whatever `assembler` has yielded: as text, or
// as one call of `handback` when it names one and no tool call was yielded.
async function* failStep(e: TurnStepInput, assembler: Assembler, text: string, handback?: string): StepResult {
  const end = assembler.end({ failure: text, ...(handback === undefined ? {} : { handback }) })
  yield* end.chunks
  return { turnId: e.turnId, index: e.index, answer: end.answer, toolUses: end.toolUses, stopReason: end.stopReason, usage: null }
}

async function* remoteStep(io: StepIo & Pick<RouteStore, 'route' | 'translated' | 'setTranslated'>, s: Session, backend: Backend, e: TurnStepInput, target: string, route: Route | undefined, signal: AbortSignal, alive: () => boolean): StepResult {
  const key = stepKey(e)
  const record: StepRecord = { target }
  s.steps.set(key, record)
  const who = e.agentId ?? 'main'
  // A failure before the request is sent; a subagent's goes back through `handback` when it names one, and
  // is toasted (a main step's text is the answer already).
  const fail = async function* (text: string, handback: string | undefined) {
    if (s.steps.get(key) === record) s.steps.delete(key)
    if (e.agentId !== undefined) io.toast(text)
    return yield* failStep(e, createAssembler(target), text, handback)
  }
  // A fork is offered no SubagentHandback, so its failures are answered as text, its final message.
  const fork = isFork(route?.type)
  // A subagent klyth started but could not run on the klyth model its caller asked for hands that back as its report.
  if (route?.refused !== undefined) return yield* fail(route.refused, await handbackFor(io, s, e, !fork))
  if (e.agentId === undefined && s.mainChoiceError !== undefined) return yield* fail(s.mainChoiceError, undefined)
  const snap = s.loaded
  const t = snap.config === undefined ? undefined : resolve(snap.config, target)
  if (snap.config === undefined || t?.kind !== 'remote') {
    return yield* fail(
      `klyth: ${target} is not available (${snap.errors[0] ?? 'no longer configured'}); the step was not sent. Fix ${snap.path}, run /klyth reload, or pick another model`,
      await handbackFor(io, s, e, !fork),
    )
  }
  if (!(await isTrusted(io, t.provider))) {
    return yield* fail(`klyth: provider ${t.provider.id} is not approved; run /model ${labelOf(snap.config, target)} to approve it. The step was not sent`, await handbackFor(io, s, e, !fork))
  }
  await approve(s, backend, t.provider)
  if (!alive()) return yield* fail('klyth: conversation ended; the step was not sent', undefined)
  const read = await io.transcript(e.agentId)
  if (!('deny' in read)) {
    await reconcileHistory(s, who, read, io.debug)
    if (!alive()) return yield* fail('klyth: conversation ended; the step was not sent', undefined)
    if (who === 'main') s.currentPrompt = undefined
  }
  const history = 'deny' in read ? undefined : await historyOf(io, s, e.agentId, route, read)
  const header = await normalHeader(io, s, t, { ...e, target, route, read, history }, false, alive)
  if (header === undefined) return yield* fail(`klyth: the route of the parent of this fork cannot be read; the step was not sent; retry`, undefined)
  if (!alive()) return yield* fail('klyth: conversation ended; the step was not sent', undefined)
  const { sent, synth } = header
  const tools = sent.tools
  const names = tools.map(x => x.name)
  if (e.agentId !== undefined) s.offered.set(e.agentId, new Set(names))
  const handback = await handbackFor(io, s, e, names.includes(HANDBACK_TOOL.name) || synth, read)
  if ('deny' in read) return yield* fail(`klyth: the transcript of ${who} is unreadable (${read.deny}); the step was not sent; retry`, handback)
  if (history === undefined) return yield* fail(FORK_HISTORY, handback)
  const messages = asSent(await s.cacheHistory.read(e.agentId, route, history, e.turnId, io.debug), t)
  io.debug(
    `klyth req ${who} msgs=${messages.length} firstUser=${JSON.stringify(redact(firstUserText(messages)).slice(0, 60))} tools=${tools.length}[${tools
      .slice(0, 8)
      .map(x => x.name)
      .join('|')}]`,
  )
  const req: StepRequest = { ...sent, transcript: messages, who, sessionId: s.sessionId(who), cacheLoop: who, accounting: { purpose: 'step', owner: e.agentId === undefined ? 'main' : 'child' } }
  const budget = inputBudget(t.model, t.provider.kind)
  const estimate = await contextEstimate(s, who, req)
  if (estimate > 0.95 * budget) {
    const toolTokens = Math.ceil(JSON.stringify(tools).length / 3.5)
    return yield* fail(
      toolTokens > 0.5 * budget
        ? `klyth: tool schemas alone take ~${k(toolTokens)} of ${target}'s ${k(budget)} input budget; set "tools": false on the model or use a larger one`
        : `klyth: context ~${k(estimate)} exceeds ${target}'s 95% safety threshold (${k(0.95 * budget)}) of its ${k(budget)} configured input budget; run /klyth compact between turns`,
      handback,
    )
  }
  // The request less its messages, for the classifier's fork context (classifier-fork.ts).
  const prefix = await historyPrefix(messages)
  if (!alive()) return yield* fail('klyth: conversation ended; the step was not sent', undefined)
  s.sent.set(who, sent)
  s.sentContext.set(who, { loaded: snap, routeKey: header.routeKey, messageCount: messages.length, prefix, turnId: e.turnId, model: e.model, effort: e.effort })
  s.promptTokens.delete(who)
  const assembler = createAssembler(t.target)
  record.assembler = assembler
  for await (const ev of backend.step(req, signal)) {
    if (!alive()) break
    if (ev.type === 'stats') {
      s.lastSteps.delete(who)
      s.lastSteps.set(who, { target, stats: ev, prompt: header.source })
    }
    const translated = ev.type === 'tool_use' && ev.name === WRAPPER ? await translateUse(io, s, who, target, ev, names.includes(WRAPPER)) : ev
    if (!alive()) break
    yield* assembler.feed(translated)
  }
  // A subagent offered SubagentHandback hands a request failure back as its report, so its run ends with
  // the failure delivered rather than re-asked; after a refused handback it answers text, and the run ends.
  const end = assembler.end({ ...(handback === undefined ? {} : { handback }), ...(synth ? { deliver: true } : {}) })
  if (end.delivered === true) io.debug(`klyth: ${who} ended on text; klyth handed it back as one ${HANDBACK_TOOL.name} call (tools: false)`)
  const stop = end.chunks.pop() as TurnStepChunk
  yield* end.chunks
  const u = end.usage
  if (alive() && u !== null) s.promptTokens.set(who, { tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, messageCount: e.messageCount })
  if (end.failure !== undefined && e.agentId !== undefined) io.toast(firstLine(end.failure))
  const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: end.answer, toolUses: end.toolUses, stopReason: end.stopReason, usage: end.usage }
  yield stop
  if (s.steps.get(key) === record) s.steps.delete(key)
  return result
}

// A turn.step: native when no klyth target holds it, else the remote step. `native` is the step beneath.
export async function* turnStep(io: StepIo & Pick<RouteStore, 'main' | 'pin' | 'setPin' | 'route' | 'translated' | 'setTranslated'> & Sleeper & AgentTypes, s: Session, backend: Backend, e: TurnStepInput, signal: AbortSignal, native: () => StepResult): StepResult {
  const generation = s.conversationGeneration
  const alive = () => s.conversationGeneration === generation && !signal.aborted
  const guarded = guardedPort(io, alive)
  try {
    const route = e.agentId === undefined ? undefined : await subRoute(guarded, s, e.agentId, signal)
    const target = e.agentId === undefined ? await mainRoute(guarded, s, e, alive) : (route?.target ?? null)
    if (!alive()) return yield* failStep(e, createAssembler(target ?? 'klyth'), 'klyth: conversation ended')
    if (target === null) return yield* (e.agentId === undefined ? nativeMain(guarded, s, native) : native())
    return yield* remoteStep(guarded, s, backend, e, target, route, signal, alive)
  } catch (err) {
    if (alive()) throw err
    return yield* failStep(e, createAssembler('klyth'), 'klyth: conversation ended')
  }
}

// A turn.step whose hook failed (`error`): a step klyth routes is answered with the internal-error text,
// handed back when it is a subagent's, and never passed to another model; any other goes on beneath.
export async function* stepFailed(io: Say & Transcripts, s: Session, e: TurnStepInput, error: { kind: string; message?: string }, native: () => StepResult): StepResult {
  const key = stepKey(e)
  const record = s.steps.get(key)
  const target = record?.target ?? (e.agentId !== undefined ? (s.routes.get(e.agentId)?.target ?? null) : s.pin?.turnId === e.turnId ? s.pin.target : (s.main ?? null))
  try {
    io.debug(`klyth: turn.step ${key} failed (${error.kind}: ${error.message ?? ''}); ${target === null ? 'passed to the native model' : `answered with the internal-error text for ${target}`}`)
  } catch {}
  if (target === null) return yield* native()
  s.steps.delete(key)
  const handback = await handbackFor(io, s, e, !isFork(s.routes.get(e.agentId ?? '')?.type))
  return yield* failStep(e, record?.assembler ?? createAssembler(target), `klyth: internal error on ${target}; the step was not sent to another model (see the debug log)`, handback)
}
