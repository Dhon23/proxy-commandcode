const { STATIC_CONFIG } = require('./config');

function parseJsonArg(arg) {
  if (!arg) return {};
  if (typeof arg === 'object') return arg;
  try { return JSON.parse(arg); } catch { return arg; }
}

function transform(oaiBody) {
  const model = oaiBody.model || 'deepseek/deepseek-v4-pro';
  let systemText = '';
  const messages = [];

  const toolNameMap = {};
  for (const m of oaiBody.messages || []) {
    if (m.role === 'assistant' && m.tool_calls)
      for (const tc of m.tool_calls)
        if (tc.id && tc.function?.name) toolNameMap[tc.id] = tc.function.name;
  }

  for (const m of oaiBody.messages || []) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : String(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const c = typeof m.content === 'string'
        ? { type: 'text', value: m.content }
        : (m.content || { type: 'text', value: String(m.content) });
      messages.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: m.tool_call_id, toolName: toolNameMap[m.tool_call_id] || 'unknown', output: c }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) {
        if (typeof m.content === 'string') parts.push({ type: 'text', text: m.content });
        else if (Array.isArray(m.content))
          for (const p of m.content) if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      }
      if (m.tool_calls)
        for (const tc of m.tool_calls)
          if (tc.type === 'function' && tc.function)
            parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: parseJsonArg(tc.function.arguments) });
      messages.push({ role: 'assistant', content: parts });
      continue;
    }
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          const imgUrl = p.image_url?.url || '';
          const m = imgUrl.match(/^data:(image\/\w+);base64,(.+)$/);
          if (m) {
            parts.push({ type: 'image', image: m[2], mediaType: m[1] });
          } else {
            parts.push({ type: 'image', image: imgUrl, mediaType: 'image/png' });
          }
        }
      }
      messages.push({ role: m.role, content: parts });
    } else {
      messages.push({ role: m.role, content: [{ type: 'text', text: String(m.content) }] });
    }
  }

  const tools = (oaiBody.tools || []).map(t => ({
    name: t.function?.name || t.name,
    description: t.function?.description || t.description || '',
    input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
  }));

  return JSON.stringify({
    config: { ...STATIC_CONFIG, date: new Date().toISOString().slice(0, 10) },
    memory: '',
    taste: null,
    skills: null,
    permissionMode: 'standard',
    params: {
      model,
      system: systemText || undefined,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens: oaiBody.max_tokens || 32000,
      temperature: oaiBody.temperature,
      top_p: oaiBody.top_p,
      stop: oaiBody.stop,
      stream: true,
    },
  });
}

module.exports = { transform };