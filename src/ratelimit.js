const { RATE_LIMIT_RPM, RATE_LIMIT_TPM } = require('./config');

const windowMs = 60000;

const buckets = new Map();

function prune(bucket, now) {
  bucket.requests = bucket.requests.filter(ts => ts > now - windowMs);
  const windowStart = now - windowMs;
  let pruned = 0;
  for (let i = 0; i < bucket.tokens.length; i++) {
    if (bucket.tokens[i].ts > windowStart) break;
    pruned++;
  }
  bucket.tokens = bucket.tokens.slice(pruned);
}

function getBucket(key) {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { requests: [], tokens: [] };
    buckets.set(key, bucket);
  }
  return bucket;
}

function check(key, tokenCount) {
  const now = Date.now();
  const bucket = getBucket(key);
  prune(bucket, now);

  bucket.requests.push(now);
  const rpmOk = bucket.requests.length <= RATE_LIMIT_RPM;

  bucket.tokens.push({ ts: now, count: tokenCount });
  const tpmUsed = bucket.tokens.reduce((s, t) => s + t.count, 0);
  const tpmOk = tpmUsed <= RATE_LIMIT_TPM;

  if (!rpmOk) {
    bucket.requests.pop();
    return { allowed: false, reason: `Rate limit: ${RATE_LIMIT_RPM} RPM exceeded` };
  }
  if (!tpmOk) {
    bucket.requests.pop();
    bucket.tokens.pop();
    return { allowed: false, reason: `Rate limit: ${RATE_LIMIT_TPM} TPM exceeded` };
  }

  return { allowed: true };
}

function cleanup() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.requests.length === 0 && bucket.tokens.length === 0) {
      buckets.delete(key);
      continue;
    }
    prune(bucket, now);
    if (bucket.requests.length === 0 && bucket.tokens.length === 0) {
      buckets.delete(key);
    }
  }
}

setInterval(cleanup, 60000);

module.exports = { check, cleanup };