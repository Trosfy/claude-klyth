// A routed step's events as the engine's turn.step chunks: block indexes, coalesced deltas, tool calls,
// and the end, which is one stop carrying the usage, or a failure answered as text or, for a subagent
// offered SubagentHandback, as one call of it. Pure.
import type { TurnStepChunk, TurnStepToolUse, TurnUsage } from 'claude-code'

import { mintToolId } from './protocol'
import type { StepEvent, StopReason } from './protocol'

type Failure = { kind: 'request' | 'response'; text: string }
// The step's end: its last chunks (the stop among them, last), what it answered, and the failure text when
// it failed.
type StepEnd = { chunks: TurnStepChunk[]; answer: string; toolUses: TurnStepToolUse[]; stopReason: StopReason; usage: TurnUsage | null; failure?: string; delivered?: true }

// Adjacent text deltas merged into one, and adjacent thinking deltas likewise, so what arrives together
// reaches the engine as one chunk.
export function coalesce(events: readonly StepEvent[]): StepEvent[] {
  const out: StepEvent[] = []
  for (const ev of events) {
    const last = out.at(-1)
    if ((ev.type === 'text' || ev.type === 'thinking') && (last?.type === 'text' || last?.type === 'thinking') && last.type === ev.type) {
      out[out.length - 1] = { type: ev.type, text: last.text + ev.text }
    } else out.push(ev)
  }
  return out
}

// One step's chunks, built as its events come. A text or thinking delta continues the open block of its
// kind, else opens one at the next index; a tool call takes the next index and closes the open block. Usage
// is reported as `usageModel`'s.
export function createAssembler(usageModel: string) {
  let next = 0
  let open: { type: 'text' | 'thinking'; index: number } | undefined
  let answer = ''
  const toolUses: TurnStepToolUse[] = []
  let usage: TurnUsage | null = null
  let reason: StopReason | undefined
  let failure: Failure | undefined

  return {
    feed(ev: StepEvent): TurnStepChunk[] {
      if (ev.type === 'text' || ev.type === 'thinking') {
        if (open?.type !== ev.type) open = { type: ev.type, index: next++ }
        if (ev.type === 'text') answer += ev.text
        return [{ kind: ev.type, index: open.index, text: ev.text }]
      }
      if (ev.type === 'tool_use') {
        const index = next++
        open = undefined
        toolUses.push({ name: ev.name, input: ev.input })
        return [
          { kind: 'tool', index, id: ev.id, name: ev.name },
          { kind: 'input', index, json: JSON.stringify(ev.input) },
        ]
      }
      if (ev.type === 'usage') usage = { input_tokens: ev.in, output_tokens: ev.out, cache_read_input_tokens: ev.cacheRead, cache_creation_input_tokens: ev.cacheWrite, model: usageModel }
      else if (ev.type === 'stop') reason = ev.reason
      else if (ev.type === 'error') failure ??= { kind: ev.kind, text: ev.text }
      return []
    },
    // Ends the step: a stop, `tool_use` whenever a tool call was yielded. A failure (the events' error, or
    // `failure` in its place) takes the next index as text; a request failure goes instead as one call of
    // `handback` when one is named and no tool call was yielded. A failed step reports no usage.
    end(o: { handback?: string; failure?: string; deliver?: boolean } = {}): StepEnd {
      const failed: Failure | undefined =
        o.failure !== undefined
          ? { kind: 'request', text: o.failure }
          : (failure ?? (reason === undefined ? { kind: 'request', text: `klyth: ${usageModel} ended the step with no stop; retry` } : undefined))
      if (failed === undefined) {
        const stopReason = toolUses.length > 0 ? 'tool_use' : reason === 'tool_use' || reason === undefined ? 'end_turn' : reason
        // `deliver`: a text-only successful end is handed back as one call of `handback` carrying the text.
        if (o.deliver === true && o.handback !== undefined && toolUses.length === 0 && stopReason === 'end_turn' && answer.trim() !== '') {
          const index = next++
          open = undefined
          const input = { message: answer }
          toolUses.push({ name: o.handback, input })
          const chunks: TurnStepChunk[] = [
            { kind: 'tool', index, id: mintToolId(), name: o.handback },
            { kind: 'input', index, json: JSON.stringify(input) },
            { kind: 'stop', stopReason: 'tool_use', usage },
          ]
          return { chunks, answer, toolUses: [...toolUses], stopReason: 'tool_use', usage, delivered: true }
        }
        return { chunks: [{ kind: 'stop', stopReason, usage }], answer, toolUses: [...toolUses], stopReason, usage }
      }
      const index = next++
      open = undefined
      const chunks: TurnStepChunk[] = []
      if (failed.kind === 'request' && o.handback !== undefined && toolUses.length === 0) {
        const input = { message: failed.text }
        chunks.push({ kind: 'tool', index, id: mintToolId(), name: o.handback }, { kind: 'input', index, json: JSON.stringify(input) })
        toolUses.push({ name: o.handback, input })
      } else {
        chunks.push({ kind: 'text', index, text: failed.text })
        answer += failed.text
      }
      usage = null
      const stopReason = toolUses.length > 0 ? 'tool_use' : 'end_turn'
      chunks.push({ kind: 'stop', stopReason, usage: null })
      return { chunks, answer, toolUses: [...toolUses], stopReason, usage: null, failure: failed.text }
    },
  }
}
