// The live-check script (scripts/klythd-smoke.ts) end to end against a local provider: given an alias, it sends
// the alias itself as the step's target, so the request klythd makes carries the alias's params, effort level,
// cache marks and headers; given `provider/model` it sends the model alone.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'klythd-smoke.ts')
const seen: { body: Record<string, unknown>; headers: Record<string, string> }[] = []
const sse = (...events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
const provider = Bun.serve({
  hostname: '::1',
  port: 0,
  async fetch(req) {
    seen.push({ body: (await req.json()) as Record<string, unknown>, headers: Object.fromEntries(req.headers) })
    const answer = sse(
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    )
    return new Response(answer, { headers: { 'content-type': 'text/event-stream' } })
  },
})
const dir = mkdtempSync(join(tmpdir(), 'klyth-smoke-'))
afterAll(() => (void provider.stop(true), rmSync(dir, { recursive: true, force: true })))
// The script asks `claude --version` for its User-Agent; a stub answers it.
const bin = join(dir, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.292 (Claude Code)"\n')
chmodSync(join(bin, 'claude'), 0o755)
writeFileSync(
  join(dir, 'klyth.json'),
  JSON.stringify({
    providers: {
      cl: { kind: 'anthropic', baseUrl: `http://klyth.localhost:${provider.port}`, allowHttp: true, auth: { command: ['/bin/echo', 'sk-smoke-0123456789abcdef'] }, models: { m: { contextWindow: 200_000, maxOutputTokens: 8000, params: { top_k: 1 } } } },
    },
    aliases: { deep: { target: 'cl/m', params: { thinking: { type: 'adaptive' }, top_k: 2 }, cache: '1h', headers: { 'x-alias': 'deep' } } },
  }),
)

async function smoke(name: string) {
  const proc = Bun.spawn([process.execPath, SCRIPT, name], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir, PATH: `${bin}:${process.env['PATH']}` }, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { out, code }
}

test('given an alias the script sends the alias, so the provider request carries its params, cache marks and headers', async () => {
  const { out, code } = await smoke('deep')
  expect(code).toBe(0)
  expect(out).toContain('target   deep → cl/m (anthropic,')
  const sent = seen.at(-1)
  expect(sent?.body).toMatchObject({ top_k: 2, thinking: { type: 'adaptive' }, system: [{ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } }] })
  expect(sent?.headers).toMatchObject({ 'x-alias': 'deep' })
})

test('given provider/model the script sends the model alone', async () => {
  const { out, code } = await smoke('cl/m')
  expect(code).toBe(0)
  expect(out).toContain('target   cl/m (anthropic,')
  const sent = seen.at(-1)
  expect(sent?.body).toMatchObject({ top_k: 1, system: 'You are a helpful assistant.' })
  expect(sent?.body).not.toHaveProperty('thinking')
  expect(sent?.headers).not.toHaveProperty('x-alias')
})
