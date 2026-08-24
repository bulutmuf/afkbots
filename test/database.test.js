'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Repository } = require('../src/database')

test('migrates account schema and enforces a manager lease', () => {
  const databasePath = path.join(os.tmpdir(), `zenitmc-test-${crypto.randomUUID()}.sqlite`)
  const first = new Repository(databasePath)
  const second = new Repository(databasePath)
  try {
    const identity = {
      username: 'TestWolf42',
      password: 'test-password',
      email: 'testwolf42@gmail.com'
    }
    first.insertAccount(identity)
    assert.equal(first.getAccount(identity.username).enabled, 1)

    first.db.prepare(`
      INSERT INTO gem_transfers (
        bot_username, target_username, amount, status, requested_at
      ) VALUES (?, 'Collector1', 120, 'success', ?)
    `).run(identity.username, new Date().toISOString())
    const canonical = first.canonicalizeAccountUsername(identity.username, 'testwolf42')
    assert.equal(canonical.username, 'testwolf42')
    assert.equal(first.getAccount('TestWolf42').username, 'testwolf42')
    assert.equal(first.history(1)[0].bot_username, 'testwolf42')
    assert.throws(
      () => first.canonicalizeAccountUsername('testwolf42', 'DifferentWolf42'),
      /must only change letter casing/u
    )

    first.db.prepare(`
      UPDATE bots SET gems = 360 WHERE username = 'testwolf42' COLLATE NOCASE
    `).run()
    const replacementIdentity = {
      username: 'FreshOtter73',
      password: 'replacement-password',
      email: 'freshotter73@gmail.com'
    }
    const replaced = first.replaceAccount(
      'testwolf42',
      replacementIdentity,
      'server username collision'
    )
    assert.equal(replaced.previous.enabled, 0)
    assert.equal(replaced.previous.status, 'replaced')
    assert.equal(replaced.previous.gems, 360)
    assert.equal(replaced.previous.replaced_by, replacementIdentity.username)
    assert.equal(replaced.replacement.enabled, 1)
    assert.equal(replaced.replacement.username, replacementIdentity.username)
    assert.deepEqual(
      first.selectAccounts(10).map(account => account.username),
      [replacementIdentity.username]
    )
    assert.equal(first.history(1)[0].bot_username, 'testwolf42')

    first.acquireLease('first-instance', 1001)
    assert.throws(
      () => second.acquireLease('second-instance', 1002),
      /Another ZenitMC manager is active/u
    )
    first.releaseLease('first-instance')
    second.acquireLease('second-instance', 1002)
    second.releaseLease('second-instance')
  } finally {
    first.close()
    second.close()
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${databasePath}${suffix}`, { force: true })
    }
  }
})
