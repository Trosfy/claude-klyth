import type { Elements, RenderElement } from 'claude-code'
import type { UsagePaneState } from '../types'
import type { UsageSession } from './usage-ledger'
import { usageCacheRatio, usageNumber, usageCompactTokens, usageModelNames, usageCount, usageWarning, usageEmptyModels, USAGE_HEADING, USAGE_UNAVAILABLE, type UsageRecordState, usageModelDetails, usageSummary, usageView, type UsageFilter } from './usage-view'

export const USAGE_PANE = 'klyth-usage'
const FILTERS: UsageFilter[] = ['All', 'Main', 'Children', 'Maintenance']
const FILTER_LABELS = { All: 'All', Main: 'Main conversation', Children: 'Subagents', Maintenance: 'Checks and summaries' }
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
export function renderUsagePane(io: UsagePanePort, sessionId: string, session: UsageSession | undefined, saved: UsagePaneState | undefined, bodyColumns: number, contextTokens?: number, recordState: UsageRecordState = 'active'): RenderElement {
  const { Box, Text, Button } = io.elements
  const state = usagePanePreferences(sessionId, saved)
  const text = (line: string, dimColor = false) => Text({ children: line, dimColor })
  const button = (key: string, label: string, onPress: () => Promise<void>, hotkey?: string) => Button({ key, label, onPress, ...(hotkey === undefined ? {} : { hotkey }) })
  const toolbar = (children: RenderElement[]) => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children })
  const controls = () => toolbar([
    ...(session === undefined ? [] : [button('diagnostics', state.diagnostics ? 'Hide session details' : 'Session details', () => io.change({ type: 'diagnostics' }), 'd')]),
    button('text', 'Print report', io.text, 't'), button('close', 'Close', io.close, 'q'),
  ])
  const heading = Text({ bold: true, children: USAGE_HEADING })
  if (session === undefined) return Box({ flexDirection: 'column', children: [heading, controls(), text('Press Escape to close.', true), ...USAGE_UNAVAILABLE.map(line => text(line))] })
  const view = usageView(session, state.filter, recordState)
  const requests = session.logicalRequests + session.untrackedRequests
  const cost = view.estimatedCost
  const metric = (label: string, value: string) => Box({ flexDirection: 'column', minWidth: 10, children: [text(label, true), Text({ bold: true, children: value })] })
  const children: RenderElement[] = [heading, controls(), text('Press Escape to close.', true), Text({ bold: true, children: `Estimated cost: ${cost}` }), Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, marginTop: 1, marginBottom: 1, children: [
    metric('Input tokens', usageCompactTokens(session.totals.totalInput)), metric('Output tokens', usageCompactTokens(session.totals.output)),
    metric('Input tokens from cache', usageCacheRatio(session.cacheReadTokens, session.cacheInputTokens)), metric('Requests', usageNumber(requests)),
  ] })]
  children.push(...usageWarning(session, recordState).map(line => text(line)))
  const pending = Object.keys(session.pending).length
  if (pending > 0) children.push(text(recordState === 'fenced' ? `${usageCount(pending, 'request')} without final records. Print this report to keep the current totals.` : `${usageCount(pending, 'request')} in progress. Wait for the request to finish.`, true))
  const hasModels = Object.keys(session.buckets).length > 0
  if (hasModels) {
    children.push(toolbar(FILTERS.map(filter => Button({ key: `filter-${filter}`, label: state.filter === filter ? `[${FILTER_LABELS[filter]}]` : FILTER_LABELS[filter], plain: true, onPress: () => io.change({ type: 'filter', filter }) }))))
    children.push(text(`Models: ${FILTER_LABELS[state.filter]}`, true))
  } else {
    children.push(...usageEmptyModels(session).pane.map((line, index) => text(line, index > 0)))
  }
  const rows = view.models
  const pages = Math.max(1, Math.ceil(rows.length / MODEL_PAGE))
  const page = Math.min(state.page, pages - 1)
  const shown = rows.slice(page * MODEL_PAGE, (page + 1) * MODEL_PAGE)
  if (pages > 1) children.push(toolbar([
    text(`Page ${usageNumber(page + 1)} of ${usageNumber(pages)}`, true),
    ...(page > 0 ? [button('previous', 'Previous page', () => io.change({ type: 'page', page: page - 1 }), 'p')] : []),
    ...(page + 1 < pages ? [button('next', 'Next page', () => io.change({ type: 'page', page: page + 1 }), 'n')] : []),
  ]))
  if (hasModels && shown.length === 0) children.push(text('This group has no models. Select All to see all models.', true))
  const names = usageModelNames(shown.map(row => row.target), Math.max(37, bodyColumns - 25))
  for (const row of shown) {
    const expanded = row.target === state.expanded
    const label = names.get(row.target)!
    const name = Button({ key: `model-${row.target}`, plain: true, label: `${expanded ? 'Hide' : 'Show'} model details: ${label}`, children: [text(`${expanded ? 'Hide' : 'Show'} model details: ${label}`)], onPress: () => io.change({ type: 'expand', target: row.target }) })
    const rowChildren = [name, text(`Estimated cost: ${row.estimatedCost}`)]
    children.push(Box({ flexDirection: 'column', marginTop: 1, children: rowChildren }))
    children.push(toolbar([text(`Input tokens: ${usageCompactTokens(row.totals.totalInput)}`, true), text(`Output tokens: ${usageCompactTokens(row.totals.output)}`, true), text(`Input from cache: ${usageCacheRatio(row.cacheReadTokens, row.cacheInputTokens)}`, true), text(usageCount(row.requests, 'request'), true)]))
    if (expanded) {
      const details = usageModelDetails(row)
      const detailPages = Math.max(1, Math.ceil(details.length / DETAIL_PAGE))
      const detailPage = Math.min(state.detailPage, detailPages - 1)
      if (detailPages > 1) children.push(toolbar([
        text(`Model details: Page ${usageNumber(detailPage + 1)} of ${usageNumber(detailPages)}`, true),
        ...(detailPage > 0 ? [button('detail-previous', 'Previous details page', () => io.change({ type: 'detail', page: detailPage - 1 }))] : []),
        ...(detailPage + 1 < detailPages ? [button('detail-next', 'Next details page', () => io.change({ type: 'detail', page: detailPage + 1 }))] : []),
      ]))
      children.push(...details.slice(detailPage * DETAIL_PAGE, (detailPage + 1) * DETAIL_PAGE).map(line => text(line)))
    }
  }
  if (state.diagnostics) children.push(Box({ flexDirection: 'column', marginTop: 1, children: [Text({ bold: true, children: 'Session details' }), ...usageSummary(session, contextTokens, recordState).map(line => text(line))] }))
  return Box({ flexDirection: 'column', children })
}

export async function openUsagePane(open: () => Promise<{ isPlaced: boolean }>, fallback: () => Promise<readonly string[]>): Promise<readonly string[]> {
  try { if ((await open()).isPlaced) return [] } catch { /* Text is available when the surface cannot open a pane. */ }
  return fallback()
}
