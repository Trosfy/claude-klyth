// What klyth offers, derived from a config: every model name, the /model typeahead rows, and the klyth agent
// tool's description and input schema. Pure.
import { NATIVE_MODELS } from './config'
import type { Alias, Config, JsonSchema } from './config'

// Every model name the klyth agent tool offers: native models, aliases and declared provider/models, sorted.
export function modelNames(config: Config): string[] {
  const declared = Object.values(config.providers).flatMap(p => Object.keys(p.models).map(m => `${p.id}/${m}`))
  return [...new Set([...NATIVE_MODELS, ...Object.keys(config.aliases), ...declared])].sort()
}

// The /model typeahead rows for the token at `start`: klyth aliases and declared models after `/model `. An
// alias row reads `<alias>  <note> (<provider>/<model>)`, a model row `<provider>/<model>  klyth model`.
export function typeahead(config: Config, text: string, start: number, token: string) {
  if (!/^\/model\s+$/.test(text.slice(0, start))) return []
  return modelNames(config)
    .filter(n => !NATIVE_MODELS.includes(n) && n.startsWith(token))
    .map(n => {
      const a = config.aliases[n]
      return { text: n, description: a === undefined ? 'klyth model' : a.note ? `${a.note} (${a.target})` : `(${a.target})` }
    })
}

// The klyth agent tool's description: deterministic for a config, aliases sorted by name.
export function advert(config: Config): string {
  const names = Object.keys(config.aliases).sort()
  const rows = names.length
    ? names.map(n => {
        const a = config.aliases[n] as Alias
        return `- ${n}: ${a.target}${a.note ? ` — ${a.note}` : ''}`
      })
    : modelNames(config)
        .filter(n => n.includes('/'))
        .map(n => `- ${n}`)
  return [
    'Launch a subagent like the Agent tool, choosing its model, including custom models (klyth).',
    'Use this instead of Agent when the user asks for a custom model:',
    ...rows,
    'Native: opus, sonnet, haiku, fable.',
  ].join('\n')
}

const BACKGROUND_DESCRIPTION =
  'From the main conversation a subagent runs in the background by default, and you are notified when it completes; from a subagent the call waits for the result. false waits for the result.'
const MODEL_DESCRIPTION =
  "The model: a native alias or a klyth alias from this tool's description. Required, except for subagent_type fork, which runs on the model of the agent that calls it (name that one or none)."
const ISOLATION_DESCRIPTION =
  'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo; it is removed when the agent finishes without changes.'
// The native Agent parameters a klyth agent call can carry (to $.agent.spawn, or to the Agent call klyth makes of
// it), plus klyth's own effort and worktree isolation.
const AGENT_KEYS = ['description', 'prompt', 'subagent_type', 'model', 'effort', 'name', 'isolation', 'run_in_background']

// The klyth agent tool's input schema: native Agent's, narrowed to AGENT_KEYS, with `model` widened to
// modelNames(config) (a call must name one, a fork apart: it runs on its caller's model, so the tool checks
// that), `isolation` offering worktree only, and `run_in_background` saying where false works.
export function agentSchema(config: Config, base: JsonSchema): JsonSchema {
  const properties = (base['properties'] ?? {}) as Readonly<Record<string, JsonSchema>>
  const required = (base['required'] as readonly string[] | undefined) ?? []
  const kept = AGENT_KEYS.filter(k => properties[k] !== undefined)
  const shaped = (k: string): JsonSchema =>
    k === 'model'
      ? { ...properties[k], enum: modelNames(config), description: MODEL_DESCRIPTION }
      : k === 'isolation'
        ? { type: 'string', enum: ['worktree'], description: ISOLATION_DESCRIPTION }
        : k === 'run_in_background'
          ? { type: 'boolean', description: BACKGROUND_DESCRIPTION }
          : (properties[k] as JsonSchema)
  return {
    ...base,
    properties: Object.fromEntries(kept.map(k => [k, shaped(k)])),
    required: required.filter(k => kept.includes(k)),
  }
}
