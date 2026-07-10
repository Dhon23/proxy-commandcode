import { app, draining } from './app'
import { config } from './config'
import { logger } from './logger'

logger.info('=== proxy started ===')

const server = Bun.serve({
  port: config.port,
  fetch: (req) => {
    return app.fetch(req)
  },
  idleTimeout: 255,
})

logger.info(`listening on http://localhost:${server.port}`)

function shutdown() {
  draining.value = true
  logger.info('=== draining requests ===')

  const forceExit = setTimeout(() => {
    logger.info('=== force exit after drain timeout ===')
    server.stop()
    process.exit(0)
  }, 30000)

  server.stop(true)
  clearTimeout(forceExit)
  logger.info('=== graceful shutdown complete ===')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
