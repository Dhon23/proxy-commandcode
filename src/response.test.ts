import { describe, test, expect } from 'bun:test'
import { handleUpstreamResponse } from './response'

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const data = encoder.encode(lines.join('\n') + '\n')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
}

function chunkedNdjsonStream(lines: string[], chunkSize = 3): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const data = encoder.encode(lines.join('\n') + '\n')
  let offset = 0

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, data.length)
      controller.enqueue(data.slice(offset, end))
      offset = end
    },
  })
}

function sseEvents(response: Response): Promise<string[]> {
  return response.text().then((body) => {
    const events: string[] = []
    const parts = body.split('\n\n')
    for (const part of parts) {
      const trimmed = part.trim()
      if (trimmed && trimmed !== 'data: [DONE]') {
        events.push(trimmed)
      }
    }
    return events
  })
}

describe('handleUpstreamResponse', () => {
  describe('error path', () => {
    test('translates 401 to authentication_error', async () => {
      const body = ndjsonStream(['{"error":{"code":"UNAUTHORIZED","message":"Invalid token","status":401}}'])
      const res = await handleUpstreamResponse(body, 401, 'deepseek/deepseek-v4-pro', false, 0)

      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error.type).toBe('authentication_error')
      expect(json.error.message).toBe('Invalid token')
    })

    test('translates 400 to invalid_request_error', async () => {
      const body = ndjsonStream(['{"error":{"code":"BAD_REQUEST","message":"Bad input","status":400}}'])
      const res = await handleUpstreamResponse(body, 400, 'deepseek/deepseek-v4-pro', false, 0)

      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error.type).toBe('invalid_request_error')
    })
  })

  describe('non-streaming (buffer) path', () => {
    test('accumulates text-delta events into a completion', async () => {
      const lines = [
        '{"type":"start","id":"msg_abc123"}',
        '{"type":"text-delta","text":"Hello, "}',
        '{"type":"text-delta","text":"world!"}',
        '{"type":"finish","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15,"cachedInputTokens":0,"reasoningTokens":0}}',
      ]
      const body = chunkedNdjsonStream(lines)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', false, 0)

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.object).toBe('chat.completion')
      expect(json.id).toBe('msg_abc123')
      expect(json.choices[0].message.content).toBe('Hello, world!')
      expect(json.choices[0].finish_reason).toBe('stop')
      expect(json.usage).toBeDefined()
      expect(json.usage.prompt_tokens).toBe(10)
    })

    test('uses fallback id when no start event', async () => {
      const lines = [
        '{"type":"text-delta","text":"Hi"}',
        '{"type":"finish","finishReason":"stop"}',
      ]
      const body = chunkedNdjsonStream(lines)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', false, 0)

      const json = await res.json()
      expect(json.id).toMatch(/^chatcmpl-/)
    })

    test('handles tool calls in non-streaming mode', async () => {
      const lines = [
        '{"type":"start","id":"msg_tool"}',
        '{"type":"text-delta","text":"Let me check."}',
        '{"type":"tool-input-start","id":"call_1","toolName":"get_weather"}',
        '{"type":"tool-input-delta","delta":"{\\"loc"}',
        '{"type":"tool-input-delta","delta":"ation\\":\\"SF\\"}"}',
        '{"type":"tool-input-end"}',
        '{"type":"finish","finishReason":"tool_calls","usage":{"inputTokens":10,"outputTokens":20,"totalTokens":30,"cachedInputTokens":0,"reasoningTokens":0}}',
      ]
      const body = chunkedNdjsonStream(lines)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', false, 0)

      const json = await res.json()
      expect(json.choices[0].finish_reason).toBe('tool_calls')
      expect(json.choices[0].message.tool_calls).toHaveLength(1)
      expect(json.choices[0].message.tool_calls[0].id).toBe('call_1')
      expect(json.choices[0].message.tool_calls[0].function.name).toBe('get_weather')
      expect(json.choices[0].message.tool_calls[0].function.arguments).toBe('{"location":"SF"}')
      expect(json.choices[0].message.content).toBe('Let me check.')
    })

    test('computes tokens when usage event is missing', async () => {
      const lines = [
        '{"type":"text-delta","text":"Hello world"}',
        '{"type":"finish","finishReason":"stop"}',
      ]
      const body = chunkedNdjsonStream(lines)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', false, 100)

      const json = await res.json()
      expect(json.usage.prompt_tokens).toBe(100)
      expect(json.usage.completion_tokens).toBeGreaterThan(0)
      expect(json.usage.total_tokens).toBeGreaterThan(100)
    })

    test('returns empty content for empty responses', async () => {
      const lines = [
        '{"type":"finish","finishReason":"stop"}',
      ]
      const body = chunkedNdjsonStream(lines)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', false, 0)

      const json = await res.json()
      expect(json.choices[0].message.content).toBeNull()
    })
  })

  describe('streaming path', () => {
    test('emits SSE events for text deltas', async () => {
      const lines = [
        '{"type":"start","id":"msg_stream"}',
        '{"type":"text-start"}',
        '{"type":"text-delta","text":"Hello, "}',
        '{"type":"text-delta","text":"world!"}',
        '{"type":"finish","finishReason":"stop","usage":{"inputTokens":5,"outputTokens":4,"totalTokens":9,"cachedInputTokens":0,"reasoningTokens":0}}',
      ]
      const body = chunkedNdjsonStream(lines, 2)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', true, 0)

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('text/event-stream')

      const events = await sseEvents(res)
      const eventTypes = events.map((e) => {
        const data = e.startsWith('data: ') ? e.slice(6) : e
        const json = JSON.parse(data)
        return {
          hasRole: json.choices?.[0]?.delta?.role === 'assistant',
          content: json.choices?.[0]?.delta?.content || '',
          finishReason: json.choices?.[0]?.finish_reason,
          isDone: e === 'data: [DONE]',
        }
      })

      const contents = eventTypes.map((e) => e.content)
      expect(contents.join('')).toBe('Hello, world!')
    })

    test('emits tool call chunks in streaming mode', async () => {
      const lines = [
        '{"type":"start","id":"msg_tool_stream"}',
        '{"type":"text-start"}',
        '{"type":"text-delta","text":"I\'ll search."}',
        '{"type":"tool-input-start","id":"call_2","toolName":"search"}',
        '{"type":"tool-input-delta","delta":"{\\"q\\":\\"}',
        '{"type":"tool-input-delta","delta":"test\\"}"}',
        '{"type":"tool-input-end"}',
        '{"type":"finish","finishReason":"tool_calls","usage":{"inputTokens":5,"outputTokens":10,"totalTokens":15,"cachedInputTokens":0,"reasoningTokens":0}}',
      ]
      const body = chunkedNdjsonStream(lines, 2)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', true, 0)

      const events = await sseEvents(res)
      const toolCallEvents = events.filter((e) => {
        const data = e.startsWith('data: ') ? e.slice(6) : e
        const json = JSON.parse(data)
        return json.choices?.[0]?.delta?.tool_calls !== undefined
      })

      expect(toolCallEvents.length).toBeGreaterThan(0)

      const firstTc = JSON.parse(toolCallEvents[0].startsWith('data: ') ? toolCallEvents[0].slice(6) : toolCallEvents[0])
      expect(firstTc.choices[0].delta.tool_calls[0].function.name).toBe('search')
    })

    test('ends with finish_reason and [DONE]', async () => {
      const lines = [
        '{"type":"start","id":"msg_end"}',
        '{"type":"text-start"}',
        '{"type":"text-delta","text":"Done"}',
        '{"type":"finish","finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2,"cachedInputTokens":0,"reasoningTokens":0}}',
      ]
      const body = chunkedNdjsonStream(lines, 2)
      const res = await handleUpstreamResponse(body, 200, 'deepseek/deepseek-v4-pro', true, 0)

      const text = await res.text()
      const parts = text.trim().split('\n\n')
      const last = parts[parts.length - 1]?.trim()

      expect(last).toBe('data: [DONE]')

      const finishPart = parts[parts.length - 2]?.trim()
      const finishData = finishPart?.startsWith('data: ') ? finishPart.slice(6) : finishPart
      expect(JSON.parse(finishData!).choices[0].finish_reason).toBe('stop')
    })
  })
})
