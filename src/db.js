'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DEFAULT_SETTINGS = {
  promotion_target: '5', // direct customers a Coach needs to become Supervisor L1
};

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      phone         TEXT    NOT NULL UNIQUE,
      email         TEXT,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK (role IN ('admin','supervisor','coach','customer')),
      level         INTEGER,
      referral_code TEXT    UNIQUE,
      sponsor_id    INTEGER REFERENCES users(id),
      status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      promoted_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_sponsor ON users(sponsor_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  return db;
}

function ensureAdmin(db, { phone, password, name = 'Administrator' }) {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  if (existing) return false;
  db.prepare(
    "INSERT INTO users (name, phone, password_hash, role) VALUES (?, ?, ?, 'admin')"
  ).run(name, phone, bcrypt.hashSync(password, 10));
  return true;
}

module.exports = { openDb, ensureAdmin };
