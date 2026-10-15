// Per-request maintenance limits apply after configuration overlays, never to shared model settings.
import { isObject } from './config'
import { KINDS } from './kinds'
import type { ModelConfig, ProviderConfig } from './config'

type Json = Record<string, unknown>
export const maintenanceLimit = (p: ProviderConfig, m: ModelConfig) => ({ output: Math.min(8000, m.maxOutputTokens), capped: KINDS[p.kind].sendsMaxTokens || m.maxTokensParam !== undefined })
export function maintenanceParams(body: Json, p: ProviderConfig, m: ModelConfig, outputTokens?: number): Json {
  if (outputTokens === undefined || !maintenanceLimit(p, m).capped) return body
  if (p.kind === 'bedrock') body = { ...body, inferenceConfig: { ...(isObject(body['inferenceConfig']) ? body['inferenceConfig'] : {}), maxTokens: outputTokens } }
  else if (p.kind === 'anthropic' || m.maxTokensParam !== undefined) body = { ...body, [p.kind === 'anthropic' ? 'max_tokens' : m.maxTokensParam!]: outputTokens }
  else return body
  if (p.kind !== 'anthropic' && p.kind !== 'bedrock') return body
  const fields = p.kind === 'bedrock' && isObject(body['additionalModelRequestFields']) ? body['additionalModelRequestFields'] : body
  const thinking = fields['thinking']
  if (!isObject(thinking) || thinking['type'] !== 'enabled' || typeof thinking['budget_tokens'] !== 'number' || thinking['budget_tokens'] < outputTokens) return body
  // Fixed thinking requires at least 1024 tokens and room for output; smaller caps cannot reserve it.
  const limited = outputTokens > 1024 ? { ...thinking, budget_tokens: outputTokens - 1 } : { type: 'disabled' }
  return p.kind === 'bedrock' ? { ...body, additionalModelRequestFields: { ...fields, thinking: limited } } : { ...body, thinking: limited }
}
