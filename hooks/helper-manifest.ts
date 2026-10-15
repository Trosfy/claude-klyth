export const HELPER_MANIFEST_SCHEMA_VERSION = 1 as const
export const HELPER_PROTOCOL_VERSION = 1 as const
export const HELPER_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-glibc-arm64', 'linux-glibc-x64'] as const
export const MAX_HELPER_BYTES = 256 * 1024 * 1024

export type HelperPlatform = typeof HELPER_PLATFORMS[number]
export type HelperArtifact = { url: string; sha256: string; size: number }
export type HelperManifest = {
  schemaVersion: typeof HELPER_MANIFEST_SCHEMA_VERSION
  protocolVersion: typeof HELPER_PROTOCOL_VERSION
  releaseVersion: string
  artifacts: Partial<Record<HelperPlatform, HelperArtifact>>
}

const SHA256 = /^[a-f0-9]{64}$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const ownObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))

function releaseVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && VERSION.test(value)
}

function artifactUrl(value: unknown, version: string, platform: HelperPlatform): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    const segments = url.pathname.split('/').filter(Boolean)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' &&
      url.href === value && !segments.some(segment => segment.toLowerCase() === 'latest') &&
      (segments.at(-2) === version || segments.at(-2) === `v${version}`) && segments.at(-1) === `klyth-${platform}` &&
      segments.every(segment => /^[A-Za-z0-9._+-]+$/.test(segment) && segment !== '.' && segment !== '..')
  } catch {
    return false
  }
}

// Validate a manifest shipped with the trusted mod. The artifact URL and digest are data, never executable input.
export function validateHelperManifest(value: unknown): HelperManifest {
  if (!ownObject(value) || !onlyKeys(value, ['schemaVersion', 'protocolVersion', 'releaseVersion', 'artifacts'])) throw new Error('invalid helper manifest shape')
  if (value.schemaVersion !== HELPER_MANIFEST_SCHEMA_VERSION || value.protocolVersion !== HELPER_PROTOCOL_VERSION) throw new Error('unsupported helper manifest version')
  if (!releaseVersion(value.releaseVersion) || !ownObject(value.artifacts) || !onlyKeys(value.artifacts, HELPER_PLATFORMS)) throw new Error('invalid helper manifest fields')
  const artifacts: Partial<Record<HelperPlatform, HelperArtifact>> = {}
  for (const [name, raw] of Object.entries(value.artifacts)) {
    if (!HELPER_PLATFORMS.includes(name as HelperPlatform) || !ownObject(raw) || !onlyKeys(raw, ['url', 'sha256', 'size'])) throw new Error('invalid helper artifact')
    const platform = name as HelperPlatform
    if (!artifactUrl(raw.url, value.releaseVersion, platform) || typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256) ||
      typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 1 || raw.size > MAX_HELPER_BYTES) throw new Error('invalid helper artifact')
    artifacts[platform] = { url: raw.url, sha256: raw.sha256, size: raw.size }
  }
  if (Object.keys(artifacts).length === 0) throw new Error('helper manifest has no artifacts')
  return { schemaVersion: HELPER_MANIFEST_SCHEMA_VERSION, protocolVersion: HELPER_PROTOCOL_VERSION, releaseVersion: value.releaseVersion, artifacts }
}

// Return only a native artifact tuple whose libc contract is known.
export function helperPlatform(platform: string, arch: string, libc: 'glibc' | 'musl' | 'unknown'): HelperPlatform {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64') && libc === 'glibc') return `linux-glibc-${arch}`
  if (platform === 'linux' && libc !== 'glibc') throw new Error('unsupported Linux libc: only a verified glibc build is supported')
  throw new Error(`unsupported helper platform: ${platform}/${arch}`)
}

// The trusted HOME is already canonical; this path is independent of cwd and config overrides.
export function helperInstallPath(home: string, sha256: string): string {
  const segments = home.split('/')
  if (!home.startsWith('/') || home === '/' || home.endsWith('/') || home.includes('//') ||
    segments.some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..')) ||
    /[\u0000-\u001f\u007f]/.test(home) || !SHA256.test(sha256)) throw new Error('invalid helper installation identity')
  return `${home}/.local/share/klyth/helpers/${sha256}/klyth`
}
