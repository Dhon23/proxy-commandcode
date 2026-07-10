import type {
  CCStreamEvent,
  OpenAIChatCompletion,
  OpenAIChatChunk,
  OpenAIToolCall,
  OpenAIToolCallDelta,
  CCUsage,
  OpenAIUsage,
} from './types'
import { logger } from './logger'

const errorTypeMap: Record<string, string> = {
  UNAUTHORIZED: 'authentication_error',
  PERMISSION_ERROR: 'insufficient_quota',
  BAD_REQUEST: 'invalid_request_error',
  RATE_LIMITED: 'rate_limit_error',
  INTERNAL_ERROR: 'server_error',
}

function translateError(body: string): string {
  try {
    const cc = JSON.parse(body)
    if (cc.error) {
      return JSON.stringify({
        error: {
          message: cc.error.message || 'Unknown error',
          type: errorTypeMap[cc.error.code] || 'server_error',
          param: null,
          code: cc.error.status || 500,
        },
      })
    }
  } catch { /* not JSON */ }
  return body
}

function parseLine(line: string): CCStreamEvent | null {
  const t = line.trim()
  if (!t) return null
  try { return JSON.parse(t) } catch { return null }
}

function extractUsage(evt: CCStreamEvent | null): CCUsage & { cost: number | null } {
  const result = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    cost: null as number | null,
  }
  if (!evt?.usage) return result
  const u = evt.usage
  result.inputTokens = u.inputTokens || 0
  result.outputTokens = u.outputTokens || 0
  result.totalTokens = u.totalTokens || 0
  result.cachedInputTokens = u.cachedInputTokens || 0
  result.reasoningTokens = u.reasoningTokens || 0
  if (evt.providerMetadata?.gateway?.cost) {
    result.cost = evt.providerMetadata.gateway.cost
  }
  return result
}

function logUsage(model: string, tokens: CCUsage & { cost: number | null }): void {
  const parts = [
    `in=${tokens.inputTokens}`,
    `out=${tokens.outputTokens}`,
    `total=${tokens.totalTokens}`,
  ]
  if (tokens.cachedInputTokens) parts.push(`cache=${tokens.cachedInputTokens}`)
  if (tokens.reasoningTokens) parts.push(`reason=${tokens.reasoningTokens}`)
  if (tokens.cost) parts.push(`cost=$${tokens.cost}`)
  logger.info({ model, usage: tokens }, `[usage] ${model} ${parts.join(' ')}`)
}

function sse(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export async function handleUpstreamResponse(
  src: ReadableStream<Uint8Array>,
  statusCode: number,
  model: string,
  clientStream: boolean,
): Promise<Response> {
  if (statusCode >= 400) {
    return handleError(src, statusCode)
  }
  if (clientStream) {
    return handleStream(src, model)
  }
  return handleBuffer(src, model)
}

async function handleError(src: ReadableStream<Uint8Array>, statusCode: number): Promise<Response> {
  const reader = src.getReader()
  let errorBuf = ''
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      errorBuf += decoder.decode(value, { stream: true })
    }
    errorBuf += decoder.decode()
  } catch { /* stream error */ }

  const body = translateError(errorBuf)
  return new Response(body, {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleBuffer(src: ReadableStream<Uint8Array>, model: string): Promise<Response> {
  const reader = src.getReader()
  const decoder = new TextDecoder()
  let genId = 'chatcmpl-' + Date.now()
  let fullText = ''
  let fullReasoning = ''
  let finishReason = 'stop'
  const toolCalls: OpenAIToolCall[] = []
  let toolPart: OpenAIToolCall | null = null
  let fullUsage: CCUsage & { cost: number | null } | null = null

  try {
    let buf = ''
    let done = false
    while (!done) {
      const result = await reader.read()
      done = result.done
      if (result.value) buf += decoder.decode(result.value, { stream: !done })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const evt = parseLine(line)
        if (!evt) continue
        switch (evt.type) {
          case 'start':
            if (evt.id) genId = evt.id
            break
          case 'text-delta':
            fullText += evt.text || ''
            break
          case 'reasoning-delta':
            fullReasoning += evt.text || ''
            break
          case 'tool-input-start':
            toolPart = { id: evt.id!, type: 'function', function: { name: evt.toolName!, arguments: '' } }
            toolCalls.push(toolPart)
            break
          case 'tool-input-delta':
            if (evt.delta && toolPart) toolPart.function.arguments += evt.delta
            break
          case 'tool-input-end':
          case 'tool-call':
            toolPart = null
            break
          case 'finish-step':
          case 'finish':
            finishReason = evt.finishReason || finishReason
            fullUsage = extractUsage(evt)
            break
        }
      }
    }
    if (buf.trim()) {
      const evt = parseLine(buf.trim())
      if (evt) {
        if (evt.type === 'text-delta') fullText += evt.text || ''
        else if (evt.type === 'reasoning-delta') fullReasoning += evt.text || ''
        else if (evt.type === 'finish-step' || evt.type === 'finish') {
          finishReason = evt.finishReason || finishReason
          fullUsage = extractUsage(evt)
        }
      }
    }
  } catch { /* stream error */ }

  const usage: OpenAIUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  if (fullUsage) {
    usage.prompt_tokens = fullUsage.inputTokens
    usage.completion_tokens = fullUsage.outputTokens
    usage.total_tokens = fullUsage.totalTokens
    logUsage(model, fullUsage)
  }

  const text = fullText || fullReasoning
  const msg: OpenAIChatCompletion['choices'][0]['message'] = {
    role: 'assistant' as const,
    content: text || null,
  }
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls
    msg.content = text || null
  }

  const completion: OpenAIChatCompletion = {
    id: genId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
    }],
    usage,
  }

  logger.info({ model, textLen: text.length, toolCalls: toolCalls.length }, `[done] text=${text.length} tools=${toolCalls.length}`)

  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleStream(src: ReadableStream<Uint8Array>, model: string): Promise<Response> {
  const reader = src.getReader()
  const decoder = new TextDecoder()
  let genId = 'chatcmpl-' + Date.now()
  let toolIdx = 0
  let roleSent = false
  let tChars = 0
  let rChars = 0
  let finishReason = 'stop'
  const toolCalls: { id: string; name: string }[] = []
  let fullUsage: CCUsage & { cost: number | null } | null = null

  const encoder = new TextEncoder()
  const base = (): Partial<OpenAIChatChunk> => ({
    id: genId,
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model,
  })

  const ensureRole = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!roleSent) {
      roleSent = true
      controller.enqueue(encoder.encode(sse({
        ...base(),
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })))
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buf = ''
      let done = false

      try {
        while (!done) {
          const result = await reader.read()
          done = result.done
          if (result.value) buf += decoder.decode(result.value, { stream: !done })
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const line of lines) {
            const evt = parseLine(line)
            if (!evt) continue
            switch (evt.type) {
              case 'start':
                if (evt.id) genId = evt.id
                break
              case 'text-start':
                toolCalls.length = 0
                toolIdx = 0
                roleSent = true
                controller.enqueue(encoder.encode(sse({
                  ...base(),
                  choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
                })))
                break
              case 'text-delta':
                if (evt.text) {
                  tChars += evt.text.length
                  controller.enqueue(encoder.encode(sse({
                    ...base(),
                    choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }],
                  })))
                }
                break
              case 'reasoning-delta':
                if (evt.text) {
                  rChars += evt.text.length
                  ensureRole(controller)
                  controller.enqueue(encoder.encode(sse({
                    ...base(),
                    choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
                    reasoning_content: evt.text,
                  })))
                }
                break
              case 'tool-input-start':
                ensureRole(controller)
                toolIdx = toolCalls.length
                toolCalls.push({ id: evt.id!, name: evt.toolName! })
                controller.enqueue(encoder.encode(sse({
                  ...base(),
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIdx,
                        id: evt.id,
                        type: 'function' as const,
                        function: { name: evt.toolName!, arguments: '' },
                      }],
                    },
                    finish_reason: null,
                  }],
                })))
                break
              case 'tool-input-delta':
                if (evt.delta && toolCalls[toolIdx]) {
                  const tc: OpenAIToolCallDelta = { index: toolIdx, function: { arguments: evt.delta } }
                  controller.enqueue(encoder.encode(sse({
                    ...base(),
                    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
                  })))
                }
                break
              case 'finish-step':
              case 'finish':
                finishReason = evt.finishReason || finishReason
                fullUsage = extractUsage(evt)
                break
            }
          }
        }
      } catch { /* stream error */ }

      const usage: OpenAIUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      if (fullUsage) {
        usage.prompt_tokens = fullUsage.inputTokens
        usage.completion_tokens = fullUsage.outputTokens
        usage.total_tokens = fullUsage.totalTokens
        logUsage(model, fullUsage)
      }

      const reason = toolCalls.length > 0 ? 'tool_calls' : finishReason
      controller.enqueue(encoder.encode(sse({
        ...base(),
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
        usage,
      })))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()

      logger.info({
        model,
        textChars: tChars,
        reasoningChars: rChars,
        toolCalls: toolCalls.length,
        finishReason: reason,
      }, `[done] text=${tChars} reasoning=${rChars} tools=${toolCalls.length} reason=${reason}`)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
