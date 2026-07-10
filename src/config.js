const https = require('https');

const PORT = process.env.PCMC_PORT || 3456;
const HOST = 'api.commandcode.ai';
const PATH = '/alpha/generate';
const CC_VERSION = process.env.PCMC_VERSION || '0.41.1';

const STATIC_CONFIG = {
  workingDir: '',
  date: new Date().toISOString().slice(0, 10),
  environment: process.env.PCMC_ENV || 'production',
  structure: [],
  isGitRepo: false,
  currentBranch: '',
  mainBranch: 'main',
  gitStatus: '',
  recentCommits: [],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  timeout: 300000,
});

const RATE_LIMIT_RPM = parseInt(process.env.PCMC_RATE_LIMIT_RPM || '5', 10);
const RATE_LIMIT_TPM = parseInt(process.env.PCMC_RATE_LIMIT_TPM || '100000', 10);

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

module.exports = { PORT, HOST, PATH, CC_VERSION, STATIC_CONFIG, CORS, agent, sse, RATE_LIMIT_RPM, RATE_LIMIT_TPM };