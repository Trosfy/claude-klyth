// Recovery coordination is pure over small ports; the composition root retains all host authority.
import type { AgentInfo } from 'claude-code'
import type { Loaded } from './load'
import { recoveryCommand, recoveryRecipient, sendObservation, type RecoveryCommandPort } from './delivery-recovery'

export type RecoveryNotice = { sessionId: string; notified: boolean; warnings: number; epoch?: string }
export type RecoveryPort = Omit<RecoveryCommandPort, 'epoch'> & {
  loaded(): Promise<Loaded>
  epoch(): Promise<string | undefined>; setEpoch(value: string): Promise<void>
  notice(): Promise<{ value: RecoveryNotice | undefined; version: number }>
  setNotice(value: RecoveryNotice, version: number): Promise<{ isSet: boolean }>
  toast(text: string): void; debug(text: string): void
}
export type RecoveryCall = { tool_use_id: string; agentId?: string; to: unknown; message?: unknown }
export function createRecovery() {
  let lifetime: Promise<string> | undefined
  const epoch = (io: RecoveryPort) => lifetime ??= (async () => {
    const old = await io.epoch()
    const value = old ?? crypto.randomUUID()
    if (old === undefined) await io.setEpoch(value)
    // An empty initial journal needs no environment write. Its first opted-in use joins that
    // already-notified lifetime without turning a code reload into a second startup notice.
    const held = await io.notice()
    if (held.value?.sessionId === await io.sessionId() && held.value.epoch === undefined) await io.setNotice({ ...held.value, epoch: value }, held.version)
    return value
  })()
  async function warn(io: RecoveryPort): Promise<void> {
    try {
      const sessionId = await io.sessionId(), held = await io.notice()
      const old = held.value?.sessionId === sessionId ? held.value : { sessionId, notified: false, warnings: 0 }
      if (old.warnings >= 3) return
      if ((await io.setNotice({ ...old, warnings: old.warnings + 1 }, held.version)).isSet) io.toast('klyth: this SendMessage was not backed up (unsupported recipient/payload, journal unavailable or capacity reached). The original send still runs normally. Coverage warnings are bounded; /klyth recovery inspects existing backups.')
    } catch { /* Coverage failure never changes the original tool call. */ }
  }
  return {
    async start(io: RecoveryPort): Promise<void> {
      try {
        const records = (await io.storage({ action: 'list' })).records ?? []
        const currentEpoch = records.length ? await epoch(io) : await io.epoch()
        const sessionId = await io.sessionId(), held = await io.notice()
        if (held.value?.sessionId === sessionId && held.value.notified && held.value.epoch === currentEpoch) return
        const pending = records.filter(record => !record.dismissed && !record.attempts.some(attempt => attempt.status === 'restored') && (record.outcome !== 'refused' || record.attempts.some(attempt => attempt.status === 'unknown')))
        const count = pending.length, uncertain = pending.filter(record => record.attempts.some(attempt => attempt.status === 'unknown')).length
        const value = { sessionId, epoch: currentEpoch, notified: true, warnings: held.value?.sessionId === sessionId ? held.value.warnings : 0 }
        if ((await io.setNotice(value, held.version)).isSet && count) io.toast(`klyth: ${count} current-session recovery backups may need review${uncertain ? ` (${uncertain} restore outcomes unknown)` : ''}; original delivery is unproven. Run /klyth recovery. No automatic replay.`)
      } catch { io.debug('klyth recovery: current-session journal could not be inspected; evidence retained.') }
    },
    async capture(io: RecoveryPort, call: RecoveryCall): Promise<string | undefined> {
      try {
        if ((await io.loaded()).config?.compaction?.deliveryRecovery !== true) return undefined
        await epoch(io)
        const agents: readonly AgentInfo[] = await io.agents()
        const recipient = recoveryRecipient(call.to, call.agentId, agents)
        if (recipient === undefined || typeof call.to !== 'string' || typeof call.message !== 'string' || !call.message || new TextEncoder().encode(call.message).length > 65_536) { await warn(io); return undefined }
        const saved = await io.storage({ action: 'capture', sender: call.agentId ?? 'main', toolUseId: call.tool_use_id, recipient, address: call.to, text: call.message })
        if (!saved.id) { await warn(io); return undefined }
        return saved.id
      } catch { await warn(io); return undefined }
    },
    async observe(io: RecoveryPort, id: string | undefined, result: unknown): Promise<void> {
      if (!id) return
      try { await io.storage({ action: 'outcome', id, outcome: sendObservation(result) }) }
      catch { io.debug('klyth recovery: backup retained, send outcome unknown.') }
    },
    async command(io: RecoveryPort, args: string): Promise<{ text: string } | undefined> {
      if (args.trim().split(/\s+/)[0] !== 'recovery') return undefined
      try { await recoveryCommand({ ...io, epoch: await epoch(io) }, args) }
      catch { io.log('klyth recovery: journal or restore state unavailable/changed; any append outcome may be unknown. No automatic retry. Review /klyth recovery after resume; existing evidence is retained.') }
      return { text: '' }
    },
  }
}
