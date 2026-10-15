// The one optional sign-in client a build may add beside Sign in with ChatGPT; the public build adds none. Pure: the
// descriptor core reads, and its lookups. The registry, data only, is hooks/extras.ts.
export type ExtraHeaders = { originator?: string; userAgent?: string }
export type ExtraClient<Id extends string = string, Method extends string = string> = {
  id: Id // the setup protocol's client name
  method: Method // the keyring item's method tag
  label: string // the setup pane's name for it
  baseUrl: string // the backend its tokens are for: a provider's baseUrl
  verificationUrl: string // the one page a device challenge opens: origin and path, exactly
  failureText: string // what setup shows for `extra-client-unavailable`
  defaultProviderId: string // the provider id a new sign-in takes
  // The environment's identity overrides for requests to `baseUrl`, or the line naming a bad one (its value unshown).
  requestHeaders(env: Readonly<Record<string, string | undefined>>): ExtraHeaders | { error: string }
}

export const knownClient = <Id extends string>(extra: ExtraClient<Id> | undefined, v: unknown): v is 'official' | Id => v === 'official' || (extra !== undefined && v === extra.id)
export const knownMethod = <M extends string>(extra: ExtraClient<string, M> | undefined, v: unknown): v is 'v1' | M => v === 'v1' || (extra !== undefined && v === extra.method)

// A device challenge's page: the extra client's verification URL exactly (no userinfo, query or hash).
export function verificationPage(extra: ExtraClient | undefined, v: unknown): boolean {
  if (extra === undefined || typeof v !== 'string' || v.length > 8192) return false
  try {
    const [u, want] = [new URL(v), new URL(extra.verificationUrl)]
    return u.origin === want.origin && u.pathname === want.pathname && u.username === '' && u.password === '' && u.search === '' && u.hash === ''
  } catch {
    return false
  }
}
