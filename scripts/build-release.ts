import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { HELPER_MANIFEST_SCHEMA_VERSION, HELPER_PROTOCOL_VERSION, MAX_HELPER_BYTES, helperPlatform, validateHelperManifest } from '../hooks/helper-manifest'
import type { HelperManifest, HelperPlatform } from '../hooks/helper-manifest'

type Options = { entry?: string; out: string; version: string; artifactBaseUrl: string }
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const usage = 'usage: bun scripts/build-release.ts --out <new-directory> --version <semver> --artifact-base-url <versioned-https-url> [--entry <file>]'

function parseArgs(args: readonly string[]): Options {
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--help') throw new Error(usage)
    if (key !== '--entry' && key !== '--out' && key !== '--version' && key !== '--artifact-base-url') throw new Error(usage)
    if (values[key] !== undefined || args[i + 1] === undefined || args[i + 1]!.startsWith('--')) throw new Error(usage)
    values[key] = args[++i]!
  }
  if (values['--out'] === undefined || values['--version'] === undefined || values['--artifact-base-url'] === undefined) throw new Error(usage)
  return { ...(values['--entry'] === undefined ? {} : { entry: values['--entry'] }), out: values['--out'], version: values['--version'], artifactBaseUrl: values['--artifact-base-url'] }
}

function versionedBase(value: string, version: string): string {
  if (value.length > 2048) throw new Error('artifact base URL is too long')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('artifact base URL must be a canonical versioned HTTPS URL') }
  const segments = url.pathname.split('/').filter(Boolean)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.href !== value ||
    (segments.at(-1) !== version && segments.at(-1) !== `v${version}`) || segments.some(part => part.toLowerCase() === 'latest') ||
    !segments.every(part => /^[A-Za-z0-9._+-]+$/.test(part) && part !== '.' && part !== '..')) throw new Error('artifact base URL must be a canonical versioned HTTPS URL')
  return url.href.replace(/\/+$/, '')
}

function currentLibc(): 'glibc' | 'musl' | 'unknown' {
  if (process.platform !== 'linux') return 'unknown'
  const report = process.report as { getReport?: () => { header?: { glibcVersionRuntime?: string } } } | undefined
  const glibc = report?.getReport?.().header?.glibcVersionRuntime
  return typeof glibc === 'string' && glibc !== '' ? 'glibc' : 'unknown'
}

function executableTarget(platform: HelperPlatform): string {
  return `bun-${platform.startsWith('darwin-') ? 'darwin' : 'linux'}-${platform.endsWith('arm64') ? 'arm64' : 'x64'}`
}

async function existingRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function help(): void {
  process.stdout.write(`${usage}\n`)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function buildRelease(options: Options): Promise<{ manifest: HelperManifest; binaryPath: string }> {
  if (Bun.version !== '1.3.11') throw new Error('build requires pinned Bun 1.3.11')
  if (!VERSION.test(options.version) || options.version.length > 64) throw new Error('release version must be SemVer')
  const platform = helperPlatform(process.platform, process.arch, currentLibc())
  const artifactBase = versionedBase(options.artifactBaseUrl, options.version)
  const root = resolve(import.meta.dir, '..')
  const entry = resolve(options.entry ?? `${root}/scripts/cli.ts`)
  try {
    const entryInfo = await lstat(entry)
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error('entry must be a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.entry === undefined) throw new Error('default entry scripts/cli.ts is missing; pass --entry <file> only for an explicit build fixture')
    throw error
  }

  const out = resolve(options.out)
  await mkdir(out, { mode: 0o700 })
  const binaryPath = `${out}/klyth`
  const manifestPath = `${out}/helper.json`

  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) if (process.env[key] !== undefined) env[key] = process.env[key]!
  const args = [
    'build', '--compile', `--target=${executableTarget(platform)}`, `--outfile=${binaryPath}`,
    '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json',
    '--env=disable', '--define=KLYTH_COMPILED=true', `--define=KLYTH_VERSION=${JSON.stringify(options.version)}`, entry,
  ]
  const built = Bun.spawnSync([process.execPath, ...args], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
  if (built.exitCode !== 0) throw new Error(`Bun compile failed with exit ${built.exitCode}`)
  if (!(await existingRegularFile(binaryPath))) throw new Error('Bun compile did not produce a regular executable')
  await chmod(binaryPath, 0o755)
  const binaryInfo = await stat(binaryPath)
  if (binaryInfo.size < 1 || binaryInfo.size > MAX_HELPER_BYTES) throw new Error('compiled helper size is outside the manifest limit')
  const digest = await sha256(binaryPath)
  const artifactUrl = `${artifactBase}/klyth-${platform}`
  const manifest = validateHelperManifest({
    schemaVersion: HELPER_MANIFEST_SCHEMA_VERSION,
    protocolVersion: HELPER_PROTOCOL_VERSION,
    releaseVersion: options.version,
    artifacts: { [platform]: { url: artifactUrl, sha256: digest, size: binaryInfo.size } },
  })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
  await chmod(out, 0o755)
  return { manifest, binaryPath }
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') return help()
  const result = await buildRelease(parseArgs(args))
  const [platform, artifact] = Object.entries(result.manifest.artifacts)[0]!
  process.stdout.write(`built ${platform}: ${artifact!.size} bytes, sha256 ${artifact!.sha256}\n`)
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`build-release: ${error instanceof Error ? error.message : 'build failed'}\n`)
    process.exitCode = 1
  })
}
