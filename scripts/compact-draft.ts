// Publish an immutable private draft through verified working directories, never following symlinks.
import { compactionParts, compactionPath } from '../hooks/product'
import { resolve } from 'node:path'
import { inPrivateDirectory, publishPrivate } from './private-file'

export function storeDraft(input: { configDir: string; sessionId: string; summary: string; target: string; agentId?: string; sourceMessages: number; retained: unknown[] }, id: string = crypto.randomUUID()): string {
  if (!input.configDir.startsWith('/') || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('invalid draft location')
  if (!input.summary || input.summary.length > 32_000 || JSON.stringify(input.retained).length > 24_000) throw new Error('invalid draft bounds')
  const config = resolve(input.configDir)
  return inPrivateDirectory(config, compactionParts(input.sessionId), () => {
    const { configDir: _config, ...data } = input
    publishPrivate(`${id}.json`, JSON.stringify({ version: 1, status: 'draft-not-installed', createdAt: new Date().toISOString(), ...data }) + '\n')
    return compactionPath(config, input.sessionId, id)
  })
}

if (import.meta.main) {
  try { console.log(storeDraft(JSON.parse(await Bun.stdin.text()))) }
  catch { console.error('Private draft publication failed.'); process.exitCode = 1 }
}
