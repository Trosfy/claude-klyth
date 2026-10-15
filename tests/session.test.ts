// The classifier's memory in the session: what a subagent's end forgets of it, and what a config reload drops.
import { expect, test } from 'claude-code/testing'

import { createSession } from '../hooks/session'

const TOKEN = { source: 'model-fresh' as const, until: 1, step: 1, cwd: '/work' }
const key = (who: string) => `${who}\nEdit\n{}`

test("a subagent's end forgets the actions classified for it and its tokens, and no other loop's", () => {
  const s = createSession()
  for (const who of ['main', 'a1', 'a10']) {
    s.classified.set(who, { count: 1, asked: new Set([key(who)]) })
    s.tokens.set(key(who), TOKEN)
    s.sessionId(who)
    s.vettedSpawns.add(who)
    s.offered.set(who, new Set(['Edit']))
    s.routedSteps.set(who, 1)
    s.steps.set(`${who}:t:0`, { target: 'fast' })
  }
  const id = s.sessionId('a1')
  s.forget('a1')
  expect(s.sessionId('a1')).toBe(id)
  expect([...s.classified.keys()]).toEqual(['main', 'a10'])
  expect([...s.tokens.keys()]).toEqual([key('main'), key('a10')])
  expect([...s.vettedSpawns]).toEqual(['main', 'a10'])
  expect([...s.offered.keys()]).toEqual(['main', 'a10'])
  expect([...s.routedSteps.keys()]).toEqual(['main', 'a10'])
  expect([...s.steps.keys()]).toEqual(['main:t:0', 'a10:t:0'])
})

test("a subagent's end forgets that its spawn was vetted, and no other subagent's; a config reload keeps them", () => {
  const s = createSession()
  for (const who of ['a1', 'a10']) s.vettedSpawns.add(who)
  s.resetForReload()
  s.forget('a1')
  expect([...s.vettedSpawns]).toEqual(['a10'])
})

test('a config reload drops the classifier tokens, and keeps what the running turn and the person typed need', () => {
  const s = createSession()
  s.tokens.set(key('main'), TOKEN)
  s.classified.set('main', { count: 2, asked: new Set([key('main')]) })
  s.prompts.push('fix the typo')
  s.classifierInFlight = 1
  const epoch = s.dropEpoch
  s.resetForReload()
  expect([s.tokens.size, s.classified.get('main')?.count, s.prompts, s.classifierInFlight, s.dropEpoch]).toEqual([0, 2, ['fix the typo'], 1, epoch + 1])
})

test("a subagent's end forgets its last routed request, and no other loop's; a config reload keeps them", () => {
  const s = createSession()
  for (const who of ['main', 'a1', 'a10']) s.sent.set(who, { target: 'fast', system: 'SYSTEM PROMPT', tools: [] })
  s.forget('a1')
  expect([...s.sent.keys()]).toEqual(['main', 'a10'])
  s.resetForReload()
  expect([...s.sent.keys()]).toEqual(['main', 'a10'])
})

test("each loop's session id survives completion and config reload, but a new registration starts fresh", () => {
  const s = createSession()
  const loops = ['main', 'a1', 'a10']
  const ids = loops.map(who => s.sessionId(who))
  expect(new Set(ids).size).toBe(3)
  s.resetForReload()
  expect(loops.map(who => s.sessionId(who))).toEqual(ids)
  for (let n = 0; n < 2; n++) {
    s.forget('a1')
    expect(loops.map(who => s.sessionId(who))).toEqual(ids)
  }
  const fresh = createSession()
  expect(fresh.sessionIds.size).toBe(0)
  loops.forEach((who, n) => expect(fresh.sessionId(who)).not.toBe(ids[n]))
})
