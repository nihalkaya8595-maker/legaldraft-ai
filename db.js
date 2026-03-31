/**
 * LegalDraft AI — Base de données
 *
 * Production : PostgreSQL via DATABASE_URL (Railway)
 * Développement local : fallback JSON si DATABASE_URL absent
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Mode détection ───────────────────────────────────────────────────────────
const USE_POSTGRES = !!process.env.DATABASE_URL;

// ── PostgreSQL (production) ──────────────────────────────────────────────────
let pool = null;

if (USE_POSTGRES) {
  const { Pool } = require('pg');
  // DATABASE_PUBLIC_URL si Postgres est dans un projet différent (réseau public)
  // DATABASE_URL si même projet (réseau privé Railway)
  const connStr = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });

  // Crée les tables si elles n'existent pas (migration automatique)
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               TEXT PRIMARY KEY,
      email            TEXT UNIQUE NOT NULL,
      password_hash    TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      free_doc_used    BOOLEAN NOT NULL DEFAULT FALSE,
      free_doc_used_at TEXT,
      free_doc_type    TEXT,
      current_plan     TEXT NOT NULL DEFAULT 'none',
      updated_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS freedoc_log (
      id        SERIAL PRIMARY KEY,
      user_id   TEXT NOT NULL,
      email     TEXT NOT NULL,
      doc_type  TEXT NOT NULL,
      used_at   TEXT NOT NULL
    );
  `).then(() => {
    console.log('✅ PostgreSQL — tables vérifiées/créées');
  }).catch(err => {
    console.error('❌ PostgreSQL migration error:', err.message);
  });
}

// ── JSON fallback (dev local) ────────────────────────────────────────────────
const USERS_FILE   = path.join(__dirname, 'legaldraft-users.json');
const FREEDOC_FILE = path.join(__dirname, 'legaldraft-freedoc.json');

function _read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function _write(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── USERS ────────────────────────────────────────────────────────────────────

async function createUser(email, passwordHash) {
  const now  = new Date().toISOString();
  const id   = crypto.randomUUID();
  const user = {
    id, email: email.toLowerCase().trim(), password_hash: passwordHash,
    created_at: now, free_doc_used: false, free_doc_used_at: null,
    free_doc_type: null, current_plan: 'none', updated_at: now,
  };

  if (USE_POSTGRES) {
    await pool.query(
      `INSERT INTO users (id,email,password_hash,created_at,free_doc_used,free_doc_used_at,free_doc_type,current_plan,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, user.email, passwordHash, now, false, null, null, 'none', now]
    );
  } else {
    const users = _read(USERS_FILE);
    users.push(user);
    _write(USERS_FILE, users);
  }
  return user;
}

async function getUserByEmail(email) {
  const emailClean = email.toLowerCase().trim();
  if (USE_POSTGRES) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [emailClean]);
    return rows[0] || null;
  }
  const users = _read(USERS_FILE);
  return users.find(u => u.email === emailClean) || null;
}

async function getUserById(id) {
  if (USE_POSTGRES) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
    return rows[0] || null;
  }
  const users = _read(USERS_FILE);
  return users.find(u => u.id === id) || null;
}

// ── FREE DOC ─────────────────────────────────────────────────────────────────

function canUseFreeDocument(user) {
  return !user.free_doc_used;
}

async function markFreeDocumentAsUsed(userId, docType) {
  const now = new Date().toISOString();

  if (USE_POSTGRES) {
    const { rows } = await pool.query(
      `UPDATE users SET free_doc_used=TRUE, free_doc_used_at=$1, free_doc_type=$2, updated_at=$3
       WHERE id=$4 RETURNING *`,
      [now, docType, now, userId]
    );
    if (!rows[0]) throw new Error('Utilisateur introuvable : ' + userId);
    await pool.query(
      'INSERT INTO freedoc_log (user_id,email,doc_type,used_at) VALUES ($1,$2,$3,$4)',
      [userId, rows[0].email, docType, now]
    );
    console.log(`📝 Free doc — ${rows[0].email} — ${docType}`);
    return rows[0];
  }

  const users = _read(USERS_FILE);
  const idx   = users.findIndex(u => u.id === userId);
  if (idx === -1) throw new Error('Utilisateur introuvable : ' + userId);
  users[idx] = { ...users[idx], free_doc_used: true, free_doc_used_at: now, free_doc_type: docType, updated_at: now };
  _write(USERS_FILE, users);
  const log = _read(FREEDOC_FILE);
  log.push({ id: log.length + 1, user_id: userId, email: users[idx].email, doc_type: docType, used_at: now });
  _write(FREEDOC_FILE, log);
  console.log(`📝 Free doc — ${users[idx].email} — ${docType}`);
  return users[idx];
}

// ── ADMIN ────────────────────────────────────────────────────────────────────

async function getAllUsers() {
  if (USE_POSTGRES) {
    const { rows } = await pool.query(
      'SELECT id,email,created_at,free_doc_used,free_doc_used_at,free_doc_type,current_plan,updated_at FROM users ORDER BY created_at DESC'
    );
    return rows;
  }
  return _read(USERS_FILE).map(u => ({
    id: u.id, email: u.email, created_at: u.created_at,
    free_doc_used: u.free_doc_used, free_doc_used_at: u.free_doc_used_at,
    free_doc_type: u.free_doc_type, current_plan: u.current_plan, updated_at: u.updated_at,
  }));
}

async function getFreeDocLog() {
  if (USE_POSTGRES) {
    const { rows } = await pool.query('SELECT * FROM freedoc_log ORDER BY id DESC');
    return rows;
  }
  return _read(FREEDOC_FILE);
}

// ── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  canUseFreeDocument,
  markFreeDocumentAsUsed,
  getAllUsers,
  getFreeDocLog,
};
