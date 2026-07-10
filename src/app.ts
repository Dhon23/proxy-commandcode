import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from './config'
import { health } from './routes/health'
import { models } from './routes/models'
import { chat } from './routes/chat'

const app = new Hono()

app.use('*', cors({
  origin: config.cors.allowOrigin,
  allowHeaders: config.cors.allowHeaders,
  allowMethods: config.cors.allowMethods as unknown as string[],
  maxAge: config.cors.maxAge,
}))

const draining = { value: false }

app.use('*', async (c, next) => {
  if (draining.value) {
    return c.json({
      error: { message: 'Server shutting down', type: 'server_error', code: 503 },
    }, 503)
  }
  await next()
})

app.route('/', health)
app.route('/', models)
app.route('/', chat)

app.notFound((c) => {
  return c.json({ error: 'POST /v1/chat/completions' }, 404)
})

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({
    error: { message: err.message, type: 'server_error', code: 500 },
  }, 500)
})

export { app, draining }
