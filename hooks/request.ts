// Shared normal request header construction. Maintenance requests reuse a stamped sent header or
// rebuild through the same prompt/tool selection, without changing offers or diagnostic tool reports.
import type { Effort, Route } from '../types'
import { HANDBACK_TOOL, isFork } from './agents'
import { advert, agentSchema } from './advert'
import { EFFORTS, isObject } from './config'
import type { Config, Target } from './config'
import { asSent, forkParent } from './fork'
import { contextEstimate, matchesDecisionHistory, matchesPrefix, reconcileHistoryReceipt } from './history-context'
import { guardedPort } from './compact-decision'
import type { ContextPreparation } from './compact-decision'
import { resolve } from './names'
import { poolOf } from './pool'
import { definitionOf, systemFor } from './prompts'
import type { ApiMessage, RemoteTool } from './protocol'
import type { RouteStore, StepIo } from './routing'
import { WRAPPER } from './routing'
import { SCHEMAS } from './schemas.gen'
import type { Session } from './session'
import { handbackState } from './transcript'

type Remote = Extract<Target, { kind: 'remote' }>
type ToolSource = Pick<StepIo, 'list' | 'loadedMcp'>
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

// The tool names the `tool_reference` blocks of a transcript load: what ToolSearch returned to its caller.
function referencedTools(messages: readonly ApiMessage[]): Set<string> {
  const names = new Set<string>()
  const scan = (block: unknown) => {
    if (!isObject(block)) return
    if (block['type'] === 'tool_reference' && typeof block['tool_name'] === 'string') names.add(block['tool_name'])
    else if (block['type'] === 'tool_result' && Array.isArray(block['content'])) block['content'].forEach(scan)
  }
  for (const m of messages) if (typeof m.content !== 'string') m.content.forEach(scan)
  return names
}

// The tools a remote request offers: the non-MCP and loaded MCP tools `offered` keeps, the klyth agent tool
// when the loop may call both Agent (which its calls become) and the tool itself (the tool list holds them
// and `offered` keeps them), and SubagentHandback to a subagent unless `noHandback` (a fork, which Claude Code offers
// none; a subagent the engine did not say it delivers through it; one the engine refused it; inside the cap). Each goes with its generated
// schema or a permissive one. An MCP tool is loaded when main's usage says so (`mainMcp`: main, or a fork of main,
// whose tools are main's: `$.tool.list()` and the usage are main's) or when the transcript sent holds a
// `tool_reference` to it, which is how a subagent loads one.
async function toolSet(io: ToolSource, s: Session, config: Config, t: Remote, isSub: boolean, mainMcp: boolean, noHandback: boolean, offered: (name: string) => boolean, referenced: ReadonlySet<string>, observe: boolean, valid: () => boolean): Promise<RemoteTool[]> {
  const handback = { name: HANDBACK_TOOL.name, description: HANDBACK_TOOL.description, schema: HANDBACK_TOOL.schema }
  // A model without tools is offered none, SubagentHandback included: its text-only end is handed back by klyth (step.ts).
  if (!t.model.tools) return []
  const listed = await io.list()
  const loadedMcp = new Set([...(mainMcp ? await io.loadedMcp() : []), ...referenced])
  const tools: RemoteTool[] = []
  const seen = new Set<string>([HANDBACK_TOOL.name])
  const schemaless: string[] = []
  const long: string[] = []
  const wrapped = listed.some(x => x.name === 'Agent') && offered('Agent') && offered(WRAPPER)
  for (const tool of listed) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    if (tool.name === WRAPPER) {
      if (wrapped) tools.push({ name: WRAPPER, description: advert(config), schema: agentSchema(config, SCHEMAS['Agent'] ?? {}) })
      continue
    }
    if (!offered(tool.name)) continue
    if (tool.mcp && !loadedMcp.has(tool.name)) continue
    if (!TOOL_NAME_RE.test(tool.name)) {
      long.push(tool.name)
      continue
    }
    const schema = SCHEMAS[tool.name] ?? s.mcpSchemas[tool.name]
    if (schema === undefined) schemaless.push(tool.name)
    tools.push({ name: tool.name, description: tool.description, schema: schema ?? { type: 'object' } })
  }
  const cap = t.provider.maxTools
  const hands = isSub && !noHandback
  const room = hands ? cap - 1 : cap
  const kept = tools.slice(0, Math.max(0, room))
  if (!observe && valid()) s.toolReport = { schemaless, capped: tools.slice(Math.max(0, room)).map(x => x.name), long, cap }
  if (hands && cap > 0) kept.push(handback)
  return kept
}

export async function normalHeader(io: StepIo & Pick<RouteStore, 'route'>, s: Session, t: Remote, at: { agentId?: string; route?: Route; target: string; model: string; effort?: Effort | number; read: readonly ApiMessage[] | { deny: string }; history?: readonly ApiMessage[] }, observe = false, valid: () => boolean = () => true) {
  const who = at.agentId ?? 'main'
  const fork = isFork(at.route?.type)
  const base = fork && at.route !== undefined ? await forkParent(io, s, at.route) : undefined
  if (fork && base === undefined) return undefined
  const routeKey = JSON.stringify({ route: at.route, base })
  const sent = s.sent.get(who), stamp = s.sentContext.get(who)
  const synth = at.agentId !== undefined && !fork && !t.model.tools
  if (observe && sent !== undefined && stamp?.loaded === s.loaded && stamp.routeKey === routeKey && stamp.model === at.model && sent.target === at.target && at.history !== undefined && stamp.messageCount <= at.history.length && await matchesPrefix(at.history.slice(0, stamp.messageCount), stamp.prefix)) return { sent, source: 'last routed request', synth, routeKey }
  const shape = base === undefined ? at.route : base.route
  const def = at.agentId === undefined ? undefined : await definitionOf(io, s, shape?.type)
  const pool = at.agentId === undefined ? () => true : await poolOf(io, s, at.agentId)
  const state = at.agentId === undefined ? 'unsaid' : 'deny' in at.read ? 'offered' : handbackState(at.read, HANDBACK_TOOL.name)
  if (!observe && at.agentId !== undefined && !fork && state !== 'offered' && (s.offered.get(who)?.has(HANDBACK_TOOL.name) ?? true)) io.debug(`klyth: ${who} is offered no SubagentHandback (${state === 'unsaid' ? 'the engine did not say it delivers through it; its final text is its report' : 'the engine refused a call of it'})`)
  const tools = await toolSet(io, s, s.loaded.config!, t, at.agentId !== undefined, at.agentId === undefined || (fork && base?.route === undefined), fork || state !== 'offered', pool, referencedTools(at.history ?? []), observe, valid)
  const prompt = await systemFor(io, s, { def, route: shape, fork: base !== undefined, engineModel: at.model, target: t.target, model: t.model.id, provider: t.provider.id, tools: tools.map(t => t.name) })
  const declared = def?.effort !== undefined && EFFORTS.includes(def.effort as Effort) ? def.effort as Effort : undefined
  const effort = at.route?.effort ?? declared ?? at.effort
  return { sent: { target: at.target, system: prompt.text, tools, ...(effort === undefined ? {} : { effort }) }, source: prompt.source, synth, routeKey }
}

// Idle eligibility uses the same routed prompt, tools and observational provider history as a step.
export async function currentContext(io: StepIo & Pick<RouteStore, 'route'> & { engineModel(): Promise<string> }, s: Session, preparation?: ContextPreparation): Promise<number | undefined> {
  if (preparation !== undefined) io = guardedPort(io, preparation.valid)
  if (s.mainChoiceError !== undefined) return undefined
  const target = s.main
  const t = target == null || s.loaded.config === undefined ? undefined : resolve(s.loaded.config, target)
  if (t?.kind !== 'remote') return undefined
  const read = await io.transcript(undefined)
  if ('deny' in read) return undefined
  const receipt = await reconcileHistoryReceipt(s, 'main', read, io.debug, undefined, preparation)
  if (receipt.status === 'stale' || (preparation !== undefined && !preparation.valid())) return undefined
  const stamp = s.sentContext.get('main')
  const messages = asSent(await s.cacheHistory.read(undefined, undefined, read, stamp?.turnId ?? 'auto:main', io.debug, true), t)
  const model = await io.engineModel()
  const header = await normalHeader(io, s, t, { target: target!, model, effort: stamp?.model === model ? stamp.effort : undefined, read, history: messages }, true)
  const estimate = header === undefined ? undefined : await contextEstimate(s, 'main', { ...header.sent, transcript: messages, who: 'main', sessionId: s.sessionId('main') })
  if (preparation !== undefined) {
    if (!preparation.valid()) return undefined
    const current = await io.transcript(undefined)
    if ('deny' in current || !(await matchesDecisionHistory(current, receipt.prefix)) || !preparation.valid()) return undefined
  }
  return estimate
}
