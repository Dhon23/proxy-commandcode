import pino from 'pino'
import { config } from './config'

export const logger = pino({
  level: config.environment === 'production' ? 'info' : 'debug',
  transport: config.environment !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
})
