import { findBun } from './backend'
import { launcherText } from './launcher'

export type LauncherPort = {
  home(): Promise<string>; root: string; version(): Promise<string>; path(): Promise<string>
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  run(argv: readonly string[], options: { timeoutMs: number }): Promise<{ exitCode: number; stdout: string }>
  debug(text: string): void; toast(text: string): void
}

export async function installLauncher(io: LauncherPort): Promise<string | undefined> {
  try {
    const home = await io.home(), version = await io.version()
    const text = launcherText(home, io.root, version)
    if (text === undefined) { io.debug('klyth launcher: skipped invalid paths or version'); return undefined }
    const dest = `${home}/.local/bin/klyth`
    const record = `${home}/.local/share/klyth/launcher`
    const read = (path: string) => io.read(path).catch(() => undefined)
    if (await io.exists(`${io.root}/.claude-plugin/helper.json`)) { io.debug('klyth launcher: skipped compiled helper'); return undefined }
    if (await read(dest) === text && await read(record) !== undefined) {
      io.debug('klyth launcher: current'); return dest
    }
    const bun = await findBun(io.run)
    if (!bun) { io.debug('klyth launcher: skipped missing Bun'); return undefined }
    const result = await io.run([bun, '--config=/dev/null', '--no-env-file', `${io.root}/scripts/install-launcher.ts`, home, io.root, version], { timeoutMs: 10000 })
    const parsed: unknown = JSON.parse(result.stdout)
    const status = result.exitCode === 0 && parsed !== null && typeof parsed === 'object' && 'status' in parsed ? parsed.status : undefined
    if (status === 'installed') {
      const onPath = (await io.path()).split(':').includes(`${home}/.local/bin`)
      io.toast(onPath ? 'Klyth installed the klyth command in ~/.local/bin. Type klyth --help in a terminal.' : 'Klyth installed the klyth command in ~/.local/bin. Add ~/.local/bin to your PATH to use it.')
    } else io.debug(`klyth launcher: ${typeof status === 'string' ? status : 'skipped'}`)
    return ['installed', 'updated', 'current', 'older'].includes(String(status)) ? dest : undefined
  } catch { io.debug('klyth launcher: skipped installation failure'); return undefined }
}

export function scheduleLauncher(io: LauncherPort, after: (callback: () => void) => void): Promise<string | undefined> {
  return new Promise(resolve => {
    after(() => { void installLauncher(io).then(resolve, () => resolve(undefined)) })
  })
}
