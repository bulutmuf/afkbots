'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { nextRewardRemainingMs, averageRewardRemainingMs } = require('../src/afk-reward')

test('calculates the next ten-minute AFK reward from the live session anchor', () => {
  const startedAt = '2026-08-24T10:00:00.000Z'
  const now = Date.parse('2026-08-24T10:05:30.000Z')
  assert.equal(nextRewardRemainingMs({ afkConfirmed: true, afkStartedAt: startedAt }, now), 270000)
})

test('uses the latest detected reward as the next cycle anchor', () => {
  const now = Date.parse('2026-08-24T10:15:00.000Z')
  const item = {
    afkConfirmed: true,
    afkStartedAt: '2026-08-24T10:00:00.000Z',
    lastRewardAt: '2026-08-24T10:12:00.000Z'
  }
  assert.equal(nextRewardRemainingMs(item, now), 420000)
})

test('averages only live AFK reward schedules', () => {
  const now = Date.parse('2026-08-24T10:05:00.000Z')
  const result = averageRewardRemainingMs([
    { afkConfirmed: true, afkStartedAt: '2026-08-24T10:00:00.000Z' },
    { afkConfirmed: true, afkStartedAt: '2026-08-24T10:02:00.000Z' },
    { afkConfirmed: false, afkStartedAt: null }
  ], now)
  assert.deepEqual(result, { average: 360000, tracked: 2 })
})
