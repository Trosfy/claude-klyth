import { expect, test } from 'claude-code/testing'
import { SETUP_PANE } from '../hooks/setup-pane'
import type { SetupEvent, SetupRequest } from '../hooks/setup-protocol'
import { CONFIG_OBJECT, klyth, start, world } from './world'

// The helper is a local JSONL fixture; no credential or provider operation runs.
test('actual setup command survives return, decodes helper frames, saves only and switches through the model command', { timeoutMs: 30000 }, async ($, on) => {
  const calls: SetupRequest[] = []
  const modelCalls: string[] = []
  let release = () => {}
  let held = true
  on('clock.after', { ms: 960000 }, ($, e, next) => new Promise(resolve => next.signal.addEventListener('abort', () => resolve({ value: undefined }), { once: true })))
  on('ui.open', { id: SETUP_PANE }, () => ({ value: { isPlaced: true } }))
  on('process.spawn', { input: /^\{"version":1,"action":/ }, async function* ($, e, next) {
    if (!e.argv.includes('__setup')) return yield* next(e)
    const request = JSON.parse(e.input ?? '{}') as SetupRequest
    calls.push(request)
    if (held) { await new Promise<void>(resolve => { release = resolve }); held = false }
    const events: SetupEvent[] = request.action === 'inspect'
      ? [{ version: 1, type: 'inspection', aliases: [], providers: [{ id: 'acme', kind: 'openai', baseUrl: CONFIG_OBJECT.providers.acme.baseUrl, allowHttp: false, configuredAuth: true, revision: 'a'.repeat(64), models: [{ id: 'model-a', contextWindow: 128000, maxOutputTokens: 8000 }] }] }]
      : request.action === 'save' ? [{ version: 1, type: 'saved', target: `acme/${request.model.id}` }] : []
    const wire = [...events, { version: 1, type: 'done' }].map(event => JSON.stringify(event) + '\n').join('')
    for (let i = 0; i < wire.length; i += 17) yield { stream: 'stdout', text: wire.slice(i, i + 17) }
    return { value: { code: 0, signal: null } }
  })
  on('command.run', { command: 'model' }, ($, e, next) => { modelCalls.push(e.args); return next(e) })
  const w = world(on)
  const settle = async () => { for (let i = 0; i < 2000; i++) await Promise.resolve() }
  await start($)
  await klyth($, 'setup')
  await settle()
  expect(calls.map(call => call.action)).toEqual(['inspect'])
  release()
  await settle()
  const pane = await $.ui.mount({ plugin: 'klyth', surface: 'terminal', component: 'Pane', requestId: SETUP_PANE, props: { title: 'Klyth setup', isFocused: true, bodyColumns: 68, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} }, viewport: { columns: 200, rows: 40 } })
  await pane.select({ key: 'existing-provider', value: 'acme' })
  await settle(); await pane.redraw()
  await pane.press({ key: 'choose-model' })
  await settle(); await pane.redraw()
  await pane.select({ key: 'model-choice', value: 'model-a' })
  await settle(); await pane.redraw()
  await pane.press({ key: 'save-only' })
  await settle(); await pane.redraw()
  expect((await pane.findAll({ type: 'Text' })).map(item => item.text).join('\n')).toContain('Configuration saved. The model is ready to use.')
  expect(modelCalls).toEqual([])
  await pane.press({ key: 'close' })
  await klyth($, 'setup')
  await settle(); await pane.redraw()
  await pane.select({ key: 'existing-provider', value: 'acme' })
  await settle(); await pane.redraw()
  await pane.press({ key: 'choose-model' })
  await settle(); await pane.redraw()
  await pane.select({ key: 'model-choice', value: 'model-a' })
  await settle(); await pane.redraw()
  await pane.press({ key: 'save-and-use' })
  await settle(); await pane.redraw()
  expect(modelCalls).toEqual(['acme/model-a'])
  expect(calls.map(call => call.action)).toEqual(['inspect', 'save', 'inspect', 'save'])
  expect(w.requests).toEqual([])
  expect(w.runs.some(argv => argv[0] === '/usr/bin/security')).toBe(false)
  await pane.unmount()
})
