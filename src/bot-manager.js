'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const { createAccountIdentity } = require('./username-generator')

const MAX_BOTS = 1000
const FRESH_BALANCE_MS = 6 * 60 * 1000
const CONNECTION_INTERVAL_MIN_MS = 9000
const CONNECTION_INTERVAL_MAX_MS = 11000
const CONNECTION_BATCH_SIZE = 15
const CONNECTION_BATCH_PAUSE_MS = 45000
const CONNECTION_ADMISSION_TIMEOUT_MS = 45000
const RECONNECT_DELAYS_MS = Object.freeze([5000, 10000, 20000, 40000, 60000])
const RATE_LIMIT_COOLDOWNS_MS = Object.freeze([60000, 120000, 240000, 300000])
const ALREADY_CONNECTED_DELAY_MIN_MS = 60000
const ALREADY_CONNECTED_DELAY_MAX_MS = 90000
const SILENT_REPLACEMENT_ATTEMPTS = 8
const MIN_HEALTHY_PEERS_FOR_REPLACEMENT = 5
const PERMANENT_DISCONNECT_TERMS = Object.freeze([
  'ban', 'banned', 'yasak', 'wrong password', 'yanlış şifre', 'invalid password',
  'account limit', 'hesap limiti'
])
const RATE_LIMIT_TERMS = Object.freeze([
  'çok hızlı giriş', 'cok hizli giris', 'too fast', 'rate limit', 'too many connections'
])
const ALREADY_CONNECTED_TERMS = Object.freeze([
  "bu proxy'ye zaten bağlısınız", "bu proxy'ye zaten baglisiniz", 'already connected'
])
const ADMISSION_SUCCESS_STATES = new Set(['lobby', 'boxpvp', 'afk'])
const CANONICAL_USERNAME_PATTERN = /You should join using username\s+([A-Za-z0-9_]{1,16}),\s+not\s+([A-Za-z0-9_]{1,16})/iu

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function randomDelay (minimum, maximum) {
  return crypto.randomInt(minimum, maximum + 1)
}

function normalizeDisconnectReason (reason) {
  return String(reason || '').toLocaleLowerCase('tr-TR')
}

function classifyDisconnectReason (reason) {
  const normalized = normalizeDisconnectReason(reason)
  if (PERMANENT_DISCONNECT_TERMS.some(term => normalized.includes(term))) return 'permanent'
  if (RATE_LIMIT_TERMS.some(term => normalized.includes(term))) return 'rate_limit'
  if (ALREADY_CONNECTED_TERMS.some(term => normalized.includes(term))) return 'already_connected'
  if (CANONICAL_USERNAME_PATTERN.test(String(reason || ''))) return 'canonical_username'
  return 'transient'
}

function extractCanonicalUsernameCorrection (reason, currentUsername) {
  const match = String(reason || '').match(CANONICAL_USERNAME_PATTERN)
  if (!match) return null
  const [, expected, provided] = match
  const current = String(currentUsername)
  const currentKey = current.toLowerCase()
  if (provided.toLowerCase() !== currentKey || expected.toLowerCase() !== currentKey) return null
  return expected
}

function isSilentTransportFailure (reason) {
  const normalized = String(reason || '').toLowerCase().replace(/\s+/gu, '')
  return normalized.includes('socketclosed') ||
    normalized.includes('econnreset') ||
    normalized.includes('epipe') ||
    normalized.includes('sockethangup')
}

class BotManager {
  constructor ({ repository, logger, connectionPolicy = {} }) {
    this.repository = repository
    this.logger = logger
    this.sessions = new Map()
    this.shuttingDown = false
    this.operationQueue = Promise.resolve()
    this.operationBusy = false
    this.autoEnabled = false
    this.autoTarget = repository.getSetting('auto.target', null)
    this.autoThreshold = repository.getSetting('auto.threshold', 120)
    this.autoReserve = repository.getSetting('auto.reserve', 0)
    this.autoQueued = new Set()
    this.autoGeneration = 0
    this.connectionPolicy = Object.freeze({
      intervalMinMs: connectionPolicy.intervalMinMs ?? CONNECTION_INTERVAL_MIN_MS,
      intervalMaxMs: connectionPolicy.intervalMaxMs ?? CONNECTION_INTERVAL_MAX_MS,
      batchSize: connectionPolicy.batchSize ?? CONNECTION_BATCH_SIZE,
      batchPauseMs: connectionPolicy.batchPauseMs ?? CONNECTION_BATCH_PAUSE_MS,
      admissionTimeoutMs: connectionPolicy.admissionTimeoutMs ?? CONNECTION_ADMISSION_TIMEOUT_MS
    })
    this.connectionQueue = []
    this.connectionQueued = new Set()
    this.connectionPumpPromise = null
    this.connectionWaitTimer = null
    this.connectionWaitResolve = null
    this.connectionCurrent = null
    this.connectionNextAttemptAt = 0
    this.connectionCooldownUntil = 0
    this.connectionCooldownReason = null
    this.connectionBatchAttempts = 0
    this.connectionRateLimitLevel = 0
    this.connectionSuccessesSinceRateLimit = 0
    this.connectionStats = {
      attempts: 0,
      admitted: 0,
      failed: 0,
      rateLimits: 0,
      batchPauses: 0,
      replacements: 0,
      lastAttemptAt: null,
      lastSuccessAt: null
    }
  }

  async start (count) {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BOTS) {
      throw new Error(`Bot count must be between 1 and ${MAX_BOTS}`)
    }

    const accounts = this.repository.selectAccounts(count)
    while (accounts.length < count) {
      const identity = createAccountIdentity(name => this.repository.accountExists(name))
      accounts.push(this.repository.insertAccount(identity))
      this.logger.info('manager.account_created', { username: identity.username })
    }

    this.logger.info('manager.sessions_starting', {
      requested: count,
      reused: accounts.filter(account => account.created_at !== account.updated_at).length,
      total: accounts.length
    })

    for (const account of accounts) {
      if (this.shuttingDown) break
      const record = this.ensureRecord(account)
      this.enqueueConnection(record, { reason: 'startup' })
    }
  }

  ensureRecord (account) {
    const key = account.username.toLowerCase()
    const existing = this.sessions.get(key)
    const record = existing || {
      account,
      controller: null,
      attempts: Number(account.reconnect_attempts || 0),
      reconnectTimer: null,
      reconnectDueAt: null,
      desired: true,
      restartNow: false,
      admissionPending: false,
      admissionResolve: null,
      queueReason: null,
      queuedAt: null,
      lastAdmissionAt: null
    }
    record.account = account
    record.desired = true
    this.sessions.set(key, record)
    return record
  }

  startSession (account, reason = 'requested') {
    const record = this.ensureRecord(account)
    return this.enqueueConnection(record, { reason })
  }

  enqueueConnection (record, { reason = 'scheduled', notBefore = Date.now(), priority = false } = {}) {
    if (this.shuttingDown || !record.desired) return false
    const key = record.account.username.toLowerCase()
    if (this.connectionQueued.has(key)) {
      const existing = this.connectionQueue.find(item => item.key === key)
      if (existing) existing.notBefore = Math.min(existing.notBefore, notBefore)
      return false
    }
    if (record.controller && !record.controller.getSnapshot().stopping) return false

    const item = { key, record, reason, notBefore, queuedAt: Date.now() }
    if (priority) this.connectionQueue.unshift(item)
    else this.connectionQueue.push(item)
    this.connectionQueued.add(key)
    record.queueReason = reason
    record.queuedAt = new Date(item.queuedAt).toISOString()
    this.repository.updateRuntime(record.account.username, {
      status: reason === 'startup' ? 'queued' : 'reconnecting',
      attempts: record.attempts
    })
    this.logger.debug('manager.connection_queued', {
      username: record.account.username,
      reason,
      queuePosition: this.connectionQueue.findIndex(entry => entry.key === key) + 1,
      notBefore: new Date(notBefore).toISOString()
    })
    this.wakeConnectionPump()
    this.startConnectionPump()
    return true
  }

  startConnectionPump () {
    if (this.connectionPumpPromise || this.shuttingDown) return
    this.connectionPumpPromise = this.runConnectionPump()
      .catch(error => this.logger.error('manager.connection_pump_failed', { error }))
      .finally(() => {
        this.connectionPumpPromise = null
        if (this.connectionQueue.length && !this.shuttingDown) this.startConnectionPump()
      })
  }

  async runConnectionPump () {
    while (!this.shuttingDown && this.connectionQueue.length) {
      const item = this.connectionQueue[0]
      const waitUntil = Math.max(
        item.notBefore,
        this.connectionNextAttemptAt,
        this.connectionCooldownUntil
      )
      const waitMs = Math.max(0, waitUntil - Date.now())
      if (waitMs > 0) {
        await this.waitForConnectionWindow(waitMs)
        continue
      }

      this.connectionQueue.shift()
      this.connectionQueued.delete(item.key)
      item.record.queueReason = null
      item.record.queuedAt = null
      if (!item.record.desired || item.record.controller) continue

      const startedAt = Date.now()
      this.connectionCurrent = {
        username: item.record.account.username,
        reason: item.reason,
        startedAt
      }
      this.connectionStats.attempts += 1
      this.connectionStats.lastAttemptAt = new Date(startedAt).toISOString()
      this.connectionNextAttemptAt = startedAt + randomDelay(
        this.connectionPolicy.intervalMinMs,
        this.connectionPolicy.intervalMaxMs
      )
      this.connectionBatchAttempts += 1

      const admission = this.startSessionNow(item.record, item.reason)
      const admissionOutcome = await Promise.race([
        admission,
        delay(this.connectionPolicy.admissionTimeoutMs).then(() => 'timeout')
      ])
      if (admissionOutcome === 'timeout' && item.record.admissionPending) {
        this.logger.warn('manager.connection_admission_timeout', {
          username: item.record.account.username,
          timeoutSeconds: Math.round(this.connectionPolicy.admissionTimeoutMs / 1000)
        })
        item.record.controller?.stop('admission_timeout')
      }
      this.connectionCurrent = null

      if (this.connectionBatchAttempts >= this.connectionPolicy.batchSize) {
        this.connectionBatchAttempts = 0
        if (this.connectionQueue.length) {
          this.connectionStats.batchPauses += 1
          this.extendConnectionCooldown(this.connectionPolicy.batchPauseMs, 'batch_pause')
          this.logger.info('manager.connection_batch_pause', {
            completedBatchSize: this.connectionPolicy.batchSize,
            pauseSeconds: Math.round(this.connectionPolicy.batchPauseMs / 1000),
            queued: this.connectionQueue.length
          })
        }
      }
    }
  }

  waitForConnectionWindow (milliseconds) {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(this.connectionWaitTimer)
        this.connectionWaitTimer = null
        this.connectionWaitResolve = null
        resolve()
      }
      this.connectionWaitResolve = finish
      this.connectionWaitTimer = setTimeout(finish, milliseconds)
    })
  }

  wakeConnectionPump () {
    this.connectionWaitResolve?.()
  }

  extendConnectionCooldown (milliseconds, reason) {
    const candidate = Date.now() + milliseconds
    if (candidate > this.connectionCooldownUntil) {
      this.connectionCooldownUntil = candidate
      this.connectionCooldownReason = reason
      this.wakeConnectionPump()
    }
  }

  startSessionNow (record, reason) {
    if (this.shuttingDown || !record.desired) return Promise.resolve('cancelled')
    const account = record.account
    clearTimeout(record.reconnectTimer)
    record.reconnectTimer = null
    record.reconnectDueAt = null
    record.admissionPending = true
    const admission = new Promise(resolve => { record.admissionResolve = resolve })

    try {
      record.controller = this.loadRuntime(account)
      this.bindSession(record)
      this.repository.updateRuntime(account.username, { status: 'connecting', attempts: record.attempts })
      this.logger.info('manager.session_started', {
        username: account.username,
        reconnectAttempt: record.attempts,
        admissionReason: reason
      })
    } catch (error) {
      record.controller = null
      this.finishAdmission(record, 'failed')
      this.logger.error('manager.session_start_failed', { username: account.username, error })
      this.scheduleReconnect(record, error.message, { admissionFailure: true })
    }
    return admission
  }

  loadRuntime (account) {
    const runtimePath = path.join(__dirname, '..', 'bot.js')
    const resolvedPath = require.resolve(runtimePath)
    const keys = ['ZENIT_MANAGED_SESSION', 'MC_USERNAME', 'MC_PASSWORD', 'MC_EMAIL']
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))

    process.env.ZENIT_MANAGED_SESSION = '1'
    process.env.MC_USERNAME = account.username
    process.env.MC_PASSWORD = account.password
    process.env.MC_EMAIL = account.email

    try {
      delete require.cache[resolvedPath]
      return require(resolvedPath)
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  }

  bindSession (record) {
    const { controller } = record
    controller.events.on('status', event => {
      if (event.status === 'afk') record.attempts = 0
      if (record.admissionPending && ADMISSION_SUCCESS_STATES.has(event.status)) {
        this.markAdmissionSuccess(record, event.status)
      }
      this.repository.updateRuntime(record.account.username, {
        status: event.status,
        attempts: record.attempts
      })
    })
    controller.events.on('gems', event => {
      this.maybeQueueAuto(record, event.gems)
    })
    controller.events.once('end', event => {
      record.controller = null
      const reason = event.reason || 'connection closed'
      const admissionFailure = record.admissionPending
      if (record.admissionPending) {
        this.connectionStats.failed += 1
        this.finishAdmission(record, 'ended')
      }
      if (this.shuttingDown || !record.desired) return
      if (record.restartNow) {
        record.restartNow = false
        this.enqueueConnection(record, { reason: 'manual_reconnect', priority: true })
        return
      }
      this.scheduleReconnect(record, reason, { admissionFailure })
    })
  }

  markAdmissionSuccess (record, status) {
    if (!record.admissionPending) return
    const now = new Date().toISOString()
    record.lastAdmissionAt = now
    this.connectionStats.admitted += 1
    this.connectionStats.lastSuccessAt = now
    this.connectionSuccessesSinceRateLimit += 1
    if (this.connectionRateLimitLevel > 0 && this.connectionSuccessesSinceRateLimit >= 10) {
      this.connectionRateLimitLevel -= 1
      this.connectionSuccessesSinceRateLimit = 0
    }
    this.logger.debug('manager.connection_admitted', {
      username: record.account.username,
      status,
      admitted: this.connectionStats.admitted,
      attempts: this.connectionStats.attempts
    })
    this.finishAdmission(record, 'admitted')
  }

  finishAdmission (record, outcome) {
    record.admissionPending = false
    const resolve = record.admissionResolve
    record.admissionResolve = null
    resolve?.(outcome)
  }

  applyRateLimitCooldown (reason) {
    const index = Math.min(this.connectionRateLimitLevel, RATE_LIMIT_COOLDOWNS_MS.length - 1)
    const cooldownMs = RATE_LIMIT_COOLDOWNS_MS[index]
    this.connectionRateLimitLevel = Math.min(
      this.connectionRateLimitLevel + 1,
      RATE_LIMIT_COOLDOWNS_MS.length - 1
    )
    this.connectionSuccessesSinceRateLimit = 0
    this.connectionStats.rateLimits += 1
    this.connectionBatchAttempts = 0
    this.extendConnectionCooldown(cooldownMs, 'server_rate_limit')
    this.logger.warn('manager.connection_rate_limited', {
      cooldownSeconds: Math.round(cooldownMs / 1000),
      level: this.connectionRateLimitLevel,
      queued: this.connectionQueue.length,
      reason
    })
    return cooldownMs
  }

  healthySessionCount (excludedRecord = null) {
    let count = 0
    for (const record of this.sessions.values()) {
      if (record === excludedRecord) continue
      const snapshot = record.controller?.getSnapshot()
      if (snapshot?.afkConfirmed || ADMISSION_SUCCESS_STATES.has(snapshot?.status)) count += 1
    }
    return count
  }

  replaceRecordAccount (record, reason, trigger) {
    const previousAccount = record.account
    const previousKey = previousAccount.username.toLowerCase()
    clearTimeout(record.reconnectTimer)
    record.reconnectTimer = null
    record.reconnectDueAt = null
    this.removeQueuedConnection(record)

    const identity = createAccountIdentity(name => this.repository.accountExists(name))
    const { previous, replacement } = this.repository.replaceAccount(
      previousAccount.username,
      identity,
      reason
    )

    this.sessions.delete(previousKey)
    this.autoQueued.delete(previousKey)
    record.account = replacement
    record.attempts = 0
    record.desired = true
    record.restartNow = false
    record.lastAdmissionAt = null
    this.sessions.set(replacement.username.toLowerCase(), record)
    this.connectionStats.replacements += 1

    const delayMs = randomDelay(1000, 3000)
    record.reconnectDueAt = new Date(Date.now() + delayMs).toISOString()
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = null
      record.reconnectDueAt = null
      this.enqueueConnection(record, {
        reason: `replacement:${trigger}`,
        priority: true
      })
    }, delayMs)

    this.logger.info('manager.account_replaced', {
      previousUsername: previous.username,
      replacementUsername: replacement.username,
      archivedGems: Number(previous.gems || 0),
      trigger,
      delayMs,
      reason
    })
    return replacement
  }

  scheduleReconnect (record, reason, { admissionFailure = false } = {}) {
    if (this.shuttingDown || !record.desired || record.reconnectTimer) return
    let classification = classifyDisconnectReason(reason)
    if (classification === 'canonical_username') {
      const canonicalUsername = extractCanonicalUsernameCorrection(reason, record.account.username)
      if (!canonicalUsername) {
        record.desired = false
        this.repository.updateRuntime(record.account.username, {
          status: 'blocked',
          attempts: record.attempts,
          error: `Unsafe canonical username response: ${reason}`
        })
        this.logger.error('manager.session_blocked', {
          username: record.account.username,
          reason: 'unsafe_canonical_username_response'
        })
        return
      }
      try {
        this.replaceRecordAccount(record, reason, 'server_username_collision')
        return
      } catch (error) {
        record.desired = false
        this.repository.updateRuntime(record.account.username, {
          status: 'blocked',
          attempts: record.attempts,
          error: error.message
        })
        this.logger.error('manager.session_blocked', {
          username: record.account.username,
          reason: 'canonical_username_update_failed',
          error
        })
        return
      }
    }
    if (classification === 'permanent') {
      record.desired = false
      this.repository.updateRuntime(record.account.username, {
        status: 'blocked',
        attempts: record.attempts,
        error: reason
      })
      this.logger.error('manager.session_blocked', { username: record.account.username, reason })
      return
    }

    const nextAttempt = record.attempts + 1
    const shouldReplaceSilentFailure = classification === 'transient' &&
      admissionFailure &&
      isSilentTransportFailure(reason) &&
      nextAttempt >= SILENT_REPLACEMENT_ATTEMPTS &&
      this.healthySessionCount(record) >= MIN_HEALTHY_PEERS_FOR_REPLACEMENT &&
      this.connectionCooldownUntil <= Date.now()

    if (shouldReplaceSilentFailure) {
      try {
        this.replaceRecordAccount(record, reason, 'repeated_silent_admission_failure')
        return
      } catch (error) {
        this.logger.error('manager.account_replacement_failed', {
          username: record.account.username,
          attempt: nextAttempt,
          reason,
          error
        })
      }
    }

    record.attempts += 1
    let delayMs
    if (classification === 'rate_limit') {
      delayMs = this.applyRateLimitCooldown(reason) + randomDelay(1000, 5000)
    } else if (classification === 'already_connected') {
      delayMs = randomDelay(ALREADY_CONNECTED_DELAY_MIN_MS, ALREADY_CONNECTED_DELAY_MAX_MS)
    } else if (classification === 'canonical_username') {
      delayMs = randomDelay(1000, 3000)
    } else {
      const baseDelay = RECONNECT_DELAYS_MS[Math.min(record.attempts - 1, RECONNECT_DELAYS_MS.length - 1)]
      delayMs = baseDelay + randomDelay(500, 1500)
    }
    this.repository.updateRuntime(record.account.username, {
      status: 'reconnecting',
      attempts: record.attempts,
      error: reason
    })
    this.logger.warn('manager.reconnect_scheduled', {
      username: record.account.username,
      attempt: record.attempts,
      delayMs,
      reason,
      classification
    })
    record.reconnectDueAt = new Date(Date.now() + delayMs).toISOString()
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = null
      record.reconnectDueAt = null
      record.account = this.repository.getAccount(record.account.username)
      this.enqueueConnection(record, { reason: `reconnect:${classification}` })
    }, delayMs)
  }

  getRecord (username) {
    return this.sessions.get(String(username).toLowerCase()) || null
  }

  botNames () {
    return this.repository.listAccounts()
      .filter(account => account.enabled)
      .map(account => account.username)
  }

  snapshots () {
    const accounts = this.repository.listAccounts().filter(account => account.enabled)
    return accounts.map(account => {
      const record = this.getRecord(account.username)
      const live = record?.controller?.getSnapshot()
      const key = account.username.toLowerCase()
      const queueIndex = this.connectionQueue.findIndex(item => item.key === key)
      return {
        ...account,
        ...(live || {}),
        active: Boolean(live),
        reconnectAttempts: record?.attempts ?? account.reconnect_attempts ?? 0,
        connectionQueued: this.connectionQueued.has(key),
        connectionQueuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
        connectionQueueReason: record?.queueReason || null,
        reconnectDueAt: record?.reconnectDueAt || null,
        lastAdmissionAt: record?.lastAdmissionAt || null
      }
    })
  }

  snapshot (username) {
    return this.snapshots().find(item => item.username.toLowerCase() === username.toLowerCase()) || null
  }

  connectionStatus () {
    const now = Date.now()
    const delayedReconnects = [...this.sessions.values()].filter(record => record.reconnectTimer).length
    const nextWindowAt = Math.max(this.connectionNextAttemptAt, this.connectionCooldownUntil)
    return {
      queued: this.connectionQueue.length,
      delayedReconnects,
      current: this.connectionCurrent ? { ...this.connectionCurrent } : null,
      intervalMinMs: this.connectionPolicy.intervalMinMs,
      intervalMaxMs: this.connectionPolicy.intervalMaxMs,
      batchSize: this.connectionPolicy.batchSize,
      batchProgress: this.connectionBatchAttempts,
      batchPauseMs: this.connectionPolicy.batchPauseMs,
      cooldownUntil: this.connectionCooldownUntil > now
        ? new Date(this.connectionCooldownUntil).toISOString()
        : null,
      cooldownRemainingMs: Math.max(0, this.connectionCooldownUntil - now),
      cooldownReason: this.connectionCooldownUntil > now ? this.connectionCooldownReason : null,
      nextAttemptAt: (this.connectionQueue.length || this.connectionCurrent) && nextWindowAt > now
        ? new Date(nextWindowAt).toISOString()
        : null,
      nextAttemptRemainingMs: (this.connectionQueue.length || this.connectionCurrent)
        ? Math.max(0, nextWindowAt - now)
        : 0,
      rateLimitLevel: this.connectionRateLimitLevel,
      ...this.connectionStats
    }
  }

  gemsSummary () {
    const now = Date.now()
    const accounts = this.snapshots().filter(account => account.enabled)
    let total = 0
    let fresh = 0
    let stale = 0
    let unknown = 0
    let freshAmount = 0
    let staleAmount = 0

    for (const account of accounts) {
      if (!account.gemsUpdatedAt && !account.gems_updated_at) {
        unknown += 1
        continue
      }
      const updatedAt = account.gemsUpdatedAt || account.gems_updated_at
      const amount = Number(account.gems || 0)
      total += amount
      if (now - Date.parse(updatedAt) <= FRESH_BALANCE_MS) {
        fresh += 1
        freshAmount += amount
      } else {
        stale += 1
        staleAmount += amount
      }
    }

    return {
      total,
      online: accounts.filter(account => account.active).length,
      accounts: accounts.length,
      fresh,
      freshAmount,
      stale,
      staleAmount,
      unknown
    }
  }

  readyRecords () {
    return [...this.sessions.values()].filter(record => {
      const snapshot = record.controller?.getSnapshot()
      return snapshot?.afkConfirmed && snapshot?.playSessionReady && !snapshot?.stopping
    })
  }

  async refreshBot (username) {
    const record = this.getRecord(username)
    if (!record?.controller) throw new Error(`Bot "${username}" is not active`)
    return record.controller.requestGems('manager_manual_refresh')
  }

  async refreshAll () {
    const records = this.readyRecords()
    const results = []
    let cursor = 0
    const worker = async () => {
      while (cursor < records.length) {
        const record = records[cursor]
        cursor += 1
        try {
          const gems = await record.controller.requestGems('manager_refresh_all')
          results.push({ username: record.account.username, status: 'success', gems })
        } catch (error) {
          results.push({ username: record.account.username, status: 'failed', error: error.message })
        }
        await delay(randomDelay(300, 800))
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, records.length) }, worker))
    return results
  }

  enqueueOperation (operation) {
    const result = this.operationQueue.then(async () => {
      this.operationBusy = true
      try { return await operation() } finally { this.operationBusy = false }
    })
    this.operationQueue = result.catch(() => {})
    return result
  }

  sendAggregate (target, requestedAmount) {
    return this.enqueueOperation(() => this.performAggregateSend(target, requestedAmount))
  }

  async performAggregateSend (target, requestedAmount) {
    if (!/^[A-Za-z0-9_]{3,16}$/u.test(target)) throw new Error('Invalid target player name')
    const sendAll = ['all', 'max'].includes(String(requestedAmount).toLowerCase())
    if (!sendAll && !/^[1-9][0-9]*$/u.test(String(requestedAmount))) {
      throw new Error('Amount must be a positive integer or "all"')
    }

    await this.refreshAll()
    const ready = this.readyRecords()
      .map(record => ({ record, snapshot: record.controller.getSnapshot() }))
      .filter(item => item.snapshot.gems > 0)
      .sort((left, right) => right.snapshot.gems - left.snapshot.gems)
    const available = ready.reduce((sum, item) => sum + item.snapshot.gems, 0)
    const requested = sendAll ? available : Number.parseInt(requestedAmount, 10)
    if (requested <= 0) throw new Error('No gems are available on active AFK bots')
    if (!sendAll && available < requested) {
      throw new Error(`Insufficient aggregate balance: requested ${requested}, available ${available}`)
    }

    const batchId = this.repository.createBatch(target, sendAll ? 'all' : 'amount', sendAll ? null : requested)
    let remaining = requested
    let sentAmount = 0
    let successfulBots = 0
    let failedBots = 0
    const failures = []

    for (const item of ready) {
      if (remaining <= 0) break
      const amount = Math.min(item.snapshot.gems, remaining)
      try {
        const result = await item.record.controller.sendGems(target, amount)
        if (result?.transferId) this.repository.attachTransferToBatch(result.transferId, batchId)
        if (result?.status === 'success') {
          sentAmount += amount
          remaining -= amount
          successfulBots += 1
        } else {
          failedBots += 1
          failures.push({ username: item.record.account.username, reason: 'unverified' })
        }
      } catch (error) {
        failedBots += 1
        failures.push({ username: item.record.account.username, reason: error.message })
      }
      await delay(randomDelay(300, 800))
    }

    const skippedBots = this.repository.listAccounts().filter(account => account.enabled).length - ready.length
    const status = sentAmount === requested && failedBots === 0
      ? 'success'
      : sentAmount > 0 ? 'partial' : 'failed'
    const report = { batchId, status, requested, sentAmount, successfulBots, failedBots, skippedBots, failures }
    this.repository.completeBatch(batchId, report)
    this.logger.info('manager.transfer_batch_completed', report)
    return report
  }

  async enableAuto (target, threshold = 120, reserve = 0) {
    if (!/^[A-Za-z0-9_]{3,16}$/u.test(target)) throw new Error('Invalid auto-transfer target')
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('Auto threshold must be a positive integer')
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw new Error('Auto reserve must be zero or greater')
    this.autoTarget = target
    this.autoThreshold = threshold
    this.autoReserve = reserve
    this.autoEnabled = true
    this.autoGeneration += 1
    this.repository.setSetting('auto.target', target)
    this.repository.setSetting('auto.threshold', threshold)
    this.repository.setSetting('auto.reserve', reserve)
    await this.refreshAll()
    for (const record of this.readyRecords()) {
      this.maybeQueueAuto(record, record.controller.getSnapshot().gems)
    }
  }

  disableAuto () {
    this.autoEnabled = false
    this.autoGeneration += 1
    this.autoQueued.clear()
  }

  autoStatus () {
    return {
      enabled: this.autoEnabled,
      target: this.autoTarget,
      threshold: this.autoThreshold,
      reserve: this.autoReserve,
      queued: this.autoQueued.size
    }
  }

  maybeQueueAuto (record, gems) {
    if (!this.autoEnabled || !this.autoTarget || gems < this.autoThreshold) return
    const key = record.account.username.toLowerCase()
    if (this.autoQueued.has(key)) return
    const amount = gems - this.autoReserve
    if (amount <= 0) return
    const generation = this.autoGeneration
    this.autoQueued.add(key)
    void this.enqueueOperation(async () => {
      let batchId = null
      try {
        const snapshot = record.controller?.getSnapshot()
        if (!this.autoEnabled || generation !== this.autoGeneration || !snapshot?.afkConfirmed || snapshot.gems < this.autoThreshold) return
        const liveAmount = Math.max(0, snapshot.gems - this.autoReserve)
        if (liveAmount <= 0) return
        batchId = this.repository.createBatch(this.autoTarget, 'auto', liveAmount)
        const result = await record.controller.sendGems(this.autoTarget, liveAmount)
        if (result?.transferId) this.repository.attachTransferToBatch(result.transferId, batchId)
        const success = result?.status === 'success'
        this.repository.completeBatch(batchId, {
          status: success ? 'success' : 'failed',
          sentAmount: success ? liveAmount : 0,
          successfulBots: success ? 1 : 0,
          failedBots: success ? 0 : 1,
          skippedBots: 0
        })
      } catch (error) {
        if (batchId !== null) {
          this.repository.completeBatch(batchId, {
            status: 'failed',
            sentAmount: 0,
            successfulBots: 0,
            failedBots: 1,
            skippedBots: 0
          })
        }
        this.logger.warn('manager.auto_transfer_failed', {
          username: record.account.username,
          target: this.autoTarget,
          error
        })
      } finally {
        this.autoQueued.delete(key)
      }
    })
  }

  reconnect (target) {
    const records = target.toLowerCase() === 'all'
      ? [...this.sessions.values()]
      : [this.getRecord(target)].filter(Boolean)
    if (!records.length) throw new Error(`Unknown bot "${target}"`)
    for (const record of records) {
      record.desired = true
      clearTimeout(record.reconnectTimer)
      record.reconnectTimer = null
      record.reconnectDueAt = null
      this.removeQueuedConnection(record)
      if (record.controller) {
        record.restartNow = true
        record.controller.stop('manager_reconnect')
      } else {
        this.enqueueConnection(record, { reason: 'manual_reconnect', priority: true })
      }
    }
    return records.length
  }

  stop (target) {
    const records = target.toLowerCase() === 'all'
      ? [...this.sessions.values()]
      : [this.getRecord(target)].filter(Boolean)
    if (!records.length) throw new Error(`Unknown bot "${target}"`)
    for (const record of records) {
      record.desired = false
      clearTimeout(record.reconnectTimer)
      record.reconnectTimer = null
      record.reconnectDueAt = null
      this.removeQueuedConnection(record)
      record.controller?.stop('manager_stop')
      this.repository.updateRuntime(record.account.username, { status: 'stopped', attempts: record.attempts })
    }
    return records.length
  }

  async shutdown () {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.autoEnabled = false
    const endings = []
    for (const record of this.sessions.values()) {
      record.desired = false
      clearTimeout(record.reconnectTimer)
      record.reconnectTimer = null
      record.reconnectDueAt = null
      if (!record.controller) continue
      endings.push(new Promise(resolve => {
        record.controller.events.once('end', resolve)
        record.controller.stop('manager_shutdown')
      }))
    }
    await Promise.race([
      Promise.allSettled(endings),
      delay(5000)
    ])
    this.connectionQueue.length = 0
    this.connectionQueued.clear()
    this.wakeConnectionPump()
  }

  removeQueuedConnection (record) {
    const key = record.account.username.toLowerCase()
    if (!this.connectionQueued.has(key)) return false
    this.connectionQueue = this.connectionQueue.filter(item => item.key !== key)
    this.connectionQueued.delete(key)
    record.queueReason = null
    record.queuedAt = null
    this.wakeConnectionPump()
    return true
  }
}

module.exports = {
  BotManager,
  MAX_BOTS,
  FRESH_BALANCE_MS,
  classifyDisconnectReason,
  extractCanonicalUsernameCorrection,
  isSilentTransportFailure,
  SILENT_REPLACEMENT_ATTEMPTS
}
