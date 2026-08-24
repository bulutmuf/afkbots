'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  BotManager,
  classifyDisconnectReason,
  extractCanonicalUsernameCorrection,
  isSilentTransportFailure,
  SILENT_REPLACEMENT_ATTEMPTS
} = require('../src/bot-manager')

function createRepository () {
  const completed = []
  return {
    completed,
    getSetting: (_key, fallback) => fallback,
    listAccounts: () => [
      { username: 'AlphaWolf1', enabled: 1 },
      { username: 'BetaLion2', enabled: 1 },
      { username: 'OfflineFox3', enabled: 1 }
    ],
    createBatch: () => 7,
    attachTransferToBatch: () => {},
    completeBatch: (_id, result) => completed.push(result)
  }
}

function createRecord (username, gems, sent) {
  return {
    account: { username },
    controller: {
      getSnapshot: () => ({
        username,
        gems,
        afkConfirmed: true,
        playSessionReady: true,
        stopping: false
      }),
      sendGems: async (_target, amount) => {
        sent.push({ username, amount })
        return { status: 'success', transferId: sent.length }
      }
    }
  }
}

test('aggregate numeric send distributes a total amount, not an amount per bot', async () => {
  const repository = createRepository()
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const manager = new BotManager({ repository, logger })
  const sent = []
  manager.sessions.set('alphawolf1', createRecord('AlphaWolf1', 200, sent))
  manager.sessions.set('betalion2', createRecord('BetaLion2', 100, sent))
  manager.refreshAll = async () => []

  const result = await manager.performAggregateSend('Collector1', '250')

  assert.deepEqual(sent, [
    { username: 'AlphaWolf1', amount: 200 },
    { username: 'BetaLion2', amount: 50 }
  ])
  assert.equal(result.sentAmount, 250)
  assert.equal(result.status, 'success')
  assert.equal(result.skippedBots, 1)
})

test('automatic transfers always start disabled', () => {
  const manager = new BotManager({
    repository: createRepository(),
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  })
  assert.equal(manager.autoStatus().enabled, false)
})

test('aggregate numeric send fails before transfer when total balance is insufficient', async () => {
  const repository = createRepository()
  const manager = new BotManager({
    repository,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  })
  const sent = []
  manager.sessions.set('alphawolf1', createRecord('AlphaWolf1', 25, sent))
  manager.refreshAll = async () => []

  await assert.rejects(
    manager.performAggregateSend('Collector1', '100'),
    /Insufficient aggregate balance/u
  )
  assert.deepEqual(sent, [])
})

test('disconnect reasons distinguish global rate limits from account conflicts', () => {
  assert.equal(classifyDisconnectReason('Çok hızlı giriş yapıyorsunuz, lütfen biraz bekleyin.'), 'rate_limit')
  assert.equal(classifyDisconnectReason("Bu proxy'ye zaten bağlısınız!"), 'already_connected')
  assert.equal(classifyDisconnectReason('client timed out'), 'transient')
  assert.equal(classifyDisconnectReason('You are banned'), 'permanent')
  assert.equal(
    classifyDisconnectReason('You should join using username stormshark5, not StormShark5.'),
    'canonical_username'
  )
})

test('canonical username correction accepts case-only server guidance', () => {
  const reason = 'fakeLobi: You should join using username stormshark5, not StormShark5.'
  assert.equal(extractCanonicalUsernameCorrection(reason, 'StormShark5'), 'stormshark5')
  assert.equal(extractCanonicalUsernameCorrection(reason, 'DifferentBot1'), null)
  assert.equal(
    extractCanonicalUsernameCorrection(
      'You should join using username Attacker1, not StormShark5.',
      'StormShark5'
    ),
    null
  )
})

test('replaces an account after repeated silent admission failures while peers are healthy', () => {
  const accounts = new Map()
  const original = {
    username: 'ExistingWolf7',
    password: 'old-password',
    email: 'existingwolf7@gmail.com',
    enabled: 1,
    reconnect_attempts: SILENT_REPLACEMENT_ATTEMPTS - 1,
    gems: 240
  }
  accounts.set(original.username.toLowerCase(), original)
  const repository = {
    getSetting: (_key, fallback) => fallback,
    accountExists: username => accounts.has(username.toLowerCase()),
    replaceAccount: (username, identity, reason) => {
      const previous = { ...accounts.get(username.toLowerCase()), enabled: 0, status: 'replaced' }
      accounts.set(username.toLowerCase(), previous)
      const replacement = { ...identity, enabled: 1, reconnect_attempts: 0, gems: 0 }
      accounts.set(identity.username.toLowerCase(), replacement)
      return { previous, replacement, reason }
    },
    updateRuntime: () => {},
    listAccounts: () => [...accounts.values()]
  }
  const manager = new BotManager({
    repository,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  })
  const record = manager.ensureRecord(original)
  for (let index = 0; index < 5; index += 1) {
    manager.sessions.set(`healthy${index}`, {
      account: { username: `Healthy${index}` },
      controller: { getSnapshot: () => ({ status: 'afk', afkConfirmed: true }) }
    })
  }

  assert.equal(isSilentTransportFailure('socketClosed'), true)
  manager.scheduleReconnect(record, 'socketClosed', { admissionFailure: true })

  assert.notEqual(record.account.username, original.username)
  assert.equal(record.attempts, 0)
  assert.equal(manager.connectionStatus().replacements, 1)
  assert.equal(accounts.get(original.username.toLowerCase()).enabled, 0)
  clearTimeout(record.reconnectTimer)
})

test('connection admission uses one queue and pauses after each configured batch', async () => {
  const accounts = [
    { username: 'QueueWolf1', enabled: 1, created_at: 'a', updated_at: 'b' },
    { username: 'QueueWolf2', enabled: 1, created_at: 'a', updated_at: 'b' },
    { username: 'QueueWolf3', enabled: 1, created_at: 'a', updated_at: 'b' }
  ]
  const repository = {
    getSetting: (_key, fallback) => fallback,
    selectAccounts: count => accounts.slice(0, count),
    updateRuntime: () => {},
    getAccount: username => accounts.find(account => account.username === username),
    listAccounts: () => accounts
  }
  const manager = new BotManager({
    repository,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    connectionPolicy: {
      intervalMinMs: 0,
      intervalMaxMs: 0,
      batchSize: 2,
      batchPauseMs: 1,
      admissionTimeoutMs: 100
    }
  })

  manager.loadRuntime = account => {
    const events = new EventEmitter()
    const controller = {
      events,
      getSnapshot: () => ({ username: account.username, stopping: false }),
      stop: reason => queueMicrotask(() => events.emit('end', { reason }))
    }
    queueMicrotask(() => events.emit('status', { status: 'lobby' }))
    return controller
  }

  await manager.start(3)
  const deadline = Date.now() + 1000
  while (manager.connectionStatus().admitted < 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  const status = manager.connectionStatus()
  assert.equal(status.attempts, 3)
  assert.equal(status.admitted, 3)
  assert.equal(status.batchPauses, 1)
  assert.equal(status.queued, 0)
  await manager.shutdown()
})
