// The optional node sign-in capabilities injected into core by executable composition roots.
import type { ExtraClient } from '../hooks/extra-client'
import type { ChatGptIo } from './chatgpt'

export type ExtraSignIn<Id extends string = string, Method extends string = string> = {
  client: ExtraClient<Id, Method>
  deviceLogin(io: ChatGptIo, provider: string): Promise<Record<string, string | undefined> | number>
  refresh: { tokenUrl: string; fields: Record<string, string>; loginFlags: string; refusedClient(provider: string): string }
  authUserAgent(env: Readonly<Record<string, string | undefined>>): { userAgent?: string } | { error: string }
  clientId(env: Readonly<Record<string, string | undefined>>): string | undefined
  cliFlags: readonly string[]
  help: string
  configCheck(provider: Record<string, unknown>, device: boolean): string | undefined
  configHeaders(headers: Record<string, string | undefined> | undefined): Record<string, string | undefined>
  headerKeys: readonly string[]
  setupDiscover(env: Readonly<Record<string, string | undefined>>): { suffix: string; headers: Record<string, string> }
}
