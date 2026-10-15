import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { createSetupController, type SetupControllerPorts } from '../hooks/setup-controller'
import { setupFrames } from '../hooks/setup-protocol'
import type { SetupEvent, SetupProviderSummary, SetupRequest } from '../hooks/setup-protocol'

const REVISION = 'a'.repeat(64)
const MODEL = { id: 'vendor/model-a', name: 'Model A' }
const configuredModel = { ...MODEL, contextWindow: 128_000, maxOutputTokens: 8_192 }
const existingProvider = (models = [configuredModel]): SetupProviderSummary => ({
  id: 'work-gateway', kind: 'openai', baseUrl: 'https://gateway.example.com/v1', allowHttp: false,
  configuredAuth: true, revision: REVISION, models,
})
const inspect = (providers: SetupProviderSummary[] = [], aliases: string[] = []): SetupEvent => ({ version: 1, type: 'inspection', providers, aliases })
const done: SetupEvent = { version: 1, type: 'done' }

function stream(events: readonly SetupEvent[], onEvent: (event: SetupEvent) => void): void {
  const frames = setupFrames(onEvent)
  const source = events.map(event => `${JSON.stringify(event)}\n`).join('')
  for (let offset = 0; offset < source.length; offset += 11) frames.feed(source.slice(offset, offset + 11))
  frames.end()
}

function standardEvents(request: SetupRequest, providers: SetupProviderSummary[] = [], aliases: string[] = []): SetupEvent[] {
  if (request.action === 'inspect') return [inspect(providers, aliases), done]
  if (request.action === 'presence') return [{ version: 1, type: 'presence', status: 'unknown' }, done]
  if (request.action === 'models') return [{ version: 1, type: 'models', models: [MODEL] }, done]
  if (request.action === 'save') return [{ version: 1, type: 'saved', target: `${request.connection.provider}/${request.model.id}` }, done]
  return [{ version: 1, type: 'failed', code: 'auth-failed' }, done]
}

type TimerFixture = { delay: number; callback: () => void; cancelled: boolean }
type Calls = { requests: SetupRequest[]; installs: number; browserUrls: string[]; copiedUrls: string[]; reloads: string[]; uses: string[]; keyProviders: string[]; signals: AbortSignal[]; timers: TimerFixture[] }
function ports(_on: On, events: (request: SetupRequest) => SetupEvent[], calls: Calls, overrides: Partial<SetupControllerPorts> = {}): SetupControllerPorts {
  return {
    helperReady: async () => true,
    installHelper: async () => { calls.installs++ },
    invoke: async (request, onEvent, signal) => { calls.requests.push(request); calls.signals.push(signal); stream(events(request), onEvent) },
    keyCommand: provider => { calls.keyProviders.push(provider); return `/opt/klyth/bin/klyth auth login api-key ${provider}` },
    reopenBrowser: url => { calls.browserUrls.push(url) },
    copySignInLink: async url => { calls.copiedUrls.push(url); return true },
    reload: target => { calls.reloads.push(target); return true },
    useModel: target => { calls.uses.push(target); return true },
    now: async () => Date.now(),
    after: (delay, callback) => {
      const timer: TimerFixture = { delay, callback, cancelled: false }
      calls.timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    },
    ...overrides,
  }
}
const newCalls = (): Calls => ({ requests: [], installs: 0, browserUrls: [], copiedUrls: [], reloads: [], uses: [], keyProviders: [], signals: [], timers: [] })
const uiPort = (views: unknown[], closes: number[]) => ({ redraw: (view: unknown) => views.push(view), closePane: () => { closes.push(1) } })
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('missing helper is not installed on open and explicit install continues into inspection', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  let ready = false
  const io = ports(on, request => standardEvents(request), calls, {
    helperReady: async () => ready,
    installHelper: async () => { calls.installs++; ready = true },
  })
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  expect(controller.view()).toMatchObject({ phase: 'helper', status: 'needed' })
  expect(calls.requests).toEqual([])
  controller.dispatch({ type: 'install-helper' })
  await flush()
  expect(calls.installs).toBe(1)
  expect(calls.requests.map(request => request.action)).toEqual(['inspect'])
  expect(controller.view().phase).toBe('connect')
  controller.close()
})

test('missing inspection completion fails closed instead of offering a configured provider', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  const io = ports(on, request => request.action === 'inspect' ? [inspect([existingProvider()])] : standardEvents(request), calls)
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  expect(controller.view()).toMatchObject({ phase: 'error' })
  expect(controller.view().phase).not.toBe('connect')
  controller.close()
})

test('custom API-key setup validates locally, fetches models only on request, and saves without switching', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  let discoveryCount = 0
  const io = ports(on, request => request.action === 'models' && discoveryCount++ === 0
    ? [{ version: 1, type: 'failed', code: 'models-unavailable' }, done]
    : standardEvents(request, [], ['openai-compatible-vendor-model-a']), calls)
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  expect(controller.view().phase).toBe('connect')
  controller.dispatch({ type: 'choose-provider', provider: 'openai-compatible' })
  controller.dispatch({ type: 'update-field', field: 'baseUrl', value: 'https://api.example.com/v1' })
  controller.dispatch({ type: 'continue-connection' })
  expect(controller.view().phase).toBe('api-key')
  expect(calls.keyProviders).toEqual(['openai-compatible'])
  expect(calls.requests.map(request => request.action)).toEqual(['inspect'])
  controller.dispatch({ type: 'continue-api-key' })
  await flush()
  expect(controller.view().phase).toBe('model')
  expect(calls.requests.map(request => request.action)).toEqual(['inspect', 'presence'])
  controller.dispatch({ type: 'fetch-models' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'model', modelDiscovery: { state: 'failed' }, manualEntry: true })
  controller.dispatch({ type: 'fetch-models' })
  await flush()
  expect(calls.requests.map(request => request.action)).toEqual(['inspect', 'presence', 'models', 'models'])
  expect(controller.view()).toMatchObject({ phase: 'model', models: [{ id: 'vendor/model-a' }], contextWindow: '', maxOutputTokens: '' })
  controller.dispatch({ type: 'choose-model', modelId: MODEL.id })
  expect(controller.view()).toMatchObject({ phase: 'model', contextWindow: '', maxOutputTokens: '' })
  controller.dispatch({ type: 'update-field', field: 'contextWindow', value: '128000' })
  controller.dispatch({ type: 'update-field', field: 'maxOutputTokens', value: '8192' })
  expect(controller.view()).toMatchObject({ phase: 'model', suggestedAlias: 'openai-compatible-vendor-model-a-2', canSave: true })
  controller.dispatch({ type: 'save-only' })
  await flush()
  expect(calls.requests.map(request => request.action)).toEqual(['inspect', 'presence', 'models', 'models', 'save'])
  const saveRequest = calls.requests.find(request => request.action === 'save')
  expect(saveRequest).toMatchObject({ action: 'save', expectedRevision: null, model: { id: MODEL.id, contextWindow: 128000, maxOutputTokens: 8192 } })
  expect(calls.reloads).toEqual([`openai-compatible/${MODEL.id}`])
  expect(calls.uses).toEqual([])
  expect(controller.view()).toMatchObject({ phase: 'result', status: 'configured' })
  controller.close()
  expect(closes).toEqual([1])
})

test('existing providers reuse inspected models without login and retry reload or model switch without saving again', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  let reloadCount = 0, useCount = 0
  const io = ports(on, request => standardEvents(request, [existingProvider()]), calls, {
    reload: target => { calls.reloads.push(target); return ++reloadCount > 1 },
    useModel: target => { calls.uses.push(target); return ++useCount > 1 },
  })
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'choose-existing-provider', id: 'work-gateway' })
  controller.dispatch({ type: 'continue-connection' })
  expect(controller.view()).toMatchObject({ phase: 'model', models: [{ id: MODEL.id }] })
  controller.dispatch({ type: 'choose-model', modelId: MODEL.id })
  expect(controller.view()).toMatchObject({ phase: 'model', contextWindow: undefined, maxOutputTokens: undefined, canSave: true })
  expect(calls.requests.map(request => request.action)).toEqual(['inspect'])
  controller.dispatch({ type: 'save-and-use' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'result', status: 'saved-not-connected' })
  expect(calls.uses).toEqual([])
  controller.dispatch({ type: 'retry' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'result', status: 'saved-not-switched' })
  controller.dispatch({ type: 'retry' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'result', status: 'active' })
  const save = calls.requests.find(request => request.action === 'save')
  expect(save).toMatchObject({ action: 'save', expectedRevision: REVISION, connection: { auth: { kind: 'existing', provider: 'work-gateway', revision: REVISION } } })
  expect(calls.requests.filter(request => request.action === 'save')).toHaveLength(1)
  expect(calls.requests.some(request => request.action === 'login')).toBe(false)
  expect(calls.reloads).toEqual([`work-gateway/${MODEL.id}`, `work-gateway/${MODEL.id}`])
  expect(calls.uses).toEqual([`work-gateway/${MODEL.id}`, `work-gateway/${MODEL.id}`])
  controller.close()
})

test('Bedrock uses a validated commercial region and only adds its OpenAI endpoint after the advanced choice', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  const io = ports(on, request => standardEvents(request), calls)
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'choose-provider', provider: 'bedrock' })
  controller.dispatch({ type: 'update-field', field: 'region', value: 'moon-1' })
  controller.dispatch({ type: 'continue-connection' })
  expect(controller.view().phase).toBe('connect')
  expect(calls.keyProviders).toEqual([])
  controller.dispatch({ type: 'update-field', field: 'region', value: 'us-east-1' })
  controller.dispatch({ type: 'toggle-advanced' })
  controller.dispatch({ type: 'set-protocol', protocol: 'bedrock-openai' })
  controller.dispatch({ type: 'continue-connection' })
  expect(controller.view().phase).toBe('api-key')
  controller.dispatch({ type: 'continue-api-key' })
  await flush()
  controller.dispatch({ type: 'fetch-models' })
  await flush()
  const request = calls.requests.find(item => item.action === 'models')
  expect(request).toMatchObject({ action: 'models', connection: { kind: 'openai', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1' } })
  expect(calls.requests.some(item => item.action === 'login')).toBe(false)
  controller.close()
})

test('endpoint validation rejects URL credentials and HTTP requires explicit consent before continuing', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  const io = ports(on, request => standardEvents(request), calls)
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'choose-provider', provider: 'openai-compatible' })
  controller.dispatch({ type: 'update-field', field: 'baseUrl', value: 'https://person:secret@api.example.com/v1?token=x' })
  controller.dispatch({ type: 'continue-connection' })
  expect(controller.view().phase).toBe('connect')
  expect(calls.keyProviders).toEqual([])
  controller.dispatch({ type: 'update-field', field: 'baseUrl', value: 'http://api.example.com/v1' })
  controller.dispatch({ type: 'continue-connection' })
  expect(calls.keyProviders).toEqual([])
  controller.dispatch({ type: 'set-allow-http', allowed: true })
  controller.dispatch({ type: 'continue-connection' })
  expect(controller.view().phase).toBe('api-key')
  expect(calls.keyProviders).toEqual(['openai-compatible'])
  expect(calls.requests.map(request => request.action)).toEqual(['inspect'])
  controller.close()
})

test('existing credential helper needs target-specific consent before model discovery', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  const io = ports(on, request => standardEvents(request, [existingProvider()]), calls)
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'choose-provider', provider: 'openai-compatible' })
  controller.dispatch({ type: 'update-field', field: 'baseUrl', value: 'https://new-endpoint.example.com/v1' })
  controller.dispatch({ type: 'set-auth-method', method: 'existing-helper' })
  expect(controller.view()).toMatchObject({ phase: 'connect', canContinue: false })
  controller.dispatch({ type: 'choose-credential-helper', id: 'work-gateway' })
  expect(controller.view()).toMatchObject({ phase: 'connect', canContinue: false })
  controller.dispatch({ type: 'set-helper-consent', allowed: true })
  expect(controller.view()).toMatchObject({ phase: 'connect', canContinue: true })
  controller.dispatch({ type: 'continue-connection' })
  expect(controller.view()).toMatchObject({ phase: 'model' })
  expect(calls.requests.map(request => request.action)).toEqual(['inspect'])
  controller.dispatch({ type: 'fetch-models' })
  await flush()
  const request = calls.requests.find(item => item.action === 'models')
  expect(request).toMatchObject({
    action: 'models', connection: {
      provider: 'openai-compatible', baseUrl: 'https://new-endpoint.example.com/v1',
      auth: { kind: 'existing', provider: 'work-gateway', revision: REVISION },
    },
  })
  controller.close()
})

test('browser challenge URLs stay controller-only and cancellation rejects late decoded events', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  const authorizeUrl = 'https://auth.openai.com/api/accounts/authorize?client_id=temporary'
  let loginSink: ((event: SetupEvent) => void) | undefined, releaseLogin!: () => void
  const gate = new Promise<void>(resolve => { releaseLogin = resolve })
  let loginSignal: AbortSignal | undefined
  const io = ports(on, request => standardEvents(request), calls, {
    invoke: async (request, onEvent, signal) => {
      calls.requests.push(request); calls.signals.push(signal)
      if (request.action !== 'login') { stream(standardEvents(request), onEvent); return }
      loginSignal = signal
      const frames = setupFrames(onEvent)
      loginSink = event => frames.feed(`${JSON.stringify(event)}\n`)
      loginSink({ version: 1, type: 'browser-challenge', authorizeUrl, expiresAt: Date.now() + 60_000 })
      await gate
      frames.end()
    },
  })
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'begin-sign-in', provider: 'chatgpt' })
  expect(controller.view()).toMatchObject({ phase: 'sign-in', status: 'waiting' })
  expect(JSON.stringify(controller.view())).not.toContain(authorizeUrl)
  await flush()
  expect(calls.browserUrls).toEqual([authorizeUrl])
  controller.dispatch({ type: 'open-browser-again' })
  await flush()
  expect(calls.browserUrls).toEqual([authorizeUrl, authorizeUrl])
  loginSink?.({ version: 1, type: 'credentials-saved', handle: '0123456789abcdef0123456789abcdef' })
  controller.dispatch({ type: 'cancel-auth' })
  expect(loginSignal?.aborted).toBe(true)
  expect(controller.view()).toMatchObject({ phase: 'error', message: 'Sign-in saved; configuration not changed.' })
  loginSink?.({ version: 1, type: 'models', models: [MODEL] })
  loginSink?.(done)
  releaseLogin()
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'error', message: 'Sign-in saved; configuration not changed.' })
  expect(calls.requests.some(request => request.action === 'save')).toBe(false)
  controller.close()
})

test('browser failure offers user-triggered link copy and expiry blocks a late copy', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  const authorizeUrl = 'https://auth.openai.com/api/accounts/authorize?client_id=temporary'
  const expiresAt = 5_000
  let now = 1_000, openAttempts = 0, loginSink: ((event: SetupEvent) => void) | undefined, releaseLogin!: () => void
  const gate = new Promise<void>(resolve => { releaseLogin = resolve })
  let loginSignal: AbortSignal | undefined
  const io = ports(on, request => standardEvents(request), calls, {
    now: async () => now,
    reopenBrowser: async url => { calls.browserUrls.push(url); if (++openAttempts === 1) throw new Error('browser unavailable') },
    invoke: async (request, onEvent, signal) => {
      calls.requests.push(request); calls.signals.push(signal)
      if (request.action !== 'login') { stream(standardEvents(request), onEvent); return }
      loginSignal = signal
      const frames = setupFrames(onEvent)
      loginSink = event => frames.feed(`${JSON.stringify(event)}\n`)
      loginSink({ version: 1, type: 'browser-challenge', authorizeUrl, expiresAt })
      await gate
      frames.end()
    },
  })
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'begin-sign-in', provider: 'chatgpt' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'sign-in', status: 'waiting', notice: expect.stringContaining('forward callback port 1455 over SSH') })
  expect(JSON.stringify(controller.view())).not.toContain(authorizeUrl)
  controller.dispatch({ type: 'copy-sign-in-link' })
  await flush()
  expect(calls.copiedUrls).toEqual([authorizeUrl])
  expect(controller.view()).toMatchObject({ phase: 'sign-in', notice: expect.stringContaining('Sign-in link copied') })
  now = expiresAt + 1
  controller.dispatch({ type: 'copy-sign-in-link' })
  await flush()
  expect(loginSignal?.aborted).toBe(true)
  expect(controller.view()).toMatchObject({ phase: 'error', message: 'The sign-in request expired. Start a new sign-in to continue.' })
  expect(calls.copiedUrls).toHaveLength(1)
  loginSink?.({ version: 1, type: 'credentials-saved', handle: '0123456789abcdef0123456789abcdef' })
  releaseLogin()
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'error', message: 'The sign-in request expired. Start a new sign-in to continue.' })
  controller.close()
})



test('handoff failure reports saved sign-in without requiring a credentials-saved event', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  const io = ports(on, request => request.action === 'login'
    ? [{ version: 1, type: 'failed', code: 'handoff-failed' }, done]
    : standardEvents(request), calls)
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'begin-sign-in', provider: 'chatgpt' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'error', message: 'Sign-in saved; configuration not changed.' })
  expect(calls.requests.filter(request => request.action === 'login')).toHaveLength(1)
  expect(calls.requests.some(request => request.action === 'save')).toBe(false)
  controller.close()
})

test('a confirmed atomic save followed by helper bookkeeping failure is partial success, never a second save', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  let reloadResult = false
  const io = ports(on, request => {
    if (request.action === 'save') return [
      { version: 1, type: 'saved', target: `${request.connection.provider}/${request.model.id}` },
      { version: 1, type: 'failed', code: 'save-failed' }, done,
    ]
    return standardEvents(request, [existingProvider()])
  }, calls, { reload: target => { calls.reloads.push(target); return reloadResult } })
  const controller = createSetupController(io)
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'choose-existing-provider', id: 'work-gateway' })
  controller.dispatch({ type: 'continue-connection' })
  controller.dispatch({ type: 'choose-model', modelId: MODEL.id })
  controller.dispatch({ type: 'save-and-use' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'result', status: 'saved-not-connected' })
  expect(calls.reloads).toEqual([])
  expect(calls.uses).toEqual([])
  expect(calls.requests.filter(request => request.action === 'save')).toHaveLength(1)
  reloadResult = true
  controller.dispatch({ type: 'retry' })
  await flush()
  expect(controller.view()).toMatchObject({ phase: 'result', status: 'active' })
  expect(calls.requests.filter(request => request.action === 'save')).toHaveLength(1)
  expect(calls.reloads).toEqual([`work-gateway/${MODEL.id}`])
  expect(calls.uses).toEqual([`work-gateway/${MODEL.id}`])
  controller.close()
})

test('handoff expiry during save recovery cannot restore an authenticated model preview', { timeoutMs: 30000 }, async ($, on) => {
  const calls = newCalls(), views: unknown[] = [], closes: number[] = []
  let inspections = 0, release = () => {}
  const events = (request: SetupRequest): SetupEvent[] => request.action === 'login'
    ? [{ version: 1, type: 'credentials-saved', handle: 'a'.repeat(32) }, { version: 1, type: 'models', models: [configuredModel] }, done]
    : request.action === 'save' ? [{ version: 1, type: 'failed', code: 'save-failed' }, done] : standardEvents(request)
  const controller = createSetupController(ports(on, events, calls, {
    invoke: async (request, emit, signal) => {
      calls.requests.push(request); calls.signals.push(signal)
      if (request.action === 'inspect' && ++inspections === 2) await new Promise<void>(resolve => { release = resolve })
      stream(events(request), emit)
    },
  }))
  await controller.open(uiPort(views, closes))
  controller.dispatch({ type: 'begin-sign-in', provider: 'chatgpt' }); await flush()
  controller.dispatch({ type: 'choose-model', modelId: configuredModel.id })
  controller.dispatch({ type: 'save-only' }); await flush()
  controller.dispatch({ type: 'retry' }); await flush()
  calls.timers.find(timer => timer.delay === 15 * 60_000)!.callback()
  release(); await flush()
  expect(controller.view()).toMatchObject({ phase: 'error', message: 'Sign-in saved; configuration not changed. The setup handoff expired. Retry setup to start again.' })
  expect(calls.requests.map(request => request.action)).toEqual(['inspect', 'login', 'save', 'inspect'])
  controller.close()
})
