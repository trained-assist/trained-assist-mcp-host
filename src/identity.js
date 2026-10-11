'use strict';

const crypto = require('node:crypto');

async function hashKey(key) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyKey(env, providedKey) {
  if (!env.MCP_IDENTITY_DB || typeof providedKey !== 'string' || !providedKey) return null;
  const keyHash = await hashKey(providedKey);
  const row = await env.MCP_IDENTITY_DB.prepare(
    `SELECT u.user_id, u.role, u.disabled, u.email
     FROM identity_api_keys k
     JOIN identity_users u ON u.user_id = k.user_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL`
  ).bind(keyHash).first();
  if (!row || row.disabled === 1) return null;
  return { userId: row.user_id, role: row.role, email: row.email };
}

async function createUser(env, { userId, email, role = 'user' }) {
  if (!env.MCP_IDENTITY_DB) throw new Error('D1 binding MCP_IDENTITY_DB not configured');
  const now = Date.now();
  await env.MCP_IDENTITY_DB.prepare(
    `INSERT INTO identity_users (user_id, email, role, disabled, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).bind(userId, email, role, now, now).run();
  return { userId, email, role };
}

async function issueApiKey(env, { userId, label }) {
  if (!env.MCP_IDENTITY_DB) throw new Error('D1 binding MCP_IDENTITY_DB not configured');
  const key = crypto.randomBytes(32).toString('base64url');
  const keyHash = await hashKey(key);
  const now = Date.now();
  await env.MCP_IDENTITY_DB.prepare(
    `INSERT INTO identity_api_keys (key_hash, user_id, label, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(keyHash, userId, label, now).run();
  return { key, keyHash, label };
}

async function revokeApiKey(env, keyHash) {
  if (!env.MCP_IDENTITY_DB) return false;
  const result = await env.MCP_IDENTITY_DB.prepare(
    `UPDATE identity_api_keys SET revoked_at = ? WHERE key_hash = ?`
  ).bind(Date.now(), keyHash).run();
  return result.meta.changes > 0;
}

async function initTables() {
  // Schema lives in migrations/0001_identity.sql (single source of truth).
  // Applied via `wrangler d1 migrations apply` before first use.
}

module.exports = {
  hashKey,
  verifyKey,
  createUser,
  issueApiKey,
  revokeApiKey,
  initTables,
};