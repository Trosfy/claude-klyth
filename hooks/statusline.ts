// Main's route in Claude Code's own status line. Claude Code draws every status a mod pins with a warning icon, so with
// klyth.json `"statusLine": "command"` klyth writes main's route to one small file per session instead, and
// scripts/statusline.ts, the command Claude Code's `statusLine` setting runs, reads it. The file's name, its writer and
// its reader are all here. Pure over a port.
import { statuslinePath } from './product'
import type { Session } from './session'

export type RecordPort = {
  // The home directory; '' when it cannot be read.
  home(): Promise<string>
  // The id of the session now running.
  sessionId(): Promise<string>
  write(path: string, text: string): Promise<void>
  run(argv: readonly string[]): Promise<{ exitCode: number; stderr: string }>
  debug(text: string): void
}

// Claude Code's session ids are UUIDs. An id is a plain name, so one with a `/` or a `.` is never part of a path.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const NATIVE = 'Claude'

// Whether klyth.json sends main's route to the status line command rather than pinning it.
export const viaCommand = (s: Session) => s.loaded.config?.statusLine === 'command'

// The file holding a session's route, in the cache folder klyth keeps its other files in; undefined when the home
// directory is unknown or the id is not a plain name.
export const routeFile = (home: string, id: string) => (home !== '' && SESSION_ID.test(id) ? statuslinePath(home, id) : undefined)

// Text as one clean line: control characters dropped, at most 200 characters; '' when it is not text.
const oneLine = (v: unknown) => (typeof v === 'string' ? v.slice(0, 4096).replace(/\p{Cc}/gu, '').trim().slice(0, 200) : '')

// The status line for the session JSON Claude Code feeds the command: `◆ <route>` while the session's route file holds a
// route, `◇ <model>` while it is missing or empty (native), and the bare model name when anything else goes wrong.
// Only the command output is styled: cyan routed diamond, dim native diamond and provider suffix; model text is normal.
// `read` answers a file's text, or undefined when it is not there. `color: false` emits plain text. Never throws.
export function statusLine(stdin: string, home: string, read: (path: string) => string | undefined, color = true): string {
  let model = ''
  try {
    if (stdin.length > 65536) return NATIVE
    const input = JSON.parse(stdin)
    model = oneLine(input.model?.display_name)
    const path = typeof input.session_id === 'string' ? routeFile(home, input.session_id) : undefined
    const route = path === undefined ? '' : oneLine(read(path))
    if (!color) return route === '' ? `◇ ${model || NATIVE}` : `◆ ${route}`
    if (route === '') return `\x1b[2m◇\x1b[0m ${model || NATIVE}`
    const separator = route.lastIndexOf(' · ')
    const text = separator > 0 && separator + 3 < route.length
      ? `${route.slice(0, separator)}\x1b[2m${route.slice(separator)}\x1b[0m`
      : route
    return `\x1b[36m◆\x1b[0m ${text}`
  } catch {
    return model || NATIVE
  }
}

// A unique sibling avoids overlapping writers sharing a temp file or following a predictable temp symlink.
// Moving it into place atomically replaces even a symlink at the destination, rather than writing through it.
async function publish(io: RecordPort, path: string, text: string): Promise<boolean> {
  try {
    const temp = `${path}.${crypto.randomUUID()}.tmp`
    await io.write(temp, text)
    const moved = await io.run(['/bin/mv', '-f', temp, path])
    if (moved.exitCode === 0) return true
    io.debug(`klyth statusline: could not move the route file into place (exit ${moved.exitCode}) ${moved.stderr}`)
  } catch (err) {
    io.debug(`klyth statusline: could not record the route (${String(err)})`)
  }
  return false
}

// Publications and cleanup share one queue per registration. A failed operation does not block the next one.
function enqueue(s: Session, action: () => Promise<void>): Promise<void> {
  const pending = s.statuslineQueue.then(action)
  s.statuslineQueue = pending.catch(() => {})
  return pending
}

// Capture the session's destination before waiting for earlier publications, then record main's captured route.
export function record(io: RecordPort, s: Session, text: string): Promise<void> {
  const destination = Promise.all([io.home(), io.sessionId()])
    .then(([home, id]) => routeFile(home, id))
    .catch(err => {
      io.debug(`klyth statusline: could not record the route (${String(err)})`)
      return undefined
    })
  return enqueue(s, async () => {
    const path = await destination
    if (path === undefined) {
      io.debug('klyth statusline: no home directory, or a session id that is not a plain name; the route is not recorded')
      return
    }
    if (await publish(io, path, text)) s.statuslineFile = path
  })
}

// Blank the record owned after earlier publications settle. No deletion: the reader treats blank as native.
export function clearRecord(io: RecordPort, s: Session): Promise<void> {
  return enqueue(s, async () => {
    const owner = s.statuslineFile
    if (owner !== undefined && await publish(io, owner, '') && s.statuslineFile === owner) s.statuslineFile = undefined
  })
}
