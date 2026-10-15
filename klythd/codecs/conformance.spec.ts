// The codec conformance suite. Every response under fixtures/<kind>/<scenario>.<ext> is decoded whole and
// split at random byte offsets (a character split included), and must give the events its
// <scenario>.expected.json holds (text deltas merged, minted ids numbered). Every kind holds the shared
// invariants: exactly one stop or error, last; a tool_use only whole, its input an object; usage mapped;
// an error text one line. A kind with no fixture directory is skipped.
//
//   bun test klythd                      KLYTH_WRITE_EXPECTED=1 bun test klythd/codecs   (rewrites expected.json)
import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { KINDS } from '../../hooks/config'
import type { Kind, ProviderConfig } from '../../hooks/config'
import type { StepEvent } from '../../hooks/protocol'
import { coalesce } from '../../hooks/step'
import { remoteIds } from '../history'
import { assembler } from '../step'
import { CODECS } from '.'

const DIR = join(import.meta.dir, 'fixtures')
const P = { id: 'p' } as ProviderConfig

// A response's events, its bytes fed in pieces cut at `cuts`.
function decode(kind: Kind, bytes: Uint8Array, cuts: readonly number[]): StepEvent[] {
  const codec = CODECS[kind]
  if (codec === undefined) throw new Error(`no ${kind} codec`)
  let n = 0
  const asm = assembler(codec, P.id, remoteIds(), () => `toolu_klyth_${String(++n).padStart(24, '0')}`)
  const decoder = codec.decoder()
  const out: StepEvent[] = []
  let at = 0
  for (const cut of [...cuts, bytes.length]) {
    out.push(...asm.feed(decoder.feed(bytes.subarray(at, cut))))
    at = cut
  }
  out.push(...asm.feed(decoder.end()), ...asm.end(P).events)
  return coalesce(out)
}

// A deterministic stream of numbers in [0, 1).
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function invariants(events: readonly StepEvent[]) {
  const ends = events.filter(e => e.type === 'stop' || e.type === 'error')
  expect(ends).toHaveLength(1)
  expect(events.at(-1)).toBe(ends[0] as StepEvent)
  for (const e of events) {
    if (e.type === 'tool_use') {
      expect(e.name).not.toBe('')
      expect(typeof e.input === 'object' && e.input !== null && !Array.isArray(e.input)).toBe(true)
      expect(e.id).toMatch(/^toolu_klyth_\d{24}$/)
    }
    if (e.type === 'usage') for (const n of [e.in, e.out, e.cacheRead, e.cacheWrite]) expect(Number.isInteger(n) && n >= 0).toBe(true)
    if (e.type === 'error') {
      expect(e.text).toMatch(/^klyth: /)
      expect(e.text).not.toContain('\n')
    }
  }
}

for (const kind of Object.keys(KINDS) as Kind[]) {
  const dir = join(DIR, kind)
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir).filter(f => !f.endsWith('.json')).sort()) {
    const scenario = file.slice(0, file.lastIndexOf('.'))
    test(`${kind}/${scenario}: decoded whole and split anywhere, it gives its expected events and holds the invariants`, () => {
      const bytes = new Uint8Array(readFileSync(join(dir, file)))
      const whole = decode(kind, bytes, [])
      const expectedPath = join(dir, `${scenario}.expected.json`)
      if (process.env['KLYTH_WRITE_EXPECTED'] === '1') writeFileSync(expectedPath, `${JSON.stringify(whole, null, 2)}\n`)
      expect(whole).toEqual(JSON.parse(readFileSync(expectedPath, 'utf8')) as StepEvent[])
      invariants(whole)
      const next = random(scenario.length * 7919)
      for (let trial = 0; trial < 25; trial++) {
        const cuts = Array.from({ length: 1 + Math.floor(next() * 6) }, () => Math.floor(next() * bytes.length)).sort((a, b) => a - b)
        expect(decode(kind, bytes, cuts)).toEqual(whole)
      }
    })
  }
}
