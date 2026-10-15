import type { BackendUsageObserver, UsageTargetSnapshot } from './backend'
import { activateUsageSession, createUsageEnvelope, interruptPending, markUntracked, markUsageWarning, reduceUsage, usageTokenFor } from './usage-ledger'
import { usageCheckpointFits, validateUsageEnvelope } from './usage-ledger-codec'
import type { PendingUsage, UsageAction, UsageEnvelope, UsageSession, UsageToken } from './usage-ledger'
import { applyUsageRetention, bindUsageTranscript, observeUsageTranscripts } from './usage-retention'
import { usageText } from './usage-view'

export type UsageStateRead = { value: unknown; version: number }
export type UsagePort = {
  sessionId(): Promise<string>
  transcriptExists?(path: string): Promise<boolean>
  now(): Promise<number>
  state(): Promise<UsageStateRead>
  setState(value: UsageEnvelope, ifVersion: number): Promise<number>
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: UsageEnvelope): Promise<void>
  after(ms: number, fn: () => void): { cancel(): void }
  context(): Promise<number | undefined>
  log(text: string): void
}

export class UsageOwnershipConflict extends Error {}

type Result<T> = { state: 'ok'; value: T } | { state: 'error' } | { state: 'conflict' } | { state: 'timeout' }
const STORE_KEY = 'usage:v1'
const HOST_STATE_MS = 250
const CHECKPOINT_MS = 250
const CHECKPOINT_RETRY_MS = 5000
const SESSION_ID_MAX = 200
const TOKENS_MAX = 256

function limited<T>(port: UsagePort, operation: Promise<T>, ms = HOST_STATE_MS): Promise<Result<T>> {
  let timer = { cancel: () => {} }
  const timeout = new Promise<Result<T>>(resolve => { timer = port.after(ms, () => resolve({ state: 'timeout' })) })
  const work = operation.then(value => ({ state: 'ok', value }) as Result<T>, error => ({ state: error instanceof UsageOwnershipConflict ? 'conflict' : 'error' }) as Result<T>)
  return Promise.race([work, timeout]).finally(() => timer.cancel())
}

const session = (envelope: UsageEnvelope | undefined): UsageSession | undefined => envelope?.sessions.find(item => item.id === envelope.activeSessionId)
const latestSequence = (envelope: UsageEnvelope) => Math.max(0, ...envelope.sessions.flatMap(item => Object.values(item.pending).map(p => p.generation === envelope.ownerGeneration ? p.sequence : 0)))

export function createUsageLifetime() {
  let live: UsageEnvelope | undefined
  let ports: UsagePort | undefined
  let version = 0
  let sequence = 0
  let memoryOnly = false
  let checkpointDisabled = false
  let fenced = false
  let warm = false
  let initializing = false
  let closing = false
  let stateDirty = false
  let stateWorker: Promise<void> | undefined
  let checkpointTimer: { cancel(): void } | undefined
  let checkpointInFlight: Promise<void> | undefined
  let checkpointWait: Promise<void> | undefined
  let checkpointDirty = false
  let lastCheckpointFailure = -Infinity
  let uninitializedGaps = 0
  const tokens = new Map<string, UsageToken>()
  const pruneTokens = () => {
    for (const [id, token] of tokens) {
      const pending = live?.sessions.find(session => session.id === token.sessionId)?.pending[id]
      if (pending === undefined || pending.generation !== token.generation) tokens.delete(id)
    }
  }

  const warn = (key: 'trackingGap' | 'persistenceFailure' | 'recovered' | 'earlierUnavailable') => {
    if (live === undefined) return
    live = markUsageWarning(live, key)
    stateDirty = true
  }
  const flagGap = () => {
    if (live === undefined) uninitializedGaps = Math.min(Number.MAX_SAFE_INTEGER, uninitializedGaps + 1)
    else { live = markUsageWarning(live, 'trackingGap'); changed() }
  }
  const flagSessionGap = (sessionId: string) => {
    if (live === undefined) return
    const next = markUsageWarning(live, 'trackingGap', sessionId)
    if (next !== live) { live = next; changed() }
  }
  const changed = (checkpoint = true) => {
    if (live === undefined) return
    stateDirty = true
    if (!initializing && !closing && ports !== undefined && !warm && !fenced && !memoryOnly) drainState()
    if (!initializing && !closing && checkpoint) scheduleCheckpoint()
  }

  function publicationFailed(reason: 'error' | 'timeout' | 'conflict') {
    // A rejected storage write leaves live accounting usable; stale or ambiguous CAS owners cannot write again.
    if (reason === 'error') memoryOnly = true
    else { fenced = true; warn('trackingGap') }
    warn('persistenceFailure')
    try { ports?.log(reason === 'error' ? 'Klyth could not update the usage record. It continues to count usage in this session. Print this report to keep the current totals.' : 'Klyth cannot update this usage record. Print this report to keep the current totals.') } catch {}
  }

  async function writeState(port: UsagePort) {
    if (live === undefined || fenced || warm || memoryOnly) return
    while (stateDirty && live !== undefined && !fenced && !warm && !memoryOnly) {
      stateDirty = false
      const snapshot: UsageEnvelope = structuredClone(live)
      const revision: number = snapshot.revision
      const result = await limited(port, Promise.resolve().then(() => port.setState(snapshot, version)))
      if (result.state !== 'ok') {
        publicationFailed(result.state)
        return
      }
      version = result.value
      if (live?.revision !== revision) stateDirty = true
    }
  }

  function drainState() {
    if (stateWorker !== undefined || ports === undefined || fenced || warm || memoryOnly || initializing || closing) return
    stateWorker = Promise.resolve().then(() => writeState(ports as UsagePort)).finally(() => {
      stateWorker = undefined
      if (stateDirty && ports !== undefined && !fenced && !warm && !memoryOnly) drainState()
    })
  }

  async function writeCheckpoint(port: UsagePort, timeoutMs = 1000) {
    if (live === undefined || checkpointDisabled || memoryOnly) return
    if (checkpointInFlight !== undefined || checkpointWait !== undefined) { checkpointDirty = true; return }
    checkpointDirty = false
    const snapshot = structuredClone(live)
    const raw = Promise.resolve().then(() => {
      if (!usageCheckpointFits(snapshot)) throw new Error('usage checkpoint cannot fit the host store')
      return port.storeSet(STORE_KEY, snapshot)
    })
    const settled = raw.then(() => undefined, () => undefined)
    checkpointInFlight = settled
    void settled.then(() => {
      if (checkpointInFlight === settled) checkpointInFlight = undefined
      if (checkpointDirty && checkpointWait === undefined && !fenced && !warm && !closing) scheduleCheckpoint()
    })
    const wait = limited(port, raw, timeoutMs).then(result => {
      if (result.state !== 'ok') {
        const now = Date.now()
        if (now - lastCheckpointFailure >= CHECKPOINT_RETRY_MS) {
          lastCheckpointFailure = now
          warn('persistenceFailure')
          changed(false)
          try { port.log('Klyth could not save usage. Print this report to keep the current totals.') } catch {}
        }
      }
    })
    checkpointWait = wait
    await wait
    if (checkpointWait === wait) checkpointWait = undefined
    if (checkpointInFlight === undefined && checkpointDirty && !fenced && !warm && !closing) scheduleCheckpoint()
  }

  function scheduleCheckpoint() {
    if (ports === undefined || fenced || warm || closing || checkpointDisabled || memoryOnly) return
    checkpointDirty = true
    if (checkpointTimer !== undefined) checkpointTimer.cancel()
    const backoff = Number.isFinite(lastCheckpointFailure) ? Math.max(0, lastCheckpointFailure + CHECKPOINT_RETRY_MS - Date.now()) : 0
    checkpointTimer = ports.after(Math.max(CHECKPOINT_MS, backoff), () => {
      checkpointTimer = undefined
      void writeCheckpoint(ports as UsagePort)
    })
  }

  const apply = (action: UsageAction) => {
    if (live === undefined) { flagGap(); return }
    const next = reduceUsage(live, action)
    if (next === live) return
    live = next
    changed(action.type === 'begin' || action.type === 'settle')
  }

  const observer: BackendUsageObserver = {
    begin(meta) {
      if (live === undefined) { flagGap(); return undefined }
      if (fenced) { live = markUntracked(live); return undefined }
      if (tokens.size >= TOKENS_MAX) { live = markUntracked(live); changed(); return undefined }
      const lastSequence = Math.max(sequence, latestSequence(live))
      if (lastSequence >= Number.MAX_SAFE_INTEGER) { live = markUntracked(live); changed(); return undefined }
      sequence = lastSequence + 1
      const token = usageTokenFor(live, sequence)
      if (token === undefined || token.id.length > 256) { live = markUntracked(live); changed(); return undefined }
      const pending: PendingUsage = {
        requestId: token.id, sessionId: token.sessionId, generation: token.generation, sequence: token.sequence,
        purpose: meta.purpose, owner: meta.owner, target: meta.target,
        startedAt: Date.now(), executions: {},
      }
      apply({ type: 'begin', pending })
      if (!live?.sessions.some(item => Object.hasOwn(item.pending, token.id))) { flagGap(); return undefined }
      tokens.set(token.id, token)
      return token.id
    },
    dispatch(requestId, executionId, snapshot: UsageTargetSnapshot) {
      const token = tokens.get(requestId)
      if (token === undefined) return
      if (fenced) { flagSessionGap(token.sessionId); return }
      apply({ type: 'dispatch', token, executionId, snapshot })
    },
    summary(requestId, summary) {
      const token = tokens.get(requestId)
      if (token === undefined) return
      if (fenced) { flagSessionGap(token.sessionId); return }
      apply({ type: 'summary', token, summary })
    },
    missing(requestId, executionId) {
      const token = tokens.get(requestId)
      if (token === undefined) return
      if (fenced) { flagSessionGap(token.sessionId); return }
      apply({ type: 'missing', token, executionId })
    },
    settle(requestId) {
      const token = tokens.get(requestId)
      if (token === undefined) return
      if (fenced) { flagSessionGap(token.sessionId); return }
      apply({ type: 'settle', token, at: Date.now() })
      tokens.delete(requestId)
    },
    gap(requestId) {
      if (requestId === undefined) { flagGap(); return }
      const token = tokens.get(requestId)
      if (token !== undefined) flagSessionGap(token.sessionId)
    },
  }

  async function maintainRetention(port: UsagePort) {
    if (live === undefined || port.transcriptExists === undefined) return
    const generation = live.ownerGeneration
    const result = await limited(port, observeUsageTranscripts(live, path => port.transcriptExists!(path)))
    if (result.state !== 'ok' || live === undefined || live.ownerGeneration !== generation || fenced || warm) return
    const next = applyUsageRetention(live, result.value)
    if (next !== live) { live = next; pruneTokens(); changed() }
  }

  async function readState(port: UsagePort) {
    return limited(port, port.state())
  }
  async function readCheckpoint(port: UsagePort) {
    return limited(port, port.storeGet(STORE_KEY), 1000)
  }

  async function claim(port: UsagePort, stateVersion: number) {
    version = stateVersion
    if (live === undefined) return
    const snapshot = structuredClone(live)
    const revision = snapshot.revision
    const result = await limited(port, Promise.resolve().then(() => port.setState(snapshot, version)))
    if (result.state !== 'ok') {
      publicationFailed(result.state)
      return
    }
    version = result.value
    stateDirty = live?.revision !== revision
  }

  async function initialize(port: UsagePort, handoff: 'cold' | 'resume' | 'successor') {
    ports = port
    initializing = true
    warm = false
    fenced = false
    memoryOnly = false
    checkpointDisabled = false
    const id = await port.sessionId().catch(() => '')
    const clock = await port.now().catch(() => Date.now())
    const now = Number.isFinite(clock) && clock >= 0 && clock <= 8.64e15 ? clock : Date.now()
    if (id.length === 0 || id.length > SESSION_ID_MAX || /[\u0000-\u001f\u007f]/.test(id)) {
      live = createUsageEnvelope('unknown-session', now)
      memoryOnly = true
      warn('trackingGap')
      sequence = 0
      initializing = false
      return
    }
    if (handoff !== 'cold' && live !== undefined) {
      if (handoff === 'successor') live = interruptPending(live, now, live.ownerGeneration)
      live = activateUsageSession(live, id, now)
      await maintainRetention(port)
      pruneTokens()
      sequence = latestSequence(live)
      const actual = await readState(port)
      if (actual.state !== 'ok') { memoryOnly = true; warn('trackingGap'); warn('persistenceFailure'); initializing = false; return }
      await claim(port, actual.value.version)
      initializing = false
      if (stateDirty && !fenced) drainState()
      scheduleCheckpoint()
      return
    }

    const [stateResult, checkpointResult] = await Promise.all([readState(port), readCheckpoint(port)])
    const stateRead = stateResult.state === 'ok' ? stateResult.value : undefined
    const current = stateRead === undefined ? undefined : validateUsageEnvelope(stateRead.value)
    const checkpoint = checkpointResult.state === 'ok' ? validateUsageEnvelope(checkpointResult.value) : undefined
    checkpointDisabled = checkpointResult.state === 'ok' && checkpointResult.value !== undefined && checkpoint === undefined
    if (stateResult.state !== 'ok') {
      const matching = checkpoint?.sessions.some(item => item.id === id) === true
      live = checkpoint === undefined ? createUsageEnvelope(id, now) : interruptPending(checkpoint, now, checkpoint.ownerGeneration)
      if (checkpoint !== undefined) live = activateUsageSession(live, id, now)
      live = markUsageWarning(live, checkpoint === undefined ? 'trackingGap' : matching ? 'recovered' : 'earlierUnavailable')
      memoryOnly = true
      warn('trackingGap')
      warn('persistenceFailure')
      sequence = latestSequence(live)
    } else if (stateResult.value.value !== undefined && current === undefined) {
      live = createUsageEnvelope(id, now)
      memoryOnly = true
      warn('trackingGap')
      warn('persistenceFailure')
      warn('earlierUnavailable')
      port.log('Klyth cannot read the saved usage record. It will count new usage without replacing that record. Print this report to keep the current totals.')
    } else if (current !== undefined) {
      const matching = current.sessions.some(item => item.id === id)
      live = interruptPending(current, now, current.ownerGeneration)
      live = activateUsageSession(live, id, now)
      if (!matching) live = markUsageWarning(live, 'earlierUnavailable')
      sequence = latestSequence(live)
      await claim(port, stateResult.value.version)
    } else if (checkpoint !== undefined) {
      const matching = checkpoint.sessions.some(item => item.id === id)
      live = interruptPending(checkpoint, now, checkpoint.ownerGeneration)
      live = activateUsageSession(live, id, now)
      live = markUsageWarning(live, matching ? 'recovered' : 'earlierUnavailable')
      sequence = latestSequence(live)
      await claim(port, stateResult.value.version)
    } else if (checkpointResult.state === 'ok' && checkpointResult.value !== undefined && checkpoint === undefined) {
      live = createUsageEnvelope(id, now)
      memoryOnly = true
      warn('trackingGap')
      warn('persistenceFailure')
      warn('earlierUnavailable')
      port.log('Klyth cannot read the saved usage record. It will count new usage without replacing that record. Print this report to keep the current totals.')
    } else {
      live = createUsageEnvelope(id, now)
      sequence = 0
      await claim(port, stateResult.value.version)
    }
    if ((checkpointDisabled || checkpointResult.state !== 'ok') && !memoryOnly) warn('persistenceFailure')
    await maintainRetention(port)
    pruneTokens()
    if (uninitializedGaps > 0) {
      live = markUntracked(live, live.activeSessionId, now, uninitializedGaps)
      uninitializedGaps = 0
      stateDirty = true
    }
    initializing = false
    if (stateDirty && !fenced && !memoryOnly) drainState()
    scheduleCheckpoint()
  }

  async function flush(port: UsagePort) {
    if (stateWorker !== undefined) await limited(port, stateWorker, 300)
    if (stateDirty && !fenced && !memoryOnly && stateWorker === undefined) await limited(port, writeState(port), 250)
    const checkpointOperation = checkpointWait ?? checkpointInFlight
    if (checkpointOperation !== undefined) {
      checkpointDirty = true
      await limited(port, checkpointOperation, 450)
      return
    }
    const retryReady = Date.now() - lastCheckpointFailure >= CHECKPOINT_RETRY_MS
    if (retryReady && !fenced && !memoryOnly && !checkpointDisabled) await writeCheckpoint(port, 450)
  }

  return {
    observer,
    recordState: () => fenced ? 'fenced' as const : 'active' as const,
    async bindTranscript(port: UsagePort, sessionId: string, path: string) {
      if (live === undefined || warm || fenced) return
      const next = bindUsageTranscript(live, sessionId, path)
      if (next !== live) { live = next; changed() }
      await maintainRetention(port)
    },
    start: (port: UsagePort) => initialize(port, warm ? 'successor' : 'cold'),
    resume: async (port: UsagePort) => {
      if (!warm || live === undefined) return
      await initialize(port, 'resume')
    },
    end: async (port: UsagePort) => {
      if (live === undefined) return
      closing = true
      checkpointTimer?.cancel()
      checkpointTimer = undefined
      try { await flush(port) } finally { warm = true; closing = false; ports = undefined }
    },
    async text(port: UsagePort) {
      const context = await port.context().catch(() => undefined)
      const current = session(live)
      return usageText(current, context, fenced ? 'fenced' : 'active')
    },
    snapshot: () => live === undefined ? undefined : structuredClone(live),
  }
}
