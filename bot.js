'use strict'

const mineflayer = require('mineflayer')
const { Physics, PlayerState } = require('prismarine-physics')
const crypto = require('node:crypto')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const Database = require('better-sqlite3')
const { shouldLog } = require('./src/log-policy')

const DEVELOPMENT_MODE = process.argv.includes('dev') || process.env.NODE_ENV === 'development'
const MANAGED_SESSION = process.env.ZENIT_MANAGED_SESSION === '1'
const sessionEvents = new EventEmitter()

const CONFIG = Object.freeze({
  host: process.env.MC_HOST || 'play.zenitmc.com',
  port: Number.parseInt(process.env.MC_PORT || '25565', 10),
  version: '1.21.11',
  auth: 'offline',
  logLevel: process.env.LOG_LEVEL || 'debug',
  tracePackets: process.env.TRACE_PACKETS === '1',
  traceChat: process.env.TRACE_CHAT === '1',
  email: process.env.MC_EMAIL || null,
  password: process.env.MC_PASSWORD || null
})

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 })
const LEVEL_COLORS = Object.freeze({
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m'
})
const RESET = '\x1b[0m'
const CONSOLE_COLORS = Object.freeze({
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[97m'
})
const GEMS_POLL_INTERVAL_MS = 5 * 60 * 1000
const GEMS_INITIAL_DELAY_MS = 35 * 1000
const GEMS_RESPONSE_TIMEOUT_MS = 15 * 1000
const REWARD_REFRESH_MIN_MS = 1000
const REWARD_REFRESH_MAX_MS = 3000
const ACCOUNT_INITIALIZATION_DELAY_MS = 35 * 1000
const AFK_CONFIRMATION_TIMEOUT_MS = 12 * 1000
const PLAY_READY_FALLBACK_MS = 8 * 1000
const CLIENT_TICK_INTERVAL_MS = 50
const CLIENT_VIEW_DISTANCE = 2
const PHYSICS_TICK_INTERVAL_MS = 50
const IDLE_CONTROLS = Object.freeze({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  sneak: false
})

const ENTITY_TELEPORT_PACKET = [
  'container',
  [
    { name: 'entityId', type: 'varint' },
    { name: 'x', type: 'f64' },
    { name: 'y', type: 'f64' },
    { name: 'z', type: 'f64' },
    { name: 'velocityX', type: 'f64' },
    { name: 'velocityY', type: 'f64' },
    { name: 'velocityZ', type: 'f64' },
    { name: 'yaw', type: 'f32' },
    { name: 'pitch', type: 'f32' },
    {
      name: 'flags',
      type: [
        'bitfield',
        [
          { name: 'relative_x', size: 1, signed: false },
          { name: 'relative_y', size: 1, signed: false },
          { name: 'relative_z', size: 1, signed: false },
          { name: 'relative_yaw', size: 1, signed: false },
          { name: 'relative_pitch', size: 1, signed: false },
          { name: 'relative_velocity_x', size: 1, signed: false },
          { name: 'relative_velocity_y', size: 1, signed: false },
          { name: 'relative_velocity_z', size: 1, signed: false },
          { name: 'rotate_velocity', size: 1, signed: false },
          { name: 'reserved', size: 23, signed: false }
        ]
      ]
    },
    { name: 'onGround', type: 'bool' }
  ]
]

const OPAQUE_PACKET = [
  'container',
  [{ name: 'data', type: 'restBuffer' }]
]

const PROTOCOL_PATCHES = Object.freeze({
  packet_entity_teleport: ENTITY_TELEPORT_PACKET,
  packet_window_items: OPAQUE_PACKET,
  packet_set_slot: OPAQUE_PACKET,
  packet_explosion: OPAQUE_PACKET,
  packet_world_particles: OPAQUE_PACKET,
  packet_trade_list: OPAQUE_PACKET,
  packet_craft_recipe_response: OPAQUE_PACKET,
  packet_recipe_book_add: OPAQUE_PACKET,
  packet_set_cursor_item: OPAQUE_PACKET,
  packet_entity_metadata: OPAQUE_PACKET,
  packet_entity_equipment: OPAQUE_PACKET,
  packet_set_player_inventory: OPAQUE_PACKET,
  packet_advancements: OPAQUE_PACKET,
  packet_declare_recipes: OPAQUE_PACKET
})

class Logger {
  constructor (level = 'info', pretty = false, context = {}) {
    this.threshold = LEVELS[level] ?? LEVELS.info
    this.pretty = pretty
    this.useColor = pretty && Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
    this.terminal = null
    this.context = context
  }

  attachTerminal (terminal) { this.terminal = terminal }

  debug (event, fields) { this.write('debug', event, fields) }
  info (event, fields) { this.write('info', event, fields) }
  warn (event, fields) { this.write('warn', event, fields) }
  error (event, fields) { this.write('error', event, fields) }

  write (level, event, fields = {}) {
    if (LEVELS[level] < this.threshold) return
    if (!shouldLog(level, event)) return

    const metadata = sanitize({ ...this.context, ...fields })
    const timestamp = new Date().toISOString()
    const stream = level === 'error' ? process.stderr : process.stdout

    const terminal = this.terminal || globalThis[Symbol.for('zenitmc.operatorConsole')]
    terminal?.beforeLog()

    if (!this.pretty) {
      stream.write(`${JSON.stringify({ timestamp, level, event, ...metadata })}\n`)
      terminal?.afterLog()
      return
    }

    const label = level.toUpperCase().padEnd(5)
    const prefix = this.useColor
      ? `${LEVEL_COLORS[level]}${timestamp} ${label}${RESET}`
      : `${timestamp} ${label}`
    const details = Object.keys(metadata).length > 0
      ? ` ${formatLogFields(metadata)}`
      : ''
    stream.write(`${prefix} ${event}${details}\n`)
    terminal?.afterLog()
  }
}

function formatLogFields (fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ')
}

function formatLogValue (value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') {
    return /^[A-Za-z0-9._:/@-]+$/.test(value) ? value : JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function sanitize (value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'

  seen.add(value)
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen))

  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = sanitize(item, seen)
  }
  return output
}

function readableMessage (value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    try {
      return readableMessage(JSON.parse(value))
    } catch {
      return value
    }
  }
  if (Buffer.isBuffer(value)) return `<binary message: ${value.length} bytes>`
  if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
    const rendered = value.toString()
    if (rendered !== '[object Object]') return rendered
  }
  if (typeof value === 'object') {
    const parts = []
    if (typeof value.text === 'string') parts.push(value.text)
    if (typeof value.translate === 'string') parts.push(value.translate)
    if (Array.isArray(value.extra)) {
      parts.push(...value.extra.map(readableMessage).filter(Boolean))
    }
    if (parts.length > 0) return parts.join('')
  }
  return JSON.stringify(sanitize(value))
}

const OPERATOR_COMMANDS = Object.freeze({
  help: { usage: 'help [command]', description: 'Show available commands or command details.' },
  status: { usage: 'status', description: 'Show the current bot and AFK session state.' },
  gems: { usage: 'gems', description: 'Fetch the live gems balance from the server.' },
  send: { usage: 'send <player> <amount|all>', description: 'Verify and transfer gems to a player.' },
  history: { usage: 'history [limit]', description: 'Show recent gems transfer attempts.' },
  clear: { usage: 'clear', description: 'Clear the terminal.' },
  reconnect: { usage: 'reconnect', description: 'Restart the bot process and reconnect safely.' },
  stop: { usage: 'stop', description: 'Disconnect the bot and stop the application.' },
  exit: { usage: 'exit', description: 'Disconnect the bot and stop the application.' }
})

class OperatorConsole {
  constructor (commandHandler) {
    this.commandHandler = commandHandler
    this.enabled = DEVELOPMENT_MODE && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
    this.useColor = this.enabled && process.env.NO_COLOR === undefined
    this.rl = null
    this.acceptingInput = false
    this.ghostLength = 0
    this.executionQueue = Promise.resolve()
    this.preKeypress = this.preKeypress.bind(this)
    this.postKeypress = this.postKeypress.bind(this)
  }

  start () {
    if (!this.enabled || this.rl !== null) return false

    readline.emitKeypressEvents(process.stdin)
    process.stdin.on('keypress', this.preKeypress)
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 200,
      removeHistoryDuplicates: true,
      completer: line => this.complete(line)
    })
    process.stdin.on('keypress', this.postKeypress)
    this.rl.setPrompt(this.promptText())
    this.rl.on('line', line => {
      this.executionQueue = this.executionQueue.then(() => this.handleLine(line))
    })
    this.rl.on('SIGINT', () => this.handleInterrupt())
    this.rl.on('close', () => {
      this.acceptingInput = false
      this.ghostLength = 0
    })

    this.acceptingInput = true
    logger.attachTerminal(this)
    this.rl.prompt()
    this.renderGhost()
    return true
  }

  stop () {
    if (this.rl === null) return
    this.acceptingInput = false
    this.clearGhost()
    logger.attachTerminal(null)
    process.stdin.removeListener('keypress', this.preKeypress)
    process.stdin.removeListener('keypress', this.postKeypress)
    this.rl.close()
    this.rl = null
  }

  beforeLog () {
    if (!this.acceptingInput || this.rl === null) return
    this.clearGhost()
    readline.cursorTo(process.stdout, 0)
    readline.clearLine(process.stdout, 0)
  }

  afterLog () {
    if (!this.acceptingInput || this.rl === null) return
    this.rl.prompt(true)
    this.renderGhost()
  }

  success (message) { this.writeResult('success', message) }
  info (message) { this.writeResult('info', message) }
  warn (message) { this.writeResult('warn', message) }
  error (message) { this.writeResult('error', message) }

  writeResult (level, message) {
    const colors = {
      success: CONSOLE_COLORS.green,
      info: CONSOLE_COLORS.cyan,
      warn: CONSOLE_COLORS.yellow,
      error: CONSOLE_COLORS.red
    }
    const label = {
      success: 'OK',
      info: 'INFO',
      warn: 'WARN',
      error: 'ERROR'
    }[level]
    const prefix = this.useColor ? `${colors[level]}${label}${RESET}` : label
    process.stdout.write(`${prefix}  ${message}\n`)
  }

  writeLines (lines) {
    for (const line of lines) process.stdout.write(`${line}\n`)
  }

  async handleLine (line) {
    if (this.rl === null) return
    this.acceptingInput = false
    this.clearGhost()
    const input = line.trim()

    if (input.length === 0) {
      this.acceptingInput = true
      this.rl.prompt()
      return
    }

    try {
      await this.commandHandler(input, this)
    } catch (error) {
      this.error(error?.message || String(error))
    } finally {
      if (this.rl !== null && !stopping) {
        this.acceptingInput = true
        this.rl.prompt()
        this.renderGhost()
      }
    }
  }

  handleInterrupt () {
    if (this.rl === null) return
    if (this.rl.line.length > 0) {
      this.clearGhost()
      this.rl.write(null, { ctrl: true, name: 'u' })
      this.rl.prompt(true)
      return
    }
    shutdown('SIGINT')
  }

  preKeypress () {
    if (!this.acceptingInput) return
    this.clearGhost()
  }

  postKeypress (_value, key = {}) {
    if (!this.acceptingInput || key.name === 'return' || key.name === 'enter') return
    setImmediate(() => this.renderGhost())
  }

  clearGhost () {
    if (this.ghostLength === 0 || !process.stdout.isTTY) return
    readline.clearLine(process.stdout, 1)
    this.ghostLength = 0
  }

  renderGhost () {
    if (!this.acceptingInput || this.rl === null || this.rl.cursor !== this.rl.line.length) return
    const suffix = this.suggestionFor(this.rl.line)
    if (!suffix) return

    const rendered = this.useColor ? `${CONSOLE_COLORS.gray}${suffix}${RESET}` : suffix
    process.stdout.write(rendered)
    readline.moveCursor(process.stdout, -suffix.length, 0)
    this.ghostLength = suffix.length
  }

  promptText () {
    if (!this.useColor) return 'zenitmc > '
    return `${CONSOLE_COLORS.white}zenitmc${RESET} ${CONSOLE_COLORS.cyan}\u203a${RESET} `
  }

  suggestionFor (line) {
    const trimmedStart = line.replace(/^\s+/u, '')
    if (!trimmedStart) return ''
    const endsWithSpace = /\s$/u.test(line)
    const parts = trimmedStart.trimEnd().split(/\s+/u)
    const command = parts[0].toLowerCase()
    const names = Object.keys(OPERATOR_COMMANDS)

    if (parts.length === 1 && !line.endsWith(' ')) {
      const match = names.find(name => name.startsWith(command))
      if (!match) return ''
      const usageTail = OPERATOR_COMMANDS[match].usage.slice(match.length)
      return `${match.slice(command.length)}${usageTail}`
    }

    if (!OPERATOR_COMMANDS[command]) return ''
    if (command === 'send') {
      if (parts.length === 1) return endsWithSpace ? '<player> <amount|all>' : ''
      if (parts.length === 2 && !endsWithSpace) {
        const target = knownTransferTargets().find(item => item.toLowerCase().startsWith(parts[1].toLowerCase()))
        return target ? `${target.slice(parts[1].length)} <amount|all>` : ' <amount|all>'
      }
      if (parts.length === 2) return '<amount|all>'
      if (parts.length === 3 && !endsWithSpace) {
        const amount = ['all', 'max'].find(item => item.startsWith(parts[2].toLowerCase()))
        return amount ? amount.slice(parts[2].length) : ''
      }
    }
    if (command === 'history' && parts.length === 1) return '[limit]'
    if (command === 'help' && parts.length === 1) return '[command]'
    return ''
  }

  complete (line) {
    const parts = line.trimStart().split(/\s+/u)
    const command = parts[0]?.toLowerCase() || ''
    const endsWithSpace = /\s$/u.test(line)
    const current = endsWithSpace ? '' : (parts.at(-1) || '')
    let candidates = []

    if (parts.length === 1 && !endsWithSpace) {
      candidates = Object.keys(OPERATOR_COMMANDS)
    } else if (command === 'help' && parts.length <= 2) {
      candidates = Object.keys(OPERATOR_COMMANDS)
    } else if (command === 'send' && (parts.length === 2 || (parts.length === 1 && endsWithSpace))) {
      candidates = knownTransferTargets()
    } else if (command === 'send' && (parts.length === 3 || (parts.length === 2 && endsWithSpace))) {
      candidates = ['all', 'max']
    }

    const matches = candidates.filter(candidate => candidate.toLowerCase().startsWith(current.toLowerCase()))
    return [matches.length > 0 ? matches : candidates, current]
  }
}

function randomUsername () {
  const adjectives = [
    'Dark', 'Silent', 'Swift', 'Iron', 'Frost', 'Crimson', 'Solar', 'Night',
    'Wild', 'Royal', 'Storm', 'Lunar', 'Rapid', 'Golden', 'Shadow'
  ]
  const animals = [
    'Lion', 'Wolf', 'Fox', 'Hawk', 'Bear', 'Tiger', 'Raven', 'Eagle',
    'Cobra', 'Falcon', 'Lynx', 'Panda', 'Shark', 'Otter', 'Viper'
  ]
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)]
  const animal = animals[Math.floor(Math.random() * animals.length)]
  const number = Math.floor(100 + Math.random() * 900)
  return `${adjective}${animal}${number}`.slice(0, 16)
}

function randomEmail (name) {
  return `${name.toLowerCase()}@gmail.com`
}

function applyProtocolCompatibilityPatches () {
  const protocolTypes = require('minecraft-data')(CONFIG.version).protocol.play.toClient.types
  Object.assign(protocolTypes, PROTOCOL_PATCHES)
}

function loadPluginWithoutPackets (targetBot, options, pluginPath, ignoredPackets) {
  const originalOn = targetBot._client.on
  targetBot._client.on = function (eventName, listener) {
    if (ignoredPackets.has(eventName)) return this
    return originalOn.call(this, eventName, listener)
  }

  try {
    require(pluginPath)(targetBot, options)
  } finally {
    targetBot._client.on = originalOn
  }
}

function loadEntitiesWithoutItemPackets (targetBot, options) {
  loadPluginWithoutPackets(
    targetBot,
    options,
    'mineflayer/lib/plugins/entities',
    new Set(['entity_equipment', 'entity_metadata'])
  )
}

function loadBlocksWithoutExplosionPackets (targetBot, options) {
  loadPluginWithoutPackets(
    targetBot,
    options,
    'mineflayer/lib/plugins/blocks',
    new Set(['explosion'])
  )
}

applyProtocolCompatibilityPatches()

const username = process.env.MC_USERNAME || randomUsername()
const accountPassword = CONFIG.password || `Zx_${crypto.randomBytes(12).toString('base64url')}`
const accountEmail = CONFIG.email || randomEmail(username)
const logger = new Logger(CONFIG.logLevel, DEVELOPMENT_MODE, MANAGED_SESSION ? { bot: username } : {})
const databasePath = process.env.ZENIT_DATABASE_PATH
  ? path.resolve(process.env.ZENIT_DATABASE_PATH)
  : path.join(__dirname, 'zenitmc.sqlite')
const database = new Database(databasePath)

database.pragma('journal_mode = WAL')
database.pragma('synchronous = NORMAL')
database.exec(`
  CREATE TABLE IF NOT EXISTS bots (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL,
    gems INTEGER NOT NULL DEFAULT 0,
    gems_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gem_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_username TEXT NOT NULL,
    target_username TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    balance_before INTEGER,
    balance_after INTEGER,
    server_message TEXT,
    error_message TEXT,
    requested_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_gem_transfers_bot_requested
  ON gem_transfers (bot_username, requested_at DESC)
`)

const upsertBotStatement = database.prepare(`
  INSERT INTO bots (username, password, email, status, gems, created_at, updated_at)
  VALUES (@username, @password, @email, @status, 0, @now, @now)
  ON CONFLICT(username) DO UPDATE SET
    password = excluded.password,
    email = excluded.email,
    status = excluded.status,
    updated_at = excluded.updated_at
`)
const updateBotStatusStatement = database.prepare(`
  UPDATE bots SET status = ?, updated_at = ? WHERE username = ?
`)
const updateBotGemsStatement = database.prepare(`
  UPDATE bots
  SET gems = ?, gems_updated_at = ?, updated_at = ?
  WHERE username = ?
`)
const selectBotStatement = database.prepare(`
  SELECT username, status, gems, gems_updated_at, updated_at
  FROM bots WHERE username = ?
`)
const insertTransferStatement = database.prepare(`
  INSERT INTO gem_transfers (
    bot_username, target_username, amount, status, balance_before, requested_at
  ) VALUES (?, ?, ?, 'pending', ?, ?)
`)
const completeTransferStatement = database.prepare(`
  UPDATE gem_transfers
  SET status = ?, balance_after = ?, server_message = ?, error_message = ?, completed_at = ?
  WHERE id = ?
`)
const selectTransferHistoryStatement = database.prepare(`
  SELECT id, target_username, amount, status, balance_before, balance_after,
    server_message, error_message, requested_at, completed_at
  FROM gem_transfers
  WHERE bot_username = ?
  ORDER BY id DESC
  LIMIT ?
`)
const selectTransferTargetsStatement = database.prepare(`
  SELECT target_username, MAX(requested_at) AS last_used_at
  FROM gem_transfers
  WHERE bot_username = ?
  GROUP BY target_username
  ORDER BY last_used_at DESC
  LIMIT 20
`)

upsertBotStatement.run({
  username,
  password: accountPassword,
  email: accountEmail,
  status: 'connecting',
  now: new Date().toISOString()
})

let stopping = false
let restartRequested = false
let currentStatus = 'connecting'
let currentGems = selectBotStatement.get(username)?.gems ?? 0
let gemsUpdatedAt = selectBotStatement.get(username)?.gems_updated_at ?? null
let connectedAt = null
let afkStartedAt = null
let lastRewardAt = null
let disconnectReason = null
let operatorConsole = null
let activeTransfer = null
let transferInProgress = false
const gemsBalanceWaiters = new Set()
let authCommandSent = null
let lobbyExpectedAfterSessionId = 0
let lobbyReadySessionId = 0
let registrationAttempts = 0
let registrationCompletedAt = null
let commandQueue = Promise.resolve()
let boxPvpCommandScheduled = false
let boxPvpDelayTimer = null
let fallbackRecoveryPending = false
let awaitingBoxPvpTransfer = false
let boxPvpConfigurationSeen = false
let afkWarpCommandScheduled = false
let afkWarpCommandSent = false
let afkWarpAttempts = 0
let afkConfirmed = false
let afkConfirmationTimer = null
let gemsPollTimer = null
let gemsStartTimer = null
let rewardRefreshTimer = null
let gemsRequestPending = false
let gemsResponseTimer = null
let playSessionId = 0
let playSessionReady = false
let playerLoadedSent = false
let playReadyTimer = null
let clientTickTimer = null
let physicsTimer = null
let physicsEngine = null
let playerPositionReady = false
let playerYawDegrees = 0
let playerPitchDegrees = 0
let worldLoadId = 0
let worldChunkCount = 0
let worldLoadedColumnEvents = 0
let physicsTickCount = 0
let worldReadyLogged = false

logger.info('application.starting', {
  service: MANAGED_SESSION ? 'zenitmc-session' : 'zenitmc-standalone-session',
  nodeVersion: process.version,
  pid: process.pid,
  mode: DEVELOPMENT_MODE ? 'development' : 'production'
})
logger.info('minecraft.connecting', {
  host: CONFIG.host,
  port: CONFIG.port,
  version: CONFIG.version,
  auth: CONFIG.auth,
  username
})

const bot = mineflayer.createBot({
  host: CONFIG.host,
  port: CONFIG.port,
  username,
  version: CONFIG.version,
  auth: CONFIG.auth,
  brand: 'vanilla',
  viewDistance: CLIENT_VIEW_DISTANCE,
  physicsEnabled: true,
  logErrors: false,
  hideErrors: true,
  plugins: {
    entities: loadEntitiesWithoutItemPackets,
    blocks: loadBlocksWithoutExplosionPackets,
    physics: false,
    breath: false,
    explosion: false,
    fishing: false,
    particle: false,
    inventory: false,
    simple_inventory: false,
    chest: false,
    craft: false,
    creative: false,
    enchantment_table: false,
    furnace: false,
    villager: false,
    anvil: false,
    book: false,
    digging: false,
    generic_place: false,
    place_entity: false
  }
})
const client = bot._client
const loggedBotErrors = new Set()

bot.inventory = { slots: new Array(46).fill(null) }
bot.jumpTicks = 0
bot.jumpQueued = false
bot.fireworkRocketDuration = 0

bot.on('error', error => {
  const fingerprint = `${error?.name || 'Error'}:${error?.message || String(error)}`
  if (loggedBotErrors.has(fingerprint)) return
  loggedBotErrors.add(fingerprint)
  logger.error('minecraft.bot_error', { error })
})

client.on('connect', () => {
  connectedAt = new Date().toISOString()
  updateBotStatus('connected')
  logger.info('minecraft.socket_connected', { remote: `${CONFIG.host}:${CONFIG.port}` })
})

client.on('state', state => {
  logger.debug('minecraft.protocol_state_changed', { state })

  if (state === 'configuration') {
    suspendPlaySession()

    if (awaitingBoxPvpTransfer) {
      boxPvpConfigurationSeen = true
      logger.info('minecraft.server_transfer_detected', { destination: 'boxpvp' })
    }
  }
})

client.on('login', packet => {
  logger.info('minecraft.login_accepted', {
    username,
    entityId: packet?.entityId,
    gameMode: packet?.gameMode
  })
  beginPlaySession()
})

bot.on('chunkColumnLoad', () => {
  worldLoadedColumnEvents += 1
  if (CONFIG.tracePackets) {
    logger.debug('minecraft.chunk_column_loaded', {
      playSessionId,
      worldLoadId,
      loadedColumns: worldLoadedColumnEvents
    })
  }
})

client.on('playerJoin', () => {
  logger.info('minecraft.play_state_ready', { username })
  handleServerReady()
})

client.on('systemChat', event => {
  const message = readableMessage(event?.formattedMessage ?? event)
  const positionId = event?.positionId
  handleAuthenticationPrompt(message)

  if (
    message &&
    !isNoisyServerMessage(message, positionId) &&
    (CONFIG.traceChat || isOperationalServerMessage(message))
  ) {
    logger.info('minecraft.system_chat', {
      position: positionId,
      message
    })
  }

  handleGemsMessage(message)
  handleTransferMessage(message)
  handleLobbyMessage(message)
  handleAfkMessage(message)
})

client.on('playerChat', event => {
  const message = readableMessage(
    event?.formattedMessage ?? event?.unsignedContent ?? event?.plainMessage ?? event
  )
  if (CONFIG.traceChat) {
    logger.info('minecraft.player_chat', { message })
  }
  handleGemsMessage(message, { source: 'profileless_or_player_chat', logOriginal: true })
  handleTransferMessage(message)
})

client.on('ping', packet => {
  if (CONFIG.tracePackets) {
    logger.debug('minecraft.ping_acknowledged', { id: packet.id, playSessionId })
  }
})

client.on('keep_alive', packet => {
  if (CONFIG.tracePackets) {
    logger.debug('minecraft.keepalive_acknowledged', {
      id: packet.keepAliveId,
      playSessionId
    })
  }
})

client.on('packet', (data, metadata) => {
  if (metadata?.state === 'play') {
    if (metadata.name === 'respawn') prepareWorldReload('respawn')
    if (metadata.name === 'position') handlePlayerPositionPacket(data)
    if (metadata.name === 'map_chunk') {
      worldChunkCount += 1
      if (worldChunkCount === 1) {
        logger.debug('minecraft.world_chunk_packet_shape', {
          playSessionId,
          worldLoadId,
          keys: Object.keys(data || {}),
          x: data?.x,
          z: data?.z,
          groundUp: data?.groundUp,
          bitMap: data?.bitMap,
          chunkDataBytes: Buffer.isBuffer(data?.chunkData) ? data.chunkData.length : null
        })
      }
    }
    if (metadata.name === 'transfer') {
      logger.warn('minecraft.transfer_packet_received', {
        host: data?.host,
        port: data?.port,
        playSessionId,
        afkConfirmed
      })
    }
    if (metadata.name === 'action_bar') {
      const message = readableMessage(data?.text ?? data)
      handleGemsMessage(message, {
        source: 'action_bar',
        logOriginal: true
      })
    }
  }

  if (CONFIG.tracePackets) {
    logger.debug('minecraft.packet_received', {
      name: metadata?.name,
      state: metadata?.state,
      data
    })
  }
})

client.on('disconnect', packet => {
  disconnectReason = readableMessage(packet?.reason ?? packet)
  logger.warn('minecraft.disconnect_received', {
    reason: disconnectReason
  })
})

client.on('error', error => {
  updateBotStatus('error')
  const fingerprint = `${error?.name || 'Error'}:${error?.message || String(error)}`
  if (loggedBotErrors.has(fingerprint)) return
  loggedBotErrors.add(fingerprint)
  logger.error('minecraft.client_error', { error })
})

client.on('end', reason => {
  const finalReason = disconnectReason || readableMessage(reason)
  suspendPlaySession()
  stopGemsPolling()
  updateBotStatus(stopping ? 'stopped' : 'disconnected')
  logger.warn('minecraft.connection_closed', {
    reason: finalReason,
    intentional: stopping
  })
  sessionEvents.emit('end', {
    username,
    reason: finalReason,
    intentional: stopping,
    snapshot: getSessionSnapshot()
  })
  if (!MANAGED_SESSION) operatorConsole?.stop()
  database.close()
  if (!MANAGED_SESSION && restartRequested) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: __dirname,
      env: {
        ...process.env,
        MC_USERNAME: username,
        MC_PASSWORD: accountPassword,
        MC_EMAIL: accountEmail
      },
      stdio: 'inherit'
    })
    child.unref()
  }
  if (!MANAGED_SESSION) process.exitCode = stopping ? 0 : 1
})

function handleAuthenticationPrompt (message) {
  const normalized = message.toLocaleLowerCase('tr-TR')
  const emailRejected = normalized.includes('invalid email') || normalized.includes('geçersiz e-posta')
  const authenticationSucceeded = normalized.includes('giriş başarılı')

  if (authenticationSucceeded) {
    lobbyExpectedAfterSessionId = Math.max(lobbyExpectedAfterSessionId, playSessionId)
  }

  if (authCommandSent === 'register' && registrationCompletedAt === null && authenticationSucceeded) {
    registrationCompletedAt = Date.now()
    logger.info('minecraft.account_initialization_started', {
      waitSeconds: ACCOUNT_INITIALIZATION_DELAY_MS / 1000
    })
  }

  if (afkConfirmed && authenticationSucceeded) {
    afkConfirmed = false
    afkStartedAt = null
    lastRewardAt = null
    stopGemsPolling()
    prepareFallbackRecovery()
    updateBotStatus('lobby_fallback')
    logger.warn('minecraft.afk_session_lost', {
      reason: 'transferred_to_authentication_server'
    })
  }

  if (authenticationSucceeded) return

  if (emailRejected && authCommandSent === 'register') {
    logger.error('minecraft.registration_email_rejected', {
      attempt: registrationAttempts,
      email: accountEmail
    })
    return
  }

  if (typeof client.chat !== 'function' || authCommandSent !== null) return

  const requestsRegistration = normalized.includes('/register') || normalized.includes('/kayıt')
  const requestsLogin = normalized.includes('/login')

  if (requestsRegistration) {
    sendRegistrationCommand()
    return
  }

  if (requestsLogin) {
    authCommandSent = 'login'
    scheduleCommand('login', `/login ${accountPassword}`, {
      passwordSource: CONFIG.password ? 'environment' : 'generated'
    })
  }
}

function isOperationalServerMessage (message) {
  const normalized = message.toLocaleLowerCase('tr-TR')
  const operationalTerms = [
    '/register', '/login', '/email', '/boxpvp', '/warp', '/gems',
    'giriş başarılı', 'kayıt başarılı', 'invalid email', 'geçersiz e-posta',
    'e-posta', 'email', 'afk', 'gem'
  ]

  return normalized.includes(username.toLocaleLowerCase('tr-TR')) ||
    operationalTerms.some(term => normalized.includes(term))
}

function isNoisyServerMessage (message, positionId) {
  if (message === '%s') return true
  const normalized = message.toLocaleLowerCase('tr-TR')
  if (/^toplam \d+ hesabın var:$/u.test(normalized)) return true
  if ((message.match(/,/g) || []).length >= 4 && message.endsWith('.')) return true
  if (positionId !== 2) return false

  return normalized.startsWith('korumanızın bitişine kalan:')
}

function handleLobbyMessage (message) {
  const normalized = message.toLocaleLowerCase('tr-TR')
  const normalizedUsername = username.toLocaleLowerCase('tr-TR')
  const isLobbyWelcome = normalized.includes('hoş geldin') && normalized.includes(normalizedUsername)

  if (!isLobbyWelcome) return

  markLobbyReady('welcome_message')
}

function markLobbyReady (source) {
  if (lobbyReadySessionId === playSessionId) return

  lobbyReadySessionId = playSessionId
  updateBotStatus('lobby')
  logger.info('minecraft.lobby_ready', {
    username,
    recovery: fallbackRecoveryPending,
    source
  })

  if (fallbackRecoveryPending) {
    fallbackRecoveryPending = false
    scheduleBoxPvpAfterInitialization()
    return
  }

  scheduleBoxPvpAfterInitialization()
}

function scheduleBoxPvpAfterInitialization () {
  if (stopping || boxPvpCommandScheduled || boxPvpDelayTimer !== null) return

  const readyAt = registrationCompletedAt === null
    ? Date.now()
    : registrationCompletedAt + ACCOUNT_INITIALIZATION_DELAY_MS
  const remainingMs = Math.max(0, readyAt - Date.now())

  if (remainingMs === 0) {
    scheduleBoxPvpCommand()
    return
  }

  updateBotStatus('initializing_account')
  logger.info('minecraft.boxpvp_waiting_for_account_initialization', {
    remainingSeconds: Number((remainingMs / 1000).toFixed(1))
  })
  boxPvpDelayTimer = setTimeout(() => {
    boxPvpDelayTimer = null
    scheduleBoxPvpCommand()
  }, remainingMs)
}

function prepareFallbackRecovery () {
  clearTimeout(boxPvpDelayTimer)
  boxPvpDelayTimer = null
  fallbackRecoveryPending = true
  boxPvpCommandScheduled = false
  awaitingBoxPvpTransfer = false
  boxPvpConfigurationSeen = false
  afkWarpCommandScheduled = false
  afkWarpCommandSent = false
  afkWarpAttempts = 0
}

function scheduleBoxPvpCommand () {
  if (stopping || boxPvpCommandScheduled) return

  boxPvpCommandScheduled = true
  awaitingBoxPvpTransfer = true
  scheduleCommand('boxpvp', '/boxpvp')
}

function handleServerReady () {
  if (!playSessionReady) return
  if (afkConfirmed) {
    updateBotStatus('afk')
    scheduleGemsPollingStart()
    return
  }
  if (!awaitingBoxPvpTransfer || !boxPvpConfigurationSeen || afkWarpCommandScheduled) return

  awaitingBoxPvpTransfer = false
  afkWarpCommandScheduled = true
  updateBotStatus('boxpvp')
  logger.info('minecraft.boxpvp_ready', { username })
  sendAfkWarpCommand()
}

function sendAfkWarpCommand () {
  if (stopping || afkConfirmed || afkWarpAttempts >= 2) return

  afkWarpAttempts += 1
  scheduleCommand(
    'warp_afk',
    '/warp afk',
    { attempt: afkWarpAttempts },
    () => !afkConfirmed
  ).then(sent => {
      if (!sent || stopping || afkConfirmed) return

      afkWarpCommandSent = true
      logger.info('minecraft.afk_warp_pending', {
        attempt: afkWarpAttempts,
        serverDelaySeconds: 5
      })
      clearTimeout(afkConfirmationTimer)
      afkConfirmationTimer = setTimeout(() => {
        if (afkConfirmed) return
        if (afkWarpAttempts < 2) {
          logger.warn('minecraft.afk_warp_confirmation_timeout', {
            attempt: afkWarpAttempts,
            action: 'retry'
          })
          sendAfkWarpCommand()
        } else {
          logger.error('minecraft.afk_warp_failed', {
            attempts: afkWarpAttempts,
            reason: 'confirmation_timeout'
          })
        }
      }, AFK_CONFIRMATION_TIMEOUT_MS)
    })
}

function handleAfkMessage (message) {
  if (!boxPvpCommandScheduled || afkConfirmed) return

  const normalized = message.toLocaleLowerCase('tr-TR')
  const confirmsAfk = normalized.includes('afk bölgesine girdiniz') ||
    normalized.includes('içinde ödül alacaksınız')

  if (!confirmsAfk) return

  afkConfirmed = true
  afkStartedAt = new Date().toISOString()
  lastRewardAt = null
  clearTimeout(afkConfirmationTimer)
  updateBotStatus('afk')
  logger.info('minecraft.afk_ready', {
    username,
    attempt: afkWarpAttempts,
    source: afkWarpCommandSent ? 'warp_confirmation' : 'server_routing'
  })
  scheduleGemsPollingStart()
}

function scheduleGemsPollingStart () {
  if (stopping || !afkConfirmed || !playSessionReady || gemsPollTimer !== null || gemsStartTimer !== null) return

  const sessionId = playSessionId
  logger.info('minecraft.gems_polling_scheduled', {
    initialDelaySeconds: GEMS_INITIAL_DELAY_MS / 1000,
    intervalSeconds: GEMS_POLL_INTERVAL_MS / 1000
  })

  gemsStartTimer = setTimeout(() => {
    gemsStartTimer = null
    if (stopping || !afkConfirmed || !playSessionReady || sessionId !== playSessionId) return

    void requestGemsBalance({ reason: 'scheduled_poll' }).catch(() => {})
    gemsPollTimer = setInterval(() => {
      void requestGemsBalance({ reason: 'scheduled_poll' }).catch(() => {})
    }, GEMS_POLL_INTERVAL_MS)
    logger.info('minecraft.gems_polling_started', {
      intervalSeconds: GEMS_POLL_INTERVAL_MS / 1000
    })
  }, GEMS_INITIAL_DELAY_MS)
}

function stopGemsPolling () {
  clearInterval(gemsPollTimer)
  clearTimeout(gemsStartTimer)
  clearTimeout(gemsResponseTimer)
  clearTimeout(rewardRefreshTimer)
  gemsPollTimer = null
  gemsStartTimer = null
  gemsResponseTimer = null
  rewardRefreshTimer = null
  gemsRequestPending = false
  rejectGemsBalanceWaiters(new Error('Gems polling stopped'))
}

function requestGemsBalance ({ reason = 'manual' } = {}) {
  if (stopping) return Promise.reject(new Error('The bot is shutting down'))
  if (!afkConfirmed || !playSessionReady) {
    return Promise.reject(new Error('The bot is not ready in the AFK world'))
  }

  const result = new Promise((resolve, reject) => {
    gemsBalanceWaiters.add({ resolve, reject })
  })

  if (gemsRequestPending) return result

  const sessionId = playSessionId
  gemsRequestPending = true
  scheduleCommand(
    'gems_balance',
    '/gems',
    { playSessionId: sessionId, reason },
    () => afkConfirmed && playSessionReady && sessionId === playSessionId
  ).then(sent => {
    if (!sent) {
      gemsRequestPending = false
      rejectGemsBalanceWaiters(new Error('The gems command was cancelled'))
      return
    }

    clearTimeout(gemsResponseTimer)
    gemsResponseTimer = setTimeout(() => {
      if (!gemsRequestPending) return
      gemsRequestPending = false
      logger.warn('minecraft.gems_response_timeout', {
        timeoutSeconds: GEMS_RESPONSE_TIMEOUT_MS / 1000,
        playSessionId: sessionId,
        reason
      })
      rejectGemsBalanceWaiters(new Error('The server did not return a gems balance'))
    }, GEMS_RESPONSE_TIMEOUT_MS)
  })

  return result
}

function resolveGemsBalanceWaiters (gems) {
  const waiters = [...gemsBalanceWaiters]
  gemsBalanceWaiters.clear()
  for (const waiter of waiters) waiter.resolve(gems)
}

function rejectGemsBalanceWaiters (error) {
  const waiters = [...gemsBalanceWaiters]
  gemsBalanceWaiters.clear()
  for (const waiter of waiters) waiter.reject(error)
}

function handleGemsMessage (message, { source = 'system_chat', logOriginal = false } = {}) {
  const rewardMatch = message.match(/([0-9][0-9.,]*)\s+gems\s+ald[ıi]n/iu)
  if (rewardMatch) {
    const reward = Number.parseInt(rewardMatch[1].replace(/[.,]/g, ''), 10)
    if (Number.isSafeInteger(reward) && reward > 0) {
      lastRewardAt = new Date().toISOString()
      logger.info('minecraft.gems_reward_detected', { username, reward })
      sessionEvents.emit('reward', { username, reward, message })
      clearTimeout(rewardRefreshTimer)
      const delayMs = crypto.randomInt(REWARD_REFRESH_MIN_MS, REWARD_REFRESH_MAX_MS + 1)
      rewardRefreshTimer = setTimeout(() => {
        rewardRefreshTimer = null
        void requestGemsBalance({ reason: 'reward_refresh' }).catch(error => {
          logger.warn('minecraft.gems_reward_refresh_failed', { error })
        })
      }, delayMs)
    }
    return true
  }

  const match = message.match(/([0-9][0-9.,]*)\s+gems['\u2019]?in\s+var/iu)
  if (!match) return false

  if (logOriginal) {
    logger.info('minecraft.gems_message_received', { source, message })
  }

  const gems = Number.parseInt(match[1].replace(/[.,]/g, ''), 10)
  if (!Number.isSafeInteger(gems) || gems < 0) {
    logger.warn('minecraft.gems_balance_invalid', { value: match[1] })
    return true
  }

  logger.debug('minecraft.gems_balance_parsed', {
    source,
    message,
    rawValue: match[1],
    gems
  })
  gemsRequestPending = false
  clearTimeout(gemsResponseTimer)
  updateBotGems(gems)
  logger.info('minecraft.gems_balance_updated', { username, gems })
  sessionEvents.emit('gems', { username, gems, updatedAt: gemsUpdatedAt })
  resolveGemsBalanceWaiters(gems)
  return true
}

function beginPlaySession () {
  suspendPlaySession()
  playSessionId += 1
  prepareWorldReload('server_join')
}

function prepareWorldReload (source) {
  clearTimeout(playReadyTimer)
  clearInterval(clientTickTimer)
  clearInterval(physicsTimer)
  playReadyTimer = null
  clientTickTimer = null
  physicsTimer = null
  playSessionReady = false
  playerLoadedSent = false
  playerPositionReady = false
  worldLoadId += 1
  worldChunkCount = 0
  worldLoadedColumnEvents = 0
  physicsTickCount = 0
  worldReadyLogged = false

  if (afkConfirmed) stopGemsPolling()

  const sessionId = playSessionId
  const loadId = worldLoadId
  logger.debug('minecraft.world_load_started', {
    playSessionId: sessionId,
    worldLoadId: loadId,
    source
  })

  clientTickTimer = setInterval(() => {
    if (!stopping && sessionId === playSessionId && client.state === 'play') {
      client.write('tick_end', {})
    }
  }, CLIENT_TICK_INTERVAL_MS)

  physicsTimer = setInterval(() => {
    if (!stopping && sessionId === playSessionId && loadId === worldLoadId) runPhysicsTick()
  }, PHYSICS_TICK_INTERVAL_MS)

  playReadyTimer = setTimeout(() => {
    if (stopping || sessionId !== playSessionId || loadId !== worldLoadId) return
    sendPlayerLoaded(sessionId, 'fallback_timer')
    if (!playSessionReady) {
      logger.warn('minecraft.world_not_ready', {
        playSessionId: sessionId,
        worldLoadId: loadId,
        mapChunksReceived: worldChunkCount,
        loadedColumns: worldLoadedColumnEvents,
        physicsTicks: physicsTickCount,
        position: bot.entity?.position ? formatPosition(bot.entity.position) : null,
        currentColumnLoaded: isCurrentColumnLoaded(),
        blockAtPlayerLoaded: isBlockLoadedAtPlayer(),
        physicsEnabled: bot.physicsEnabled,
        physicsApiReady: typeof bot.setControlState === 'function',
        action: 'waiting_for_chunk_backed_physics'
      })
    }
  }, PLAY_READY_FALLBACK_MS)
}

function suspendPlaySession () {
  clearTimeout(playReadyTimer)
  clearInterval(clientTickTimer)
  clearInterval(physicsTimer)
  playReadyTimer = null
  clientTickTimer = null
  physicsTimer = null
  playSessionReady = false

  if (gemsRequestPending) {
    gemsRequestPending = false
    clearTimeout(gemsResponseTimer)
    gemsResponseTimer = null
    logger.info('minecraft.gems_request_cancelled', { reason: 'server_transfer' })
  }
}

function handlePlayerPositionPacket (packet) {
  if (!packet || !Number.isInteger(packet.teleportId) || !bot.entity?.position || !bot.entity?.velocity) return

  const flags = packet.flags || {}
  const position = bot.entity.position
  const velocity = bot.entity.velocity

  position.set(
    flags.x ? position.x + packet.x : packet.x,
    flags.y ? position.y + packet.y : packet.y,
    flags.z ? position.z + packet.z : packet.z
  )
  velocity.set(
    flags.dx ? velocity.x + packet.dx : packet.dx,
    flags.dy ? velocity.y + packet.dy : packet.dy,
    flags.dz ? velocity.z + packet.dz : packet.dz
  )

  playerYawDegrees = flags.yaw ? playerYawDegrees + packet.yaw : packet.yaw
  playerPitchDegrees = flags.pitch ? playerPitchDegrees + packet.pitch : packet.pitch
  bot.entity.yaw = fromMinecraftYaw(playerYawDegrees)
  bot.entity.pitch = fromMinecraftPitch(playerPitchDegrees)
  bot.entity.onGround = false
  playerPositionReady = true

  client.write('teleport_confirm', { teleportId: packet.teleportId })
  client.write('position_look', {
    x: position.x,
    y: position.y,
    z: position.z,
    yaw: playerYawDegrees,
    pitch: playerPitchDegrees,
    flags: { onGround: false, hasHorizontalCollision: false }
  })

  if (CONFIG.tracePackets) {
    logger.debug('minecraft.teleport_confirmed', {
      teleportId: packet.teleportId,
      playSessionId,
      position: formatPosition(position),
      velocityY: Number(velocity.y.toFixed(5))
    })
  }
}

function runPhysicsTick () {
  if (client.state !== 'play' || !playerPositionReady || !bot.entity?.position) return
  if (bot.blockAt(bot.entity.position, false) === null) return

  try {
    if (physicsEngine === null) {
      physicsEngine = Physics(bot.registry, {
        getBlock: position => bot.blockAt(position, false)
      })
    }

    physicsEngine.simulatePlayer(new PlayerState(bot, IDLE_CONTROLS), {
      getBlock: position => bot.blockAt(position, false)
    }).apply(bot)
    physicsTickCount += 1

    client.write('position', {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
      flags: {
        onGround: Boolean(bot.entity.onGround),
        hasHorizontalCollision: Boolean(bot.entity.isCollidedHorizontally)
      }
    })

    handlePhysicsTick()
  } catch (error) {
    const fingerprint = `physics:${error?.name || 'Error'}:${error?.message || String(error)}`
    if (loggedBotErrors.has(fingerprint)) return
    loggedBotErrors.add(fingerprint)
    logger.error('minecraft.physics_error', { error })
  }
}

function fromMinecraftYaw (degrees) {
  const fullTurn = Math.PI * 2
  return ((Math.PI - (degrees * Math.PI / 180)) % fullTurn + fullTurn) % fullTurn
}

function fromMinecraftPitch (degrees) {
  const radians = -degrees * Math.PI / 180
  return Math.atan2(Math.sin(radians), Math.cos(radians))
}

function handlePhysicsTick () {
  if (stopping || !bot.entity?.position) return

  physicsTickCount += 1
  if (playSessionReady) return

  const blockAtPlayer = bot.blockAt(bot.entity.position, false)
  if (blockAtPlayer === null) return

  if (!worldReadyLogged) {
    worldReadyLogged = true
    logger.info('minecraft.world_physics_ready', {
      playSessionId,
      worldLoadId,
      mapChunksReceived: worldChunkCount,
      loadedColumns: worldLoadedColumnEvents,
      position: formatPosition(bot.entity.position),
      velocityY: Number(bot.entity.velocity.y.toFixed(5)),
      onGround: bot.entity.onGround
    })
  }

  sendPlayerLoaded(playSessionId, 'chunk_backed_physics')
  markPlaySessionReady(playSessionId, 'chunk_backed_physics')

  if (
    lobbyExpectedAfterSessionId > 0 &&
    playSessionId > lobbyExpectedAfterSessionId &&
    !awaitingBoxPvpTransfer &&
    !boxPvpCommandScheduled
  ) {
    markLobbyReady('authenticated_session_physics')
  }
}

function isCurrentColumnLoaded () {
  if (!bot.entity?.position || typeof bot.world?.getColumnAt !== 'function') return false
  return bot.world.getColumnAt(bot.entity.position) != null
}

function isBlockLoadedAtPlayer () {
  if (!bot.entity?.position || typeof bot.blockAt !== 'function') return false
  return bot.blockAt(bot.entity.position, false) !== null
}

function formatPosition (position) {
  return {
    x: Number(position.x.toFixed(3)),
    y: Number(position.y.toFixed(3)),
    z: Number(position.z.toFixed(3))
  }
}

function sendPlayerLoaded (sessionId, source) {
  if (stopping || sessionId !== playSessionId || playerLoadedSent) return
  client.write('player_loaded', {})
  playerLoadedSent = true
  logger.debug('minecraft.player_loaded_sent', { playSessionId: sessionId, source })
}

function markPlaySessionReady (sessionId, source) {
  if (stopping || sessionId !== playSessionId || playSessionReady) return

  clearTimeout(playReadyTimer)
  playReadyTimer = null
  playSessionReady = true
  logger.info('minecraft.play_session_ready', { playSessionId: sessionId, source })

  handleServerReady()
  if (afkConfirmed) scheduleGemsPollingStart()
}

function updateBotStatus (status) {
  currentStatus = status
  sessionEvents.emit('status', { username, status, snapshot: getSessionSnapshot() })
  if (!database.open) return
  const now = new Date().toISOString()
  updateBotStatusStatement.run(status, now, username)
}

function getSessionSnapshot () {
  return {
    username,
    status: currentStatus,
    protocolState: client?.state ?? 'disconnected',
    playSessionId,
    playSessionReady,
    afkConfirmed,
    connectedAt,
    afkStartedAt,
    lastRewardAt,
    gems: currentGems,
    gemsUpdatedAt,
    transferInProgress,
    stopping
  }
}

function updateBotGems (gems) {
  currentGems = gems
  gemsUpdatedAt = new Date().toISOString()
  if (!database.open) return
  const now = gemsUpdatedAt
  updateBotGemsStatement.run(gems, now, now, username)
}

function knownTransferTargets () {
  if (!database.open) return []
  const recent = selectTransferTargetsStatement.all(username).map(row => row.target_username)
  const online = Object.keys(bot.players || {})
    .filter(playerName => playerName.toLowerCase() !== username.toLowerCase())
    .sort((left, right) => left.localeCompare(right, 'en'))
  return [...new Set([...recent, ...online])]
}

function formatDuration (startedAt) {
  if (!startedAt) return 'n/a'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatOperatorValue (value, terminal) {
  const rendered = value === null || value === undefined ? 'n/a' : String(value)
  return terminal.useColor ? `${CONSOLE_COLORS.white}${rendered}${RESET}` : rendered
}

function closestOperatorCommand (input) {
  const commands = Object.keys(OPERATOR_COMMANDS)
  let closest = commands[0]
  let closestDistance = Number.POSITIVE_INFINITY
  for (const command of commands) {
    const distance = levenshteinDistance(input, command)
    if (distance < closestDistance) {
      closest = command
      closestDistance = distance
    }
  }
  return closestDistance <= Math.max(2, Math.floor(input.length / 2)) ? closest : null
}

function levenshteinDistance (left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

async function executeOperatorCommand (input, terminal) {
  const [rawCommand, ...args] = input.split(/\s+/u)
  const command = rawCommand.toLowerCase()

  switch (command) {
    case 'help':
      showOperatorHelp(args[0], terminal)
      return
    case 'status':
      showOperatorStatus(terminal)
      return
    case 'gems': {
      if (args.length > 0) throw new Error(`Usage: ${OPERATOR_COMMANDS.gems.usage}`)
      terminal.info('Requesting the live gems balance...')
      const gems = await requestGemsBalance({ reason: 'operator_command' })
      terminal.success(`Gems balance: ${gems.toLocaleString('en-US')}`)
      return
    }
    case 'send':
      if (args.length !== 2) throw new Error(`Usage: ${OPERATOR_COMMANDS.send.usage}`)
      await transferGems(args[0], args[1], terminal)
      return
    case 'history':
      showTransferHistory(args[0], terminal)
      return
    case 'clear':
      if (args.length > 0) throw new Error(`Usage: ${OPERATOR_COMMANDS.clear.usage}`)
      process.stdout.write('\x1b[2J\x1b[H')
      return
    case 'reconnect':
      if (args.length > 0) throw new Error(`Usage: ${OPERATOR_COMMANDS.reconnect.usage}`)
      terminal.info('Restarting the bot process...')
      restartRequested = true
      shutdown('operator_reconnect')
      return
    case 'stop':
    case 'exit':
      if (args.length > 0) throw new Error(`Usage: ${OPERATOR_COMMANDS[command].usage}`)
      terminal.info('Stopping the bot...')
      shutdown(`operator_${command}`)
      return
    default: {
      const suggestion = closestOperatorCommand(command)
      throw new Error(suggestion
        ? `Unknown command "${rawCommand}". Did you mean "${suggestion}"?`
        : `Unknown command "${rawCommand}". Run "help" to list commands.`)
    }
  }
}

function showOperatorHelp (requestedCommand, terminal) {
  if (requestedCommand) {
    const command = requestedCommand.toLowerCase()
    const specification = OPERATOR_COMMANDS[command]
    if (!specification) throw new Error(`Unknown command "${requestedCommand}"`)
    terminal.writeLines([
      `${formatOperatorValue(specification.usage, terminal)}`,
      `  ${specification.description}`
    ])
    return
  }

  const commandWidth = Math.max(...Object.values(OPERATOR_COMMANDS).map(item => item.usage.length))
  terminal.writeLines([
    formatOperatorValue('Available commands', terminal),
    ...Object.values(OPERATOR_COMMANDS).map(item => `  ${item.usage.padEnd(commandWidth)}  ${item.description}`),
    '',
    'Use Tab to complete commands and Up/Down to navigate command history.'
  ])
}

function showOperatorStatus (terminal) {
  terminal.writeLines([
    formatOperatorValue('Bot status', terminal),
    `  Username       ${formatOperatorValue(username, terminal)}`,
    `  Status         ${formatOperatorValue(currentStatus, terminal)}`,
    `  Protocol       ${formatOperatorValue(client.state, terminal)}`,
    `  Play session   ${formatOperatorValue(playSessionId, terminal)}`,
    `  AFK confirmed  ${formatOperatorValue(afkConfirmed, terminal)}`,
    `  Connected for  ${formatOperatorValue(formatDuration(connectedAt), terminal)}`,
    `  AFK for        ${formatOperatorValue(formatDuration(afkStartedAt), terminal)}`,
    `  Gems           ${formatOperatorValue(currentGems.toLocaleString('en-US'), terminal)}`,
    `  Gems updated   ${formatOperatorValue(gemsUpdatedAt || 'never', terminal)}`,
    `  Transfer busy  ${formatOperatorValue(transferInProgress, terminal)}`
  ])
}

function showTransferHistory (rawLimit, terminal) {
  const limit = rawLimit === undefined ? 10 : Number.parseInt(rawLimit, 10)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || String(limit) !== String(rawLimit ?? limit)) {
    throw new Error('History limit must be an integer between 1 and 50')
  }

  const transfers = selectTransferHistoryStatement.all(username, limit)
  if (transfers.length === 0) {
    terminal.info('No gems transfers have been recorded.')
    return
  }

  terminal.writeLines([
    formatOperatorValue('Recent gems transfers', terminal),
    ...transfers.map(transfer => {
      const after = transfer.balance_after === null ? '?' : transfer.balance_after
      return `  #${transfer.id} ${transfer.requested_at}  ${transfer.target_username}  ${transfer.amount} gems  ${transfer.status}  ${transfer.balance_before}->${after}`
    })
  ])
}

async function transferGems (target, rawAmount, terminal) {
  if (transferInProgress) throw new Error('Another gems transfer is already in progress')
  if (!/^[A-Za-z0-9_]{3,16}$/u.test(target)) {
    throw new Error('Player name must contain 3-16 letters, numbers, or underscores')
  }
  if (target.toLowerCase() === username.toLowerCase()) {
    throw new Error('The bot cannot transfer gems to itself')
  }

  const normalizedAmount = rawAmount.toLowerCase()
  const sendAll = normalizedAmount === 'all' || normalizedAmount === 'max'
  if (!sendAll && !/^[1-9][0-9]*$/u.test(rawAmount)) {
    throw new Error('Amount must be a positive integer, "all", or "max"')
  }

  transferInProgress = true
  let transferId = null
  let balanceBefore = null
  let amount = null
  let serverResponse = null

  try {
    terminal.info(`Checking the live balance before sending gems to ${target}...`)
    balanceBefore = await requestGemsBalance({ reason: 'transfer_preflight' })
    amount = sendAll ? balanceBefore : Number.parseInt(rawAmount, 10)

    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('There are no gems available to transfer')
    if (amount > balanceBefore) {
      throw new Error(`Insufficient gems: requested ${amount}, available ${balanceBefore}`)
    }

    const requestedAt = new Date().toISOString()
    transferId = Number(insertTransferStatement.run(
      username,
      target,
      amount,
      balanceBefore,
      requestedAt
    ).lastInsertRowid)

    const responsePromise = waitForTransferResponse(target, amount, 5000)
    const sent = await scheduleCommand(
      'gems_transfer',
      `/gems 1 ${target} ${amount}`,
      { transferId, target, amount },
      () => afkConfirmed && playSessionReady
    )
    if (!sent) throw new Error('The transfer command was cancelled')

    serverResponse = await responsePromise
    if (serverResponse?.outcome === 'failure') {
      throw new Error(serverResponse.message)
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
    let balanceAfter = currentGems
    let verificationError = null
    try {
      balanceAfter = await requestGemsBalance({ reason: 'transfer_verification' })
    } catch (error) {
      verificationError = error
    }

    const explicitSuccess = serverResponse?.outcome === 'success'
    const balanceVerified = balanceAfter <= balanceBefore - amount
    const completedAt = new Date().toISOString()

    if (explicitSuccess || balanceVerified) {
      completeTransferStatement.run(
        'success',
        balanceAfter,
        serverResponse?.message ?? null,
        verificationError?.message ?? null,
        completedAt,
        transferId
      )
      logger.info('minecraft.gems_transfer_completed', {
        transferId,
        target,
        amount,
        balanceBefore,
        balanceAfter,
        verification: explicitSuccess ? 'server_response' : 'balance_delta'
      })
      terminal.success(balanceVerified
        ? `Sent ${amount.toLocaleString('en-US')} gems to ${target}. Remaining balance: ${balanceAfter.toLocaleString('en-US')}`
        : `The server confirmed ${amount.toLocaleString('en-US')} gems were sent to ${target}. Balance refresh is pending.`)
      return { status: 'success', target, amount, balanceBefore, balanceAfter, transferId }
    }

    completeTransferStatement.run(
      'unverified',
      balanceAfter,
      serverResponse?.message ?? null,
      verificationError?.message ?? 'The balance did not confirm the transfer',
      completedAt,
      transferId
    )
    logger.warn('minecraft.gems_transfer_unverified', {
      transferId,
      target,
      amount,
      balanceBefore,
      balanceAfter
    })
    terminal.warn('The command was sent, but the server balance did not confirm the transfer. Check history before retrying.')
    return { status: 'unverified', target, amount, balanceBefore, balanceAfter, transferId }
  } catch (error) {
    if (transferId !== null) {
      completeTransferStatement.run(
        'failed',
        currentGems,
        serverResponse?.message ?? null,
        error?.message || String(error),
        new Date().toISOString(),
        transferId
      )
    }
    logger.warn('minecraft.gems_transfer_failed', {
      transferId,
      target,
      amount,
      balanceBefore,
      reason: error?.message || String(error)
    })
    throw error
  } finally {
    if (activeTransfer !== null) clearTimeout(activeTransfer.timer)
    activeTransfer = null
    transferInProgress = false
  }
}

function waitForTransferResponse (target, amount, timeoutMs) {
  if (activeTransfer !== null) return Promise.reject(new Error('A transfer response is already pending'))
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (activeTransfer?.timer === timer) activeTransfer = null
      resolve(null)
    }, timeoutMs)
    activeTransfer = { target, amount, resolve, timer }
  })
}

function handleTransferMessage (message) {
  if (activeTransfer === null || !message) return false
  const normalized = message.toLocaleLowerCase('tr-TR')
  if (!normalized.includes('gem')) return false
  if (/gems['\u2019]?in\s+var/iu.test(message)) return false

  const targetMentioned = normalized.includes(activeTransfer.target.toLocaleLowerCase('tr-TR'))
  const amountMentioned = new RegExp(`(^|\\D)${activeTransfer.amount}(\\D|$)`, 'u').test(message)
  if (!targetMentioned && !amountMentioned) return false

  const failureTerms = ['yetersiz', 'bulunamad', 'çevrimdışı', 'cevrimdisi', 'offline', 'geçersiz', 'gecersiz', 'gönderilemedi', 'gonderilemedi']
  const successTerms = ['gönderildi', 'gonderildi', 'gönderdin', 'gonderdin', 'başarıyla', 'basariyla']
  const outcome = failureTerms.some(term => normalized.includes(term))
    ? 'failure'
    : successTerms.some(term => normalized.includes(term)) ? 'success' : null
  if (outcome === null) return false

  const pending = activeTransfer
  activeTransfer = null
  clearTimeout(pending.timer)
  pending.resolve({ outcome, message })
  logger.info('minecraft.gems_transfer_response', {
    target: pending.target,
    amount: pending.amount,
    outcome,
    message
  })
  return true
}

function sendRegistrationCommand () {
  if (typeof client.chat !== 'function' || authCommandSent !== null) return

  registrationAttempts += 1
  authCommandSent = 'register'
  scheduleCommand('register', `/register ${accountPassword} ${accountEmail}`, {
    email: accountEmail,
    attempt: registrationAttempts,
    passwordSource: CONFIG.password ? 'environment' : 'generated'
  })
}

function scheduleCommand (name, command, metadata = {}, shouldSend = () => true) {
  const delayMs = crypto.randomInt(200, 1001)
  logger.debug('minecraft.command_scheduled', { name, delayMs, ...metadata })

  commandQueue = commandQueue
    .then(() => new Promise(resolve => setTimeout(resolve, delayMs)))
    .then(() => {
      if (stopping || !shouldSend()) {
        logger.info('minecraft.command_cancelled', {
          name,
          reason: stopping ? 'shutdown' : 'no_longer_required'
        })
        return false
      }
      if (typeof client.chat !== 'function') {
        throw new Error('Minecraft chat API is not ready')
      }

      logger.info('minecraft.command_sending', { name, ...metadata })
      client.chat(command)
      logger.info('minecraft.command_sent', { name, ...metadata })
      return true
    })
    .catch(error => {
      logger.error('minecraft.command_failed', { name, error })
      return false
    })

  return commandQueue
}

function shutdown (signal) {
  if (stopping) return
  stopping = true
  if (!MANAGED_SESSION) operatorConsole?.stop()
  if (activeTransfer !== null) {
    clearTimeout(activeTransfer.timer)
    activeTransfer.resolve(null)
    activeTransfer = null
  }
  clearTimeout(afkConfirmationTimer)
  clearTimeout(boxPvpDelayTimer)
  boxPvpDelayTimer = null
  suspendPlaySession()
  stopGemsPolling()
  updateBotStatus('stopping')
  logger.info('application.shutdown_requested', { signal })
  client.end('Client shutdown')
}

if (!MANAGED_SESSION) {
  operatorConsole = new OperatorConsole(executeOperatorCommand)
  if (operatorConsole.start()) {
    logger.info('operator.console_ready', {
      prompt: 'zenitmc >',
      commands: Object.keys(OPERATOR_COMMANDS).length
    })
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', error => {
    logger.error('application.uncaught_exception', { error })
    process.exitCode = 1
  })

  process.on('unhandledRejection', reason => {
    logger.error('application.unhandled_rejection', { reason })
    process.exitCode = 1
  })
}

const managedTerminal = Object.freeze({
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {}
})

module.exports = {
  username,
  events: sessionEvents,
  getSnapshot: getSessionSnapshot,
  requestGems: reason => requestGemsBalance({ reason: reason || 'manager_request' }),
  sendGems: (target, amount) => transferGems(target, String(amount), managedTerminal),
  stop: reason => shutdown(reason || 'manager_stop')
}
