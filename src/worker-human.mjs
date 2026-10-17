import hostModule from './index.js';
import identityModule from './identity.js';
import humanModule from './human.js';
import googleDocsModule from './google-docs.js';
import walletModule from './zerocreds-wallet.js';
import sandboxProvisioningModule from './sandbox-provisioning.js';

const { createHost } = hostModule;
const { initTables, createUser, issueApiKey, revokeApiKey, verifyKey, setUserStatus } = identityModule;
const { createHumanProvider, humanScope, verifyAgentRunScope, HUMAN_SERVICE, HUMAN_AUDIENCE } = humanModule;
const { finishGoogleAuthorization } = googleDocsModule;
const { createZeroCredsWalletProvider, walletProfileFor, resolveWalletBindings } = walletModule;
const { provisionSandboxUser, revokeSandboxUser, authorizeProvisioning } = sandboxProvisioningModule;

const audience = HUMAN_AUDIENCE;

let cachedHumanHost = null;

function humanHostFor(env) {
  if (cachedHumanHost && cachedHumanHost.env === env) return cachedHumanHost.host;
  const walletFetch = env.ZEROCREDS_WALLET_API_SERVICE?.fetch
    ? async (input, init) => {
      try {
        return await env.ZEROCREDS_WALLET_API_SERVICE.fetch(new Request(input, { ...init, redirect: 'manual' }));
      }
      catch (error) {
        console.error('[wallet] internal API request failed', error?.name || 'Error', error?.message || 'unknown');
        throw error;
      }
    }
    : undefined;
  const host = createHost({
    providers: [createHumanProvider(env), createZeroCredsWalletProvider(env, walletFetch)],
    audience,
    resolveBindings: async ({ context, providerId, required }) => {
      if (providerId !== 'zerocreds-wallet') return {};
      return resolveWalletBindings({ env, context, required });
    },
    authenticate: async ({ authorization, headers }) => {
      const match = /^Bearer ([^\s]+)$/.exec(String(authorization || ''));
      if (!match) return null;
      const human = await verifyKey(env, match[1], { acceptedServices: [HUMAN_SERVICE, 'ladder'] });
      if (human) return humanScope(human, host.catalog.digest, await walletProfileFor(env, human));
      return verifyAgentRunScope({ authorization, headers, env, catalogDigest: host.catalog.digest });
    },
  });
  cachedHumanHost = { host, env };
  initTables();
  return host;
}

export { initTables, createUser, issueApiKey, revokeApiKey, verifyKey, setUserStatus };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/sandbox/users' || url.pathname === '/internal/sandbox/users/revoke') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
      if (env.MCP_SANDBOX_PROVISIONING_ENABLED !== 'true' || !await authorizeProvisioning(request, env)) {
        return Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401, headers: { 'cache-control': 'no-store' } });
      }
      const rawBody = await request.text();
      if (Buffer.byteLength(rawBody, 'utf8') > 4096) return Response.json({ error: { code: 'REQUEST_TOO_LARGE' } }, { status: 413 });
      let body;
      try { body = JSON.parse(rawBody); } catch { return Response.json({ error: { code: 'INVALID_JSON' } }, { status: 400 }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: { code: 'INVALID_REQUEST' } }, { status: 400 });
      try {
        if (url.pathname.endsWith('/revoke')) {
          if (Object.keys(body).sort().join(',') !== 'runId') return Response.json({ error: { code: 'INVALID_REQUEST' } }, { status: 400 });
          const result = await revokeSandboxUser(env, body.runId);
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (Object.keys(body).sort().join(',') !== 'expiresAt,runId') return Response.json({ error: { code: 'INVALID_REQUEST' } }, { status: 400 });
        const result = await provisionSandboxUser(env, body);
        return Response.json(result, { status: result.created ? 201 : 200, headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        const code = error?.message === 'invalid_sandbox_run_id' || error?.message === 'invalid_sandbox_lease' ? error.message
          : error?.message === 'sandbox_run_identity_conflict' ? error.message
          : error?.message === 'sandbox_provisioning_disabled' ? error.message : 'SANDBOX_PROVISIONING_FAILED';
        const status = code === 'sandbox_run_identity_conflict' ? 409 : code === 'invalid_sandbox_run_id' || code === 'invalid_sandbox_lease' ? 400 : 503;
        return Response.json({ error: { code } }, { status, headers: { 'cache-control': 'no-store' } });
      }
    }
    if (url.pathname === '/oauth/google/callback' && request.method === 'GET') {
      if (!configured(env)) return new Response('human MCP binding is not configured', { status: 503 });
      return finishGoogleAuthorization(env, url);
    }
    if (url.pathname === '/mcp') {
      if (!configured(env)) return new Response('human MCP binding is not configured', { status: 503 });
      return humanHostFor(env).fetchHandler(request);
    }
    return new Response('not found', { status: 404 });
  },
};

function configured(env) {
  return typeof env.MCP_IDENTITY_DB === 'object' && env.MCP_IDENTITY_DB !== null;
}
