import type { ExtraClientId } from './extras'
import type { Elements, RenderElement } from 'claude-code'

export const SETUP_PANE = 'klyth-setup'

export type SetupProvider = 'chatgpt' | 'bedrock' | 'openai-compatible' | 'other-api' | ExtraClientId
export type SetupAuthMethod = 'api-key' | 'none' | 'existing-helper'
export type SetupProtocol = 'chat-completions' | 'responses' | 'anthropic-messages' | 'bedrock-converse' | 'bedrock-openai'
export type SetupField = 'providerLabel' | 'region' | 'baseUrl' | 'modelId' | 'contextWindow' | 'maxOutputTokens' | 'alias'
/** Labels are sanitized display names; IDs are nonsensitive config identifiers. */
export type SetupExistingProvider = { id: string; label: string }
/** Only helpers already configured by the person may be listed here. */
export type SetupCredentialHelper = { id: string; label: string }

export type SetupPaneAction =
  | { type: 'install-helper' }
  | { type: 'continue-helper' }
  | { type: 'toggle-helper-details' }
  | { type: 'choose-provider'; provider: SetupProvider }
  | { type: 'choose-existing-provider'; id: string }
  | { type: 'toggle-advanced' }
  | { type: 'set-auth-method'; method: SetupAuthMethod }
  | { type: 'set-protocol'; protocol: SetupProtocol }
  | { type: 'set-allow-http'; allowed: boolean }
  | { type: 'choose-credential-helper'; id: string }
  | { type: 'set-helper-consent'; allowed: boolean }
  | { type: 'fetch-models' }
  | { type: 'update-field'; field: SetupField; value: string }
  | { type: 'continue-connection' }
  | { type: 'begin-sign-in'; provider: 'chatgpt' | ExtraClientId }
  | { type: 'open-browser-again' }
  | { type: 'copy-sign-in-link' }
  | { type: 'open-device-verification' }
  | { type: 'cancel-auth' }
  | { type: 'continue-api-key' }
  | { type: 'choose-model'; modelId: string }
  | { type: 'toggle-manual-model' }
  | { type: 'toggle-change-details' }
  | { type: 'save-and-use' }
  | { type: 'save-only' }
  | { type: 'retry' }
  | { type: 'back' }

export type SetupModelOption = { id: string; label?: string }
export type SetupPaneView =
  | {
      phase: 'helper'
      status: 'needed' | 'installing' | 'ready'
      detailsExpanded: boolean
      helperPath?: string
      optionalCommand?: string
    }
  | {
      phase: 'connect'
      provider: SetupProvider
      extraClient?: { id: ExtraClientId; label: string }
      advancedExpanded: boolean
      existingProviders?: readonly SetupExistingProvider[]
      selectedExistingProviderId?: string
      canContinue: boolean
      canGoBack?: boolean
      providerLabel?: string
      baseUrl?: string
      region?: string
      authMethod?: SetupAuthMethod
      protocol?: SetupProtocol
      allowHttp?: boolean
      credentialHelpers?: readonly SetupCredentialHelper[]
      selectedCredentialHelperId?: string
      helperConsent?: boolean
      helperTargetLabel?: string
    }
  | {
      phase: 'sign-in'
      provider: 'chatgpt' | ExtraClientId
      label?: string
      status: 'ready' | 'waiting' | 'device-challenge'
      userCode?: string
      expiresLabel?: string
      notice?: string
    }
  | {
      phase: 'api-key'
      providerLabel: string
      terminalCommand: string
      presence: 'unknown' | 'present' | 'absent'
      canGoBack?: boolean
    }
  | {
      phase: 'model'
      providerLabel: string
      models: readonly SetupModelOption[]
      selectedModelId?: string
      manualEntry: boolean
      manualModelId?: string
      contextWindow?: string
      maxOutputTokens?: string
      suggestedAlias?: string
      alias?: string
      changeDetails: readonly string[]
      detailsExpanded: boolean
      canSave: boolean
      modelDiscovery?: { endpointLabel: string; state: 'needs-consent' | 'ready' | 'loading' | 'failed' }
      canGoBack?: boolean
    }
  | { phase: 'saving'; mode: 'use' | 'only' }
  | {
      phase: 'result'
      status: 'configured' | 'active' | 'saved-not-connected' | 'saved-not-switched'
      recovery?: { type: 'retry' | 'back'; label: string }
    }
  | {
      phase: 'error'
      message: string
      recovery: { type: 'retry' | 'back'; label: string }
    }

export type SetupPanePort = {
  elements: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Select' | 'Input'>
  dispatch(action: SetupPaneAction): void
  close(): void
}

const PROVIDERS: readonly { value: SetupProvider; label: string }[] = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'bedrock', label: 'Amazon Bedrock' },
  { value: 'openai-compatible', label: 'OpenAI-compatible endpoint' },
  { value: 'other-api', label: 'Other API provider' },
]
const CONTROL = /[\x00-\x1f\x7f-\x9f\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}\u{2066}-\u{2069}]/gu

function withoutTerminalControls(value: string): string {
  return value.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '').replace(CONTROL, '')
}

function display(value: string, limit = 220): string {
  const clean = withoutTerminalControls(value).replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : clean
}

export function renderSetupPane(io: SetupPanePort, view: SetupPaneView, bodyColumns: number): RenderElement {
  const { Box, Text, Button, Select, Input } = io.elements
  const text = (value: string, dimColor = false) => Text({ children: display(value), dimColor, wrap: 'wrap' })
  const button = (key: string, label: string, action: SetupPaneAction, variant?: 'primary' | 'secondary', hotkey?: string) => Button({
    key, label: display(label, 100), onPress: () => io.dispatch(action), ...(variant === undefined ? {} : { variant }), ...(hotkey === undefined ? {} : { hotkey }),
  })
  const row = (children: RenderElement[]) => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: bodyColumns >= 68 ? 2 : 1, rowGap: 1, children })
  const stack = (children: RenderElement[]) => Box({ flexDirection: 'column', gap: 1, children })
  const fieldInput = (field: SetupField, label: string, value: string | undefined, placeholder?: string) => {
    const update = (next: string) => io.dispatch({ type: 'update-field', field, value: next })
    return Input({
      key: field, label, value: value === undefined ? undefined : withoutTerminalControls(value), placeholder: placeholder === undefined ? undefined : display(placeholder, 100),
      onInput: update, onSubmit: update,
    })
  }
  const close = Button({ key: 'close', label: 'Close', role: 'dismiss', variant: 'secondary', onPress: io.close })
  const footer = (extra: RenderElement[] = []) => stack([row([...extra, close]), text('Esc to close', true)])
  const heading = Text({ bold: true, children: 'Klyth setup' })
  let content: RenderElement[] = []

  if (view.phase === 'helper') {
    content.push(text(view.status === 'needed' ? 'The matching Klyth helper is needed to continue.' : view.status === 'installing' ? 'Installing the Klyth helper…' : 'Klyth helper is ready.'))
    if (view.status === 'needed') content.push(button('install-helper', 'Install helper', { type: 'install-helper' }, 'primary', 'i'))
    if (view.status === 'ready') content.push(button('continue-helper', 'Continue setup', { type: 'continue-helper' }, 'primary', 'c'))
    if (view.status !== 'installing') {
      content.push(button('helper-details', `${view.detailsExpanded ? 'Hide' : 'Show'} install details`, { type: 'toggle-helper-details' }, 'secondary'))
      if (view.detailsExpanded) {
        if (view.helperPath) content.push(text(`Helper location: ${view.helperPath}`, true))
        if (view.optionalCommand) content.push(text(`Optional command: ${view.optionalCommand}`, true))
      }
    }
  } else if (view.phase === 'connect') {
    content.push(text('Choose a provider. Existing connections stay ready; setup does not test a model.'))
    content.push(Select({
      key: 'setup-provider', label: 'Connect with', options: PROVIDERS, value: view.extraClient?.id === view.provider ? undefined : view.provider,
      onSelect: value => {
        if (PROVIDERS.some(provider => provider.value === value)) io.dispatch({ type: 'choose-provider', provider: value as SetupProvider })
      },
    }))
    const existingProviders = view.existingProviders ?? []
    if (existingProviders.length > 0) content.push(Select({
      key: 'existing-provider', label: 'Use existing provider',
      options: existingProviders.map(provider => ({ value: provider.id, label: display(provider.label || provider.id, 100) })),
      value: view.selectedExistingProviderId,
      onSelect: id => { if (existingProviders.some(provider => provider.id === id)) io.dispatch({ type: 'choose-existing-provider', id }) },
    }))
    content.push(button('advanced', `${view.advancedExpanded || view.extraClient?.id === view.provider ? 'Hide' : 'Show'} advanced options`, { type: 'toggle-advanced' }, 'secondary'))
    if (view.advancedExpanded || view.extraClient?.id === view.provider) {
      if (view.extraClient) content.push(button('choose-extra', view.extraClient.label, { type: 'choose-provider', provider: view.extraClient.id }, 'secondary'))
      const protocols: readonly { value: SetupProtocol; label: string }[] | undefined = view.provider === 'bedrock'
        ? [{ value: 'bedrock-converse', label: 'Bedrock Converse' }, { value: 'bedrock-openai', label: 'Bedrock OpenAI Chat Completions' }]
        : view.provider === 'other-api'
          ? [{ value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]
          : view.provider === 'openai-compatible'
            ? [{ value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }]
            : undefined
      if (protocols !== undefined) content.push(Select({
        key: 'request-protocol', label: 'Request protocol (advanced)', options: protocols,
        value: view.protocol ?? (view.provider === 'bedrock' ? 'bedrock-converse' : 'chat-completions'),
        onSelect: value => { if (protocols.some(protocol => protocol.value === value)) io.dispatch({ type: 'set-protocol', protocol: value as SetupProtocol }) },
      }))
    }
    const existing = existingProviders.find(provider => provider.id === view.selectedExistingProviderId)
    if (existing) {
      content.push(text(`${display(existing.label || existing.id, 100)} is already configured. Choose a model without signing in again.`))
      if (view.canContinue) content.push(button('choose-model', 'Choose model', { type: 'continue-connection' }, 'primary', 'c'))
    } else if (view.provider === 'chatgpt' || view.extraClient?.id === view.provider) {
      content.push(text(view.provider === 'chatgpt' ? 'Sign in opens ChatGPT in your browser.' : 'This client uses its separate device sign-in flow.', true))
      if (view.canContinue) content.push(button('sign-in', `Sign in with ${view.provider === 'chatgpt' ? 'ChatGPT' : (view.extraClient?.label ?? 'extra client')}`, { type: 'begin-sign-in', provider: view.provider }, 'primary', 's'))
    } else {
      if (view.provider !== 'bedrock') {
        content.push(fieldInput('providerLabel', 'Provider label (optional)', view.providerLabel, view.provider === 'openai-compatible' ? 'OpenAI-compatible' : 'Other API provider'))
        content.push(fieldInput('baseUrl', 'Base URL', view.baseUrl, 'https://api.example.com/v1'))
        content.push(text('Use an HTTPS endpoint. URL credentials and query secrets are not accepted.', true))
      } else {
        content.push(fieldInput('region', 'AWS region', view.region, 'us-east-1'))
      }
      const helpers = view.credentialHelpers ?? []
      const methods: readonly { value: SetupAuthMethod; label: string }[] = [
        { value: 'api-key', label: 'API key entered in terminal' },
        ...(view.provider === 'bedrock' ? [] : [{ value: 'none' as const, label: 'No authentication' }]),
        ...(helpers.length > 0 ? [{ value: 'existing-helper' as const, label: view.provider === 'bedrock' ? 'Existing bearer helper' : 'Existing credential helper' }] : []),
      ]
      content.push(Select({
        key: 'setup-auth-method', label: 'Authentication', options: methods, value: methods.some(method => method.value === view.authMethod) ? view.authMethod : undefined,
        onSelect: value => { if (methods.some(method => method.value === value)) io.dispatch({ type: 'set-auth-method', method: value as SetupAuthMethod }) },
      }))
      let helperReady = view.authMethod !== 'existing-helper'
      if (view.authMethod === 'existing-helper') {
        if (helpers.length > 0) {
          content.push(Select({
            key: 'credential-helper', label: 'Credential helper', options: helpers.map(helper => ({ value: helper.id, label: display(helper.label, 100) })), value: view.selectedCredentialHelperId,
            onSelect: id => { if (helpers.some(helper => helper.id === id)) io.dispatch({ type: 'choose-credential-helper', id }) },
          }))
        }
        if (view.selectedCredentialHelperId && helpers.some(helper => helper.id === view.selectedCredentialHelperId)) {
          const target = display(view.helperTargetLabel || 'this provider endpoint', 100)
          content.push(text(`This helper will be used for ${target} only. Approve before it runs.`, true))
          content.push(button('helper-consent', view.helperConsent ? 'Remove helper consent' : 'Allow helper for this endpoint', { type: 'set-helper-consent', allowed: !view.helperConsent }, 'secondary'))
        } else {
          content.push(text(helpers.length > 0 ? 'Choose a configured helper before continuing.' : 'No configured credential helper is available.', true))
        }
        helperReady = Boolean(view.selectedCredentialHelperId && view.helperConsent && helpers.some(helper => helper.id === view.selectedCredentialHelperId))
      }
      const insecureHttp = view.provider !== 'bedrock' && /^http:\/\//i.test(view.baseUrl?.trim() ?? '')
      if (insecureHttp) {
        content.push(text('This endpoint uses unencrypted HTTP. Only allow it on a network you trust.', true))
        content.push(button('http-consent', view.allowHttp ? 'Remove HTTP consent' : 'Allow HTTP for this endpoint', { type: 'set-allow-http', allowed: !view.allowHttp }, 'secondary'))
      }
      content.push(text('API keys are entered in your terminal, never in this pane.', true))
      const canContinue = view.canContinue && helperReady && (!insecureHttp || view.allowHttp === true)
      if (canContinue) content.push(button('continue-connection', 'Continue', { type: 'continue-connection' }, 'primary', 'c'))
      else content.push(text(view.provider === 'bedrock' ? 'Enter a region and choose an authentication method to continue.' : 'Complete the connection details and any endpoint consent to continue.', true))
    }
    if (view.canGoBack) content.push(button('back', 'Back', { type: 'back' }, 'secondary'))
  } else if (view.phase === 'sign-in') {
    const { label } = view // read before the provider check, which leaves `view` as never in a build with no extra client
    const providerName = view.provider === 'chatgpt' ? 'ChatGPT' : (label ?? 'extra client')
    content.push(Text({ bold: true, children: `Sign in with ${providerName}` }))
    if (view.status === 'ready') {
      content.push(text('Klyth will open the browser and keep sign-in data out of chat.'))
      content.push(button('begin-sign-in', `Sign in with ${providerName}`, { type: 'begin-sign-in', provider: view.provider }, 'primary', 's'))
    } else if (view.status === 'waiting') {
      content.push(text(view.notice ?? 'Waiting for browser sign-in. Finish there, or reopen the sign-in page.'))
      content.push(button('open-browser-again', 'Open browser again', { type: 'open-browser-again' }, 'primary', 'o'))
      content.push(button('copy-sign-in-link', 'Copy sign-in link', { type: 'copy-sign-in-link' }, 'secondary'))
      content.push(button('cancel-auth', 'Cancel sign-in', { type: 'cancel-auth' }, 'secondary'))
    } else {
      content.push(text(view.notice ?? 'Enter this temporary code on the verification page. It stays in this pane only.'))
      if (view.userCode) content.push(Text({ bold: true, children: display(view.userCode, 80) }))
      if (view.expiresLabel) content.push(text(`Code expires ${view.expiresLabel}.`, true))
      content.push(button('open-device-verification', 'Open verification page', { type: 'open-device-verification' }, 'primary', 'o'))
      content.push(button('copy-sign-in-link', 'Copy verification link', { type: 'copy-sign-in-link' }, 'secondary'))
      content.push(button('cancel-auth', 'Cancel sign-in', { type: 'cancel-auth' }, 'secondary'))
    }
  } else if (view.phase === 'api-key') {
    content.push(text(`${display(view.providerLabel, 100)} needs a key in your terminal.`))
    content.push(text('Run this command there. It opens a hidden prompt; never paste a key into this pane.'))
    content.push(Text({ wrap: 'wrap', children: withoutTerminalControls(view.terminalCommand) }))
    content.push(text(view.presence === 'present' ? 'Credential entry is present but has not been tested.' : view.presence === 'absent' ? 'No credential is recorded yet.' : 'Credential presence could not be checked. Continue after the terminal command succeeds.', true))
    content.push(button('continue-api-key', 'Continue', { type: 'continue-api-key' }, 'primary', 'c'))
    if (view.canGoBack) content.push(button('back', 'Back', { type: 'back' }, 'secondary'))
  } else if (view.phase === 'model') {
    content.push(text(`Choose a model for ${display(view.providerLabel, 100)}.`))
    const showManual = view.manualEntry || view.models.length === 0
    const options = view.models.map(model => ({ value: model.id, label: display(model.label ?? model.id, 140) }))
    if (!showManual && options.length > 0) {
      content.push(Select({
        key: 'model-choice', label: 'Model', options, value: view.selectedModelId,
        onSelect: modelId => io.dispatch({ type: 'choose-model', modelId }),
      }))
      content.push(button('manual-model', 'Enter model ID manually', { type: 'toggle-manual-model' }, 'secondary'))
    } else {
      if (view.models.length === 0) content.push(text('No model list is available. Enter a model ID.'))
      content.push(fieldInput('modelId', 'Model ID', view.manualModelId))
      if (options.length > 0) content.push(button('available-models', 'Choose from available models', { type: 'toggle-manual-model' }, 'secondary'))
    }
    if (view.modelDiscovery) {
      if (view.modelDiscovery.state === 'loading') content.push(text('Fetching model list…', true))
      else {
        const endpoint = display(view.modelDiscovery.endpointLabel, 100)
        if (view.modelDiscovery.state === 'failed') content.push(text('The model list could not be fetched. Enter a model ID or retry.', true))
        else content.push(text(`Optional metadata request to ${endpoint}; this does not test inference.`, true))
        const label = view.modelDiscovery.state === 'needs-consent' ? 'Fetch models' : view.modelDiscovery.state === 'failed' ? 'Retry model list' : 'Refresh model list'
        content.push(button('fetch-models', label, { type: 'fetch-models' }, 'secondary'))
      }
    }
    if (view.contextWindow !== undefined) content.push(fieldInput('contextWindow', 'Context window (tokens)', view.contextWindow, 'Required by provider configuration'))
    if (view.maxOutputTokens !== undefined) content.push(fieldInput('maxOutputTokens', 'Maximum output tokens', view.maxOutputTokens, 'Required by provider configuration'))
    if (view.changeDetails.length > 0 || view.suggestedAlias) {
      content.push(button('change-details', `${view.detailsExpanded ? 'Hide' : 'Show'} configuration details`, { type: 'toggle-change-details' }, 'secondary'))
      if (view.detailsExpanded) {
        for (const detail of view.changeDetails) content.push(text(detail, true))
        if (view.suggestedAlias) {
          content.push(text(`Suggested alias: ${display(view.suggestedAlias, 80)}`, true))
          content.push(fieldInput('alias', 'Optional alias', view.alias, view.suggestedAlias))
        }
      }
    }
    if (view.canSave) {
      content.push(row([
        button('save-and-use', 'Save and use model', { type: 'save-and-use' }, 'primary', 's'),
        button('save-only', 'Save only', { type: 'save-only' }, 'secondary'),
      ]))
    } else {
      content.push(text('Choose a model and complete any required limits before saving.', true))
    }
    if (view.canGoBack) content.push(button('back', 'Back', { type: 'back' }, 'secondary'))
  } else if (view.phase === 'saving') {
    content.push(Text({ bold: true, children: view.mode === 'use' ? 'Saving and preparing to use the model…' : 'Saving configuration…' }))
    content.push(text(view.mode === 'use' ? 'The host handles any model-switch approval. No inference request is sent.' : 'The current model will not be switched.', true))
  } else if (view.phase === 'result') {
    const messages = {
      configured: 'Configuration saved. The model is ready to use.',
      active: 'Configuration saved and the model is active.',
      'saved-not-connected': 'Saved; provider is not connected yet.',
      'saved-not-switched': 'Saved; model not switched. Your configuration remains available.',
    } as const
    content.push(Text({ bold: true, children: messages[view.status] }))
    if (view.recovery) content.push(button('result-recovery', view.recovery.label, { type: view.recovery.type }, view.recovery.type === 'retry' ? 'primary' : 'secondary'))
  } else {
    content.push(Text({ bold: true, children: 'Setup needs attention' }))
    content.push(text(view.message))
    content.push(button('error-recovery', view.recovery.label, { type: view.recovery.type }, 'primary', view.recovery.type === 'retry' ? 'r' : 'b'))
  }

  return stack([heading, ...content, footer()])
}
