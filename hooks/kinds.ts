// The provider kinds and what each adds to the common provider and model keys. Pure data.

// The provider protocols: Chat Completions, OpenAI's Responses API, the Anthropic Messages API, and Amazon
// Bedrock Converse.
export type Kind = 'openai' | 'openai-responses' | 'anthropic' | 'bedrock'
// The body key a model's `maxTokensParam` may name for its output limit.
export type MaxTokensParam = 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'

// What each kind adds to the common provider and model keys, the max-tokens body keys a model may name, the
// request body keys klyth sets (refused in params), whether its requests always carry a max-tokens value, and
// whether it takes cache points (the others cache on their own).
type KindSpec = {
  providerKeys: readonly string[]
  modelKeys: readonly string[]
  maxTokensParams: readonly MaxTokensParam[]
  reservedParams: readonly string[]
  sendsMaxTokens: boolean
  cache: boolean
}
export const KINDS: Readonly<Record<Kind, KindSpec>> = {
  openai: {
    providerKeys: ['streamUsage'],
    modelKeys: ['maxTokensParam', 'systemRole', 'parallelToolCalls'],
    maxTokensParams: ['max_tokens', 'max_completion_tokens'],
    reservedParams: ['model', 'messages', 'tools', 'stream', 'stream_options', 'n', 'tool_choice', 'functions', 'function_call'],
    sendsMaxTokens: false,
    cache: false,
  },
  'openai-responses': {
    providerKeys: [],
    modelKeys: ['maxTokensParam', 'parallelToolCalls'],
    maxTokensParams: ['max_output_tokens'],
    reservedParams: ['model', 'input', 'instructions', 'tools', 'tool_choice', 'stream', 'store', 'previous_response_id', 'conversation'],
    sendsMaxTokens: false,
    cache: false,
  },
  anthropic: {
    providerKeys: ['authHeader'],
    modelKeys: ['parallelToolCalls'],
    maxTokensParams: [],
    reservedParams: ['model', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'max_tokens'],
    sendsMaxTokens: true,
    cache: true,
  },
  bedrock: { providerKeys: [], modelKeys: [], maxTokensParams: [], reservedParams: ['messages', 'system', 'toolConfig'], sendsMaxTokens: true, cache: true },
}
