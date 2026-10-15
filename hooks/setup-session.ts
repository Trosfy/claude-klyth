// Session-owned setup supervision; engine calls remain in register.ts.
import type { ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import { createHelperRuntime } from './helper-runtime'
import type { HelperChild, HelperRuntimePort } from './helper-runtime'
import { createSetupController } from './setup-controller'
import type { SetupController, SetupControllerUiPort } from './setup-controller'
import type { SetupPaneAction, SetupPaneView } from './setup-pane'
import type { ExtraClient } from './extra-client'
import type { ExtraClientId } from './extras'
import type { SetupRequest } from './setup-protocol'
import { providerPolicyErrors } from './load'

export type SetupSessionPort = Omit<HelperRuntimePort, 'spawn' | 'extraClient'> & {
  extraClient?: ExtraClient<ExtraClientId>
  spawn(request: ProcessSpawnRequest): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>
  now(): Promise<number>
  copy(url: string): Promise<boolean>
  policy(): Promise<Readonly<Record<string, unknown>>>
  reload(target: string): Promise<boolean>
  useModel(target: string): Promise<boolean>
  ui: SetupControllerUiPort
  failed(): void
}

export function createSetupSession() {
  let runtime: ReturnType<typeof createHelperRuntime> | undefined
  let controller: SetupController | undefined
  let makeController: (() => SetupController) | undefined
  let ui: SetupControllerUiPort | undefined
  let failed = () => {}
  let generation = 0
  let wake = () => {}
  const jobs: { run(): void; reject(): void }[] = []
  const children = new Set<() => void>()
  const owned = <T>(run: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    jobs.push({ run: () => { void run().then(resolve, reject) }, reject: () => reject(new Error('Setup session ended')) })
    wake()
  })
  const end = () => {
    generation++
    controller?.stop()
    controller = undefined
    for (const cancel of children) cancel()
    children.clear()
    for (const job of jobs.splice(0)) job.reject()
    wake()
  }
  return {
    start(io: SetupSessionPort) {
      end()
      ui = io.ui
      failed = io.failed
      const owner = generation
      void (async () => {
        while (owner === generation) {
          for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) job.run()
          await new Promise<void>(resolve => { wake = resolve })
        }
      })()
      const spawn: HelperRuntimePort['spawn'] = async (argv, options): Promise<HelperChild> => {
        if (options.signal.aborted || owner !== generation) throw new Error('Setup session ended')
        const child = io.spawn({ argv, input: options.input, env: options.env })
        let exit = (_code: number) => {}, done = false
        const exited = new Promise<number>(resolve => { exit = resolve })
        const finish = (code: number) => {
          if (done) return
          done = true
          cancelTimer()
          options.signal.removeEventListener('abort', cancel)
          children.delete(cancel)
          exit(code)
        }
        const cancel = () => { void child.return(undefined as never).catch(() => {}).finally(() => finish(130)) }
        const cancelTimer = io.setTimer(cancel, options.timeoutMs)
        children.add(cancel)
        options.signal.addEventListener('abort', cancel, { once: true })
        if (options.signal.aborted) cancel()
        const stdout = (async function* () {
          try {
            for (;;) {
              const next = await child.next()
              if (next.done) { finish(next.value.code ?? 1); return }
              if (next.value.stream === 'stdout') yield next.value.text
              // Drain stderr without retaining or forwarding provider or credential diagnostics.
            }
          } catch { finish(1); throw new Error('Setup helper stopped') }
          finally { if (!done) cancel() }
        })()
        return { stdout, exited, cancel }
      }
      runtime = createHelperRuntime({ ...io, spawn })
      const helper = runtime
      const allowed = async (request: SetupRequest): Promise<boolean> => {
        const origins = request.action === 'login'
          ? ['https://auth.openai.com', request.client === 'official' ? 'https://api.openai.com' : new URL(io.extraClient!.baseUrl).origin]
          : request.action === 'models' || request.action === 'save' ? [new URL(request.connection.baseUrl).origin] : []
        return origins.length === 0 || (await providerPolicyErrors(io, origins.map((origin, index) => ({ id: `setup-${index}`, origin })))).length === 0
      }
      makeController = () => createSetupController({
        extraClient: io.extraClient,
        helperReady: () => helper.ready(),
        installHelper: () => owned(async () => { await helper.install(true) }),
        invoke: (request, emit, signal) => owned(async () => {
          if (owner !== generation || signal.aborted) throw new Error('Setup session ended')
          if (!(await allowed(request))) { emit({ version: 1, type: 'failed', code: 'policy-blocked' }); emit({ version: 1, type: 'done' }); return }
          await helper.invoke(request, emit, signal)
        }),
        keyCommand: id => helper.keyCommand(id),
        reopenBrowser: url => helper.openBrowser(url),
        copySignInLink: url => io.copy(url),
        reload: target => io.reload(target), useModel: target => io.useModel(target),
        now: () => io.now(), after: (ms, callback) => ({ cancel: io.setTimer(callback, ms) }),
      })
      controller = makeController()
    },
    open(): void {
      void owned(async () => {
        if (!makeController || !ui) throw new Error('Klyth setup is not initialized')
        controller ??= makeController()
        await controller.open(ui)
      }).catch(failed)
    },
    view: (): SetupPaneView | undefined => controller?.view(),
    dispatch: (action: SetupPaneAction) => { void owned(async () => { controller?.dispatch(action) }).catch(failed) },
    close: () => controller?.close(),
    reset() { controller?.stop(); controller = undefined },
    stop: end,
    daemonArgv: async (): Promise<readonly string[] | undefined> => {
      if (!runtime) return undefined
      return runtime.compiledDaemonArgv()
    },
  }
}
