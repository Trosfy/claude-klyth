// Explicit stopped-runtime migration. No route, approval, archive or config state is transferred.
import { dirname } from 'node:path'
import { CREDENTIAL_NAMESPACE, LEGACY_CREDENTIAL_NAMESPACE } from '../hooks/product'
import { isUsableKey } from '../klythd/auth'
import type { LockPort, Ports } from './chatgpt'
import { acquire, isSignIn, parseItem, reservedRecord } from './chatgpt'
import type { Run, Store } from './credential-store'
import { keychain, lookup, secretTool } from './credential-store'
import type { ExtraSignIn } from './extra-sign-in'
import type { ExtraClientId, ExtraMethod } from './extras'
import { migrateHostIdentity } from './migrate-host'

type MigrationIo = Pick<Ports, 'lock' | 'pid' | 'alive' | 'now'> & { run: Run; hostIdentity(): void; extraSignIn?: ExtraSignIn<ExtraClientId, ExtraMethod> }
export type MigrationResult = { ok: boolean; message: string }
export async function migrate(io: MigrationIo, provider: string, source: Store, destination: Store, retire: boolean): Promise<MigrationResult> {
  const fail = (message: string): MigrationResult => ({ ok: false, message: `${message}; migration did not finish; a partial destination may remain and source status may need verification; keep both runtimes stopped and retry` })
  if (!destination.create) return { ok: false, message: 'migration is unsupported by this keyring: safe absence and create-only storage are required; nothing changed' }
  if (source.namespace !== LEGACY_CREDENTIAL_NAMESPACE || destination.namespace !== CREDENTIAL_NAMESPACE || !/^[a-z][a-z0-9-]{0,31}$/.test(provider)) return { ok: false, message: 'invalid migration identity; nothing changed' }
  const held: LockPort[] = []
  try {
    // Namespace order is stable across retries; use the same provider locks as token refresh.
    for (const namespace of [source.namespace, destination.namespace].sort()) {
      const lock = io.lock(provider, namespace)
      if (acquire(io, lock) !== true) return fail('could not acquire both refresh locks')
      held.push(lock)
    }
    const old = await lookup(io.run, source, provider)
    if (old.status !== 'found') return fail(old.status === 'missing' ? 'no source item' : 'source keyring lookup failed')
    const parsed = isSignIn(old.value) ? parseItem(old.value, io.extraSignIn) : undefined
    if (reservedRecord(old.value) ? parsed === undefined : !isUsableKey(old.value)) return fail(reservedRecord(old.value) ? 'looks like a sign-in record; nothing stored' : 'source is not a recognized credential record')
    const current = await lookup(io.run, destination, provider)
    if (current.status === 'error') return fail('destination keyring lookup failed')
    if (current.status === 'found' && current.value !== old.value) return fail('destination already holds a different item')
    if (parsed?.method === 'v1') {
      try { io.hostIdentity() } catch { return fail('host identity is missing, unsafe, unreadable or conflicting') }
    }
    if (current.status === 'missing') {
      const create = destination.create(provider, old.value)
      if (typeof create === 'string') return fail(`destination refused create-only storage: ${create}`)
      const created = await io.run(create.argv, create.input)
      if (created.exitCode !== 0) return fail('destination create failed (possibly another item appeared)')
    }
    const back = await lookup(io.run, destination, provider)
    if (back.status !== 'found' || back.value !== old.value) return fail('destination readback did not verify')
    if (retire) {
      const latest = await lookup(io.run, source, provider)
      if (latest.status !== 'found' || latest.value !== old.value) return fail('source changed or became unreadable before retirement')
      if ((await io.run(source.del(provider))).exitCode !== 0) return fail('source removal failed after verified copy')
      const gone = await lookup(io.run, source, provider)
      if (gone.status !== 'missing') return fail('source removal could not be verified')
    }
    return { ok: true, message: retire ? 'complete record verified in Klyth; source item retired (host identity retained)' : 'complete record verified in Klyth; source preserved. Do not let both copies refresh concurrently; keep the old runtime stopped' }
  } catch { return fail('migration operation failed') }
  finally { for (const lock of held.reverse()) lock.release() }
}

export const MIGRATE_USAGE = 'bun run auth migrate <provider> --from styx --runtimes-stopped [--retire-source]'
export async function migrateCli(args: readonly string[], io: Pick<Ports, 'lock' | 'pid' | 'alive' | 'now'> & { extraSignIn?: ExtraSignIn<ExtraClientId, ExtraMethod>; platform: string; which(name: string): string | undefined; run: Run; configPath: string; out(line: string): void; err(line: string): void }): Promise<number> {
  const [provider, ...flags] = args
  const at = flags.indexOf('--from')
  const remaining = at < 0 ? flags : [...flags.slice(0, at), ...flags.slice(at + 2)]
  if (!provider || !/^[a-z][a-z0-9-]{0,31}$/.test(provider) || at < 0 || flags[at + 1] !== LEGACY_CREDENTIAL_NAMESPACE || !remaining.includes('--runtimes-stopped') || new Set(remaining).size !== remaining.length || remaining.some(f => f !== '--runtimes-stopped' && f !== '--retire-source')) {
    io.err(`klyth auth: usage: ${MIGRATE_USAGE}\n--runtimes-stopped acknowledges that both old and new runtimes and all other auth commands are stopped; --retire-source removes the source item only after verified copy and required host identity preservation. Destination is always Klyth. No interactive prompts.`)
    return 2
  }
  const bin = io.platform === 'linux' ? io.which('secret-tool') : undefined
  const factory = io.platform === 'darwin' ? keychain : bin ? (namespace: string) => secretTool(bin, namespace) : undefined
  if (!factory) return io.err('klyth auth: no supported keyring; nothing changed'), 1
  const result = await migrate({ ...io, hostIdentity: () => migrateHostIdentity(dirname(io.configPath), LEGACY_CREDENTIAL_NAMESPACE, CREDENTIAL_NAMESPACE) }, provider, factory(LEGACY_CREDENTIAL_NAMESPACE), factory(CREDENTIAL_NAMESPACE), remaining.includes('--retire-source'))
  ;(result.ok ? io.out : io.err)(`klyth auth: ${provider}: ${result.message}`)
  return result.ok ? 0 : 1
}
