// Cache-only repair of attested SendMessage resume seams. Opening wrappers move, with every LF,
// to their own delivery user turns in the provider copy; host history and permission memory stay whole.
import type { Origin, ToolCallResult } from 'claude-code'

import type { Route } from '../types'
import { isFork } from './agents'
import type { ApiMessage } from './protocol'
import { blocksOf } from './transcript'
import { isObject } from './config'

type Block = ReturnType<typeof blocksOf>[number]
type Delivery = { raw: string; size: number; confirmed: boolean; turn?: string; ambiguous?: true; at?: { index: number; digest: string }; wrapper?: Block }
type Opening = { head: ApiMessage; task: number; prompt: string; completed: boolean; revision: number; boundary: number; size: number; prefix?: string; ledger: Delivery[]; delivery?: Delivery }
const MAX_LOOPS = 64
const MAX_BYTES = 2 * 1024 * 1024
const MAX_HEAD = 64 * 1024
const MAX_DELIVERY = 32 * 1024
const MAX_SEAMS = 32
// A million-token provider context can occupy several MiB. Hashing is transient; only digests stay.
const MAX_PREFIX = 4 * 1024 * 1024
const MAX_MESSAGES = 4096
const bytes = (text: string) => new TextEncoder().encode(text).length
const ordinary = (route: Route | undefined) => route?.target != null && route.forkOf === undefined && !isFork(route.type) && route.refused === undefined
const once = (text: string, raw: string) => text.indexOf(raw) >= 0 && text.indexOf(raw, text.indexOf(raw) + raw.length) < 0

// Abort serialization before copying an oversized string or visiting an unbounded number of values.
function boundedJson(value: unknown, limit: number): string | undefined {
  try {
    let room = limit
    const text = JSON.stringify(value, (key, item: unknown) => {
      room -= key.length + (typeof item === 'string' ? item.length : 32) + 4
      if (room < 0) throw new Error('cache history bound')
      return item
    })
    if (text === undefined || bytes(text) > limit) return undefined
    return text
  } catch { return undefined }
}

async function digest(value: unknown, limit: number): Promise<string | undefined> {
  const text = boundedJson(value, limit)
  if (text === undefined) return undefined
  try {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text).buffer as ArrayBuffer))).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch { return undefined }
}

// The one raw-text user turn for a delivery. Tool results never qualify, even when they quote it.
function deliveryIndex(messages: readonly ApiMessage[], raw: string, start: number): number | undefined {
  let index: number | undefined
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const blocks = blocksOf(m)
    if (blocks.length > MAX_MESSAGES) return undefined
    let count = 0
    for (const b of blocks) if (b.type === 'text' && b['text'] === raw && ++count > 1) return undefined
    if (count === 0) continue
    if (count !== 1 || index !== undefined || messages[i - 1]?.role !== 'assistant') return undefined
    index = i
  }
  return index
}

export function createCacheHistory(hash = digest) {
  const openings = new Map<string, Opening>(), dropped = new Map<string, number>() // loop → its latest drop, while no save made after it succeeded
  let used = 0, drops = 0
  const drop = (opening: Opening) => {
    if (opening.delivery !== undefined) used -= opening.delivery.size
    delete opening.delivery
  }
  return {
    clear() { openings.clear(); used = 0 },
    snapshot(who: string): unknown { const opening = openings.get(who); return opening === undefined ? undefined : { version: 1, opening: structuredClone(opening) } },
    // Puts back an opening `snapshot` gave, where memory holds none; a value that is not a whole opening, or past the loop bound, throws.
    restore(who: string, value: unknown) {
      const o = isObject(value) && value.version === 1 && isObject(value.opening) ? value.opening : undefined
      const deliveries = o !== undefined && Array.isArray(o.ledger) ? [...o.ledger, ...(o.delivery === undefined ? [] : [o.delivery])] : undefined
      if (o === undefined || deliveries === undefined || openings.has(who) || openings.size >= MAX_LOOPS || !isObject(o.head) || o.head.role !== 'user' || !Array.isArray(o.head.content) || typeof o.prompt !== 'string' || !Number.isInteger(o.task) || !Number.isInteger(o.boundary) || !Number.isInteger(o.revision) || typeof o.completed !== 'boolean' || typeof o.size !== 'number' || !deliveries.every(d => isObject(d) && typeof d.raw === 'string' && typeof d.confirmed === 'boolean' && typeof d.size === 'number')) throw new Error('klyth: the saved cache-history opening is not a whole one')
      const opening = structuredClone(o) as unknown as Opening
      openings.set(who, opening)
      used += opening.size + opening.ledger.reduce((sum, d) => sum + d.size, 0) + (opening.delivery?.size ?? 0)
    },
    invalidate(who: string | undefined) {
      if (who === undefined) return
      dropped.set(who, ++drops)
      const opening = openings.get(who)
      if (opening === undefined) return
      used -= opening.size + opening.ledger.reduce((sum, d) => sum + d.size, 0)
      drop(opening)
      openings.delete(who)
    },
    tracked(who: string) { return openings.has(who) },
    // A loop whose opening memory dropped (its drop's mark): its saved copy is stale until a save that began after that drop succeeds.
    invalidated(who: string) { return dropped.get(who) },
    saved(who: string, mark: number | undefined) { if (dropped.get(who) === mark) dropped.delete(who) },
    epoch() { return drops }, // changes with every drop: a restore that read state across one puts nothing back
    // Only the exact ordinary task, seen before completion, establishes an opening. Restored
    // histories, compaction summaries and forks cannot bootstrap a baseline from a resume wrapper.
    // Observational reads validate and normalize the same seam without claiming a turn or recording it.
    async read(who: string | undefined, route: Route | undefined, messages: readonly ApiMessage[], turn: string, debug: (text: string) => void, observe = false): Promise<readonly ApiMessage[]> {
      if (who === undefined || !ordinary(route) || route?.prompt === undefined) return messages
      const head = messages[0]
      if (head?.role !== 'user' || typeof head.content === 'string' || head.content.length > MAX_MESSAGES) return messages
      let opening = openings.get(who)
      if (opening === undefined) {
        if (observe) return messages
        const tasks = head.content.flatMap((b, i) => b.type === 'text' && b['text'] === route.prompt ? [i] : [])
        const encoded = boundedJson(head, MAX_HEAD)
        if (encoded === undefined) return messages
        const size = bytes(encoded) + bytes(route.prompt) + 64 // reserved completed-prefix digest
        if (tasks.length !== 1 || messages.length !== 1 || openings.size >= MAX_LOOPS || size > MAX_HEAD || used + size > MAX_BYTES) return messages
        opening = { head: JSON.parse(encoded) as ApiMessage, task: tasks[0]!, prompt: route.prompt, completed: false, revision: 0, boundary: messages.length, size, ledger: [] }
        openings.set(who, opening)
        used += size
      }
      const delivery = opening.delivery
      if (delivery === undefined) {
        if (!observe) { opening.completed = false; opening.revision++ }
        return messages
      }
      if (!observe && delivery.turn === undefined) { delivery.turn = turn; opening.completed = false; opening.revision++ }
      const revision = opening.revision
      const baseline = blocksOf(opening.head)
      const current = head.content
      const task = current[opening.task]
      const extras = current.slice(baseline.length)
      const lf = task?.type === 'text' && task['text'] === opening.prompt + '\n'
      const contains = extras.some(b => b.type === 'text' && typeof b['text'] === 'string' && once(b['text'], delivery.raw))
      const note = (reason: string) => debug(`klyth cache-seam ${who} pending=${!delivery.confirmed} confirmed=${delivery.confirmed} headLF=${lf} containment=${contains} apply=${reason}`)
      if (!delivery.confirmed || delivery.ambiguous || (delivery.turn !== undefined && delivery.turn !== turn) || opening.prompt !== route.prompt) { note('unattested'); return messages }
      if (!lf || !contains || extras.length === 0 || extras.length > MAX_SEAMS) { note('head'); return messages }
      const restored = current.slice(0, baseline.length).map((b, i) => i === opening!.task ? { ...b, text: opening!.prompt } : b)
      if (boundedJson({ ...head, content: restored }, MAX_HEAD) !== boundedJson(opening.head, MAX_HEAD)) { note('changed'); return messages }
      if (opening.prefix === undefined || messages.length > MAX_MESSAGES || messages.length < opening.boundary || await hash(messages.slice(1, opening.boundary), MAX_PREFIX) !== opening.prefix) { note('prefix'); return messages }
      const records = [...opening.ledger, delivery]
      const moves: { index: number; block: Block; record: Delivery; fingerprint: string; encoded: string }[] = []
      for (const extra of extras) {
        if (extra.type !== 'text' || typeof extra['text'] !== 'string') { note('wrapper'); return messages }
        const matches = records.filter(d => d.confirmed && !d.ambiguous && once(extra['text'] as string, d.raw))
        const record = matches[0]
        if (matches.length !== 1 || record === undefined || moves.some(m => m.record === record)) { note('wrapper'); return messages }
        const encoded = boundedJson(extra, MAX_DELIVERY)
        if (encoded === undefined) { note('bounds'); return messages }
        if (record.wrapper !== undefined && encoded !== JSON.stringify(record.wrapper) && encoded !== JSON.stringify({ ...record.wrapper, text: String(record.wrapper['text']) + '\n' })) { note('wrapper'); return messages }
        const index = deliveryIndex(messages, record.raw, record === delivery ? opening.boundary : record.at?.index ?? messages.length)
        if (index === undefined || index <= (moves.at(-1)?.index ?? 0)) { note('tail'); return messages }
        const fingerprint = await hash(messages[index], MAX_PREFIX)
        if (fingerprint === undefined || (record.at !== undefined && (record.at.index !== index || record.at.digest !== fingerprint))) { note('delivery'); return messages }
        moves.push({ index, block: extra, record, fingerprint, encoded })
      }
      const active = moves.find(m => m.record === delivery)
      if (active === undefined || openings.get(who) !== opening || opening.revision !== revision || opening.delivery !== delivery || delivery.ambiguous || !delivery.confirmed) { note('unattested'); return messages }
      const added = delivery.wrapper === undefined ? bytes(active.encoded) : 0
      if (used + added > MAX_BYTES) { note('bounds'); return messages }
      if (!observe && delivery.wrapper === undefined) {
        delivery.wrapper = JSON.parse(active.encoded) as Block
        delivery.size += added
        used += added
      }
      if (!observe) delivery.at = { index: active.index, digest: active.fingerprint }
      note('moved')
      // The task's single displaced LF belongs before the earliest moved wrapper. Any LF the host
      // appended to an older wrapper travels with that wrapper, preserving all text at its own turn.
      return messages.map((m, i) => {
        if (i === 0) return { ...m, content: restored }
        const move = moves.find(x => x.index === i)
        return move === undefined ? m : { ...m, content: [{ ...move.block, text: (move === moves[0] ? '\n' : '') + move.block['text'] }, ...blocksOf(m)] }
      })
    },
    async complete(who: string, messages: readonly ApiMessage[]) {
      const opening = openings.get(who)
      if (opening === undefined) return
      const revision = ++opening.revision
      const delivery = opening.delivery
      if (delivery?.confirmed && !delivery.ambiguous && delivery.at !== undefined && delivery.wrapper !== undefined) {
        opening.ledger.push(delivery)
        delete opening.delivery
      } else drop(opening)
      opening.completed = false
      delete opening.prefix
      const prefix = messages.length > MAX_MESSAGES ? undefined : await hash(messages.slice(1), MAX_PREFIX)
      if (openings.get(who) !== opening || opening.revision !== revision || prefix === undefined) return
      opening.prefix = prefix
      opening.completed = true
      opening.boundary = messages.length
    },
    // The key was observed as an engine turn.step agentId, not a name claimed in message text.
    // Finished resumable children need not appear in the current roster. This memory grants no permission.
    begin(to: unknown, raw: unknown, origin: Origin, route: Route | undefined): (() => void) | undefined {
      if (typeof to !== 'string' || to === 'main') return undefined
      const opening = openings.get(to)
      if (opening === undefined || typeof raw !== 'string' || raw.length === 0 || origin.plugin !== 'engine' || origin.tier !== 'core' || !ordinary(route)) return undefined
      if (opening.delivery !== undefined) { opening.delivery.ambiguous = true; return undefined }
      const size = bytes(raw) + 64 // reserved delivery-message digest
      if (!opening.completed || opening.ledger.length >= MAX_SEAMS || size > MAX_DELIVERY || used + size > MAX_BYTES) return undefined
      const delivery: Delivery = { raw, size, confirmed: false }
      opening.delivery = delivery
      used += size
      return () => { delivery.confirmed = true }
    },
    failed(to: unknown) {
      if (typeof to !== 'string') return
      const opening = openings.get(to)
      if (opening !== undefined) drop(opening)
    },
  }
}

// A successful continuation preserves its result verbatim; failure provides no delivery attestation.
export const delivered = (result: ToolCallResult) => result.deny === undefined && result.isError !== true && 'result' in result
