import type { RateLimitResult, RateLimitStats } from './types'
import { config } from './config'

const windowMs = 60000

interface TokenEntry {
  ts: number
  count: number
}

interface Bucket {
  requests: number[]
  tokens: TokenEntry[]
}

const buckets = new Map<string, Bucket>()

function prune(bucket: Bucket, now: number): void {
  bucket.requests = bucket.requests.filter(ts => ts > now - windowMs)
  const windowStart = now - windowMs
  let pruned = 0
  for (let i = 0; i < bucket.tokens.length; i++) {
    if (bucket.tokens[i].ts > windowStart) break
    pruned++
  }
  bucket.tokens = bucket.tokens.slice(pruned)
}

function getBucket(key: string): Bucket {
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { requests: [], tokens: [] }
    buckets.set(key, bucket)
  }
  return bucket
}

export function check(key: string, tokenCount: number): RateLimitResult {
  const now = Date.now()
  const bucket = getBucket(key)
  prune(bucket, now)

  bucket.requests.push(now)
  const rpmOk = bucket.requests.length <= config.rateLimit.rpm

  bucket.tokens.push({ ts: now, count: tokenCount })
  const tpmUsed = bucket.tokens.reduce((s, t) => s + t.count, 0)
  const tpmOk = tpmUsed <= config.rateLimit.tpm

  if (!rpmOk) {
    bucket.requests.pop()
    return { allowed: false, reason: `Rate limit: ${config.rateLimit.rpm} RPM exceeded` }
  }
  if (!tpmOk) {
    bucket.requests.pop()
    bucket.tokens.pop()
    return { allowed: false, reason: `Rate limit: ${config.rateLimit.tpm} TPM exceeded` }
  }

  return { allowed: true }
}

export function getStats(): RateLimitStats {
  const now = Date.now()
  let activeKeys = 0
  let totalReqs = 0
  let totalTokens = 0
  for (const [, bucket] of buckets) {
    prune(bucket, now)
    if (bucket.requests.length === 0) continue
    activeKeys++
    totalReqs += bucket.requests.length
    totalTokens += bucket.tokens.reduce((s, t) => s + t.count, 0)
  }
  return {
    activeKeys,
    currentRPM: totalReqs,
    currentTPM: totalTokens,
    limits: { rpm: config.rateLimit.rpm, tpm: config.rateLimit.tpm },
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.requests.length === 0 && bucket.tokens.length === 0) {
      buckets.delete(key)
      continue
    }
    prune(bucket, now)
    if (bucket.requests.length === 0 && bucket.tokens.length === 0) {
      buckets.delete(key)
    }
  }
}, 60000)
