'use strict'

const crypto = require('node:crypto')
const readline = require('node:readline/promises')
const { stdin, stdout } = require('node:process')
const { Repository } = require('./src/database')
const { Logger } = require('./src/logger')
const { OperatorConsole, COMMANDS } = require('./src/operator-console')
const { BotManager, MAX_BOTS } = require('./src/bot-manager')
const { PROFILES, getLogProfile, setLogProfile } = require('./src/log-policy')
const { nextRewardRemainingMs, averageRewardRemainingMs } = require('./src/afk-reward')

const DEVELOPMENT_MODE = process.argv.includes('dev') || process.env.NODE_ENV === 'development'
setLogProfile(process.env.LOG_PROFILE || (DEVELOPMENT_MODE ? 'quiet' : 'normal'))
const logger = new Logger({
  pretty: DEVELOPMENT_MODE,
  level: process.env.LOG_LEVEL || 'debug',
  context: { service: 'zenitmc-manager' }
})
const repository = new Repository()
const manager = new BotManager({ repository, logger })
const instanceId = crypto.randomUUID()
let terminal = null
let heartbeatTimer = null
let closing = false

const HELP = Object.freeze({
  help: 'Show available commands or detailed command usage.',
  bots: 'List stored accounts and their live connection state.',
  status: 'Show manager summary or detailed state for one bot.',
  gems: 'Show cached totals, refresh all ready bots, or query one bot.',
  send: 'Send an aggregate amount from all ready AFK bots.',
  history: 'Show recent per-bot gems transfer records.',
  auto: 'Show, enable, or disable automatic gems transfers.',
  logs: 'Show or change the live terminal log detail level.',
  reconnect: 'Reconnect one bot or every managed bot.',
  stop: 'Stop one bot or every managed bot without exiting the console.',
  clear: 'Clear the interactive terminal.',
  exit: 'Stop every bot and close the manager.'
})

async function main () {
  repository.acquireLease(instanceId, process.pid)
  heartbeatTimer = setInterval(() => repository.heartbeatLease(instanceId), 30000)
  const count = await determineBotCount()

  logger.info('manager.starting', {
    nodeVersion: process.version,
    pid: process.pid,
    mode: DEVELOPMENT_MODE ? 'development' : 'production',
    requestedBots: count,
    maxBots: MAX_BOTS,
    autoEnabled: false
  })

  if (DEVELOPMENT_MODE) {
    terminal = new OperatorConsole({
      handler: executeCommand,
      botNames: () => manager.botNames()
    })
    terminal.start()
  }

  await manager.start(count)
  if (closing) return
  logger.info('manager.ready', {
    managedBots: count,
    autoEnabled: manager.autoStatus().enabled,
    connectionQueue: manager.connectionStatus().queued
  })
}

async function determineBotCount () {
  const argument = process.argv.find(item => item.startsWith('--bots='))
  const argumentIndex = process.argv.indexOf('--bots')
  const raw = argument
    ? argument.slice('--bots='.length)
    : argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.BOT_COUNT

  if (raw !== undefined) return parseBotCount(raw)
  if (!DEVELOPMENT_MODE || !stdin.isTTY || !stdout.isTTY) return 1

  const prompt = readline.createInterface({ input: stdin, output: stdout })
  try {
    const answer = await prompt.question('Number of bots [1]: ')
    return parseBotCount(answer.trim() || '1')
  } finally {
    prompt.close()
  }
}

function parseBotCount (value) {
  if (!/^[0-9]+$/u.test(String(value))) throw new Error(`Bot count must be between 1 and ${MAX_BOTS}`)
  const count = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BOTS) {
    throw new Error(`Bot count must be between 1 and ${MAX_BOTS}`)
  }
  return count
}

async function executeCommand (input, consoleUi) {
  const [rawCommand, ...args] = input.split(/\s+/u)
  const command = rawCommand.toLowerCase()

  switch (command) {
    case 'help':
      showHelp(args[0], consoleUi)
      return
    case 'bots':
      ensureArguments(args, 0, COMMANDS.bots)
      showBots(consoleUi)
      return
    case 'status':
      if (args.length > 1) throw new Error(`Usage: ${COMMANDS.status}`)
      showStatus(args[0], consoleUi)
      return
    case 'gems':
      if (args.length > 1) throw new Error(`Usage: ${COMMANDS.gems}`)
      await showGems(args[0], consoleUi)
      return
    case 'send':
      ensureArguments(args, 2, COMMANDS.send)
      await sendGems(args[0], args[1], consoleUi)
      return
    case 'history':
      if (args.length > 1) throw new Error(`Usage: ${COMMANDS.history}`)
      showHistory(args[0], consoleUi)
      return
    case 'auto':
      await handleAuto(args, consoleUi)
      return
    case 'logs':
      if (args.length > 1) throw new Error(`Usage: ${COMMANDS.logs}`)
      if (args[0]) setLogProfile(args[0])
      consoleUi.success(`Log profile: ${getLogProfile()} (${PROFILES.join(' | ')})`)
      return
    case 'reconnect':
      ensureArguments(args, 1, COMMANDS.reconnect)
      consoleUi.success(`Reconnect requested for ${manager.reconnect(args[0])} bot(s).`)
      return
    case 'stop':
      ensureArguments(args, 1, COMMANDS.stop)
      consoleUi.success(`Stopped ${manager.stop(args[0])} bot(s).`)
      return
    case 'clear':
      ensureArguments(args, 0, COMMANDS.clear)
      stdout.write('\x1b[2J\x1b[H')
      return
    case 'exit':
      ensureArguments(args, 0, COMMANDS.exit)
      consoleUi.info('Stopping all managed bots...')
      await shutdown('operator_exit')
      return
    default:
      throw new Error(`Unknown command "${rawCommand}". Run "help" to list commands.`)
  }
}

function ensureArguments (args, count, usage) {
  if (args.length !== count) throw new Error(`Usage: ${usage}`)
}

function showHelp (requested, consoleUi) {
  if (requested) {
    const command = requested.toLowerCase()
    if (!COMMANDS[command]) throw new Error(`Unknown command "${requested}"`)
    consoleUi.lines([consoleUi.heading(COMMANDS[command]), `  ${HELP[command]}`])
    return
  }

  const width = Math.max(...Object.values(COMMANDS).map(value => value.length))
  consoleUi.lines([
    consoleUi.heading('Available commands'),
    ...Object.entries(COMMANDS).map(([name, usage]) => `  ${usage.padEnd(width)}  ${HELP[name]}`),
    '',
    'Use Tab to complete commands and Up/Down to navigate command history.'
  ])
}

function showBots (consoleUi) {
  const snapshots = manager.snapshots()
  const width = Math.max(8, ...snapshots.map(item => item.username.length))
  consoleUi.lines([
    consoleUi.heading(`Managed accounts (${snapshots.length})`),
    ...snapshots.map(item => {
      const status = item.active ? item.status : item.status || 'offline'
      const freshness = balanceFreshness(item)
      return `  ${item.username.padEnd(width)}  ${String(status).padEnd(12)}  gems=${String(item.gems || 0).padEnd(8)}  ${freshness}`
    })
  ])
}

function showStatus (username, consoleUi) {
  if (username) {
    const item = manager.snapshot(username)
    if (!item) throw new Error(`Unknown bot "${username}"`)
    const admission = manager.connectionStatus()
    const isCurrentAdmission = admission.current?.username.toLowerCase() === item.username.toLowerCase()
    const connectionState = item.connectionQueued
      ? `queued #${item.connectionQueuePosition} (${item.connectionQueueReason})`
      : isCurrentAdmission ? `admitting (${admission.current.reason})` : item.active ? 'connected' : 'offline'
    consoleUi.lines([
      consoleUi.heading(`Bot status: ${item.username}`),
      `  Active          ${item.active}`,
      `  Status          ${item.status}`,
      `  Protocol        ${item.protocolState || 'offline'}`,
      `  Admission       ${connectionState}`,
      `  Next retry      ${formatFuture(item.reconnectDueAt)}`,
      `  AFK confirmed   ${Boolean(item.afkConfirmed)}`,
      `  AFK duration    ${formatElapsed(item.afkStartedAt)}`,
      `  Next AFK reward ${formatCountdown(nextRewardRemainingMs(item))}`,
      `  Last reward     ${formatPast(item.lastRewardAt)}`,
      `  Gems            ${Number(item.gems || 0).toLocaleString('en-US')}`,
      `  Gems freshness  ${balanceFreshness(item)}`,
      `  Reconnects      ${item.reconnectAttempts || 0}`,
      `  Last error      ${item.last_error || 'none'}`
    ])
    return
  }

  const snapshots = manager.snapshots()
  const auto = manager.autoStatus()
  const admission = manager.connectionStatus()
  const rewardSchedule = averageRewardRemainingMs(snapshots)
  consoleUi.lines([
    consoleUi.heading('Manager status'),
    `  Stored accounts ${snapshots.length}`,
    `  Managed bots    ${manager.sessions.size}`,
    `  Active bots     ${snapshots.filter(item => item.active).length}`,
    `  AFK bots        ${snapshots.filter(item => item.afkConfirmed).length}`,
    `  Blocked bots    ${snapshots.filter(item => item.status === 'blocked').length}`,
    `  Operation busy  ${manager.operationBusy}`,
    `  Auto enabled    ${auto.enabled}`,
    `  Log profile     ${getLogProfile()}`,
    `  Memory RSS      ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`,
    '',
    consoleUi.heading('Connection admission'),
    `  Current         ${admission.current ? `${admission.current.username} (${admission.current.reason})` : 'idle'}`,
    `  Queue           ${admission.queued} ready, ${admission.delayedReconnects} delayed`,
    `  Pace            ${(admission.intervalMinMs / 1000).toFixed(0)}-${(admission.intervalMaxMs / 1000).toFixed(0)}s; ${admission.batchSize} per batch`,
    `  Batch pause     ${(admission.batchPauseMs / 1000).toFixed(0)}s (${admission.batchProgress}/${admission.batchSize})`,
    `  Cooldown        ${admission.cooldownRemainingMs > 0 ? `${formatCountdown(admission.cooldownRemainingMs)} (${admission.cooldownReason})` : 'none'}`,
    `  Next attempt    ${admission.nextAttemptRemainingMs > 0 ? formatCountdown(admission.nextAttemptRemainingMs) : 'ready'}`,
    `  Admissions      ${admission.admitted}/${admission.attempts} successful`,
    `  Rate limits     ${admission.rateLimits}`,
    `  Replacements    ${admission.replacements}`,
    '',
    consoleUi.heading('AFK rewards'),
    `  Tracked bots    ${rewardSchedule.tracked}`,
    `  Average next    ${formatCountdown(rewardSchedule.average)}`
  ])
}

async function showGems (argument, consoleUi) {
  if (argument === '--refresh') {
    consoleUi.info('Refreshing every ready AFK bot with a global concurrency limit of 3...')
    const results = await manager.refreshAll()
    const failed = results.filter(item => item.status === 'failed')
    consoleUi.info(`Refreshed ${results.length - failed.length}/${results.length} ready bots.`)
    if (failed.length) consoleUi.warn(`${failed.length} bot balance request(s) failed.`)
    showGemsSummary(consoleUi)
    return
  }
  if (argument) {
    consoleUi.info(`Requesting the live balance for ${argument}...`)
    const gems = await manager.refreshBot(argument)
    consoleUi.success(`${argument}: ${gems.toLocaleString('en-US')} gems`)
    return
  }
  showGemsSummary(consoleUi)
}

function showGemsSummary (consoleUi) {
  const summary = manager.gemsSummary()
  consoleUi.lines([
    consoleUi.heading('Gems summary'),
    `  Total balance     ${summary.total.toLocaleString('en-US')}`,
    `  Online bots       ${summary.online} / ${summary.accounts}`,
    `  Fresh balances    ${summary.freshAmount.toLocaleString('en-US')} (${summary.fresh})`,
    `  Stale balances    ${summary.staleAmount.toLocaleString('en-US')} (${summary.stale})`,
    `  Unknown balances  ${summary.unknown}`
  ])
}

async function sendGems (target, amount, consoleUi) {
  consoleUi.info(`Refreshing ready bots and preparing aggregate transfer to ${target}...`)
  const report = await manager.sendAggregate(target, amount)
  const message = `Batch #${report.batchId}: sent ${report.sentAmount}/${report.requested} gems with ${report.successfulBots} successful, ${report.failedBots} failed, ${report.skippedBots} skipped bot(s).`
  if (report.status === 'success') consoleUi.success(message)
  else if (report.status === 'partial') consoleUi.warn(message)
  else consoleUi.error(message)
}

function showHistory (rawLimit, consoleUi) {
  const limit = rawLimit === undefined ? 10 : Number.parseInt(rawLimit, 10)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || String(limit) !== String(rawLimit ?? limit)) {
    throw new Error('History limit must be an integer between 1 and 50')
  }
  const rows = repository.history(limit)
  if (!rows.length) {
    consoleUi.info('No gems transfers have been recorded.')
    return
  }
  consoleUi.lines([
    consoleUi.heading('Recent gems transfers'),
    ...rows.map(row => `  #${row.id} batch=${row.batch_id ?? '-'} ${row.bot_username} -> ${row.target_username}  ${row.amount} gems  ${row.status}`)
  ])
}

async function handleAuto (args, consoleUi) {
  const action = (args[0] || 'status').toLowerCase()
  if (action === 'status') {
    if (args.length > 1) throw new Error(`Usage: ${COMMANDS.auto}`)
    const state = manager.autoStatus()
    consoleUi.lines([
      consoleUi.heading('Automatic transfer'),
      `  Enabled    ${state.enabled}`,
      `  Target     ${state.target || 'not configured'}`,
      `  Threshold  ${state.threshold}`,
      `  Reserve    ${state.reserve}`,
      `  Queued     ${state.queued}`
    ])
    return
  }
  if (action === 'off') {
    if (args.length > 1) throw new Error('Usage: auto off')
    manager.disableAuto()
    consoleUi.success('Automatic gems transfers are disabled for this process.')
    return
  }
  if (action === 'on') {
    if (args.length < 2 || args.length > 4) {
      throw new Error('Usage: auto on <player> [threshold] [reserve]')
    }
    const threshold = args[2] === undefined ? 120 : parseNonNegativeInteger(args[2], false)
    const reserve = args[3] === undefined ? 0 : parseNonNegativeInteger(args[3], true)
    consoleUi.info('Enabling auto and refreshing ready bot balances...')
    await manager.enableAuto(args[1], threshold, reserve)
    consoleUi.success(`Auto enabled for ${args[1]} with threshold=${threshold} reserve=${reserve}.`)
    return
  }
  throw new Error('Usage: auto <status|on|off> [player] [threshold] [reserve]')
}

function parseNonNegativeInteger (value, allowZero) {
  if (!/^[0-9]+$/u.test(String(value))) throw new Error('Expected an integer value')
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(allowZero ? 'Value must be zero or greater' : 'Value must be greater than zero')
  }
  return parsed
}

function balanceFreshness (item) {
  const timestamp = item.gemsUpdatedAt || item.gems_updated_at
  if (!timestamp) return 'unknown'
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000))
  const label = ageSeconds <= 6 * 60 ? 'fresh' : 'stale'
  if (ageSeconds < 60) return `${label} ${ageSeconds}s ago`
  return `${label} ${Math.floor(ageSeconds / 60)}m ago`
}

function formatCountdown (milliseconds) {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return 'not available'
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function formatElapsed (timestamp) {
  if (!timestamp) return 'not available'
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return 'not available'
  return formatCountdown(Date.now() - parsed)
}

function formatFuture (timestamp) {
  if (!timestamp) return 'none'
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return 'none'
  return parsed <= Date.now() ? 'ready' : `in ${formatCountdown(parsed - Date.now())}`
}

function formatPast (timestamp) {
  if (!timestamp) return 'none'
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return 'none'
  return `${formatCountdown(Date.now() - parsed)} ago`
}

async function shutdown (reason) {
  if (closing) return
  closing = true
  terminal?.stop()
  clearInterval(heartbeatTimer)
  logger.info('manager.shutdown_requested', { reason })
  await manager.shutdown()
  repository.releaseLease(instanceId)
  repository.close()
  logger.info('manager.shutdown_complete', { reason })
  process.exitCode = 0
}

process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('uncaughtException', error => {
  logger.error('manager.uncaught_exception', { error })
  void shutdown('uncaught_exception').finally(() => { process.exitCode = 1 })
})
process.on('unhandledRejection', reason => {
  logger.error('manager.unhandled_rejection', { reason })
})

void main().catch(error => {
  logger.error('manager.start_failed', { error })
  clearInterval(heartbeatTimer)
  repository.releaseLease(instanceId)
  repository.close()
  process.exitCode = 1
})
