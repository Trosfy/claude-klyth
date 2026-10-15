// The engine's transcript as every codec reads it: Messages-shaped, holding text, image, tool_use and tool_result
// blocks only. The engine's thinking is dropped, and the signed thinking blocks klythd kept for an assistant turn
// are put back where they came in that turn, as is each klyth agent call the host ran as an Agent call; a
// tool_reference, document or other block is named as text; a tool_result whose tool_use the window does not hold
// is dropped; cache_control and every other field go; an image is a text note for a model without vision. Pure.
import { isObject } from '../hooks/config'
import { PRODUCT } from '../hooks/product'
import type { ApiMessage } from '../hooks/protocol'
import { blocksOf, str } from '../hooks/transcript'

export type Text = { type: 'text'; text: string }
export type Image = { type: 'image'; source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string } }
type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type ToolResult = { type: 'tool_result'; tool_use_id: string; content: (Text | Image)[]; is_error: boolean }
// A thinking block as the model sent it, to be sent back whole: its text and signature, the data of a
// redacted one, or a Responses reasoning item (its id and encrypted content).
export type Thinking = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string } | { type: 'reasoning'; id: string; encrypted_content: string }
// A thinking block and its place in its turn: how many of the turn's text and tool_use blocks came before it.
export type Placed = { at: number; block: Thinking }
// `unsealed` marks an assistant turn with tool calls whose thinking blocks were asked for and not held.
export type Message = { role: 'user' | 'assistant'; content: (Text | Image | ToolUse | ToolResult | Thinking)[]; unsealed?: true }

// A text, image or other block as text or image; anything but text and an image (with vision) is named.
function part(b: Record<string, unknown>, vision: boolean): Text | Image {
  if (b['type'] === 'text') return { type: 'text', text: str(b['text']) }
  if (b['type'] === 'image') {
    if (!vision) return { type: 'text', text: '[image omitted: model has no vision]' }
    const s = isObject(b['source']) ? b['source'] : {}
    return { type: 'image', source: s['type'] === 'url' ? { type: 'url', url: str(s['url']) } : { type: 'base64', media_type: str(s['media_type']), data: str(s['data']) } }
  }
  if (b['type'] === 'document') return { type: 'text', text: '[document omitted]' }
  if (b['type'] === 'tool_reference') return { type: 'text', text: `[tool loaded: ${str(b['tool_name'])}]` }
  return { type: 'text', text: `[${str(b['type'])} block omitted]` }
}

// `content` with each thinking block placed after the blocks it came after; one placed past the end goes last.
const interleave = (content: Message['content'], held: readonly Placed[]): Message['content'] => [
  ...content.flatMap((b, i) => [...held.filter(p => p.at === i).map(p => p.block), b]),
  ...held.filter(p => p.at >= content.length).map(p => p.block),
]

// The transcript normalized. `remoteId` gives the provider's own id behind an id klyth minted for one of its
// calls, which goes out in its place. `sealed`, when given, gives the thinking blocks of the turn that made a
// call; a turn with calls and none held is marked `unsealed`. `messageBlocks`, when it gives a message's blocks,
// is asked first (a text-only turn has no call to find them by). `agent` gives a klyth agent call's input as the
// provider made it, which goes out as that call whatever the transcript names it.
export function normalize(messages: readonly ApiMessage[], vision: boolean, remoteId: (id: string) => string | undefined, sealed?: (id: string) => readonly Placed[] | undefined, messageBlocks?: (message: ApiMessage) => readonly Placed[] | undefined, agent?: (id: string) => Record<string, unknown> | undefined): Message[] {
  const out: Message[] = []
  const seen = new Set<string>()
  for (const msg of messages) {
    const content: Message['content'] = []
    let call: string | undefined
    for (const b of blocksOf(msg)) {
      const type = b['type']
      if (type === 'thinking' || type === 'redacted_thinking') continue
      if (msg.role === 'assistant') {
        if (type === 'text') content.push({ type: 'text', text: str(b['text']) })
        else if (type === 'tool_use') {
          const id = str(b['id'])
          seen.add(id)
          call ??= id
          const made = agent?.(id)
          content.push({ type: 'tool_use', id: remoteId(id) ?? id, name: made === undefined ? str(b['name']) : PRODUCT.qualifiedTool, input: made ?? (isObject(b['input']) ? b['input'] : {}) })
        }
      } else if (type === 'tool_result') {
        const id = str(b['tool_use_id'])
        if (!seen.has(id)) continue
        const raw = b['content']
        const parts = (typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : []).filter(isObject).map(c => part(c, vision))
        content.push({ type: 'tool_result', tool_use_id: remoteId(id) ?? id, content: parts, is_error: b['is_error'] === true })
      } else content.push(part(b, vision))
    }
    const blocks = messageBlocks?.(msg) ?? (call === undefined ? undefined : sealed?.(call))
    if (content.length > 0) out.push({ role: msg.role, content: blocks === undefined ? content : interleave(content, blocks), ...(call !== undefined && sealed !== undefined && blocks === undefined ? { unsealed: true as const } : {}) })
  }
  return out
}

// The provider's own id behind each tool call klyth minted, given back only to the provider that made it (another
// kind may reject its form); kept for the daemon's life, so no other loop's calls can push one out.
export function remoteIds() {
  const ids = new Map<string, { provider: string; id: string }>()
  return {
    remember: (provider: string, minted: string, id: string) => ids.set(minted, { provider, id }),
    of: (provider: string) => (minted: string) => {
      const hit = ids.get(minted)
      return hit?.provider === provider ? hit.id : undefined
    },
  }
}
