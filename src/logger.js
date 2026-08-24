'use strict'

const { shouldLog } = require('./log-policy')

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 })
const COLORS = Object.freeze({
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m'
})
const RESET = '\x1b[0m'

function clean (value) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
  }
  return value
}

function formatValue (value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return /^[A-Za-z0-9._:/@-]+$/u.test(value) ? value : JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

class Logger {
  constructor ({ pretty = false, level = 'debug', context = {} } = {}) {
    this.pretty = pretty
    this.threshold = LEVELS[level] ?? LEVELS.info
    this.context = context
    this.useColor = pretty && Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
  }

  debug (event, fields) { this.write('debug', event, fields) }
  info (event, fields) { this.write('info', event, fields) }
  warn (event, fields) { this.write('warn', event, fields) }
  error (event, fields) { this.write('error', event, fields) }

  write (level, event, fields = {}) {
    if (LEVELS[level] < this.threshold) return
    if (!shouldLog(level, event)) return
    const terminal = globalThis[Symbol.for('zenitmc.operatorConsole')]
    terminal?.beforeLog()

    const timestamp = new Date().toISOString()
    const metadata = clean({ ...this.context, ...fields })
    const stream = level === 'error' ? process.stderr : process.stdout
    if (!this.pretty) {
      stream.write(`${JSON.stringify({ timestamp, level, event, ...metadata })}\n`)
    } else {
      const label = level.toUpperCase().padEnd(5)
      const prefix = this.useColor
        ? `${COLORS[level]}${timestamp} ${label}${RESET}`
        : `${timestamp} ${label}`
      const details = Object.entries(metadata).map(([key, value]) => `${key}=${formatValue(value)}`).join(' ')
      stream.write(`${prefix} ${event}${details ? ` ${details}` : ''}\n`)
    }

    terminal?.afterLog()
  }
}

module.exports = { Logger, RESET }
