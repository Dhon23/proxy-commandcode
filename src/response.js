const { CORS, sse } = require('./config');
const { log } = require('./logger');

function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function extractUsage(evt) {
  if (!evt || !evt.usage) return null;
  const u = evt.usage;
  return {
    prompt_tokens: u.inputTokens || 0,
    completion_tokens: u.outputTokens || 0,
    total_tokens: u.totalTokens || 0,
  };
}

function handleUpstreamResponse(proxyRes, res, model, clientStream) {
  if (proxyRes.statusCode >= 400) {
    res.writeHead(proxyRes.statusCode, { ...CORS, 'Content-Type': 'application/json' });
    proxyRes.pipe(res);
    return;
  }

  let genId = 'chatcmpl-' + Date.now();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (!clientStream) {
    let buf = '', fullText = '', fullReasoning = '', finishReason = 'stop';
    const toolCalls = [];
    let toolPart = null;

    proxyRes.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const evt = parseLine(line);
        if (!evt) continue;
        switch (evt.type) {
          case 'start':
            if (evt.id) genId = evt.id;
            break;
          case 'text-delta':
            fullText += evt.text || '';
            break;
          case 'reasoning-delta':
            fullReasoning += evt.text || '';
            break;
          case 'tool-input-start':
            toolPart = { id: evt.id, type: 'function', function: { name: evt.toolName, arguments: '' } };
            toolCalls.push(toolPart);
            break;
          case 'tool-input-delta':
            if (evt.delta && toolPart) toolPart.function.arguments += evt.delta;
            break;
          case 'tool-input-end':
          case 'tool-call':
            toolPart = null;
            break;
          case 'finish-step':
          case 'finish':
            finishReason = evt.finishReason || finishReason;
            {
              const u = extractUsage(evt);
              if (u) usage = u;
            }
            break;
        }
      }
    });

    proxyRes.on('end', () => {
      if (buf.trim()) {
        const evt = parseLine(buf.trim());
        if (evt) {
          if (evt.type === 'text-delta') fullText += evt.text || '';
          else if (evt.type === 'reasoning-delta') fullReasoning += evt.text || '';
          else if (evt.type === 'finish-step' || evt.type === 'finish') {
            finishReason = evt.finishReason || finishReason;
            const u = extractUsage(evt);
            if (u) usage = u;
          }
        }
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
        choices: [{ index: 0, message: msg, finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason }],
        usage,
      }));
      log(`[done] text=${text.length} tools=${toolCalls.length}`);
    });
  } else {
    let buf = '', toolCalls = [], toolIdx = 0, roleSent = false, tChars = 0, rChars = 0;
    let finishReason = 'stop';

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const write = (chunk) => res.write(sse(chunk));
    const base = () => ({ id: genId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model });
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
        const evt = parseLine(line);
        if (!evt) continue;
        switch (evt.type) {
          case 'start':
            if (evt.id) genId = evt.id;
            break;
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
              write({
                ...base(),
                choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
                reasoning_content: evt.text,
              });
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
          case 'finish-step':
          case 'finish':
            finishReason = evt.finishReason || finishReason;
            {
              const u = extractUsage(evt);
              if (u) usage = u;
            }
            break;
        }
      }
    });

    proxyRes.on('end', () => {
      const reason = toolCalls.length > 0 ? 'tool_calls' : finishReason;
      write({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { ...usage } });
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