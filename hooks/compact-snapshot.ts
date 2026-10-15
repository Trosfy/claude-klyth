// Compare public message projections without object-key ordering or opaque engine handles.
import type { SessionCompactInput, SessionMessage, SessionMessagesResult } from 'claude-code'
import type { ApiMessage } from './protocol'

export function stable(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]))
    return v
  }
  return JSON.stringify(normalize(value))
}

const rowData = ({ handle: _handle, toolResults, ...row }: SessionMessage) => ({ ...row, toolResults: toolResults ?? [] })
// Outcomes are populated by the messages getter; compare call identity and input across the two nouns.
const sourceData = (row: SessionMessage) => ({ role: row.role, text: row.text, toolUses: row.toolUses.map(({ tool_use_id, tool, input }) => ({ tool_use_id, tool, input })), toolResults: (row.toolResults ?? []).map(({ tool_use_id, text }) => ({ tool_use_id, text })) })
export const rowSnapshot = (rows: readonly SessionMessage[]) => stable(rows.map(rowData))
export function rowDifference(a: readonly SessionMessage[], b: readonly SessionMessage[], source = false): string | undefined {
  if (a.length !== b.length) return `row count ${a.length} -> ${b.length}`
  const project = source ? sourceData : rowData
  for (let i = 0; i < a.length; i++) {
    const left = project(a[i]!), right = project(b[i]!)
    if (stable(left) !== stable(right)) {
      const fields = Object.keys(left).filter(k => stable((left as Record<string, unknown>)[k]) !== stable((right as Record<string, unknown>)[k]))
      return `row ${i}, role ${a[i]!.role}, fields ${fields.join(',')}`
    }
  }
}
// Core's manual command is visible to the getter but absent from its compact input. Only the exact
// singleton command suffix with an unchanged source prefix is a projection, not a history append.
export function compactSourceRows(e: SessionCompactInput, rows: readonly SessionMessage[]): readonly SessionMessage[] {
  if (e.trigger !== 'manual' || e.agentId !== undefined || rows.length !== e.messages.length + 1) return rows
  const command = rows.at(-1)!
  const expected = `/compact${e.instructions ? ` ${e.instructions}` : ''}`
  if (command.role !== 'user' || command.text !== expected || command.toolUses.length !== 0 || (command.toolResults?.length ?? 0) !== 0) return rows
  const prefix = rows.slice(0, -1)
  return rowDifference(e.messages, prefix, true) === undefined ? prefix : rows
}

export async function compactRows(read: (args: { agentId?: string }) => Promise<SessionMessagesResult>, agentId?: string): Promise<readonly SessionMessage[]> {
  const rows = await read(agentId === undefined ? {} : { agentId })
  if (!Array.isArray(rows)) throw new Error(rows.deny)
  return rows
}

export function apiDifference(a: readonly ApiMessage[], b: readonly ApiMessage[]): string {
  if (a.length !== b.length) return `row count ${a.length} -> ${b.length}`
  const i = a.findIndex((row, index) => stable(row) !== stable(b[index]))
  if (i < 0) return 'snapshot changed'
  const fields = (['role', 'content'] as const).filter(k => stable(a[i]![k]) !== stable(b[i]![k]))
  const role = a[i]!.role === 'user' ? 'user' : a[i]!.role === 'assistant' ? 'assistant' : 'unsupported'
  return `row ${i}, role ${role}, fields ${fields.join(',') || 'metadata'}`
}
