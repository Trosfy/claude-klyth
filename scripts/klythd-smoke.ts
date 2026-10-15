// Live check of klythd: starts `bun klythd/main.ts` as the mod does, sends a routed step for a target from
// your klyth.json over curl on its socket (the token on curl's stdin), streams the events it answers, prints
// klythd's debug lines, and stops it. The target's provider counts as approved for this one run: its
// credential helper (the keychain) runs inside klythd, and the key never reaches this script.
//
//   bun scripts/klythd-smoke.ts [--tool-loop] [--effort <level>] [--pad <n>] <alias | provider/model> [prompt]
//
// With --tool-loop the step offers one fake tool, `get_time`; each tool call it makes is answered with a
// tool_result and the next step is sent, as the engine does between steps, until a step makes none. Each step
// is summed up in one line: tokens in (not cached), out, read from and written to the cache, how it ended.
// --pad repeats a filler paragraph n times in the system prompt, to pass a model's cache minimum.
//
// Reads $CLAUDE_CONFIG_DIR/klyth.json, else ~/.claude/klyth.json. Exits 1 when a step ends in an error.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import type { Effort } from '../types'
import { fingerprint, parseConfig } from '../hooks/config'
import { resolve } from '../hooks/names'
import type { ApiMessage, StepEvent, StepWire } from '../hooks/protocol'

const USAGE = 'usage: bun scripts/klythd-smoke.ts [--tool-loop] [--effort <level>] [--pad <n>] <alias | provider/model> [prompt]'
const MAX_STEPS = 5
const FILLER = 'This paragraph is filler that makes the system prompt long enough for the provider to cache it. It says nothing the answer depends on, and the assistant may ignore it.'
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'tool-loop': { type: 'boolean' }, effort: { type: 'string', default: 'low' }, pad: { type: 'string', default: '0' } } })
const [name, given] = positionals
if (name === undefined) {
  console.error(USAGE)
  process.exit(2)
}
const loop = values['tool-loop'] === true
const prompt = given ?? (loop ? 'Call get_time once, then answer with the time in one short sentence.' : 'Reply with one short sentence naming the model you are.')
const system = ['You are a helpful assistant.', ...Array<string>(Number(values.pad) || 0).fill(FILLER)].join('\n\n')
const tools = loop ? [{ name: 'get_time', description: 'Returns the current time as an ISO 8601 string.', schema: { type: 'object', properties: {}, additionalProperties: false } }] : []

const configPath = join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'klyth.json')
const configText = readFileSync(configPath, 'utf8')
const parsed = parseConfig(configText)
if (parsed.config === undefined) {
  console.error(`${configPath}: ${parsed.errors.join('; ')}`)
  process.exit(2)
}
const t = resolve(parsed.config, name)
if (t?.kind !== 'remote') {
  console.error(`${name} is not a klyth alias or provider/model in ${configPath}`)
  process.exit(2)
}
const userAgent = (await import('../hooks/product')).klythUserAgent((await import('../.claude-plugin/plugin.json')).default.version)
console.log(`target   ${name === t.target ? name : `${name} → ${t.target}`} (${t.provider.kind}, ${t.provider.origin})`)
console.log(`helper   ${t.provider.auth === 'none' ? 'none' : JSON.stringify(t.provider.auth.command)}`)
console.log(`agent    ${userAgent}`)

const started = performance.now()
const klythd = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'klythd', 'main.ts')], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
const reader = klythd.stdout.getReader()
let out = ''
while (!out.includes('\n')) {
  const r = await reader.read()
  if (r.done) throw new Error(`klythd ended before ready: ${await new Response(klythd.stderr).text()}`)
  out += new TextDecoder().decode(r.value)
}
const [, sock, token] = out.trim().split(' ') as [string, string, string]
console.log(`klythd    ready in ${Math.round(performance.now() - started)} ms at ${sock}`)

// One step over curl: the events klythd answers, printed as they come.
const step = async (transcript: readonly ApiMessage[]): Promise<StepEvent[]> => {
  const wire: StepWire = {
    token,
    configText,
    approved: [fingerprint(t.provider)],
    req: { target: name, system, tools, transcript, effort: values.effort as Effort, who: 'smoke', sessionId: crypto.randomUUID(), cacheLoop: 'smoke', accounting: { purpose: 'step', owner: 'main' } },
  }
  const curl = Bun.spawn(['/usr/bin/curl', '-q', '-sS', '-N', '--unix-socket', sock, '--data-binary', '@-', 'http://klythd/step'], {
    stdin: new TextEncoder().encode(JSON.stringify(wire)),
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const events: StepEvent[] = []
  let buf = ''
  let mode = ''
  for await (const piece of curl.stdout) {
    const lines = (buf + new TextDecoder().decode(piece)).split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines.filter(l => l !== '')) {
      const ev = JSON.parse(line) as StepEvent
      events.push(ev)
      if (ev.type === 'text' || ev.type === 'thinking') {
        if (mode !== ev.type) process.stdout.write(`\n${ev.type === 'text' ? 'answer  ' : 'thinking'} `)
        mode = ev.type
        process.stdout.write(ev.text)
        continue
      }
      if (mode !== '') process.stdout.write('\n')
      mode = ''
      console.log(`${ev.type.padEnd(8)} ${JSON.stringify(ev)}`)
    }
  }
  await curl.exited
  return events
}

const transcript: ApiMessage[] = [{ role: 'user', content: prompt }]
const steps: StepEvent[][] = []
while (steps.length < MAX_STEPS) {
  console.log(`\n-- step ${steps.length + 1}`)
  const events = await step(transcript)
  steps.push(events)
  const calls = events.flatMap(e => (e.type === 'tool_use' ? [e] : []))
  if (!loop || calls.length === 0 || events.some(e => e.type === 'error')) break
  // The assistant turn as the engine records it (thinking is shown, not recorded), then each call answered.
  const said = events.flatMap(e => (e.type === 'text' ? [{ type: 'text', text: e.text }] : []))
  transcript.push(
    { role: 'assistant', content: [...said, ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))] },
    { role: 'user', content: calls.map(c => ({ type: 'tool_result', tool_use_id: c.id, content: new Date().toISOString() })) },
  )
}
klythd.kill('SIGTERM')
await klythd.exited
const log = await new Response(klythd.stderr).text()
console.log(`\nklythd log\n${log}`)

const https = [...log.matchAll(/^klyth step .* http=(\S+)/gm)].map(m => m[1])
console.log('steps')
steps.forEach((events, i) => {
  const u = events.find(e => e.type === 'usage')
  const s = events.find(e => e.type === 'stats')
  const n = (v: number | undefined) => String(v ?? '-')
  console.log(`step ${i + 1}  http ${https[i] ?? '-'}  in ${n(u?.in)} out ${n(u?.out)} cacheRead ${n(u?.cacheRead)} cacheWrite ${n(u?.cacheWrite)}  finish ${s?.finish ?? '-'}`)
})
const last = steps.at(-1) ?? []
const stuck = loop && last.some(e => e.type === 'tool_use')
if (stuck) console.log(`the model was still calling tools after ${MAX_STEPS} steps`)
process.exit(steps.some(events => events.some(e => e.type === 'error')) || stuck ? 1 : 0)
