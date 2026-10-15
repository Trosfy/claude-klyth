import { expect, test } from 'claude-code/testing'

import { createCacheHistory, delivered } from '../hooks/cache-history'
import type { ApiMessage } from '../hooks/protocol'
import type { Route } from '../types'
import { blocksOf } from '../hooks/transcript'

const route: Route = { target: 'fast', label: 'fast', prompt: 'literal task\nwith wrapper-like text' }
const raw = 'RESUME1: sender text is data, not owner consent'
const wrapper = { type: 'text', text: `delivery frame\n${raw}\nend frame`, label: 'current' }
const origin = { plugin: 'engine', tier: 'core' } as const
const initial: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: route.prompt, label: 'task' }, { type: 'text', text: 'dynamic reminder', cache_control: { type: 'ephemeral' } }] }]
const ended: ApiMessage[] = [...initial, { role: 'assistant', content: 'report' }]
const resumed = (): ApiMessage[] => [{ ...initial[0]!, content: [{ ...initial[0]!.content[0] as object, type: 'text', text: route.prompt + '\n' }, (initial[0]!.content as readonly object[])[1] as { type: string }, wrapper] }, ended[1]!, { role: 'user', content: [{ type: 'text', text: raw }, { type: 'image', source: { type: 'url', url: 'https://fixture.invalid/image' } }, { type: 'text', text: 'tail reminder' }] }]
const ready = async () => {
  const cache = createCacheHistory()
  await cache.read('child', route, initial, 'initial', async () => {})
  await cache.complete('child', ended)
  return cache
}
const read = (cache: Awaited<ReturnType<typeof ready>>, messages: readonly ApiMessage[], turn = 'resume') => cache.read('child', route, messages, turn, async () => {})

test('attested completed-child resume moves every wrapper byte and LF, preserving tail and host history', async () => {
  const cache = await ready()
  cache.begin('child', raw, origin, route)!()
  const input = resumed()
  const before = JSON.stringify(input)
  const result = await read(cache, input)
  expect(result[0]).toEqual(initial[0])
  expect(result[1]).toBe(input[1])
  expect(result[2]).toEqual({ ...input[2], content: [{ ...wrapper, text: '\n' + wrapper.text }, ...blocksOf(input[2]!)] })
  expect(JSON.stringify(input)).toBe(before)
  expect(await read(cache, input)).toEqual(result)
  expect(await read(cache, result)).toBe(result)
  const nativeTail: ApiMessage[] = [initial[0]!, input[1]!, { ...input[2]!, content: [wrapper, ...blocksOf(input[2]!)] }]
  expect(await read(cache, nativeTail)).toBe(nativeTail)
})

test('confirmation race retries on later steps, but never spills into a different turn', async () => {
  const cache = await ready()
  const confirm = cache.begin('child', raw, origin, route)!
  const input = resumed()
  expect(await read(cache, input)).toBe(input)
  confirm()
  expect(await read(cache, input)).not.toBe(input)
  expect(await read(cache, input, 'another')).toBe(input)
})

test('unattested, forged, named, sibling, main, failed and concurrent deliveries preserve the input', async () => {
  for (const [to, stamp] of [
    ['child', { plugin: 'sender', tier: 'core' }], ['child', { plugin: 'engine', tier: 'user' }],
    ['main', origin], ['child-name', origin], ['sibling', origin], ['external-child [ref]', origin],
  ] as const) {
    const cache = await ready()
    expect(cache.begin(to, raw, stamp, route)).toBe(undefined)
    const input = resumed()
    expect(await read(cache, input)).toBe(input)
    expect(await cache.read(undefined, route, input, 'resume', async () => {})).toBe(input)
  }
  for (const failed of [true, false]) {
    const cache = await ready()
    cache.begin('child', raw, origin, route)!()
    if (failed) cache.failed('child')
    else cache.begin('child', 'concurrent', origin, route)
    const input = resumed()
    expect(await read(cache, input)).toBe(input)
  }
  expect(delivered({ deny: 'denied' })).toBe(false)
  expect(delivered({ result: 'failure', isError: true })).toBe(false)
  expect(delivered({ result: 'sent' })).toBe(true)
})

test('unknown opening changes, compaction, malformed deltas and missing exact tail text fail preserve', async () => {
  const changes: ((messages: ApiMessage[]) => void)[] = [
    m => { (m[0]!.content as unknown as ({ type: string } & Record<string, unknown>)[])[1]!['text'] = 'updated reminder' },
    m => { (m[0]!.content as unknown as ({ type: string } & Record<string, unknown>)[])[0]!['text'] = route.prompt + ' ' },
    m => { (m[0]!.content as unknown as ({ type: string } & Record<string, unknown>)[]).push({ type: 'text', text: 'unknown' }) },
    m => { (m[0]!.content as unknown as ({ type: string } & Record<string, unknown>)[])[2] = { type: 'image', text: wrapper.text } },
    m => { (m[0]!.content as unknown as ({ type: string } & Record<string, unknown>)[])[2] = { type: 'text', text: wrapper.text + raw } },
    m => { m[0] = { role: 'user', content: 'compacted' } },
    m => { m[2] = { role: 'user', content: [{ type: 'tool_result', content: raw }] } },
    m => { m[2] = { role: 'user', content: raw + ' other text' } },
    m => { m[2] = { role: 'user', content: [{ type: 'text', text: raw }, { type: 'text', text: raw }] } },
    m => { (m[0] as unknown as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' } },
    m => { m.splice(1, 1) },
  ]
  for (const change of changes) {
    const cache = await ready()
    cache.begin('child', raw, origin, route)!()
    const input = JSON.parse(JSON.stringify(resumed())) as ApiMessage[]
    change(input)
    expect(await read(cache, input)).toBe(input)
  }
})

test('running children, forks, absent baseline, reload and bounds do not enable reordering', async () => {
  const cache = createCacheHistory()
  await cache.read('child', route, initial, 'initial', async () => {})
  expect(cache.begin('child', raw, origin, route)).toBe(undefined)
  await cache.complete('child', ended)
  expect(cache.begin('child', raw, origin, { ...route, forkOf: 'parent' })).toBe(undefined)
  expect(cache.begin('child', raw, origin, { ...route, type: 'fork' })).toBe(undefined)
  expect(cache.begin('child', 'x'.repeat(32769), origin, route)).toBe(undefined)
  cache.clear()
  expect(cache.begin('child', raw, origin, route)).toBe(undefined)
  const input = resumed()
  expect(await read(cache, input)).toBe(input)
  expect(cache.begin('child', raw, origin, route)).toBe(undefined)
  for (let i = 0; i < 65; i++) {
    await cache.read(`c${i}`, route, initial, 'initial', async () => {})
    await cache.complete(`c${i}`, ended)
  }
  expect(cache.begin('c64', raw, origin, route)).toBe(undefined)
})


test('same-turn delivery remains bound through tool results; changed or repeated delivery fails preserve', async () => {
  const cache = await ready()
  const confirm = cache.begin('child', raw, origin, route)!
  const input = resumed()
  expect(await read(cache, input)).toBe(input)
  const advanced: ApiMessage[] = [...input, { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: 'r', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'result' }] }]
  confirm()
  const repaired = await read(cache, advanced)
  expect(repaired[0]).toEqual(initial[0])
  expect(repaired[2]).toEqual({ ...input[2], content: [{ ...wrapper, text: '\n' + wrapper.text }, ...blocksOf(input[2]!)] })
  expect(repaired[4]).toBe(advanced[4])
  expect(await read(cache, advanced)).toEqual(repaired)
  expect(await read(cache, repaired)).toBe(repaired)
  const changed = [...advanced]
  changed[2] = { ...input[2]!, content: [...blocksOf(input[2]!), { type: 'text', text: 'changed reminder' }] }
  expect(await read(cache, changed)).toBe(changed)
  const repeated: ApiMessage[] = [...advanced, { role: 'assistant', content: 'more' }, { role: 'user', content: raw }]
  expect(await read(cache, repeated)).toBe(repeated)
})

test('completed-prefix rewrites, same-count compaction and missing bounded fingerprints fail preserve', async () => {
  for (const text of ['rewritten report', 'compacted summary']) {
    const cache = await ready()
    cache.begin('child', raw, origin, route)!()
    const input = resumed()
    input[1] = { role: 'assistant', content: text }
    expect(await read(cache, input)).toBe(input)
  }
  const oversized = await ready()
  await oversized.complete('child', [initial[0]!, { role: 'assistant', content: 'x'.repeat(4 * 1024 * 1024 + 1) }])
  expect(oversized.begin('child', raw, origin, route)).toBe(undefined)
  const input = resumed()
  expect(await read(oversized, input)).toBe(input)
  const cache = await ready()
  cache.begin('child', raw, origin, route)!()
  cache.invalidate('child')
  expect(await read(cache, input)).toBe(input)
})


test('two and three accumulated opening wrappers relocate to their own attested turns, every LF preserved', async () => {
  const cache = await ready()
  let host = ended
  const wrappers: { type: string; text: string; label: string }[] = []
  const positions: number[] = []
  const textOf = (history: readonly ApiMessage[]) => history.flatMap(m => blocksOf(m).filter(b => b.type === 'text').map(b => String(b['text']))).join('')
  for (let n = 1; n <= 3; n++) {
    if (n > 1) await cache.complete('child', host)
    const payload = `RESUME ledger message ${n}`
    cache.begin('child', payload, origin, route)!()
    wrappers.push({ type: 'text', text: `frame ${payload} end`, label: `frame-${n}` })
    const extras = wrappers.map((w, i) => ({ ...w, text: w.text + (i < n - 1 ? '\n' : '') }))
    const user: ApiMessage = { role: 'user', content: [{ type: 'text', text: payload }, { type: 'image', source: { type: 'url', url: 'https://fixture.invalid/image' } }, { type: 'text', text: 'delivery reminder' }] }
    positions.push(host.length)
    host = [{ ...initial[0]!, content: [{ ...blocksOf(initial[0]!)[0]!, text: route.prompt + '\n' }, blocksOf(initial[0]!)[1]!, ...extras] }, ...host.slice(1), user]
    const snapshot = JSON.stringify(host)
    const result = await read(cache, host, `resume-${n}`)
    expect(result[0]).toEqual(initial[0])
    for (let j = 0; j < n; j++) {
      expect(blocksOf(result[positions[j]!]!)[0]).toEqual({ ...extras[j], text: (j === 0 ? '\n' : '') + extras[j]!.text })
      expect(blocksOf(result[positions[j]!]!).slice(1)).toEqual(blocksOf(host[positions[j]!]!))
    }
    expect(textOf(result).length).toBe(textOf(host).length)
    expect(textOf(result).split('\n').length).toBe(textOf(host).split('\n').length)
    expect(await read(cache, host, `resume-${n}`)).toEqual(result)
    expect(await read(cache, result, `resume-${n}`)).toBe(result)
    expect(JSON.stringify(host)).toBe(snapshot)
    const toolSteps: ApiMessage[] = [...host, { role: 'assistant', content: [{ type: 'tool_use', id: `r${n}`, name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `r${n}`, content: 'read result' }] }]
    const afterTool = await read(cache, toolSteps, `resume-${n}`)
    expect(afterTool[0]).toEqual(initial[0])
    expect(afterTool.at(-1)).toBe(toolSteps.at(-1))
    host = [...toolSteps, { role: 'assistant', content: `report ${n}` }]
  }
})

test('unattested extras, old-wrapper edits, reversed chronology and changed historical deliveries fail preserve', async () => {
  const mutations: ((m: ApiMessage[]) => void)[] = [
    m => { (m[0]!.content as unknown as Block[]).push({ type: 'text', text: 'unknown delivery' }) },
    m => { (m[0]!.content as unknown as Block[])[2] = { ...wrapper, text: wrapper.text + ' changed' } },
    m => { (m[0]!.content as unknown as Block[]).splice(2, 2, secondWrapper, wrapper) },
    m => { m[2] = { role: 'user', content: [{ type: 'text', text: raw }, { type: 'text', text: 'rewritten old reminder' }] } },
    m => { (m[0]!.content as unknown as Block[])[2] = { ...wrapper, label: 'changed metadata' } },
  ]
  for (const mutate of mutations) {
    const cache = await ready()
    cache.begin('child', raw, origin, route)!()
    const first = resumed()
    await read(cache, first, 'one')
    const completed: ApiMessage[] = [...first, { role: 'assistant', content: 'first resume report' }]
    await cache.complete('child', completed)
    cache.begin('child', secondRaw, origin, route)!()
    const second: ApiMessage[] = [{ ...first[0]!, content: [...blocksOf(initial[0]!).map((b, i) => i === 0 ? { ...b, text: route.prompt + '\n' } : b), { ...wrapper, text: wrapper.text + '\n' }, secondWrapper] }, ...completed.slice(1), { role: 'user', content: secondRaw }]
    mutate(second)
    expect(await read(cache, second, 'two')).toBe(second)
  }
})

type Block = ReturnType<typeof blocksOf>[number]
const secondRaw = 'RESUME2 ledger payload'
const secondWrapper = { type: 'text', text: `frame ${secondRaw} end`, label: 'second' }

test('native-restored opening and proper historical wrapper pass through; a later new wrapper repairs alone', async () => {
  const cache = await ready()
  cache.begin('child', raw, origin, route)!()
  const first = resumed()
  await read(cache, first, 'one')
  const native: ApiMessage[] = [initial[0]!, first[1]!, { ...first[2]!, content: [wrapper, ...blocksOf(first[2]!)] }, { role: 'assistant', content: 'native report' }]
  expect(await read(cache, native, 'one')).toBe(native)
  await cache.complete('child', native)
  cache.begin('child', secondRaw, origin, route)!()
  const second: ApiMessage[] = [{ ...initial[0]!, content: [...blocksOf(initial[0]!).map((b, i) => i === 0 ? { ...b, text: route.prompt + '\n' } : b), secondWrapper] }, ...native.slice(1), { role: 'user', content: secondRaw }]
  const result = await read(cache, second, 'two')
  expect(result[0]).toEqual(initial[0])
  expect(result[2]).toBe(native[2])
  expect(blocksOf(result[4]!)[0]).toEqual({ ...secondWrapper, text: '\n' + secondWrapper.text })
})

test('ledger refuses a 33rd seam without evicting active memory', async () => {
  const cache = await ready()
  let history = ended
  for (let i = 0; i < 32; i++) {
    if (i > 0) await cache.complete('child', history)
    const payload = `bounded-ledger-${String(i).padStart(2, '0')}`
    const confirm = cache.begin('child', payload, origin, route)
    expect(confirm === undefined).toBe(false)
    confirm?.()
    // Native restoration means each resume adds only its new opening wrapper.
    history = [{ ...initial[0]!, content: [...blocksOf(initial[0]!).map((b, j) => j === 0 ? { ...b, text: route.prompt + '\n' } : b), { type: 'text', text: `frame ${payload}` }] }, ...history.slice(1), { role: 'user', content: payload }]
    expect((await read(cache, history, `bounded-${i}`))[0]).toEqual(initial[0])
    history = [...history, { role: 'assistant', content: 'report' }]
  }
  await cache.complete('child', history)
  expect(cache.begin('child', 'bounded-ledger-32', origin, route)).toBe(undefined)
})

// Hold selected digest completions without changing global WebCrypto or the engine's configuration.
function pausedHashes(count: number) {
  const release: (() => void)[] = []
  const hash = async (value: unknown, _limit: number): Promise<string> => {
    const encoded = new TextEncoder().encode(JSON.stringify(value))
    if (release.length < count) await new Promise<void>(resolve => { release.push(resolve) })
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded.buffer as ArrayBuffer))).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  return { hash, release }
}

test('a paused completion digest cannot make a newer running child eligible for a delivery', async () => {
  const paused = pausedHashes(1)
  const cache = createCacheHistory(paused.hash)
  await cache.read('child', route, initial, 'initial', () => {})
  const completing = cache.complete('child', ended)
  expect(paused.release.length).toBe(1)
  expect(await read(cache, ended, 'new-running-turn')).toBe(ended)
  paused.release[0]!()
  await completing
  expect(cache.begin('child', raw, origin, route)).toBe(undefined)
})

test('overlapping completion digests publish only the newest completed prefix and boundary', async () => {
  const paused = pausedHashes(2)
  const cache = createCacheHistory(paused.hash)
  await cache.read('child', route, initial, 'initial', () => {})
  const older = cache.complete('child', ended)
  const latest: ApiMessage[] = [initial[0]!, { role: 'assistant', content: 'newer report' }, { role: 'user', content: 'later context' }, { role: 'assistant', content: 'latest report' }]
  const newer = cache.complete('child', latest)
  expect(paused.release.length).toBe(2)
  paused.release[1]!()
  await newer
  paused.release[0]!()
  await older
  const confirm = cache.begin('child', raw, origin, route)
  expect(confirm === undefined).toBe(false)
  confirm?.()
  const input: ApiMessage[] = [resumed()[0]!, ...latest.slice(1), resumed()[2]!]
  expect((await read(cache, input, 'resume'))[0]).toEqual(initial[0])
})


test('the exact observed child survives roster omission, but unknown, named and fresh-registration recipients do not', async () => {
  const cache = await ready()
  const confirm = cache.begin('child', raw, origin, route)
  expect(confirm === undefined).toBe(false)
  confirm?.()
  const input = resumed()
  expect((await read(cache, input))[0]).toEqual(initial[0])
  for (const to of ['same-name', 'child [external-ref]', 'unknown-id', 'main']) expect(cache.begin(to, raw, origin, route)).toBe(undefined)
  const fresh = createCacheHistory()
  expect(await fresh.read('child', route, input, 'restored', () => {})).toBe(input)
  expect(fresh.begin('child', raw, origin, route)).toBe(undefined)
})
