// Native helpers reuse the terminal OAuth implementation without consuming terminal text.
import type { AuthChallenge, ModelDescriptor, SavedCredential } from './auth-operation'
import { officialClientChanged } from './auth-operation'
import type { ChatGptIo } from './chatgpt'
import { login } from './chatgpt'
import type { ExtraClientId } from './extras'

export type AuthLoginResult =
  | { status: 'saved'; credential: SavedCredential; models: readonly ModelDescriptor[] }
  | { status: 'failed' | 'cancelled' | 'credential-conflict' }
export async function authenticate(io: ChatGptIo, provider: string, options: { client: 'official' | ExtraClientId; existingClientId?: string; port?: number; browser?: boolean; challenge(challenge: AuthChallenge): void }): Promise<AuthLoginResult> {
  let credential: SavedCredential | undefined
  let models: readonly ModelDescriptor[] = []
  let expectedState: string | undefined, replacementBlocked = false
  const adapted: ChatGptIo = { ...io, out: () => {}, err: () => {},
    listen: (port, onCallback) => io.listen(port, url => {
      if (options.client === 'official' && officialClientChanged(url, expectedState, options.existingClientId)) {
        replacementBlocked = true
        const refused = new URL(url)
        refused.searchParams.set('error', 'credential_client_changed')
        refused.searchParams.delete('error_description')
        return onCallback(refused)
      }
      return onCallback(url)
    }), operation: {
    challenge: value => {
      if (value.type === 'browser-challenge') expectedState = new URL(value.authorizeUrl).searchParams.get('state') ?? undefined
      options.challenge(value)
    },
    models: value => { models = value },
    credentialsSaved: value => { credential = value; io.operation?.credentialsSaved?.(value) },
  } }
  if (io.signal?.aborted) return { status: 'cancelled' }
  if (options.client !== 'official') {
    if (io.extraSignIn?.client.id !== options.client) return { status: 'failed' }
    await io.extraSignIn.deviceLogin(adapted, provider)
  }
  else await login(adapted, provider, { port: options.port ?? 1455, browser: options.browser ?? true })
  if (replacementBlocked) return { status: 'credential-conflict' }
  return credential === undefined ? { status: io.signal?.aborted ? 'cancelled' : 'failed' } : { status: 'saved', credential, models }
}
