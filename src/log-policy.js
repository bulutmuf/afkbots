'use strict'

const PROFILES = Object.freeze(['quiet', 'normal', 'debug'])

const QUIET_INFO_EVENTS = new Set([
  'manager.starting',
  'manager.sessions_starting',
  'manager.ready',
  'manager.connection_batch_pause',
  'manager.account_username_canonicalized',
  'manager.account_replaced',
  'manager.transfer_batch_completed',
  'minecraft.afk_ready',
  'minecraft.gems_reward_detected',
  'minecraft.gems_transfer_completed',
  'minecraft.gems_transfer_unverified'
])

const NORMAL_SUPPRESSED_INFO_EVENTS = new Set([
  'application.starting',
  'application.shutdown_requested',
  'minecraft.socket_connected',
  'minecraft.login_accepted',
  'minecraft.play_state_ready',
  'minecraft.play_session_ready',
  'minecraft.world_physics_ready',
  'minecraft.system_chat',
  'minecraft.command_sending',
  'minecraft.command_sent',
  'minecraft.command_cancelled',
  'minecraft.gems_polling_scheduled',
  'minecraft.gems_polling_started',
  'minecraft.gems_balance_updated',
  'minecraft.gems_transfer_response'
])

let profile = 'quiet'

function normalizeProfile (value) {
  const normalized = String(value || '').toLowerCase()
  if (!PROFILES.includes(normalized)) {
    throw new Error(`Log profile must be one of: ${PROFILES.join(', ')}`)
  }
  return normalized
}

function setLogProfile (value) {
  profile = normalizeProfile(value)
  return profile
}

function getLogProfile () {
  return profile
}

function shouldLog (level, event) {
  if (level === 'warn' || level === 'error') return true
  if (profile === 'debug') return true
  if (level === 'debug') return false
  if (profile === 'normal') return !NORMAL_SUPPRESSED_INFO_EVENTS.has(event)
  return QUIET_INFO_EVENTS.has(event)
}

module.exports = { PROFILES, getLogProfile, setLogProfile, shouldLog }
