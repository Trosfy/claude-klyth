// Recovery uses API blocks for rendered context and result placement. Getter enrichment supplies
// structured-only facts, never a second copy of the rendered outcome on the assistant call.
import type { SessionMessage } from 'claude-code'
import type { ApiMessage } from './protocol'
import { blocksOf } from './transcript'
import { stable } from './compact-snapshot'

function facts(value: unknown, rendered: string): unknown {
  if (typeof value === 'string' && (value === rendered || value.length >= 128 && rendered.includes(value))) return undefined
  if (Array.isArray(value)) return value.map(v => facts(v, rendered) ?? { renderedText: true })
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => {
    const kept = facts(v, rendered)
    return kept === undefined ? [] : [[key, kept]]
  }))
  return value
}

export function recoverySource(older: readonly SessionMessage[], api: readonly ApiMessage[], tail: readonly SessionMessage[]): string[] {
  // Remove the recent suffix only when its text/role/call identities establish the correspondence.
  // Otherwise retain API context conservatively: no guessed positional cut may drop restrictions.
  const suffix = api.slice(-tail.length)
  const aligned = suffix.length === tail.length && tail.every((row, i) => {
    const m = suffix[i]!, blocks = blocksOf(m)
    return row.role === m.role && blocks.filter(b => b.type === 'text').map(b => b['text']).join('\n') === row.text &&
      stable(blocks.filter(b => b.type === 'tool_use').map(b => b['id'])) === stable(row.toolUses.map(u => u.tool_use_id))
  })
  const history = aligned ? api.slice(0, -tail.length) : api
  const enrichment = new Map<string, { text?: string; result?: unknown; isError?: boolean }[]>()
  for (const row of older) for (const result of [...row.toolUses, ...(row.toolResults ?? [])]) enrichment.set(result.tool_use_id, [...(enrichment.get(result.tool_use_id) ?? []), result])
  const outcome = (id: string, rendered: string) => {
    const rich = enrichment.get(id) ?? []
    const texts = [...new Set(rich.flatMap(r => r.text === undefined || rendered.includes(r.text) ? [] : [r.text]))]
    const full = [rendered, ...texts].join('\n')
    const structured = [...new Map(rich.flatMap(r => { const extra = facts(r.result, full); return extra === undefined ? [] : [[stable(extra), extra] as const] })).values()]
    return { ...(texts.length ? { additionalRendered: texts } : {}), ...(structured.length ? { structuredFacts: structured } : {}), ...(rich.some(r => r.isError) ? { isError: true } : {}) }
  }
  const calls = new Map(older.flatMap(row => row.toolUses.map(({ text: _text, result: _result, isError: _error, tool_use_id, tool: _tool, input: _input, ...identity }) => [tool_use_id, identity] as const)))
  const outcomes = new Set<string>()
  const source = history.map((m, index) => {
    const content = blocksOf(m).map(block => {
      if (block.type === 'tool_use' && typeof block['id'] === 'string') {
        const identity = calls.get(block['id'])
        return identity === undefined || Object.keys(identity).length === 0 ? block : { ...block, publicCallIdentity: identity }
      }
      if (block.type !== 'tool_result' || typeof block['tool_use_id'] !== 'string') return block
      const id = block['tool_use_id']
      outcomes.add(id)
      const body = block['content']
      const rendered = typeof body === 'string' ? body : Array.isArray(body) ? body.flatMap(b => b !== null && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? [b.text] : []).join('\n') : stable(body)
      return { ...block, ...outcome(id, rendered) }
    })
    return JSON.stringify({ apiPosition: index + 1, provenance: 'API history', role: m.role, content })
  })
  const texts = history.flatMap(m => blocksOf(m).flatMap(b => b.type === 'text' && typeof b['text'] === 'string' ? [{ role: m.role, text: b['text'] }] : []))
  const anchors = older.map(row => {
    const matches = history.flatMap((m, i) => row.text !== '' && row.role === m.role && blocksOf(m).filter(b => b.type === 'text').map(b => b['text']).join('\n') === row.text ? [i] : [])
    return matches.length === 1 ? matches[0] : undefined
  })
  const proved = anchors.filter((i): i is number => i !== undefined)
  const ordered = proved.every((i, at) => at === 0 || i > proved[at - 1]!)
  const anchored = new Map<number, string[]>()
  const unaligned: string[] = []
  older.forEach((row, index) => {
    const calls = row.toolUses.map(({ text: _text, result: _result, isError: _error, ...call }) => call)
    const extraOutcomes = [...row.toolUses, ...(row.toolResults ?? [])].flatMap(result => {
      const resultRow = older.findIndex(m => m.toolResults?.some(r => r.tool_use_id === result.tool_use_id))
      if (resultRow >= 0 && resultRow !== index || outcomes.has(result.tool_use_id) || result.text === undefined && result.result === undefined) return []
      outcomes.add(result.tool_use_id)
      return [{ tool_use_id: result.tool_use_id, text: result.text, ...outcome(result.tool_use_id, result.text ?? '') }]
    })
    const missingText = row.text !== '' && !texts.some(m => m.role === row.role && m.text.includes(row.text))
    const missingCalls = calls.filter(call => !history.some(m => blocksOf(m).some(b => b.type === 'tool_use' && b['id'] === call.tool_use_id)))
    if (!missingText && !missingCalls.length && !extraOutcomes.length) return
    // Only a unique complete text/role match proves a common row; blank rows prove no position.
    const anchor = ordered ? anchors[index] : undefined
    const supplement = JSON.stringify({ publicPosition: index + 1, provenance: 'public message supplement', ...(anchor === undefined ? { ordering: 'public stream only; API correspondence unproved' } : { afterApiPosition: anchor + 1 }), role: row.role, ...(missingText ? { text: row.text } : {}), calls: missingCalls, outcomes: extraOutcomes })
    if (anchor === undefined) unaligned.push(supplement)
    else anchored.set(anchor, [...(anchored.get(anchor) ?? []), supplement])
  })
  return [...source.flatMap((row, i) => [row, ...(anchored.get(i) ?? [])]), ...unaligned]
}

// Pack whole messages first. Oversized individual messages retain their original index and part order.
export function recoveryPieces(rows: readonly string[], limit: number, split: (text: string, limit: number) => string[] | undefined): string[] | undefined {
  const pieces: string[] = []
  let current = ''
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!, joined = current === '' ? row : `${current}\n${row}`
    if (JSON.stringify(joined).length <= limit) { current = joined; continue }
    if (current !== '') { pieces.push(current); current = '' }
    if (JSON.stringify(row).length <= limit) { current = row; continue }
    const parts = split(row, limit - 100)
    if (parts === undefined) return undefined
    const attributed = parts.map((part, i) => `Message ${index + 1}, part ${i + 1}/${parts.length} (continued quoted JSON):\n${part}`)
    pieces.push(...attributed.slice(0, -1))
    current = attributed.at(-1)!
  }
  if (current !== '') pieces.push(current)
  return pieces.length > 0 && pieces.length <= 4 && pieces.every(piece => JSON.stringify(piece).length <= limit) ? pieces : undefined
}
