// Independent literals pin public identity, production defaults and the clean break from the migration source.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CREDENTIAL_NAMESPACE, ENV, PRODUCT, compactionPath, configPath, hostIdentityPath, recoveryPath, refreshLockDirectory } from '../hooks/product'
import { routeFile } from '../hooks/statusline'
import { loadConfig } from '../hooks/load'
import { asCommand } from '../hooks/model'
import { createSession } from '../hooks/session'
import { recoveryJournal } from '../hooks/recovery-storage'
import { eligibleInput } from '../hooks/classifier-rules'
import { ports } from '../scripts/chatgpt'
import { homedir } from 'node:os'

const root = join(import.meta.dir, '..')
const text = (path: string) => readFileSync(join(root, path), 'utf8')

test('manifest, marketplace, command, tool and state owner are Klyth, with attribution and repository unchanged', () => {
  expect(PRODUCT).toEqual({ displayName: 'Klyth', plugin: 'klyth', command: 'klyth', tool: 'agent', qualifiedTool: 'mcp__klyth__agent', daemon: 'klythd', config: 'klyth.json' })
  expect(CREDENTIAL_NAMESPACE).toBe('klyth')
  const manifest = JSON.parse(text('.claude-plugin/plugin.json')), market = JSON.parse(text('.claude-plugin/marketplace.json'))
  expect(manifest.name).toBe('klyth')
  expect(manifest.author.name).toBe('styx contributors')
  expect(manifest.repository).toBe('https://github.com/Trosfy/claude-klyth')
  expect([market.name, market.plugins[0].name]).toEqual(['klyth', 'klyth'])
  expect(JSON.parse(text('package.json')).name).toBe('klyth')
  expect(text('types/index.d.ts')).toContain('klyth: {')
  expect(text('hooks/register.ts')).toContain("name: 'klyth'")
  expect(text('hooks/register.ts')).toContain("name: 'agent'")
  expect(text('hooks/register.ts')).toContain("tool: 'mcp__klyth__agent'")
  expect(text('hooks/register.ts')).toContain("$.env.get('KLYTH_DELIVERY_RECOVERY_EPOCH')")
  expect(text('hooks/register.ts')).toContain("$.env.set('KLYTH_DELIVERY_RECOVERY_EPOCH', value)")
  expect(text('hooks/register.ts')).toContain("$.env.get('KLYTH_HOST_WINDOW_HANDOFF')")
  expect(text('hooks/register.ts')).not.toContain("plugin: 'styx'")
  expect(text('hooks/product.ts')).not.toMatch(/^import /m)
})

test('path builders preserve config-directory identity versus home-scoped locks and status', () => {
  expect(configPath('/config/')).toBe('/config/klyth.json')
  expect(hostIdentityPath('/config/')).toBe('/config/klyth-host-id')
  expect(refreshLockDirectory('/home/')).toBe('/home/.cache/klyth')
  expect(hostIdentityPath('/config', 'styx')).toBe('/config/styx-host-id')
  expect(refreshLockDirectory('/home', 'styx')).toBe('/home/.cache/styx')
  expect(routeFile('/home', 'session')).toBe('/home/.cache/klyth/statusline/session')
  expect(compactionPath('/config', 'session', 'draft')).toBe('/config/klyth/compactions/session/draft.json')
  expect(recoveryPath('/config/', 'session')).toBe('/config/klyth/delivery-recovery/session')
  // Creating ports and inspecting paths performs no filesystem, keyring or network operations.
  const real = ports('/synthetic-config', 'darwin')
  expect(real.hostIdPath).toBe('/synthetic-config/klyth-host-id')
  expect(real.lock('acme').path).toBe(`${homedir()}/.cache/klyth/acme.lock`)
  expect(real.lock('acme', 'styx').path).toBe(`${homedir()}/.cache/styx/acme.lock`)
})

test('core environment names contain only delivery controls', () => {
  expect(ENV).toEqual({ recoveryEpoch: 'KLYTH_DELIVERY_RECOVERY_EPOCH', hostWindowHandoff: 'KLYTH_HOST_WINDOW_HANDOFF' })
})

test('normal config loading never looks for the legacy config and a new session has no approvals or routes', async () => {
  const paths: string[] = []
  const loaded = await loadConfig({ configDir: async () => '/home/.claude', home: async () => '/home', exists: async path => { paths.push(path); return path.endsWith('/styx.json') }, read: async () => { throw new Error('must not read the old config') }, policy: async () => ({}) })
  expect(paths).toEqual(['/home/.claude/klyth.json'])
  expect(loaded).toEqual({ errors: [], missing: true, path: '~/.claude/klyth.json' })
  const s = createSession()
  expect([...s.approved]).toEqual([])
  expect([...s.routes]).toEqual([])
  expect(s.pin).toBeNull()
  expect(s.main).toBeUndefined()
})

test('recovery existence probe and storage share the Klyth path and do not inspect legacy archives', async () => {
  const paths: string[] = []
  const result = await recoveryJournal({ root: '/plugin', configDir: async () => '/config', sessionId: async () => 'session', exists: async path => { paths.push(path); return false }, run: async () => { throw new Error('must not spawn for an absent archive') } }, { action: 'list' })
  expect(paths).toEqual(['/config/klyth/delivery-recovery/session'])
  expect(result).toEqual({ records: [] })
})

test('classifier hard guards cover both current and explicit migration-source paths and commands', async () => {
  for (const brand of ['klyth', 'styx']) for (const path of [`/workspace/${brand}.json`, `/workspace/${brand}-host-id`, `/workspace/.cache/${brand}/acme.lock`]) {
    const ctx = { cwd: '/workspace', roots: [], prompts: [], all: true, stat: async (p: string) => ({ realPath: p }) }
    expect(await eligibleInput('Write', { file_path: path }, ctx)).toContain('protected path')
    expect(await eligibleInput('Bash', { command: `cat ${path}` }, ctx)).toContain('protected path')
  }
  expect(text('hooks/classifier-rules.ts')).toContain('const NAMED_SECRETS = inText(SECRETS)')
})


test('command replies remove the complete Klyth prefix without stripping native text or its whitespace', () => {
  expect(asCommand({ text: 'klyth: provider acme not approved' })).toEqual({ text: 'provider acme not approved' })
  expect(asCommand({ text: 'klyth: ' })).toEqual({ text: '' })
  expect(asCommand({ text: 'klyth:  intentional leading space' })).toEqual({ text: ' intentional leading space' })
  const native = { text: ' native reply\nklyth: left route' }
  expect(asCommand(native)).toBe(native)
  expect(asCommand({})).toEqual({})
})
