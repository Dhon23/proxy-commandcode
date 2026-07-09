const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { PORT, HOST, CORS, agent, CC_VERSION } = require('./src/config');
const { log, logErr, logFile } = require('./src/logger');
const { transform } = require('./src/transform');
const { handleUpstreamResponse } = require('./src/response');

log('=== proxy started ===');

function handleRequest(req, res) {
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
    log(`[req] ${model} stream=${isStream}`);

    let upstream;
    try { upstream = transform(oai); } catch (e) {
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
process.on('SIGINT', () => server.close(() => logFile.end(() => process.exit(0))));