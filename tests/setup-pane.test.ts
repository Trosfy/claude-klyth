import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { renderSetupPane, type SetupPaneAction, type SetupPanePort, type SetupPaneView } from '../hooks/setup-pane'
import { world } from './world'

const paneProps = (bodyColumns: number) => ({ title: 'Klyth setup', isFocused: true, bodyColumns, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 24 }, view: {} })
const mount = ($: Engine, columns = 68) => $.ui.mount({ plugin: 'test', surface: 'terminal', component: 'Pane', requestId: 'setup-fixture', props: paneProps(columns), viewport: { columns: 200, rows: 40 } })
const connectView = (overrides: Partial<Extract<SetupPaneView, { phase: 'connect' }>> = {}): Extract<SetupPaneView, { phase: 'connect' }> => ({
  phase: 'connect', provider: 'openai-compatible', advancedExpanded: false, canContinue: true,
  providerLabel: 'OpenAI-compatible', baseUrl: 'https://api.example.com/v1', authMethod: 'api-key', ...overrides,
})
const modelView = (overrides: Partial<Extract<SetupPaneView, { phase: 'model' }>> = {}): Extract<SetupPaneView, { phase: 'model' }> => ({
  phase: 'model', providerLabel: 'ChatGPT', models: [{ id: 'openai/gpt-example', label: 'GPT example' }], manualEntry: false,
  changeDetails: ['Adds one provider and one model.'], detailsExpanded: false, canSave: true, ...overrides,
})

function renderOn($: Engine, on: On, getView: () => SetupPaneView, actions: SetupPaneAction[], closes: number[] = []) {
  on('ui.render', { component: 'Pane', requestId: 'setup-fixture' }, ($, e) => renderSetupPane({
    elements: $.ui.resolve(e) as SetupPanePort['elements'], dispatch: action => actions.push(action), close: () => { closes.push(1) },
  }, getView(), e.props.bodyColumns))
}

test('helper consent hides paths until requested and only emits install or continue actions', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const actions: SetupPaneAction[] = []
  let view: SetupPaneView = { phase: 'helper', status: 'needed', detailsExpanded: false, helperPath: '/home/person/.local/share/klyth/bin/klyth', optionalCommand: '/home/person/.local/bin/klyth' }
  renderOn($, on, () => view, actions)
  const ui = await mount($, 24)
  let content = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(content).not.toContain('/home/person')
  expect(await ui.find({ key: 'install-helper' })).toBeDefined()
  await ui.press({ key: 'helper-details' })
  view = { ...view, detailsExpanded: true }
  await ui.redraw()
  content = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(content).toContain('Helper location: /home/person/.local/share/klyth/bin/klyth')
  await ui.press({ key: 'install-helper' })
  view = { ...view, status: 'ready' }
  await ui.redraw()
  await ui.press({ key: 'continue-helper' })
  expect(actions).toEqual([{ type: 'toggle-helper-details' }, { type: 'install-helper' }, { type: 'continue-helper' }])
  expect(w.requests).toEqual([])
  expect(w.runs).toEqual([])
  await ui.unmount()
})

for (const width of [24, 40, 68]) test(`connection controls wrap at ${width} columns and expose only nonsecret fields`, { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const actions: SetupPaneAction[] = []
  const view = connectView()
  renderOn($, on, () => view, actions)
  const ui = await mount($, width)
  expect(await ui.find({ key: 'baseUrl' })).toBeDefined()
  expect(await ui.find({ key: 'providerLabel' })).toBeDefined()
  expect(await ui.find({ key: 'setup-auth-method' })).toBeDefined()
  expect(await ui.find({ key: 'apiKey' })).toBeUndefined()
  expect(await ui.find({ key: 'secret' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Box' })).some(item => item.props?.['flexDirection'] === 'row' && item.props?.['flexWrap'] === 'wrap')).toBe(true)
  await ui.select({ key: 'setup-provider', value: 'bedrock' })
  await ui.input({ key: 'baseUrl', text: 'https://bedrock.example.com/v1' })
  expect(actions).toContainEqual({ type: 'choose-provider', provider: 'bedrock' })
  expect(actions).toContainEqual({ type: 'update-field', field: 'baseUrl', value: 'https://bedrock.example.com/v1' })
  expect(w.requests).toEqual([])
  expect(w.runs).toEqual([])
  await ui.unmount()
})


test('Bedrock defaults to Converse and keeps its OpenAI protocol under Advanced', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const actions: SetupPaneAction[] = []
  let view = connectView({ provider: 'bedrock', region: 'us-east-1', protocol: 'bedrock-converse', advancedExpanded: false })
  renderOn($, on, () => view, actions)
  const ui = await mount($, 40)
  expect(await ui.find({ key: 'region' })).toBeDefined()
  expect(await ui.find({ key: 'request-protocol' })).toBeUndefined()
  await ui.press({ key: 'advanced' })
  view = { ...view, advancedExpanded: true }
  await ui.redraw()
  expect(await ui.find({ key: 'request-protocol' })).toBeDefined()
  await ui.select({ key: 'request-protocol', value: 'bedrock-openai' })
  expect(actions).toContainEqual({ type: 'set-protocol', protocol: 'bedrock-openai' })
  await ui.unmount()
})

test('HTTP use needs endpoint consent and advanced protocols stay provider-specific', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const actions: SetupPaneAction[] = []
  let view = connectView({ advancedExpanded: true, baseUrl: 'http://api.example.com/v1', allowHttp: false })
  renderOn($, on, () => view, actions)
  const ui = await mount($, 40)
  expect(await ui.find({ key: 'request-protocol' })).toBeDefined()
  expect(await ui.find({ key: 'continue-connection' })).toBeUndefined()
  await ui.select({ key: 'request-protocol', value: 'responses' })
  await ui.press({ key: 'http-consent' })
  expect(actions).toContainEqual({ type: 'set-protocol', protocol: 'responses' })
  expect(actions).toContainEqual({ type: 'set-allow-http', allowed: true })
  view = { ...view, allowHttp: true }
  await ui.redraw()
  expect(await ui.find({ key: 'continue-connection' })).toBeDefined()
  view = { ...view, provider: 'other-api', protocol: 'anthropic-messages' }
  await ui.redraw()
  await ui.select({ key: 'request-protocol', value: 'anthropic-messages' })
  expect(actions).toContainEqual({ type: 'set-protocol', protocol: 'anthropic-messages' })
  expect(w.requests).toEqual([])
  expect(w.runs).toEqual([])
  await ui.unmount()
})

test('credential helper choices require explicit helper and endpoint consent', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const actions: SetupPaneAction[] = []
  let view = connectView({ authMethod: 'existing-helper', canContinue: true, helperConsent: false, helperTargetLabel: 'api.example.com' })
  renderOn($, on, () => view, actions)
  const ui = await mount($, 40)
  expect(await ui.find({ key: 'credential-helper' })).toBeUndefined()
  expect(await ui.find({ key: 'continue-connection' })).toBeUndefined()
  view = { ...view, credentialHelpers: [{ id: 'keychain-openai', label: 'macOS Keychain' }] }
  await ui.redraw()
  await ui.select({ key: 'credential-helper', value: 'keychain-openai' })
  view = { ...view, selectedCredentialHelperId: 'keychain-openai' }
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('api.example.com only')
  expect(await ui.find({ key: 'continue-connection' })).toBeUndefined()
  await ui.press({ key: 'helper-consent' })
  expect(actions).toContainEqual({ type: 'choose-credential-helper', id: 'keychain-openai' })
  expect(actions).toContainEqual({ type: 'set-helper-consent', allowed: true })
  view = { ...view, helperConsent: true }
  await ui.redraw()
  expect(await ui.find({ key: 'continue-connection' })).toBeDefined()
  await ui.unmount()
})

test('existing provider path skips sign-in and lets setup continue to model selection', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const actions: SetupPaneAction[] = []
  let view: SetupPaneView = connectView({
    provider: 'chatgpt', existingProviders: [{ id: 'work-gateway', label: 'Work gateway' }], selectedExistingProviderId: 'work-gateway',
  })
  renderOn($, on, () => view, actions)
  const ui = await mount($, 40)
  const content = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(content).toContain('Work gateway is already configured')
  expect(content).toContain('Choose a model without signing in again.')
  expect(await ui.find({ key: 'existing-provider' })).toBeDefined()
  expect(await ui.find({ key: 'setup-auth-method' })).toBeUndefined()
  await ui.select({ key: 'existing-provider', value: 'work-gateway' })
  await ui.press({ key: 'choose-model' })
  expect(actions).toEqual([{ type: 'choose-existing-provider', id: 'work-gateway' }, { type: 'continue-connection' }])
  view = modelView({ providerLabel: 'ChatGPT', models: [{ id: 'existing/model', label: 'Existing model' }] })
  await ui.redraw()
  expect(await ui.find({ key: 'model-choice' })).toBeDefined()
  await ui.unmount()
})

test('browser waiting and transient device challenge expose actions without printing a URL', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const actions: SetupPaneAction[] = []
  let view: SetupPaneView = { phase: 'sign-in', provider: 'chatgpt', status: 'waiting' }
  renderOn($, on, () => view, actions)
  const ui = await mount($, 24)
  expect(await ui.find({ key: 'copy-sign-in-link' })).toBeDefined()
  await ui.press({ key: 'open-browser-again' })
  await ui.press({ key: 'copy-sign-in-link' })
  await ui.press({ key: 'cancel-auth' })
  view = { phase: 'sign-in', provider: 'chatgpt', status: 'device-challenge', userCode: 'ABCD-EFGH', expiresLabel: 'in 5 minutes' }
  await ui.redraw()
  let content = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(content).toContain('ABCD-EFGH')
  expect(content).toContain('Code expires in 5 minutes.')
  expect(content).not.toContain('https://')
  await ui.press({ key: 'open-device-verification' })
  await ui.press({ key: 'copy-sign-in-link' })
  await ui.press({ key: 'cancel-auth' })
  expect(actions).toEqual([
    { type: 'open-browser-again' }, { type: 'copy-sign-in-link' }, { type: 'cancel-auth' },
    { type: 'open-device-verification' }, { type: 'copy-sign-in-link' }, { type: 'cancel-auth' },
  ])
  await ui.unmount()
})

test('API-key flow displays the supplied terminal command, never creates a secret input, and continues by callback', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const actions: SetupPaneAction[] = []
  const command = '/opt/klyth/bin/klyth auth login api-key my-provider'
  renderOn($, on, () => ({ phase: 'api-key', providerLabel: 'My provider', terminalCommand: command, presence: 'unknown' }), actions)
  const ui = await mount($, 24)
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain(command)
  expect((await ui.findAll({ type: 'Input' })).length).toBe(0)
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Credential presence could not be checked.')
  await ui.press({ key: 'continue-api-key' })
  expect(actions).toEqual([{ type: 'continue-api-key' }])
  expect(w.requests).toEqual([])
  expect(w.runs).toEqual([])
  await ui.unmount()
})

test('model choice requests only missing limits and keeps alias details optional until expanded', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const actions: SetupPaneAction[] = []
  let view = modelView({ selectedModelId: undefined, contextWindow: '', maxOutputTokens: '', suggestedAlias: 'balanced', canSave: false, modelDiscovery: { endpointLabel: 'api.example.com', state: 'needs-consent' } })
  renderOn($, on, () => view, actions)
  const ui = await mount($, 40)
  expect(await ui.find({ key: 'fetch-models' })).toBeDefined()
  expect(w.requests).toEqual([])
  await ui.press({ key: 'fetch-models' })
  view = { ...view, modelDiscovery: { endpointLabel: 'api.example.com', state: 'loading' } }
  await ui.redraw()
  expect(actions).toContainEqual({ type: 'fetch-models' })
  expect(w.requests).toEqual([])
  view = { ...view, modelDiscovery: { endpointLabel: 'api.example.com', state: 'failed' } }
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('The model list could not be fetched. Enter a model ID or retry.')
  expect(await ui.find({ key: 'fetch-models' })).toBeDefined()
  await ui.press({ key: 'fetch-models' })
  view = { ...view, modelDiscovery: { endpointLabel: 'api.example.com', state: 'loading' } }
  await ui.redraw()
  expect(actions.filter(action => action.type === 'fetch-models')).toHaveLength(2)
  expect(await ui.find({ key: 'contextWindow' })).toBeDefined()
  expect(await ui.find({ key: 'maxOutputTokens' })).toBeDefined()
  expect(await ui.find({ key: 'alias' })).toBeUndefined()
  expect(await ui.find({ key: 'save-and-use' })).toBeUndefined()
  await ui.select({ key: 'model-choice', value: 'openai/gpt-example' })
  await ui.input({ key: 'contextWindow', text: '128000' })
  await ui.input({ key: 'maxOutputTokens', text: '8192' })
  await ui.press({ key: 'change-details' })
  view = { ...view, selectedModelId: 'openai/gpt-example', contextWindow: '128000', maxOutputTokens: '8192', detailsExpanded: true }
  await ui.redraw()
  expect(await ui.find({ key: 'alias' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Suggested alias: balanced')
  view = { ...view, canSave: true }
  await ui.redraw()
  await ui.press({ key: 'save-and-use' })
  await ui.press({ key: 'save-only' })
  expect(actions).toContainEqual({ type: 'choose-model', modelId: 'openai/gpt-example' })
  expect(actions).toContainEqual({ type: 'update-field', field: 'contextWindow', value: '128000' })
  expect(actions).toContainEqual({ type: 'update-field', field: 'maxOutputTokens', value: '8192' })
  expect(actions).toContainEqual({ type: 'save-and-use' })
  expect(actions).toContainEqual({ type: 'save-only' })
  await ui.unmount()
})

test('saving and result views distinguish save-only, active, disconnected, and unswitched outcomes', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const actions: SetupPaneAction[] = []
  let view: SetupPaneView = { phase: 'saving', mode: 'use' }
  renderOn($, on, () => view, actions)
  const ui = await mount($, 40)
  let content = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(content).toContain('No inference request is sent.')
  view = { phase: 'saving', mode: 'only' }
  await ui.redraw()
  content = (await ui.findAll({ type: 'Text' })).map(item => item.text).join('\n')
  expect(content).toContain('The current model will not be switched.')
  for (const status of ['configured', 'active', 'saved-not-connected', 'saved-not-switched'] as const) {
    view = { phase: 'result', status, recovery: { type: 'retry', label: 'Retry model switch' } }
    await ui.redraw()
    expect((await ui.findAll({ type: 'Button' })).filter(item => item.key !== 'close')).toHaveLength(1)
    await ui.press({ key: 'result-recovery' })
    expect(actions.at(-1)).toEqual({ type: 'retry' })
  }
  await ui.unmount()
})

test('errors expose exactly one recovery callback and close remains host-owned', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  const actions: SetupPaneAction[] = []
  const closes: number[] = []
  renderOn($, on, () => ({ phase: 'error', message: 'Configuration could not be saved.', recovery: { type: 'back', label: 'Back to model' } }), actions, closes)
  const ui = await mount($, 24)
  expect((await ui.findAll({ type: 'Button' })).filter(item => item.key !== 'close')).toHaveLength(1)
  await ui.press({ key: 'error-recovery' })
  await ui.press({ key: 'close' })
  expect(actions).toEqual([{ type: 'back' }])
  expect(closes).toEqual([1])
  await ui.unmount()
})

test('without an extra descriptor Advanced has no extra sign-in button and keeps the protocol select', async ($, on) => {
  world(on)
  const actions: SetupPaneAction[] = []
  renderOn($, on, () => connectView({ advancedExpanded: true }), actions)
  const ui = await mount($, 40)
  expect(await ui.find({ key: 'choose-extra' })).toBeUndefined()
  expect(await ui.find({ key: 'request-protocol' })).toBeDefined()
  await ui.unmount()
})
