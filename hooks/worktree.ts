// Worktree isolation for a routed subagent: a git worktree on a new branch, and its cleanup when the
// subagent finishes. Pure over a port.
import type { EngineWorktree, Worktree } from '../types'
import { firstLine } from './redact'

type Cmd = { exitCode: number; stdout: string; stderr: string }
export type WorktreePort = {
  // Runs a command to its end; a command that cannot start answers exit code 127 with the reason as stderr.
  run(argv: readonly string[], opts?: { timeoutMs?: number }): Promise<Cmd>
  cwd(): Promise<string>
  toast(text: string): void
  // A line in the transcript.
  log(text: string): void
  debug(text: string): void
}

const git = (io: Pick<WorktreePort, 'run'>, args: readonly string[]) => io.run(['git', ...args], { timeoutMs: 30_000 })

// The path of the `trash` command, or undefined when there is none.
export async function findTrash(io: Pick<WorktreePort, 'run'>): Promise<string | undefined> {
  const r = await io.run(['/bin/sh', '-c', 'command -v trash'])
  const path = r.stdout.trim()
  return r.exitCode === 0 && path.startsWith('/') ? path : undefined
}

// A new worktree of the session's repository, on a new branch from HEAD, for an isolated subagent.
export async function makeWorktree(io: WorktreePort): Promise<Worktree | { error: string }> {
  const cwd = await io.cwd()
  const top = await git(io, ['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { error: `klyth agent: isolation "worktree" needs a git work tree, and ${cwd} is not inside one; omit isolation` }
  const root = top.stdout.trim()
  const head = await git(io, ['-C', root, 'rev-parse', '--verify', 'HEAD'])
  if (head.exitCode !== 0) return { error: `klyth agent: isolation "worktree" needs a commit to start from, and ${root} has none; make a commit or omit isolation` }
  const short = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  const wt: Worktree = { path: `${root}/.claude/worktrees/agent-${short}`, branch: `worktree-agent-${short}`, base: head.stdout.trim(), root }
  const add = await git(io, ['-C', root, 'worktree', 'add', '-b', wt.branch, wt.path, wt.base])
  if (add.exitCode !== 0) return { error: `klyth agent: git worktree add failed: ${firstLine(add.stderr)}; fix the repository or omit isolation` }
  io.debug(`klyth worktree ${wt.path} (branch ${wt.branch}) from ${wt.base.slice(0, 12)}`)
  return wt
}

// The worktree the engine made for the subagent `agentId` of an isolated Agent call, where it makes them
// (`<repository root>/.claude/worktrees/agent-<agentId>`), when that directory is there. Undefined when the
// root cannot be found, the directory is not there, or a port call fails. A session that itself runs inside a
// linked worktree always gets undefined here, so its isolated subagents stay native: safe, so left as it is.
export async function engineWorktree(io: Pick<WorktreePort, 'run' | 'cwd'> & { exists(path: string): Promise<boolean> }, agentId: string): Promise<EngineWorktree | undefined> {
  try {
    const top = await git(io, ['-C', await io.cwd(), 'rev-parse', '--show-toplevel'])
    const path = `${top.stdout.trim()}/.claude/worktrees/agent-${agentId}`
    return top.exitCode === 0 && (await io.exists(path)) ? { path, engine: true } : undefined
  } catch {
    return undefined
  }
}

// Moves a worktree that holds no changes and no new commits to the Trash, prunes it, and deletes its branch
// with `-d`. A changed one, one that cannot be checked, and every one when no `trash` resolved (`trashPath`)
// are kept and said so: `git worktree remove` would delete its git-ignored files for good.
export async function settleWorktree(io: WorktreePort, trashPath: string | undefined, wt: Worktree, who: string): Promise<'removed' | 'kept'> {
  const keep = (why: string) => {
    const text = `kept worktree ${wt.path} (branch ${wt.branch}) of subagent ${who}: ${why}; merge ${wt.branch} or remove the worktree`
    io.log(text)
    io.toast(`klyth: ${text}`)
    return 'kept' as const
  }
  const status = await git(io, ['-C', wt.path, 'status', '--porcelain'])
  const ahead = await git(io, ['-C', wt.path, 'rev-list', '--count', `${wt.base}..HEAD`])
  if (status.exitCode !== 0 || ahead.exitCode !== 0) return keep(`it could not be checked (${firstLine(status.stderr || ahead.stderr)})`)
  if (status.stdout.trim() !== '' || ahead.stdout.trim() !== '0') return keep('it has changes')
  if (trashPath === undefined) return keep('no trash command was found to move it with')
  const moved = await io.run([trashPath, wt.path])
  if (moved.exitCode !== 0) return keep(`trash failed (${firstLine(moved.stderr)})`)
  await git(io, ['-C', wt.root, 'worktree', 'prune'])
  const branch = await git(io, ['-C', wt.root, 'branch', '-d', wt.branch])
  io.debug(`klyth worktree ${wt.path} moved to the Trash; branch ${wt.branch} ${branch.exitCode === 0 ? 'deleted' : `kept (${firstLine(branch.stderr)})`}`)
  return 'removed'
}
