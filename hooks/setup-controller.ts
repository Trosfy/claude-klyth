import { OFFICIAL_PROFILE } from '../scripts/chatgpt-profiles'
import type { SetupPaneAction, SetupPaneView } from './setup-pane'
import type { ExtraClientId } from './extras'
import { applyConnectionAction, challengeNotice, connectionPane, emptySetupDraft, enterModel, paneModel, resolvedModel, selectDraftModel, setupConnection, setupEndpointLabel, setupExpirationLabel, setupFailureMessage, setupProviderId, signedInConnection, updateDraftField, validConnection, validSave, toggleManualModel, type SetupChallenge as Challenge, type SetupController, type SetupControllerPorts, type SetupControllerUiPort, type SetupCredential as Credential, type SetupDraft, type SetupOperation as Operation, type SetupOperationOutcome as Outcome, type SetupRetryIntent as RetryIntent } from './setup-draft'
export type { SetupController, SetupControllerPorts, SetupControllerUiPort } from './setup-draft'
import { setupRequest } from './setup-protocol'
import type { SetupConnection, SetupEvent, SetupModel, SetupProviderSummary, SetupRequest } from './setup-protocol'

const exactPartialSuccess = 'Sign-in saved; configuration not changed.'

export function createSetupController(io: SetupControllerPorts): SetupController {
  let pane: SetupPaneView = { phase: 'helper', status: 'needed', detailsExpanded: false }
  let draft: SetupDraft = emptySetupDraft()
  let ui: SetupControllerUiPort | undefined
  let operation: Operation | undefined
  let operationId = 0, lifecycle = 0
  let installing = false, postSaveBusy = false, stopped = false
  let challenge: Challenge | undefined
  let challengeTimer: { cancel(): void } | undefined
  let handoffTimer: { cancel(): void } | undefined
  let pendingCredential: Credential | undefined
  let credentialSaved = false
  let loginProvider: 'chatgpt' | ExtraClientId = 'chatgpt'
  let keyCommand = ''
  let retryIntent: RetryIntent | undefined
  let savedTarget: string | undefined
  let savedMode: 'use' | 'only' = 'only'

  const redraw = () => { try { ui?.redraw(pane) } catch { /* A closing native surface cannot stop cleanup. */ } }
  const show = (view: SetupPaneView) => { pane = view.phase === 'sign-in' ? { ...view, label: view.provider === 'chatgpt' ? 'ChatGPT' : io.extraClient?.label } : view; redraw() }
  const clearChallenge = () => { challengeTimer?.cancel(); challengeTimer = undefined; challenge = undefined }
  const clearHandoff = () => { handoffTimer?.cancel(); handoffTimer = undefined; pendingCredential = undefined }
  const cancelOperation = () => { operationId++; operation?.abort.abort(); operation = undefined }
  const reportError = (message: string, intent: RetryIntent, label: string, type: 'retry' | 'back' = 'retry') => {
    retryIntent = intent; show({ phase: 'error', message, recovery: { type, label } })
  }
  const operationStart = (): Operation | undefined => {
    if (stopped || operation !== undefined) return undefined
    operation = { generation: ++operationId, abort: new AbortController() }
    return operation
  }
  const invoke = async (request: SetupRequest, onEvent: (event: SetupEvent, outcome: Outcome) => void = () => {}): Promise<Outcome> => {
    const checked = setupRequest(request)
    if (!checked) return { done: false, invalidAfterDone: false, rejected: false, cancelled: false, failure: 'invalid-request' }
    const current = operationStart()
    if (!current) return { done: false, invalidAfterDone: false, rejected: true, cancelled: false, failure: 'helper-failed' }
    const result: Outcome = { done: false, invalidAfterDone: false, rejected: false, cancelled: false }
    const accept = (event: SetupEvent) => {
      if (operation !== current || current.generation !== operationId || current.abort.signal.aborted) return
      if (result.done) { result.invalidAfterDone = true; return }
      if (event.type === 'done') { result.done = true; return }
      if (event.type === 'failed') result.failure = event.code
      else if (event.type === 'inspection') result.inspection = event
      else if (event.type === 'presence') result.presence = event.status
      else if (event.type === 'models') result.models = event.models
      else if (event.type === 'saved') result.savedTarget = event.target
      else if (event.type === 'credentials-saved') result.credentialHandle = event.handle
      onEvent(event, result)
    }
    try { await io.invoke(checked, accept, current.abort.signal) } catch { result.rejected = true }
    result.cancelled = operation !== current || current.generation !== operationId || current.abort.signal.aborted
    if (operation === current) operation = undefined
    return result
  }

  const inspect = async (preserveDraft = false): Promise<void> => {
    if (operation !== undefined || stopped) return
    const credential = pendingCredential
    retryIntent = preserveDraft ? 'save' : 'inspect'
    const result = await invoke({ version: 1, action: 'inspect' }, event => {
      if (event.type === 'inspection') draft = preserveDraft ? { ...draft, providers: event.providers, aliases: event.aliases } : emptySetupDraft(event.providers, event.aliases)
    })
    if (stopped || ui === undefined || result.cancelled || preserveDraft && pendingCredential !== credential) return
    if (result.rejected || !result.done || result.invalidAfterDone || result.failure || !result.inspection) {
      reportError(result.failure ? setupFailureMessage(result.failure, io.extraClient) : 'Could not confirm the local configuration. Retry setup to inspect it again.', preserveDraft ? 'save' : 'inspect', 'Retry inspect')
      return
    }
    retryIntent = undefined
    if (preserveDraft) showModel(true); else show(connectionPane(draft, io.extraClient))
  }

  const checkHelper = async (epoch: number): Promise<void> => {
    let ready = false
    try { ready = await io.helperReady() } catch { ready = false }
    if (epoch !== lifecycle || stopped || ui === undefined) return
    if (!ready) { show({ phase: 'helper', status: 'needed', detailsExpanded: false }); return }
    show({ phase: 'helper', status: 'ready', detailsExpanded: false })
    await inspect()
  }
  const installHelper = async (): Promise<void> => {
    if (installing || operation !== undefined || stopped) return
    installing = true
    const epoch = lifecycle
    retryIntent = 'install'
    show({ phase: 'helper', status: 'installing', detailsExpanded: false })
    try {
      await io.installHelper()
      if (epoch !== lifecycle || stopped || ui === undefined) return
      if (!await io.helperReady()) { reportError('The helper is not ready yet. Retry the install or go back.', 'install', 'Retry install'); return }
      if (epoch !== lifecycle || stopped || ui === undefined) return
      show({ phase: 'helper', status: 'ready', detailsExpanded: false })
    } catch {
      if (epoch === lifecycle && !stopped && ui !== undefined) reportError('The helper could not be installed. Check local setup status, then retry.', 'install', 'Retry install')
      return
    } finally { installing = false }
    await inspect()
  }

  const canFetchModels = () => draft.connection !== undefined && (draft.existing === undefined) &&
    (draft.connection.auth.kind !== 'existing' || draft.form.helperConsent)
  const showModel = (detailsExpanded = false, discoveryState: 'needs-consent' | 'ready' | 'loading' | 'failed' = 'needs-consent') =>
    show(paneModel(draft, canFetchModels(), detailsExpanded, discoveryState))
  const stageModel = (connection: SetupConnection, label: string, models: SetupModel[], existing?: SetupProviderSummary) => {
    draft = enterModel(draft, connection, label, models, existing)
    showModel()
  }
  const setCredential = (provider: string, client: 'official' | ExtraClientId, handle: string) => {
    pendingCredential = { provider, client, handle }
    credentialSaved = true
    handoffTimer?.cancel()
    const record = pendingCredential
    handoffTimer = io.after(15 * 60_000, () => {
      if (pendingCredential !== record) return
      clearHandoff()
      reportError(`${exactPartialSuccess} The setup handoff expired. Retry setup to start again.`, 'restart-setup', 'Retry setup')
    })
  }
  const expireChallenge = (generation: number) => {
    if (challenge?.generation !== generation) return
    clearChallenge(); cancelOperation()
    reportError('The sign-in request expired. Start a new sign-in to continue.', 'login', 'Start new sign-in')
  }
  const challengeAction = async (action: 'open' | 'copy') => {
    const current = challenge
    if (!current) return
    let now: number
    try { now = await io.now() } catch { expireChallenge(current.generation); return }
    if (challenge !== current) return
    if (current.expiresAt <= now) { expireChallenge(current.generation); return }
    retryIntent = action === 'open' ? 'reopen' : 'login'
    let success = false
    try { success = action === 'open' ? (await io.reopenBrowser(current.url), true) : await io.copySignInLink(current.url) } catch {}
    if (challenge === current && pane.phase === 'sign-in') show({ ...pane, notice: challengeNotice(current.kind, action, success) })
  }
  const startLogin = async (provider: 'chatgpt' | ExtraClientId): Promise<void> => {
    loginProvider = provider
    const client = provider === 'chatgpt' ? 'official' : io.extraClient?.id
    if (client === undefined) return
    const id = setupProviderId(undefined, provider, draft.providers, io.extraClient)
    credentialSaved = false; clearChallenge(); clearHandoff()
    retryIntent = 'login'
    show({ phase: 'sign-in', provider, label: io.extraClient?.label, status: 'waiting' })
    const result = await invoke({ version: 1, action: 'login', provider: id, client }, (event, outcome) => {
      if (event.type === 'browser-challenge' || event.type === 'device-challenge') {
        const generation = operationId
        const isDevice = event.type === 'device-challenge'
        const current: Challenge = { url: isDevice ? event.verificationUrl : event.authorizeUrl, kind: isDevice ? 'device' : 'browser', expiresAt: event.expiresAt, generation }
        challenge = current
        challengeTimer?.cancel()
        void challengeAction('open')
        show(isDevice
          ? { phase: 'sign-in', provider, label: io.extraClient?.label, status: 'device-challenge', userCode: event.userCode }
          : { phase: 'sign-in', provider, label: io.extraClient?.label, status: 'waiting' })
        void io.now().then(now => {
          if (challenge?.generation !== generation) return
          if (event.expiresAt <= now) { expireChallenge(generation); return }
          challengeTimer = io.after(event.expiresAt - now, () => expireChallenge(generation))
          if (isDevice && pane.phase === 'sign-in' && pane.status === 'device-challenge') {
            show({ ...pane, expiresLabel: setupExpirationLabel(event.expiresAt, now) })
          }
        }).catch(() => expireChallenge(generation))
      } else if (event.type === 'credentials-saved') {
        setCredential(id, client, event.handle)
        clearChallenge()
      }
    })
    if (stopped || ui === undefined || result.cancelled) return
    const handle = result.credentialHandle
    if (result.failure === 'handoff-failed') {
      clearChallenge(); clearHandoff()
      reportError(exactPartialSuccess, 'restart-setup', 'Retry setup')
      return
    }
    if (result.failure === 'models-unavailable' && handle !== undefined && result.done && !result.invalidAfterDone && !result.rejected) {
      const connection = signedInConnection(client, id, provider === 'chatgpt' ? OFFICIAL_PROFILE.resource : io.extraClient!.baseUrl, handle)
      stageModel(connection, provider === 'chatgpt' ? 'ChatGPT' : io.extraClient!.label, result.models ?? [])
      retryIntent = undefined
      return
    }
    if (result.rejected || !result.done || result.invalidAfterDone || result.failure || handle === undefined) {
      clearChallenge()
      const saved = credentialSaved || handle !== undefined
      const message = saved ? exactPartialSuccess : result.failure ? setupFailureMessage(result.failure, io.extraClient) : 'Sign-in may have been saved; configuration was not changed. Check local sign-in status before retrying.'
      if (saved) clearHandoff()
      reportError(message, saved ? 'restart-setup' : 'login', saved ? 'Retry setup' : 'Retry sign-in')
      return
    }
    clearChallenge()
    stageModel(signedInConnection(client, id, provider === 'chatgpt' ? OFFICIAL_PROFILE.resource : io.extraClient!.baseUrl, handle), provider === 'chatgpt' ? 'ChatGPT' : io.extraClient!.label, result.models ?? [])
    retryIntent = undefined
  }
  const continueConnection = () => {
    const selected = draft.providers.find(item => item.id === draft.form.selectedExistingId)
    const connection = setupConnection(draft)
    if (selected) {
      if (connection) stageModel(connection, selected.id, selected.models, selected)
      else reportError('The selected provider is not valid for setup. Refresh configuration and try again.', 'inspect', 'Refresh setup', 'back')
      return
    }
    if (draft.form.provider === 'chatgpt' || draft.form.provider === io.extraClient?.id) { void startLogin(draft.form.provider); return }
    if (!connection || !validConnection(connection)) { show(connectionPane(draft, io.extraClient)); return }
    if (draft.form.authMethod === 'api-key') {
      try { keyCommand = io.keyCommand(connection.provider) } catch { keyCommand = '' }
      if (!keyCommand || keyCommand.length > 1200 || /[\u0000-\u001f\u007f]/.test(keyCommand)) {
        reportError('The safe terminal key command is unavailable for this provider.', 'inspect', 'Back to setup', 'back')
        return
      }
      draft = { ...draft, connection, providerLabel: draft.form.providerLabel.trim() || connection.provider }
      show({ phase: 'api-key', providerLabel: draft.providerLabel, terminalCommand: keyCommand, presence: 'unknown', canGoBack: true })
      return
    }
    draft = { ...draft, connection, targetProvider: connection.provider, providerLabel: draft.form.providerLabel.trim() || connection.provider }
    stageModel(connection, draft.providerLabel, [])
  }

  const checkPresence = async () => {
    if (operation !== undefined) return
    const connection = draft.connection
    if (!connection) return
    retryIntent = 'presence'
    const result = await invoke({ version: 1, action: 'presence', provider: connection.provider })
    if (stopped || ui === undefined || result.cancelled) return
    if (result.rejected || !result.done || result.invalidAfterDone || result.failure || result.presence === undefined) {
      reportError('Credential presence could not be checked. Retry the local check or go back.', 'presence', 'Retry check')
    } else if (result.presence === 'missing') {
      show({ phase: 'api-key', providerLabel: draft.providerLabel, terminalCommand: keyCommand, presence: 'absent', canGoBack: true })
    } else {
      stageModel(connection, draft.providerLabel, [])
      retryIntent = undefined
    }
  }
  const fetchModels = async () => {
    if (operation !== undefined) return
    const connection = draft.connection
    if (!connection || (connection.auth.kind === 'existing' && draft.existing === undefined && !draft.form.helperConsent)) return
    const wasModel = pane.phase === 'model' ? pane : undefined
    retryIntent = 'models'
    if (wasModel && connection) show({ ...wasModel, modelDiscovery: { endpointLabel: setupEndpointLabel(connection.baseUrl), state: 'loading' } })
    const result = await invoke({ version: 1, action: 'models', connection }, event => {
      if (event.type === 'models') draft = { ...draft, models: event.models }
    })
    if (stopped || ui === undefined || result.cancelled) return
    if (result.rejected || !result.done || result.invalidAfterDone || result.failure || !result.models) {
      showModel(wasModel?.detailsExpanded, 'failed'); retryIntent = undefined; return
    }
    draft = { ...draft, models: result.models, manualEntry: result.models.length === 0, selectedModel: draft.selectedModel && result.models.find(item => item.id === draft.selectedModel?.id) }
    showModel(wasModel?.detailsExpanded, 'ready'); retryIntent = undefined
  }
  const save = async (mode: 'use' | 'only') => {
    if (operation !== undefined) return
    const connection = draft.connection
    if (!connection) return
    const model = resolvedModel(draft.manualEntry ? undefined : draft.selectedModel, draft.manualEntry ? draft.manualModelId : undefined, draft.contextValue, draft.outputValue)
    const alias = draft.aliasValue?.trim() || undefined
    const revision = draft.providers.find(item => item.id === connection.provider)?.revision ?? null
    if (!model || alias && draft.aliases.includes(alias) || !validSave(connection, revision, model, alias)) { showModel(pane.phase === 'model' && pane.detailsExpanded); return }
    savedMode = mode; retryIntent = 'save'
    show({ phase: 'saving', mode })
    const result = await invoke({ version: 1, action: 'save', connection, expectedRevision: revision, model, ...(alias ? { alias } : {}) })
    if (stopped || ui === undefined || result.cancelled) return
    const canonical = `${connection.provider}/${model.id}`
    const targets = new Set([canonical, ...(alias ? [alias] : [])])
    if (result.savedTarget && targets.has(result.savedTarget)) {
      savedTarget = result.savedTarget
      clearHandoff(); clearChallenge()
      if (result.rejected || !result.done || result.failure || result.invalidAfterDone) {
        retryIntent = 'reload'
        show({ phase: 'result', status: 'saved-not-connected', recovery: { type: 'retry', label: 'Retry configuration reload' } })
        return
      }
      retryIntent = 'reload'
      await reloadSaved()
      return
    }
    if (result.failure === 'config-conflict') reportError(setupFailureMessage('config-conflict'), 'save', 'Refresh configuration', 'back')
    else reportError(result.failure ? setupFailureMessage(result.failure, io.extraClient) : 'The save could not be confirmed. Check the local configuration before retrying.', 'save', 'Check configuration')
  }
  const switchSaved = async (epoch: number) => {
    if (!savedTarget) return
    retryIntent = 'use'
    let active = false
    try { active = await io.useModel(savedTarget) } catch { active = false }
    if (epoch !== lifecycle || stopped || ui === undefined) return
    retryIntent = active ? undefined : 'use'
    show({ phase: 'result', status: active ? 'active' : 'saved-not-switched', ...(active ? {} : { recovery: { type: 'retry', label: 'Retry model switch' } }) })
  }
  const reloadSaved = async () => {
    if (!savedTarget || postSaveBusy) return
    postSaveBusy = true
    const epoch = lifecycle
    try {
      let connected = false
      try { connected = await io.reload(savedTarget) } catch { connected = false }
      if (epoch !== lifecycle || stopped || ui === undefined) return
      if (!connected) {
        retryIntent = 'reload'
        show({ phase: 'result', status: 'saved-not-connected', recovery: { type: 'retry', label: 'Retry configuration reload' } })
      } else if (savedMode === 'only') {
        retryIntent = undefined; show({ phase: 'result', status: 'configured' })
      } else await switchSaved(epoch)
    } finally { postSaveBusy = false }
  }
  const useSaved = async () => {
    if (!savedTarget || postSaveBusy) return
    postSaveBusy = true
    try { await switchSaved(lifecycle) } finally { postSaveBusy = false }
  }

  const retry = () => {
    if (retryIntent === 'save') void inspect(true)
    else if (retryIntent === 'inspect' || retryIntent === 'restart-setup') void inspect()
    else if (retryIntent === 'install') void installHelper()
    else if (retryIntent === 'login') void startLogin(loginProvider)
    else if (retryIntent === 'reopen') void reopenChallenge()
    else if (retryIntent === 'presence') void checkPresence()
    else if (retryIntent === 'models') void fetchModels()
    else if (retryIntent === 'reload') void reloadSaved()
    else if (retryIntent === 'use') void useSaved()
  }
  const reopenChallenge = () => { void challengeAction('open') }

  const dispatch = (action: SetupPaneAction): void => {
    if (stopped || ui === undefined) return
    if (action.type === 'install-helper') { void installHelper(); return }
    if (action.type === 'continue-helper') { if (pane.phase === 'helper' && pane.status === 'ready') void inspect(); return }
    if (action.type === 'toggle-helper-details') { if (pane.phase === 'helper') show({ ...pane, detailsExpanded: !pane.detailsExpanded }); return }
    if (action.type === 'choose-provider' || action.type === 'choose-existing-provider' || action.type === 'toggle-advanced' || action.type === 'set-auth-method' || action.type === 'set-protocol' || action.type === 'set-allow-http' || action.type === 'choose-credential-helper' || action.type === 'set-helper-consent') {
      const next = applyConnectionAction(draft, action, io.extraClient)
      if (next) { draft = next; show(connectionPane(draft, io.extraClient)) }
      return
    }
    if (action.type === 'update-field') {
      if (pane.phase === 'connect' || pane.phase === 'model') {
        draft = updateDraftField(draft, action, pane.phase)
        if (pane.phase === 'connect') show(connectionPane(draft, io.extraClient)); else showModel(pane.detailsExpanded)
      }
      return
    }
    if (action.type === 'continue-connection') { if (pane.phase === 'connect') continueConnection(); return }
    if (action.type === 'begin-sign-in') { if (pane.phase === 'connect') void startLogin(action.provider); return }
    if (action.type === 'copy-sign-in-link') { if (pane.phase === 'sign-in') void challengeAction('copy'); return }
    if (action.type === 'open-browser-again' || action.type === 'open-device-verification') {
      if (challenge?.kind === (action.type === 'open-device-verification' ? 'device' : 'browser')) void reopenChallenge()
      return
    }
    if (action.type === 'cancel-auth') {
      const partial = credentialSaved || pendingCredential !== undefined
      clearChallenge(); cancelOperation(); clearHandoff()
      reportError(partial ? exactPartialSuccess : 'Sign-in may have been saved; configuration was not changed. Check local sign-in status before retrying.', 'restart-setup', 'Retry setup')
      return
    }
    if (action.type === 'continue-api-key') { if (pane.phase === 'api-key') void checkPresence(); return }
    if (action.type === 'choose-model') { draft = selectDraftModel(draft, action.modelId); showModel(); return }
    if (action.type === 'toggle-manual-model') { draft = toggleManualModel(draft); showModel(); return }
    if (action.type === 'fetch-models') { if (pane.phase === 'model') void fetchModels(); return }
    if (action.type === 'toggle-change-details') { if (pane.phase === 'model') showModel(!pane.detailsExpanded); return }
    if (action.type === 'save-and-use') { if (pane.phase === 'model' && pane.canSave) void save('use'); return }
    if (action.type === 'save-only') { if (pane.phase === 'model' && pane.canSave) void save('only'); return }
    if (action.type === 'retry') { retry(); return }
    if (action.type === 'back') {
      if (pane.phase === 'error' && retryIntent === 'save') { void inspect(true); return }
      if (pane.phase === 'error' && (retryIntent === 'inspect' || retryIntent === 'restart-setup')) { void inspect(); return }
      if (pane.phase === 'model' && pendingCredential) {
        clearHandoff()
        reportError(exactPartialSuccess, 'restart-setup', 'Retry setup')
        return
      }
      if (pane.phase === 'model') draft = { ...draft, connection: undefined, existing: undefined }
      retryIntent = undefined; show(connectionPane(draft, io.extraClient))
    }
  }

  const open = async (port: SetupControllerUiPort): Promise<void> => {
    if (stopped) return
    if (ui !== undefined) { ui = port; redraw(); return }
    ui = port
    const epoch = ++lifecycle
    redraw()
    await checkHelper(epoch)
  }
  const close = (): void => {
    lifecycle++; cancelOperation(); clearChallenge(); clearHandoff(); credentialSaved = false; keyCommand = ''
    pane = { phase: 'helper', status: 'needed', detailsExpanded: false }
    try { ui?.closePane() } catch { /* The session may already be unloading. */ }
    ui = undefined
  }
  const stop = (): void => { stopped = true; close() }
  return { view: () => pane, open, dispatch, close, stop }
}
