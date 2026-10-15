import hostModule from './index.js';
import identityModule from './identity.js';
import proofContract from '../contracts/runner-mcp-proof/v1/contract.cjs';

const { createHost } = hostModule;
const { initTables, createUser, issueApiKey, revokeApiKey, verifyKey } = identityModule;
const serverId = proofContract.testTool.serverId;
const toolName = proofContract.testTool.tool;
const audience = proofContract.proof.audience;
const profileId = proofContract.testTool.profileId;
const bindingRef = proofContract.testTool.bindingRef;
const policyVersion = proofContract.testTool.policyVersion;
const catalogueVersion = proofContract.testTool.catalogueVersion;
const executionScope = proofContract.testTool.scope;
const fixtureMarker = proofContract.testTool.marker;
const runIdPatterns = proofContract.runId.patterns.map((pattern) => new RegExp(pattern));
const required = [
  'MCP_TEST_AUTH_TOKEN',
  'MCP_TEST_PRINCIPAL_ID',
  'MCP_TEST_EXPIRES_AT',
  'MCP_TEST_RUNNER_PUBLIC_JWK',
  'MCP_TEST_CATALOGUE_VERSION',
];

let cachedEnv;
let cachedHost;

async function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length !== expected.length) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function configured(env) {
  if (!required.every((key) => typeof env[key] === 'string' && env[key].trim())) return false;
  try {
    const validPublicJwk = (value) => {
      const jwk = JSON.parse(value);
      return jwk && jwk.kty === 'OKP' && jwk.crv === 'Ed25519'
        && typeof jwk.x === 'string' && jwk.x && !Object.hasOwn(jwk, 'd')
        && !Object.keys(jwk).some((key) => !['kty', 'crv', 'x', 'use', 'key_ops', 'alg', 'ext'].includes(key));
    };
    if (!validPublicJwk(env.MCP_TEST_RUNNER_PUBLIC_JWK)) return false;
    if (env.MCP_TEST_E2E_ENABLED === 'true'
        && (!validPublicJwk(env.MCP_TEST_E2E_PUBLIC_JWK)
          || JSON.parse(env.MCP_TEST_E2E_PUBLIC_JWK).x === JSON.parse(env.MCP_TEST_RUNNER_PUBLIC_JWK).x)) return false;
  } catch { return false; }
  return Number.isFinite(Date.parse(env.MCP_TEST_EXPIRES_AT))
    && env.MCP_TEST_CATALOGUE_VERSION === catalogueVersion
    && Number.isSafeInteger(Number(env.MCP_TEST_GENERATION || 1))
    && Number(env.MCP_TEST_GENERATION || 1) > 0;
}

function decodePart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('malformed base64url');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), (char) => char.charCodeAt(0));
}

async function verifyRunBinding(token, env, expected) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    const expectedHeaderKeys = Object.keys(proofContract.proof.header).sort();
    if (!header || Object.keys(header).sort().join(',') !== expectedHeaderKeys.join(',')
        || Object.entries(proofContract.proof.header).some(([key, value]) => header[key] !== value)) return null;
    const expectedClaims = [...proofContract.proof.requiredClaims].sort();
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)
        || Object.keys(claims).sort().join(',') !== expectedClaims.join(',')) return null;
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = decodePart(parts[2]);
    const verificationKeys = [env.MCP_TEST_RUNNER_PUBLIC_JWK];
    if (env.MCP_TEST_E2E_ENABLED === 'true') verificationKeys.push(env.MCP_TEST_E2E_PUBLIC_JWK);
    let valid = false;
    for (const jwk of verificationKeys) {
      const key = await crypto.subtle.importKey('jwk', JSON.parse(jwk), { name: 'Ed25519' }, false, ['verify']);
      if (await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, signingInput)) {
        valid = true;
        break;
      }
    }
    if (!valid) return null;
    const now = Math.floor(Date.now() / 1000);
    const identityBindings = proofContract.proof.bindings;
    if (claims.iss !== proofContract.proof.issuer || claims.aud !== audience
        || claims[identityBindings.runIdClaim] !== expected.runId
        || claims[identityBindings.subjectClaim] !== expected.runId
        || claims[identityBindings.taskIdClaim] !== expected.taskId || claims.profileId !== profileId
        || claims.principalId !== env.MCP_TEST_PRINCIPAL_ID || claims.serverId !== serverId
        || claims.bindingRef !== bindingRef || !Array.isArray(claims.allowedTools)
        || claims.allowedTools.length !== 1 || claims.allowedTools[0] !== toolName
        || claims.scope !== expected.scope
        || claims.policyVersion !== policyVersion || claims.catalogueVersion !== catalogueVersion
        || claims.registryDigest !== expected.registryDigest
        || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
        || claims.iat > now + 30 || claims.exp <= now || claims.exp <= claims.iat
        || claims.exp - claims.iat > proofContract.proof.maxLifetimeSeconds
        || claims.exp > Math.floor(Date.parse(env.MCP_TEST_EXPIRES_AT) / 1000)) return null;
    return claims;
  } catch { return null; }
}

export const machineProvider = {
  id: 'registry-fixture',
  version: '1.0.0-test',
  tools: [{
    name: toolName,
    description: 'Read the pinned marker from the Registry MCP test fixture.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiredBindings: [bindingRef],
    handler: async (_args, run) => {
      if (run.profileId !== profileId || run.bindings[bindingRef] !== fixtureMarker) {
        throw new Error('Test profile binding mismatch');
      }
      return { marker: fixtureMarker, profileId: run.profileId, taskId: run.taskId, runId: run.runId };
    },
  }],
};

function hostFor(env) {
  if (cachedHost && cachedEnv === env) return cachedHost;
  cachedHost = createHost({
    providers: [machineProvider],
    audience,
    authenticate: async ({ authorization, headers, method }) => {
      const match = /^Bearer ([^\s]+)$/.exec(String(authorization || ''));
      if (!match || !await sameSecret(match[1], env.MCP_TEST_AUTH_TOKEN)) return null;
      const taskId = headers?.get?.(proofContract.transport.taskIdHeader) || '';
      const requestProfileId = headers?.get?.('x-mcp-profile') || '';
      const requestedOperation = headers?.get?.(proofContract.transport.operationHeader) || '';
      const generation = Number(env.MCP_TEST_GENERATION || 1);
      if (!taskId || taskId.length > 200 || requestProfileId !== profileId) return null;
      let runId;
      let proofExpiry;
      if (requestedOperation === 'discovery') {
        if (headers?.get?.(proofContract.transport.runIdHeader) || headers?.get?.(proofContract.transport.proofHeader)
            || headers?.get?.(proofContract.transport.scopeHeader)) return null;
        const requestGeneration = Number(headers?.get?.('x-mcp-generation'));
        const requestPrincipalId = headers?.get?.('x-mcp-principal-id') || '';
        if (method !== 'tools/list' || requestGeneration !== generation || requestPrincipalId !== env.MCP_TEST_PRINCIPAL_ID) return null;
        runId = undefined;
      } else {
        if (requestedOperation !== proofContract.transport.operationValue
            || headers?.get?.(proofContract.transport.scopeHeader) !== executionScope) return null;
        runId = headers?.get?.(proofContract.transport.runIdHeader) || '';
        // VM runs use UUIDs; the sandbox Runner API uses a task hash and
        // attempt ID. Both remain bound to the signed proof below.
        if (runId.length < proofContract.runId.minLength || runId.length > proofContract.runId.maxLength
            || !runIdPatterns.some((pattern) => pattern.exec(runId)?.[0] === runId)) return null;
        if (method !== 'tools/call' && method !== 'tools/list') return null;
        const catalogue = cachedHost?.catalog.digest;
        if (!catalogue) return null;
        const proof = await verifyRunBinding(headers?.get?.(proofContract.transport.proofHeader), env, { runId, taskId, scope: executionScope, registryDigest: catalogue });
        if (!proof) return null;
        proofExpiry = proof.exp * 1000;
      }
      return {
        taskId,
        generation,
        profileId,
        principalId: env.MCP_TEST_PRINCIPAL_ID,
        runId,
        operationId: requestedOperation === 'discovery' ? 'discovery' : 'invocation',
        bindingRef,
        allowedTools: [toolName],
        policyVersion,
        registryDigest: cachedHost?.catalog.digest,
        expiresAt: requestedOperation === 'discovery'
          ? Date.parse(env.MCP_TEST_EXPIRES_AT)
          : Math.min(proofExpiry, Date.parse(env.MCP_TEST_EXPIRES_AT)),
        audience,
      };
    },
    resolveBindings: async ({ context, required: requested }) => {
      if (context.profileId !== profileId || context.bindingRef !== bindingRef
          || requested.length !== 1 || requested[0] !== bindingRef) return {};
      return { [bindingRef]: fixtureMarker };
    },
  });
  cachedEnv = env;
  // I00.a.1: Initialize D1 identity tables when D1 binding is present
  initTables();

  return cachedHost;
}

// I00.a.1: Export identity management functions for CLI/admin
// These are used by account provisioning (I01.a/I01.b)
export { initTables, createUser, issueApiKey, revokeApiKey, verifyKey };

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('not found', { status: 404 });
    if (!configured(env)) return new Response('test MCP binding is not configured', { status: 503 });
    return hostFor(env).fetchHandler(request);
  },
};
