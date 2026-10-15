// Preserve a registered OAuth client's host identity without following links or replacing another identity.
import { constants, openSync, closeSync, writeFileSync, fsyncSync, linkSync } from 'node:fs'
import { basename } from 'node:path'
import { hostIdentityPath } from '../hooks/product'
import { inPrivateDirectory, readPrivate, syncDirectory } from './private-file'

const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n?$/
function read(name: string): string | undefined {
  try {
    const text = readPrivate(name, 64)
    if (!HOST_ID.test(text)) throw new Error('invalid host identity')
    return text
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

export function migrateHostIdentity(configDir: string, from: string, to: string): void {
  inPrivateDirectory(configDir, [], () => {
    const source = read(basename(hostIdentityPath(configDir, from)))
    if (source === undefined) throw new Error('source host identity is missing')
    const target = basename(hostIdentityPath(configDir, to))
    const existing = read(target)
    if (existing !== undefined) {
      if (existing.trim() !== source.trim()) throw new Error('destination host identity conflicts')
      return
    }
    // Publish a fully written private inode by exclusive link; an interrupted attempt leaves private evidence.
    const pending = `${target}.${crypto.randomUUID()}.pending`
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, source); fsyncSync(fd) } finally { closeSync(fd) }
    try { linkSync(pending, target); syncDirectory() } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
    if (read(target)?.trim() !== source.trim()) throw new Error('destination host identity did not verify')
  }, false)
}
