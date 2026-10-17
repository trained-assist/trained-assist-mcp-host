'use strict';

const crypto = require('node:crypto');
const { createWalletProvider, API_OPERATIONS, bindingForOperation } = require('@zerocreds/mcp-provider');

const WALLET_AUDIENCE = 'zerocreds-wallet:human';
const MAX_ASSERTION_SECONDS = 300;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TOOL_NAMES = Object.keys(API_OPERATIONS);

function walletProviderConfigured(env) {
  if (typeof env?.ZEROCREDS_WALLET_API_URL !== 'string'
      || typeof env?.ZEROCREDS_WALLET_ISSUER !== 'string'
      || typeof env?.ZEROCREDS_WALLET_KEY_ID !== 'string'
      || typeof env?.ZEROCREDS_WALLET_SIGNING_KEY !== 'string'
      || !env?.ZEROCREDS_WALLET_PROFILES
      || typeof env.ZEROCREDS_WALLET_PROFILES.get !== 'function') return false;
  try {
    const url = new URL(env.ZEROCREDS_WALLET_API_URL);
    const jwk = JSON.parse(env.ZEROCREDS_WALLET_SIGNING_KEY);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && env.ZEROCREDS_WALLET_ISSUER.length <= 200
      && /^[A-Za-z0-9._-]{1,100}$/.test(env.ZEROCREDS_WALLET_KEY_ID)
      && jwk?.kty === 'OKP' && jwk?.crv === 'Ed25519' && typeof jwk?.d === 'string' && typeof jwk?.x === 'string';
  } catch { return false; }
}

async function walletProfileFor(env, identity) {
  if (!walletProviderConfigured(env) || !['mcp-host', 'mcp-sandbox-agent'].includes(identity?.service) || !identity?.userId) return null;
  let value;
  try { value = await env.ZEROCREDS_WALLET_PROFILES.get(String(identity.userId), { type: 'json' }); }
  catch { return null; }
  if (!value || !ID.test(value.owner_id || '') || !ID.test(value.profile_id || '')) return null;
  return Object.freeze({ ownerId: value.owner_id, profileId: value.profile_id });
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }

async function signWalletAssertion(env, profile, operation, now = Date.now) {
  const key = JSON.parse(env.ZEROCREDS_WALLET_SIGNING_KEY);
  const signingKey = await crypto.subtle.importKey('jwk', key, { name: 'Ed25519' }, false, ['sign']);
  const issuedAt = Math.floor(now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: env.ZEROCREDS_WALLET_KEY_ID };
  const claims = {
    iss: env.ZEROCREDS_WALLET_ISSUER,
    aud: WALLET_AUDIENCE,
    owner_id: profile.ownerId,
    profile_id: profile.profileId,
    caller_class: 'human',
    operations: [operation],
    iat: issuedAt,
    exp: issuedAt + MAX_ASSERTION_SECONDS,
    jti: crypto.randomUUID(),
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign('Ed25519', signingKey, Buffer.from(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}

async function resolveWalletBindings({ env, context, required, now = Date.now }) {
  const profile = context?.identity?.walletProfile;
  if (!profile || !walletProviderConfigured(env)) throw new Error('ZeroCreds wallet authorization is unavailable');
  const bindings = {};
  for (const binding of required) {
    const operation = Object.entries(API_OPERATIONS).find(([name]) => binding === bindingForOperation(API_OPERATIONS[name]))?.[1];
    if (!operation) throw new Error('ZeroCreds wallet authorization is unavailable');
    bindings[binding] = await signWalletAssertion(env, profile, operation, now);
  }
  return bindings;
}

function createZeroCredsWalletProvider(env, fetchImpl) {
  return createWalletProvider({ baseUrl: env?.ZEROCREDS_WALLET_API_URL, ...(fetchImpl && { fetchImpl }) });
}

module.exports = {
  WALLET_AUDIENCE,
  TOOL_NAMES,
  createZeroCredsWalletProvider,
  walletProviderConfigured,
  walletProfileFor,
  signWalletAssertion,
  resolveWalletBindings,
};
