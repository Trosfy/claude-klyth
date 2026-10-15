// The line reader the SSE decoders share: a long line is held without being rescanned at each read, and a line
// past 16 MiB is cut off, with what it held dropped so a provider that goes on sending holds no more memory.
import { expect, test } from 'bun:test'

import { sseReader } from './codec'

const bytes = (text: string) => new TextEncoder().encode(text)

test('a line arriving in thousands of small pieces is read in linear time', () => {
  const reader = sseReader()
  const started = performance.now()
  const early = ['data: ', ...Array.from({ length: 4096 }, () => 'a'.repeat(1024))].flatMap(piece => reader.feed(bytes(piece)))
  const [payload, ...rest] = reader.feed(bytes('\r\ndata: next\n'))
  expect(performance.now() - started).toBeLessThan(500)
  expect([early, payload?.length, rest]).toEqual([[], 4 << 20, ['next']])
})

// Feeds a `data:` line of `size` bytes in pieces of 1 MiB, with no newline.
function send(reader: ReturnType<typeof sseReader>, size: number) {
  reader.feed(bytes('data: '))
  for (let left = size - 6; left > 0; left -= 1 << 20) reader.feed(bytes('a'.repeat(Math.min(left, 1 << 20))))
}

test('a line of 16 MiB is read; one byte more is an error, and the reader then starts afresh', () => {
  const reader = sseReader()
  send(reader, 16 << 20)
  expect(reader.feed(bytes('\n'))[0]).toHaveLength((16 << 20) - 6)
  expect(() => send(reader, (16 << 20) + 1)).toThrow('the stream sent a line over 16 MiB')
  expect(reader.feed(bytes('data: ok\n'))).toEqual(['ok'])
})
