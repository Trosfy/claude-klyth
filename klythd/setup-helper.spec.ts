// Core auth entry-point behavior over shared offline worlds.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfig } from '../hooks/config'
import type { SetupConnection } from '../hooks/setup-protocol'
import { RESOURCE } from '../scripts/chatgpt'
import { runSetup, runSetupHelper } from '../scripts/setup'
import { revisionOf } from '../scripts/setup-config'
import { publishPending, readPending } from '../scripts/setup-pending'
import { connection, failed, model, nativeSetup, provider, save, world } from './fixtures/setup-helper-world'

test('invalid requests have no file, credential, process or network effects; exactly one done', async () => {
  const w = world()
  await runSetup({ version: 1, action: 'models', connection: { ...connection, secret: 'pasted-token' } }, w.io)
  expect(w.calls).toEqual([]); expect(failed(w)).toEqual({ version: 1, type: 'failed', code: 'invalid-request' })
  expect(w.events.filter(e => e.type === 'done')).toHaveLength(1)
})
test('inspection of absent config and Linux presence are local metadata only', async () => {
  const w = world()
  await runSetup({ version: 1, action: 'inspect' }, w.io)
  expect(w.events[0]).toEqual({ version: 1, type: 'inspection', providers: [], aliases: [] })
  await runSetup({ version: 1, action: 'presence', provider: 'custom' }, w.io)
  expect(w.events.at(-2)).toEqual({ version: 1, type: 'presence', status: 'unknown' }); expect(w.calls).toEqual([])
})
test('malformed and dangling configuration fail rather than becoming an absent config', async () => {
  for (const raw of ['{broken', { providers: { custom: { ...provider, models: {} } } }]) {
    const w = world(raw); await runSetup({ version: 1, action: 'inspect' }, w.io)
    expect(failed(w)).toMatchObject({ code: 'invalid-config' }); expect(w.calls).toEqual([])
  }
  const w = world(); symlinkSync(join(w.dir, 'absent'), w.io.configPath)
  await runSetup({ version: 1, action: 'inspect' }, w.io)
  expect(failed(w)).toMatchObject({ code: 'invalid-config' })
})
test('first save creates a valid complete provider, canonical target and 0600 config', async () => {
  const w = world(); expect(await save(w)).toBe(0)
  expect(parseConfig(JSON.stringify(w.raw())).errors).toEqual([])
  expect(w.events[0]).toEqual({ version: 1, type: 'saved', target: 'custom/chosen-id' })
  expect(statSync(w.io.configPath).mode & 0o777).toBe(0o600)
  expect(w.raw().aliases).toBeUndefined()
})
test('symlink save preserves mode, model params/prices, unrelated providers and aliases', async () => {
  const selected = { ...provider, models: { 'chosen-id': { ...provider.models['chosen-id'], params: { temperature: 0.4 }, pricing: { currency: 'USD', perMillionTokens: { input: 1, output: 2 } } } }, headers: { 'x-custom': 'preserved' } }
  const raw = { providers: { custom: selected, other: provider }, aliases: { preserved: 'other/chosen-id' } }
  const w = world(raw), target = join(w.dir, 'real.json')
  writeFileSync(target, JSON.stringify(raw), { mode: 0o640 })
  const link = join(w.dir, 'link.json'); symlinkSync(target, link); w.io.configPath = link
  expect(await save(w, connection, revisionOf(selected), { alias: 'new-alias', model: { ...model, maxOutputTokens: 2000 } })).toBe(0)
  expect(lstatSync(link).isSymbolicLink()).toBe(true); expect(statSync(target).mode & 0o777).toBe(0o640)
  expect(w.raw().providers.custom.models['chosen-id']).toMatchObject({ params: { temperature: 0.4 }, pricing: { currency: 'USD', perMillionTokens: { input: 1, output: 2 } }, maxOutputTokens: 2000 })
  w.events.length = 0
  await runSetup({ version: 1, action: 'inspect' }, w.io)
  expect(w.events[0]).toMatchObject({ aliases: ['preserved', 'new-alias'] })
  expect(w.raw().providers.other).toEqual(provider); expect(w.raw().aliases).toEqual({ preserved: 'other/chosen-id', 'new-alias': 'custom/chosen-id' })
})
test('selected revision and alias collisions refuse overwrite, unrelated edits survive fresh locked reads', async () => {
  const w = world({ providers: { custom: provider }, aliases: { taken: 'custom/chosen-id' } })
  const revision = revisionOf(provider)
  const raw = w.raw(); raw.providers.other = provider; writeFileSync(w.io.configPath, JSON.stringify(raw))
  expect(await save(w, connection, revision)).toBe(0); expect(w.raw().providers.other).toEqual(provider)
  raw.providers.custom.headers = { 'x-changed': 'concurrent' }; writeFileSync(w.io.configPath, JSON.stringify(raw))
  expect(await save(w, connection, revision)).toBe(1); expect(failed(w)).toMatchObject({ code: 'config-conflict' })
  const a = world({ providers: { other: provider }, aliases: { taken: 'other/chosen-id' } })
  expect(await save(a, connection, null, { alias: 'taken' })).toBe(1); expect(a.raw().providers.custom).toBeUndefined()
})
test('existing helper selection uses only exact configured source and revision; save copies auth not commands from UI', async () => {
  const source = { ...provider, auth: { command: ['/configured/helper'], ttlSeconds: 99 } }
  const w = world({ providers: { source } }), c: SetupConnection = { ...connection, auth: { kind: 'existing', provider: 'source', revision: revisionOf(source)! } }
  expect(await save(w, c)).toBe(0); expect(w.raw().providers.custom.auth).toEqual(source.auth)
  const bad = world({ providers: { source } }); c.auth = { kind: 'existing', provider: 'source', revision: '0'.repeat(64) }
  expect(await save(bad, c)).toBe(1); expect(bad.raw().providers.custom).toBeUndefined()
})
test('models require explicit request, use x-api-key for Anthropic and never invent limits', async () => {
  const w = world(); w.items.custom = 'fixture-api-key'
  w.io.fetch = async (_url, init) => { expect(new Headers(init.headers).get('x-api-key')).toBe('fixture-api-key'); expect(init.redirect).toBe('error'); return Response.json({ data: [{ id: 'only-id', context_window: -1 }] }) }
  await runSetup({ version: 1, action: 'models', connection: { ...connection, kind: 'anthropic', auth: { kind: 'keyring' } } }, w.io)
  expect(w.events[0]).toEqual({ version: 1, type: 'models', models: [{ id: 'only-id' }] })
  const b = world(); await runSetup({ version: 1, action: 'models', connection: { ...connection, kind: 'bedrock', auth: { kind: 'keyring' } } }, b.io)
  expect(failed(b)).toMatchObject({ code: 'models-unavailable' }); expect(b.calls).toEqual([])
})
test('metadata redirect, oversized response and endpoint schema failures are closed and sanitized', async () => {
  for (const response of [new Response('raw-secret', { status: 302, headers: { location: 'https://evil.invalid' } }), new Response('x'.repeat(256 * 1024 + 1))]) {
    const w = world(); w.io.fetch = async () => response
    await runSetup({ version: 1, action: 'models', connection }, w.io)
    expect(failed(w)).toMatchObject({ code: 'models-unavailable' }); expect(JSON.stringify(w.events)).not.toContain('raw-secret')
  }
  const w = world(); await runSetup({ version: 1, action: 'models', connection: { ...connection, baseUrl: 'https://[::1]/v1' } }, w.io)
  expect(failed(w)).toMatchObject({ code: 'invalid-request' }); expect(w.calls).toEqual([])
})
for (const client of ['official'] as const) test(`${client} real auth callbacks produce wire challenges, private handoff and complete saved config`, async () => {
  const w = world()
  expect(await runSetup({ version: 1, action: 'login', provider: 'custom', client }, w.io)).toBe(0)
  expect(w.opened).toEqual([])
  expect(w.events[0]?.type).toBe(client === 'official' ? 'browser-challenge' : 'device-challenge')
  const saved = w.events.find(e => e.type === 'credentials-saved')!
  expect(saved.type).toBe('credentials-saved'); if (saved.type !== 'credentials-saved') return
  const record = readPending(w.io, 'custom', saved.handle, client)
  expect(record.fingerprint).toBe(createHash('sha256').update(w.items.custom!).digest('hex'))
  expect(statSync(join(w.dir, 'klyth/setup')).mode & 0o777).toBe(0o700)
  expect(statSync(join(w.dir, 'klyth/setup/custom.json')).mode & 0o777).toBe(0o600)
  const publicOutput = JSON.stringify(w.events)
  for (const secret of ['fixture-access', 'fixture-refresh', 'private-account', 'secret-claim@example.invalid', 'private-verifier']) expect(publicOutput).not.toContain(secret)
  const c: SetupConnection = { ...connection, kind: 'openai-responses', baseUrl: RESOURCE, auth: { kind: 'chatgpt', client, handle: saved.handle } }
  const metadataFetch = w.io.fetch
  w.io.fetch = (url, init) => { expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-access'); return metadataFetch(url, init) }
  expect(await runSetup({ version: 1, action: 'models', connection: c }, w.io)).toBe(0)
  expect(await save(w, c)).toBe(0); expect(w.raw().providers.custom.auth.command).toEqual(['/immutable/klyth', 'auth', 'token', 'custom'])
  expect(readPending(w.io, 'custom', saved.handle, client).consumed).toBe(true)
  // A consumed handle cannot authorize another configuration operation.
  expect(await save(w, c)).toBe(1)
  expect(await save(w, c, revisionOf(w.raw().providers.custom), { model: { ...model, maxOutputTokens: 2000 } })).toBe(1)
})
test('handoff publication failure truthfully reports saved credential without exposing a fake handle', async () => {
  const w = world(); mkdirSync(join(w.dir, 'klyth'), { mode: 0o755 }); chmodSync(join(w.dir, 'klyth'), 0o755)
  expect(await runSetup({ version: 1, action: 'login', provider: 'custom', client: 'official' }, w.io)).toBe(1)
  expect(w.items.custom).toContain('v1|'); expect(failed(w)).toMatchObject({ code: 'handoff-failed' })
  expect(w.events.some(e => e.type === 'credentials-saved')).toBe(false); expect(w.held.size).toBe(0)
})
test('expired, superseded and changed credential generations reject; credentials remain stored', async () => {
  const w = world(), value = 'v1|client|refresh|1800003600||access'; w.items.custom = value
  const data = { provider: 'custom', method: 'v1' as const, clientId: 'client', fingerprint: createHash('sha256').update(value).digest('hex') }
  const first = publishPending(w.io, data), second = publishPending(w.io, data)
  const c = (handle: string): SetupConnection => ({ ...connection, kind: 'openai-responses', baseUrl: RESOURCE, auth: { kind: 'chatgpt', client: 'official', handle } })
  expect(await save(w, c(first.handle))).toBe(1)
  w.items.custom = `${value}-changed`; expect(await save(w, c(second.handle))).toBe(1)
  w.items.custom = value; w.advance(15 * 60_000); expect(await save(w, c(second.handle))).toBe(1)
  expect(w.items.custom).toBe(value); expect(w.held.size).toBe(0)
})
test('model failure after successful login retains usable pending handoff without claiming availability', async () => {
  const w = world(), fetcher = w.io.fetch
  w.io.fetch = (url, init) => url.endsWith('/models') ? Promise.resolve(Response.json({ data: [] })) : fetcher(url, init)
  await runSetup({ version: 1, action: 'login', provider: 'custom', client: 'official' }, w.io)
  expect(w.events.some(e => e.type === 'credentials-saved')).toBe(true); expect(failed(w)).toMatchObject({ code: 'models-unavailable' })
})
test('aborted operation does not read credentials or start login', async () => {
  const w = world(); w.io.signal = AbortSignal.abort()
  expect(await runSetup({ version: 1, action: 'login', provider: 'custom', client: 'official' }, w.io)).toBe(130)
  expect(failed(w)).toMatchObject({ code: 'cancelled' }); expect(w.calls).toEqual([])
})
test('post-write pending bookkeeping failure reports known saved config and allows identical retry', async () => {
  const w = world(), value = 'v1|client|refresh|1800003600||access'; w.items.custom = value
  const record = publishPending(w.io, { provider: 'custom', method: 'v1', clientId: 'client', fingerprint: createHash('sha256').update(value).digest('hex') })
  const c: SetupConnection = { ...connection, kind: 'openai-responses', baseUrl: RESOURCE, auth: { kind: 'chatgpt', client: 'official', handle: record.handle } }
  const output = w.io.write, slot = join(w.dir, 'klyth/setup/custom.json')
  w.io.write = line => { output(line); if (JSON.parse(line).type === 'saved') chmodSync(slot, 0o644) }
  expect(await save(w, c)).toBe(1)
  expect(w.events.map(e => e.type)).toEqual(['saved', 'failed', 'done'])
  expect(failed(w)).toMatchObject({ code: 'save-failed' }); expect(w.raw().providers.custom.models['chosen-id']).toBeDefined()
  chmodSync(slot, 0o600); w.io.write = output
  expect(await save(w, c)).toBe(0)
})
test('credential replacement between preflight and auth-core snapshot is refused', async () => {
  const w = world(), runner = w.io.run; let reads = 0
  w.io.run = async (argv, input) => {
    if (argv[1] === 'lookup' && ++reads === 2) w.items.custom = 'newly-stored-api-key'
    return runner(argv, input)
  }
  expect(await runSetup({ version: 1, action: 'login', provider: 'custom', client: 'official' }, w.io)).toBe(1)
  expect(failed(w)).toMatchObject({ code: 'credential-conflict' }); expect(w.items.custom).toBe('newly-stored-api-key')
  expect(w.events.some(e => e.type === 'browser-challenge')).toBe(false)
})
test('pending-slot symlink and permissive mode fail without altering the linked file', async () => {
  const w = world(), value = 'v1|client|refresh|1800003600||access'
  const data = { provider: 'custom', method: 'v1' as const, clientId: 'client', fingerprint: createHash('sha256').update(value).digest('hex') }
  const record = publishPending(w.io, data), external = join(w.dir, 'external.json')
  writeFileSync(external, 'untouched', { mode: 0o600 }); symlinkSync(external, join(w.dir, 'klyth/setup/custom.pending'))
  expect(() => publishPending(w.io, data)).toThrow(); expect(readFileSync(external, 'utf8')).toBe('untouched')
  chmodSync(join(w.dir, 'klyth/setup/custom.json'), 0o644)
  expect(() => readPending(w.io, 'custom', record.handle, 'official')).toThrow()
})
test('existing metadata helper runs only explicitly and fails sanitized before network', async () => {
  const source = { ...provider, auth: { command: ['/configured/helper'] } }, w = world({ providers: { source } })
  const c: SetupConnection = { ...connection, auth: { kind: 'existing', provider: 'source', revision: revisionOf(source)! } }
  let helpers = 0, networks = 0
  w.io.runHelper = async (argv, timeout) => { helpers++; expect(argv).toEqual(['/configured/helper']); expect(timeout).toBe(5000); return { exitCode: 1, stdout: 'raw-token', stderr: 'raw-provider-error' } }
  w.io.fetch = async () => { networks++; return Response.json({ data: [] }) }
  await runSetup({ version: 1, action: 'inspect' }, w.io); expect(helpers).toBe(0)
  await runSetup({ version: 1, action: 'models', connection: c }, w.io)
  expect(helpers).toBe(1); expect(networks).toBe(0); expect(JSON.stringify(w.events)).not.toContain('raw-provider-error')
})
test('in-flight browser cancellation closes callback listener and stores nothing', async () => {
  const w = world(), abort = new AbortController(); let closed = 0
  w.io.signal = abort.signal
  w.io.listen = () => ({ url: 'http://127.0.0.1:1455/auth/callback', close: () => { closed++ } })
  const output = w.io.write
  w.io.write = line => { if (JSON.parse(line).type === 'browser-challenge') abort.abort(); output(line) }
  expect(await runSetup({ version: 1, action: 'login', provider: 'custom', client: 'official' }, w.io)).toBe(130)
  expect(closed).toBe(1); expect(w.items).toEqual({}); expect(failed(w)).toMatchObject({ code: 'cancelled' })
})
test('keyring and Bedrock save use keyring argv, preserving the existing helper TTL', async () => {
  const prior = { ...provider, auth: { command: ['/old/helper'], ttlSeconds: 123 } }
  const w = world({ providers: { custom: prior } })
  expect(await save(w, { ...connection, auth: { kind: 'keyring' } }, revisionOf(prior))).toBe(0)
  expect(w.raw().providers.custom.auth).toEqual({ command: w.io.store.read('custom'), ttlSeconds: 123 })
  const b = world(); expect(await save(b, { ...connection, kind: 'bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', auth: { kind: 'keyring' } })).toBe(0)
  expect(b.calls).toEqual([])
})
test('excessive configured-helper output is killed and rejected before metadata fetch', async () => {
  const source = { ...provider, auth: { command: ['/configured/helper'] } }, w = world({ providers: { source } })
  const c: SetupConnection = { ...connection, auth: { kind: 'existing', provider: 'source', revision: revisionOf(source)! } }
  let killed = 0, networks = 0
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
  w.io.runHelper = (argv, timeout) => runSetupHelper(argv, timeout, undefined, args => {
    expect(args).toEqual(['/configured/helper'])
    return { stdout: stream('x'.repeat(64 * 1024 + 1)), stderr: stream('raw-provider-error'), exited: Promise.resolve(0), kill: signal => { expect(signal).toBe('SIGKILL'); killed++ } }
  })
  w.io.fetch = async () => { networks++; return Response.json({ data: [] }) }
  expect(await runSetup({ version: 1, action: 'models', connection: c }, w.io)).toBe(1)
  expect(killed).toBe(1); expect(networks).toBe(0)
  expect(w.events).toEqual([{ version: 1, type: 'failed', code: 'models-unavailable' }, { version: 1, type: 'done' }])
})

// Exercise controller requests against the real helper producer and runtime JSONL consumer.
for (const client of ['official'] as const) test(`${client} controller signs in and saves through real helper JSONL with Responses kind`, async () => {
  const w = world(), { controller, requests, flush } = nativeSetup(w)
  try {
    await controller.open({ redraw: () => {}, closePane: () => {} })
    const id = 'chatgpt'
    controller.dispatch({ type: 'choose-provider', provider: id })
    controller.dispatch({ type: 'begin-sign-in', provider: id }); await flush()
    expect(controller.view().phase).toBe('model')
    controller.dispatch({ type: 'choose-model', modelId: model.id })
    controller.dispatch({ type: 'update-field', field: 'contextWindow', value: String(model.contextWindow) })
    controller.dispatch({ type: 'update-field', field: 'maxOutputTokens', value: String(model.maxOutputTokens) })
    controller.dispatch({ type: 'save-only' }); await flush()
    expect(controller.view()).toMatchObject({ phase: 'result', status: 'configured' })
    expect(requests.find(r => r.action === 'save')).toMatchObject({ connection: { kind: 'openai-responses' } })
    expect(w.raw().providers[id].kind).toBe('openai-responses')
    expect(w.events.filter(e => e.type === 'failed')).toEqual([])
  } finally { controller.close() }
})
test('real login with unavailable models permits manual entry and save without a second OAuth flow', async () => {
  const w = world(), fetcher = w.io.fetch
  w.io.fetch = (url, init) => url.endsWith('/models') ? Promise.resolve(Response.json({ data: [] })) : fetcher(url, init)
  const { controller, requests, flush } = nativeSetup(w)
  try {
    await controller.open({ redraw: () => {}, closePane: () => {} })
    controller.dispatch({ type: 'begin-sign-in', provider: 'chatgpt' }); await flush()
    expect(w.events.slice(-4).map(e => e.type)).toEqual(['credentials-saved', 'models', 'failed', 'done'])
    expect(controller.view()).toMatchObject({ phase: 'model', manualEntry: true })
    controller.dispatch({ type: 'update-field', field: 'modelId', value: 'manual-id' })
    controller.dispatch({ type: 'update-field', field: 'contextWindow', value: '10000' })
    controller.dispatch({ type: 'update-field', field: 'maxOutputTokens', value: '1000' })
    controller.dispatch({ type: 'save-only' }); await flush()
    expect(controller.view()).toMatchObject({ phase: 'result', status: 'configured' })
    expect(w.raw().providers.chatgpt.models['manual-id']).toMatchObject({ contextWindow: 10000, maxOutputTokens: 1000 })
    expect(requests.filter(r => r.action === 'login')).toHaveLength(1)
  } finally { controller.close() }
})
for (const client of ['old-client', 'fixture-client']) test(`native official callback ${client === 'old-client' ? 'refuses changed' : 'accepts same'} issuing client before exchange`, async () => {
  const w = world(), fetcher = w.io.fetch, prior = `v1|${client}|refresh|1800003600||old-access`
  w.items.custom = prior
  let exchanges = 0
  w.io.fetch = (url, init) => { if (url.endsWith('/token')) exchanges++; return fetcher(url, init) }
  const exit = await runSetup({ version: 1, action: 'login', provider: 'custom', client: 'official' }, w.io)
  if (client === 'old-client') {
    expect(exit).toBe(1); expect(exchanges).toBe(0); expect(w.items.custom).toBe(prior)
    expect(failed(w)).toMatchObject({ code: 'credential-conflict' })
    expect(w.events.some(e => e.type === 'credentials-saved')).toBe(false)
    expect(w.calls.some(argv => argv[1] === 'store')).toBe(false)
  } else {
    expect(exit).toBe(0); expect(exchanges).toBe(1); expect(w.items.custom).toStartWith('v1|fixture-client|')
    expect(w.items.custom).not.toBe(prior)
  }
})

for (const failure of ['invalid-config', 'config-conflict'] as const) test(`native save recovery retains authenticated draft after ${failure} and refreshes consent without OAuth`, async () => {
  const w = world(), { controller, requests, flush } = nativeSetup(w)
  try {
    await controller.open({ redraw: () => {}, closePane: () => {} })
    controller.dispatch({ type: 'begin-sign-in', provider: 'chatgpt' }); await flush()
    controller.dispatch({ type: 'choose-model', modelId: model.id })
    controller.dispatch({ type: 'update-field', field: 'contextWindow', value: String(model.contextWindow) })
    controller.dispatch({ type: 'update-field', field: 'maxOutputTokens', value: String(model.maxOutputTokens) })
    controller.dispatch({ type: 'update-field', field: 'alias', value: 'saved-choice' })
    const concurrent = { kind: 'openai-responses', baseUrl: RESOURCE, auth: { command: ['/immutable/klyth', 'auth', 'token', 'chatgpt'] }, models: { prior: { contextWindow: 20000, maxOutputTokens: 2000 } } }
    writeFileSync(w.io.configPath, failure === 'invalid-config' ? '{' : JSON.stringify({ providers: { chatgpt: concurrent } }))
    controller.dispatch({ type: 'save-only' }); await flush()
    expect(controller.view().phase).toBe('error')
    expect(failed(w)).toMatchObject({ code: failure })
    const saved = w.events.find(e => e.type === 'credentials-saved')!
    if (saved.type !== 'credentials-saved') throw new Error('missing handoff')
    expect(readPending(w.io, 'chatgpt', saved.handle, 'official').consumed).toBe(false)
    if (failure === 'invalid-config') writeFileSync(w.io.configPath, '{}')
    controller.dispatch({ type: failure === 'config-conflict' ? 'back' : 'retry' }); await flush()
    expect(controller.view()).toMatchObject({ phase: 'model', selectedModelId: model.id, alias: 'saved-choice', contextWindow: String(model.contextWindow), maxOutputTokens: String(model.maxOutputTokens), detailsExpanded: true, canSave: true })
    expect(requests.filter(r => r.action === 'save')).toHaveLength(1)
    controller.dispatch({ type: 'save-only' }); await flush()
    expect(controller.view()).toMatchObject({ phase: 'result', status: 'configured' })
    expect(requests.map(r => r.action)).toEqual(['inspect', 'login', 'save', 'inspect', 'save'])
    expect(requests.at(-1)).toMatchObject({ action: 'save', expectedRevision: failure === 'config-conflict' ? revisionOf(concurrent) : null })
    expect(w.raw().providers.chatgpt.models[model.id]).toMatchObject({ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens })
    expect(w.raw().aliases['saved-choice']).toBe(`chatgpt/${model.id}`)
    expect(readPending(w.io, 'chatgpt', saved.handle, 'official').consumed).toBe(true)
  } finally { controller.close() }
})

test('native sign-in save strips stale User-Agent case-insensitively without dropping unrelated headers', async () => {
  for (const name of ['User-Agent', 'user-agent', 'uSeR-aGeNt']) {
    const selected = { ...provider, kind: 'openai-responses', baseUrl: RESOURCE, headers: { [name]: 'stale/1', 'X-Team': 'blue' } }
    const w = world({ providers: { custom: selected } })
    expect(await runSetup({ version: 1, action: 'login', provider: 'custom', client: 'official' }, w.io)).toBe(0)
    const saved = w.events.find(e => e.type === 'credentials-saved')!
    if (saved.type !== 'credentials-saved') throw new Error('missing handoff')
    const c: SetupConnection = { ...connection, kind: 'openai-responses', baseUrl: RESOURCE, auth: { kind: 'chatgpt', client: 'official', handle: saved.handle } }
    expect(await save(w, c, revisionOf(selected))).toBe(0)
    expect(w.raw().providers.custom.headers).toEqual({ 'X-Team': 'blue' })
  }
})
