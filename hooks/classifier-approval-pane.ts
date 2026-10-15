import type { Elements, RenderElement } from 'claude-code'
import type { ApprovalView } from './classifier-approval'

// Escaped JSON is exact and inert in a Text element. A value requiring secret masking cannot be reviewed here.
export function approvalDetails(action: { actor: string; tool: string; input: unknown; cwd: string; target?: string; recipient?: unknown }): string | undefined {
  const text = JSON.stringify(action, null, 2)
  if (text === undefined || text.length > 24_000 || /Bearer\s+\S+|sk-[A-Za-z0-9._-]+|(?:api[-_]?key|token|secret)["':= ]+\S+/i.test(text)) return undefined
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ch => ch === '\n' ? ch : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function renderApprovalPane(elements: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>, view: ApprovalView | undefined): RenderElement {
  const { Box, Text, Button } = elements
  return Box({ flexDirection: 'column', children: view === undefined ? [Text({ children: 'Approval closed.' })] : [
    Text({ bold: true, children: `Review action: ${view.seconds}s` }),
    Text({ children: 'Allow once approves only this exact action. Deny or Esc leaves it blocked.' }),
    Text({ children: 'After 8 seconds without an answer, only routine non-risky work may pass classifier review.' }),
    Text({ children: view.details }),
    Box({ flexDirection: 'row', flexWrap: 'wrap', gap: 1, children: [
      Button({ key: 'allow-once', label: 'Allow once', onPress: () => view.answer('allow') }),
      Button({ key: 'deny', label: 'Deny', onPress: () => view.answer('deny') }),
    ] }),
  ] })
}
