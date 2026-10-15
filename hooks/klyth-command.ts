import type { CommandRunResult } from 'claude-code'

export type KlythCommandPort = {
  recovery(args: string): Promise<CommandRunResult | undefined>
  compact(): CommandRunResult | undefined
  usage(args: string): Promise<readonly string[] | undefined>
  reload(): Promise<void>
  report(): Promise<readonly string[]>
  log(line: string): void
}

export async function runKlythCommand(io: KlythCommandPort, args: string): Promise<CommandRunResult> {
  const recovered = await io.recovery(args)
  if (recovered !== undefined) return recovered
  const queued = io.compact()
  if (queued !== undefined) return queued
  const usage = await io.usage(args)
  if (usage !== undefined) {
    for (const line of usage) io.log(line)
    return {}
  }
  if (args.trim() === 'reload') await io.reload()
  for (const line of await io.report()) io.log(line)
  return {}
}
