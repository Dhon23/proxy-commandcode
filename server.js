const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { PORT, HOST, CORS, agent, CC_VERSION } = require('./src/config');
const { log, logErr, logFile } = require('./src/logger');
const { transform } = require('./src/transform');
const { handleUpstreamResponse } = require('./src/response');
const { check, getStats } = require('./src/ratelimit');

const startTime = Date.now();
let totalReqs = 0, activeReqs = 0, draining = false;

log('=== proxy started ===');

function normalizeModels(body) {
  try {
    const obj = JSON.parse(body);
    if (Array.isArray(obj.data)) {
      for (const m of obj.data) {
        if (!m.permission) m.permission = [];
        if (!m.owned_by) m.owned_by = 'command-code';
      }
    }
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

function pipeUpstream(method, path, auth, res, transform) {
  const pr = https.request({
    hostname: HOST,
    path,
    method,
    agent,
    timeout: 30000,
    headers: { Authorization: auth, 'x-command-code-version': CC_VERSION },
  }, proxyRes => {
    if (transform) {
      let buf = '';
      proxyRes.on('data', c => { buf += c.toString(); });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { ...CORS, 'Content-Type': 'application/json' });
        res.end(transform(buf));
      });
    } else {
      res.writeHead(proxyRes.statusCode, { ...CORS, 'Content-Type': 'application/json' });
      proxyRes.pipe(res);
    }
  });
  pr.setTimeout(30000, () => {
    pr.destroy();
    if (!res.headersSent) { res.writeHead(504, CORS); res.end('{}'); }
  });
  pr.on('error', e => {
    logErr(`[upstream] ${e.message}`);
    if (!res.headersSent) { res.writeHead(502, CORS); res.end(JSON.stringify({ error: e.message })); }
  });
  pr.end();
}

function handleRequest(req, res) {
  if (draining) {
    res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Server shutting down', type: 'server_error', code: 503 } }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Max-Age': '86400' });
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/health/upstream') {
    const auth = req.headers['authorization'] || '';
    const pr = https.request({
      hostname: HOST,
      path: '/alpha/whoami',
      method: 'GET',
      agent,
      timeout: 5000,
      headers: { Authorization: auth, 'x-command-code-version': CC_VERSION },
    }, upstreamRes => {
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ status: 'ok', upstream: upstreamRes.statusCode }));
    });
    pr.setTimeout(5000, () => { pr.destroy(); res.writeHead(504, CORS); res.end(JSON.stringify({ status: 'error', upstream: 'timeout' })); });
    pr.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, CORS);
        res.end(JSON.stringify({ status: 'error', upstream: 'unreachable' }));
      }
    });
    pr.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/stats') {
    const rl = getStats();
    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      totalRequests: totalReqs,
      activeReqs,
      draining,
      rateLimits: rl,
    }));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    pipeUpstream('GET', '/provider/v1/models', req.headers['authorization'] || '', res, normalizeModels);
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, CORS);
    res.end(JSON.stringify({ error: 'POST /v1/chat/completions' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 10 * 1024 * 1024) {
      req.destroy();
      res.writeHead(413, CORS);
      res.end('{}');
    }
  });
  req.on('end', () => {
    let oai;
    try { oai = JSON.parse(body); } catch {
      res.writeHead(400, CORS);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    const model = oai.model || '-', isStream = oai.stream === true;

    const key = auth.replace(/^Bearer\s+/i, '').trim() || 'anonymous';
    const rl = check(key, oai.max_tokens || 32000);
    if (!rl.allowed) {
      res.writeHead(429, { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: { message: rl.reason, type: 'rate_limit_error', param: null, code: 429 } }));
      log(`[req] ${model} stream=${isStream} RATE_LIMITED`);
      return;
    }

    log(`[req] ${model} stream=${isStream}`);
    totalReqs++;
    activeReqs++;

    let upstream;
    try { upstream = transform(oai); } catch (e) {
      activeReqs = Math.max(0, activeReqs - 1);
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: 'Transform error' }));
      return;
    }

    const pr = https.request({
      hostname: HOST,
      path: '/alpha/generate',
      method: 'POST',
      agent,
      timeout: 300000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(upstream),
        Authorization: auth,
        'x-command-code-version': CC_VERSION,
        'x-cli-environment': 'production',
        'x-session-id': crypto.randomUUID(),
      },
    }, proxyRes => {
      log(`[upstream] ${proxyRes.statusCode}`);
      handleUpstreamResponse(proxyRes, res, model, isStream);
    });
    pr.setTimeout(300000, () => {
      logErr('[upstream] timeout');
      pr.destroy();
      if (!res.headersSent) { res.writeHead(504, CORS); res.end('{}'); }
    });
    pr.on('error', e => {
      logErr(`[upstream] ${e.message}`);
      if (!res.headersSent) { res.writeHead(502, CORS); res.end(JSON.stringify({ error: e.message })); }
    });

    res.once('finish', () => { activeReqs = Math.max(0, activeReqs - 1); });

    pr.write(upstream);
    pr.end();
  });
}

try {
  const netstat = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
  const match = netstat.trim().match(/(\d+)\s*$/m);
  if (match) {
    const pid = match[1];
    log(`killing existing process on port ${PORT} (PID ${pid})`);
    execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
  }
} catch {}

const server = http.createServer(handleRequest);
server.timeout = 300000;
server.keepAliveTimeout = 120000;
server.listen(PORT, () => log(`listening on http://localhost:${PORT}`));
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    logErr(`Port ${PORT} still in use after kill attempt`);
    process.exit(1);
  }
  throw e;
});

setInterval(() => {
  const { sockets, freeSockets, requests } = agent;
  const socketCount = Object.values(sockets).reduce((s, a) => s + a.length, 0);
  const freeCount = Object.values(freeSockets).reduce((s, a) => s + a.length, 0);
  const pendingCount = Object.values(requests || {}).reduce((s, a) => s + a.length, 0);
  log(`[pool] sockets=${socketCount} free=${freeCount} pending=${pendingCount}`);
}, 60000);

function shutdown() {
  draining = true;
  log(`=== draining ${activeReqs} requests ===`);
  server.close(() => {
    if (activeReqs === 0) {
      log('=== all requests drained ===');
      logFile.end(() => process.exit(0));
    }
  });
  const forceExit = setTimeout(() => {
    log('=== force exit after drain timeout ===');
    logFile.end(() => process.exit(0));
  }, 30000);
  const checkDrain = setInterval(() => {
    if (activeReqs === 0) {
      clearTimeout(forceExit);
      clearInterval(checkDrain);
      log('=== all requests drained ===');
      logFile.end(() => process.exit(0));
    }
  }, 200);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);