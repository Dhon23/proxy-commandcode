const { CORS, sse } = require('./config');
const { log } = require('./logger');

function handleUpstreamResponse(proxyRes, res, model, isStream) {
  if (proxyRes.statusCode >= 400) {
    res.writeHead(proxyRes.statusCode, { ...CORS, 'Content-Type': 'application/json' });
    proxyRes.pipe(res);
    return;
  }

  const genId = 'chatcmpl-' + Date.now();

  if (!isStream) {
    let buf = '', fullText = '', fullReasoning = '';
    const toolCalls = [];
    let toolPart = null;

    proxyRes.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let evt;
        try { evt = JSON.parse(t); } catch { continue; }
        switch (evt.type) {
          case 'text-delta':
            fullText += evt.text || '';
            break;
          case 'reasoning-delta':
            fullReasoning += evt.text || '';
            break;
          case 'tool-input-start':
            toolPart = {
              id: evt.id,
              type: 'function',
              function: { name: evt.toolName, arguments: '' },
            };
            toolCalls.push(toolPart);
            break;
          case 'tool-input-delta':
            if (evt.delta && toolPart) toolPart.function.arguments += evt.delta;
            break;
          case 'tool-input-end':
          case 'tool-call':
            toolPart = null;
            break;
        }
      }
    });

    proxyRes.on('end', () => {
      if (buf.trim()) {
        try {
          const evt = JSON.parse(buf.trim());
          if (evt.type === 'text-delta') fullText += evt.text || '';
          else if (evt.type === 'reasoning-delta') fullReasoning += evt.text || '';
        } catch {}
      }
      const text = fullText || fullReasoning;
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
        msg.content = text || null;
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: genId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: msg, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
      log(`[done] text=${text.length} tools=${toolCalls.length}`);
    });
  } else {
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let buf = '', toolCalls = [], toolIdx = 0, roleSent = false, tChars = 0, rChars = 0;

    const write = (chunk) => res.write(sse(chunk));
    const base = () => ({
      id: genId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
    });
    const ensureRole = () => {
      if (!roleSent) {
        roleSent = true;
        write({ ...base(), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      }
    };

    proxyRes.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let evt;
        try { evt = JSON.parse(t); } catch { continue; }
        switch (evt.type) {
          case 'text-start':
            toolCalls = [];
            toolIdx = 0;
            roleSent = true;
            write({ ...base(), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            break;
          case 'text-delta':
            if (evt.text) {
              tChars += evt.text.length;
              write({ ...base(), choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }] });
            }
            break;
          case 'reasoning-delta':
            if (evt.text) {
              rChars += evt.text.length;
              ensureRole();
              write({ ...base(), choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }] });
            }
            break;
          case 'tool-input-start':
            ensureRole();
            toolIdx = toolCalls.length;
            toolCalls.push({ id: evt.id, name: evt.toolName });
            write({
              ...base(),
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: toolIdx, id: evt.id, type: 'function', function: { name: evt.toolName, arguments: '' } }] },
                finish_reason: null,
              }],
            });
            break;
          case 'tool-input-delta':
            if (evt.delta && toolCalls[toolIdx]) {
              write({
                ...base(),
                choices: [{
                  index: 0,
                  delta: { tool_calls: [{ index: toolIdx, function: { arguments: evt.delta } }] },
                  finish_reason: null,
                }],
              });
            }
            break;
        }
      }
    });

    proxyRes.on('end', () => {
      const reason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
      write({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      res.write('data: [DONE]\n\n');
      res.end();
      log(`[done] text=${tChars} reasoning=${rChars} tools=${toolCalls.length} reason=${reason}`);
    });
  }

  proxyRes.on('error', () => {
    if (!res.writableEnded) res.end();
  });
}

module.exports = { handleUpstreamResponse };