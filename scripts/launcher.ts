import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { LAUNCHER_MARKER } from '../hooks/launcher'

// Check each component before creating or using its child.
export function launcherPaths(home: string, create = false): boolean {
  try {
    if (realpathSync(home) !== home) return false
    for (const [path, mode] of [[home, 0o755], [`${home}/.local`, 0o755], [`${home}/.local/bin`, 0o755], [`${home}/.local/share`, 0o755], [`${home}/.local/share/klyth`, 0o700]] as const) {
      let stat
      try { stat = lstatSync(path) } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') return false
        try { mkdirSync(path, { mode }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        stat = lstatSync(path)
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return false
    }
    return true
  } catch { return false }
}

export function validLauncher(env: Readonly<Record<string, string | undefined>>, home: string): string | undefined {
  const path = `${home}/.local/bin/klyth`
  if (env['KLYTH_LAUNCHER'] !== path || !launcherPaths(home)) return undefined
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o100) === 0) return undefined
    return readFileSync(path, 'utf8').split('\n')[1] === LAUNCHER_MARKER ? path : undefined
  } catch { return undefined }
}
