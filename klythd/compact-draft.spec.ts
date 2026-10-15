import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeDraft } from '../scripts/compact-draft'

const fixture = () => {
  const configDir = mkdtempSync(join(realpathSync(tmpdir()), 'klyth-draft-'))
  return { configDir, sessionId: 'engine-session', summary: 'Complete private summary.', target: 'provider/model', sourceMessages: 12, retained: [{ role: 'user', text: 'recent context', toolUses: [] }] }
}

test('private immutable draft contains the complete summary, metadata and bounded retained context', () => {
  const input = fixture()
  const path = storeDraft(input, 'unique')
  expect(path).toBe(join(input.configDir, 'klyth/compactions/engine-session/unique.json'))
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ status: 'draft-not-installed', summary: input.summary, sessionId: input.sessionId, target: input.target, retained: input.retained })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(join(input.configDir, 'klyth')).mode & 0o777).toBe(0o700)
  expect(statSync(join(input.configDir, 'klyth/compactions/engine-session')).mode & 0o777).toBe(0o700)
  expect(() => storeDraft({ ...input, summary: 'overwrite' }, 'unique')).toThrow()
  expect(JSON.parse(readFileSync(path, 'utf8')).summary).toBe(input.summary)
})

test('draft directories never follow a symlink or accept a public directory', () => {
  const input = fixture(), outside = fixture().configDir
  symlinkSync(outside, join(input.configDir, 'klyth'))
  expect(() => storeDraft(input)).toThrow()
  expect(readdirSync(outside)).toEqual([])
  const publicInput = fixture()
  mkdirSync(join(publicInput.configDir, 'klyth'), { mode: 0o755 })
  expect(() => storeDraft(publicInput)).toThrow()
})

test('draft ids cannot escape the session and oversized retained data is rejected', () => {
  const input = fixture()
  expect(() => storeDraft({ ...input, sessionId: '../escape' })).toThrow()
  expect(() => storeDraft(input, '../escape')).toThrow()
  expect(() => storeDraft({ ...input, retained: ['x'.repeat(24_001)] })).toThrow()
})
