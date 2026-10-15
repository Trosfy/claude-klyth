import type { UsageEnvelope } from './usage-ledger'

export type UsageTranscript = { path: string; confirmed: boolean }
export type TranscriptObservation = { sessionId: string; path: string; exists: boolean }
export const validTranscriptPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)

export function bindUsageTranscript(envelope: UsageEnvelope, sessionId: string, path: string): UsageEnvelope {
  if (sessionId !== envelope.activeSessionId || !validTranscriptPath(path)) return envelope
  const current = envelope.sessions.find(session => session.id === sessionId)
  if (current === undefined || current.transcript?.path === path) return envelope
  const next = structuredClone(envelope)
  next.sessions.find(session => session.id === sessionId)!.transcript = { path, confirmed: false }
  next.revision++
  return next
}

// Only engine-provided exact paths are checked; errors are not evidence of host deletion.
export async function observeUsageTranscripts(envelope: UsageEnvelope, exists: (path: string) => Promise<boolean>): Promise<TranscriptObservation[]> {
  const observations: TranscriptObservation[] = []
  for (const session of envelope.sessions) {
    if (session.transcript === undefined || session.id === envelope.activeSessionId && session.transcript.confirmed) continue
    try { observations.push({ sessionId: session.id, path: session.transcript.path, exists: await exists(session.transcript.path) }) } catch {}
  }
  return observations
}

export function applyUsageRetention(envelope: UsageEnvelope, observations: TranscriptObservation[]): UsageEnvelope {
  const next = structuredClone(envelope)
  let changed = false
  for (const observation of observations) {
    const session = next.sessions.find(session => session.id === observation.sessionId)
    if (session?.transcript?.path !== observation.path) continue
    if (observation.exists) {
      if (!session.transcript.confirmed) { session.transcript.confirmed = true; changed = true }
    } else if (session.transcript.confirmed && session.id !== next.activeSessionId && Object.keys(session.pending).length === 0) {
      next.sessions = next.sessions.filter(item => item.id !== session.id)
      changed = true
    }
  }
  if (!changed) return envelope
  next.revision++
  return next
}
