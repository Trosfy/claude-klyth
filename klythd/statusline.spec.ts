// scripts/statusline.ts run as Claude Code runs it: the session JSON on stdin and HOME naming the folder that holds the
// route files. It prints one line and exits 0 whatever it is fed, and reads nothing outside that folder.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'statusline.ts')
const dirs: string[] = []
afterAll(async () => {
  if (dirs.length === 0) return
  const proc = Bun.spawn(['trash', ...dirs], { stdout: 'pipe', stderr: 'pipe' })
  expect(await proc.exited).toBe(0)
})

// A home folder with a route file `routed` holding `fast · acme`, and a decoy beside the folder of route files.
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'klyth-statusline-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.cache', 'klyth', 'statusline'), { recursive: true })
  writeFileSync(join(dir, '.cache', 'klyth', 'statusline', 'routed'), 'fast · acme\n')
  writeFileSync(join(dir, '.cache', 'klyth', 'decoy'), 'leaked\n')
  return dir
}

async function run(dir: string, stdin: string, noColor = '') {
  const proc = Bun.spawn([process.execPath, SCRIPT], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: dir, NO_COLOR: noColor } })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}
const session = (id: unknown) => JSON.stringify({ session_id: id, model: { id: 'claude-opus-5-5', display_name: 'Opus' } })

test('a routed session prints its route, a native one the model, and an id that climbs out of the folder is never read', async () => {
  const dir = home()
  expect(await run(dir, session('routed'))).toEqual({ out: '\x1b[36m◆\x1b[0m fast\x1b[2m · acme\x1b[0m\n', err: '', code: 0 })
  expect(await run(dir, session('native'))).toEqual({ out: '\x1b[2m◇\x1b[0m Opus\n', err: '', code: 0 })
  expect(await run(dir, session('../decoy'))).toEqual({ out: '\x1b[2m◇\x1b[0m Opus\n', err: '', code: 0 })
  expect(await run(dir, session('routed/../../decoy'))).toEqual({ out: '\x1b[2m◇\x1b[0m Opus\n', err: '', code: 0 })
})

test('stdin that is not the session JSON prints a name and exits 0', async () => {
  const dir = home()
  for (const stdin of ['', 'not json', 'null']) expect(await run(dir, stdin), stdin).toEqual({ out: 'Claude\n', err: '', code: 0 })
})

test('a home folder with no route files prints the native line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'klyth-statusline-'))
  dirs.push(dir)
  expect(await run(dir, session('routed'))).toEqual({ out: '\x1b[2m◇\x1b[0m Opus\n', err: '', code: 0 })
})

test('cache reads are bounded before sanitizing, and oversized stdin is native', async () => {
  const dir = home()
  const file = join(dir, '.cache', 'klyth', 'statusline', 'large')
  writeFileSync(file, 'x'.repeat(1024 * 1024))
  expect(await run(dir, session('large'))).toEqual({ out: 'Opus\n', err: '', code: 0 })
  // A route outside the initial read budget is not scanned, even if that prefix is all controls.
  writeFileSync(file, '\0'.repeat(1024 * 1024) + 'leaked')
  expect(await run(dir, session('large'))).toEqual({ out: 'Opus\n', err: '', code: 0 })
  expect(await run(dir, JSON.stringify({ ...JSON.parse(session('routed')), padding: 'x'.repeat(65536) }))).toEqual({ out: 'Claude\n', err: '', code: 0 })
})

test('symlinks, directories and FIFOs are refused with native fallback without blocking', async () => {
  const dir = home()
  const cache = join(dir, '.cache', 'klyth', 'statusline')
  symlinkSync(join(cache, 'routed'), join(cache, 'link'))
  mkdirSync(join(cache, 'directory'))
  const fifo = Bun.spawn(['mkfifo', join(cache, 'fifo')], { stdout: 'pipe', stderr: 'pipe' })
  expect(await fifo.exited).toBe(0)
  for (const id of ['link', 'directory', 'fifo']) expect(await run(dir, session(id))).toEqual({ out: 'Opus\n', err: '', code: 0 })
})

test('command styling sanitizes cache controls, supports labels alone and honors nonempty NO_COLOR', async () => {
  const dir = home()
  const file = join(dir, '.cache', 'klyth', 'statusline', 'routed')
  expect(await run(dir, session('routed'), '1')).toEqual({ out: '◆ fast · acme\n', err: '', code: 0 })
  expect(await run(dir, session('native'), '0')).toEqual({ out: '◇ Opus\n', err: '', code: 0 })
  writeFileSync(file, 'fast')
  expect(await run(dir, session('routed'))).toEqual({ out: '\x1b[36m◆\x1b[0m fast\n', err: '', code: 0 })
  writeFileSync(file, '\x1b[31mfast\x1b[0m · acme\n')
  expect(await run(dir, session('routed'))).toEqual({ out: '\x1b[36m◆\x1b[0m [31mfast[0m\x1b[2m · acme\x1b[0m\n', err: '', code: 0 })
  expect(await run(dir, session('routed'), '1')).toEqual({ out: '◆ [31mfast[0m · acme\n', err: '', code: 0 })
})
