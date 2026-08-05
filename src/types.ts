import { z } from 'zod'

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string }
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export const OpenAIChatRequest = z.object({
  model: z.string().optional().default('deepseek/deepseek-v4-pro'),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
    name: z.string().optional(),
    tool_calls: z.array(z.object({
      id: z.string(),
      type: z.literal('function'),
      function: z.object({
        name: z.string(),
        arguments: z.string(),
      }),
    })).optional(),
    tool_call_id: z.string().optional(),
  })),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.unknown()).optional(),
    }),
  })).optional(),
  stream: z.boolean().optional(),
  max_tokens: z.number().optional().default(32000),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
})

export type OpenAIChatRequestType = z.infer<typeof OpenAIChatRequest>

export interface CCContentPart {
  type: string
  text?: string
  value?: string
  image?: string
  mediaType?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

export interface CCMessage {
  role: string
  content: CCContentPart[]
}

export interface CCTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface CCParams {
  model: string
  system?: string
  messages: CCMessage[]
  tools?: CCTool[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  stream: true
}

export interface CCRequest {
  config: Record<string, unknown>
  memory: string
  taste: null
  skills: null
  permissionMode: string
  params: CCParams
}

export interface CCStreamEvent {
  type: string
  id?: string
  text?: string
  toolName?: string
  delta?: string
  finishReason?: string
  usage?: CCUsage
  providerMetadata?: {
    gateway?: {
      cost?: number
    }
  }
}

export interface CCUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface OpenAIChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChatChoice[]
  usage: OpenAIUsage
}

export interface OpenAIChatChoice {
  index: number
  message: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: string
}

export interface OpenAIChatChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: OpenAIChatChunkChoice[]
  usage?: OpenAIUsage
}

export interface OpenAIChatChunkChoice {
  index: number
  delta: {
    role?: string
    content?: string
    reasoning_content?: string
    tool_calls?: OpenAIToolCallDelta[]
  }
  finish_reason: string | null
}

export interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export interface CCEvent {
  type: string
  text?: string
}

export interface RateLimitResult {
  allowed: boolean
  reason?: string
}

export interface RateLimitStats {
  activeKeys: number
  currentRPM: number
  currentTPM: number
  limits: { rpm: number; tpm: number }
}
