// The key path inside klythd: a credential helper runs only for an approved fingerprint (an argv change is a
// new fingerprint, so it needs approval again), its output is trimmed or refused, the key is kept for its
// ttl, steps that need a key at once share one helper run, a failure is remembered as one line naming the
// fix, and reading the key states runs nothing. Also the real helper runner: no shell, and killed past its
// timeout. A provider with auth "none" has no key and runs no helper, yet is still approved first. (The one
// 401/403 retry with a fresh key lives in step.ts and is pinned in step.spec.ts.)
import { expect, test } from 'bun:test'

import { fingerprint, parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import { createKeys, isUsableKey } from './auth'
import type { Runner } from './auth'
import { runHelper } from './main'

const HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'klyth', '-a', 'acme', '-w']
const KEY = 'sk-klyth-test-0123456789abcdef'
const configOf = (command: readonly string[], ttlSeconds = 300) =>
  parseConfig(JSON.stringify({ providers: { acme: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: { command, ttlSeconds }, models: { m: { contextWindow: 1000, maxOutputTokens: 100 } } } } }))
    .config as Config
const CONFIG = configOf(HELPER)
const ACME = CONFIG.providers['acme'] as ProviderConfig
const APPROVED = new Set([fingerprint(ACME)])
const FREE = (parseConfig(JSON.stringify({ providers: { acme: { kind: 'openai', baseUrl: 'https://klyth.invalid/v1', auth: 'none', models: { m: { contextWindow: 1000, maxOutputTokens: 100 } } } } })).config as Config)
  .providers['acme'] as ProviderConfig

// Keys over a runner answering `answer` (an Error rejects) and a clock reading `h.ms`; every run recorded.
function keys(answer: () => { exitCode: number; stdout: string; stderr?: string } | Error = () => ({ exitCode: 0, stdout: `${KEY}\n` })) {
  const h = { runs: [] as { argv: readonly string[]; timeoutMs: number }[], ms: 0 }
  const run: Runner = async (argv, timeoutMs) => {
    h.runs.push({ argv, timeoutMs })
    const r = answer()
    if (r instanceof Error) throw r
    return r
  }
  return { h, k: createKeys(run, () => h.ms) }
}

test('an approved provider runs its helper once, with no shell and a 10 s bound, and its key is kept for its ttl', async () => {
  const { h, k } = keys()
  expect(await k.get(ACME, APPROVED)).toEqual({ key: KEY, cached: false })
  expect(await k.get(ACME, APPROVED)).toEqual({ key: KEY, cached: true })
  expect(h.runs).toEqual([{ argv: HELPER, timeoutMs: 10_000 }])
  h.ms = 299_999
  expect(await k.get(ACME, APPROVED)).toMatchObject({ cached: true })
  h.ms = 300_000
  expect(await k.get(ACME, APPROVED)).toMatchObject({ cached: false })
  expect(h.runs).toHaveLength(2)
})

test('an unapproved provider never runs its helper, and an edited argv is a new fingerprint that needs approval again', async () => {
  const { h, k } = keys()
  expect(await k.get(ACME, new Set())).toEqual({ error: 'klyth: acme not approved — run /model <alias> to approve it' })
  const edited = configOf([...HELPER, '--extra']).providers['acme'] as ProviderConfig
  expect(fingerprint(edited)).not.toBe(fingerprint(ACME))
  expect(await k.get(edited, APPROVED)).toEqual({ error: 'klyth: acme not approved — run /model <alias> to approve it' })
  expect(h.runs).toEqual([])
})

test('a keyless provider has no key and runs no helper, however often it is asked; its status reads none', async () => {
  const { h, k } = keys()
  const approved = new Set([fingerprint(FREE)])
  expect(await k.get(FREE, approved)).toEqual({ key: null, cached: false })
  expect(await k.get(FREE, approved)).toEqual({ key: null, cached: false })
  expect(k.status({ providers: { acme: FREE }, aliases: {} })).toEqual([{ provider: 'acme', key: 'none' }])
  k.drop(FREE)
  k.prune(new Set())
  expect(await k.get(FREE, approved)).toEqual({ key: null, cached: false })
  expect(h.runs).toEqual([])
})

test('an unapproved keyless provider is still refused, and the approval of the same origin with a helper does not cover it', async () => {
  const { h, k } = keys()
  const refused = { error: 'klyth: acme not approved — run /model <alias> to approve it' }
  expect(fingerprint(FREE)).toBe('openai|https://klyth.invalid|none')
  expect(await k.get(FREE, new Set())).toEqual(refused)
  expect(await k.get(FREE, APPROVED)).toEqual(refused)
  expect(await k.get(ACME, new Set([fingerprint(FREE)]))).toEqual(refused)
  expect(h.runs).toEqual([])
})

test('a helper that fails, does not finish or prints no usable key fails with one line naming the fix, remembered for status', async () => {
  const UNUSABLE = 'klyth: acme key helper printed no usable key (empty, over 4 KiB, or holding spaces, control or non-ASCII characters); run bun run auth login acme'
  const cases: [{ exitCode: number; stdout: string; stderr?: string } | Error, string][] = [
    [{ exitCode: 1, stdout: '' }, 'klyth: acme key helper failed (exit 1): keychain locked, or no key stored? Run bun run auth login acme'],
    [{ exitCode: 1, stdout: '', stderr: '' }, 'klyth: acme key helper failed (exit 1): keychain locked, or no key stored? Run bun run auth login acme'],
    [{ exitCode: 3, stdout: '', stderr: 'the sign-in expired; run bun run auth login acme --chatgpt' }, 'klyth: acme key helper failed (exit 3): the sign-in expired; run bun run auth login acme --chatgpt'],
    [{ exitCode: 3, stdout: '', stderr: 'klyth auth: the sign-in expired; run bun run auth login acme --chatgpt' }, 'klyth: acme key helper failed (exit 3): the sign-in expired; run bun run auth login acme --chatgpt'],
    [new Error(`timed out after 10000 ms\n${KEY}`), 'klyth: acme key helper did not finish (Error: timed out after 10000 ms); unlock the keychain or fix auth.command, then retry'],
    [{ exitCode: 0, stdout: '\n' }, UNUSABLE],
    [{ exitCode: 0, stdout: 'two words\n' }, UNUSABLE],
    [{ exitCode: 0, stdout: 'sk-a\u0007b' }, UNUSABLE],
    [{ exitCode: 0, stdout: 'sk-a\u200bb' }, UNUSABLE],
    [{ exitCode: 0, stdout: 'sk-a€b' }, UNUSABLE],
    [{ exitCode: 0, stdout: 'k'.repeat(4097) }, UNUSABLE],
  ]
  for (const [answer, text] of cases) {
    const { k } = keys(() => answer)
    expect(await k.get(ACME, APPROVED)).toEqual({ error: text })
    expect(text).not.toContain('\n')
    expect(k.status(CONFIG)).toEqual([{ provider: 'acme', key: 'failed', failure: text }])
  }
  const { k } = keys(() => ({ exitCode: 0, stdout: `  ${'k'.repeat(4096)}\n` }))
  expect(await k.get(ACME, APPROVED)).toEqual({ key: 'k'.repeat(4096), cached: false })
})

test('status reads cached, not run and failed without running anything; prune and drop forget keys', async () => {
  const { h, k } = keys()
  expect(k.status(CONFIG)).toEqual([{ provider: 'acme', key: 'not-run' }])
  await k.get(ACME, APPROVED)
  expect(k.status(CONFIG)).toEqual([{ provider: 'acme', key: 'cached' }])
  expect(h.runs).toHaveLength(1)
  k.drop(ACME)
  expect(k.status(CONFIG)).toEqual([{ provider: 'acme', key: 'not-run' }])
  await k.get(ACME, APPROVED)
  k.prune(new Set())
  expect(k.status(CONFIG)).toEqual([{ provider: 'acme', key: 'not-run' }])
  expect(h.runs).toHaveLength(2)
})

test('steps asking for a key at the same moment share one helper run, and its failure; a later ask runs it again', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const h = { runs: 0 }
  const run: Runner = async () => (h.runs++, await gate, { exitCode: 0, stdout: `${KEY}\n` })
  const k = createKeys(run, () => 0)
  const asks = [k.get(ACME, APPROVED), k.get(ACME, APPROVED), k.get(ACME, APPROVED)]
  release()
  expect(await Promise.all(asks)).toEqual([{ key: KEY, cached: false }, { key: KEY, cached: false }, { key: KEY, cached: false }])
  expect(h.runs).toBe(1)
  k.drop(ACME)
  expect(await k.get(ACME, APPROVED)).toEqual({ key: KEY, cached: false })
  expect(h.runs).toBe(2)

  const down = keys(() => ({ exitCode: 1, stdout: '' }))
  const both = await Promise.all([down.k.get(ACME, APPROVED), down.k.get(ACME, APPROVED)])
  expect(both[0]).toEqual(both[1])
  expect(down.h.runs).toHaveLength(1)
  expect(await down.k.get(ACME, APPROVED)).toHaveProperty('error')
  expect(down.h.runs).toHaveLength(2)
})

test('a usable key is one visible-ASCII token of at most 4 KiB', () => {
  for (const ok of ['sk-a', 'k'.repeat(4096), 'a.b_c~d+e/f=g', '"\\']) expect(isUsableKey(ok)).toBe(true)
  for (const bad of ['', ' ', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u200bb', 'a€b', 'aéb', 'k'.repeat(4097)]) expect(isUsableKey(bad)).toBe(false)
})

test('the real runner runs the argv with no shell, gives stdout, the exit code and the first line of stderr, and kills a helper past its timeout', async () => {
  expect(await runHelper(['/bin/echo', 'a b', '$HOME'], 5000)).toEqual({ exitCode: 0, stdout: 'a b $HOME\n', stderr: '' })
  expect(await runHelper(['/bin/sh', '-c', 'exit 3'], 5000)).toEqual({ exitCode: 3, stdout: '', stderr: '' })
  const started = performance.now()
  await expect(runHelper(['/bin/sleep', '5'], 200)).rejects.toThrow('timed out after 200 ms')
  expect(performance.now() - started).toBeLessThan(2000)
  await expect(runHelper(['/no/such/helper'], 1000)).rejects.toThrow()
})

test('the real runner keeps the first line of a helper\'s stderr, redacted and cut at 120 characters, and drains a megabyte of it', async () => {
  const noisy = `{ printf 'failed Bearer abcdef0123456789 '; yes word | head -n 60 | tr '\\n' ' '; printf '\\nsecond line\\n'; } >&2; exit 3`
  const r = await runHelper(['/bin/sh', '-c', noisy], 5000)
  expect(r.exitCode).toBe(3)
  expect(r.stderr).toStartWith('failed Bearer [REDACTED] word word')
  expect(r.stderr).toHaveLength(120)
  expect(r.stderr).not.toContain('second line')
  expect(await runHelper(['/bin/sh', '-c', 'echo sk-0123456789abcdef >&2'], 5000)).toMatchObject({ stderr: '[REDACTED]' })
  const started = performance.now()
  expect(await runHelper(['/bin/sh', '-c', 'yes x | head -c 1048576 >&2; echo key'], 5000)).toEqual({ exitCode: 0, stdout: 'key\n', stderr: 'x' })
  expect(performance.now() - started).toBeLessThan(3000)
})
