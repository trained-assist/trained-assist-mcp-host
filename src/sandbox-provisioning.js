'use strict';

const crypto = require('node:crypto');
const { setUserStatus } = require('./identity');

const MAX_LEASE_MS = 6 * 60 * 60 * 1000;
const RUN_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|run_[0-9a-f]{64}_[0-9a-f]{24})$/i;
const WALLET_ID = /^[A-Za-z0-9_-]{1,100}$/;

function sandboxIdentity(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('invalid_sandbox_run_id');
  const compact = crypto.createHash('sha256').update(runId.toLowerCase()).digest('hex').slice(0, 32);
  return { userId: `sbx-${compact}`, profileId: `sbx_${compact}`, email: `sandbox-${compact}@sandbox.invalid` };
}

async function provisionSandboxUser(env, { runId, expiresAt, now = Date.now() }) {
  if (env.MCP_SANDBOX_PROVISIONING_ENABLED !== 'true') throw new Error('sandbox_provisioning_disabled');
  if (!env.MCP_IDENTITY_DB || !env.ZEROCREDS_WALLET_PROFILES
      || typeof env.ZEROCREDS_WALLET_PROFILES.put !== 'function') throw new Error('sandbox_provisioning_unavailable');
  const ownerId = env.MCP_SANDBOX_WALLET_OWNER_ID;
  if (!WALLET_ID.test(ownerId || '')) throw new Error('sandbox_wallet_owner_unconfigured');
  const identity = sandboxIdentity(runId);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now + 60_000 || expiresAt > now + MAX_LEASE_MS) {
    throw new Error('invalid_sandbox_lease');
  }
  const existing = await env.MCP_IDENTITY_DB.prepare(
    'SELECT run_id, user_id, profile_id, expires_at, revoked_at FROM mcp_sandbox_users WHERE run_id = ?'
  ).bind(runId.toLowerCase()).first();
  const created = !existing;
  if (existing) {
    if (existing.user_id !== identity.userId || existing.profile_id !== identity.profileId
        || existing.expires_at !== expiresAt || existing.revoked_at !== null) throw new Error('sandbox_run_identity_conflict');
  } else {
    const createdAt = now;
    await env.MCP_IDENTITY_DB.prepare(
      `INSERT OR IGNORE INTO identity_users (user_id, email, role, service, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'mcp-sandbox-agent', 'active', ?, ?)`
    ).bind(identity.userId, identity.email, createdAt, createdAt).run();
    await env.MCP_IDENTITY_DB.prepare(
      'INSERT OR IGNORE INTO mcp_sandbox_users (run_id, user_id, profile_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(runId.toLowerCase(), identity.userId, identity.profileId, expiresAt, createdAt).run();
    const persisted = await env.MCP_IDENTITY_DB.prepare(
      'SELECT user_id, profile_id, expires_at, revoked_at FROM mcp_sandbox_users WHERE run_id = ?'
    ).bind(runId.toLowerCase()).first();
    if (!persisted || persisted.user_id !== identity.userId || persisted.profile_id !== identity.profileId
        || persisted.expires_at !== expiresAt || persisted.revoked_at !== null) throw new Error('sandbox_run_identity_conflict');
  }
  const remainingSeconds = Math.ceil((expiresAt - now) / 1000);
  try {
    await env.ZEROCREDS_WALLET_PROFILES.put(identity.userId,
      JSON.stringify({ owner_id: ownerId, profile_id: identity.profileId }), { expirationTtl: remainingSeconds });
  } catch (error) {
    await env.MCP_IDENTITY_DB.prepare('UPDATE mcp_sandbox_users SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL')
      .bind(now, runId.toLowerCase()).run().catch(() => {});
    await setUserStatus(env, identity.userId, 'disabled').catch(() => {});
    throw new Error('sandbox_wallet_mapping_failed', { cause: error });
  }
  return { ...identity, expiresAt, created };
}

async function revokeSandboxUser(env, runId, { now = Date.now() } = {}) {
  if (!env.MCP_IDENTITY_DB || !env.ZEROCREDS_WALLET_PROFILES) throw new Error('sandbox_provisioning_unavailable');
  const identity = sandboxIdentity(runId);
  const lease = await env.MCP_IDENTITY_DB.prepare(
    'SELECT user_id, revoked_at FROM mcp_sandbox_users WHERE run_id = ?'
  ).bind(runId.toLowerCase()).first();
  if (!lease) return { revoked: false, reason: 'not_found' };
  const alreadyRevoked = lease.revoked_at !== null;
  await env.MCP_IDENTITY_DB.prepare('UPDATE mcp_sandbox_users SET revoked_at = COALESCE(revoked_at, ?) WHERE run_id = ?')
    .bind(now, runId.toLowerCase()).run();
  await setUserStatus(env, lease.user_id, 'disabled');
  await env.ZEROCREDS_WALLET_PROFILES.delete(lease.user_id);
  return alreadyRevoked ? { revoked: false, reason: 'already_revoked' } : { revoked: true, userId: identity.userId };
}

async function authorizeProvisioning(request, env) {
  const actual = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') || '')?.[1];
  const expected = env.MCP_SANDBOX_PROVISION_TOKEN;
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length < 32 || actual.length !== expected.length) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return crypto.timingSafeEqual(left, right);
}

module.exports = { MAX_LEASE_MS, sandboxIdentity, provisionSandboxUser, revokeSandboxUser, authorizeProvisioning };
