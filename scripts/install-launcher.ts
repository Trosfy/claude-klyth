import { closeSync, constants, existsSync, fchmodSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { LAUNCHER_MARKER, launcherText, RELEASE_VERSION } from '../hooks/launcher'
import { acquire, fileLock } from './chatgpt'
import { launcherPaths } from './launcher'

type Status = 'installed' | 'updated' | 'current' | 'foreign' | 'removed' | 'older' | 'busy' | 'skipped'
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const statAt = (path: string) => { try { return lstatSync(path) } catch (error) { if (!missing(error)) throw error; return undefined } }
const owned = (path: string) => {
  const stat = statAt(path)
  return stat?.isFile() && stat.uid === process.getuid?.() && readFileSync(path, 'utf8').split('\n')[1] === LAUNCHER_MARKER
}
const higher = (left: string, right: string) => {
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return true
}

export function installLauncher(home: string, root: string, version: string, beforePublish?: (from: string, to: string) => void): { status: Status } {
  const text = launcherText(home, root, version)
  if (text === undefined || existsSync(`${root}/.claude-plugin/helper.json`) || !launcherPaths(home, true)) return { status: 'skipped' }
  const dir = `${home}/.local/share/klyth`, dest = `${home}/.local/bin/klyth`, record = `${dir}/launcher`
  const temp = `${home}/.local/bin/.klyth-launcher.tmp`, recordTemp = `${dir}/launcher.tmp`
  const lock = fileLock(dir, 'launcher')
  const acquired = acquire({ pid: process.pid, now: Date.now, alive: pid => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } } }, lock)
  if (acquired !== true) return { status: acquired === false ? 'busy' : 'skipped' }
  const temps = new Set<string>()
  let newRecord = false
  const writeTemp = (path: string, value: string, mode: number) => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    temps.add(path)
    try { writeFileSync(fd, value); fchmodSync(fd, mode) } finally { closeSync(fd) }
  }
  const recordFirst = () => {
    if (statAt(record)) return
    writeTemp(recordTemp, '1\n', 0o600)
    renameSync(recordTemp, record); temps.delete(recordTemp); newRecord = true
  }
  const present = (): Status => {
    if (!owned(dest)) return 'foreign'
    recordFirst()
    const previous = readFileSync(dest, 'utf8')
    if (previous === text) return 'current'
    const match = /^# klyth-release (\S+) (.+)$/.exec(previous.split('\n')[2] ?? '')
    if (match && RELEASE_VERSION.test(match[1]!) && existsSync(`${match[2]}/scripts/cli.ts`) && !higher(version, match[1]!)) return 'older'
    writeTemp(temp, text, 0o755)
    if (!owned(dest)) return 'foreign'
    renameSync(temp, dest); temps.delete(temp)
    return 'updated'
  }
  try {
    for (const path of [temp, recordTemp]) {
      const stat = statAt(path)
      if (!stat) continue
      if (!stat.isFile() || stat.uid !== process.getuid?.()) return { status: 'skipped' }
      unlinkSync(path)
    }
    if (statAt(dest)) return { status: present() }
    if (statAt(record)) return { status: 'removed' }
    recordFirst()
    writeTemp(temp, text, 0o755)
    try { beforePublish?.(temp, dest); linkSync(temp, dest) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Publication lost to another file. Keep a record only when that file is Klyth's.
      if (newRecord) { unlinkSync(record); newRecord = false }
      unlinkSync(temp); temps.delete(temp)
      const status = present()
      return { status }
    }
    return { status: 'installed' }
  } catch {
    if (newRecord) { try { unlinkSync(record) } catch {} }
    return { status: 'skipped' }
  } finally {
    for (const path of temps) { try { unlinkSync(path) } catch {} }
    lock.release()
  }
}

if (import.meta.main) {
  let result: { status: Status }
  try { result = installLauncher(process.argv[2] ?? '', process.argv[3] ?? '', process.argv[4] ?? '') } catch { result = { status: 'skipped' } }
  console.log(JSON.stringify(result))
}
