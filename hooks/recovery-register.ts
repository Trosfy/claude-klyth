// Permission observations are separate from classifier decisions; each callback owns its host calls.
import type { Register } from 'claude-code'
import type { Session } from './session'
import { dropTokens, noteAttachment, noteMode } from './classifier'
import { typeahead } from './advert'

export function registerObservations(on: Parameters<Register>[0], s: Session): void {
  // The classifier sees complete classic events and attachments, including their permission mode.
  // Dialogs revoke classifier tokens, while classic.PreToolUse remains untouched: a hook there could
  // stand behind every verdict. PermissionDenied and tool.check decisions remain in the root.
  // One line per event preserves event-specific typing; a union of names would lose it.
  on('classic.PostToolUse', ($, e, next) => (noteMode({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', ($, e, next) => (noteMode({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('classic.PostToolBatch', ($, e, next) => (noteMode({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('classic.Notification', ($, e, next) => (noteMode({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('classic.SubagentStop', ($, e, next) => (noteMode({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('classic.Stop', ($, e, next) => (noteMode({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', ($, e, next) => (noteMode({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('classic.PermissionRequest', ($, e, next) => (dropTokens({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, 'PermissionRequest'), next(e))).catch(($, e, next) => next(e))
  on('classic.CwdChanged', ($, e, next) => (dropTokens({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, 'CwdChanged'), next(e))).catch(($, e, next) => next(e))
  on('prompt.attachment', ($, e, next) => (noteAttachment({ debug: text => $.ui.log(text, { to: 'debug' }) }, s, e), next(e))).catch(($, e, next) => next(e))
  on('prompt.autocomplete', async ($, e, next) => {
    const r = await next(e)
    const rows = s.loaded.config === undefined ? [] : typeahead(s.loaded.config, e.text, e.start, e.token)
    return rows.length === 0 ? r : { suggestions: [...r.suggestions, ...rows] }
  })
}
