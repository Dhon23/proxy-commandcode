import { Hono } from 'hono'
import { logger } from '../logger'
import { config } from '../config'
import { transform } from '../transform'
import { handleUpstreamResponse } from '../response'
import { check } from '../ratelimit'
import { incrementRequests } from './health'
import type { OpenAIChatRequestType } from '../types'

const chat = new Hono()

chat.post('/v1/chat/completions', async (c) => {
  const auth = c.req.header('Authorization') || ''
  let oai: OpenAIChatRequestType

  try {
    oai = await c.req.json() as OpenAIChatRequestType
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const model = oai.model || '-'
  const isStream = oai.stream === true

  const key = auth.replace(/^Bearer\s+/i, '').trim() || 'anonymous'
  const rl = check(key, oai.max_tokens || 32000)
  if (!rl.allowed) {
    logger.info({ model, stream: isStream, reason: rl.reason }, `[req] ${model} stream=${isStream} RATE_LIMITED`)
    return c.json(
      { error: { message: rl.reason, type: 'rate_limit_error', param: null, code: 429 } },
      429,
      { 'Retry-After': '60' },
    )
  }

  logger.info({ model, stream: isStream }, `[req] ${model} stream=${isStream}`)
  incrementRequests()

  let upstreamBody: string
  try {
    upstreamBody = JSON.stringify(transform(oai))
  } catch {
    return c.json({ error: 'Transform error' }, 500)
  }

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 300000)

  let proxyRes: Response
  try {
    proxyRes = await fetch(`https://${config.host}/alpha/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        'x-command-code-version': config.ccVersion,
        'x-cli-environment': 'production',
        'x-session-id': crypto.randomUUID(),
      },
      body: upstreamBody,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(t)
    logger.error({ err }, '[upstream] fetch error')
    return c.json({ error: (err as Error).message }, 502)
  } finally {
    clearTimeout(t)
  }

  logger.info({ statusCode: proxyRes.status }, `[upstream] ${proxyRes.status}`)

  if (!proxyRes.body) {
    return c.json({ error: 'Empty upstream response' }, 502)
  }

  const response = await handleUpstreamResponse(proxyRes.body, proxyRes.status, model, isStream)

  // Forward CORS headers from response handler + Hono's built-in
  return response
})

export { chat }
