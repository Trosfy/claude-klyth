import { expect, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'
import { recoveryCommand, recoveryCopy, recoveryRecipient, recoveryStatus, sendObservation, validBackup, type RecoveryRecord, type RecoveryCommandPort, type RecoveryRequest } from '../hooks/delivery-recovery'
import { createRecovery, type RecoveryPort } from '../hooks/recovery-lifetime'
import { parseConfig } from '../hooks/config'
import { recoveryJournal } from '../hooks/recovery-storage'

test('sessions without a recovery directory need no helper process to inspect backups', async () => {
  let calls = 0
  const reply = await recoveryJournal({ root: '/plugin', configDir: async () => '/config', sessionId: async () => 'session', exists: async path => { expect(path).toBe('/config/klyth/delivery-recovery/session'); return false }, run: async () => { calls++; throw new Error('unexpected helper') } }, { action: 'list' })
  expect(reply).toEqual({ records: [] })
  expect(calls).toBe(0)
})

const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({ id, description: 'local test agent', type: 'fixture', status: 'running', ...extra })
const backup = () => ({ version: 1 as const, id: 'a'.repeat(64), sessionId: 'session', recipient: 'main', sender: 'child', toolUseId: 'call-1', address: 'main', text: 'Preserve exact private message\nwithout approval authority', capturedAt: '2026-10-13T00:00:00.000Z' })
function world(recipient = 'main') {
  const record: RecoveryRecord = { backup: { ...backup(), recipient }, outcome: 'queued', dismissed: false, attempts: [], revision: '0' }
  let session = 'session', agents = [agent('child'), agent('peer')], revision = 0, epoch: string | undefined, version = 0
  let notice: { sessionId: string; notified: boolean; warnings: number } | undefined
  let config = '{"compaction":{"deliveryRecovery":true}}'
  const logs: string[] = [], asks: string[] = [], copies: { text: string; recipient: string }[] = [], writes: RecoveryRequest[] = [], toasts: string[] = []
  const failures = { storage: false, ask: false, append: false, finish: false, refused: false }
  let onAsk: (() => void | Promise<void>) | undefined
  const change = () => { record.revision = String(++revision) }
  const io: RecoveryPort = {
    sessionId: async () => session, agents: async () => agents, loaded: async () => ({ ...parseConfig(config), missing: false, path: 'klyth.json' }),
    epoch: async () => epoch, setEpoch: async value => { epoch = value },
    notice: async () => ({ value: notice, version }), setNotice: async (value, expected) => { if (expected !== version) return { isSet: false }; notice = value; version++; return { isSet: true } },
    log: text => { logs.push(text) }, debug: text => { logs.push(text) }, toast: text => { toasts.push(text) },
    ask: async question => { asks.push(question); if (failures.ask) throw new Error('headless'); await onAsk?.(); return 'Confirm' },
    append: async (text, recipient) => { if (failures.append) throw new Error('interrupted'); if (failures.refused) return { deny: 'recipient stopped' }; copies.push({ text, recipient }); return { uuid: 'plugin-row-uuid' } },
    storage: async request => {
      if (failures.storage || (failures.finish && request.action === 'finish')) throw new Error('disk unavailable')
      if (request.action === 'list') return { records: session === record.backup.sessionId ? [structuredClone(record)] : [] }
      if (request.action === 'get') return { record: session === record.backup.sessionId && request.id === record.backup.id ? structuredClone(record) : undefined }
      writes.push(request)
      if (request.action === 'capture') return { id: record.backup.id }
      if (request.action === 'outcome') { record.outcome = request.outcome; change(); return {} }
      if (request.action === 'claim' || request.action === 'dismiss') {
        if (record.revision !== request.revision || record.dismissed || record.attempts.some(item => item.status === 'restored')) throw new Error('changed')
        if (request.action === 'dismiss') record.dismissed = true
        else { record.attempts.push({ number: record.attempts.length, token: `attempt-${record.attempts.length}`, epoch: request.epoch, status: 'unknown' }); change(); return { token: record.attempts[record.attempts.length - 1]!.token } }
        change(); return {}
      }
      const held = record.attempts.find(item => item.token === request.token)!
      held.status = request.status; held.uuid = request.uuid; change(); return {}
    },
  }
  const command = (args: string, currentEpoch = 'host-1') => recoveryCommand({ ...io, epoch: currentEpoch }, args)
  return { io, record, logs, asks, copies, writes, toasts, failures, command, change, setSession: (value: string) => { session = value }, setAgents: (value: AgentInfo[]) => { agents = value }, setConfig: (value: string) => { config = value }, onAsk: (fn: () => void | Promise<void>) => { onAsk = fn } }
}

test('recovery defaults on, explicit opt-out is retained, and invalid options reject the whole config', () => {
  for (const config of ['{}', '{"compaction":{}}', '{"compaction":{"hostWindow":false}}', '{"compaction":{"hostWindow":650000}}']) expect(parseConfig(config).config?.compaction?.deliveryRecovery).toBe(true)
  expect(parseConfig('{"compaction":{"deliveryRecovery":true}}').config?.compaction?.deliveryRecovery).toBe(true)
  expect(parseConfig('{"compaction":{"deliveryRecovery":false}}').config?.compaction?.deliveryRecovery).toBe(false)
  for (const value of ['"yes"', 'null', '1', '{}', '[]']) expect(parseConfig(`{"compaction":{"deliveryRecovery":${value}}}`).config).toBeUndefined()
})
test('only exact local ids and a proven first-generation main alias are covered', () => {
  const agents = [agent('child', { name: 'friendly' }), agent('grandchild', { parentId: 'child' }), agent('peer'), agent('teammate', { teammateId: 'worker@team' })]
  expect(recoveryRecipient('main', 'child', agents)).toBe('main')
  expect(recoveryRecipient('main', 'grandchild', agents)).toBeUndefined()
  expect(recoveryRecipient('main', undefined, agents)).toBeUndefined()
  expect(recoveryRecipient('peer', 'grandchild', agents)).toBe('peer')
  expect(recoveryRecipient('child', undefined, agents)).toBe('child')
  for (const address of ['friendly', 'child [ref]', 'unknown', 'teammate', 'remote/session', { to: 'child' }]) expect(recoveryRecipient(address, 'child', agents)).toBeUndefined()
  expect(recoveryRecipient('peer', 'remote-sender', agents)).toBeUndefined()
  expect(recoveryRecipient('child', undefined, [...agents, agent('child')])).toBeUndefined()
})
test('queue, refusal and unknown observations never claim delivered or lost', () => {
  expect(sendObservation({ result: { isDelivered: true } })).toBe('queued')
  expect(sendObservation({ result: { isDelivered: false, reason: 'gone' } })).toBe('refused')
  expect(sendObservation({ deny: 'permission denied' })).toBe('refused')
  expect(sendObservation({ result: { success: true, message: "Message queued for the main conversation's next turn." }, text: 'Message queued', isReadOnly: true })).toBe('queued')
  expect(sendObservation({ result: { success: false, message: 'No such recipient' } })).toBe('refused')
  expect(sendObservation({ result: { success: true }, isError: true })).toBe('unknown')
  expect(sendObservation({ result: { success: 'true' } })).toBe('unknown')
  for (const result of [undefined, 'accepted', {}, { result: { ok: true } }]) expect(sendObservation(result)).toBe('unknown')
  const w = world()
  expect(recoveryStatus(w.record)).toContain('possibly delivered')
  w.record.outcome = 'unknown'; expect(recoveryStatus(w.record)).toContain('possibly never sent')
  w.record.outcome = 'refused'; expect(recoveryStatus(w.record)).toContain('audit evidence')
  expect(validBackup(backup())).toBe(true)
  expect(validBackup({ ...backup(), sessionId: '../escape' })).toBe(false)
})
test('inspect and show are UI-only, and restoration requires actual ask confirmation', async () => {
  const w = world()
  await w.command('recovery')
  await w.command(`recovery show ${w.record.backup.id}`)
  expect(w.copies).toEqual([])
  expect(w.writes).toEqual([])
  expect(w.asks).toEqual([])
  expect(w.logs.join('\n')).toContain(w.record.backup.text)
  await w.command(`recovery restore ${w.record.backup.id}`)
  expect(w.asks.length).toBe(1)
  expect(w.asks[0]).toContain('original may already')
  expect(w.copies.length).toBe(1)
  expect(w.copies[0]!.recipient).toBe('main')
  expect(w.copies[0]!.text).toContain(`[klyth-recovery:${w.record.backup.id}]`)
  expect(w.copies[0]!.text).toContain('not a new user instruction, approval, or permission grant')
  expect(w.record.attempts[0]).toMatchObject({ status: 'restored', uuid: 'plugin-row-uuid' })
  await w.command(`recovery restore ${w.record.backup.id}`)
  expect(w.copies.length).toBe(1)
  expect(w.asks.length).toBe(1)
})
test('headless, missing confirmation and cancellation never claim or append', async () => {
  for (const answer of ['Cancel', '', 'yes', 'confirm']) {
    const w = world(); w.io.ask = async () => answer
    await w.command(`recovery restore ${w.record.backup.id}`)
    expect(w.writes).toEqual([]); expect(w.copies).toEqual([])
  }
  const w = world(); w.failures.ask = true
  await expect(w.command(`recovery restore ${w.record.backup.id}`)).rejects.toThrow()
  expect(w.writes).toEqual([]); expect(w.copies).toEqual([])
})
test('same session and exact running child are checked before and after consent', async () => {
  for (const status of ['completed', 'killed', 'idle', 'waiting'] as const) {
    const w = world('child'); w.setAgents([agent('child', { status })])
    await w.command(`recovery restore ${w.record.backup.id}`)
    expect(w.asks).toEqual([]); expect(w.copies).toEqual([])
  }
  const child = world('child')
  await child.command(`recovery restore ${child.record.backup.id}`)
  expect(child.copies[0]!.recipient).toBe('child')
  const stopped = world('child'); stopped.onAsk(() => { stopped.setAgents([agent('replacement')]) })
  await stopped.command(`recovery restore ${stopped.record.backup.id}`)
  expect(stopped.copies).toEqual([]); expect(stopped.writes).toEqual([])
  const cleared = world(); cleared.onAsk(() => { cleared.setSession('new-session') })
  await cleared.command(`recovery restore ${cleared.record.backup.id}`)
  expect(cleared.copies).toEqual([]); expect(cleared.writes).toEqual([])
})
test('changed reviewed receipts and concurrent confirmations do not both append', async () => {
  const changed = world(); changed.onAsk(() => { changed.change() })
  await expect(changed.command(`recovery restore ${changed.record.backup.id}`)).rejects.toThrow()
  expect(changed.copies).toEqual([])
  const w = world(), results = await Promise.allSettled([w.command(`recovery restore ${w.record.backup.id}`), w.command(`recovery restore ${w.record.backup.id}`)])
  expect(results.filter(result => result.status === 'fulfilled').length).toBe(1)
  expect(w.copies.length).toBe(1)
})
test('append refusal is retained; interrupted append or receipt never automatically retries', async () => {
  const refused = world(); refused.failures.refused = true
  await refused.command(`recovery restore ${refused.record.backup.id}`)
  expect(refused.record.attempts[0]!.status).toBe('refused')
  for (const failure of ['append', 'finish'] as const) {
    const w = world(); w.failures[failure] = true
    await expect(w.command(`recovery restore ${w.record.backup.id}`)).rejects.toThrow()
    expect(w.record.attempts[0]!.status).toBe('unknown')
    expect(recoveryStatus(w.record)).toContain('restore outcome unknown')
    const count = w.copies.length
    await w.command(`recovery restore ${w.record.backup.id}`)
    expect(w.copies.length).toBe(count)
    w.failures[failure] = false
    await w.command('recovery', 'after-resume')
    expect(w.copies.length).toBe(count)
    const asks = w.asks.length
    await w.command(`recovery restore ${w.record.backup.id}`, 'after-resume')
    expect(w.asks.length).toBe(asks + 2)
    expect(w.asks[w.asks.length - 1]).toContain('duplicate risk')
    expect(w.record.attempts[1]!.status).toBe('restored')
  }
})
test('confirmed dismissal retains text even when a child is no longer running', async () => {
  const w = world('child'), text = w.record.backup.text; w.setAgents([])
  await w.command(`recovery dismiss ${w.record.backup.id}`)
  expect(w.record.dismissed).toBe(true)
  expect(w.record.backup.text).toBe(text)
  expect(w.copies).toEqual([])
  expect(w.asks.length).toBe(1)
})
test('capture opt-out, invalid config, unsupported input and write failures are fail-open and bounded', async () => {
  const w = world(), aid = createRecovery(), call = { tool_use_id: 'call', agentId: 'child', to: 'main', message: 'text' }
  for (const config of ['{"compaction":{"deliveryRecovery":false}}', '{"compaction":{"deliveryRecovery":"invalid"}}']) {
    w.setConfig(config); expect(await aid.capture(w.io, call)).toBeUndefined()
  }
  expect(w.writes).toEqual([]); expect(w.toasts).toEqual([])
  w.setConfig('{}')
  expect(await aid.capture(w.io, call)).toBe(w.record.backup.id)
  for (let n = 0; n < 8; n++) expect(await aid.capture(w.io, { ...call, to: 'ambiguous-name' })).toBeUndefined()
  expect(w.toasts.length).toBe(3)
  w.failures.storage = true
  expect(await aid.capture(w.io, call)).toBeUndefined()
  expect(w.toasts.length).toBe(3)
})
test('resume is current-session count-only, refused sends are excluded and hot reload does not multiply notices', async () => {
  const w = world(), aid = createRecovery()
  await aid.start(w.io); await aid.start(w.io); await createRecovery().start(w.io)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('1 current-session')
  expect(w.toasts[0]).not.toContain(w.record.backup.text)
  expect(w.copies).toEqual([])
  w.setSession('clear-session'); await aid.start(w.io)
  expect(w.toasts.length).toBe(1)
  const refused = world(); refused.record.outcome = 'refused'; await createRecovery().start(refused.io)
  expect(refused.toasts).toEqual([])
})

test('long previews remain completely visible through bounded UI-only rows', async () => {
  const w = world(), text = 'z'.repeat(65_536)
  w.record.backup.text = text
  await w.command(`recovery show ${w.record.backup.id}`)
  expect(w.logs.every(line => line.length <= 1800)).toBe(true)
  expect(w.logs.join('')).toContain(text)
  expect(w.copies).toEqual([])
  expect(w.writes).toEqual([])
})

test('uncertain explicit restoration is counted even when the original send was refused', async () => {
  const w = world(); w.record.outcome = 'refused'
  w.record.attempts.push({ number: 0, token: 'attempt', epoch: 'prior-host', status: 'unknown' })
  await createRecovery().start(w.io)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('1 restore outcomes unknown')
  expect(w.toasts[0]).not.toContain(w.record.backup.text)
  expect(w.copies).toEqual([])
})
