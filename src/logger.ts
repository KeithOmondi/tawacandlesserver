import { pino } from 'pino'
import { config, isTest } from './config.ts'

export const logger = pino({
  level: isTest ? 'silent' : config.LOG_LEVEL,
  // Never log credentials or tokens.
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.password', '*.currentPassword', '*.newPassword', '*.token', '*.code', '*.refreshToken',
    ],
    censor: '[redacted]',
  },
})
