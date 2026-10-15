import type { ExtraClient } from './extra-client'
import type { ExtraClientId } from './extras'
import { ALIAS_RE, parseConfig, RESERVED_ALIASES } from './config'
import type { Kind } from './kinds'
import type { SetupPaneAction, SetupPaneView, SetupProtocol, SetupProvider } from './setup-pane'
import { setupRequest } from './setup-protocol'
import type { SetupConnection, SetupEvent, SetupFailure, SetupModel, SetupProviderSummary, SetupRequest } from './setup-protocol'

const BEDROCK_REGIONS = new Set([
  'af-south-1', 'ap-east-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-south-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'il-central-1', 'me-central-1', 'me-south-1', 'mx-central-1',
  'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
])
const VALIDATION_AUTH = { command: ['/usr/bin/true'], ttlSeconds: 300 }

export function setupFailureMessage(failure: SetupFailure, extra?: ExtraClient): string {
  return ({
    'invalid-request': 'Setup could not prepare a valid request. Review the connection details and try again.',
    'invalid-config': 'The existing Klyth configuration is invalid. Fix it before continuing.',
    'config-conflict': 'The selected provider changed while setup was open. Review the updated configuration before saving.',
    'credential-conflict': 'The stored credential changed during sign-in. Return to setup and start a new sign-in if needed.',
    'keyring-unavailable': 'The system credential store is unavailable. Check it, then retry setup.',
    'auth-failed': 'Sign-in did not complete. Retry sign-in or go back to setup.',
    cancelled: 'Sign-in was cancelled. No configuration was changed.',
    'models-unavailable': 'The provider did not return a model list. Enter a model ID or request the list again.',
    'save-failed': 'The configuration save could not be confirmed. Check setup status before retrying.',
    'helper-failed': 'The setup helper did not finish. Check local setup status before retrying.',
    'handoff-failed': 'Sign-in saved; configuration not changed.',
    'policy-blocked': 'Managed policy blocks this connection. Choose an allowed endpoint or ask your administrator.',
    'extra-client-unavailable': extra?.failureText ?? 'The optional sign-in client is unavailable.',
  } as const)[failure]
}

export type SetupControllerUiPort = { redraw(view: SetupPaneView): void; closePane(): void }
export type SetupControllerPorts = {
  extraClient?: ExtraClient<ExtraClientId>
  helperReady(): boolean | Promise<boolean>
  installHelper(): Promise<void>
  invoke(request: SetupRequest, onEvent: (event: SetupEvent) => void, signal: AbortSignal): Promise<void>
  keyCommand(provider: string): string
  reopenBrowser(url: string): void | Promise<void>
  copySignInLink(url: string): Promise<boolean>
  reload(expectedTarget: string): boolean | Promise<boolean>
  useModel(target: string): boolean | Promise<boolean>
  now(): Promise<number>
  after(ms: number, callback: () => void): { cancel(): void }
}
export type SetupController = {
  view(): SetupPaneView
  open(port: SetupControllerUiPort): Promise<void>
  dispatch(action: SetupPaneAction): void
  close(): void
  stop(): void
}
export type SetupChallenge = { url: string; kind: 'browser' | 'device'; expiresAt: number; generation: number }
export type SetupCredential = { provider: string; client: 'official' | ExtraClientId; handle: string }
export type SetupOperation = { generation: number; abort: AbortController }
export type SetupRetryIntent = 'save' | 'inspect' | 'install' | 'login' | 'reopen' | 'presence' | 'models' | 'reload' | 'use' | 'restart-setup'
export type SetupOperationOutcome = {
  done: boolean; invalidAfterDone: boolean; rejected: boolean; cancelled: boolean; failure?: SetupFailure
  inspection?: Extract<SetupEvent, { type: 'inspection' }>; presence?: Extract<SetupEvent, { type: 'presence' }>['status']
  models?: SetupModel[]; savedTarget?: string; credentialHandle?: string
}

export type SetupDraft = {
  form: {
    provider: SetupProvider
    protocol?: SetupProtocol
    providerLabel: string
    baseUrl: string
    region: string
    authMethod: 'api-key' | 'none' | 'existing-helper'
    allowHttp: boolean
    selectedHelperId?: string
    helperConsent: boolean
    selectedExistingId?: string
    advancedExpanded: boolean
  }
  providers: SetupProviderSummary[]
  aliases: string[]
  connection?: SetupConnection
  existing?: SetupProviderSummary
  targetProvider: string
  providerLabel: string
  models: SetupModel[]
  selectedModel?: SetupModel
  manualEntry: boolean
  manualModelId: string
  contextValue: string
  outputValue: string
  aliasValue?: string
}

const defaults: Partial<Record<SetupProvider, string>> = {
  chatgpt: 'chatgpt', bedrock: 'bedrock', 'openai-compatible': 'openai-compatible', 'other-api': 'other-api',
}
export function emptySetupDraft(providers: SetupProviderSummary[] = [], aliases: string[] = []): SetupDraft {
  return {
    form: { provider: 'chatgpt', providerLabel: 'ChatGPT', baseUrl: '', region: '', authMethod: 'api-key', allowHttp: false, helperConsent: false, advancedExpanded: false },
    providers, aliases, targetProvider: '', providerLabel: '', models: [], manualEntry: true, manualModelId: '', contextValue: '', outputValue: '',
  }
}

export function setupProviderId(label: string | undefined, provider: SetupProvider, providers: readonly SetupProviderSummary[], extra?: ExtraClient): string {
  const slug = (label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/g, '')
  const base = !slug || slug === 'native' ? (provider === extra?.id ? extra.defaultProviderId : defaults[provider] ?? 'provider') : slug
  const used = new Set(providers.map(item => item.id))
  if (!used.has(base)) return base
  for (let suffix = 2; ; suffix++) {
    const tail = `-${suffix}`
    const candidate = `${base.slice(0, 32 - tail.length).replace(/-+$/g, '')}${tail}`
    if (!used.has(candidate)) return candidate
  }
}

export function bedrockEndpoint(region: string, protocol?: SetupProtocol): string | undefined {
  const value = region.trim().toLowerCase()
  if (!BEDROCK_REGIONS.has(value)) return undefined
  return `https://bedrock-runtime.${value}.amazonaws.com${protocol === 'bedrock-openai' ? '/openai/v1' : ''}`
}

export function setupKind(provider: SetupProvider, protocol: SetupProtocol | undefined, extra?: ExtraClient): Kind | undefined {
  if (provider === 'bedrock') return protocol === 'bedrock-openai' ? 'openai' : protocol === undefined || protocol === 'bedrock-converse' ? 'bedrock' : undefined
  if (provider === 'chatgpt' || provider === extra?.id) return 'openai'
  if (protocol === 'bedrock-openai' || protocol === 'bedrock-converse') return undefined
  if (protocol === 'responses') return 'openai-responses'
  if (protocol === 'anthropic-messages') return provider === 'other-api' ? 'anthropic' : undefined
  return 'openai'
}

function helperChoices(draft: SetupDraft): SetupProviderSummary[] {
  return draft.providers.filter(item => item.configuredAuth && (draft.form.provider !== 'bedrock' || item.kind === 'bedrock'))
}
function selectedExisting(draft: SetupDraft): SetupProviderSummary | undefined {
  return draft.providers.find(item => item.id === draft.form.selectedExistingId)
}
export function setupConnection(draft: SetupDraft): SetupConnection | undefined {
  const existing = selectedExisting(draft)
  if (existing !== undefined) return existingConnection(existing)
  const form = draft.form
  const { provider, protocol, region, baseUrl } = form
  const kind = setupKind(provider, protocol)
  const endpoint = provider === 'bedrock' ? bedrockEndpoint(region, protocol) : baseUrl.trim()
  if (kind === undefined || endpoint === undefined || endpoint === '') return undefined
  let auth: SetupConnection['auth']
  if (form.authMethod === 'none') auth = { kind: 'none' }
  else if (form.authMethod === 'existing-helper') {
    const source = helperChoices(draft).find(item => item.id === form.selectedHelperId)
    if (source === undefined || !form.helperConsent) return undefined
    auth = { kind: 'existing', provider: source.id, revision: source.revision }
  } else auth = { kind: 'keyring' }
  return { provider: setupProviderId(form.providerLabel, provider, draft.providers), kind, baseUrl: endpoint, allowHttp: form.allowHttp, auth }
}

export function setupEndpointLabel(value: string): string {
  try { const url = new URL(value); return `${url.host}${url.pathname}`.slice(0, 120) } catch { return 'selected endpoint' }
}
export function setupExpirationLabel(expiresAt: number, now: number): string {
  const left = Math.max(0, expiresAt - now)
  return left < 60_000 ? 'in under a minute' : `in ${Math.ceil(left / 60_000)} minutes`
}
export function challengeNotice(kind: 'browser' | 'device', action: 'open' | 'copy', success: boolean): string {
  if (!success) return action === 'copy' ? 'Could not copy the link. Try opening it again or cancel sign-in.' : kind === 'browser'
    ? 'Could not open the browser. Copy the sign-in link to another device. If needed, forward callback port 1455 over SSH. Never paste a callback into chat.'
    : 'Could not open verification. Copy the verification link to another device and enter the code shown here.'
  if (action === 'open') return kind === 'browser' ? 'Sign-in page opened. Finish there, or copy the link to another device.' : 'Verification page opened. Enter the code shown here.'
  return kind === 'browser' ? 'Sign-in link copied. Open it on another device. If needed, forward callback port 1455 over SSH. Never paste a callback into chat.' : 'Verification link copied. Open it on another device and enter the code shown here.'
}
export function signedInConnection(client: 'official' | ExtraClientId, id: string, baseUrl: string, handle: string): SetupConnection {
  return { provider: id, kind: 'openai-responses', baseUrl, allowHttp: false, auth: { kind: 'chatgpt', client, handle } }
}

export function connectionPane(draft: SetupDraft, extra?: ExtraClient<ExtraClientId>): Extract<SetupPaneView, { phase: 'connect' }> {
  const connection = setupConnection(draft)
  const available = helperChoices(draft)
  const canContinue = selectedExisting(draft) !== undefined || draft.form.provider === 'chatgpt' || draft.form.provider === extra?.id || (connection !== undefined && validConnection(connection))
  const target = connection === undefined ? undefined : setupEndpointLabel(connection.baseUrl)
  return {
    phase: 'connect', ...(extra ? { extraClient: { id: extra.id, label: extra.label } } : {}), provider: draft.form.provider, advancedExpanded: draft.form.advancedExpanded,
    existingProviders: draft.providers.map(item => ({ id: item.id, label: `${item.id} · ${item.kind}` })),
    selectedExistingProviderId: draft.form.selectedExistingId, canContinue, canGoBack: false,
    providerLabel: draft.form.providerLabel, baseUrl: draft.form.baseUrl, region: draft.form.region,
    authMethod: draft.form.authMethod, protocol: draft.form.protocol, allowHttp: draft.form.allowHttp,
    credentialHelpers: available.map(item => ({ id: item.id, label: `${item.id} · ${item.kind}` })),
    selectedCredentialHelperId: draft.form.selectedHelperId, helperConsent: draft.form.helperConsent, helperTargetLabel: target,
  }
}

export function applyConnectionAction(draft: SetupDraft, action: SetupPaneAction, extra?: ExtraClient): SetupDraft | undefined {
  const form = draft.form
  if (action.type === 'choose-provider') {
    if (!['chatgpt', 'bedrock', 'openai-compatible', 'other-api', extra?.id].includes(action.provider)) return undefined
    const label = action.provider === 'bedrock' ? 'Bedrock' : action.provider === 'other-api' ? 'Other API provider' : action.provider === 'openai-compatible' ? 'OpenAI-compatible' : action.provider === extra?.id ? extra.label : 'ChatGPT'
    return { ...draft, form: { provider: action.provider, providerLabel: label, baseUrl: action.provider === 'openai-compatible' ? 'https://api.openai.com/v1' : '', region: '', authMethod: 'api-key', allowHttp: false, helperConsent: false, advancedExpanded: false, ...(action.provider === 'bedrock' ? { protocol: 'bedrock-converse' as const } : {}) } }
  }
  if (action.type === 'choose-existing-provider' && draft.providers.some(item => item.id === action.id)) return { ...draft, form: { ...form, selectedExistingId: action.id } }
  if (action.type === 'toggle-advanced') return { ...draft, form: { ...form, advancedExpanded: !form.advancedExpanded } }
  if (action.type === 'set-auth-method') {
    if (action.method === 'none' && form.provider === 'bedrock') return undefined
    if (action.method === 'existing-helper' && helperChoices(draft).length === 0) return undefined
    return { ...draft, form: { ...form, authMethod: action.method, selectedHelperId: undefined, helperConsent: false } }
  }
  if (action.type === 'set-protocol') {
    const supported = form.provider === 'bedrock' ? ['bedrock-converse', 'bedrock-openai'] : form.provider === 'openai-compatible' ? ['chat-completions', 'responses'] : form.provider === 'other-api' ? ['chat-completions', 'responses', 'anthropic-messages'] : []
    if (!supported.includes(action.protocol)) return undefined
    return { ...draft, form: { ...form, protocol: action.protocol, helperConsent: false } }
  }
  if (action.type === 'set-allow-http' && /^http:\/\//i.test(form.baseUrl.trim())) return { ...draft, form: { ...form, allowHttp: action.allowed } }
  if (action.type === 'choose-credential-helper' && helperChoices(draft).some(item => item.id === action.id)) return { ...draft, form: { ...form, selectedHelperId: action.id, helperConsent: false } }
  if (action.type === 'set-helper-consent' && form.selectedHelperId && helperChoices(draft).some(item => item.id === form.selectedHelperId)) return { ...draft, form: { ...form, helperConsent: action.allowed } }
  return undefined
}

export function updateDraftField(draft: SetupDraft, action: Extract<SetupPaneAction, { type: 'update-field' }>, phase: 'connect' | 'model'): SetupDraft {
  if (phase === 'connect') {
    if (action.field === 'providerLabel') return { ...draft, form: { ...draft.form, providerLabel: action.value, selectedExistingId: undefined } }
    if (action.field === 'baseUrl') return { ...draft, form: { ...draft.form, baseUrl: action.value, allowHttp: false, helperConsent: false, selectedExistingId: undefined } }
    if (action.field === 'region') return { ...draft, form: { ...draft.form, region: action.value, helperConsent: false, selectedExistingId: undefined } }
    return draft
  }
  if (action.field === 'modelId') return { ...draft, manualEntry: true, manualModelId: action.value, selectedModel: undefined }
  if (action.field === 'contextWindow') return { ...draft, contextValue: action.value }
  if (action.field === 'maxOutputTokens') return { ...draft, outputValue: action.value }
  if (action.field === 'alias') return { ...draft, aliasValue: action.value }
  return draft
}

export function enterModel(draft: SetupDraft, connection: SetupConnection, label: string, models: SetupModel[], existing?: SetupProviderSummary): SetupDraft {
  return {
    ...draft, connection, targetProvider: connection.provider, providerLabel: label, existing, models,
    selectedModel: undefined, manualEntry: models.length === 0, manualModelId: '', contextValue: '', outputValue: '', aliasValue: undefined,
  }
}
export function selectDraftModel(draft: SetupDraft, id: string): SetupDraft {
  const model = draft.models.find(item => item.id === id)
  return model === undefined ? draft : {
    ...draft, selectedModel: model, manualEntry: false, manualModelId: '',
    contextValue: model.contextWindow === undefined ? '' : String(model.contextWindow),
    outputValue: model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens), aliasValue: undefined,
  }
}
export function toggleManualModel(draft: SetupDraft): SetupDraft {
  return { ...draft, manualEntry: !draft.manualEntry, selectedModel: undefined, manualModelId: '', contextValue: '', outputValue: '', aliasValue: undefined }
}

export function numericLimit(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
export function resolvedModel(model: SetupModel | undefined, id: string | undefined, contextWindow: string | undefined, maxOutputTokens: string | undefined): SetupModel | undefined {
  const modelId = model?.id ?? id?.trim()
  if (modelId === undefined || modelId === '') return undefined
  const context = model?.contextWindow ?? numericLimit(contextWindow)
  const output = model?.maxOutputTokens ?? numericLimit(maxOutputTokens)
  if (context === undefined || output === undefined) return undefined
  return { id: modelId, ...(model?.name === undefined ? {} : { name: model.name }), contextWindow: context, maxOutputTokens: output }
}
export function suggestedAlias(provider: string, model: string, aliases: readonly string[]): string | undefined {
  const occupied = new Set(aliases)
  const slug = `${provider}-${model}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/\.{2,}/g, '.').replace(/-+/g, '-').replace(/^[^a-z]+/, '').replace(/[-.]+$/g, '').slice(0, 64).replace(/[-.]+$/g, '')
  if (slug === '' || RESERVED_ALIASES.has(slug)) return undefined
  if (ALIAS_RE.test(slug) && !occupied.has(slug)) return slug
  for (let suffix = 2; ; suffix++) {
    const tail = `-${suffix}`
    const candidate = `${slug.slice(0, 64 - tail.length).replace(/[-.]+$/g, '')}${tail}`
    if (ALIAS_RE.test(candidate) && !RESERVED_ALIASES.has(candidate) && !occupied.has(candidate)) return candidate
  }
}

export function paneModel(
  draft: SetupDraft, canFetchModels: boolean, detailsExpanded = false,
  discoveryState: 'needs-consent' | 'ready' | 'loading' | 'failed' = 'needs-consent',
): Extract<SetupPaneView, { phase: 'model' }> {
  const model = draft.manualEntry ? undefined : draft.selectedModel
  const currentId = draft.manualEntry ? draft.manualModelId.trim() : model?.id
  const complete = resolvedModel(model, currentId, draft.contextValue, draft.outputValue)
  const alias = draft.aliasValue?.trim() || undefined
  const aliasValid = alias === undefined || !draft.aliases.includes(alias)
  const expectedRevision = draft.providers.find(item => item.id === draft.targetProvider)?.revision ?? null
  const canSave = draft.connection !== undefined && complete !== undefined && aliasValid && validSave(draft.connection, expectedRevision, complete, alias)
  const details = draft.connection === undefined || complete === undefined ? [] : changeSummary(draft.connection, complete, draft.existing, alias)
  if (alias !== undefined && !aliasValid) details.push('That alias is already in use. Choose another or leave it blank.')
  const suggested = complete === undefined ? undefined : suggestedAlias(draft.targetProvider, complete.id, draft.aliases)
  const endpoint = draft.connection === undefined ? 'selected provider' : setupEndpointLabel(draft.connection.baseUrl)
  return {
    phase: 'model', providerLabel: draft.providerLabel,
    models: draft.models.map(item => ({ id: item.id, ...(item.name === undefined ? {} : { label: item.name }) })),
    selectedModelId: model?.id, manualEntry: draft.manualEntry, manualModelId: draft.manualModelId,
    contextWindow: model?.contextWindow === undefined ? draft.contextValue : undefined,
    maxOutputTokens: model?.maxOutputTokens === undefined ? draft.outputValue : undefined,
    suggestedAlias: suggested, alias: draft.aliasValue, changeDetails: details, detailsExpanded, canSave,
    ...(canFetchModels ? { modelDiscovery: { endpointLabel: endpoint, state: discoveryState } } : {}), canGoBack: true,
  }
}

function configShape(connection: SetupConnection, model: SetupModel, alias?: string): string {
  const auth = connection.auth.kind === 'none' ? 'none' : VALIDATION_AUTH
  const provider = { kind: connection.kind, baseUrl: connection.baseUrl, allowHttp: connection.allowHttp, auth, models: { [model.id]: { contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens } } }
  const aliases = alias === undefined ? {} : { [alias]: { target: `${connection.provider}/${model.id}` } }
  return JSON.stringify({ providers: { [connection.provider]: provider }, aliases })
}
export function validConnection(connection: SetupConnection): boolean {
  if (setupRequest({ version: 1, action: 'models', connection }) === undefined) return false
  return parseConfig(configShape(connection, { id: 'setup-validation', contextWindow: 2, maxOutputTokens: 1 })).config !== undefined
}
export function validSave(connection: SetupConnection, expectedRevision: string | null, model: SetupModel, alias?: string): boolean {
  if (setupRequest({ version: 1, action: 'save', connection, expectedRevision, model, ...(alias === undefined ? {} : { alias }) }) === undefined) return false
  return parseConfig(configShape(connection, model, alias)).config !== undefined
}
export function existingConnection(provider: SetupProviderSummary): SetupConnection {
  return {
    provider: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, allowHttp: provider.allowHttp,
    auth: provider.configuredAuth ? { kind: 'existing', provider: provider.id, revision: provider.revision } : { kind: 'none' },
  }
}
function changeSummary(connection: SetupConnection, model: SetupModel, existing?: SetupProviderSummary, alias?: string): string[] {
  const details = existing === undefined ? [`Provider: ${connection.provider}`, `Endpoint: ${connection.baseUrl}`] : [`Provider: ${existing.id}`]
  if (!existing?.models.some(item => item.id === model.id)) details.push(`Model: ${model.id}`)
  if (alias !== undefined) details.push(`Alias: ${alias}`)
  return details
}
