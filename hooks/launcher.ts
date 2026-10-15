export const LAUNCHER_MARKER = '# klyth-launcher 1. The Klyth plugin wrote this file and updates it. An approval of a key command that names this file does not bind to the release that it runs.'
export const RELEASE_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const safePath = (path: string) => path.startsWith('/') && !/['\u0000-\u001f\u007f-\u009f]/.test(path)

export function launcherText(home: string, root: string, version: string): string | undefined {
  if (!safePath(home) || !safePath(root) || !RELEASE_VERSION.test(version)) return undefined
  return `#!/bin/sh
${LAUNCHER_MARKER}
# klyth-release ${version} ${root}
bun=$(command -v bun) || bun="$HOME/.bun/bin/bun"
[ -x "$bun" ] || { echo 'klyth: Bun is not installed. Install Bun, then try again.' >&2; exit 127; }
[ -f '${root}/scripts/cli.ts' ] || { echo 'klyth: the Klyth release of this command is gone. Start Claude Code once with Klyth, then try again.' >&2; exit 1; }
KLYTH_LAUNCHER='${home}/.local/bin/klyth' exec "$bun" --config=/dev/null --no-env-file '${root}/scripts/cli.ts' "$@"
`
}

