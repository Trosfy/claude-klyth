// OS keyring command adapters. Values travel only on stdin; lookup failures never imply absence.
import { CREDENTIAL_NAMESPACE } from '../hooks/product'

export type Run = (argv: readonly string[], input?: string) => Promise<{ exitCode: number; stdout: string; stderr?: string }>
export type Lookup = { status: 'found'; value: string } | { status: 'missing' } | { status: 'error' }
type Command = { argv: string[]; input: string } | string
export type Store = {
  name: string; namespace: string
  find(p: string): string[]; read(p: string): string[]
  add(p: string, value: string): Command
  create?(p: string, value: string): Command
  del(p: string): string[]
  missing(result: Awaited<ReturnType<Run>>, run: Run, provider: string): boolean | Promise<boolean>
}
const SECURITY = '/usr/bin/security'
const LINE_MAX = 4000
const validName = (name: string) => { if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error('invalid credential name'); return name }

export function keychain(namespace = CREDENTIAL_NAMESPACE): Store {
  validName(namespace)
  const item = (p: string) => [SECURITY, 'find-generic-password', '-s', namespace, '-a', validName(p)]
  const write = (p: string, value: string, update: boolean): Command => {
    validName(p)
    if (!/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) return `a key holding " or \\ or non-visible characters would be misread by security -i; nothing stored`
    const input = `add-generic-password${update ? ' -U' : ''} -s ${namespace} -a "${p}" -l "${namespace} ${p}" -w "${value}"\n`
    const bytes = Buffer.byteLength(input)
    return bytes > LINE_MAX ? `storing ${p} takes a ${bytes}-byte security -i line, over its ${LINE_MAX}-byte limit; nothing stored` : { argv: [SECURITY, '-i'], input }
  }
  return { name: 'macOS Keychain', namespace, find: item, read: p => [...item(p), '-w'], add: (p, value) => write(p, value, true), create: (p, value) => write(p, value, false), del: p => [SECURITY, 'delete-generic-password', '-s', namespace, '-a', validName(p)], missing: r => r.exitCode === 44 }
}

export function secretTool(bin: string, namespace = CREDENTIAL_NAMESPACE): Store {
  validName(namespace)
  const look = (p: string) => [bin, 'lookup', 'service', namespace, 'provider', validName(p)]
  const missing: Store['missing'] = async (r, run, p) => {
    // A dismissed unlock also makes lookup exit 1 silently. Search without --unlock still lists locked matches.
    if (r.exitCode !== 1 || r.stdout !== '' || r.stderr !== '') return false
    try {
      const matches = await run([bin, 'search', '--all', 'service', namespace, 'provider', validName(p)])
      // Search exits 0 even with no matches; any metadata or diagnostic means absence is unproven.
      return matches.exitCode === 0 && matches.stdout === '' && matches.stderr === ''
    } catch { return false }
  }
  // secret-tool store replaces an existing match. It is not a migration create primitive.
  return { name: 'secret-tool', namespace, find: look, read: look, add: (p, value) => ({ argv: [bin, 'store', `--label=${namespace} ${validName(p)}`, 'service', namespace, 'provider', p], input: value }), del: p => [bin, 'clear', 'service', namespace, 'provider', validName(p)], missing }
}

export async function lookup(run: Run, store: Store, provider: string): Promise<Lookup> {
  try {
    const r = await run(store.read(provider))
    if (r.exitCode === 0) return { status: 'found', value: r.stdout.replace(/\n$/, '') }
    return { status: await store.missing(r, run, provider) ? 'missing' : 'error' }
  } catch { return { status: 'error' } }
}

// Presence is metadata-only. Linux's lookup and search may unlock or extract secrets, so neither is used.
export type Presence = { status: 'found' | 'missing' | 'error' | 'unknown' }
export async function credentialPresence(run: Run, store: Store, provider: string): Promise<Presence> {
  validName(provider)
  if (store.name !== 'macOS Keychain') return { status: 'unknown' }
  try {
    const result = await run(store.find(provider))
    return { status: result.exitCode === 0 ? 'found' : result.exitCode === 44 ? 'missing' : 'error' }
  } catch { return { status: 'error' } }
}
