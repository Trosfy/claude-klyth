import { createApproval } from './classifier-approval'
// All of klyth's mutable session memory in one object, and the one reset a config reload performs. Pure:
// register.ts creates one Session per registration and hands it to the modules that read and write it.
import { configPath } from './product'
import type { HistoryPrefix } from './history-context'
import type { Effort, MainPin, Route } from '../types'
import { createCacheHistory } from './cache-history'
import type { JsonSchema } from './config'
import type { Loaded } from './load'
import type { Pool } from './pool'
import type { ApiMessage, SessionScope, StepRequest, StepStats } from './protocol'
import type { createAssembler } from './step'

export type Assembler = ReturnType<typeof createAssembler>
// A remote step in flight, for the turn.step .catch: its target, and the assembler of what it has yielded.
export type StepRecord = { target: string; assembler?: Assembler }
// A conversation's last routed step: where it went, how it went, and where its system prompt came from.
type LastStep = { target: string; stats: StepStats; prompt: string }
// What an Agent call says that its spawn event does not carry: its effort, and whether it asked for a worktree.
// `target` marks a call klyth made from a routed model's klyth agent call: the klyth target the caller chose
// (null: a native model, which the call names itself). `deny` is why klyth left a klyth agent call as it was, for
// the tool to answer. `vetted` is the task a fresh classifier allow covered when the call spent it: a spawn of that same
// task is vetted.
export type CallNote = { effort?: Effort; isolated?: boolean; elsewhere?: string; target?: string | null; deny?: string; vetted?: string }
// The notes kept for Agent calls whose spawn has not taken them: only the latest 64.
const CALLS_MAX = 64
// A route main has left: its alias (or `provider/model`), the `provider/model` behind it, and how many main turns
// it answered since it was chosen. Native Claude is told of the routes left, once, with the next prompt.
export type Left = { label: string; target: string; turns: number }
// The last tool set a remote request was built with: what it left out, and why.
type ToolReport = { schemaless: string[]; capped: string[]; long: string[]; cap: number }
// What the classifier answers the engine's refusal of an action: `retry` when it allowed the action.
export type ClassifierCheck = { who: string; key: string; plain: boolean; loaded: Loaded; epoch: number; revision: number; step: number; turn: string | undefined }
export type ClassifierOutcome = { retry?: true }
// A classifier allow waiting for its action to be re-issued: until when it holds, the loop's routed step it was
// armed in, its directory scope, classifier source, and any translated destination or identified local recipient.
export type ClassifierToken = { until: number; step: number; cwd: string; scratch?: string; source: 'model-fresh' | 'model-fork' | 'human'; human?: { loaded: Loaded; revision: number; mode: { mode: unknown; revision: number } | undefined; policy: string; session: string; actorRoute: string; loop: string }; target?: string; recipient?: { id: string; parentId?: string } }
// A loop's last routed request less its messages: what the classifier's fork context sends again, before the loop's history.
export type Sent = Pick<StepRequest, 'target' | 'system' | 'tools' | 'effort'>

export function createSession() {
  const s = {
    loaded: { errors: [], missing: true, path: configPath('~/.claude') } as Loaded, // until the first load says where it looked
    configReady: false, // initial classic SessionStart precedes the config-loading session.start
    goodAliases: [] as readonly string[], // the alias names of the last valid config loaded
    mcpSchemas: {} as Readonly<Record<string, JsonSchema>>,
    notes: [] as string[], // what a load found worth saying in /klyth
    toolReport: { schemaless: [], capped: [], long: [], cap: 0 } as ToolReport,
    // Files read for agent types this session (agent files, installed_plugins.json), parsed, by path (null: no file).
    agentFiles: new Map<string, unknown>(),
    agentNotes: new Set<string>(), // the agent types (custom, and built-in ones an agent file may define) whose definition lookup is logged, and the notes said once
    approved: new Set<string>(), // the fingerprints the backend has been told are approved
    trashPath: undefined as string | undefined,
    platform: undefined as string | null | undefined, // `uname -s`, lowercased; null when it could not be read
    main: undefined as string | null | undefined, // main's target; undefined until read from state after a load
    mainChoiceSession: undefined as string | undefined,
    mainChoiceError: undefined as string | undefined,
    mainChoiceRevision: 0,
    mainChoiceQueue: Promise.resolve(),
    conversationGeneration: 0, // clear/resume invalidate running work independently of permission changes
    pin: null as MainPin | null,
    statuslineFile: undefined as string | undefined, // the command record published by this registration; survives config reloads
    statuslineQueue: Promise.resolve(), // record publications and cleanup, including ownership; survives config reloads
    // In memory only: a hot reload of the hooks module loses both (accepted; `/klyth reload` keeps them).
    routedTurns: 0, // the main turns pinned to the current route since it was chosen (a turn, not its steps)
    left: [] as Left[], // the routes main left, oldest first, until a native main's prompt carries their note
    routes: new Map<string, Route>(), // agentId → route
    pendingSpawns: new Set<Promise<void>>(),
    // the pending spawns of a klyth agent call klyth made, or of a fork under a routed parent (`fork`), by their barrier → the target asked for, and the id the engine started once it has
    requested: new Map<Promise<void>, { target: string; id?: string; fork?: boolean }>(),
    calls: new Map<string, CallNote>(), // tool_use_id → an Agent call's note, until its spawn takes it
    // main (as "main") or an agentId → the klyth agent calls of its routed steps that klyth made Agent calls of: tool_use id → the model named.
    // Read for a spawn whose note a reload cleared (recovered) and for a classified call's target.
    translated: new Map<string, Readonly<Record<string, string>>>(),
    steps: new Map<string, StepRecord>(), // `${agentId ?? "main"}:${turnId}:${index}` → remote step
    offered: new Map<string, ReadonlySet<string>>(), // agentId → the tool names its last remote step offered
    pools: new Map<string, Pool>(), // agentId → the tools it may be offered: its type's, within its caller's (pool.ts)
    mainTurn: undefined as string | undefined, // active main turn, for its compaction route pin
    compacting: new Set<string>(), // loops with a routed summary in flight
    historyRevision: new Map<string, number>(), // observed writes invalidate pending summaries
    // agentId or "main" → the last remote prompt_tokens, and the messageCount of the request they counted
    promptTokens: new Map<string, { tokens: number; messageCount: number }>(),
    lastSteps: new Map<string, LastStep>(), // agentId or "main" → its last routed step, least recent first
    // agentId or "main" → the random id its routed steps carry, for a provider that caches by session. Kept for this registration, including completion and config reload.
    sessionIds: new Map<string, string>(),
    hostSession: undefined as SessionScope | undefined, // the scope klythd keeps this session's provider metadata under, sent with every step; set by session.start and each root SessionStart
    transcriptPath: undefined as string | undefined, // the session's transcript as SessionStart or the usage record gave it
    cacheHistory: createCacheHistory(), // bounded opening snapshots and delivery attestations; no permission authority
    blindHandbacks: new Map<string, string>(), // agentId → the turn whose failure was handed back with its transcript unreadable
    // agentId → a fork's inherited history as first rebuilt: its parent's through the cut turn and the turn after it (if read).
    // Memory only: a hooks reload loses it and the next step rebuilds. A reload keeps it, a running fork needs it.
    forkPrefixes: new Map<string, { messages: readonly ApiMessage[]; cut: number }>(),

    // The classifier's memory (classifier.ts). An action's key is `${who}\n${tool}\n${stable JSON of its input}`, so what
    // belongs to one loop starts with `${who}\n`.
    currentPrompt: undefined as string | undefined, // engine-attested prompt awaiting its first history boundary
    historyPrefixes: new Map<string, HistoryPrefix>(), // bounded raw getter prefix metadata
    prompts: [] as string[], // what the person typed, last 32, oldest first
    // who → the actions classified this turn, and the keys not to ask the classifier again
    classified: new Map<string, { count: number; asked: Set<string> }>(),
    inFlight: new Map<string, Promise<ClassifierOutcome>>(), // action key → its classifier request in flight, shared by an identical refusal
    tokens: new Map<string, ClassifierToken>(), // action key → the allow its re-issued call may use, once
    review: createApproval(),
    reviewChecks: new Map<string, ClassifierCheck>(), // original engine tool.check verdicts, consumed by PermissionDenied
    classifierInFlight: 0, // classifier requests in flight, all loops
    dropEpoch: 0, // moved on by every drop of the tokens: a classifier request that began in an earlier one arms nothing
    permissionEpoch: 0, // actual session-wide invalidations, separate from routine classifier token revocation
    permissionModes: new Map<string, { mode: unknown; revision: number }>(), // loop-local permission observations
    classifierStats: { allowed: 0, asked: 0, skipped: 0 }, // actions the classifier allowed, did not allow, and was not asked about, for /klyth
    dirReal: undefined as string | null | undefined, // the working directory's real path; undefined until read, null when it cannot be
    classifierIneligible: undefined as string | undefined, // why the last action was ineligible, for /klyth; never disables the classifier
    routedSteps: new Map<string, number>(), // main or an agentId → the routed steps sent for it; a classifier token holds in the next one
    // Header provenance and prefix boundary only; no transcript copy or permission authority.
    sentContext: new Map<string, { loaded: Loaded; routeKey: string; messageCount: number; prefix?: HistoryPrefix; turnId: string; model: string; effort?: Effort | number }>(),
    sent: new Map<string, Sent>(), // main or an agentId → its last routed request less its messages (classifier.context "fork")
    // the subagents whose task (their route's `prompt`) was vetted at their spawn: written by a native model in its own klyth agent
    // call, or allowed by a fresh classifier on the Agent call. Memory only: a hooks reload forgets it.
    vettedSpawns: new Set<string>(),

    // Keeps an Agent call's note until its spawn takes it; the oldest goes when more than 64 are kept.
    note(id: string, note: CallNote) {
      s.calls.set(id, note)
      const [oldest] = s.calls.keys()
      if (s.calls.size > CALLS_MAX && oldest !== undefined) s.calls.delete(oldest)
    },

    // The id of a conversation's session: made when its loop first steps, the same for this registration.
    sessionId(who: string) {
      const id = s.sessionIds.get(who) ?? crypto.randomUUID()
      s.sessionIds.set(who, id)
      return id
    },

    // Forgets what a subagent's finished turn leaves: its route, offered tools, tool pool, last step, prompt
    // size, blind handback, translated calls, the actions classified for it, its classifier tokens, its routed-step count, its
    // last request, whether its spawn was vetted, and any step recorded for it that never ended (an aborted one).
    // Its route and translated calls stay in state, so a later message to it routes again. Its cache id stays
    // in memory for this registration; it grants no classifier authority.
    forget(agentId: string) {
      for (const m of [s.historyPrefixes, s.routes, s.offered, s.pools, s.lastSteps, s.promptTokens, s.blindHandbacks, s.translated, s.forkPrefixes, s.classified, s.routedSteps, s.sentContext, s.sent, s.vettedSpawns]) m.delete(agentId)
      for (const key of s.steps.keys()) if (key.startsWith(`${agentId}:`)) s.steps.delete(key)
      for (const [id, check] of s.reviewChecks) if (check.who === agentId) s.reviewChecks.delete(id)
      s.review.cancel()
      for (const key of s.tokens.keys()) if (key.startsWith(`${agentId}\n`)) s.tokens.delete(key)
    },

    // Forgets what the config text decides, ahead of loading it again: the agent files read and the tool pools
    // drawn from them, the approvals told to the backend, the MCP schemas, the load notes, the tool report and
    // the classifier's tokens.
    // `loaded` is replaced by the load itself, so a step racing the reload keeps the config it started with.
    // Routes, pins, steps, offered sets, prompt sizes and last steps are what a running turn still needs, so
    // they stay.
    resetForReload() {
      s.cacheHistory.clear()
      s.agentFiles.clear()
      s.agentNotes.clear()
      s.pools.clear()
      s.approved.clear()
      s.mcpSchemas = {}
      s.notes = []
      s.toolReport = { schemaless: [], capped: [], long: [], cap: 0 }
      s.review.cancel()
      s.reviewChecks.clear()
      s.tokens.clear()
      s.dropEpoch++ // a classifier request still running across the reload arms nothing
    },
  }
  return s
}
export type Session = ReturnType<typeof createSession>
