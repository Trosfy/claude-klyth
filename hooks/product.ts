// Product identity and paths shared by the host sandbox and command-line helpers. No filesystem effects.
export const PRODUCT = { displayName: 'Klyth', plugin: 'klyth', command: 'klyth', tool: 'agent', qualifiedTool: 'mcp__klyth__agent', daemon: 'klythd', config: 'klyth.json' } as const
// Credential service identity is independent of display branding; legacy is used only by explicit migration.
export const CREDENTIAL_NAMESPACE = 'klyth'
export const LEGACY_CREDENTIAL_NAMESPACE = 'styx'
export const ENV = { recoveryEpoch: 'KLYTH_DELIVERY_RECOVERY_EPOCH', hostWindowHandoff: 'KLYTH_HOST_WINDOW_HANDOFF' } as const
const under = (root: string, ...parts: string[]) => `${root.replace(/\/+$/, '')}/${parts.join('/')}`
// The User-Agent every Klyth request carries unless a provider's headers set one.
export const klythUserAgent = (version: string) => `klyth/${version}`
export const configPath = (configDir: string) => under(configDir, PRODUCT.config)
export const refreshLockDirectory = (home: string, namespace = CREDENTIAL_NAMESPACE) => under(home, '.cache', namespace)
export const hostIdentityPath = (configDir: string, namespace = CREDENTIAL_NAMESPACE) => under(configDir, `${namespace}-host-id`)
export const statuslinePath = (home: string, sessionId: string) => under(refreshLockDirectory(home), 'statusline', sessionId)
export const compactionParts = (sessionId: string) => [PRODUCT.plugin, 'compactions', sessionId]
export const compactionPath = (configDir: string, sessionId: string, id: string) => under(configDir, ...compactionParts(sessionId), `${id}.json`)
export const recoveryParts = (sessionId: string, ...record: string[]) => [PRODUCT.plugin, 'delivery-recovery', sessionId, ...record]
export const recoveryPath = (configDir: string, sessionId: string) => under(configDir, ...recoveryParts(sessionId))
