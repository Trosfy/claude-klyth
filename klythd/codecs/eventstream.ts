// The AWS event-stream framing Bedrock streams its answer in. A frame is a prelude (total length, headers
// length, CRC32 of those 8 bytes), the headers, the payload, and a CRC32 of everything before it, all
// integers big-endian. Pure.

// The runtime's CRC-32. The mod's type environment reaches this file through the kit tests and has no Bun global.
declare const Bun: { hash: { crc32(data: Uint8Array): number } }
export const crc32 = (b: Uint8Array) => Bun.hash.crc32(b)

export type Frame = { headers: Record<string, string>; payload: string }

// 16 MiB of payload, 128 KiB of headers and 16 bytes of framing.
const MAX_FRAME = 16 * 1024 * 1024 + 128 * 1024 + 16
// Each header value type's size in bytes; -1 is a value led by its 2-byte length (byte array 6, string 7).
const SIZES = [0, 0, 1, 2, 4, 8, -1, -1, 8, 16]
const utf8 = new TextDecoder()

// The string headers of a frame (type 7; every other type is skipped). Throws on a header that runs past
// the headers or has a type the format does not define.
function headersOf(b: Uint8Array): Record<string, string> {
  const v = new DataView(b.buffer, b.byteOffset, b.length)
  const out: Record<string, string> = {}
  let at = 0
  const take = (n: number) => {
    if (at + n > b.length) throw new Error('event-stream header runs past the headers')
    at += n
    return at - n
  }
  while (at < b.length) {
    const name = utf8.decode(b.subarray(take(b[take(1)] as number), at))
    const type = b[take(1)] as number
    const size = SIZES[type]
    if (size === undefined) throw new Error(`event-stream header type ${type} is not defined`)
    const len = size < 0 ? v.getUint16(take(2)) : size
    const value = b.subarray(take(len), at)
    if (type === 7) out[name] = utf8.decode(value)
  }
  return out
}

// Frames (the payload as UTF-8 text) out of response bytes as they arrive, a frame split between reads held
// until whole. A corrupt frame (a CRC that does not match, a length out of range, a malformed header) is a
// throw after the frames before it: nothing after it can be framed.
export function frameReader() {
  let buf = new Uint8Array(0)
  return {
    *feed(bytes: Uint8Array): Generator<Frame> {
      const all = new Uint8Array(buf.length + bytes.length)
      all.set(buf)
      all.set(bytes, buf.length)
      buf = all
      while (buf.length >= 12) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.length)
        const [total, headers] = [v.getUint32(0), v.getUint32(4)]
        if (crc32(buf.subarray(0, 8)) !== v.getUint32(8)) throw new Error('event-stream prelude CRC mismatch')
        if (total < 16 + headers || total > MAX_FRAME) throw new Error('event-stream frame length is out of range')
        if (buf.length < total) return
        if (crc32(buf.subarray(0, total - 4)) !== v.getUint32(total - 4)) throw new Error('event-stream message CRC mismatch')
        const frame = { headers: headersOf(buf.subarray(12, 12 + headers)), payload: utf8.decode(buf.subarray(12 + headers, total - 4)) }
        buf = buf.subarray(total)
        yield frame
      }
    },
    pending: () => buf.length, // bytes held of a frame not yet whole
  }
}
