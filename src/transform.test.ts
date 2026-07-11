import { describe, test, expect } from 'bun:test'
import { transform } from './transform'
import type { OpenAIChatRequestType } from './types'

function req(overrides: Partial<OpenAIChatRequestType>): OpenAIChatRequestType {
  return {
    model: 'deepseek/deepseek-v4-pro',
    max_tokens: 32000,
    messages: [{ role: 'user', content: 'test' }],
    ...overrides,
  }
}

function msg(role: OpenAIChatRequestType['messages'][0]['role'], content: string) {
  return { role, content }
}

describe('transform', () => {
  test('basic user message with default model', () => {
    const result = transform(req({ model: undefined as unknown as string, messages: [msg('user', 'Hello')] }))

    expect(result.params.model).toBe('deepseek/deepseek-v4-pro')
    expect(result.params.messages).toHaveLength(1)
    expect(result.params.messages[0].role).toBe('user')
    expect(result.params.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(result.params.system).toBeUndefined()
  })

  test('extracts system message', () => {
    const result = transform(req({
      messages: [msg('system', 'You are a helpful assistant.'), msg('user', 'Hi')],
    }))

    expect(result.params.system).toBe('You are a helpful assistant.')
    expect(result.params.messages).toHaveLength(1)
    expect(result.params.messages[0].role).toBe('user')
  })

  test('merges multiple system messages', () => {
    const result = transform(req({
      messages: [msg('system', 'First instruction.'), msg('system', 'Second instruction.'), msg('user', 'Hello')],
    }))

    expect(result.params.system).toBe('First instruction.\n\nSecond instruction.')
    expect(result.params.messages).toHaveLength(1)
  })

  test('handles custom model', () => {
    const result = transform(req({ model: 'moonshotai/Kimi-K2.5', messages: [msg('user', 'test')] }))

    expect(result.params.model).toBe('moonshotai/Kimi-K2.5')
  })

  test('converts assistant messages with content', () => {
    const result = transform(req({
      messages: [msg('user', 'Hello'), { role: 'assistant', content: 'Hi there!' }],
    }))

    expect(result.params.messages).toHaveLength(2)
    expect(result.params.messages[1].role).toBe('assistant')
    expect(result.params.messages[1].content).toEqual([{ type: 'text', text: 'Hi there!' }])
  })

  test('converts tool calls', () => {
    const result = transform(req({
      messages: [
        { role: 'user', content: 'Get weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_123', type: 'function' as const, function: { name: 'get_weather', arguments: '{"location":"NYC"}' } },
          ],
        },
        { role: 'tool', content: 'Sunny 72F', tool_call_id: 'call_123' },
      ],
    }))

    const assistant = result.params.messages[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toHaveLength(1)
    expect(assistant.content[0].type).toBe('tool-call')
    expect(assistant.content[0].toolCallId).toBe('call_123')
    expect(assistant.content[0].toolName).toBe('get_weather')
    expect(assistant.content[0].input).toEqual({ location: 'NYC' })

    const tool = result.params.messages[2]
    expect(tool.role).toBe('tool')
    expect(tool.content).toHaveLength(1)
    expect(tool.content[0].type).toBe('tool-result')
    expect(tool.content[0].toolCallId).toBe('call_123')
    expect(tool.content[0].toolName).toBe('get_weather')
    expect(tool.content[0].output).toEqual({ type: 'text', value: 'Sunny 72F' })
  })

  test('converts tools to CCTool format', () => {
    const result = transform(req({
      tools: [{
        type: 'function' as const,
        function: { name: 'search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
      }],
    }))

    expect(result.params.tools).toHaveLength(1)
    expect(result.params.tools![0].name).toBe('search')
    expect(result.params.tools![0].description).toBe('Search the web')
    expect(result.params.tools![0].input_schema).toEqual({ type: 'object', properties: { query: { type: 'string' } } })
  })

  test('passes through temperature, top_p, stop', () => {
    const result = transform(req({ temperature: 0.7, top_p: 0.9, stop: ['END'] }))

    expect(result.params.temperature).toBe(0.7)
    expect(result.params.top_p).toBe(0.9)
    expect(result.params.stop).toEqual(['END'])
  })

  test('max_tokens defaults to 32000', () => {
    const result = transform(req({}))

    expect(result.params.max_tokens).toBe(32000)
  })

  test('stream is always true in upstream request', () => {
    const result = transform(req({ stream: false }))

    expect(result.params.stream).toBe(true)
  })

  test('config includes staticConfig merged with date', () => {
    const result = transform(req({}))

    expect(result.config.workingDir).toBe('')
    expect(result.config.isGitRepo).toBe(false)
    expect(result.config.mainBranch).toBe('main')
    expect(result.config.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('req shape matches CCRequest interface', () => {
    const result = transform(req({}))

    expect(result).toHaveProperty('config')
    expect(result.memory).toBe('')
    expect(result.taste).toBeNull()
    expect(result.skills).toBeNull()
    expect(result.permissionMode).toBe('standard')
    expect(result).toHaveProperty('params')
  })
})
