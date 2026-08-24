'use strict'

const readline = require('node:readline')

const RESET = '\x1b[0m'
const COLORS = Object.freeze({
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[97m'
})

const COMMANDS = Object.freeze({
  help: 'help [command]',
  bots: 'bots',
  status: 'status [bot]',
  gems: 'gems [bot|--refresh]',
  send: 'send <player> <amount|all>',
  history: 'history [limit]',
  auto: 'auto <status|on|off> [player] [threshold] [reserve]',
  logs: 'logs [quiet|normal|debug]',
  reconnect: 'reconnect <bot|all>',
  stop: 'stop <bot|all>',
  clear: 'clear',
  exit: 'exit'
})

class OperatorConsole {
  constructor ({ handler, botNames }) {
    this.handler = handler
    this.botNames = botNames
    this.enabled = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
    this.useColor = this.enabled && process.env.NO_COLOR === undefined
    this.rl = null
    this.accepting = false
    this.ghostLength = 0
    this.queue = Promise.resolve()
    this.preKeypress = this.preKeypress.bind(this)
    this.postKeypress = this.postKeypress.bind(this)
  }

  start () {
    if (!this.enabled || this.rl) return false
    readline.emitKeypressEvents(process.stdin)
    process.stdin.on('keypress', this.preKeypress)
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 500,
      removeHistoryDuplicates: true,
      completer: line => this.complete(line)
    })
    process.stdin.on('keypress', this.postKeypress)
    this.rl.setPrompt(this.promptText())
    this.rl.on('line', line => {
      this.queue = this.queue.then(() => this.execute(line))
    })
    this.rl.on('SIGINT', () => this.interrupt())
    this.accepting = true
    globalThis[Symbol.for('zenitmc.operatorConsole')] = this
    this.rl.prompt()
    return true
  }

  stop () {
    if (!this.rl) return
    this.accepting = false
    this.clearGhost()
    delete globalThis[Symbol.for('zenitmc.operatorConsole')]
    process.stdin.removeListener('keypress', this.preKeypress)
    process.stdin.removeListener('keypress', this.postKeypress)
    this.rl.close()
    this.rl = null
  }

  beforeLog () {
    if (!this.accepting || !this.rl) return
    this.clearGhost()
    readline.cursorTo(process.stdout, 0)
    readline.clearLine(process.stdout, 0)
  }

  afterLog () {
    if (!this.accepting || !this.rl) return
    this.rl.prompt(true)
    this.renderGhost()
  }

  async execute (rawLine) {
    if (!this.rl) return
    this.accepting = false
    this.clearGhost()
    const line = rawLine.trim()
    if (line) {
      try {
        await this.handler(line, this)
      } catch (error) {
        this.error(error?.message || String(error))
      }
    }
    if (this.rl) {
      this.accepting = true
      this.rl.prompt()
      this.renderGhost()
    }
  }

  interrupt () {
    if (!this.rl) return
    if (this.rl.line) {
      this.clearGhost()
      this.rl.write(null, { ctrl: true, name: 'u' })
      this.rl.prompt(true)
      return
    }
    void this.handler('exit', this)
  }

  preKeypress () {
    if (this.accepting) this.clearGhost()
  }

  postKeypress (_value, key = {}) {
    if (!this.accepting || ['return', 'enter'].includes(key.name)) return
    setImmediate(() => this.renderGhost())
  }

  clearGhost () {
    if (!this.ghostLength || !process.stdout.isTTY) return
    readline.clearLine(process.stdout, 1)
    this.ghostLength = 0
  }

  renderGhost () {
    if (!this.accepting || !this.rl || this.rl.cursor !== this.rl.line.length) return
    const suffix = this.suggestion(this.rl.line)
    if (!suffix) return
    process.stdout.write(this.useColor ? `${COLORS.gray}${suffix}${RESET}` : suffix)
    readline.moveCursor(process.stdout, -suffix.length, 0)
    this.ghostLength = suffix.length
  }

  suggestion (line) {
    const input = line.trimStart()
    if (!input) return ''
    const endsWithSpace = /\s$/u.test(line)
    const parts = input.trimEnd().split(/\s+/u)
    const command = parts[0].toLowerCase()
    const match = Object.keys(COMMANDS).find(name => name.startsWith(command))
    if (parts.length === 1 && !endsWithSpace && match) {
      return `${match.slice(command.length)}${COMMANDS[match].slice(match.length)}`
    }
    if (!COMMANDS[command]) return ''
    if (['status', 'reconnect', 'stop'].includes(command) && parts.length === 1 && endsWithSpace) return '<bot|all>'
    if (command === 'send' && parts.length === 1 && endsWithSpace) return '<player> <amount|all>'
    if (command === 'send' && parts.length === 2 && endsWithSpace) return '<amount|all>'
    if (command === 'auto' && parts.length === 1 && endsWithSpace) return '<status|on|off>'
    if (command === 'logs' && parts.length === 1 && endsWithSpace) return '<quiet|normal|debug>'
    return ''
  }

  complete (line) {
    const endsWithSpace = /\s$/u.test(line)
    const parts = line.trimStart().trimEnd().split(/\s+/u)
    const command = parts[0]?.toLowerCase() || ''
    const current = endsWithSpace ? '' : (parts.at(-1) || '')
    let candidates = []

    if (parts.length === 1 && !endsWithSpace) candidates = Object.keys(COMMANDS)
    else if (command === 'help') candidates = Object.keys(COMMANDS)
    else if (['status', 'reconnect', 'stop'].includes(command)) candidates = [...this.botNames(), 'all']
    else if (command === 'gems') candidates = [...this.botNames(), '--refresh']
    else if (command === 'send' && parts.length >= 3) candidates = ['all']
    else if (command === 'auto' && parts.length <= 2) candidates = ['status', 'on', 'off']
    else if (command === 'logs') candidates = ['quiet', 'normal', 'debug']

    const matches = candidates.filter(item => item.toLowerCase().startsWith(current.toLowerCase()))
    return [matches.length ? matches : candidates, current]
  }

  promptText () {
    if (!this.useColor) return 'zenitmc[all] > '
    return `${COLORS.white}zenitmc${RESET}${COLORS.gray}[all]${RESET} ${COLORS.cyan}\u203a${RESET} `
  }

  line (message = '') { process.stdout.write(`${message}\n`) }
  lines (messages) { for (const message of messages) this.line(message) }
  success (message) { this.result('OK', COLORS.green, message) }
  info (message) { this.result('INFO', COLORS.cyan, message) }
  warn (message) { this.result('WARN', COLORS.yellow, message) }
  error (message) { this.result('ERROR', COLORS.red, message) }

  result (label, color, message) {
    const rendered = this.useColor ? `${color}${label}${RESET}` : label
    this.line(`${rendered}  ${message}`)
  }

  heading (message) {
    return this.useColor ? `${COLORS.white}${message}${RESET}` : message
  }
}

module.exports = { OperatorConsole, COMMANDS }
