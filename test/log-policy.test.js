'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { getLogProfile, setLogProfile, shouldLog } = require('../src/log-policy')

test('quiet logging keeps operator-critical events and all warnings visible', () => {
  setLogProfile('quiet')
  assert.equal(getLogProfile(), 'quiet')
  assert.equal(shouldLog('debug', 'minecraft.command_scheduled'), false)
  assert.equal(shouldLog('info', 'minecraft.gems_balance_updated'), false)
  assert.equal(shouldLog('info', 'minecraft.afk_ready'), true)
  assert.equal(shouldLog('warn', 'minecraft.connection_closed'), true)
})

test('log profiles can restore operational or full protocol detail', () => {
  setLogProfile('normal')
  assert.equal(shouldLog('info', 'minecraft.afk_ready'), true)
  assert.equal(shouldLog('info', 'minecraft.system_chat'), false)
  setLogProfile('debug')
  assert.equal(shouldLog('debug', 'minecraft.command_scheduled'), true)
  assert.throws(() => setLogProfile('invalid'))
})
