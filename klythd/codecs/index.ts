// Each provider kind's codec. Total over the kinds: a kind added to hooks/config.ts's KINDS needs its codec here.
import type { Kind } from '../../hooks/config'
import type { Codec } from '../codec'
import { anthropic } from './anthropic'
import { bedrock } from './bedrock'
import { openai } from './openai'
import { openaiResponses } from './openai-responses'

export const CODECS: Readonly<Record<Kind, Codec>> = { openai, 'openai-responses': openaiResponses, anthropic, bedrock }
