import hostModule from './index.js';
import identityModule from './identity.js';
import humanModule from './human.js';
import googleDocsModule from './google-docs.js';
import walletModule from './zerocreds-wallet.js';

const { createHost } = hostModule;
const { initTables, createUser, issueApiKey, revokeApiKey, verifyKey, setUserStatus } = identityModule;
const { createHumanProvider, humanScope, verifyAgentRunScope, HUMAN_SERVICE, HUMAN_AUDIENCE } = humanModule;
const { finishGoogleAuthorization } = googleDocsModule;
const { createZeroCredsWalletProvider, walletProfileFor, resolveWalletBindings } = walletModule;

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
