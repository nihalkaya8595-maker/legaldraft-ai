/**
 * LegalDraft AI — Base de données JSON (fichier local)
 * Production-ready pour petits volumes ; migrable vers SQLite/Postgres.
 *
 * Fichiers :
 *   legaldraft-users.json    — comptes utilisateurs
 *   legaldraft-freedoc.json  — log des documents gratuits consommés
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const USERS_FILE    = path.join(__dirname, 'legaldraft-users.json');
const FREEDOC_FILE  = path.join(__dirname, 'legaldraft-freedoc.json');

// ── Helpers lecture / écriture ───────────────────────────────────────────────

function _read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function _write(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);           // écriture atomique
}

// ── USERS ────────────────────────────────────────────────────────────────────

/**
 * Crée un nouvel utilisateur.
 * @param {string} email
 * @param {string} passwordHash  — hash bcrypt
 * @returns {object} utilisateur créé
 */
function createUser(email, passwordHash) {
  const users = _read(USERS_FILE);
  const now   = new Date().toISOString();
  const user  = {
    id:                crypto.randomUUID(),
    email:             email.toLowerCase().trim(),
    password_hash:     passwordHash,
    created_at:        now,
    free_doc_used:     false,
    free_doc_used_at:  null,
    free_doc_type:     null,
    current_plan:      'none',
    updated_at:        now,
  };
  users.push(user);
  _write(USERS_FILE, users);
  return user;
}

/**
 * Recherche un utilisateur par email (insensible à la casse).
 * @param {string} email
 * @returns {object|null}
 */
function getUserByEmail(email) {
  const users = _read(USERS_FILE);
  return users.find(u => u.email === email.toLowerCase().trim()) || null;
}

/**
 * Recherche un utilisateur par id.
 * @param {string} id
 * @returns {object|null}
 */
function getUserById(id) {
  const users = _read(USERS_FILE);
  return users.find(u => u.id === id) || null;
}

// ── FREE DOC ─────────────────────────────────────────────────────────────────

/**
 * Vérifie si l'utilisateur peut encore utiliser son document gratuit.
 * @param {object} user  — objet utilisateur complet
 * @returns {boolean}
 */
function canUseFreeDocument(user) {
  return !user.free_doc_used;
}

/**
 * Marque le document gratuit comme consommé pour cet utilisateur.
 * Met à jour le fichier users + ajoute une entrée dans le log.
 * @param {string} userId
 * @param {string} docType  — libellé du document généré
 * @returns {object} utilisateur mis à jour
 */
function markFreeDocumentAsUsed(userId, docType) {
  const users = _read(USERS_FILE);
  const now   = new Date().toISOString();

  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) throw new Error('Utilisateur introuvable : ' + userId);

  users[idx] = {
    ...users[idx],
    free_doc_used:     true,
    free_doc_used_at:  now,
    free_doc_type:     docType,
    updated_at:        now,
  };
  _write(USERS_FILE, users);

  // Log dédié (pour admin)
  const log  = _read(FREEDOC_FILE);
  log.push({
    id:       log.length + 1,
    user_id:  userId,
    email:    users[idx].email,
    doc_type: docType,
    used_at:  now,
  });
  _write(FREEDOC_FILE, log);

  console.log(`📝 Free doc — ${users[idx].email} — ${docType}`);
  return users[idx];
}

// ── ADMIN ────────────────────────────────────────────────────────────────────

/**
 * Retourne tous les utilisateurs avec leur statut free doc.
 * (route admin uniquement)
 * @returns {object[]}
 */
function getAllUsers() {
  return _read(USERS_FILE).map(u => ({
    id:               u.id,
    email:            u.email,
    created_at:       u.created_at,
    free_doc_used:    u.free_doc_used,
    free_doc_used_at: u.free_doc_used_at,
    free_doc_type:    u.free_doc_type,
    current_plan:     u.current_plan,
    updated_at:       u.updated_at,
  }));
}

/**
 * Retourne uniquement les entrées du log de documents gratuits consommés.
 * @returns {object[]}
 */
function getFreeDocLog() {
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
