'use strict'

const Database = require('better-sqlite3')

const databasePath = process.env.ZENIT_DATABASE_PATH
if (!databasePath) throw new Error('ZENIT_DATABASE_PATH is not configured')

const database = new Database(databasePath)
const journalMode = database.pragma('journal_mode = WAL', { simple: true })
database.exec('BEGIN IMMEDIATE; ROLLBACK')
database.close()

process.stdout.write(`Database write check passed (journal_mode=${journalMode}).\n`)
