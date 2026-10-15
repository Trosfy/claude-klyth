// Session start, switching the main conversation (/model), trust on first use, the large-context warning,
// PostModelSwitch, the /model typeahead and /klyth.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { typeahead } from '../hooks/advert'
import { parseConfig } from '../hooks/config'
import { STAMP } from '../hooks/schemas.gen'
import type { Config } from '../hooks/config'
import { CONFIG, CONFIG_OBJECT, HELPER, LOCAL_CONFIG, LOCAL_HELPER, LOCAL_ORIGIN, LOCAL_TRUSTED, model, ORIGIN, sse, start, step, world } from './world'

const brokenConfig = JSON.stringify({ ...CONFIG_OBJECT, aliases: { strong: 'acme9/model-b' } })
const NONE_CONFIG = JSON.stringify({ ...CONFIG_OBJECT, providers: { acme: { ...CONFIG_OBJECT.providers.acme, auth: 'none' } } })

test('session.start registers the klyth agent tool and /klyth, and a healthy config makes no toast', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered.map(t => t.name)).toEqual(['agent'])
  const schema = w.registered[0]?.inputSchema as { properties: { model: { enum: string[] } } }
  expect(schema.properties.model.enum).toContain('strong')
  expect(w.registered[0]?.description).toContain('- strong: acme/model-b — strong generalist')
  expect(w.commands).toEqual(['klyth'])
  expect(w.toasts).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('with no config file klyth registers no tool, toasts nothing, and leaves /model alone', async ($, on) => {
  const w = world(on, { config: null })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual([])
  expect(await model($, 'strong')).toMatchObject({ text: 'native /model strong' })
})

test('a broken config disables routing: one toast, alias-shaped /model args answered, native ones passed', async ($, on) => {
  const w = world(on, { config: brokenConfig })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual(['klyth: routing off, config error: aliases.strong → provider "acme9" is not declared (declared: acme). Fix ~/.claude/klyth.json, then run /klyth reload'])
  expect(await model($, 'strong')).toEqual({
    text: 'can\'t switch to strong: config error, aliases.strong → provider "acme9" is not declared (declared: acme). Native model unchanged; fix ~/.claude/klyth.json, then run /klyth reload',
  })
  expect(await model($, 'opus')).toMatchObject({ text: 'native /model opus' })
  expect(await model($, 'native/sonnet')).toMatchObject({ text: 'native /model sonnet' })
  expect(await model($, 'opusplan')).toMatchObject({ text: 'native /model opusplan' })
  expect(w.native).toEqual(['/model opus', '/model sonnet', '/model opusplan'])
})

test('after a reload breaks the config, the last valid aliases are still answered and other names pass', async ($, on) => {
  let text = CONFIG
  const w = world(on, { config: () => text })
  await start($)
  text = JSON.stringify({ providers: 5 })
  await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(await model($, 'strong')).toEqual({ text: "can't switch to strong: config error, providers: must be an object. Native model unchanged; fix ~/.claude/klyth.json, then run /klyth reload" })
  expect(await model($, 'opusplan')).toMatchObject({ text: 'native /model opusplan' })
  expect(w.native).toEqual(['/model opusplan'])
})

test('/model strong selects the klyth target in one line, without the native command, with a status line and no toast', async ($, on) => {
  const w = world(on, { usageTokens: 84_000 })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.native).toEqual([])
  expect(w.statuses.at(-1)).toBe('strong · acme')
  expect(w.toasts).toEqual([])
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'strong' })
  expect(await model($, 'acme/model-a')).toEqual({ text: 'Set model to acme/model-a' })
  expect(w.statuses.at(-1)).toBe('fast · acme')
  expect(await model($, 'acme/small')).toEqual({ text: 'Set model to acme/small' })
  expect(w.statuses.at(-1)).toBe('acme/small · acme')
})

test('/model strong runs no key helper; a routed step whose helper fails answers one line naming the fix, and sends nothing', async ($, on) => {
  const w = world(on, { keyFails: true })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'strong' })
  expect(w.runs.filter(r => r[0] === HELPER[0])).toEqual([])
  const s = await step($, { turnId: 'k', index: 0 })
  const text = 'klyth: acme key helper failed (exit 1): keychain locked, or no key stored? Run klyth auth login api-key acme'
  expect(s.result).toMatchObject({ answer: text, stopReason: 'end_turn', usage: null })
  expect(w.runs.filter(r => r[0] === HELPER[0])).toEqual([HELPER])
  expect(w.toasts).toEqual([])
  expect(w.requests).toEqual([])
})

test('prototype names are no klyth targets: acme/toString is undeclared, and constructor goes to the native /model', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await model($, 'acme/toString')).toEqual({ text: '"toString" is not declared under provider acme (declared: model-a, model-b, small)' })
  expect(await model($, 'constructor')).toMatchObject({ text: 'native /model constructor' })
  expect(w.stateSets.some(s => s.key === 'main')).toBe(false)
})

test('a refused write clearing main still leaves main native, and the native command runs once', async ($, on) => {
  const w = world(on, { mainClear: 'fails' })
  await start($)
  await model($, 'strong')
  expect(await model($, 'opus')).toMatchObject({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.native).toEqual(['/model opus'])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.debug.some(l => l.startsWith('klyth: could not persist clearing main'))).toBe(true)
  expect((await step($, { turnId: 'n', index: 0 })).result.answer).toBe('native')
})

test('a clear of main holds in memory before its state write lands: a turn starting during the write is native', async ($, on) => {
  let release = () => {}
  let entered = () => {}
  const writing = new Promise<void>(resolve => (entered = resolve))
  const w = world(on, { mainClear: () => (entered(), new Promise<void>(resolve => (release = resolve))) })
  await start($)
  await model($, 'strong')
  const switching = model($, 'opus')
  await writing
  expect((await step($, { turnId: 'during', index: 0 })).result.answer).toBe('native')
  release()
  expect(await switching).toEqual({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.requests).toEqual([])
})

// The leave line, as the native command's output carries it. Alone it is the whole /model result, which
// the engine shows under the mod's name, so it drops its own prefix there (`LEFT_STRONG_ALONE`).
const LEFT_STRONG = 'klyth: left strong (acme/model-b)'
const LEFT_STRONG_ALONE = 'left strong (acme/model-b)'

test('a bare /model while klyth holds main leaves klyth before the picker opens, even when the picker answers nothing', async ($, on) => {
  let atPicker: { main: unknown; status: string | undefined } | undefined
  const w = world(on, { picker: () => ((atPicker = { main: w.stateSets.at(-1), status: w.statuses.at(-1) }), '') })
  await start($)
  await model($, 'strong')
  expect(await model($, '')).toEqual({ text: LEFT_STRONG_ALONE })
  expect(atPicker).toEqual({ main: { key: 'main', value: null }, status: undefined })
  expect((await step($, { turnId: 'p', index: 0 })).result.answer).toBe('native')
  expect(w.requests).toEqual([])
})

for (const picked of ['Set model to `Opus 5.5` and saved as your default for new sessions', 'Kept model as Opus 5.5']) {
  test(`a bare /model leaves klyth whatever the picker then says: ${picked}`, async ($, on) => {
    const w = world(on, { picker: picked })
    await start($)
    await model($, 'strong')
    expect(await model($, '')).toEqual({ text: `${picked}\n${LEFT_STRONG}` })
    expect(w.stateSets.filter(s => s.key === 'main')).toEqual([
      { key: 'main', value: 'strong' },
      { key: 'main', value: null },
    ])
    expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  })
}

test('a bare /model with klyth not holding main is the native picker, untouched', async ($, on) => {
  const w = world(on, { picker: 'Kept model as Opus 5.5' })
  await start($)
  expect(await model($, '')).toEqual({ text: 'Kept model as Opus 5.5' })
  expect(w.stateSets.some(s => s.key === 'main')).toBe(false)
})

test('a picker switch while klyth holds main clears main once, its PostModelSwitch finding it clear', async ($, on) => {
  const w = world(on, { picker: '' })
  await start($)
  await model($, 'strong')
  await model($, '')
  await $.classic.PostModelSwitch({
    from_model: 'opus',
    to_model: 'sonnet',
    requested_model: null,
    source: 'picker',
    context_tokens: 0,
    prompt_cache_warm: false,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0,
  } as never)
  expect(w.stateSets.filter(s => s.key === 'main')).toEqual([
    { key: 'main', value: 'strong' },
    { key: 'main', value: null },
  ])
  expect(w.toasts.filter(t => t.startsWith('klyth: left'))).toEqual([])
})

test('/model opus while klyth holds main runs the native command, then clears main and the status line', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  expect(await model($, 'opus')).toEqual({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.native).toEqual(['/model opus'])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.stateSets.at(-1)).toEqual({ key: 'main', value: null })
  expect(await model($, 'opus')).toEqual({ text: 'native /model opus' })
  expect((await step($, { turnId: 'after-opus', index: 0 })).result.answer).toBe('native')
  expect(w.toasts).toEqual([])
})

test('/model native/opus hands opus to the native command and clears main after it ran', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  expect(await model($, 'native/opus')).toEqual({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.native).toEqual(['/model opus'])
  expect(w.stateSets.at(-1)).toEqual({ key: 'main', value: null })
})

test('an undeclared provider/model is named; a bare /model opens the native picker', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await model($, 'acme/gpt-6')).toEqual({ text: '"gpt-6" is not declared under provider acme (declared: model-a, model-b, small)' })
  expect(await model($, '')).toMatchObject({ text: 'native /model ' })
  expect(w.native).toEqual(['/model '])
})

test('explicit selection persists a large-context route for compaction without sending a request', async ($, on) => {
  const w = world(on, { usageTokens: 310_000 })
  await start($)
  expect(await model($, 'acme/small')).toEqual({ text: "Set model to acme/small\nklyth: existing context ~310k tokens is large for acme/small's 120k input budget; run /compact before continuing. Normal requests still enforce the 95% safety threshold" })
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'acme/small' })
  expect(w.requests).toEqual([])
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
})

test('the first routed use asks once; Allow persists, and later uses do not ask', async ($, on) => {
  const w = world(on, { store: {} })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.asks).toEqual([`Route klyth requests to ${ORIGIN}, with the key printed by ${JSON.stringify(HELPER)}?`])
  await model($, 'fast')
  expect(w.asks).toHaveLength(1)
})

test('a provider switched from a helper to none asks again, names that no key is sent, and its steps carry no key and run no helper', async ($, on) => {
  const w = world(on, { config: NONE_CONFIG })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.asks).toEqual([`Route klyth requests to ${ORIGIN}, sending no key?`])
  await model($, 'fast')
  expect(w.asks).toHaveLength(1)
  await step($, { turnId: 'k1', index: 0 })
  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]!.headers)).not.toContain('authorization')
  expect(Object.keys(w.requests[0]!.headers)).not.toContain('x-api-key')
  expect(w.runs.filter(argv => argv[0] === HELPER[0])).toEqual([])
})

test('the trust prompt for a plain-http provider says the key and data travel unencrypted, and approval is per http origin', async ($, on) => {
  const w = world(on, { config: LOCAL_CONFIG, store: {} })
  await start($)
  expect(await model($, 'model.v1-mini')).toEqual({ text: 'Set model to model.v1-mini (local/model-v1)' })
  expect(w.asks).toEqual([
    `Plain http: the API key and your data travel unencrypted unless the network itself is private or encrypted. Route klyth requests to ${LOCAL_ORIGIN}, with the key printed by ${JSON.stringify(LOCAL_HELPER)}?`,
  ])
  expect(await model($, 'local/model-v1')).toEqual({ text: 'Set model to local/model-v1' })
  expect(w.asks).toHaveLength(1)
})

test('a dotted alias switches main end to end: the status line, the state, the leave line, the typeahead and the picker leave', async ($, on) => {
  const w = world(on, { config: LOCAL_CONFIG, store: LOCAL_TRUSTED })
  await start($)
  expect(w.toasts).toEqual([])
  expect((w.registered[0]?.inputSchema as { properties: { model: { enum: string[] } } }).properties.model.enum).toContain('model.v1-mini')
  expect(await model($, 'model.v1-mini')).toEqual({ text: 'Set model to model.v1-mini (local/model-v1)' })
  expect(w.native).toEqual([])
  expect(w.statuses.at(-1)).toBe('model.v1-mini · local')
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'model.v1-mini' })
  expect(w.toasts).toEqual([])
  expect(await model($, 'opus')).toEqual({ text: 'native /model opus\nklyth: left model.v1-mini (local/model-v1)' })
  expect(w.statuses.at(-1)).toBeUndefined()
  const config = parseConfig(LOCAL_CONFIG).config as Config
  expect(typeahead(config, '/model model.v1-m', 7, 'model.v1-m')).toEqual([
    { text: 'model.v1-mini', description: 'a dotted alias on a plain-http provider (local/model-v1)' },
  ])
})

test('a dotted alias is kept from the native /model while the config is broken', async ($, on) => {
  const broken = JSON.stringify({ ...JSON.parse(LOCAL_CONFIG), version: 2 })
  const w = world(on, { config: broken })
  await start($)
  expect(await model($, 'model.v1-mini')).toEqual({
    text: "can't switch to model.v1-mini: config error, version: unsupported (klyth reads version 1). Native model unchanged; fix ~/.claude/klyth.json, then run /klyth reload",
  })
  expect(w.native).toEqual([])
})

for (const answer of ['Keep native', 'Allow it', null]) {
  test(`answering ${JSON.stringify(answer)} to the trust dialog leaves the provider unapproved`, async ($, on) => {
    const w = world(on, { store: {}, answer })
    await start($)
    expect(await model($, 'strong')).toEqual({ text: 'provider acme not approved; native model unchanged. Run /model strong again and choose Allow' })
    expect(w.stateSets.some(s => s.key === 'main')).toBe(false)
  })
}

test('an approval for another key helper does not cover a changed fingerprint', async ($, on) => {
  const w = world(on, { store: { [`trust:openai|${ORIGIN}|cmd:["/usr/bin/other"]`]: true }, answer: 'Keep native' })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'provider acme not approved; native model unchanged. Run /model strong again and choose Allow' })
  expect(w.asks).toHaveLength(1)
})

test('when the /model hook fails, its .catch answers a klyth-shaped argument and the native command does not run', async ($, on) => {
  const w = world(on, { store: 'fails' })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: "couldn't switch to strong (internal error; see the debug log). Native model unchanged" })
  expect(w.native).toEqual([])
})

test('a /model result never opens with "klyth: " (the engine adds the mod name), and a native reply passes through as it is', async ($, on) => {
  world(on, { store: {}, answer: 'Keep native', picker: 'Kept model as Opus 5.5' })
  await start($)
  const refused = await model($, 'strong')
  expect(refused.text).toBe('provider acme not approved; native model unchanged. Run /model strong again and choose Allow')
  expect(refused.text?.startsWith('klyth: ')).toBe(false)
  expect(await model($, 'opus')).toEqual({ text: 'native /model opus' })
  expect(await model($, '')).toEqual({ text: 'Kept model as Opus 5.5' })
})

test('PostModelSwitch clears main for command, picker and sdk switches, not auto or resume', async ($, on) => {
  const w = world(on)
  await start($)
  const raise = (source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume') =>
    $.classic.PostModelSwitch({
      from_model: 'opus',
      to_model: 'sonnet',
      requested_model: null,
      source,
      context_tokens: 0,
      prompt_cache_warm: false,
      cache_ttl: '1h',
      estimated_cache_write_usd: 0,
    } as never)
  for (const source of ['auto', 'resume'] as const) {
    await model($, 'strong')
    await raise(source)
    expect(w.statuses.at(-1), source).toBe('strong · acme')
  }
  for (const source of ['command', 'picker', 'sdk'] as const) {
    await model($, 'strong')
    await raise(source)
    expect(w.statuses.at(-1), source).toBeUndefined()
  }
  expect(w.toasts).toEqual([])
})

test('the /model typeahead offers klyth aliases and models for the argument token only', () => {
  const config = parseConfig(CONFIG).config as Config
  expect(typeahead(config, '/model st', 7, 'st')).toEqual([{ text: 'strong', description: 'strong generalist (acme/model-b)' }])
  expect(typeahead(config, '/model ', 7, '').map(s => s.text)).toEqual(['acme/model-a', 'acme/model-b', 'acme/small', 'fast', 'strong'])
  expect(typeahead(config, '/model acme/s', 7, 'acme/s')).toEqual([{ text: 'acme/small', description: 'klyth model' }])
  const bare = parseConfig(JSON.stringify({ ...CONFIG_OBJECT, aliases: { quick: 'acme/small' } })).config as Config
  expect(typeahead(bare, '/model q', 7, 'q')).toEqual([{ text: 'quick', description: '(acme/small)' }])
  expect(typeahead(config, 'say h', 4, 'h')).toEqual([])
})

const klyth = ($: Engine) => $.command.run({ command: 'klyth', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('/klyth prints main, two aligned tables (providers with kind, key and approval; aliases), and its gaps through the log, with no model-facing text', async ($, on) => {
  const w = world(on, { version: STAMP.engineVersion })
  await start($)
  await model($, 'strong')
  expect((await klyth($)).text).toBeUndefined()
  expect(w.transcript).toEqual([
    'klyth · main: strong → acme/model-b',
    '  PROVIDER  KIND    ORIGIN                 KEY              APPROVED',
    '  acme      openai  https://klyth.invalid  cmd not yet run  yes',
    '  ALIAS   TARGET        EFFORT           NOTE',
    '  fast    acme/model-a  low medium high  cheap, fast explorer for read-only sweeps',
    '  strong  acme/model-b  low medium high  strong generalist',
    '  routed subagents: none',
    `  schemas: generated on ${STAMP.engineVersion} · OK`,
    '  worktree cleanup: to the Trash (/opt/bin/trash)',
  ])
})

test('/klyth ends with one next step for the first thing wrong: no config, a broken one, a failed key helper', async ($, on) => {
  let text: string | null = null
  const w = world(on, { config: () => text, keyFails: true })
  const nextStep = async () => {
    w.transcript.length = 0
    await klyth($)
    return w.transcript.filter(l => l.startsWith('  next: '))
  }
  await start($)
  expect(w.transcript).toEqual([])
  expect(await nextStep()).toEqual(['  next: copy example.klyth.json to ~/.claude/klyth.json and fill it in, then run /klyth reload'])
  expect(w.transcript[0]).toBe('klyth · routing off: no ~/.claude/klyth.json')
  text = JSON.stringify({ providers: 5 })
  await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(await nextStep()).toEqual(['  next: fix ~/.claude/klyth.json (errors above), then run /klyth reload'])
  expect(w.transcript.slice(0, 2)).toEqual(['klyth · routing off: ~/.claude/klyth.json has errors', '  providers: must be an object'])
  text = CONFIG
  await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await model($, 'strong')
  await step($, { turnId: 'k', index: 0 })
  expect(await nextStep()).toEqual(['  next: acme key helper failed (exit 1): keychain locked, or no key stored? Run klyth auth login api-key acme'])
  expect(w.transcript).toContain('  acme      openai  https://klyth.invalid  cmd failed  yes')
})

test('/klyth names the approval step when the provider is not approved', async ($, on) => {
  const w = world(on, { store: {} })
  await start($)
  await klyth($)
  expect(w.transcript.at(-1)).toBe('  next: run /model fast once to approve acme')
})

test('/klyth reload re-reads the config, re-registers the tool and drops the cached description', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.registered.map(t => t.name)).toEqual(['agent', 'agent'])
  expect(w.registered[0]).toEqual(w.registered[1])
  expect(w.invalidated).toEqual(['tool.describe'])
})

test('a schema stamp from another engine version, and a malformed MCP schema file, are reported by /klyth and toasted never', async ($, on) => {
  const w = world(on, { version: '2.1.300', mcpFile: '[1, 2]' })
  await start($)
  expect(w.toasts).toEqual([])
  await klyth($)
  expect(w.transcript).toContain(`  schemas: generated on ${STAMP.engineVersion} · engine 2.1.300 · regenerate with bun scripts/gen-schemas.ts`)
  expect(w.transcript).toContain('  MCP schemas: hooks/schemas.mcp.gen.json is not a JSON object; MCP tools go out permissive')
  expect(w.transcript.at(-1)).toBe('  next: regenerate the tool schemas with bun scripts/gen-schemas.ts')
})

test('a managed policy allow-list that excludes the provider host is a config error', async ($, on) => {
  const w = world(on, { policy: { sandbox: { network: { allowedDomains: ['api.anthropic.com'] } } } })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual([
    "klyth: routing off, config error: providers.acme.baseUrl: klyth.invalid is not in the managed policy's sandbox.network.allowedDomains. Fix ~/.claude/klyth.json, then run /klyth reload",
  ])
})

test('unreadable managed policy settings are a config error: no host goes unchecked', async ($, on) => {
  const w = world(on, { policy: 'fails' })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^klyth: routing off, config error: the managed policy settings are unreadable \(.+\), so no provider host can be checked against them\. Fix ~\/\.claude\/klyth\.json, then run \/klyth reload$/)
})

test('a managed WebFetch deny with a wildcard domain covering the provider host is a config error', async ($, on) => {
  const w = world(on, { policy: { permissions: { deny: ['WebFetch(domain:*.invalid)'] } } })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual(['klyth: routing off, config error: providers.acme.baseUrl: the managed policy denies WebFetch to klyth.invalid. Fix ~/.claude/klyth.json, then run /klyth reload'])
})

test('tool.describe puts the klyth agent tool in front with its registered description and leaves Agent untouched', async ($, on) => {
  world(on)
  on('tool.describe', ($, e) => ({ description: `${e.description} (beneath)` }))
  expect(await $.tool.describe({ tool: 'mcp__klyth__agent', description: 'advert', provider: { plugin: 'klyth', tier: 'user' } })).toMatchObject({ description: 'advert', isDeferred: false })
  expect(await $.tool.describe({ tool: 'Agent', description: 'native', provider: { plugin: 'engine', tier: 'core' } })).toEqual({ description: 'native (beneath)' })
})

test('a custom CLAUDE_CONFIG_DIR is the path the routing-off messages name, and ~ stands for the home directory under it', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' }, config: JSON.stringify({ providers: 5 }) })
  await start($)
  expect(w.toasts).toEqual(['klyth: routing off, config error: providers: must be an object. Fix /cfg/klyth.json, then run /klyth reload'])
  await klyth($)
  expect(w.transcript.slice(0, 2)).toEqual(['klyth · routing off: /cfg/klyth.json has errors', '  providers: must be an object'])
  expect(w.transcript.at(-1)).toBe('  next: fix /cfg/klyth.json (errors above), then run /klyth reload')
})

test('a config directory under the home directory is shown with ~', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '/home/u/work/claude' }, config: null })
  await start($)
  await klyth($)
  expect(w.transcript[0]).toBe('klyth · routing off: no ~/work/claude/klyth.json')
})

test('with a custom config directory, /model on a known alias after the config breaks names that file', async ($, on) => {
  let text = CONFIG
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' }, config: () => text })
  await start($)
  text = JSON.stringify({ providers: 5 })
  await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(await model($, 'strong')).toEqual({ text: "can't switch to strong: config error, providers: must be an object. Native model unchanged; fix /cfg/klyth.json, then run /klyth reload" })
  expect(w.toasts.at(-1)).toContain('Fix /cfg/klyth.json')
})

test('reload refuses a saved alias remap before outbound routing; explicit model selection replaces the choice', async ($, on) => {
  let config = CONFIG
  const w = world(on, { config: () => config })
  await start($)
  await model($, 'fast')
  config = JSON.stringify({ ...CONFIG_OBJECT, aliases: { ...CONFIG_OBJECT.aliases, fast: 'acme/model-b' } })
  await $.command.run({ command: 'klyth', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  const refused = await step($, { turnId: 'changed', index: 0 })
  expect(refused.result.answer).toContain('No native/provider fallback')
  expect(w.requests).toEqual([])
  expect(w.native).toEqual([])
  expect(w.toasts.at(-1)).toContain('saved main route could not be restored')
  expect(await model($, 'fast')).toEqual({ text: 'Set model to fast (acme/model-b)' })
  const next = await step($, { turnId: 'selected', index: 0 })
  expect(next.result.answer).not.toContain('saved main route')
  expect(w.requests.length).toBe(1)
})

for (const reason of ['clear', 'resume'] as const) test(`${reason} discards ended main usage before selecting a model in the new conversation`, async ($, on) => {
  let id = 'old-conversation'
  const w = world(on, { sessionId: () => id, usageTokens: 0, upstream: () => ({ pieces: [sse({ choices: [{ delta: { content: 'Complete.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 848_000, completion_tokens: 5 } }, '[DONE]')] }) })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  await model($, 'strong')
  await step($, { turnId: 'old-turn', index: 0 })
  expect((await model($, 'strong')).text).toContain('existing context ~848k')
  await $.session.end({ reason, sessionId: id, resume: { id } })
  id = 'new-conversation'
  await $.classic.SessionStart({ source: reason === 'clear' ? 'clear' : 'resume' } as never)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.requests.length).toBe(1)
  expect(w.native).toEqual([])
})
