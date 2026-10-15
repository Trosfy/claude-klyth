// What klyth shows the person: how a target is named, the status line (quiet: a short segment while routed,
// nothing when native) and the /klyth report, where the details live. Pure; the engine draws `klyth:` in front
// of a pinned status itself.
import { EFFORTS, own } from './config'
import type { Alias, Config, ProviderConfig } from './config'
import { resolve } from './names'
import type { ProviderStatus, StepStats } from './protocol'
import { STAMP } from './schemas.gen'
import type { Session } from './session'
import { clearRecord, record, viaCommand } from './statusline'
import type { RecordPort } from './statusline'

// A route's target is an alias or a `provider/model`. The `provider/model` it names:
export const modelOf = (config: Config | undefined, target: string) => (config === undefined ? undefined : own(config.aliases, target))?.target ?? target

// The alias a route's target is, else the first alias (by name) that names it, else the target itself.
export function labelOf(config: Config | undefined, target: string) {
  if (config !== undefined && own(config.aliases, target) !== undefined) return target
  return Object.keys(config?.aliases ?? {})
    .sort()
    .find(a => config?.aliases[a]?.target === target) ?? target
}

// A target as the person reads it: `<alias> (<provider>/<model>)`, or `<provider>/<model>` with no alias.
export function shownTarget(config: Config | undefined, target: string) {
  const [label, model] = [labelOf(config, target), modelOf(config, target)]
  return label === model ? model : `${label} (${model})`
}

// A target as main's state reads it: `<alias> → <provider>/<model>`, or `<provider>/<model>` with no alias.
function pointing(config: Config | undefined, target: string) {
  const [label, model] = [labelOf(config, target), modelOf(config, target)]
  return label === model ? model : `${label} → ${model}`
}

// The status line while klyth holds main: `<alias> · <provider>`, or `<provider>/<model> · <provider>` with no
// alias; undefined when main is native.
export function statusText(config: Config | undefined, target: string | null | undefined): string | undefined {
  if (!target) return undefined
  const [label, model] = [labelOf(config, target), modelOf(config, target)]
  // An alias with no config to resolve it has no provider to show.
  return model.includes('/') ? `${label} · ${model.slice(0, model.indexOf('/'))}` : label
}

export type StatusPort = RecordPort & { status(text: string | undefined): void }

// Shows main's current target: pinned as klyth's status line, or, with `statusLine: "command"`, recorded for the
// status line command Claude Code runs (statusline.ts) while any pinned line is cleared.
export async function showStatus(io: StatusPort, s: Session) {
  const text = statusText(s.loaded.config, s.main)
  if (!viaCommand(s)) {
    io.status(text)
    return clearRecord(io, s)
  }
  io.status(undefined)
  await record(io, s, text ?? '')
}

// Rows padded into aligned columns two spaces apart, the last column unpadded.
function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = []
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
  return rows.map(r => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ')}`.trimEnd())
}

const seconds = (ms: number | null) => (ms === null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
// A token count as a line shows it: thousands rounded to `k`.
export const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// A routed step's stats on one line: time to the first byte, total time, tokens in and out, how it ended.
export const statsLine = (st: StepStats) => `ttfb ${seconds(st.ttfbMs)} · total ${seconds(st.totalMs)} · in ${st.in ?? '–'} · out ${st.out ?? '–'} · ${st.finish}`

export type ReportPort = {
  // The engine's own model.
  engineModel(): Promise<string>
  // Each provider's key state as the backend holds it: reading them runs no helper.
  keys(): Promise<readonly ProviderStatus[]>
  trusted(p: ProviderConfig): Promise<boolean>
}

const LAST_STEPS = 5

// The /klyth report: main's target, a table of providers and one of aliases, routed subagents, the last routed
// steps, tool and schema gaps, the classifier (when the config turns it on), worktree cleanup, and the one next step when
// something is wrong.
export async function report(io: ReportPort, s: Session): Promise<string[]> {
  const config = s.loaded.config
  const next: string[] = []
  const lines: string[] = []
  if (config === undefined) {
    if (s.loaded.missing) {
      lines.push(`klyth · routing off: no ${s.loaded.path}`)
      next.push(`copy example.klyth.json to ${s.loaded.path} and fill it in, then run /klyth reload`)
    } else {
      lines.push(`klyth · routing off: ${s.loaded.path} has errors`, ...s.loaded.errors.map(err => `  ${err}`))
      next.push(`fix ${s.loaded.path} (errors above), then run /klyth reload`)
    }
  } else {
    lines.push(`klyth · main: ${s.main ? pointing(config, s.main) : `native (${await io.engineModel()})`}`)
    const providers: string[][] = [['PROVIDER', 'KIND', 'ORIGIN', 'KEY', 'APPROVED']]
    const keys = new Map((await io.keys()).map(k => [k.provider, k]))
    for (const p of Object.values(config.providers)) {
      const key = keys.get(p.id)
      const trusted = await io.trusted(p)
      providers.push([p.id, p.kind, p.origin, key?.key === 'none' ? 'none' : `cmd ${key?.key === 'cached' ? 'cached' : key?.key === 'failed' ? 'failed' : 'not yet run'}`, trusted ? 'yes' : 'no'])
      if (key?.failure !== undefined) next.push(key.failure.replace(/^klyth: /, ''))
      const via = Object.keys(config.aliases)
        .sort()
        .find(a => config.aliases[a]?.target.startsWith(`${p.id}/`))
      if (!trusted) next.push(`run /model ${via ?? `${p.id}/${Object.keys(p.models)[0]}`} once to approve ${p.id}`)
    }
    const aliases: string[][] = [['ALIAS', 'TARGET', 'EFFORT', 'NOTE']]
    for (const a of Object.keys(config.aliases).sort()) {
      const alias = config.aliases[a] as Alias
      const t = resolve(config, alias.target)
      const levels = t?.kind === 'remote' ? EFFORTS.filter(l => t.model.effort?.[l] !== undefined).join(' ') : ''
      aliases.push([a, alias.target, levels || 'none', alias.note ?? ''])
    }
    if (Object.keys(config.aliases).length === 0) aliases.push(['(none)', '', '', ''])
    lines.push(...table(providers), ...table(aliases))
  }
  const routed = [...s.routes.entries()].filter(([, r]) => r.target !== null).slice(-10)
  lines.push(`  routed subagents: ${routed.map(([id, r]) => `${id} → ${r.label}`).join(', ') || 'none'}`)
  for (const [who, last] of [...s.lastSteps.entries()].slice(-LAST_STEPS)) lines.push(`  last step ${who} → ${labelOf(config, last.target)}: ${statsLine(last.stats)} · prompt ${last.prompt}`)
  const { schemaless, capped, long, cap } = s.toolReport
  if (schemaless.length > 0) lines.push(`  tools without schema (sent permissive): ${schemaless.join(', ')}`)
  if (capped.length > 0) lines.push(`  tools dropped (cap ${cap}): ${capped.join(', ')}`)
  if (long.length > 0) lines.push(`  tools dropped (name over 64 chars): ${long.join(', ')}`)
  const stamp = s.notes.find(n => n.startsWith('schemas:'))
  lines.push(`  ${stamp ?? `schemas: generated on ${STAMP.engineVersion} · OK`}`)
  if (stamp !== undefined) next.push('regenerate the tool schemas with bun scripts/gen-schemas.ts')
  for (const n of s.notes.filter(n => !n.startsWith('schemas:'))) lines.push(`  ${n}`)
  const classifier = config?.classifier
  const { allowed, asked, skipped } = s.classifierStats
  if (classifier !== undefined) lines.push(`  classifier: ${classifier.model} · ${classifier.context} context · ${classifier.tools} tools · ${allowed} allowed · ${asked} asked · ${skipped} not classified${s.classifierIneligible === undefined ? '' : ` · last ineligible (${s.classifierIneligible})`}`)
  lines.push(`  worktree cleanup: ${s.trashPath ? `to the Trash (${s.trashPath})` : 'none (no trash command found; worktrees are kept)'}`)
  if (next.length > 0) lines.push(`  next: ${next[0]}`)
  return lines
}
