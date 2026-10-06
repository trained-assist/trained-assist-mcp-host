'use strict';

const crypto = require('node:crypto');

const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_ID_MAX = 160;
const RUN_TOKEN_RE = /^rt_[0-9a-f]{64}$/;

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function configuredHostTokens(env = process.env) {
  return String(env.MCP_HOST_TOKEN || '').split(',').map((s) => s.trim())
    .filter((token) => /^mcp_[A-Za-z0-9_-]{32,}$/.test(token));
}

function createTokenStore({ env = process.env, now = Date.now, ttlMs = 60 * 60 * 1000, maxActiveTokens = 10_000 } = {}) {
  const issued = new Map();
  const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

  function canMint(authorization) {
    const match = /^Bearer (mcp_[A-Za-z0-9_-]+)$/.exec(String(authorization || ''));
    if (!match) return false;
    return configuredHostTokens(env).some((expected) => safeEqual(match[1], expected));
  }

  function issue({ taskId, username }) {
    const user = String(username || '');
    const task = String(taskId || '');
    if (!USERNAME_RE.test(user)) throw Object.assign(new Error('invalid username'), { code: 'INVALID_USERNAME' });
    if (!task || task.length > TASK_ID_MAX) throw Object.assign(new Error('invalid taskId'), { code: 'INVALID_TASK_ID' });
    const timestamp = now();
    if (issued.size >= maxActiveTokens) {
      for (const [key, scope] of issued) if (scope.expiresAt <= timestamp) issued.delete(key);
      if (issued.size >= maxActiveTokens) throw Object.assign(new Error('active run-token limit reached'), { code: 'TOKEN_CAPACITY' });
    }
    const token = `rt_${crypto.randomBytes(32).toString('hex')}`;
    issued.set(digest(token), { taskId: task, username: user, issuedAt: timestamp, expiresAt: timestamp + ttlMs });
    return token;
  }

  function verify(authorization) {
    const match = /^Bearer (rt_[0-9a-f]{64})$/.exec(String(authorization || ''));
    if (!match) return null;
    const key = digest(match[1]);
    const scope = issued.get(key);
    if (!scope) return null;
    if (scope.expiresAt <= now()) {
      issued.delete(key);
      return null;
    }
    return { taskId: scope.taskId, username: scope.username, issuedAt: scope.issuedAt, expiresAt: scope.expiresAt };
  }

  function revoke(authorization) {
    const match = /^Bearer (rt_[0-9a-f]{64})$/.exec(String(authorization || ''));
    if (match) issued.delete(digest(match[1]));
  }

  return { canMint, issue, verify, revoke, size: () => issued.size };
}

module.exports = { createTokenStore, USERNAME_RE, TASK_ID_MAX };
