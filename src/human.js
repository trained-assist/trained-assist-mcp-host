'use strict';

const crypto = require('node:crypto');
const { createGoogleDocsProvider } = require('./google-docs');
const { findActiveUser } = require('./identity');
const { TOOL_NAMES, walletProfileFor } = require('./zerocreds-wallet');

const HUMAN_SERVICE = 'mcp-host';
const HUMAN_AUDIENCE = 'trained-assist:mcp:user';
const AGENT_ISSUER = 'trained-assist-agent-runner';
const AGENT_SERVER = 'mem-gpt';
const AGENT_BINDING = 'mem-gpt-user-sandbox';
const AGENT_SCOPE = 'mcp:user-agent-run';
const AGENT_POLICY = 'mem-gpt-user-run-v1';
const DEFAULT_USER_CATALOGUE = 'mem-gpt-user-catalogue-v2';
const MAX_AGENT_GRANT_SECONDS = 2 * 60 * 60;

function humanToolsForRole(_role, walletAuthorized = false) {
  // The product user catalog contains only real user capabilities. Test fixtures
  // are served by worker.mjs and must never leak into this user-facing gateway.
  return ['identity.whoami', 'google_docs.connect', 'google_docs.get_document', ...(walletAuthorized ? TOOL_NAMES : [])];
}

function makeTrace(identity, toolName, nonce) {
  return {
    traceId: crypto.randomUUID(),
    tool: toolName,
    userId: identity.userId,
    service: identity.service,
    keyHash: identity.keyHash,
    nonce: nonce || null,
    observedAt: new Date().toISOString(),
  };
}

function createHumanProvider(env) {
  const googleProvider = createGoogleDocsProvider(env);
  return {
    id: 'identity-human',
    version: '1.1.0',
    tools: [
      {
        name: 'identity.whoami',
        description: 'Returns the caller identity and permissions.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        requiredBindings: [],
        providerId: 'identity-human',
handler: async (args, context) => {
          const trace = makeTrace(context.identity, 'identity.whoami');
          return {
            userId: context.identity.userId,
            role: context.identity.role,
            email: context.identity.email,
            service: context.identity.service,
            trace,
          };
        },
      },
      ...googleProvider.tools,
    ],
  };
}

function humanScope(identity, catalogDigest, walletProfile = null) {
  const now = Date.now();
  return {
    profileId: `user:${identity.userId}:default`,
    taskId: `user:${identity.userId}`,
    generation: 1,
    principalId: `user:${identity.userId}`,
    bindingRef: `user:${identity.userId}`,
    policyVersion: 'mcp-human-policy-v1',
    registryDigest: catalogDigest,
    identity: {
      userId: identity.userId,
      role: identity.role,
      email: identity.email,
      service: identity.service,
      keyHash: identity.keyHash,
      ...(walletProfile && { walletProfile }),
    },
    allowedTools: humanToolsForRole(identity.role, Boolean(walletProfile)),
    audience: HUMAN_AUDIENCE,
    operationId: 'user',
    expiresAt: now + 15 * 60 * 1000,
  };
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function verifyAgentRunScope({ authorization, headers, env, catalogDigest, now = Date.now() }) {
  if (!headers || typeof headers.get !== 'function') return null;
  const token = /^Bearer ([^\s]+)$/.exec(String(authorization || ''))?.[1];
  const serviceToken = env.MCP_RUNNER_AUTH_TOKEN;
  const proof = headers?.get?.('x-mcp-run-binding');
  const publicJwkText = env.MCP_RUNNER_PUBLIC_JWK;
  if (!constantTimeEqual(token, serviceToken) || typeof proof !== 'string' || proof.length > 8192
      || typeof publicJwkText !== 'string' || !publicJwkText) return null;

  let header;
  let claims;
  let publicJwk;
  let signature;
  const parts = proof.split('.');
  if (parts.length !== 3) return null;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    publicJwk = JSON.parse(publicJwkText);
    signature = Buffer.from(parts[2], 'base64url');
  } catch { return null; }
  if (header?.alg !== 'EdDSA' || header?.typ !== 'JWT' || publicJwk?.kty !== 'OKP' || publicJwk?.crv !== 'Ed25519'
      || typeof publicJwk?.x !== 'string' || publicJwk.d !== undefined || signature.length !== 64) return null;
  let validSignature = false;
  try {
    const key = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
    validSignature = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature);
  } catch { return null; }
  if (!validSignature) return null;

  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const nowSeconds = Math.floor(now / 1000);
  const expectedVersion = env.MCP_USER_CATALOGUE_VERSION || DEFAULT_USER_CATALOGUE;
  const userTaskId = headers.get('x-mcp-user-task-id');
  const profileId = headers.get('x-mcp-profile');
  const runId = headers.get('x-mcp-run-id');
  if (claims.iss !== AGENT_ISSUER || claims.aud !== HUMAN_AUDIENCE || claims.serverId !== AGENT_SERVER
      || claims.bindingRef !== AGENT_BINDING || claims.scope !== AGENT_SCOPE || claims.policyVersion !== AGENT_POLICY
      || claims.catalogueVersion !== expectedVersion || claims.catalogueDigest !== catalogDigest
      || claims.sub !== claims.runId || claims.runId !== runId || claims.userTaskId !== userTaskId || claims.profileId !== profileId
      || typeof claims.userId !== 'string' || !claims.userId || typeof claims.runId !== 'string' || !claims.runId
      || typeof claims.userTaskId !== 'string' || !claims.userTaskId || typeof claims.profileId !== 'string' || !claims.profileId
      || !Number.isSafeInteger(claims.ownerGeneration) || claims.ownerGeneration < 1
      || !Array.isArray(claims.allowedTools) || !claims.allowedTools.length || new Set(claims.allowedTools).size !== claims.allowedTools.length
      || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt > nowSeconds + 60
      || expiresAt <= nowSeconds || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_AGENT_GRANT_SECONDS
      || headers.get('x-mcp-operation') !== 'invocation' || headers.get('x-mcp-scope') !== AGENT_SCOPE) return null;

  let identity = await findActiveUser(env, claims.userId);
  if (!identity || (identity.sandboxProfileId && identity.sandboxProfileId !== claims.profileId)) return null;
  if (identity.service === 'mcp-sandbox-agent') {
    identity = { ...identity, walletProfile: await walletProfileFor(env, identity) };
    if (!identity.walletProfile) return null;
  }
  if (claims.allowedTools.some(name => typeof name !== 'string' || !humanToolsForRole('user', !!identity.walletProfile).includes(name))) return null;
  return {
    profileId: claims.profileId,
    taskId: claims.userTaskId,
    generation: claims.ownerGeneration,
    principalId: `user:${identity.userId}`,
    runId: claims.runId,
    bindingRef: AGENT_BINDING,
    policyVersion: AGENT_POLICY,
    registryDigest: catalogDigest,
    identity,
    allowedTools: claims.allowedTools,
    audience: HUMAN_AUDIENCE,
    operationId: 'agent-run',
    expiresAt: expiresAt * 1000,
  };
}

module.exports = {
  humanToolsForRole,
  createHumanProvider,
  humanScope,
  verifyAgentRunScope,
  makeTrace,
  HUMAN_SERVICE,
  HUMAN_AUDIENCE,
  AGENT_ISSUER,
  AGENT_SERVER,
  AGENT_BINDING,
  AGENT_SCOPE,
  AGENT_POLICY,
  DEFAULT_USER_CATALOGUE,
};
