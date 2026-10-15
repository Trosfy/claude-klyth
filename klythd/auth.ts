// A provider's key, from its credential helper only: run with no shell, for at most 10 s, and only while the
// provider's fingerprint is among the approved ones a request carries. Steps that need a key at the same
// moment share one helper run. A key is kept for its ttl; what a helper prints is never logged. Reading the
// key states runs nothing. `auth: "none"` has no key (null) and no helper. Pure over a runner and a clock.
import { fingerprint } from '../hooks/config'
import type { Auth, Config, ProviderConfig } from '../hooks/config'
import type { ProviderStatus } from '../hooks/protocol'
import { firstLine, redact } from '../hooks/redact'

// Runs a command to its end, with no shell; rejects when it cannot start or still runs after `timeoutMs`.
// `stderr` is its first line of error output, redacted and cut short, when it printed any.
export type Runner = (argv: readonly string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr?: string }>

const HELPER_TIMEOUT_MS = 10_000
const KEY_MAX = 4096

// Whether `key` is one token of visible ASCII, at most 4 KiB: a space, a control or a non-ASCII character
// would fail the request header, and the error would quote the key.
export const isUsableKey = (key: string) => key.length > 0 && key.length <= KEY_MAX && /^[\x21-\x7e]+$/.test(key)

type Key = { key: string | null; cached: boolean } | { error: string }

export function createKeys(run: Runner, now: () => number) {
  const keys = new Map<string, { key: string; until: number }>() // fingerprint → key, and when it expires
  const failures = new Map<string, string>() // fingerprint → the helper's last failure
  const running = new Map<string, Promise<Key>>() // fingerprint → the helper run in progress

  // Runs the helper and keeps its key for the ttl, or remembers its failure as one line naming the fix.
  async function helper(p: ProviderConfig, auth: Exclude<Auth, 'none'>, fp: string): Promise<Key> {
    const failed = (error: string) => (failures.set(fp, error), { error })
    let r: { exitCode: number; stdout: string; stderr?: string }
    try {
      r = await run(auth.command, HELPER_TIMEOUT_MS)
    } catch (err) {
      return failed(`klyth: ${p.id} key helper did not finish (${redact(firstLine(String(err))).slice(0, 200)}); unlock the keychain or fix auth.command, then retry`)
    }
    // A helper that says why it failed (its first stderr line) is quoted in place of the keychain guess.
    if (r.exitCode !== 0) return failed(`klyth: ${p.id} key helper failed (exit ${r.exitCode}): ${r.stderr ? r.stderr.replace(/^klyth auth: /, '') : `keychain locked, or no key stored? Run bun run auth login ${p.id}`}`)
    const key = r.stdout.trim()
    if (!isUsableKey(key)) return failed(`klyth: ${p.id} key helper printed no usable key (empty, over 4 KiB, or holding spaces, control or non-ASCII characters); run bun run auth login ${p.id}`)
    keys.set(fp, { key, until: now() + auth.ttlSeconds * 1000 })
    failures.delete(fp)
    return { key, cached: false }
  }

  return {
    // Forgets the key and failure of every provider not in `approved`.
    prune(approved: ReadonlySet<string>) {
      for (const map of [keys, failures]) for (const fp of map.keys()) if (!approved.has(fp)) map.delete(fp)
    },
    // The provider's key: the cached one while its ttl lasts, else what its helper prints, trimmed. An
    // unapproved provider's helper never runs.
    async get(p: ProviderConfig, approved: ReadonlySet<string>): Promise<Key> {
      const fp = fingerprint(p)
      if (!approved.has(fp)) return { error: `klyth: ${p.id} not approved — run /model <alias> to approve it` }
      if (p.auth === 'none') return { key: null, cached: false }
      const hit = keys.get(fp)
      if (hit !== undefined && now() < hit.until) return { key: hit.key, cached: true }
      keys.delete(fp)
      let flight = running.get(fp)
      if (flight === undefined) running.set(fp, (flight = helper(p, p.auth, fp).finally(() => running.delete(fp))))
      return flight
    },
    // Drops a key its provider rejected, so the next use runs the helper again.
    drop(p: ProviderConfig) {
      keys.delete(fingerprint(p))
    },
    // Each provider's key state.
    status(config: Config | undefined): ProviderStatus[] {
      return Object.values(config?.providers ?? {}).map(p => {
        if (p.auth === 'none') return { provider: p.id, key: 'none' }
        const fp = fingerprint(p)
        const [hit, failure] = [keys.get(fp), failures.get(fp)]
        if (hit !== undefined && now() < hit.until) return { provider: p.id, key: 'cached' }
        return failure === undefined ? { provider: p.id, key: 'not-run' } : { provider: p.id, key: 'failed', failure }
      })
    },
  }
}
