// `token chatgpt` as a process of its own, for the two-process lock test in klythd/chatgpt-cli.spec.ts. The keyring is
// a file in <dir> (read with cat, replaced by an atomic mv), the lock lives in <dir>, and the token endpoint is the
// local server at <origin>; every other port is the real one. Usage: bun chatgpt-driver.ts <dir> <origin>
import { join } from 'node:path'

import { run } from '../../scripts/auth'
import type { Store } from '../../scripts/auth'
import { fileLock, ports, token } from '../../scripts/chatgpt'

const [dir, origin] = process.argv.slice(2) as [string, string]
const file = (p: string) => join(dir, `klyth-${p}.item`)
const store: Store = {
  name: 'item file', namespace: 'klyth', missing: r => r.exitCode === 1,
  find: p => ['/bin/test', '-f', file(p)],
  read: p => ['/bin/cat', file(p)],
  add: (p, key) => ({ argv: ['/bin/sh', '-c', 'cat > "$0.tmp" && mv "$0.tmp" "$0"', file(p)], input: key }),
  del: p => ['/bin/rm', '-f', file(p)],
}
const real = ports(dir, process.platform)
const io = {
  ...real,
  platform: process.platform,
  configPath: join(dir, 'klyth.json'),
  run,
  out: console.log,
  err: console.error,
  store,
  identity: {},
  lock: (name: string) => fileLock(dir, name),
  // Only the token endpoint is reachable, and only on the local server.
  fetch: (url: string, init: RequestInit) => (url === 'https://auth.openai.com/api/accounts/oauth/token' ? fetch(`${origin}/token`, init) : Promise.reject(new Error(`unexpected fetch ${url}`))),
}
process.exit(await token(io, 'chatgpt'))
