// Only concrete Markdown artifacts at authoritative roots qualify for review, never for automatic permission.
export type ArtifactRoots = { configDir?: string; configReal?: string; pluginRoot?: string; cwd: string }
type Artifact = { prefix: string; realPrefix: string; tail: string; memory: boolean }
const below = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

export function artifactOf(path: string, roots: ArtifactRoots): Artifact | undefined {
  if (!path.startsWith('/') || /[\\\p{Cc}\p{Cf}*?${}~]/u.test(path) || path.split('/').some(p => p === '..' || p === '.')) return undefined
  if (roots.pluginRoot !== undefined && below(path.toLowerCase(), roots.pluginRoot.toLowerCase())) return undefined
  const config = roots.configReal === undefined ? undefined : roots.configDir?.replace(/\/+$/, '')
  const local = `${roots.cwd.replace(/\/+$/, '')}/.claude/plans/`
  const prefix = config !== undefined && path.startsWith(`${config}/plans/`) ? `${config}/plans/`
    : config !== undefined && new RegExp(`^${escape(config)}/projects/[^/]+/memory/`).test(path) ? path.match(new RegExp(`^${escape(config)}/projects/[^/]+/memory/`))?.[0]
    : path.startsWith(local) ? local : undefined
  if (prefix === undefined) return undefined
  const tail = path.slice(prefix.length)
  if (!/^[\w.-]+(?:\/[\w.-]+)*\.md$/.test(tail)) return undefined
  const realPrefix = config !== undefined && prefix.startsWith(`${config}/`) ? `${roots.configReal ?? config}${prefix.slice(config.length)}` : prefix
  return { prefix, realPrefix, tail, memory: prefix.includes('/memory/') }
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Retain every other byte and the artifact's nested components for the protected-name scan.
export async function withoutArtifacts(text: string, qualify: (path: string) => Promise<Artifact | undefined>): Promise<string> {
  const paths = [...text.matchAll(/(?<![\w.~$\\/:-])\/[\w./${}*?~-]+(?=$|[\s"'`;&|()<>]|\\")/g)]
  let out = '', at = 0
  for (const hit of paths) {
    const path = hit[0], artifact = await qualify(path)
    out += text.slice(at, hit.index) + (artifact === undefined ? path : artifact.tail)
    at = hit.index + path.length
  }
  return out + text.slice(at)
}
