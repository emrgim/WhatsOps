import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie',
      '*.password', '*.secret', '*.token', '*.access_token', '*.refresh_token', '*.code_verifier',
      '*.creds', '*.keys', '*.mediaKey', 'dbUrl', '*.dbUrl',
    ],
    censor: '***',
  },
})

export type Logger = typeof logger
