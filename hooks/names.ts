// What a model name names: a native model, an alias, or a declared `provider/model`. Pure.
import { ALIAS_RE, NATIVE_MODELS, RESERVED_ALIASES, isObject, own, undeclared } from './config'
import type { Alias, Config, ModelConfig, Target } from './config'

// The model as an alias requests it: the alias's params laid after the model's, its headers over the model's,
// its effort map instead of the model's, its cache lifetime instead of the model's (an alias giving none
// turns the cache off).
const overlay = (m: ModelConfig, a: Alias): ModelConfig => ({ ...m, overrides: a.params ?? {}, headers: { ...m.headers, ...a.headers }, effort: a.effort ?? m.effort, cache: 'cache' in a ? a.cache : m.cache })

// Resolves a model name: a native Agent model, `native/<id>`, an alias, or a declared `provider/model`
// (split at the first `/`). An alias gives the model as it requests it, so a codec never sees an alias.
export function resolve(config: Config, name: string): Target | undefined {
  if (NATIVE_MODELS.includes(name)) return { kind: 'native', model: name, label: name }
  const alias = own(config.aliases, name)
  if (alias !== undefined) {
    const t = resolve(config, alias.target)
    if (t === undefined) return undefined
    return t.kind === 'remote' ? { ...t, model: overlay(t.model, alias), label: name } : { ...t, label: name }
  }
  const slash = name.indexOf('/')
  if (slash <= 0) return undefined
  const [pid, mid] = [name.slice(0, slash), name.slice(slash + 1)]
  if (pid === 'native') return mid === '' ? undefined : { kind: 'native', model: mid, label: mid }
  const p = own(config.providers, pid)
  const m = p === undefined ? undefined : own(p.models, mid)
  return p === undefined || m === undefined ? undefined : { kind: 'remote', provider: p, model: m, target: name, label: name }
}

// Why a `/model` argument that looks like klyth's resolves to nothing.
export function explain(config: Config, name: string): string {
  return `klyth: ${undeclared(config, name) ?? `"${name}" is not a klyth alias or model`}`
}

// Whether a `/model` argument is klyth's to answer. With no valid config, a `provider/model` name and an
// alias name in `known` count, so a klyth alias never reaches the native /model as a model id and every
// other name (`opusplan`, a full id) does.
export function isKlythShaped(config: Config | undefined, arg: string, known: readonly string[] = []): boolean {
  if (arg.startsWith('native/')) return true
  if (config === undefined) return arg.includes('/') || known.includes(arg)
  if (own(config.aliases, arg) !== undefined) return true
  const slash = arg.indexOf('/')
  return slash > 0 && own(config.providers, arg.slice(0, slash)) !== undefined
}

// The alias names a config text declares, read from its `aliases` object whatever else is wrong with it,
// less the built-in model names.
export function declaredAliases(text: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const aliases = isObject(raw) ? raw['aliases'] : undefined
  return isObject(aliases) ? Object.keys(aliases).filter(n => ALIAS_RE.test(n) && !RESERVED_ALIASES.has(n)) : []
}
