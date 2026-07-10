import { Hono } from 'hono'
import { config } from '../config'
import { getStats } from '../ratelimit'

const health = new Hono()

const startTime = Date.now()
let totalReqs = 0

export function incrementRequests() {
  totalReqs++
}

health.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

health.get('/health/upstream', async (c) => {
  const auth = c.req.header('Authorization') || ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(`https://${config.host}/alpha/whoami`, {
      method: 'GET',
      headers: {
        Authorization: auth,
        'x-command-code-version': config.ccVersion,
      },
      signal: controller.signal,
    })
    return c.json({ status: 'ok', upstream: res.status })
  } catch {
    return c.json({ status: 'error', upstream: 'unreachable' }, 502)
  } finally {
    clearTimeout(timeout)
  }
})

health.get('/stats', (c) => {
  const rl = getStats()
  return c.json({
    uptime: Math.floor((Date.now() - startTime) / 1000),
    totalRequests: totalReqs,
    rateLimits: rl,
  })
})

export { health }
