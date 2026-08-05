import type { OpenAIChatRequestType, CCMessage, CCContentPart, CCTool, CCRequest } from './types'
import { config } from './config'

function parseJsonArg(arg: unknown): unknown {
  if (!arg) return {}
  if (typeof arg === 'object') return arg
  try { return JSON.parse(arg as string) } catch { return arg }
}

export function transform(oai: OpenAIChatRequestType): CCRequest {
  const model = oai.model || 'deepseek/deepseek-v4-pro'
  let systemText = ''
  const messages: CCMessage[] = []

  const toolNameMap = new Map<string, string>()
  for (const m of oai.messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
      }
    }
  }

  for (const m of oai.messages) {
    if (m.role === 'system') {
      const s = typeof m.content === 'string' ? m.content : String(m.content ?? '')
      systemText += (systemText ? '\n\n' : '') + s
      continue
    }
    if (m.role === 'tool') {
      const c = typeof m.content === 'string'
        ? { type: 'text', value: m.content }
        : m.content
          ? (typeof m.content === 'object' && !Array.isArray(m.content) ? m.content as Record<string, unknown> : { type: 'text', value: String(m.content) })
          : { type: 'text', value: String(m.content) }
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: m.tool_call_id,
          toolName: toolNameMap.get(m.tool_call_id ?? '') || 'unknown',
          output: c,
        }],
      })
      continue
    }
    if (m.role === 'assistant') {
      const parts: CCContentPart[] = []
      if (m.content) {
        if (typeof m.content === 'string') {
          parts.push({ type: 'text', text: m.content })
        } else if (Array.isArray(m.content)) {
          for (const p of m.content as CCContentPart[]) {
            if (p.type === 'text') parts.push({ type: 'text', text: p.text })
          }
        }
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.type === 'function' && tc.function) {
            parts.push({
              type: 'tool-call',
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: parseJsonArg(tc.function.arguments),
            })
          }
        }
      }
      messages.push({ role: 'assistant', content: parts })
      continue
    }
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] })
    } else if (Array.isArray(m.content)) {
      const parts: CCContentPart[] = []
      for (const p of m.content as CCContentPart[]) {
        if (p.type === 'text') {
          parts.push({ type: 'text', text: p.text })
        } else if (p.type === 'image_url') {
          const imgUrl = (p as unknown as { image_url: { url: string } }).image_url?.url || ''
          const match = imgUrl.match(/^data:(image\/\w+);base64,(.+)$/)
          if (match) {
            parts.push({ type: 'image', image: match[2], mediaType: match[1] })
          } else {
            parts.push({ type: 'image', image: imgUrl, mediaType: 'image/png' })
          }
        }
      }
      messages.push({ role: m.role, content: parts })
    } else {
      messages.push({ role: m.role, content: [{ type: 'text', text: String(m.content) }] })
    }
  }

  const tools: CCTool[] = (oai.tools || []).map((t: Record<string, unknown>) => {
    const fn = (t.function || t) as Record<string, unknown>
    return {
      name: (fn.name as string) || '',
      description: (fn.description as string) || '',
      input_schema: (fn.parameters as Record<string, unknown>) || { type: 'object', properties: {} },
    }
  })

  return {
    config: { ...config.staticConfig, date: new Date().toISOString().slice(0, 10) },
    memory: '',
    taste: null,
    skills: null,
    permissionMode: 'standard',
    params: {
      model,
      system: systemText || undefined,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens: oai.max_tokens || 32000,
      temperature: oai.temperature,
      top_p: oai.top_p,
      stop: oai.stop,
      stream: true,
      ...(oai.reasoning_effort ? { reasoning_effort: oai.reasoning_effort } : {}),
    },
  }
}
