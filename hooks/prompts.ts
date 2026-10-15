// The system prompt of a routed step, and the model identity its transcript states. Main gets the prompt
// the engine composes for its own model, with the lines that name that model rewritten to name the routed
// model and provider. A built-in agent type gets the prompt klyth writes for it (hooks/agents.ts); the `claude`
// type, which natively runs on main's own prompt, gets main's rewritten prompt; a custom agent type, or a
// built-in one with exactly one agent file naming it, gets the body of that file, and a custom one whose
// definition does not read runs as general-purpose.
// A subagent's prompt closes with the notes, its environment, how it hands back, and what answers it.
// `systemFor` is the one place a step's prompt is chosen. Pure over a port.
import type { Route } from '../types'
import { agentSystem, BUILTIN_AGENTS, BUILTIN_MODELS, BUILTIN_NOTES, builtinPrompt, dateOf, HANDBACK_TOOL, identityLine, isFork, NO_FRONTMATTER, NOT_REPRODUCED, parseAgentFile, parseInstalled, pluginRoot } from './agents'
import type { AgentDef, Parsed } from './agents'
import { own } from './config'
import type { ApiMessage } from './protocol'
import type { Session } from './session'

// One section of a composed system prompt: its id and its text.
type Section = { id: string; text: string }

export type PromptsPort = {
  // The sections of the prompt the engine composes for `model` with `tools` offered, in order.
  compose(model: string, tools: readonly string[]): Promise<readonly Section[]>
  cwd(): Promise<string>
  configDir(): Promise<string>
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  // The entries of a directory by name and kind (a symbolic link is `other`); none when it is not there.
  listDir(dir: string): Promise<readonly { name: string; kind: 'file' | 'dir' | 'other' }[]>
  // Runs a command to its end; a command that cannot start answers exit code 127.
  run(argv: readonly string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  now(): Promise<number>
  debug(text: string): void
}

const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const INHERIT = 'inherit'

// Says `text` once per session (a reload says it again): in /klyth, and in the debug log. Its key is apart
// from the ones definitionOf logs under (`def <type>`).
function noteOnce(io: Pick<PromptsPort, 'debug'>, s: Session, key: string, text: string) {
  if (s.agentNotes.has(`note ${key}`)) return
  s.agentNotes.add(`note ${key}`)
  s.notes.push(text)
  io.debug(`klyth ${text}`)
}

// --- model identity ------------------------------------------------------------------------------------------

// The sentence the engine states its own model in (section `env_info_model`, which 2.1.292 sends in the
// transcript as the session's model notice), with its knowledge cutoff; a knowledge-cutoff sentence alone; the
// environment's line on the latest Claude model family; and the sections that are nothing but the engine
// model's identity.
const POWERED_BY = /You are powered by the model (?:named [^\n]*?\. The exact model ID is \S+?|\S+?)\.(?=\s|$)(?: Assistant knowledge cutoff is [^\n]*?\.)?/g
const CUTOFF = / ?Assistant knowledge cutoff is [^\n]*?\./g
const FAMILY = /^.*The most recent Claude models\b.*(?:\n|$)/gm
const IDENTITY_SECTIONS = new Set(['fable_identity'])

// The composed main prompt for a routed model: `env_info_model` says `identity` in place of the engine
// model's, identity-only sections are left out, and the environment sections lose the engine model's
// knowledge cutoff and the Claude model-family line. Every other section is sent as composed. For a prompt
// that goes to a subagent working in another directory than the session's (`elsewhere`), the other
// environment sections are left out as well, since they may name the session's directory.
export function rewriteMain(sections: readonly Section[], identity: string, elsewhere = false): string {
  return sections
    .flatMap(x => {
      if (x.id === 'env_info_model') return [identity]
      if (IDENTITY_SECTIONS.has(x.id)) return []
      if (!x.id.startsWith('env_info')) return [x.text]
      if (elsewhere) return []
      const text = x.text.replace(POWERED_BY, identity).replace(CUTOFF, '').replace(FAMILY, '')
      return text.trim() === '' ? [] : [text]
    })
    .join('\n\n')
}

// A transcript as a routed model is sent it: the engine's notice of its own model, in a user message, names
// `model` served by `provider` instead. Messages without one are passed as they are.
export function withIdentity(messages: readonly ApiMessage[], model: string, provider: string): readonly ApiMessage[] {
  const identity = identityLine(model, provider)
  const fix = (text: string) => text.replace(POWERED_BY, identity)
  let changed = false
  const out = messages.map(m => {
    if (m.role !== 'user') return m
    if (typeof m.content === 'string') {
      const text = fix(m.content)
      if (text === m.content) return m
      changed = true
      return { ...m, content: text }
    }
    let hit = false
    const content = m.content.map(b => {
      const text = b.type === 'text' && typeof b['text'] === 'string' ? b['text'] : undefined
      const fixed = text === undefined ? undefined : fix(text)
      if (fixed === text) return b
      hit = true
      return { ...b, text: fixed }
    })
    if (!hit) return m
    changed = true
    return { ...m, content }
  })
  return changed ? out : messages
}

// --- custom agent types --------------------------------------------------------------------------------------

// `path` parsed by `parse`, read once per session: null when there is no file, an error when unreadable.
async function readParsed<T>(io: PromptsPort, s: Session, path: string, parse: (text: string) => Parsed<T>): Promise<Parsed<T> | null> {
  if (s.agentFiles.has(path)) return s.agentFiles.get(path) as Parsed<T> | null
  let value: Parsed<T> | null
  try {
    value = (await io.exists(path)) ? parse(await io.read(path)) : null
  } catch (err) {
    value = { error: `unreadable (${String(err)})` }
  }
  s.agentFiles.set(path, value)
  return value
}

// The `.claude/agents` directories of the project and of the configuration directory, in Claude Code's order.
const ownAgentDirs = async (io: PromptsPort) => [`${await io.cwd()}/.claude/agents`, `${await io.configDir()}/agents`]

// The agents directories Claude Code may read the definition of `type` from, in its order: a plugin agent
// `<plugin>:<name>` in its plugin's `agents`, any other in the session's `.claude/agents`, then in the
// configuration directory's `agents`. A plugin's directory is read off installed_plugins.json. `plugin` says
// which kind they are, because Claude Code reads the files of the two kinds by different rules.
async function agentDirs(io: PromptsPort, s: Session, type: string): Promise<Parsed<{ name: string; dirs: string[]; plugin: boolean }>> {
  const dir = await io.configDir()
  const cwd = await io.cwd()
  const colon = type.indexOf(':')
  const name = type.slice(colon + 1)
  if (!AGENT_NAME_RE.test(name)) return { error: `"${name}" is not an agent file name` }
  if (colon < 0) return { name, dirs: await ownAgentDirs(io), plugin: false }
  const file = `${dir}/plugins/installed_plugins.json`
  const installed = await readParsed(io, s, file, parseInstalled)
  if (installed === null) return { error: `${file}: no file` }
  if ('error' in installed) return { error: `${file}: ${installed.error}` }
  const root = pluginRoot(installed.plugins, type.slice(0, colon), cwd)
  if ('error' in root) return { error: `${file}: ${root.error}` }
  return { name, dirs: [`${root.root}/agents`], plugin: true }
}

// An agent file, with the name Claude Code knows its agent by: the frontmatter's `name`, else its file name less
// `.md`. `skipped` is why Claude Code ignores the file. In a `.claude/agents` directory it requires a `name` and a
// `description`, takes no agent from a file without either, and passes over a file with no frontmatter. A plugin's
// agent file needs neither field: its name falls back to the file name and its description to a default.
type AgentFile = { path: string; name: string; def: Parsed<AgentDef>; skipped?: string }
// How many entries klyth lists in one agents directory and beneath it: a directory with more is one it cannot be
// sure to have read whole.
const AGENT_DIR_MAX = 128

// Every `*.md` file in the agents directory `dir`, in the directories beneath it too (Claude Code reads those),
// parsed and in path order; an error when a listing or the count fails. Read once per session. `plugin` says the
// directory is a plugin's, whose files Claude Code reads by the plugin rule (see AgentFile).
function agentFilesIn(io: PromptsPort, s: Session, dir: string, plugin: boolean): Promise<Parsed<AgentFile[]>> {
  const key = `agents ${dir}`
  let files = s.agentFiles.get(key) as Promise<Parsed<AgentFile[]>> | undefined
  if (files === undefined) s.agentFiles.set(key, (files = loadAgentDir(io, s, dir, plugin)))
  return files
}

async function loadAgentDir(io: PromptsPort, s: Session, dir: string, plugin: boolean): Promise<Parsed<AgentFile[]>> {
  try {
    const paths: string[] = []
    let seen = 0
    const walk = async (at: string) => {
      for (const entry of await io.listDir(at)) {
        if (++seen > AGENT_DIR_MAX) throw new Error(`more than ${AGENT_DIR_MAX} entries`)
        if (entry.kind === 'dir') await walk(`${at}/${entry.name}`)
        else if (entry.name.endsWith('.md')) paths.push(`${at}/${entry.name}`)
      }
    }
    await walk(dir)
    return await Promise.all(
      paths.sort().map(async path => {
        let def: Parsed<AgentDef>
        try {
          def = parseAgentFile(await io.read(path))
        } catch (err) {
          def = { error: `unreadable (${String(err)})` }
        }
        const missing = plugin || 'error' in def ? [] : (['name', 'description'] as const).filter(k => !def[k])
        const bare = !plugin && 'error' in def && def.error === NO_FRONTMATTER
        const skipped = bare ? 'no frontmatter' : missing.length === 0 ? undefined : `no ${missing.join(' or ')}`
        if (skipped !== undefined && !bare) noteOnce(io, s, `skipped ${path}`, `agents: ${path} has ${skipped}, which Claude Code requires of a file in .claude/agents, so it skips the file and so does klyth`)
        return { path, name: ('error' in def ? undefined : def.name) || path.slice(path.lastIndexOf('/') + 1, -3), def, ...(skipped === undefined ? {} : { skipped }) }
      }),
    )
  } catch (err) {
    return { error: `${dir}: ${String(err)}` }
  }
}

// The agent files that name `type` (as its frontmatter `name`, whatever the file is called), in Claude Code's
// order of preference, the files among the others that klyth could not read (any of them may define `type`
// under a name klyth cannot see), and the directories they were looked for in.
async function definingFiles(io: PromptsPort, s: Session, type: string): Promise<Parsed<{ name: string; dirs: string[]; files: AgentFile[]; unread: AgentFile[] }>> {
  const found = await agentDirs(io, s, type)
  if ('error' in found) return found
  const files: AgentFile[] = []
  const unread: AgentFile[] = []
  for (const dir of found.dirs) {
    const listed = await agentFilesIn(io, s, dir, found.plugin)
    if ('error' in listed) return listed
    const kept = listed.filter(f => f.skipped === undefined)
    files.push(...kept.filter(f => f.name === found.name))
    unread.push(...kept.filter(f => f.name !== found.name && 'error' in f.def))
  }
  return { name: found.name, dirs: found.dirs, files, unread }
}

// A custom agent type's definition file: the first of the files that name it, which is the one Claude Code
// takes when no other of them is in play (see `contested`).
async function findDefinition(io: PromptsPort, s: Session, type: string): Promise<Parsed<{ def: AgentDef; path: string }>> {
  const found = await definingFiles(io, s, type)
  if ('error' in found) return found
  const [first] = found.files
  if (first === undefined) return { error: `no definition found (no agent file in ${found.dirs.join(' or ')} has the name ${found.name})` }
  return 'error' in first.def ? { error: `${first.path}: ${first.def.error}` } : { def: first.def, path: first.path }
}

// Whether Claude Code may define `type` from other than the one file klyth reads, as far as klyth can see: a type
// that more than one file names (it picks by a precedence klyth does not follow). A file whose text does not read
// counts under its file name, since klyth cannot tell it is not the definition; an agent that no file shows (an
// `--agents` or SDK one) is not seen.
export async function contested(io: PromptsPort, s: Session, type: string): Promise<boolean> {
  try {
    const found = await definingFiles(io, s, type)
    return 'error' in found || found.files.length > 1
  } catch {
    return true
  }
}

// The built-in agent type that runs on main's own system prompt (the engine's `appendSystemPrompt`).
const MAIN_PROMPT_TYPE = 'claude'

// A routed subagent's own definition when an agent file names its type and the definition reads, else
// undefined. Each type's outcome is logged once; a custom type whose definition does not read is also said in
// /klyth, as it runs as general-purpose. A built-in type with no file, or with more than one, has no definition
// and says nothing: it runs on klyth's own prompt. A built-in type with one file that reads says in /klyth that it
// runs on that file; a file that does not read, and so may define one under a name klyth cannot see, is said too. A
// fork has no definition of its own: it runs on its parent's prompt.
export async function definitionOf(io: PromptsPort, s: Session, type: string | undefined): Promise<AgentDef | undefined> {
  if (type === undefined || isFork(type)) return undefined
  const builtin = BUILTIN_AGENTS.includes(type)
  let single = false
  if (builtin) {
    try {
      const named = await definingFiles(io, s, type)
      if ('error' in named) return undefined
      for (const f of named.unread) {
        noteOnce(io, s, `unread ${f.path}`, `agents: ${f.path} cannot be read (${(f.def as { error: string }).error}); if it defines a built-in agent type, that type runs on klyth's prompt instead of the file`)
      }
      if (named.files.length !== 1) return undefined
      single = true
    } catch {
      return undefined
    }
  }
  let found: Parsed<{ def: AgentDef; path: string }>
  try {
    found = await findDefinition(io, s, type)
  } catch (err) {
    found = { error: String(err) }
  }
  if (!s.agentNotes.has(`def ${type}`)) {
    s.agentNotes.add(`def ${type}`)
    io.debug('error' in found ? `klyth agent-def ${type}: ${found.error}` : `klyth agent-def ${type} from ${found.path}`)
    const unreadable = `agents: ${type} has ${single ? 'one agent file klyth cannot read' : 'no readable definition'}`
    if ('error' in found) s.notes.push(single ? `${unreadable} (${found.error}); a plain call stays native and a klyth agent call is refused` : `${unreadable} (${found.error}); it runs ${builtin ? `on ${type === MAIN_PROMPT_TYPE ? "main's" : "klyth's"} prompt` : 'as general-purpose'}`)
    else if (builtin) s.notes.push(`agents: ${type} runs on ${found.path}, which overrides the built-in`)
  }
  return 'error' in found ? undefined : found.def
}

// Whether klyth may run an agent type on a klyth route, and whether its definition isolates it; else why not. Every
// route to a subagent on a klyth model asks this, the plain Agent call under a routed parent (inherit.ts) and the
// klyth agent tool alike, so the same call is answered the same from any conversation.
// A type klyth cannot run itself (NOT_REPRODUCED) qualifies never. A fork qualifies always: it runs on its parent's
// prompt, and no agent file defines it. Any other built-in type qualifies when it inherits its parent's model:
// klyth writes its prompt, or uses the one agent file that names it (`name: Explore`), whose model:, isolation: and
// tools then apply as a custom type's do. A custom type qualifies when its definition is one klyth reads and names
// no model of its own. A custom type without a readable definition (a plugin loaded with --plugin-dir, an
// --agents or SDK agent, no agent file whose `name:` is the type) is left native, because klyth would answer it with
// the general-purpose prompt and tools; so is a built-in type whose one agent file klyth cannot read, and a type that more than one agent file names (`contested`).
// These back-offs keep a spawn the caller did not ask a model for native. `named` is a spawn whose caller named
// the klyth model (a klyth agent call): it starts on the parent's model whatever the definition says, so a type's
// own model and missing definition do not stop it.
// `fate` ends the debug line that says why.
export async function claimable(io: PromptsPort, s: Session, type: string, fate: string, named: boolean): Promise<{ isolated: boolean } | { no: string }> {
  if (isFork(type)) return { isolated: false }
  if (NOT_REPRODUCED.includes(type)) {
    io.debug(`klyth inherit: ${type} is not a type klyth can run; ${fate}`)
    return { no: 'is not a type klyth can run' }
  }
  const builtin = BUILTIN_AGENTS.includes(type)
  const def = await definitionOf(io, s, type)
  // A built-in type that exactly one agent file names, and klyth cannot read, may be defined by that file: not claimable.
  const files = builtin && def === undefined ? await definingFiles(io, s, type).catch(() => undefined) : undefined
  if (files !== undefined && !('error' in files) && files.files.length === 1 && 'error' in (files.files[0] as AgentFile).def) {
    io.debug(`klyth inherit: ${type} has one agent file klyth cannot read; ${fate}`)
    return { no: 'has one agent file klyth cannot read' }
  }
  if (!builtin && def === undefined && !named) {
    io.debug(`klyth inherit: ${type} has no readable definition; ${fate}`)
    return { no: 'has no readable definition' }
  }
  const model = def?.model ?? (builtin && def === undefined ? own(BUILTIN_MODELS, type) : undefined)
  if (!named && model !== undefined && model.trim().toLowerCase() !== INHERIT) return { no: 'names a model of its own' }
  // A named spawn of a custom type with no definition runs general-purpose whatever files name it.
  if (!(named && !builtin && def === undefined) && (await contested(io, s, type))) {
    io.debug(`klyth inherit: ${type} has more than one definition (two agent files name it, or klyth could not read them all); ${fate}`)
    return { no: 'has more than one definition' }
  }
  if (def?.isolation !== undefined && def.isolation !== 'worktree') {
    io.debug(`klyth inherit: ${type} runs isolated as ${def.isolation}; ${fate}`)
    return { no: `runs isolated as ${def.isolation}` }
  }
  return { isolated: def?.isolation === 'worktree' }
}

// The agent type a klyth agent call's `subagent_type` names, resolved as the engine resolves an Agent call's, for
// the klyth agent tool's own spawn: `$.agent.spawn` takes a type only as exactly spelled, and every check and the
// route must use the type the engine runs. None is general-purpose. A type spelled exactly as a built-in type or
// an agent file's name is itself; another spelling is the one known type it matches ignoring case, and a spelling
// that matches more than one is denied with them listed. A plugin agent, and a type klyth knows of no file for (an
// `--agents` or SDK agent), are passed on as they are, and the engine refuses a name that matches none.
export async function resolveType(io: PromptsPort, s: Session, type: string | undefined): Promise<{ type: string } | { deny: string }> {
  if (type === undefined || type === '') return { type: 'general-purpose' }
  if (BUILTIN_AGENTS.includes(type) || type.includes(':')) return { type }
  const known = new Set(BUILTIN_AGENTS.filter(t => !isFork(t)))
  for (const dir of await ownAgentDirs(io)) {
    const listed = await agentFilesIn(io, s, dir, false)
    if (!('error' in listed)) for (const f of listed) if (f.skipped === undefined) known.add(f.name)
  }
  if (known.has(type)) return { type }
  const fold = (t: string) => t.normalize('NFKC').toLowerCase()
  const matches = [...known].filter(k => fold(k) === fold(type)).sort()
  if (matches.length > 1) return { deny: `klyth agent: subagent_type ${JSON.stringify(type)} matches more than one agent type (${matches.join(', ')}); name one of them exactly` }
  return { type: matches[0] ?? type }
}

// --- the prompt of a step ------------------------------------------------------------------------------------

// The platform as `uname -s` names it, lowercased (darwin, linux); undefined when it cannot be read.
async function platformOf(io: Pick<PromptsPort, 'run'>, s: Session): Promise<string | undefined> {
  if (s.platform === undefined) {
    const r = await io.run(['/usr/bin/uname', '-s'])
    const name = r.stdout.trim().toLowerCase()
    s.platform = r.exitCode === 0 && /^[a-z0-9_-]{1,32}$/.test(name) ? name : null
  }
  return s.platform ?? undefined
}

// What a step's prompt is chosen from: the agent file's definition when one names the type, the subagent's route
// (none for main), the engine model the main prompt is composed for, the routed target (`provider/model`),
// its model and provider, and the tools offered. For a fork these are its parent's: the nearest ancestor's route
// and definition that is not itself a fork (none when that is main), and `fork` says so.
type SystemInput = { def?: AgentDef; route?: Route; fork?: boolean; engineModel: string; target: string; model: string; provider: string; tools: readonly string[] }

// A routed step's system prompt and where it came from: `main` (the composed prompt, identity rewritten: main's
// own, and a `claude` subagent's when no agent file names it; one in a worktree is not told the session's
// directory), `custom` (an agent file's body: a custom type's, or a built-in type's that one file names) or
// `klyth` (the prompt klyth writes for a built-in type). A subagent's prompt is completed by agentSystem. A fork's is
// its parent's, as `fork of <source>`: a fork of main gets main's prompt alone, and a fork of a subagent that
// subagent's prompt less the handback guidance. Every fork is told how it reports in its messages (fork.ts), and
// Claude Code offers a fork no SubagentHandback, so no fork is told of it.
export async function systemFor(io: PromptsPort, s: Session, i: SystemInput): Promise<{ text: string; source: string }> {
  const fromMain = async (elsewhere = false) => rewriteMain(await io.compose(i.engineModel, i.tools), identityLine(i.model, i.provider), elsewhere)
  const handback = i.tools.includes(HANDBACK_TOOL.name)
  if (i.route === undefined) {
    const text = await fromMain()
    return { text, source: i.fork ? 'fork of main' : 'main' }
  }
  const type = i.route.type ?? 'general-purpose'
  const prompt =
    i.def !== undefined
      ? { body: i.def.prompt, source: 'custom', notes: BUILTIN_NOTES }
      : type === MAIN_PROMPT_TYPE
        ? { body: await fromMain(i.route.worktree !== undefined), source: 'main', notes: BUILTIN_NOTES }
        : { body: builtinPrompt(BUILTIN_AGENTS.includes(type) ? type : 'general-purpose', new Set(i.tools)), source: 'klyth', notes: BUILTIN_NOTES }
  const text = agentSystem(prompt.body, {
    cwd: i.route.worktree?.path ?? (await io.cwd()),
    platform: await platformOf(io, s),
    date: dateOf(await io.now()),
    model: i.model,
    provider: i.provider,
    type,
    alias: i.route.label === i.target ? undefined : i.route.label,
    notes: prompt.notes,
    handback: handback && !i.fork,
  })
  return { text, source: i.fork ? `fork of ${prompt.source}` : prompt.source }
}
