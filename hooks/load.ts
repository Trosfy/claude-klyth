// Loading what klyth runs on: klyth.json in Claude Code's configuration directory (parsed, then checked against the managed policy), the
// generated MCP schema table, and the klyth agent tool's registration. Pure over a port: register.ts reads
// the files, the settings and the engine's version.
import { PRODUCT, configPath } from './product'
import { advert, agentSchema } from './advert'
import { parseConfig } from './config'
import type { Config, JsonSchema } from './config'
import { declaredAliases } from './names'
import type { Backend } from './protocol'
import { SCHEMAS, STAMP } from './schemas.gen'
import type { Session } from './session'

// A config load: the valid config and its text, or its errors and the alias names the broken file still
// declares.
// `path` is where the file was looked for, as messages show it: `~` for the home directory when it is under it.
export type Loaded = { config?: Config; text?: string; errors: string[]; missing: boolean; declared?: readonly string[]; path: string }

export type LoadPort = {
  // Claude Code's configuration directory, where klyth.json, plugins/installed_plugins.json and agents/ live.
  configDir(): Promise<string>
  home(): Promise<string>
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  // The managed policy settings.
  policy(): Promise<Readonly<Record<string, unknown>>>
}

export type ReloadPort = LoadPort & {
  pluginRoot: string
  version(): Promise<string | undefined>
  // Registers the klyth agent tool with its description and input schema.
  registerAgentTool(description: string, inputSchema: JsonSchema): Promise<void>
  toast(text: string): void
  hostWindow?(window: number | false | undefined): Promise<void>
}

// A policy allow-list or deny rule that excludes a provider's host, as config errors. Unreadable managed
// settings are an error too: no provider host is checked against a policy klyth could not read.
export async function providerPolicyErrors(io: Pick<LoadPort, 'policy'>, providers: readonly { id: string; origin: string }[]): Promise<string[]> {
  let policy: Readonly<Record<string, unknown>>
  try {
    policy = await io.policy()
  } catch (err) {
    return [`the managed policy settings are unreadable (${String(err)}), so no provider host can be checked against them`]
  }
  const sandbox = policy['sandbox'] as { network?: { allowedDomains?: unknown } } | undefined
  const allowed = sandbox?.network?.allowedDomains
  const deny = (policy['permissions'] as { deny?: unknown } | undefined)?.deny
  // A domain rule names the host itself, or with a leading `*.` any host beneath it.
  const covers = (host: string, d: unknown) => typeof d === 'string' && (d === host || (d.startsWith('*.') && host.endsWith(d.slice(1))))
  const denies = (host: string, r: unknown) => r === 'WebFetch' || (typeof r === 'string' && r.startsWith('WebFetch(domain:') && r.endsWith(')') && covers(host, r.slice('WebFetch(domain:'.length, -1)))
  const errors: string[] = []
  for (const p of providers) {
    const host = new URL(p.origin).hostname
    if (Array.isArray(allowed) && !allowed.some(d => covers(host, d))) errors.push(`providers.${p.id}.baseUrl: ${host} is not in the managed policy's sandbox.network.allowedDomains`)
    if (Array.isArray(deny) && deny.some(r => denies(host, r))) errors.push(`providers.${p.id}.baseUrl: the managed policy denies WebFetch to ${host}`)
  }
  return errors
}

// A directory without trailing slashes, so joining and comparing never see `//`.
const bare = (dir: string) => dir.replace(/\/+$/, '')

// A file in a directory as a user would type it: under the home directory it starts with `~`.
export function display(dir: string, home: string, file: string): string {
  const d = bare(dir)
  const h = bare(home)
  return h !== '' && (d === h || d.startsWith(`${h}/`)) ? `~${d.slice(h.length)}/${file}` : `${d}/${file}`
}

export async function loadConfig(io: LoadPort): Promise<Loaded> {
  const dir = await io.configDir()
  const full = configPath(dir)
  const path = display(dir, await io.home(), PRODUCT.config)
  if (!(await io.exists(full))) return { errors: [], missing: true, path }
  let text: string
  try {
    text = await io.read(full)
  } catch (err) {
    return { errors: [`${path}: unreadable (${String(err)})`], missing: false, path }
  }
  const parsed = parseConfig(text)
  if (parsed.config === undefined) return { errors: parsed.errors, missing: false, declared: declaredAliases(text), path }
  const denied = await providerPolicyErrors(io, Object.values(parsed.config.providers))
  return denied.length > 0 ? { errors: denied, missing: false, declared: declaredAliases(text), path } : { config: parsed.config, text, errors: [], missing: false, path }
}

// The MCP schema table the generator wrote beside this mod, and a note when it cannot be used.
async function loadMcpSchemas(io: Pick<ReloadPort, 'exists' | 'read' | 'pluginRoot'>): Promise<{ table: Readonly<Record<string, JsonSchema>>; note?: string }> {
  const path = `${io.pluginRoot}/hooks/schemas.mcp.gen.json`
  try {
    if (!(await io.exists(path))) return { table: {} }
    const table: unknown = JSON.parse(await io.read(path))
    if (typeof table !== 'object' || table === null || Array.isArray(table)) return { table: {}, note: 'MCP schemas: hooks/schemas.mcp.gen.json is not a JSON object; MCP tools go out permissive' }
    return { table: table as Record<string, JsonSchema> }
  } catch (err) {
    return { table: {}, note: `MCP schemas: hooks/schemas.mcp.gen.json unreadable (${String(err)}); MCP tools go out permissive` }
  }
}

// Re-reads the config and the MCP schema table, hands the config to the backend with no provider approved
// yet (each is approved again at its next routed step), re-registers the klyth agent tool, and toasts a
// config error. A healthy load says nothing.
export async function reload(io: ReloadPort, s: Session, backend: Pick<Backend, 'configure'>) {
  const loaded = await loadConfig(io)
  s.resetForReload()
  s.loaded = loaded
  await io.hostWindow?.(loaded.config?.compaction?.hostWindow)
  await backend.configure({ configText: loaded.text ?? '{}', approved: [] })
  const mcp = await loadMcpSchemas(io)
  s.mcpSchemas = mcp.table
  if (mcp.note !== undefined) s.notes.push(mcp.note)
  const version = await io.version()
  if (version !== undefined && version !== STAMP.engineVersion) {
    s.notes.push(`schemas: generated on ${STAMP.engineVersion} · engine ${version} · regenerate with bun scripts/gen-schemas.ts`)
  }
  const config = s.loaded.config
  if (config !== undefined) {
    s.goodAliases = Object.keys(config.aliases)
    await io.registerAgentTool(advert(config), agentSchema(config, SCHEMAS['Agent'] ?? {}))
  } else if (s.loaded.errors.length > 0) {
    io.toast(`klyth: routing off, config error: ${s.loaded.errors[0]}. Fix ${s.loaded.path}, then run /klyth reload`)
  }
}

// Claude Code's configuration directory, falling back to the user's home.
export async function configDirectory(override: () => Promise<string | undefined>, home: () => Promise<string | undefined>): Promise<string> {
  return (await override()) || `${(await home()) ?? ''}/.claude`
}
