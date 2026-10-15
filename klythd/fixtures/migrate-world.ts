// Auth entry points over synthetic credentials and offline fixtures.
import { afterAll } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Io } from '../../scripts/auth'
import { cli } from '../../scripts/auth'
import type { Ports } from '../../scripts/chatgpt'
import { fileLock } from '../../scripts/chatgpt'
import type { Run } from '../../scripts/credential-store'

const KEY = 'sk-synthetic-api-secret'
const V1 = 'v1|registered-client|refresh-secret|001800003600|2027-01-15T08:00:00Z|access-secret'
const HOST = 'urn:uuid:00000000-0000-4000-8000-000000000001\n'
const OTHER_HOST = 'urn:uuid:00000000-0000-4000-8000-000000000002\n'
const args = ['migrate', 'acme', '--from', 'styx', '--runtimes-stopped']
const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))
function folder() { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'klyth-migrate-'))); dirs.push(dir); return dir }

type Faults = { source?: string | null; destination?: string; failRead?: string; failLaterRead?: string; readback?: string; race?: string; changed?: string; refuseCreate?: boolean; refuseRemove?: boolean; removeNoop?: boolean; failLock?: string; throwLock?: string; throwRun?: boolean; linux?: boolean }
function world(o: Faults = {}) {
  const dir = folder(), items: Record<string, string> = { ...(o.source === null ? {} : { 'styx:acme': o.source ?? KEY }), ...(o.destination === undefined ? {} : { 'klyth:acme': o.destination }) }
  const log: string[] = [], calls: { argv: readonly string[]; input?: string }[] = [], out: string[] = [], err: string[] = []
  let destinationReads = 0, sourceReads = 0
  const run: Run = async (argv, input) => {
    calls.push({ argv, ...(input === undefined ? {} : { input }) })
    if (o.throwRun) throw new Error(KEY)
    if (argv[1] === '-i') {
      const m = /^add-generic-password( -U)? -s ([a-z]+) -a "([a-z]+)" -l "[^"]+" -w "([^"]+)"\n$/.exec(input ?? '')
      if (!m) throw new Error('bad keychain input')
      const id = `${m[2]}:${m[3]}`
      log.push(`create:${id}`)
      if (o.race !== undefined) items[id] = o.race
      if (o.refuseCreate || (!m[1] && id in items)) return { exitCode: 45, stdout: '' }
      items[id] = m[4]!
      return { exitCode: 0, stdout: '' }
    }
    const id = `${argv[argv.indexOf('-s') + 1]}:${argv[argv.indexOf('-a') + 1]}`
    if (argv[1] === 'delete-generic-password') {
      log.push(`delete:${id}`)
      if (o.refuseRemove) return { exitCode: 51, stdout: '' }
      if (!o.removeNoop) delete items[id]
      return { exitCode: 0, stdout: '' }
    }
    log.push(`read:${id}`)
    if (id === 'klyth:acme') destinationReads++
    else sourceReads++
    if (o.failRead === id || (o.failLaterRead === id && (id === 'klyth:acme' ? destinationReads : sourceReads) > 1)) return { exitCode: 51, stdout: KEY, stderr: KEY }
    if (id === 'styx:acme' && sourceReads === 2 && o.changed !== undefined) items[id] = o.changed
    if (!(id in items)) return { exitCode: 44, stdout: '' }
    return { exitCode: 0, stdout: `${id === 'klyth:acme' && destinationReads > 1 && o.readback !== undefined ? o.readback : items[id]}\n` }
  }
  const io: Io & Ports = {
    platform: o.linux ? 'linux' : 'darwin', which: () => '/synthetic/secret-tool', run,
    configPath: join(dir, 'klyth.json'),  out: s => { out.push(s) }, err: s => { err.push(s) },
    readKey: async () => { throw new Error('must not prompt') }, readLine: async () => { throw new Error('must not prompt') },
    fetch: async () => { throw new Error('must not fetch') }, open: () => { throw new Error('must not open') }, listen: () => { throw new Error('must not listen') },
    pipe: async () => { throw new Error('must not export') }, shield: f => f(), random: () => { throw new Error('must not generate identity') },
    sleep: async () => {}, now: () => Date.now(), pid: process.pid, alive: () => true, stdoutIsTTY: true,
    hostIdPath: join(dir, 'klyth-host-id'),
    lock: (provider, namespace = 'klyth') => {
      const lock = fileLock(join(dir, 'locks', namespace), provider)
      return { ...lock, take: pid => { log.push(`take:${namespace}`); if (o.throwLock === namespace) throw new Error(KEY); return o.failLock === namespace ? false : lock.take(pid) }, holder: () => o.failLock === namespace ? { pid: 123, at: Date.now() } : lock.holder(), release: () => { log.push(`release:${namespace}`); lock.release() } }
    },
  }
  return { dir, items, log, calls, io, out, err, run: (...extra: string[]) => cli([...args, ...extra], io), said: () => [...out, ...err].join('\n') }
}


export { args, dirs, Faults, folder, HOST, KEY, OTHER_HOST, V1, world }
