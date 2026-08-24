'use strict'

const AFK_REWARD_INTERVAL_MS = 10 * 60 * 1000

function nextRewardRemainingMs (item, now = Date.now()) {
  if (!item?.afkConfirmed || !item.afkStartedAt) return null
  const anchor = Date.parse(item.lastRewardAt || item.afkStartedAt)
  if (!Number.isFinite(anchor)) return null
  const elapsed = Math.max(0, now - anchor)
  const completedCycles = Math.floor(elapsed / AFK_REWARD_INTERVAL_MS)
  const nextRewardAt = anchor + ((completedCycles + 1) * AFK_REWARD_INTERVAL_MS)
  return Math.max(0, nextRewardAt - now)
}

function averageRewardRemainingMs (items, now = Date.now()) {
  const countdowns = items
    .map(item => nextRewardRemainingMs(item, now))
    .filter(value => value !== null)
  if (!countdowns.length) return { average: null, tracked: 0 }
  return {
    average: Math.round(countdowns.reduce((total, value) => total + value, 0) / countdowns.length),
    tracked: countdowns.length
  }
}

module.exports = {
  AFK_REWARD_INTERVAL_MS,
  nextRewardRemainingMs,
  averageRewardRemainingMs
}
