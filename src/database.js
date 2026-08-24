'use strict'

const path = require('node:path')
const Database = require('better-sqlite3')

const DATABASE_PATH = process.env.ZENIT_DATABASE_PATH
  ? path.resolve(process.env.ZENIT_DATABASE_PATH)
  : path.join(__dirname, '..', 'zenitmc.sqlite')

class Repository {
  constructor (databasePath = DATABASE_PATH) {
    this.db = new Database(databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.migrate()
    this.prepare()
  }

  migrate () {
    this.db.exec(`
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

      CREATE TABLE IF NOT EXISTS transfer_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_username TEXT NOT NULL,
        requested_mode TEXT NOT NULL,
        requested_amount INTEGER,
        status TEXT NOT NULL,
        sent_amount INTEGER NOT NULL DEFAULT 0,
        successful_bots INTEGER NOT NULL DEFAULT 0,
        failed_bots INTEGER NOT NULL DEFAULT 0,
        skipped_bots INTEGER NOT NULL DEFAULT 0,
        requested_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_leases (
        scope TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
    `)

    this.ensureColumn('bots', 'enabled', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('bots', 'reconnect_attempts', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('bots', 'last_seen_at', 'TEXT')
    this.ensureColumn('bots', 'last_error', 'TEXT')
    this.ensureColumn('bots', 'replaced_by', 'TEXT')
    this.ensureColumn('bots', 'replaced_at', 'TEXT')
    this.ensureColumn('gem_transfers', 'batch_id', 'INTEGER')

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gem_transfers_bot_requested
      ON gem_transfers (bot_username, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gem_transfers_batch
      ON gem_transfers (batch_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_username_nocase
      ON bots (username COLLATE NOCASE);
    `)

    this.db.prepare(`
      UPDATE bots
      SET status = 'offline', updated_at = ?
      WHERE enabled = 1 AND status NOT IN ('blocked', 'disabled')
    `).run(new Date().toISOString())
    this.db.pragma('user_version = 3')
  }

  ensureColumn (table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all()
    if (columns.some(item => item.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  prepare () {
    this.selectAccountsStatement = this.db.prepare(`
      SELECT username, password, email, status, gems, gems_updated_at,
        enabled, reconnect_attempts, last_seen_at, last_error, replaced_by,
        replaced_at, created_at, updated_at
      FROM bots
      WHERE enabled = 1
      ORDER BY CASE WHEN gems > 0 THEN 0 ELSE 1 END, gems DESC, updated_at DESC
      LIMIT ?
    `)
    this.selectAccountStatement = this.db.prepare(`
      SELECT username, password, email, status, gems, gems_updated_at,
        enabled, reconnect_attempts, last_seen_at, last_error, replaced_by,
        replaced_at, created_at, updated_at
      FROM bots WHERE username = ? COLLATE NOCASE
    `)
    this.selectAllAccountsStatement = this.db.prepare(`
      SELECT username, status, gems, gems_updated_at, enabled,
        reconnect_attempts, last_seen_at, last_error, replaced_by, replaced_at,
        created_at, updated_at
      FROM bots ORDER BY enabled DESC, username COLLATE NOCASE
    `)
    this.insertAccountStatement = this.db.prepare(`
      INSERT INTO bots (
        username, password, email, status, gems, enabled,
        reconnect_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, 1, 0, ?, ?)
    `)
    this.updateRuntimeStatement = this.db.prepare(`
      UPDATE bots
      SET status = ?, reconnect_attempts = ?, last_seen_at = ?, last_error = ?, updated_at = ?
      WHERE username = ? COLLATE NOCASE
    `)
    this.batchInsertStatement = this.db.prepare(`
      INSERT INTO transfer_batches (
        target_username, requested_mode, requested_amount, status, requested_at
      ) VALUES (?, ?, ?, 'running', ?)
    `)
    this.batchCompleteStatement = this.db.prepare(`
      UPDATE transfer_batches
      SET status = ?, sent_amount = ?, successful_bots = ?, failed_bots = ?,
        skipped_bots = ?, completed_at = ?
      WHERE id = ?
    `)
    this.historyStatement = this.db.prepare(`
      SELECT id, batch_id, bot_username, target_username, amount, status,
        balance_before, balance_after, error_message, requested_at, completed_at
      FROM gem_transfers ORDER BY id DESC LIMIT ?
    `)
    this.getSettingStatement = this.db.prepare('SELECT value FROM app_settings WHERE key = ?')
    this.setSettingStatement = this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
  }

  selectAccounts (limit) { return this.selectAccountsStatement.all(limit) }
  getAccount (username) { return this.selectAccountStatement.get(username) }
  listAccounts () { return this.selectAllAccountsStatement.all() }

  accountExists (username) {
    return Boolean(this.selectAccountStatement.get(username))
  }

  insertAccount ({ username, password, email }) {
    const now = new Date().toISOString()
    this.insertAccountStatement.run(username, password, email, now, now)
    return this.getAccount(username)
  }

  canonicalizeAccountUsername (currentUsername, canonicalUsername) {
    const current = String(currentUsername)
    const canonical = String(canonicalUsername)
    if (!/^[A-Za-z0-9_]{1,16}$/u.test(canonical)) {
      throw new Error(`Invalid canonical Minecraft username "${canonical}"`)
    }
    if (current.toLowerCase() !== canonical.toLowerCase()) {
      throw new Error('Canonical username correction must only change letter casing')
    }

    const transaction = this.db.transaction(() => {
      const account = this.getAccount(current)
      if (!account) throw new Error(`Unknown account "${current}"`)
      if (account.username === canonical) return account
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE bots SET username = ?, updated_at = ?
        WHERE username = ? COLLATE NOCASE
      `).run(canonical, now, current)
      this.db.prepare(`
        UPDATE gem_transfers SET bot_username = ?
        WHERE bot_username = ? COLLATE NOCASE
      `).run(canonical, current)
      return this.getAccount(canonical)
    })
    return transaction()
  }

  replaceAccount (currentUsername, identity, reason) {
    const transaction = this.db.transaction(() => {
      const current = this.getAccount(currentUsername)
      if (!current) throw new Error(`Unknown account "${currentUsername}"`)
      if (!current.enabled) throw new Error(`Account "${current.username}" is already disabled`)
      if (this.accountExists(identity.username)) {
        throw new Error(`Replacement username "${identity.username}" already exists`)
      }

      const now = new Date().toISOString()
      this.insertAccountStatement.run(
        identity.username,
        identity.password,
        identity.email,
        now,
        now
      )
      this.db.prepare(`
        UPDATE bots
        SET enabled = 0, status = 'replaced', replaced_by = ?, replaced_at = ?,
          last_error = ?, updated_at = ?
        WHERE username = ? COLLATE NOCASE
      `).run(identity.username, now, String(reason || 'account replacement'), now, current.username)

      return {
        previous: this.getAccount(current.username),
        replacement: this.getAccount(identity.username)
      }
    })
    return transaction()
  }

  updateRuntime (username, { status, attempts = 0, error = null }) {
    const now = new Date().toISOString()
    this.updateRuntimeStatement.run(status, attempts, now, error, now, username)
  }

  createBatch (target, mode, amount) {
    return Number(this.batchInsertStatement.run(
      target,
      mode,
      amount,
      new Date().toISOString()
    ).lastInsertRowid)
  }

  attachTransferToBatch (transferId, batchId) {
    this.db.prepare('UPDATE gem_transfers SET batch_id = ? WHERE id = ?').run(batchId, transferId)
  }

  completeBatch (id, result) {
    this.batchCompleteStatement.run(
      result.status,
      result.sentAmount,
      result.successfulBots,
      result.failedBots,
      result.skippedBots,
      new Date().toISOString(),
      id
    )
  }

  history (limit = 10) { return this.historyStatement.all(limit) }

  getSetting (key, fallback = null) {
    const row = this.getSettingStatement.get(key)
    if (!row) return fallback
    try { return JSON.parse(row.value) } catch { return row.value }
  }

  setSetting (key, value) {
    this.setSettingStatement.run(key, JSON.stringify(value), new Date().toISOString())
  }

  acquireLease (instanceId, pid, staleAfterMs = 90000) {
    const now = Date.now()
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM runtime_leases WHERE scope = ?').get('manager')
      if (existing && existing.instance_id !== instanceId) {
        const age = now - Date.parse(existing.heartbeat_at)
        if (Number.isFinite(age) && age < staleAfterMs) {
          throw new Error(`Another ZenitMC manager is active with PID ${existing.pid}`)
        }
      }
      this.db.prepare(`
        INSERT INTO runtime_leases (scope, instance_id, pid, heartbeat_at)
        VALUES ('manager', ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          instance_id = excluded.instance_id,
          pid = excluded.pid,
          heartbeat_at = excluded.heartbeat_at
      `).run(instanceId, pid, new Date(now).toISOString())
    })
    transaction()
  }

  heartbeatLease (instanceId) {
    this.db.prepare(`
      UPDATE runtime_leases SET heartbeat_at = ?
      WHERE scope = 'manager' AND instance_id = ?
    `).run(new Date().toISOString(), instanceId)
  }

  releaseLease (instanceId) {
    if (!this.db.open) return
    this.db.prepare(`
      DELETE FROM runtime_leases WHERE scope = 'manager' AND instance_id = ?
    `).run(instanceId)
  }

  close () {
    if (this.db.open) this.db.close()
  }
}

module.exports = { Repository, DATABASE_PATH }
