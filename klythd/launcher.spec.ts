import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launcherText, LAUNCHER_MARKER } from '../hooks/launcher'
import { installLauncher } from '../scripts/install-launcher'
import { launcherPaths, validLauncher } from '../scripts/launcher'
import { parseConfig } from '../hooks/config'

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))
const source = realpathSync(join(import.meta.dir, '..'))
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'klyth-launcher-'))); dirs.push(dir)
  const home = join(dir, 'home space'), root = join(dir, 'release space')
  mkdirSync(home); symlinkSync(source, root)
  const dest = `${home}/.local/bin/klyth`, record = `${home}/.local/share/klyth/launcher`
  const run = (version = '0.2.1', target = root, publish: (from: string, to: string) => void = linkSync) => {
    if (publish !== linkSync) return installLauncher(home, target, version, publish).status
    const result = Bun.spawnSync([process.execPath, '--config=/dev/null', '--no-env-file', `${source}/scripts/install-launcher.ts`, home, target, version], { env: { ...process.env, HOME: home } })
    expect(result.exitCode).toBe(0)
    return JSON.parse(result.stdout.toString()).status
  }
  return { dir, home, root, dest, record, run, text: (version = '0.2.1', target = root) => launcherText(home, target, version)! }
}

test('fresh publication records first, is executable, is current, and respects user removal', () => {
  const f = fixture()
  expect(f.run('0.2.1', f.root, (temp, dest) => { expect(existsSync(f.record)).toBe(true) })).toBe('installed')
  expect(readFileSync(f.dest, 'utf8')).toBe(f.text())
  expect(validLauncher({ KLYTH_LAUNCHER: f.dest }, f.home)).toBe(f.dest)
  expect(f.run()).toBe('current')
  renameSync(f.dest, `${f.dest}.saved`)
  expect(f.run()).toBe('removed')
  expect(existsSync(f.dest)).toBe(false)
})

test('a record alone means removal and existing Klyth files gain a missing record before comparison', () => {
  const f = fixture(); launcherPaths(f.home, true)
  writeFileSync(f.record, '1\n'); expect(f.run()).toBe('removed')
  rmSync(f.record); writeFileSync(f.dest, f.text(), { mode: 0o755 })
  expect(f.run()).toBe('current'); expect(existsSync(f.record)).toBe(true)
  rmSync(f.record); writeFileSync(f.dest, f.text('9.0.0'))
  expect(f.run()).toBe('older'); expect(existsSync(f.record)).toBe(true)
})

test('directory and symlink publication races preserve the foreign destination', () => {
  for (const kind of ['directory', 'symlink', 'directory-link'] as const) {
    const f = fixture(); launcherPaths(f.home, true)
    const foreign = `${f.dir}/foreign`; writeFileSync(foreign, 'user content')
    const publish = (temp: string, dest: string) => {
      if (kind === 'directory') mkdirSync(dest)
      else symlinkSync(kind === 'symlink' ? foreign : f.dir, dest)
    }
    expect(f.run('0.2.1', f.root, publish)).toBe('foreign')
    expect(readFileSync(foreign, 'utf8')).toBe('user content')
    expect(existsSync(f.record)).toBe(false)
    expect(f.run()).toBe('foreign')
  }
})

test('unsafe path chains and noncanonical homes skip without publishing', () => {
  for (const component of ['.local', '.local/bin', '.local/share', '.local/share/klyth']) {
    const f = fixture(); launcherPaths(f.home, true)
    chmodSync(`${f.home}/${component}`, 0o777)
    expect(f.run()).toBe('skipped')
    expect(validLauncher({ KLYTH_LAUNCHER: f.dest }, f.home)).toBeUndefined()
  }
  const f = fixture(); mkdirSync(`${f.home}/.local`); symlinkSync(f.dir, `${f.home}/.local/bin`)
  expect(f.run()).toBe('skipped')
  const alias = `${f.dir}/alias`; symlinkSync(f.home, alias)
  expect(installLauncher(alias, f.root, '0.2.1').status).toBe('skipped')
})

test('numeric versions, equal roots, missing roots and malformed release metadata choose the right release', () => {
  for (const [prior, next, expected] of [['0.2.9', '0.2.10', 'updated'], ['0.9.0', '0.10.0', 'updated'], ['0.2.10', '0.2.9', 'older'], ['0.10.0', '0.9.0', 'older']] as const) {
    const f = fixture(); expect(f.run(prior)).toBe('installed'); expect(f.run(next)).toBe(expected)
  }
  const f = fixture(); f.run('3.0.0')
  const other = `${f.dir}/other release`; symlinkSync(source, other)
  expect(f.run('3.0.0', other)).toBe('updated')
  writeFileSync(f.dest, f.text('9.0.0', `${f.dir}/missing release`))
  expect(f.run('0.1.0')).toBe('updated')
  writeFileSync(f.dest, `#!/bin/sh\n${LAUNCHER_MARKER}\n# broken\n`)
  expect(f.run()).toBe('updated')
})

test('live locks are busy and dead locks recover fixed temp files', () => {
  const f = fixture(); launcherPaths(f.home, true)
  const lock = `${f.record}.lock`
  writeFileSync(lock, `${process.pid}\n`); expect(f.run()).toBe('busy')
  writeFileSync(lock, '2147483647\n')
  const temps = [`${f.home}/.local/bin/.klyth-launcher.tmp`, `${f.record}.tmp`]
  temps.forEach(path => writeFileSync(path, 'leftover'))
  expect(f.run()).toBe('installed')
  expect(existsSync(f.record)).toBe(true)
  expect(temps.map(existsSync)).toEqual([false, false])
  expect(existsSync(lock)).toBe(false); expect(f.run()).toBe('current')
})

test('two real installer processes serialize fresh publication and stale-lock takeover', async () => {
  for (const stale of [false, true]) {
    const f = fixture(); launcherPaths(f.home, true)
    if (stale) writeFileSync(`${f.record}.lock`, '2147483647\n')
    const children = [1, 2].map(() => Bun.spawn([process.execPath, '--config=/dev/null', '--no-env-file', `${source}/scripts/install-launcher.ts`, f.home, f.root, '0.2.1'], { stdout: 'pipe', stderr: 'pipe' }))
    const statuses = await Promise.all(children.map(async child => { expect(await child.exited).toBe(0); return JSON.parse(await new Response(child.stdout).text()).status }))
    expect(statuses.filter(status => status === 'installed')).toHaveLength(1)
    expect(statuses.every(status => ['installed', 'busy', 'current'].includes(status))).toBe(true)
    expect(readFileSync(f.dest, 'utf8')).toBe(f.text())
  }
})

test('candidate validation rejects wrong paths, symlinks, modes, and markers', () => {
  const f = fixture(); f.run()
  expect(validLauncher({ KLYTH_LAUNCHER: `${f.dest}.other` }, f.home)).toBeUndefined()
  chmodSync(f.dest, 0o644); expect(validLauncher({ KLYTH_LAUNCHER: f.dest }, f.home)).toBeUndefined()
  chmodSync(f.dest, 0o001); expect(validLauncher({ KLYTH_LAUNCHER: f.dest }, f.home)).toBeUndefined()
  chmodSync(f.dest, 0o775); expect(validLauncher({ KLYTH_LAUNCHER: f.dest }, f.home)).toBeUndefined()
  chmodSync(f.dest, 0o755); writeFileSync(f.dest, '#!/bin/sh\n# foreign\n')
  expect(validLauncher({ KLYTH_LAUNCHER: f.dest }, f.home)).toBeUndefined()
  renameSync(f.dest, `${f.dest}.real`); symlinkSync(`${f.dest}.real`, f.dest)
  expect(validLauncher({ KLYTH_LAUNCHER: f.dest }, f.home)).toBeUndefined()
})

test('the emitted shell runs outside its release, names missing Bun, and names a missing release', async () => {
  const f = fixture(); f.run()
  const call = async () => {
    const child = Bun.spawn([f.dest, '--version'], { cwd: f.dir, env: { HOME: f.home, PATH: `${f.home}/empty` }, stdout: 'pipe', stderr: 'pipe' })
    return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() }
  }
  expect(await call()).toEqual({ code: 127, out: '', err: 'klyth: Bun is not installed. Install Bun, then try again.\n' })
  mkdirSync(`${f.home}/.bun/bin`, { recursive: true }); symlinkSync(process.execPath, `${f.home}/.bun/bin/bun`)
  expect((await call()).out).toMatch(/^klyth \d+\.\d+\.\d+\n$/)
  writeFileSync(f.dest, f.text('9.0.0', `${f.dir}/gone`))
  expect((await call()).err).toContain('the Klyth release of this command is gone')
})

test('real launcher writes stable token argv and the real key helper runs it with fallback Bun', async () => {
  const f = fixture(); f.run()
  const configDir = `${f.dir}/config`, bin = `${f.dir}/tools`; mkdirSync(configDir); mkdirSync(bin)
  const configPath = `${configDir}/klyth.json`
  writeFileSync(configPath, JSON.stringify({ providers: { alpha: { kind: 'openai', baseUrl: 'https://api.example.invalid/v1', auth: 'none', models: { m: { contextWindow: 1000, maxOutputTokens: 100 } } } } }))
  // The preload selects the portable store without touching the host keyring.
  const preload = `${f.dir}/platform.ts`; writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'linux' })\n")
  mkdirSync(`${f.home}/.bun/bin`, { recursive: true })
  writeFileSync(`${f.home}/.bun/bin/bun`, `#!/bin/sh\nexec '${process.execPath}' --preload '${preload}' "$@"\n`, { mode: 0o755 })
  writeFileSync(`${bin}/secret-tool`, '#!/bin/sh\ncase "$1" in\n lookup) [ -f "$HOME/item" ] || exit 1; /bin/cat "$HOME/item";;\n search) exit 0;;\n store) /bin/cat > "$HOME/item";;\n *) exit 1;;\nesac\n', { mode: 0o755 })
  const env = { HOME: f.home, PATH: bin, CLAUDE_CONFIG_DIR: configDir }
  const child = Bun.spawn([f.dest, 'auth', 'import', 'alpha', '--write'], { cwd: f.dir, env, stdin: new TextEncoder().encode('v1|client|refresh|4102444800||synthetic-access\n'), stdout: 'pipe', stderr: 'pipe' })
  const error = await new Response(child.stderr).text()
  expect([await child.exited, error]).toEqual([0, ''])
  const config = parseConfig(readFileSync(configPath, 'utf8')).config!, provider = config.providers['alpha']!
  expect(provider.auth === 'none' ? [] : provider.auth.command).toEqual([f.dest, 'auth', 'token', 'alpha'])
  const driver = `${f.dir}/driver.ts`
  writeFileSync(driver, `import { createKeys } from ${JSON.stringify(`${source}/klythd/auth.ts`)};
import { runHelper } from ${JSON.stringify(`${source}/klythd/main.ts`)};
import { fingerprint } from ${JSON.stringify(`${source}/hooks/config.ts`)};
const provider = ${JSON.stringify(provider)};
let stdout = '';
const keys = createKeys(async (argv, ms) => { if (ms !== 10000) throw Error('wrong helper limit'); const r = await runHelper(argv, ms); stdout = r.stdout; return r }, Date.now);
const result = await keys.get(provider, new Set([fingerprint(provider)]));
console.log(JSON.stringify({ result, stdout }));`)
  const runner = Bun.spawn([process.execPath, driver], { cwd: f.dir, env, stdout: 'pipe', stderr: 'pipe' })
  const answer = JSON.parse(await new Response(runner.stdout).text())
  expect(await runner.exited).toBe(0)
  expect(answer).toEqual({ result: { key: 'synthetic-access', cached: false }, stdout: 'synthetic-access\n' })
})

test('compiled releases skip launcher installation', () => {
  const f = fixture(), root = `${f.dir}/compiled`
  mkdirSync(`${root}/.claude-plugin`, { recursive: true }); writeFileSync(`${root}/.claude-plugin/helper.json`, '{}')
  expect(f.run('0.2.1', root)).toBe('skipped')
  expect(existsSync(f.dest)).toBe(false); expect(existsSync(f.record)).toBe(false)
})

test('real installer processes reject a foreign publication race and clean up handled publication failures', async () => {
  for (const race of [true, false]) {
    const f = fixture(), driver = `${f.dir}/install-driver.ts`
    writeFileSync(driver, `import { installLauncher } from ${JSON.stringify(`${source}/scripts/install-launcher.ts`)};
import { writeFileSync } from 'node:fs';
console.log(JSON.stringify(installLauncher(process.argv[2], process.argv[3], process.argv[4], (_temp, dest) => { ${race ? "writeFileSync(dest, 'foreign bytes')" : "throw Error('publication failed')"} })));`)
    const child = Bun.spawn([process.execPath, driver, f.home, f.root, '0.2.1'], { env: { ...process.env, HOME: f.home }, stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(JSON.parse(await new Response(child.stdout).text()).status).toBe(race ? 'foreign' : 'skipped')
    if (race) expect(readFileSync(f.dest, 'utf8')).toBe('foreign bytes')
    expect(existsSync(f.record)).toBe(false)
    expect(existsSync(`${f.home}/.local/bin/.klyth-launcher.tmp`)).toBe(false)
    expect(existsSync(`${f.record}.tmp`)).toBe(false)
    expect(existsSync(`${f.record}.lock`)).toBe(false) // a failed publish releases the lock too
  }
})
