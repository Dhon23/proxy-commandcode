import { Hono } from 'hono'
import { config } from '../config'

const models = new Hono()

models.get('/v1/models', async (c) => {
  const auth = c.req.header('Authorization') || ''

  const res = await fetch(`https://${config.host}/provider/v1/models`, {
    headers: {
      Authorization: auth,
      'x-command-code-version': config.ccVersion,
    },
  })

  let body: Record<string, unknown>
  try {
    body = await res.json() as Record<string, unknown>
  } catch {
    return c.json({ error: 'Failed to fetch models' }, 502)
  }

  if (Array.isArray(body.data)) {
    (body.data as Array<Record<string, unknown>>).forEach(m => {
      if (!m.permission) m.permission = []
      if (!m.owned_by) m.owned_by = 'command-code'
    })
  }

  return c.json(body as Record<string, unknown>, res.status as unknown as Parameters<typeof c.json>[1])
})

export { models }
