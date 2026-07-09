const fs = require('fs');
const path = require('path');

const logFile = fs.createWriteStream(path.join(__dirname, '..', 'proxy.log'), { flags: 'a' });

function log(...a) {
  const l = `[${new Date().toISOString()}] ${a.join(' ')}`;
  process.stdout.write(l + '\n');
  logFile.write(l + '\n');
}

function logErr(...a) {
  const l = `[${new Date().toISOString()}] ERROR ${a.join(' ')}`;
  process.stderr.write(l + '\n');
  logFile.write(l + '\n');
}

module.exports = { log, logErr, logFile };