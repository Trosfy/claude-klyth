// /model and main's selected target: a klyth alias or `provider/model` selects main's route, any other argument
// goes to the native command, and a switch made anywhere else leaves klyth. Pure over ports.
import type { CommandRunInput, CommandRunResult } from 'claude-code'

import { inputBudget } from './config'
import { switched } from './leave'
import { explain, isKlythShaped, resolve } from './names'
import { PRODUCT } from './product'
import type { RouteStore, Say } from './routing'
import type { Session } from './session'
import { ensureTrust } from './trust'
import type { TrustPort } from './trust'
import { k, showStatus, shownTarget } from './ui'
import type { StatusPort } from './ui'

export type ModelPort = TrustPort & Pick<RouteStore, 'setMain'> & Pick<Say, 'debug' | 'toast'> & StatusPort & { contextTokens(): Promise<number> }

// The alias names /model keeps from the native command while the config is broken: the last valid
// config's, and the broken file's own.
const knownAliases = (s: Session) => [...s.goodAliases, ...(s.loaded.declared ?? [])]

// Selects main's target (null: native); when the target changes, forgets main's last remote prompt size and
// notes a route left (leave.ts).
// A selection holds once written. A clear holds in memory first, then in state, then on the status line;
// a rejected write of it is logged, not thrown: main stays native in this session, though a new session
// may read the old target back.
async function setMain(io: Pick<RouteStore, 'setMain'> & Pick<Say, 'debug' | 'toast'> & StatusPort, s: Session, target: string | null) {
  if (target !== s.main) s.promptTokens.delete('main')
  if (target !== null) await io.setMain(target)
  switched(s, target)
  s.main = target
  if (target === null) {
    try {
      await io.setMain(null)
    } catch {
      io.debug('klyth: could not persist clearing main; main is native in this session')
      io.toast('klyth: native switch could not be saved; retry /model native/sonnet before restarting or the previous route may return')
    }
  }
  await showStatus(io, s)
}

// /model: a klyth alias or `provider/model` selects main's target, one line and no toast; any other argument
// goes to the native command (`next`), and leaves klyth when klyth held main.
export async function modelCommand(io: ModelPort, s: Session, e: CommandRunInput, next: (e: CommandRunInput) => Promise<CommandRunResult>): Promise<CommandRunResult> {
  const withLine = (text: string | undefined, line: string) => (text ? `${text}\n${line}` : line)
  const leaving = () => (s.main ? `klyth: left ${shownTarget(s.loaded.config, s.main)}` : undefined)
  // The native /model with `args`, then main cleared; its output says so when klyth held main.
  const native = async (args: string) => {
    const left = leaving()
    const r = await next({ ...e, args })
    await setMain(io, s, null)
    return left === undefined ? r : { ...r, text: withLine(r.text, left) }
  }
  const arg = e.args.trim()
  if (arg === '') {
    // The picker. Its pick lands after `next(e)` resolves, so klyth leaves before opening it: a pick, an
    // unchanged pick and Esc all leave klyth alike, and /model <alias> returns to the alias.
    const left = leaving()
    if (left !== undefined) await setMain(io, s, null)
    const r = await next(e)
    return left === undefined ? r : { ...r, text: withLine(r.text, left) }
  }
  const snap = s.loaded
  if (snap.missing || !isKlythShaped(snap.config, arg, knownAliases(s))) return native(e.args)
  if (snap.config === undefined && arg.startsWith('native/') && arg.length > 'native/'.length) return native(arg.slice('native/'.length))
  if (snap.config === undefined) return { text: `klyth: can't switch to ${arg}: config error, ${snap.errors[0]}. Native model unchanged; fix ${snap.path}, then run /klyth reload` }
  const t = resolve(snap.config, arg)
  if (t === undefined) return { text: explain(snap.config, arg) }
  if (t.kind === 'native') return native(t.model)
  if (!(await ensureTrust(io, t.provider))) return { text: `klyth: provider ${t.provider.id} not approved; native model unchanged. Run /model ${arg} again and choose Allow` }
  const context = Math.max(await io.contextTokens(), s.promptTokens.get('main')?.tokens ?? 0)
  const budget = inputBudget(t.model, t.provider.kind)
  await setMain(io, s, t.label)
  const selected = `Set model to ${t.label === t.target ? t.target : `${t.label} (${t.target})`}`
  return { text: context > 0.85 * budget
    ? `${selected}\nklyth: existing context ~${k(context)} tokens is large for ${t.target}'s ${k(budget)} input budget; run /compact before continuing. Normal requests still enforce the 95% safety threshold`
    : selected }
}

// When /model fails inside klyth: a klyth-shaped argument is answered, the native command not run; any other
// goes on beneath (`next`), and so does a failure after `next` was called.
export function modelFailed(s: Session, e: CommandRunInput, called: boolean, next: (e: CommandRunInput) => Promise<CommandRunResult>): Promise<CommandRunResult> | CommandRunResult {
  return called || s.loaded.missing || !isKlythShaped(s.loaded.config, e.args.trim(), knownAliases(s))
    ? next(e)
    : { text: `klyth: couldn't switch to ${e.args.trim()} (internal error; see the debug log). Native model unchanged` }
}

// A model switch made outside /model (the /config Model row, the SDK) leaves klyth too: main is cleared, and
// the status line says so.
export async function modelSwitched(io: Pick<RouteStore, 'setMain'> & Pick<Say, 'debug' | 'toast'> & StatusPort, s: Session, source: string) {
  if ((source === 'command' || source === 'picker' || source === 'sdk') && s.main) await setMain(io, s, null)
}

// Core presents command text under the plugin name.
const COMMAND_PREFIX = `${PRODUCT.plugin}: `
export const asCommand = (r: CommandRunResult): CommandRunResult => r.text?.startsWith(COMMAND_PREFIX) ? { ...r, text: r.text.slice(COMMAND_PREFIX.length) } : r
