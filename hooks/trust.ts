// Trust on first use: a provider is approved once per fingerprint (kind, origin and key-helper argv), the
// approval is kept in the engine's store, and the backend is told which providers are approved, since it runs
// a provider's helper only then. Pure over a port.
import { fingerprint } from './config'
import type { ProviderConfig } from './config'
import type { Backend } from './protocol'
import type { Session } from './session'

export type TrustPort = {
  trusted(key: string): Promise<boolean>
  remember(key: string): Promise<void>
  // The person's answer to a question, one of `options`.
  ask(question: string, options: readonly string[]): Promise<string>
}

const trustKey = (p: ProviderConfig) => `trust:${fingerprint(p)}`

// The question asked once before a provider is first used, showing the helper's argv verbatim (or that no
// key is sent). A plain-http origin says first that its key and data travel unencrypted unless the network
// itself is private or encrypted; with no key, that anyone on the path can read or alter prompts and answers.
export function trustPrompt(p: ProviderConfig): string {
  const plain = p.origin.startsWith('http:')
  if (p.auth === 'none') return `${plain ? 'Plain http and no key: anyone on the path can read or alter prompts and answers. ' : ''}Route klyth requests to ${p.origin}, sending no key?`
  const ask = `Route klyth requests to ${p.origin}, with the key printed by ${JSON.stringify(p.auth.command)}?`
  return plain ? `Plain http: the API key and your data travel unencrypted unless the network itself is private or encrypted. ${ask}` : ask
}

export const isTrusted = (io: Pick<TrustPort, 'trusted'>, p: ProviderConfig) => io.trusted(trustKey(p))

// Tells the backend a provider is approved, once per reload, after its approval was read.
export async function approve(s: Session, backend: Pick<Backend, 'configure'>, p: ProviderConfig) {
  if (s.approved.has(fingerprint(p))) return
  s.approved.add(fingerprint(p))
  await backend.configure({ configText: s.loaded.text ?? '{}', approved: [...s.approved] })
}

// Asks once per provider fingerprint; only the exact answer "Allow" approves.
export async function ensureTrust(io: TrustPort, p: ProviderConfig): Promise<boolean> {
  if (await isTrusted(io, p)) return true
  let answer: string
  try {
    answer = await io.ask(trustPrompt(p), ['Allow', 'Keep native'])
  } catch {
    return false
  }
  if (answer !== 'Allow') return false
  await io.remember(trustKey(p))
  return true
}
