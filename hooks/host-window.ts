// The process-wide host compaction window: strict configuration and reload-safe environment ownership.
// State reserves each mutation before the environment changes, so stale dispatches cannot both acquire it.
import type { HostWindowState } from '../types'
export type { HostWindowState } from '../types'

export type Compaction = { hostWindow: number | false; deliveryRecovery?: boolean }
export type HostWindowPort = {
  environment(): Promise<string | undefined>
  setEnvironment(value: string | undefined): Promise<void>
  state(): Promise<{ value: HostWindowState | undefined; version: number }>
  setState(value: HostWindowState, version: number): Promise<{ isSet: boolean; version: number }>
  debug(text: string): void
}

export function compactionOf(raw: unknown, errors: string[]): Compaction {
  const fallback = { hostWindow: 777_000, deliveryRecovery: true }
  if (raw === undefined) return fallback
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('compaction: must be an object')
    return fallback
  }
  for (const key of Object.keys(raw)) if (key !== 'hostWindow' && key !== 'deliveryRecovery') errors.push(`compaction.${key}: unknown key`)
  const recovery = (raw as Record<string, unknown>).deliveryRecovery
  if (recovery !== undefined && typeof recovery !== 'boolean') errors.push('compaction.deliveryRecovery: must be a boolean')
  const option = { deliveryRecovery: typeof recovery === 'boolean' ? recovery : true }
  const value = (raw as Record<string, unknown>).hostWindow
  if (value === undefined) return { ...fallback, ...option }
  if (value === false || (typeof value === 'number' && Number.isInteger(value) && value >= 100_000 && value <= 1_000_000)) return { hostWindow: value, ...option }
  errors.push('compaction.hostWindow: must be false or an integer from 100000 through 1000000')
  return fallback
}

// Unset is stored as null because engine state accepts JSON, not undefined. Pending ownership retains
// the baseline if a host write has an uncertain outcome; it never authorizes a second mutation.
export async function applyHostWindow(io: HostWindowPort, window: number | false | undefined): Promise<void> {
  const note = (text: string) => io.debug(`klyth host compaction window: ${text}`)
  try {
    const held = await io.state()
    const owner = held.value
    if (owner?.pending) {
      note('unfinished environment mutation; baseline retained; restart Claude Code to recover')
      return
    }
    const current = await io.environment()
    if (owner && current !== owner.applied) {
      if (!(await io.setState(null, held.version)).isSet) note('ownership changed while releasing; environment left alone')
      else note('environment changed independently; ownership released without restoration')
      return
    }
    const desired = window === false || window === undefined ? undefined : String(window)
    if ((!owner && desired === undefined) || (owner && current === desired)) {
      if (!(await io.setState(owner ?? null, held.version)).isSet) note('ownership changed during reload; environment left alone')
      return
    }
    if (!owner && current !== undefined && current.length > 1024) {
      note('existing environment value exceeds the ownership bound; left alone')
      return
    }
    const original = owner ? owner.original : current ?? null
    const target = desired ?? (original === null ? undefined : original)
    const pending: HostWindowState = { original, applied: desired ?? owner!.applied, pending: true }
    const reserved = await io.setState(pending, held.version)
    if (!reserved.isSet) {
      note('ownership changed during reload; environment left alone')
      return
    }
    // Environment writes have no compare-and-set. Recheck after reserving state and decline an observed
    // independent write; do not restore it or turn it into a new original value.
    if (await io.environment() !== current) {
      await io.setState(null, reserved.version)
      note('environment changed before mutation; left alone')
      return
    }
    try {
      await io.setEnvironment(target)
    } catch {
      // A failed write that left the value unchanged can safely release its reservation. Otherwise the
      // pending record keeps the baseline instead of guessing whether the host applied the write.
      if (await io.environment() === current) await io.setState(owner ?? null, reserved.version)
      note('environment write failed; no successful policy change reported')
      return
    }
    const saved = await io.setState(desired === undefined ? null : { original, applied: desired }, reserved.version)
    if (!saved.isSet) note('ownership changed after environment write; restart Claude Code to recover')
  } catch {
    note('environment or ownership state unavailable; baseline retained when reserved; retry /klyth reload or restart Claude Code')
  }
}
