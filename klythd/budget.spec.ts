// The line budgets that keep the code lean: hooks modules stay within 400 lines except for the measured
// register override below; klythd production (everything but specs and fixtures) stays within 1,586 lines (1,150 until prompt caching,
// signed thinking carry-over and the alias overlay's merge layer arrived; 1,235 until thinking blocks kept in
// their place, a byte-bounded thinking store, the idle limit for long caches and the second cache mark did; 1,300
// until a failed decoder ending its request, the cut token dropped before redaction and the escaped debug line did;
// 1,320 until the openai-responses codec, the ChatGPT plan-usage error fixes and the key helper's stderr line did;
// 1,470 until the ChatGPT identity overrides did; 1,471 until the classifier's per-request bound did; 1,480 until the resends after a failure before any body byte did; 1,518 until salted outbound request fingerprints did; 1,546 until bounded first-item block fingerprints did; 1,586 for the single-owner streamed retry lifecycle, explicit non-replay boundary and shared policy-error classification. Usage evidence, bounded summaries and finality validation add 65 daemon lines, for 1,651 total. The 29-line register growth covers usage ports, lifecycle wiring and state CAS checks, measured at 427 lines. Native pane opening, rendering and session-guarded preference retries add 28 lines, for 455. PR0 adds 20 register lines for human approval ports and native pane events (475 total), and 21 rules lines for lexical/resolved artifact recognition and routine-only timeout instructions (417 total). Per-session response records (the memory and file stores, anchor lookup and capture, the Responses prompt_cache_key) add 227 daemon lines, for 1,878.
// Native entry export adds two daemon lines (1,880 total). Klyth agent calls kept as the provider made them (their call records and their rendering back) add 9 daemon lines (1,889 total). Session replay binding and setup add 70 register lines (545 total). The optional request-header seam and source/compiled version binding add two daemon lines (1,891 total). Removing the default whole-request cap removes one daemon line (1,890 total).
// Session launcher installation and setup handoff add two register lines (547 total). Launcher engine ports add seven register lines (554 total).
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const lines = (path: string) => readFileSync(join(root, path), 'utf8').split('\n').length - 1
const files = (dir: string) => readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.gen.ts') && !f.includes('fixtures'))

test('hooks modules stay within their measured line budgets', () => {
  const limit = (file: string) => file === 'register.ts' ? 554 : file === 'classifier-rules.ts' ? 417 : 400
  const over = files('hooks').flatMap(file => (lines(`hooks/${file}`) > limit(file) ? [`${file}: ${lines(`hooks/${file}`)} > ${limit(file)}`] : []))
  expect(over).toEqual([])
})

test("klythd's production code stays within its measured 1,890-line budget", () => {
  expect(files('klythd').reduce((sum, file) => sum + lines(`klythd/${file}`), 0)).toBeLessThanOrEqual(1890)
})
