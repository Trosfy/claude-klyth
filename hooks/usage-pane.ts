import type { Elements, RenderElement } from 'claude-code'
import type { UsagePaneState } from '../types'
import type { UsageSession } from './usage-ledger'
import { usageCacheRatio, usageCompactNumber, usageCompactTokens, usageDisplay, usageModelDetails, usageSummary, usageView, type UsageFilter } from './usage-view'

export const USAGE_PANE = 'klyth-usage'
const FILTERS: UsageFilter[] = ['All', 'Main', 'Children', 'Maintenance']
const MODEL_PAGE = 20
const DETAIL_PAGE = 16

export type UsagePaneAction =
  | { type: 'filter'; filter: UsageFilter }
  | { type: 'page'; page: number }
  | { type: 'expand'; target: string }
  | { type: 'detail'; page: number }
  | { type: 'diagnostics' }

export function usagePanePreferences(sessionId: string, saved?: UsagePaneState): UsagePaneState {
  return saved?.sessionId === sessionId ? saved : { sessionId, filter: 'All', page: 0, detailPage: 0 }
}

export function changeUsagePane(sessionId: string, saved: UsagePaneState | undefined, action: UsagePaneAction): UsagePaneState {
  const state = usagePanePreferences(sessionId, saved)
  if (action.type === 'diagnostics') return { ...state, diagnostics: !state.diagnostics }
  if (action.type === 'filter') return { ...state, filter: action.filter, page: 0, expanded: undefined, detailPage: 0 }
  if (action.type === 'page') return { ...state, page: Math.max(0, action.page), expanded: undefined, detailPage: 0 }
  if (action.type === 'expand') return { ...state, expanded: state.expanded === action.target ? undefined : action.target, detailPage: 0 }
  return { ...state, detailPage: Math.max(0, action.page) }
}

export type UsagePanePort = {
  elements: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
  change(action: UsagePaneAction): Promise<void>
  close(): Promise<void>
  text(): Promise<void>
}

// Constructors and callbacks belong to the host; rendering only reads the supplied snapshots.
export function renderUsagePane(io: UsagePanePort, sessionId: string, session: UsageSession | undefined, saved: UsagePaneState | undefined, bodyColumns: number, contextTokens?: number): RenderElement {
  const { Box, Text, Button } = io.elements
  const state = usagePanePreferences(sessionId, saved)
  const text = (line: string, dimColor = false) => Text({ children: line, dimColor })
  const button = (key: string, label: string, onPress: () => Promise<void>, hotkey?: string) => Button({ key, label, onPress, ...(hotkey === undefined ? {} : { hotkey }) })
  const toolbar = (children: RenderElement[]) => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children })
  const controls = () => toolbar([
    ...(session === undefined ? [] : [button('diagnostics', state.diagnostics ? 'Less' : 'Details', () => io.change({ type: 'diagnostics' }), 'd')]),
    button('text', 'Text', io.text, 't'), button('close', 'Close', io.close, 'q'),
  ])
  const heading = Text({ bold: true, children: 'Klyth usage · This session' })
  if (session === undefined) return Box({ flexDirection: 'column', children: [heading, text('Estimated cost: unavailable'), text('Usage is not available yet.'), controls(), text('Esc to close', true)] })
  const view = usageView(session, state.filter)
  const requests = session.logicalRequests + session.untrackedRequests
  const cost = requests === 0 ? 'Not priced yet' : view.estimatedCost
  const metric = (label: string, value: string) => Box({ flexDirection: 'column', minWidth: 10, children: [text(label, true), Text({ bold: true, children: value })] })
  const children: RenderElement[] = [heading, Text({ bold: true, children: `Estimated cost: ${cost}` }), Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, marginTop: 1, marginBottom: 1, children: [
    metric('Input', usageCompactTokens(session.totals.totalInput)), metric('Output', usageCompactTokens(session.totals.output)),
    metric('Cache reuse', usageCacheRatio(session.cacheReadTokens, session.cacheInputTokens)), metric('Requests', usageCompactNumber(requests)),
  ] })]
  if (session.warnings.persistenceFailure) children.push(text('Not saved; live totals are still tracked.'))
  if (session.warnings.recovered || session.warnings.earlierUnavailable) children.push(text('Earlier usage may be missing. See Details.'))
  if (session.warnings.trackingGap || session.unknownExecutions > 0 || session.untrackedRequests > 0 || session.missingUsageAttempts > 0 || session.arithmeticOverflow) children.push(text('Some usage is unreported. See Details.'))
  const pending = Object.keys(session.pending).length
  if (pending > 0) children.push(text(`${pending} request${pending === 1 ? '' : 's'} in progress`, true))
  const hasModels = Object.keys(session.buckets).length > 0
  if (hasModels) {
    children.push(toolbar(FILTERS.map(filter => Button({ key: `filter-${filter}`, label: state.filter === filter ? `[${filter}]` : filter, plain: true, onPress: () => io.change({ type: 'filter', filter }) }))))
    children.push(text(`Models · ${state.filter}`, true))
  } else {
    children.push(text(requests === 0 ? 'No routed requests recorded yet.' : 'No model usage reported yet.'))
    children.push(text(requests === 0 ? 'Tracking starts when Klyth is loaded.' : 'See Details for reporting coverage.', true))
  }
  const rows = view.models
  const pages = Math.max(1, Math.ceil(rows.length / MODEL_PAGE))
  const page = Math.min(state.page, pages - 1)
  const shown = rows.slice(page * MODEL_PAGE, (page + 1) * MODEL_PAGE)
  if (pages > 1) children.push(toolbar([
    text(`${page + 1} / ${pages}`, true),
    ...(page > 0 ? [button('previous', 'Previous', () => io.change({ type: 'page', page: page - 1 }), 'p')] : []),
    ...(page + 1 < pages ? [button('next', 'Next', () => io.change({ type: 'page', page: page + 1 }), 'n')] : []),
  ]))
  if (hasModels && shown.length === 0) children.push(text('No models in this filter.', true))
  for (const row of shown) {
    const expanded = row.target === state.expanded
    const label = usageDisplay(row.target, Math.max(24, Math.min(64, bodyColumns - 4)))
    const name = Button({ key: `model-${row.target}`, plain: true, label: `${expanded ? 'Hide' : 'Show'} details: ${label}`, children: [text(`${expanded ? '▾' : '▸'} ${label}`)], onPress: () => io.change({ type: 'expand', target: row.target }) })
    const rowChildren = [name, text(row.estimatedCost)]
    children.push(Box({ flexDirection: bodyColumns >= 76 ? 'row' : 'column', justifyContent: 'space-between', columnGap: 2, marginTop: 1, children: rowChildren }))
    children.push(toolbar([text(`In ${usageCompactTokens(row.totals.totalInput)}`, true), text(`Out ${usageCompactTokens(row.totals.output)}`, true), text(`Cache ${usageCacheRatio(row.cacheReadTokens, row.cacheInputTokens)}`, true), text(`${usageCompactNumber(row.requests)} requests`, true)]))
    if (expanded) {
      const details = usageModelDetails(row)
      const detailPages = Math.max(1, Math.ceil(details.length / DETAIL_PAGE))
      const detailPage = Math.min(state.detailPage, detailPages - 1)
      if (detailPages > 1) children.push(toolbar([
        text(`Details ${detailPage + 1} / ${detailPages}`, true),
        ...(detailPage > 0 ? [button('detail-previous', 'Previous details', () => io.change({ type: 'detail', page: detailPage - 1 }))] : []),
        ...(detailPage + 1 < detailPages ? [button('detail-next', 'Next details', () => io.change({ type: 'detail', page: detailPage + 1 }))] : []),
      ]))
      children.push(...details.slice(detailPage * DETAIL_PAGE, (detailPage + 1) * DETAIL_PAGE).map(line => text(line)))
    }
  }
  children.push(Box({ marginTop: 1, children: [controls()] }), text('Esc to close', true))
  if (state.diagnostics) children.push(Box({ flexDirection: 'column', marginTop: 1, children: [Text({ bold: true, children: 'Session details' }), ...usageSummary(session, contextTokens).slice(2).map(line => text(line))] }))
  return Box({ flexDirection: 'column', children })
}

export async function openUsagePane(open: () => Promise<{ isPlaced: boolean }>, fallback: () => Promise<readonly string[]>): Promise<readonly string[]> {
  try { if ((await open()).isPlaced) return [] } catch { /* Text is available when the surface cannot open a pane. */ }
  return fallback()
}
