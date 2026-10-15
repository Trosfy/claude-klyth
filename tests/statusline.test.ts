// Main's route in Claude Code's own status line (klyth.json "statusLine": "command"): the route is recorded in a file per
// session instead of pinned, the file follows /model, a clear and a session end, and the command reads it back.
import { expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/config'
import { clearRecord, record, routeFile, statusLine } from '../hooks/statusline'
import { createSession } from '../hooks/session'
import { showStatus } from '../hooks/ui'
import { CONFIG, CONFIG_OBJECT, HOME, model, ROUTE_FILE, SESSION_ID, start, world } from './world'

const COMMAND = JSON.stringify({ ...CONFIG_OBJECT, statusLine: 'command' })
const PINNED = JSON.stringify({ ...CONFIG_OBJECT, statusLine: 'pinned' })
const fileOf = (id: string) => `${HOME}/.cache/klyth/statusline/${id}`
const touched = (runs: readonly (readonly string[])[]) => runs.filter(r => r[0] === '/bin/mv')

test('statusLine is "pinned" or "command" and absent by default; anything else is an error that leaves no config', () => {
  expect(parseConfig(CONFIG).config?.statusLine).toBeUndefined()
  for (const mode of ['pinned', 'command']) expect(parseConfig(JSON.stringify({ ...CONFIG_OBJECT, statusLine: mode })).config?.statusLine).toBe(mode)
  for (const bad of ['Command', 'on', '', 1, true, null, ['command'], { type: 'command' }]) {
    const parsed = parseConfig(JSON.stringify({ ...CONFIG_OBJECT, statusLine: bad }))
    expect(parsed.errors, JSON.stringify(bad)).toEqual(['statusLine: must be "pinned" or "command"'])
    expect(parsed.config).toBeUndefined()
  }
})

test('with "command" the route is recorded, never pinned: the file holds it, follows /model and any other switch, and is empty when native', async ($, on) => {
  const w = world(on, { config: COMMAND })
  await start($)
  expect(w.written).toEqual({ [ROUTE_FILE]: '' })
  await model($, 'fast')
  expect(w.written).toEqual({ [ROUTE_FILE]: 'fast · acme' })
  await model($, 'acme/small')
  expect(w.written).toEqual({ [ROUTE_FILE]: 'acme/small · acme' })
  await model($, 'opus')
  expect(w.written).toEqual({ [ROUTE_FILE]: '' })
  await model($, 'strong')
  expect(w.written).toEqual({ [ROUTE_FILE]: 'strong · acme' })
  await $.classic.PostModelSwitch({ from_model: 'opus', to_model: 'sonnet', requested_model: null, source: 'sdk', context_tokens: 0, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0 } as never)
  expect(w.written).toEqual({ [ROUTE_FILE]: '' })
  expect(w.statuses.length).toBeGreaterThan(0)
  expect(w.statuses.filter(t => t !== undefined)).toEqual([])
  // The text is written to a temp file and moved into place in one step, so the command never reads half a line.
  const moves = touched(w.runs)
  expect(moves.length).toBeGreaterThan(0)
  expect(new Set(moves.map(r => r[2])).size).toBe(moves.length)
  for (const move of moves) {
    expect(move[2]).toMatch(new RegExp(`^${ROUTE_FILE}\\.[a-f0-9-]+\\.tmp$`))
    expect(move[3]).toBe(ROUTE_FILE)
  }
})

for (const [what, config] of [['no statusLine key', CONFIG], ['"pinned"', PINNED]] as const) {
  test(`with ${what} the route is pinned as before, and no route file is written or moved`, async ($, on) => {
    const w = world(on, { config })
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await start($)
    await model($, 'fast')
    expect(w.statuses.at(-1)).toBe('fast · acme')
    await $.classic.SessionStart({ source: 'clear' })
    await $.session.end({ reason: 'clear', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
    await model($, 'opus')
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.written).toEqual({})
    expect(touched(w.runs)).toEqual([])
  })
}

test('a clear blanks presentation without inheriting the old session route; resuming restores its choice', async ($, on) => {
  let id = 'old-session'
  const w = world(on, { config: COMMAND, sessionId: () => id })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  await model($, 'fast')
  expect(w.written).toEqual({ [fileOf('old-session')]: 'fast · acme' })
  await $.session.end({ reason: 'clear', sessionId: 'old-session', resume: { id: 'old-session' } })
  expect(w.written).toEqual({ [fileOf('old-session')]: '' })
  id = 'new-session'
  await $.classic.SessionStart({ source: 'clear' })
  expect(w.written).toEqual({ [fileOf('old-session')]: '', [fileOf('new-session')]: '' })
  await $.session.end({ reason: 'other', sessionId: 'new-session', resume: { id: 'new-session' } })
  expect(w.written).toEqual({ [fileOf('old-session')]: '', [fileOf('new-session')]: '' })
  id = 'old-session'
  await $.classic.SessionStart({ source: 'resume' })
  expect(w.written[fileOf('old-session')]).toBe('fast · acme')
})

test('a session id that is not a plain name is not recorded or cleared, and the debug log says so', async ($, on) => {
  const w = world(on, { config: COMMAND, sessionId: '../../escape' })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  await model($, 'fast')
  await $.session.end({ reason: 'other', sessionId: '../../escape', resume: { id: '../../escape' } })
  expect(w.written).toEqual({})
  expect(touched(w.runs)).toEqual([])
  expect(w.debug).toContain('klyth statusline: no home directory, or a session id that is not a plain name; the route is not recorded')
})

test('a write or a move that fails is logged and never reaches the person', async ($, on) => {
  const w = world(on, { config: COMMAND, run: argv => (argv[0] === '/bin/mv' ? { exitCode: 1, stderr: 'disk full' } : undefined) })
  await start($)
  expect(await model($, 'fast')).toEqual({ text: 'Set model to fast (acme/model-a)' })
  expect(w.debug).toContain('klyth statusline: could not move the route file into place (exit 1) disk full')
  expect(w.toasts).toEqual([])
})

// The command: what Claude Code's statusLine setting runs, over the session JSON it feeds on stdin.
const HOME_DIR = '/h'
const files: Record<string, string> = { [`${HOME_DIR}/.cache/klyth/statusline/abc-123`]: 'fast · acme\n', [`${HOME_DIR}/.cache/klyth/statusline/native-1`]: '' }
const line = (stdin: unknown, read: (path: string) => string | undefined = path => files[path]) => statusLine(typeof stdin === 'string' ? stdin : JSON.stringify(stdin), HOME_DIR, read)
const opus = (session_id: unknown) => ({ session_id, model: { id: 'claude-opus-5-5', display_name: 'Opus' }, cwd: '/w' })

test('the command shows the route of a routed session, and the native model for a missing or empty route file', () => {
  expect(line(opus('abc-123'))).toBe('\x1b[36m◆\x1b[0m fast\x1b[2m · acme\x1b[0m')
  expect(line(opus('other-9'))).toBe('\x1b[2m◇\x1b[0m Opus')
  expect(line(opus('native-1'))).toBe('\x1b[2m◇\x1b[0m Opus')
  expect(routeFile(HOME_DIR, 'abc-123')).toBe(`${HOME_DIR}/.cache/klyth/statusline/abc-123`)
})

test('the command never throws: unreadable input gives the model name, or Claude when there is none', () => {
  for (const stdin of ['', 'not json', 'null', '[', '{"model": ']) expect(line(stdin), stdin).toBe('Claude')
  for (const stdin of ['7', '[]', '{}', '{"session_id": 5}', '{"model": 5}', '{"model": {"display_name": 5}}']) expect(line(stdin), stdin).toBe('\x1b[2m◇\x1b[0m Claude')
  expect(line({ session_id: 7, model: { display_name: 'Opus' } })).toBe('\x1b[2m◇\x1b[0m Opus')
  expect(line(opus('abc-123'), () => { throw new Error('EACCES') })).toBe('Opus')
})

test('a session id with a slash or a dot is never used as a path', () => {
  const reads: string[] = []
  for (const id of ['../x', 'a/b', '..', '.', '', 'a.b', '/etc/passwd', 'x'.repeat(129), 'abc-123/../abc-123']) {
    expect(line(opus(id), path => (reads.push(path), 'leaked')), id).toBe('\x1b[2m◇\x1b[0m Opus')
  }
  expect(reads).toEqual([])
  expect(routeFile('', 'abc-123')).toBeUndefined()
  expect(routeFile(HOME_DIR, '../x')).toBeUndefined()
})

test('the command prints one clean line: control characters are dropped and a long route is cut', () => {
  const dirty: Record<string, string> = { [`${HOME_DIR}/.cache/klyth/statusline/dirty`]: 'fast\u001b[2J · acme\nsecond line', [`${HOME_DIR}/.cache/klyth/statusline/long`]: 'x'.repeat(500) }
  expect(line(opus('dirty'), path => dirty[path])).toBe('\x1b[36m◆\x1b[0m fast[2J\x1b[2m · acmesecond line\x1b[0m')
  expect(line(opus('long'), path => dirty[path])).toBe(`\x1b[36m◆\x1b[0m ${'x'.repeat(200)}`)
})

test('only the last complete provider suffix is dim; labels without a suffix stay normal', () => {
  for (const route of ['fast', 'fast ·', '· acme']) {
    expect(line(opus('abc-123'), () => route)).toBe(`\x1b[36m◆\x1b[0m ${route}`)
  }
  expect(line(opus('abc-123'), () => 'fast · variant · acme')).toBe('\x1b[36m◆\x1b[0m fast · variant\x1b[2m · acme\x1b[0m')
})

test('cached ANSI controls and native model controls are stripped before command styling', () => {
  expect(line(opus('abc-123'), () => '\x1b[31mfast\x1b[0m · acme\u009b0m\n')).toBe('\x1b[36m◆\x1b[0m [31mfast[0m\x1b[2m · acme0m\x1b[0m')
  expect(line({ model: { display_name: '\x1b[31mOpus\n' } })).toBe('\x1b[2m◇\x1b[0m [31mOpus')
})

test('plain command output keeps the same sanitized text without styling', () => {
  const input = JSON.stringify(opus('abc-123'))
  expect(statusLine(input, HOME_DIR, () => 'fast · acme', false)).toBe('◆ fast · acme')
  expect(statusLine(input, HOME_DIR, () => 'fast', false)).toBe('◆ fast')
  expect(statusLine(input, HOME_DIR, () => undefined, false)).toBe('◇ Opus')
  expect(statusLine(input, HOME_DIR, () => '\x1b[31mfast · acme\n', false)).toBe('◆ [31mfast · acme')
})

for (const [mode, config] of [['pinned', PINNED], ['invalid', '{"providers":5}']] as const) {
  test(`leaving command mode for ${mode} blanks its previous record, even after switching native and ending`, async ($, on) => {
    let text = COMMAND
    const w = world(on, { config: () => text })
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await start($)
    await model($, 'fast')
    expect(w.written[ROUTE_FILE]).toBe('fast · acme')
    text = config
    await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(w.written[ROUTE_FILE]).toBe('')
    await model($, 'opus')
    await $.session.end({ reason: 'other', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
    expect(w.written[ROUTE_FILE]).toBe('')
  })
}

test('a subagent SessionStart cannot publish or clear main status', async ($, on) => {
  const w = world(on, { config: COMMAND })
  await start($)
  await model($, 'fast')
  const moves = touched(w.runs).length
  const statuses = w.statuses.length
  await $.classic.SessionStart({ source: 'clear', agent_id: 'child' } as never)
  expect(w.written).toEqual({ [ROUTE_FILE]: 'fast · acme' })
  expect(touched(w.runs).length).toBe(moves)
  expect(w.statuses.length).toBe(statuses)
})

test('queued records for the same session use independent temp files', async () => {
  const writes: string[] = []
  const moves: string[][] = []
  const io = {
    home: async () => HOME,
    sessionId: async () => SESSION_ID,
    write: async (path: string) => { writes.push(path) },
    run: async (argv: readonly string[]) => { moves.push([...argv]); return { exitCode: 0, stderr: '' } },
    debug: () => {},
  }
  const s = createSession()
  await Promise.all([record(io, s, 'first'), record(io, s, 'second')])
  expect(new Set(writes).size).toBe(2)
  expect(moves.map(r => r[2])).toEqual(writes)
  expect(moves.map(r => r[3])).toEqual([ROUTE_FILE, ROUTE_FILE])
})

// A move gate keeps the temp file readable while its atomic publication is still in flight.
function moveGate() {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  return { release, started, wait: async () => { entered(); await waiting } }
}

function recordWorld() {
  const files: Record<string, string> = {}
  let id = 'old-session'
  let move: (text: string) => Promise<{ exitCode: number; stderr: string } | undefined> = async () => undefined
  const io = {
    home: async () => HOME,
    sessionId: async () => id,
    write: async (path: string, text: string) => { files[path] = text },
    run: async (argv: readonly string[]) => {
      const text = files[argv[2]!]!
      const result = await move(text)
      if (result !== undefined) return result
      files[argv[3]!] = text
      return { exitCode: 0, stderr: '' }
    },
    debug: (_text: string) => {},
    status: (_text: string | undefined) => {},
  }
  const s = createSession()
  s.loaded.config = parseConfig(COMMAND).config
  return { io, s, files, session: (next: string) => { id = next }, move: (next: typeof move) => { move = next } }
}

test('an earlier delayed publication cannot replace the latest route', async () => {
  const w = recordWorld()
  const gate = moveGate()
  w.move(async text => { if (text === 'fast · acme') await gate.wait(); return undefined })
  w.s.main = 'fast'
  const first = showStatus(w.io, w.s)
  await gate.started
  w.s.resetForReload()
  w.s.loaded.config = parseConfig(COMMAND).config
  w.s.main = 'strong'
  const second = showStatus(w.io, w.s)
  // Both the route and destination belong to the invocation, not state after the queued move settles.
  w.s.main = 'fast'
  w.session('other-session')
  // Let an unqueued second move finish before releasing the first. No timer or concurrent wait on the queue.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  gate.release()
  await Promise.all([first, second])
  expect(w.files[fileOf('old-session')]).toBe('strong · acme')
  expect(w.files[fileOf('other-session')]).toBeUndefined()
  expect(w.s.statuslineFile).toBe(fileOf('old-session'))
})

for (const cleanup of ['pinned', 'end'] as const) {
  test(`delayed old-session ${cleanup} cleanup preserves the new record's owner for a later end`, async () => {
    const w = recordWorld()
    w.s.main = 'fast'
    await showStatus(w.io, w.s)
    const gate = moveGate()
    w.move(async text => { if (text === '') await gate.wait(); return undefined })
    w.s.loaded.config = parseConfig(PINNED).config
    const clearing = cleanup === 'pinned' ? showStatus(w.io, w.s) : clearRecord(w.io, w.s)
    await gate.started
    w.session('new-session')
    w.s.loaded.config = parseConfig(COMMAND).config
    w.s.main = 'strong'
    const publishing = showStatus(w.io, w.s)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    gate.release()
    await Promise.all([clearing, publishing])
    expect(w.files[fileOf('old-session')]).toBe('')
    expect(w.files[fileOf('new-session')]).toBe('strong · acme')
    expect(w.s.statuslineFile).toBe(fileOf('new-session'))
    await clearRecord(w.io, w.s)
    expect(w.files[fileOf('new-session')]).toBe('')
    expect(w.s.statuslineFile).toBeUndefined()
  })
}

for (const failure of ['exit', 'throw'] as const) {
  test(`a failed move (${failure}) does not stall the next queued publication`, async () => {
    const w = recordWorld()
    w.move(async text => {
      if (text !== 'first') return undefined
      if (failure === 'throw') throw new Error('disk full')
      return { exitCode: 1, stderr: 'disk full' }
    })
    await Promise.all([record(w.io, w.s, 'first'), record(w.io, w.s, 'second')])
    expect(w.files[fileOf('old-session')]).toBe('second')
    expect(w.s.statuslineFile).toBe(fileOf('old-session'))
  })
}

test('delayed pinned-mode cleanup cannot re-pin status after a concurrent return to command mode', async () => {
  const w = recordWorld()
  const statuses: (string | undefined)[] = []
  w.io.status = text => { statuses.push(text) }
  w.s.main = 'fast'
  await showStatus(w.io, w.s)
  const gate = moveGate()
  w.move(async text => { if (text === '') await gate.wait(); return undefined })
  w.s.loaded.config = parseConfig(PINNED).config
  const clearing = showStatus(w.io, w.s)
  await gate.started
  expect(statuses.at(-1)).toBe('fast · acme')
  w.s.loaded.config = parseConfig(COMMAND).config
  w.s.main = 'strong'
  const publishing = showStatus(w.io, w.s)
  expect(statuses.at(-1)).toBeUndefined()
  gate.release()
  await Promise.all([clearing, publishing])
  expect(statuses).toEqual([undefined, 'fast · acme', undefined])
  expect(statuses.at(-1)).toBeUndefined()
  expect(w.files[fileOf('old-session')]).toBe('strong · acme')
})
