// The contract between the mod and the backend that answers its routed steps: what a step asks for, the
// events its answer streams back, and each provider's key state. Pure: no engine types and no I/O, so the
// helper process that serves steps imports it as the mod does.
import type { Effort } from '../types'
import type { JsonSchema } from './config'

// A transcript message as `$.session.messages({ as: "api" })` gives it: blocks, or (read as one text
// block) text.
export type ApiMessage = { role: 'user' | 'assistant'; content: string | readonly ({ type: string } & Record<string, unknown>)[] }
// A tool the remote model is offered: its name, description and input schema.
export type RemoteTool = { name: string; description: string; schema: JsonSchema }

// One routed step: its target (the alias or `provider/model` the route was made with, which the backend
// resolves against the config it holds), the system prompt, the tools offered, the transcript (a subagent's
// opening on its task), the effort the step asked for, who asks (`main` or an agentId), how long klythd
// may take over it (`timeoutMs`; the provider's own bound, when smaller, wins), and the id of the conversation
// it belongs to (`sessionId`), which klythd sends in the provider's `sessionHeader` when it names one (and, on the
// `openai-responses` kind, as the body's `prompt_cache_key`).
export type StepRequest = {
  target: string
  system: string
  tools: readonly RemoteTool[]
  transcript: readonly ApiMessage[]
  effort?: Effort | number
  who: string
  timeoutMs?: number
  compaction?: { outputTokens?: number; prefixMessages?: number } // summary-only; schemas may stay for cache reuse; bounded, no upstream resends
  sessionId?: string
  cacheLoop?: string // the loop whose provider affinity and prefix this request shares (`who`, or a parent's)
  accounting?: { purpose: 'step' | 'classifier' | 'compaction'; owner: 'main' | 'child' }
}

// Why a response stopped, in the engine's words; `tool_use` when it ended on tool calls.
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'tool_use'
// A response's tokens: input not read from cache, output, cache reads and writes, and the reasoning share
// of the output when the provider reports one.
export type Usage = { in: number; out: number; cacheRead: number; cacheWrite: number; reasoning?: number }
// How one step went: ms to the first response byte (null when none came) and in all, the request body's
// bytes, the prompt tokens (cache reads and writes included) and output tokens of a completed response (else null),
// its reasoning tokens, and the provider's finish reason as sent (`none` when it gave none, `error` when
// the step failed).
export type StepStats = { ttfbMs: number | null; totalMs: number; reqBytes: number; in: number | null; out: number | null; reasoning?: number; finish: string }

export const statsEvent = (stats: StepStats): Extract<StepEvent, { type: 'stats' }> => ({ type: 'stats', ...stats })

// One event of a step's answer, in order. `text` and `thinking` are deltas of the answer and the reasoning;
// a `tool_use` is a whole call with its input parsed, so a call cut short never appears. The events end
// with exactly one `stop` or `error`, then `stats`. An error's text is one line naming the cause and the
// fix: a `request` error had no usable response (not sent, refused, or cut in transit), a `response` error
// is one the response itself reported, or a response that broke its own format.
export type StepEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | ({ type: 'usage' } & Usage)
  | { type: 'stop'; reason: StopReason }
  | { type: 'error'; kind: 'request' | 'response'; text: string }
  | ({ type: 'stats' } & StepStats)

// A provider's key as the backend holds it: cached, not fetched yet (its helper has not run since the
// provider was approved), failed with that failure's line, or none (`auth: "none"`: no key, no helper).
export type ProviderStatus = { provider: string; key: 'cached' | 'not-run' | 'failed' | 'none'; failure?: string }

// What answers routed steps. `configure` takes a validated config's text and the fingerprints of the
// providers approved so far: a helper runs, and a key is kept, only for an approved provider. `start`, called
// in a hook the session outlives, binds the helper process to the session, and brings it up ahead of the
// first step when the config declares a provider, saying nothing when it cannot. `step` streams one step's
// events; aborting `signal` cancels its request, and `once` sends it to klythd once, never again after a
// klythd that died under it. `status` reads key states and never runs a helper.
export type Backend = {
  configure(c: { configText: string; approved: readonly string[] }): Promise<void>
  start(): Promise<void>
  step(req: StepRequest, signal: AbortSignal, opts?: { once?: true; dispatchGuard?(): Promise<boolean> }): AsyncIterable<StepEvent>
  status(): Promise<readonly ProviderStatus[]>
}

// What the mod sends klythd, the helper process that serves steps, with every call: the session's token,
// the validated config text, the fingerprints approved so far, and the User-Agent of provider requests. A
// step adds its request, and is answered with one StepEvent per line. `session` names the engine session the
// step belongs to (its config dir, id and, once known, transcript path), under which klythd keeps the provider
// metadata of its responses; a step without one is served from memory only.
export type Wire = { token: string; configText: string; approved: readonly string[] }
export type StepAccounting = { requestId: string; executionId: string }
export type SessionScope = { configDir: string; id: string; transcript?: string }
export type StepWire = Wire & { session?: SessionScope; req: StepRequest; dispatch?: string; accounting?: StepAccounting }

// A step that failed before it could be answered: its one error, and the stats that end every step.
export const failedStep = (text: string, totalMs = 0): StepEvent[] => [
  { type: 'error', kind: 'request', text },
  statsEvent({ ttfbMs: null, totalMs, reqBytes: 0, in: null, out: null, finish: 'error' }),
]

// What every tool-call id klyth mints starts with: a call of a routed step.
export const ROUTED_ID = 'toolu_klyth_'

// A tool-call id klyth mints for a remote call: Anthropic-shaped, 36 characters, under OpenAI's 40.
export const mintToolId = () => `${ROUTED_ID}${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
