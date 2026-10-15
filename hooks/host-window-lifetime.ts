// Session-held ownership crosses clear/resume through one bounded process-environment handoff.
// The handoff exists only between the ending session and its successor; it is not a persisted baseline.
import { applyHostWindow, type HostWindowPort, type HostWindowState } from './host-window'

type Held = { value: HostWindowState | undefined; version: number }
type Handoff = { sessionId: string; reason: 'clear' | 'resume'; owner: Exclude<HostWindowState, null> }
export type HostWindowLifetimePort = HostWindowPort & {
  sessionId(): Promise<string>
  handoff(): Promise<string | undefined>
  setHandoff(value: string | undefined): Promise<void>
}

function handoffOf(text: string): Handoff | undefined {
  if (text.length > 8192) return undefined
  try {
    const h = JSON.parse(text)
    if (!h || typeof h !== 'object' || Array.isArray(h) || Object.keys(h).sort().join() !== 'owner,reason,sessionId') return undefined
    if (typeof h.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(h.sessionId) || (h.reason !== 'clear' && h.reason !== 'resume')) return undefined
    const o = h.owner
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join() !== (o.pending === true ? 'applied,original,pending' : 'applied,original')) return undefined
    if (o.original !== null && (typeof o.original !== 'string' || o.original.length > 1024)) return undefined
    if (typeof o.applied !== 'string' || !/^[0-9]{6,7}$/.test(o.applied) || Number(o.applied) < 100_000 || Number(o.applied) > 1_000_000 || String(Number(o.applied)) !== o.applied) return undefined
    return h
  } catch {
    return undefined
  }
}
const same = (a: HostWindowState | undefined, b: Exclude<HostWindowState, null>) => a != null && a.original === b.original && a.applied === b.applied && a.pending === b.pending

export function createHostWindowCoordinator() {
  const active = new Set<Promise<void>>()
  let blocked = false
  let ending: string | undefined, latest: { sessionId: string; held: Held } | undefined
  const note = (io: HostWindowLifetimePort) => io.debug('klyth host compaction window: handoff unavailable or changed; policy left unchanged; restart Claude Code to recover')
  const tracked = (io: HostWindowLifetimePort, sessionId: string): HostWindowLifetimePort => ({
    ...io,
    setState: async (value, version) => {
      const saved = await io.setState(value, version)
      if (saved.isSet && (latest?.sessionId !== sessionId || saved.version > latest.held.version)) latest = { sessionId, held: { value, version: saved.version } }
      return saved
    },
  })

  // A seed returns its written version explicitly: another get in this dispatch still sees the old snapshot.
  async function seed(io: HostWindowLifetimePort, sessionId: string): Promise<Held | undefined> {
    const held = await io.state(), text = await io.handoff()
    if (text === undefined) return held
    const h = handoffOf(text)
    if (!h || h.sessionId === sessionId) { note(io); return undefined }
    let seeded = held
    if (held.value === undefined) {
      if (await io.handoff() !== text) { note(io); return undefined }
      const saved = await io.setState(h.owner, held.version)
      if (!saved.isSet) { note(io); return undefined }
      seeded = { value: h.owner, version: saved.version }
    } else if (!same(held.value, h.owner)) {
      note(io)
      return undefined
    }
    // env has no CAS. Consume only the observed exact marker after ownership is safely in session state.
    if (await io.handoff() !== text) { note(io); return undefined }
    await io.setHandoff(undefined)
    return seeded
  }

  return {
    async start(io: HostWindowLifetimePort): Promise<void> {
      try {
        const sessionId = await io.sessionId()
        if (blocked || ending === sessionId) return
        const held = await seed(tracked(io, sessionId), sessionId)
        if (held) ending = undefined
      } catch { note(io) }
    },
    apply(io: HostWindowLifetimePort, window: number | false | undefined): Promise<void> {
      const work = (async () => {
        try {
          const sessionId = await io.sessionId()
          if (blocked || ending === sessionId) { note(io); return }
          const port = tracked(io, sessionId), held = await seed(port, sessionId)
          if (!held) return
          ending = undefined
          await applyHostWindow({ ...port, state: async () => held }, window)
        } catch { note(io) }
      })()
      active.add(work)
      void work.finally(() => active.delete(work))
      return work
    },
    async end(io: HostWindowLifetimePort, reason: string, sessionId: string): Promise<void> {
      if (reason !== 'clear' && reason !== 'resume') return
      ending = sessionId
      try {
        if (await io.sessionId() !== sessionId) { blocked = true; note(io); return }
        // Drain admitted policy decisions, then fence their versions before the engine disposes this state.
        await Promise.all(active)
        const snapshot = await io.state()
        const held = latest?.sessionId === sessionId && latest.held.version > snapshot.version ? latest.held : snapshot
        if (await io.handoff() !== undefined) { blocked = true; note(io); return }
        const saved = await io.setState(held.value ?? null, held.version)
        if (!saved.isSet) { blocked = true; note(io); return }
        if (!held.value) return
        const text = JSON.stringify({ sessionId, reason, owner: held.value })
        if (!handoffOf(text) || await io.handoff() !== undefined) { blocked = true; note(io); return }
        await io.setHandoff(text)
      } catch { blocked = true; note(io) }
    },
  }
}
