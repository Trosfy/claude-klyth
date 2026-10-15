// Private directories and immutable publication shared by drafts and recovery records.
import { constants, openSync, closeSync, lstatSync, mkdirSync, writeFileSync, fsyncSync, linkSync, fstatSync, readSync } from 'node:fs'
import { resolve } from 'node:path'

export function inPrivateDirectory<T>(configDir: string, children: readonly string[], action: () => T, create = true): T {
  if (!configDir.startsWith('/') || children.some(part => !/^[a-zA-Z0-9_-]{1,128}$/.test(part))) throw new Error('invalid private location')
  const parts = resolve(configDir).split('/').filter(Boolean)
  const cwd = process.cwd()
  try {
    process.chdir('/')
    for (const [index, part] of [...parts, ...children].entries()) {
      const privateDir = index >= parts.length
      if (privateDir && create) {
        try { mkdirSync(part, { mode: 0o700 }); syncDirectory() } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
      }
      const before = lstatSync(part)
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('private path is not a directory')
      process.chdir(part)
      const stat = lstatSync('.')
      if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('private directory changed')
      if (privateDir && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid!())) throw new Error('directory is not private')
    }
    return action()
  } finally { process.chdir(cwd) }
}

export function syncDirectory(): void {
  const fd = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function publishPrivate(name: string, text: string): void {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error('invalid private filename')
  const pending = name.replace(/\.json$/, '.pending')
  const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  // Both names preserve the same evidence; no destructive cleanup is needed.
  linkSync(pending, name)
  syncDirectory()
}

export function readPrivate(name: string, maxBytes: number): string {
  const before = lstatSync(name)
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid!() || (before.mode & 0o777) !== 0o600 || before.size > maxBytes) throw new Error('invalid private file')
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) throw new Error('private file changed')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0, count = 0
    while (length <= maxBytes && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count
    if (length > maxBytes) throw new Error('private file bounds exceeded')
    return buffer.subarray(0, length).toString('utf8')
  } finally { closeSync(fd) }
}
