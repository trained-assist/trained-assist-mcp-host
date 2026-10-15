'use strict';

const crypto = require('node:crypto');

const DEFAULT_SERVICE = 'mcp-host';

async function hashKey(key) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyKey(env, providedKey, options = {}) {
  const service = options.service || DEFAULT_SERVICE;
  const acceptedServices = options.acceptedServices || [service];
  const now = options.now || Date.now();
  if (!env.MCP_IDENTITY_DB || typeof providedKey !== 'string' || !providedKey) return null;
  const keyHash = await hashKey(providedKey);
  const row = await env.MCP_IDENTITY_DB.prepare(
    `SELECT u.user_id, u.role, u.status AS user_status, u.service AS user_service, u.email,
            k.key_hash, k.status AS key_status, k.expires_at, k.revoked_at
     FROM identity_api_keys k
     JOIN identity_users u ON u.user_id = k.user_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL`
  ).bind(keyHash).first();
  if (!row || row.user_status !== 'active' || row.key_status !== 'active') return null;
  if (!acceptedServices.includes(row.user_service)) return null;
  if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at <= now) return null;
  env.MCP_IDENTITY_DB.prepare(
    `UPDATE identity_api_keys SET last_used_at = ? WHERE key_hash = ?`
  ).bind(now, keyHash).run().catch(() => {});
  return { userId: row.user_id, role: row.role, email: row.email, service: row.user_service, keyHash: row.key_hash };
}

async function findActiveUser(env, userId) {
  if (!env.MCP_IDENTITY_DB || typeof userId !== 'string' || !userId) return null;
  const row = await env.MCP_IDENTITY_DB.prepare(
    `SELECT user_id, role, status, service, email FROM identity_users WHERE user_id = ?`
  ).bind(userId).first();
  if (!row || row.status !== 'active' || !['mcp-host', 'ladder'].includes(row.service)) return null;
  return { userId: row.user_id, role: row.role, service: row.service, email: row.email, keyHash: null };
}

async function createUser(env, { userId, email, role = 'user', service = DEFAULT_SERVICE, status = 'active' }) {
  if (!env.MCP_IDENTITY_DB) throw new Error('D1 binding MCP_IDENTITY_DB not configured');
  const now = Date.now();
  await env.MCP_IDENTITY_DB.prepare(
    `INSERT INTO identity_users (user_id, email, role, service, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(userId, email, role, service, status, now, now).run();
  return { userId, email, role, service, status };
}

async function issueApiKey(env, { userId, label, service = DEFAULT_SERVICE, expiresAt = null }) {
  if (!env.MCP_IDENTITY_DB) throw new Error('D1 binding MCP_IDENTITY_DB not configured');
  const key = crypto.randomBytes(32).toString('base64url');
  const keyHash = await hashKey(key);
  const now = Date.now();
  await env.MCP_IDENTITY_DB.prepare(
    `INSERT INTO identity_api_keys (key_hash, user_id, label, status, expires_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).bind(keyHash, userId, label, expiresAt, now).run();
  return { key, keyHash, label };
}

async function revokeApiKey(env, keyHash) {
  if (!env.MCP_IDENTITY_DB) return false;
  const result = await env.MCP_IDENTITY_DB.prepare(
    `UPDATE identity_api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL`
  ).bind(Date.now(), keyHash).run();
  return result.meta.changes > 0;
}

async function setUserStatus(env, userId, status) {
  if (!env.MCP_IDENTITY_DB) throw new Error('D1 binding MCP_IDENTITY_DB not configured');
  const now = Date.now();
  const result = await env.MCP_IDENTITY_DB.prepare(
    `UPDATE identity_users SET status = ?, updated_at = ? WHERE user_id = ?`
  ).bind(status, now, userId).run();
  return result.meta.changes > 0;
}

async function initTables() {
  // Schema lives in migrations/0001_identity.sql and 0002_identity_canonical.sql
  // (single source of truth). Applied via `wrangler d1 migrations apply` before first use.
}

module.exports = {
  hashKey,
  verifyKey,
  findActiveUser,
  createUser,
  issueApiKey,
  revokeApiKey,
  setUserStatus,
  initTables,
};
