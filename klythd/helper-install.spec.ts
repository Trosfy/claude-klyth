import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { expect, test } from 'bun:test'

import { HELPER_MANIFEST_SCHEMA_VERSION, HELPER_PLATFORMS, HELPER_PROTOCOL_VERSION, MAX_HELPER_BYTES, helperInstallPath, helperPlatform, validateHelperManifest } from '../hooks/helper-manifest'

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const scratch = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const manifestOf = (url = 'https://github.com/acme/klyth/releases/download/v1.2.3/klyth-darwin-arm64') => ({
  schemaVersion: HELPER_MANIFEST_SCHEMA_VERSION,
  protocolVersion: HELPER_PROTOCOL_VERSION,
  releaseVersion: '1.2.3',
  artifacts: { 'darwin-arm64': { url, sha256: 'a'.repeat(64), size: 12 } },
})

function installerEnv(home: string, bin: string, fixture: string, count: string) {
  return { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, KLYTH_FIXTURE: fixture, KLYTH_CURL_COUNT: count }
}

function install(url: string, sha: string, size: number, destination: string, env: Record<string, string>) {
  return Bun.spawnSync(['/bin/sh', resolve(import.meta.dir, '../scripts/install-helper.sh'), url, sha, String(size), destination], { env })
}

async function installAsync(url: string, sha: string, size: number, destination: string, env: Record<string, string>) {
  const child = Bun.spawn(['/bin/sh', resolve(import.meta.dir, '../scripts/install-helper.sh'), url, sha, String(size), destination], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, exitCode }
}

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

function nativePlatform() {
  const report = (process as unknown as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } } }).report
  const libc = process.platform === 'linux' && typeof report?.getReport?.().header?.glibcVersionRuntime === 'string' ? 'glibc' : 'unknown'
  return helperPlatform(process.platform, process.arch, libc)
}

test('strict helper manifest accepts versioned release assets and rejects unsafe metadata', () => {
  const manifest = validateHelperManifest(manifestOf())
  expect(manifest.artifacts['darwin-arm64']?.url).toBe('https://github.com/acme/klyth/releases/download/v1.2.3/klyth-darwin-arm64')
  expect(() => validateHelperManifest({ ...manifestOf(), extra: true })).toThrow('manifest shape')
  for (const url of [
    'http://github.com/acme/klyth/releases/download/v1.2.3/klyth-darwin-arm64',
    'https://user:pass@github.com/acme/klyth/releases/download/v1.2.3/klyth-darwin-arm64',
    'https://github.com/acme/klyth/releases/download/v1.2.3/klyth-darwin-arm64?token=secret',
    'https://github.com/acme/klyth/releases/download/latest/klyth-darwin-arm64',
    'https://github.com/acme/klyth/releases/download/v9.9.9/klyth-darwin-arm64',
    'https://github.com/acme/klyth/releases/download/v1.2.3/klyth-linux-glibc-x64',
  ]) expect(() => validateHelperManifest(manifestOf(url))).toThrow('artifact')
  expect(() => validateHelperManifest({ ...manifestOf(), artifacts: { 'darwin-arm64': { url: manifest.artifacts['darwin-arm64']!.url, sha256: 'a'.repeat(64), size: MAX_HELPER_BYTES + 1 } } })).toThrow('artifact')
})

test('platform and helper path contracts reject unproven targets and noncanonical homes', () => {
  expect(helperPlatform('darwin', 'arm64', 'unknown')).toBe('darwin-arm64')
  expect(helperPlatform('darwin', 'x64', 'unknown')).toBe('darwin-x64')
  expect(helperPlatform('linux', 'x64', 'glibc')).toBe('linux-glibc-x64')
  expect(() => helperPlatform('linux', 'arm64', 'unknown')).toThrow('glibc')
  expect(() => helperPlatform('linux', 'x64', 'musl')).toThrow('glibc')
  expect(() => helperPlatform('win32', 'x64', 'unknown')).toThrow('unsupported')
  expect(helperInstallPath('/Users/person name', 'b'.repeat(64))).toBe(`/Users/person name/.local/share/klyth/helpers/${'b'.repeat(64)}/klyth`)
  for (const home of ['/Users/a/../b', '/Users/a/', '/Users//a', 'relative']) expect(() => helperInstallPath(home, 'b'.repeat(64))).toThrow('identity')
  expect(() => helperInstallPath('/Users/a', 'not-a-sha')).toThrow('identity')
})

test('bootstrap verifies and atomically publishes a content-addressed helper without needing Bun', () => {
  const root = scratch('klyth helper install ')
  const home = join(root, 'user home')
  mkdirSync(home, { mode: 0o700 })
  const oldReleases = join(home, '.local/share/klyth/releases')
  mkdirSync(oldReleases, { recursive: true, mode: 0o755 })
  chmodSync(join(home, '.local/share/klyth'), 0o755)
  const oldRelease = join(oldReleases, 'retained-helper')
  writeFileSync(oldRelease, 'older rollback helper')
  const bin = join(root, 'fake bin')
  mkdirSync(bin, { mode: 0o700 })
  const fixture = join(root, 'fixture binary')
  const count = join(root, 'curl count')
  writeFileSync(fixture, 'native-helper-fixture')
  const curl = join(bin, 'curl')
  writeFileSync(curl, '#!/bin/sh\nout=\nproto=\nredir=\nredirects=\nconnect=\ntimeout=\nsize=\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --output) out=$2; shift 2 ;;\n    --proto) proto=$2; shift 2 ;;\n    --proto-redir) redir=$2; shift 2 ;;\n    --max-redirs) redirects=$2; shift 2 ;;\n    --connect-timeout) connect=$2; shift 2 ;;\n    --max-time) timeout=$2; shift 2 ;;\n    --max-filesize) size=$2; shift 2 ;;\n    *) shift ;;\n  esac\ndone\n[ "$out" = - ] && [ "$proto" = =https ] && [ "$redir" = =https ] && [ "$redirects" = 3 ] && [ "$connect" = 10 ] && [ "$timeout" = 120 ] && [ -n "$size" ] || exit 19\nprintf x >> "$KLYTH_CURL_COUNT"\nif [ "$out" = - ]; then cat "$KLYTH_FIXTURE"; else cat "$KLYTH_FIXTURE" > "$out"; fi\n')
  chmodSync(curl, 0o700)
  const platform = nativePlatform()
  const url = `https://downloads.example/releases/download/v2.0.1/klyth-${platform}`
  const sha = digest('native-helper-fixture')
  const destination = helperInstallPath(home, sha)
  const env = installerEnv(home, bin, fixture, count)
  const unsupportedHome = join(root, 'unsupported home')
  mkdirSync(unsupportedHome, { mode: 0o700 })
  const otherPlatform = HELPER_PLATFORMS.find(candidate => candidate !== platform)!
  const unsupported = install(`https://downloads.example/releases/download/v2.0.1/klyth-${otherPlatform}`, sha, Buffer.byteLength('native-helper-fixture'), helperInstallPath(unsupportedHome, sha), installerEnv(unsupportedHome, bin, fixture, count))
  expect([unsupported.exitCode, output(unsupported.stderr).includes('native'), existsSync(join(unsupportedHome, '.local'))]).toEqual([1, true, false])
  const first = install(url, sha, Buffer.byteLength('native-helper-fixture'), destination, env)
  expect([first.exitCode, output(first.stdout).trim()]).toEqual([0, '{"status":"installed"}'])
  expect(readFileSync(destination, 'utf8')).toBe('native-helper-fixture')
  expect(statSync(destination).mode & 0o777).toBe(0o700)
  expect([readFileSync(oldRelease, 'utf8'), statSync(join(home, '.local/share/klyth')).mode & 0o777]).toEqual(['older rollback helper', 0o755])
  const second = install(url, sha, Buffer.byteLength('native-helper-fixture'), destination, env)
  expect([second.exitCode, output(second.stdout).trim(), readFileSync(count, 'utf8')]).toEqual([0, '{"status":"already-ready"}', 'x'])
  writeFileSync(destination, 'preserve-existing', { mode: 0o700 })
  const collision = install(url, sha, Buffer.byteLength('native-helper-fixture'), destination, env)
  expect([collision.exitCode, output(collision.stderr).includes('does not match'), readFileSync(destination, 'utf8'), readFileSync(count, 'utf8')]).toEqual([1, true, 'preserve-existing', 'x'])

  const mismatchHome = join(root, 'mismatch home')
  mkdirSync(mismatchHome, { mode: 0o700 })
  const mismatchDestination = helperInstallPath(mismatchHome, 'c'.repeat(64))
  const mismatch = install(url, 'c'.repeat(64), Buffer.byteLength('native-helper-fixture'), mismatchDestination, installerEnv(mismatchHome, bin, fixture, count))
  expect(mismatch.exitCode).not.toBe(0)
  expect(output(mismatch.stderr)).toContain('digest')
  expect(output(mismatch.stderr)).not.toContain(url)
  const sizeMismatch = install(url, sha, Buffer.byteLength('native-helper-fixture') - 1, helperInstallPath(mismatchHome, sha), installerEnv(mismatchHome, bin, fixture, count))
  expect([sizeMismatch.exitCode, output(sizeMismatch.stderr).includes('size')]).toEqual([1, true])

  const symlinkHome = join(root, 'symlink home')
  const symlinkTarget = join(root, 'symlink target')
  mkdirSync(symlinkHome, { mode: 0o700 })
  mkdirSync(symlinkTarget, { mode: 0o700 })
  symlinkSync(symlinkTarget, join(symlinkHome, '.local'), 'dir')
  const symlinkInstall = install(url, sha, Buffer.byteLength('native-helper-fixture'), helperInstallPath(symlinkHome, sha), installerEnv(symlinkHome, bin, fixture, count))
  expect([symlinkInstall.exitCode, output(symlinkInstall.stderr).includes('symbolic link'), existsSync(join(symlinkTarget, 'share'))]).toEqual([1, true, false])

  const unsafeHome = join(root, 'unsafe home')
  mkdirSync(unsafeHome, { mode: 0o700 })
  mkdirSync(join(unsafeHome, '.local'), { mode: 0o777 })
  chmodSync(join(unsafeHome, '.local'), 0o777)
  const unsafeInstall = install(url, sha, Buffer.byteLength('native-helper-fixture'), helperInstallPath(unsafeHome, sha), installerEnv(unsafeHome, bin, fixture, count))
  expect([unsafeInstall.exitCode, output(unsafeInstall.stderr).includes('writable'), existsSync(join(unsafeHome, '.local/share'))]).toEqual([1, true, false])

  const badUrlHome = join(root, 'bad URL home')
  mkdirSync(badUrlHome, { mode: 0o700 })
  const badUrl = 'https://downloads.example/releases/download/v2.0.1/klyth-darwin-arm64?token=must-not-leak'
  const badUrlInstall = install(badUrl, sha, Buffer.byteLength('native-helper-fixture'), helperInstallPath(badUrlHome, sha), installerEnv(badUrlHome, bin, fixture, count))
  expect([badUrlInstall.exitCode, output(badUrlInstall.stderr).includes('invalid artifact URL'), output(badUrlInstall.stderr).includes('must-not-leak'), existsSync(join(badUrlHome, '.local'))]).toEqual([1, true, false, false])

  const wrongDestination = join(root, 'wrong destination')
  const rejected = install(url, sha, Buffer.byteLength('native-helper-fixture'), wrongDestination, env)
  expect(rejected.exitCode).not.toBe(0)
  expect(output(rejected.stderr)).toContain('destination')
})

test('parallel installs publish one verified helper and keep the other attempt idempotent', async () => {
  const root = scratch('klyth helper parallel ')
  const home = join(root, 'user home')
  const bin = join(root, 'fake bin')
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(bin, { mode: 0o700 })
  const fixture = join(root, 'fixture binary')
  const count = join(root, 'curl count')
  writeFileSync(fixture, 'parallel-helper-fixture')
  const curl = join(bin, 'curl')
  writeFileSync(curl, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then [ "$2" = - ] || exit 1; shift 2; else shift; fi; done\nsleep 0.2\ncat "$KLYTH_FIXTURE"\n')
  chmodSync(curl, 0o700)
  const platform = nativePlatform()
  const url = `https://downloads.example/releases/download/v2.1.0/klyth-${platform}`
  const sha = digest('parallel-helper-fixture')
  const destination = helperInstallPath(home, sha)
  const env = installerEnv(home, bin, fixture, count)
  const results = await Promise.all(Array.from({ length: 2 }, () => installAsync(url, sha, Buffer.byteLength('parallel-helper-fixture'), destination, env)))
  expect(results.map(result => result.exitCode)).toEqual([0, 0])
  expect(results.map(result => result.stdout.trim()).sort()).toEqual(['{"status":"already-ready"}', '{"status":"installed"}'])
  expect(readFileSync(destination, 'utf8')).toBe('parallel-helper-fixture')
})

test('native build emits a pinned manifest and executable, not cwd configuration or inherited values', () => {
  const root = scratch('klyth helper build ')
  const out = join(root, 'release output')
  const entry = join(root, 'entry.ts')
  const hostileCwd = join(root, 'hostile cwd')
  mkdirSync(hostileCwd, { mode: 0o700 })
  writeFileSync(entry, 'console.log(JSON.stringify({ compiled: KLYTH_COMPILED, version: KLYTH_VERSION, identity: process.env.KLYTH_PRIVATE_ID ?? null }))\n')
  writeFileSync(join(hostileCwd, '.env'), 'KLYTH_PRIVATE_ID=hostile-dotenv-value\n')
  writeFileSync(join(hostileCwd, 'bunfig.toml'), '[run]\npreload = ["./preload.ts"]\n')
  writeFileSync(join(hostileCwd, 'preload.ts'), 'throw new Error("hostile cwd preload ran")\n')
  const script = resolve(import.meta.dir, '../scripts/build-release.ts')
  const build = Bun.spawnSync([process.execPath, script, '--entry', entry, '--out', out, '--version', '2.4.1', '--artifact-base-url', 'https://downloads.example/releases/download/v2.4.1'], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(), KLYTH_PRIVATE_ID: 'synthetic-build-value' },
  })
  expect(build.exitCode).toBe(0)
  const manifest = validateHelperManifest(JSON.parse(readFileSync(join(out, 'helper.json'), 'utf8')))
  const entries = Object.entries(manifest.artifacts)
  expect(entries).toHaveLength(1)
  const [platform, artifact] = entries[0]!
  const binary = join(out, 'klyth')
  expect(artifact).toEqual({ url: `https://downloads.example/releases/download/v2.4.1/klyth-${platform}`, sha256: digest(readFileSync(binary)), size: statSync(binary).size })
  expect(statSync(binary).mode & 0o111).not.toBe(0)
  const clean = Bun.spawnSync([binary], { cwd: hostileCwd, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() } })
  expect([clean.exitCode, output(clean.stdout)]).toEqual([0, '{"compiled":true,"version":"2.4.1","identity":null}\n'])
  const dynamic = Bun.spawnSync([binary], { cwd: hostileCwd, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', KLYTH_PRIVATE_ID: 'runtime-value' } })
  expect(output(dynamic.stdout)).toBe('{"compiled":true,"version":"2.4.1","identity":"runtime-value"}\n')
  const builtDigest = digest(readFileSync(binary))
  const secondBuild = Bun.spawnSync([process.execPath, script, '--entry', entry, '--out', out, '--version', '2.4.1', '--artifact-base-url', 'https://downloads.example/releases/download/v2.4.1'], { cwd: root, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() } })
  expect(secondBuild.exitCode).not.toBe(0)
  expect(digest(readFileSync(binary))).toBe(builtDigest)
})
