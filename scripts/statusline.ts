// Claude Code's statusLine command: reads only a bounded regular route file; failures fall back to the native model.
// settings.json: { "statusLine": { "type": "command", "command": "bun \"<klyth checkout>/scripts/statusline.ts\"" } }
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'

import { statusLine } from '../hooks/statusline'

// Nonblocking open refuses FIFOs without waiting for a writer; no-follow refuses symlinks before fstat/read.
const read = (path: string) => {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) throw new Error('not a small regular route file')
    const buffer = Buffer.alloc(4096)
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Stop at 64 KiB plus one byte, even if the input stream never ends. Oversized/malformed input is native.
const stdin = () => {
  const buffer = Buffer.alloc(65537)
  let length = 0
  try {
    while (length < buffer.length) {
      const n = readSync(0, buffer, length, buffer.length - length, null)
      if (n === 0) break
      length += n
    }
    return length > 65536 ? '' : buffer.subarray(0, length).toString('utf8')
  } catch {
    return ''
  }
}

console.log(statusLine(stdin(), homedir(), read, !process.env.NO_COLOR))
