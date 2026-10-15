// Drafts remain context data, even when the active conversation no longer accepts installation.
import type { ProcessRunInit, ProcessRunResult, SessionMessage } from 'claude-code'
import { findBun } from './backend'

export type CompactDraft = { summary: string; target: string; agentId?: string; sourceMessages: number; retained: readonly SessionMessage[] }
type DraftHost = { root: string; configDir(): Promise<string>; sessionId(): Promise<string>; run(argv: readonly string[], init: ProcessRunInit): Promise<ProcessRunResult> }
export async function saveCompactDraft(host: DraftHost, draft: CompactDraft): Promise<string> {
  const bun = await findBun(host.run)
  if (bun === null) throw new Error('draft storage requires Bun; install it before retrying compaction')
  const result = await host.run([bun, '--config=/dev/null', '--no-env-file', `${host.root}/scripts/compact-draft.ts`], {
    stdin: JSON.stringify({ ...draft, configDir: await host.configDir(), sessionId: await host.sessionId() }), env: { BUN_OPTIONS: '' }, timeoutMs: 10_000,
  })
  if (result.exitCode !== 0) throw new Error('private draft storage failed; check config-directory ownership, permissions and available disk space')
  const path = result.stdout.trim()
  if (!path.startsWith('/') || !path.endsWith('.json') || path.includes('\n')) throw new Error('private draft storage returned an invalid path')
  return path
}
