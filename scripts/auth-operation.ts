// Transient challenges and bounded model metadata for terminal and helper adapters.
import type { ExtraMethod } from './extras';

export type ModelDescriptor = { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number }
export type AuthChallenge =
  | { type: 'browser-challenge'; authorizeUrl: string; expiresAt: number }
  | { type: 'device-challenge'; verificationUrl: string; userCode: string; expiresAt: number }
// Helper-only completion metadata; never forward this object to a UI event or persistent plugin state.
export type SavedCredential = { provider: string; method: 'v1' | ExtraMethod; clientId: string; fingerprint: string; headers?: Record<string, string | undefined> }
// Callbacks run synchronously; completion is inside the bounded credential lock, never a UI wait.
export type AuthOperationHooks = {
  challenge?(challenge: AuthChallenge): void
  models?(models: readonly ModelDescriptor[]): void
  credentialsSaved?(saved: SavedCredential): void
}
export type AuthOperationOptions = { operation?: AuthOperationHooks; signal?: AbortSignal; tokenCommand?(provider: string): readonly string[] }

// Only a matching successful callback can request a new issuing client for an existing credential.
export function officialClientChanged(url: URL, expectedState: string | undefined, existingClientId: string | undefined): boolean {
  if (existingClientId === undefined || expectedState === undefined || url.searchParams.get('state') !== expectedState || url.searchParams.has('error')) return false
  const clientId = url.searchParams.get('client_id')
  return clientId !== null && clientId !== existingClientId
}
