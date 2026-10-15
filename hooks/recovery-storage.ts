// The host provides a process port, not engine authority, to private journal storage.
import { recoveryPath } from './product'
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'
import { findBun } from './backend'
import type { RecoveryReply, RecoveryRequest } from './delivery-recovery'
export type RecoveryStoragePort = {
  root: string; configDir(): Promise<string>; sessionId(): Promise<string>
  run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
  exists(path: string): Promise<boolean>
}
export async function recoveryJournal(io: RecoveryStoragePort, request: RecoveryRequest): Promise<RecoveryReply> {
  const configDir = await io.configDir(), sessionId = await io.sessionId()
  if (request.action === 'list' && !(await io.exists(recoveryPath(configDir, sessionId)))) return { records: [] }
  const bun = await findBun(io.run)
  if (!bun) throw new Error('recovery storage requires Bun')
  const result = await io.run([bun, '--config=/dev/null', '--no-env-file', `${io.root}/scripts/delivery-recovery.ts`], {
    stdin: JSON.stringify({ ...request, configDir, sessionId }),
    env: { BUN_OPTIONS: '' }, timeoutMs: 10_000,
  })
  if (result.exitCode !== 0 || result.isStdoutTruncated || result.stdout.length > 4 * 1024 * 1024) throw new Error('private recovery journal unavailable, full, corrupt, or changed; evidence retained')
  const reply: unknown = JSON.parse(result.stdout)
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('invalid recovery storage reply')
  return reply as RecoveryReply
}
