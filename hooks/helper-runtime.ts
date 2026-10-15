// Host effects are supplied by session-owned supervision; no subprocess belongs to a UI dispatch lifetime.
import { verificationPage, type ExtraClient } from './extra-client'
import { findBun } from './backend'
import { helperInstallPath, helperPlatform, validateHelperManifest } from './helper-manifest'
import type { HelperArtifact, HelperManifest } from './helper-manifest'
import { setupEvent, setupFrames, setupRequest } from './setup-protocol'
import type { SetupEvent, SetupFailure, SetupRequest } from './setup-protocol'

export type HelperReadiness = { ready: boolean; mode: 'source' | 'compiled'; path?: string; reason?: string }
export type HelperChild = { stdout: AsyncIterable<string>; exited: Promise<number>; cancel(): void }
export type HelperRuntimePort = {
  extraClient?: ExtraClient
  root: string; home: string; configDir: string
  setTimer(callback: () => void, ms: number): () => void
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  run(argv: readonly string[], options: { timeoutMs: number; env: Record<string, string> }): Promise<{ exitCode: number; stdout: string }>
  // This port must run through a session-owned process loop and cancel on session end/unload.
  spawn(argv: readonly string[], options: { input: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal }): Promise<HelperChild>
}
const OAUTH_TIMEOUT = 16 * 60 * 1000
const PROBE = 'os=$(uname -s) && arch=$(uname -m) || exit 1; printf "%s\\n%s\\n" "$os" "$arch"; if [ "$os" = Linux ]; then getconf GNU_LIBC_VERSION 2>/dev/null || exit 1; fi'
// Arguments, never shell interpolation, supply the trusted home and immutable artifact identity.
const VERIFY = `set -eu
home=$1; binary=$2; size=$3; sha=$4
[ "$(CDPATH= cd -P "$home" && pwd -P)" = "$home" ] || exit 1
uid=$(id -u)
os=$(uname -s)
check() {
 [ ! -L "$1" ] && [ -e "$1" ] || exit 1
 case "$os" in Darwin) values=$(stat -f '%u %Lp' "$1");; Linux) values=$(stat -c '%u %a' -- "$1");; *) exit 1;; esac
 set -- $values
 [ "$1" = "$uid" ] || exit 1
 case "$2" in [0-7][0-7][0-7]) ;; *) exit 1;; esac
 mode=$2; other=\${mode#?}
 case "$other" in *[2367]*) exit 1;; esac
}
check "$home"
check "$home/.local"; check "$home/.local/share"; check "$home/.local/share/klyth"; check "$home/.local/share/klyth/helpers"; check "\${binary%/*}"
check "$binary"
[ -f "$binary" ] && [ -x "$binary" ] || exit 1
[ "$(wc -c < "$binary" | tr -d '[:space:]')" = "$size" ] || exit 1
if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$binary"); else actual=$(sha256sum -- "$binary"); fi
[ "\${actual%% *}" = "$sha" ] || exit 1
printf 'verified\\n'`
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const safePath = (value: string) => value.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(value) && !value.split('/').some(p => p === '.' || p === '..')

export function createHelperRuntime(io: HelperRuntimePort) {
  const env = { BUN_OPTIONS: '', CLAUDE_CONFIG_DIR: io.configDir, HOME: io.home }
  let selected: { readiness: HelperReadiness; cli: readonly string[]; daemon: readonly string[]; artifact?: HelperArtifact } | undefined
  let manifest: HelperManifest | undefined
  const fail = (message: string): never => { throw new Error(message) }
  const run = (argv: readonly string[], timeoutMs = 5000) => io.run(argv, { timeoutMs, env })
  async function inspectUnchecked(): Promise<HelperReadiness> {
    selected = undefined
    if (![io.root, io.home, io.configDir].every(safePath)) return fail('Invalid helper runtime paths')
    const manifestPath = `${io.root}/.claude-plugin/helper.json`
    if (!(await io.exists(manifestPath))) {
      manifest = undefined
      const bun = await findBun((argv, options) => run(argv, options.timeoutMs))
      if (!bun || !safePath(bun)) {
        const readiness: HelperReadiness = { ready: false, mode: 'source', reason: 'Install Bun for this source checkout, or use a released helper build' }
        selected = { readiness, cli: [], daemon: [] }
        return readiness
      }
      const prefix = [bun, '--config=/dev/null', '--no-env-file']
      const readiness: HelperReadiness = { ready: true, mode: 'source', path: bun }
      selected = { readiness, cli: [...prefix, `${io.root}/scripts/cli.ts`], daemon: [...prefix, `${io.root}/klythd/main.ts`] }
      return readiness
    }
    try { manifest = validateHelperManifest(JSON.parse(await io.read(manifestPath))) } catch { return fail('Invalid shipped helper manifest; update or reinstall the mod') }
    let artifact: HelperArtifact
    try {
      const probe = await run(['/bin/sh', '-c', PROBE])
      if (probe.exitCode !== 0 || probe.stdout.length > 256) return fail('Unsupported helper platform or unverified Linux libc')
      const [os, cpu, libc] = probe.stdout.trim().split('\n')
      const platform = helperPlatform(os === 'Darwin' ? 'darwin' : os === 'Linux' ? 'linux' : 'unsupported', cpu === 'arm64' || cpu === 'aarch64' ? 'arm64' : cpu === 'x86_64' || cpu === 'amd64' ? 'x64' : 'unsupported', libc?.startsWith('glibc ') ? 'glibc' : 'unknown')
      const found = manifest.artifacts[platform]
      if (!found) return fail('This release has no helper for the current platform')
      artifact = found
    } catch { return fail('Unsupported helper platform or missing release artifact') }
    const path = helperInstallPath(io.home, artifact.sha256)
    let ready = false
    if (await io.exists(path)) {
      try { const result = await run(['/bin/sh', '-c', VERIFY, 'klyth-verify', io.home, path, String(artifact.size), artifact.sha256]); ready = result.exitCode === 0 && result.stdout === 'verified\n' } catch {}
      if (!ready) return fail('Installed helper failed integrity verification; no helper was executed')
    }
    const readiness: HelperReadiness = { ready, mode: 'compiled', path, ...(ready ? {} : { reason: 'Install the version-matched helper through Klyth setup' }) }
    selected = { readiness, cli: [path], daemon: [path, '__daemon'], artifact }
    return readiness
  }
  async function inspect(): Promise<HelperReadiness> {
    try { return await inspectUnchecked() } catch { selected = undefined; return fail('Could not resolve a verified helper; check the mod manifest, platform and installed helper') }
  }
  async function argv(kind: 'cli' | 'daemon'): Promise<readonly string[]> {
    const status = await inspect()
    if (!status.ready || !selected) return fail(status.reason ?? 'Helper is not ready')
    return selected[kind]
  }
  return {
    inspect,
    ready: async () => (await inspect()).ready,
    daemonArgv: () => argv('daemon'),
    compiledDaemonArgv: async (): Promise<readonly string[] | undefined> => {
      if (!(await io.exists(`${io.root}/.claude-plugin/helper.json`))) return undefined
      return argv('daemon')
    },
    async install(consent: boolean): Promise<HelperReadiness> {
      if (!consent) return fail('Helper installation requires explicit consent')
      const status = await inspect()
      if (status.mode === 'source') return fail('Source checkout has no release manifest; install Bun or build a release')
      if (status.ready) return status
      const artifact = selected?.artifact
      if (!artifact || !status.path) return fail('Helper installation is unavailable')
      let result: { exitCode: number; stdout: string }
      try { result = await run(['/bin/sh', `${io.root}/scripts/install-helper.sh`, artifact.url, artifact.sha256, String(artifact.size), status.path], 150000) } catch { return fail('Helper installation failed; retry through Klyth setup') }
      if (result.exitCode !== 0) return fail('Helper installation failed; retry through Klyth setup')
      const after = await inspect()
      if (!after.ready) return fail('Helper installation did not produce a verified helper')
      return after
    },
    keyCommand(provider: string): string {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider) || provider === 'native') return fail('Invalid provider identifier')
      if (!selected?.readiness.ready) return fail('Inspect helper readiness before requesting a terminal command')
      return ['env', 'BUN_OPTIONS=', `CLAUDE_CONFIG_DIR=${io.configDir}`, ...selected.cli, 'auth', 'login', 'api-key', provider].map(shellQuote).join(' ')
    },
    async openBrowser(url: string): Promise<void> {
      const event = setupEvent({ version: 1, type: 'browser-challenge', authorizeUrl: url, expiresAt: 1 }) ?? (verificationPage(io.extraClient, url) ? true : undefined)
      if (!event) return fail('Invalid authorization browser URL')
      const command = 'case "$(uname -s)" in Darwin) exec /usr/bin/open "$1";; Linux) exec xdg-open "$1";; *) exit 1;; esac'
      try { if ((await run(['/bin/sh', '-c', command, 'klyth-browser', url])).exitCode !== 0) return fail('Could not open browser; use terminal sign-in') } catch { return fail('Could not open browser; use terminal sign-in') }
    },
    async invoke(request: SetupRequest, emit: (event: SetupEvent) => void, signal: AbortSignal): Promise<void> {
      if (!setupRequest(request)) return fail('Invalid setup request')
      if (signal.aborted) return fail('Setup cancelled')
      const command = await argv('cli')
      if (signal.aborted) return fail('Setup cancelled')
      let child: HelperChild
      try { child = await io.spawn([...command, '__setup'], { input: `${JSON.stringify(request)}\n`, env, timeoutMs: OAUTH_TIMEOUT, signal }) } catch { return fail('Could not start setup helper') }
      const cancelChild = () => { try { child.cancel() } catch {} }
      let ended = false, done = false, frames = 0
      let failure: SetupFailure | undefined
      const decoder = setupFrames(event => {
        if (ended || signal.aborted || done || failure !== undefined && event.type !== 'done' || ++frames > 1024) return fail('Invalid setup event sequence')
        if (event.type === 'failed') failure = event.code
        if (event.type === 'done') done = true
        emit(event)
      }, io.extraClient)
      let interrupt: () => void = () => {}
      const interrupted = new Promise<never>((_, reject) => { interrupt = () => { cancelChild(); reject(new Error('Setup cancelled')) } })
      const cancelTimer = io.setTimer(interrupt, OAUTH_TIMEOUT)
      signal.addEventListener('abort', interrupt, { once: true })
      if (signal.aborted) interrupt()
      try {
        await Promise.race([(async () => {
          for await (const chunk of child.stdout) { if (ended) break; decoder.feed(chunk) }
          decoder.end()
          // A validated operational failure completes normally only with its documented exit.
          const expectedExit = failure === undefined ? 0 : failure === 'cancelled' ? 130 : 1
          if (await child.exited !== expectedExit || !done) return fail('Setup helper failed')
        })(), interrupted])
      } catch { cancelChild(); return fail(signal.aborted ? 'Setup cancelled' : 'Setup helper failed') }
      finally { ended = true; cancelTimer(); signal.removeEventListener('abort', interrupt) }
    },
  }
}
