// Bun-side private-file fixture for the registered harness. No cleanup or provider traffic.
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { recoveryStorage } from '../../scripts/delivery-recovery'
import type { RecoveryRecord } from '../../hooks/delivery-recovery'

export function recoveryFixture(): {
  configDir: string; root: string
  records(sessionId: string): RecoveryRecord[]
  run(stdin: string): { exitCode: number; stdout: string; stderr: string }
} {
  const configDir = mkdtempSync(join(realpathSync(tmpdir()), 'klyth-recovery-harness-'))
  const root = join(import.meta.dir, '../..')
  return {
    configDir, root,
    records: sessionId => recoveryStorage({ action: 'list', configDir, sessionId }).records!.map(item => recoveryStorage({ action: 'get', id: item.backup.id, configDir, sessionId }).record!),
    run: stdin => {
      const child = spawnSync(process.execPath, ['--config=/dev/null', '--no-env-file', join(root, 'scripts/delivery-recovery.ts')], { input: stdin, encoding: 'utf8', timeout: 10_000, maxBuffer: 9 * 1024 * 1024 })
      return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr }
    },
  }
}
