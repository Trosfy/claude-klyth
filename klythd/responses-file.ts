// The file store of responses.ts: `<configDir>/klyth/responses/<session>.jsonl`, append-only and 0600, one JSON
// record per line; the only module of a step's path that touches the filesystem, so only main.ts imports it.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import type { SessionScope } from '../hooks/protocol'
import { inPrivateDirectory } from '../scripts/private-file'
import { parseJson } from './codec'
import { indexer, valid, type Rec, type ResponseStore } from './responses'

const SESSION = '{"kind":"session",', NAME = /^[A-Za-z0-9_-]{1,128}\.jsonl$/
const { O_APPEND, O_CREAT, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants

// Every whole line of `fd` from `from` on, read through one 64 KiB buffer (a line lives only for its `each` call, one
// spanning reads is joined once), until `each` returns true; returns the offset after the last whole line read.
function scan(fd: number, from: number, each: (line: Buffer, at: number) => boolean | void): number {
  const chunk = Buffer.allocUnsafe(1 << 16), held: Buffer[] = []
  let at = from
  for (let pos = from, n = 1, size = fstatSync(fd).size; pos < size && n > 0; pos += n) {
    const read = chunk.subarray(0, (n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos)))
    let start = 0
    for (let nl; (nl = read.indexOf(10, start)) >= 0; start = nl + 1) {
      const line = held.length === 0 ? read.subarray(start, nl) : Buffer.concat([...held.splice(0), read.subarray(0, nl)])
      if (line.length > 0 && each(line, at)) return at + line.length + 1
      at += line.length + 1
    }
    if (start < read.length) held.push(Buffer.from(read.subarray(start)))
  }
  return at
}
// Whether `path` exists: undefined when lstat fails for another reason than its absence.
const exists = (path: string) => { try { return void lstatSync(path), true } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined } }

// Unlinks each other session's file here whose first `session` record names a transcript now gone; a file never
// confirmed, a transcript that cannot be checked or a read error keeps it.
function sweep(current: string, swept = 0): number {
  try {
    for (const entry of readdirSync('.', { withFileTypes: true })) if (entry.isFile() && entry.name !== current && NAME.test(entry.name)) try {
      let transcript: string | undefined
      const fd = openSync(entry.name, O_RDONLY | O_NOFOLLOW)
      try { scan(fd, 0, line => { const r = line.toString('utf8', 0, SESSION.length) === SESSION ? parseJson(line.toString()) : undefined; return valid(r) && r.kind === 'session' && ((transcript = r.transcript), true) }) } finally { closeSync(fd) }
      if (transcript !== undefined && exists(transcript) === false) (unlinkSync(entry.name), swept++)
    } catch {}
  } catch {}
  return swept
}

function fileStore(scope: SessionScope, swept: Set<string>, log: (line: string) => void) {
  let removed = 0, offset = 0, closed = false
  // The config dir may be reached through a symlink (a moved home, /var on macOS); below it nothing may be one.
  const fds = inPrivateDirectory(realpathSync(scope.configDir), ['klyth', 'responses'], () => {
    if (!swept.has(scope.configDir)) (swept.add(scope.configDir), (removed = sweep(`${scope.id}.jsonl`)))
    const append = openSync(`${scope.id}.jsonl`, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
    try {
      const read = openSync(`${scope.id}.jsonl`, O_RDONLY | O_NOFOLLOW), a = fstatSync(append), r = fstatSync(read)
      if (a.dev === r.dev && a.ino === r.ino && a.isFile() && (a.mode & 0o777) === 0o600 && a.uid === process.getuid!()) return { append, read }
      throw (closeSync(read), new Error('responses file is not private'))
    } catch (err) { throw (closeSync(append), err) }
  })
  const alive = () => { if (closed) throw Object.assign(new Error('responses store closed'), { code: 'closed' }) }
  const read = (at: number, length: number) => { alive(); const b = Buffer.alloc(length); return b.subarray(0, readSync(fds.read, b, 0, length, at)) }
  const index = indexer((at, length) => read(at, length).toString())
  const store = {
    kind: 'file' as const, remote: index.remote, agent: index.agent, blocks: index.blocks,
    refresh: () => void (alive(), (offset = scan(fds.read, offset, (line, at) => index.add(end => line.toString('utf8', 0, end), at, line.length)))),
    affinity: (loop: string, provider: string, seed: string) => index.affinity(loop, provider) ?? (store.record([{ kind: 'affinity', loop, provider, id: seed }]), seed),
    // One write of whole lines, after a newline when the file ends in a torn line (ours or a peer's); a short write throws.
    record(lines: readonly Rec[]) {
      const size = (alive(), fstatSync(fds.append).size), text = Buffer.from((size > 0 && read(size - 1, 1)[0] !== 10 ? '\n' : '') + lines.map(l => `${JSON.stringify(l)}\n`).join(''))
      if (writeSync(fds.append, text) !== text.length) throw Object.assign(new Error('short write'), { code: 'EIO' })
    },
    close: () => void (closed || ((closed = true), closeSync(fds.append), closeSync(fds.read))),
    // The `session` record, once its transcript exists, by which a later daemon's sweep tells the session is gone.
    confirm: (transcript?: string) => void (index.confirmed || transcript === undefined || exists(transcript) !== true || (store.record([{ kind: 'session', v: 1, transcript }]), (index.confirmed = true))),
  }
  try { store.refresh() } catch (err) { throw (store.close(), err) }
  log(`klyth responses ${createHash('sha256').update(scope.id).digest('hex').slice(0, 8)} store=file records=${index.records} dropped=${index.dropped} bytes=${offset} swept=${removed}`)
  return store
}

// The file store of the scope each step names: one at a time, the previous closed when a step names another session;
// one that fails to open is not kept, so the next step opens it again.
export function responseStores(log: (line: string) => void): (scope: SessionScope) => ResponseStore {
  const swept = new Set<string>()
  let current: { key: string; store: ReturnType<typeof fileStore> } | undefined
  return scope => {
    if (current?.key !== `${scope.configDir}\0${scope.id}`) (current?.store.close(), (current = undefined), (current = { key: `${scope.configDir}\0${scope.id}`, store: fileStore(scope, swept, log) }))
    current.store.confirm(scope.transcript)
    return current.store
  }
}
