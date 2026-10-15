// The provider transport: one fetch per request over Bun's keep-alive pool. https only (http too where the
// provider allows it), no redirect followed, a TCP connect check bounded at 15 s, a stall window from the
// request until the headers and between reads, and an optional bound on the whole request. Aborting `signal` (the
// client went away), even before the request starts, cancels it; `cancel` ends an answer whose body was
// never read. Bun's own 300 s idle cut is off: the stall window replaces it.
import { MAX_TIMEOUT_MS } from '../hooks/config'
import { CONNECT_TIMEOUT_S } from './errors'
import type { Cut } from './errors'
import type { Answer, UpstreamRequest } from './step'

// Whether the origin takes a TCP connection within the connect timeout.
async function reachable(hostname: string, port: number): Promise<Cut | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Cut>(r => (timer = setTimeout(() => r({ kind: 'connect-timeout', detail: '' }), CONNECT_TIMEOUT_S * 1000)))
  const tried = Bun.connect({ hostname, port, socket: { open: s => void s.end(), data() {}, error() {}, close() {} } }).then(
    () => undefined,
    (err: { code?: string }) => ({ kind: 'connect' as const, detail: `${hostname}:${port} ${err.code ?? String(err)}` }),
  )
  try {
    return await Promise.race([tried, late])
  } finally {
    clearTimeout(timer)
  }
}

export async function post(r: UpstreamRequest, signal: AbortSignal): Promise<Answer> {
  const url = new URL(r.url)
  if (url.protocol !== 'https:' && !(r.allowHttp && url.protocol === 'http:')) return { cut: { kind: 'connect', detail: `${url.protocol} is refused: https only, unless the provider sets allowHttp` } }
  if (signal.aborted) return { cut: { kind: 'reset', detail: 'aborted' } }
  const reach = await reachable(url.hostname, Number(url.port) || (url.protocol === 'https:' ? 443 : 80))
  if (reach !== undefined) return { cut: reach }
  const ac = new AbortController()
  let why: Cut | undefined
  const cutBy = (c: Cut) => ((why ??= c), ac.abort())
  const total = r.totalS !== undefined && Number.isFinite(r.totalS) && r.totalS > 0 ? setTimeout(() => cutBy({ kind: 'total', detail: String(r.totalS) }), Math.min(r.totalS * 1000, MAX_TIMEOUT_MS)) : undefined
  let stall: ReturnType<typeof setTimeout> | undefined
  const arm = () => (clearTimeout(stall), (stall = setTimeout(() => cutBy({ kind: 'stall', detail: String(r.stallS) }), r.stallS * 1000)))
  const release = () => (clearTimeout(stall), clearTimeout(total))
  arm()
  let res: Response
  try {
    res = await fetch(r.url, { method: 'POST', headers: r.headers, body: r.body, redirect: 'manual', signal: AbortSignal.any([signal, ac.signal]), timeout: false } as RequestInit)
  } catch (err) {
    release()
    return { cut: why ?? { kind: 'reset', detail: String(err) } }
  }
  if (res.status >= 300 && res.status < 400) {
    release()
    await res.body?.cancel().catch(() => {})
    return { cut: { kind: 'redirect', detail: String(res.status) } }
  }
  // Aborting closes the connection; cancelling the body's reader alone leaves it open on Bun 1.3.11.
  const cancel = () => (release(), ac.abort())
  async function* body(): AsyncGenerator<Uint8Array, Cut | undefined> {
    try {
      arm()
      for await (const chunk of res.body ?? []) {
        if (chunk.length > 0) yield chunk
        arm()
      }
      return why
    } catch (err) {
      return why ?? (signal.aborted ? undefined : { kind: 'reset', detail: String(err) })
    } finally {
      cancel()
    }
  }
  return { status: res.status, retryAfter: res.headers.get('retry-after') ?? undefined, body: body(), cancel }
}
