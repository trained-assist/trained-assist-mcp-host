import hostModule from './index.js';
import catalogModule from './catalog.js';
import codeModule from './js-ts-code.js';

const { createHost } = hostModule;
const { createJsTsCodeProvider } = codeModule;

const audience = 'trained-assist:js-ts-code';
const profileId = 'anonymous';
const taskId = 'anonymous';
const bindingRef = 'anonymous';

let cachedHost = null;
function hostFor(env) {
  if (cachedHost && cachedHost.env === env) return cachedHost.host;
  // The Worker runtime has no filesystem, no child process and forbids dynamic
  // code evaluation, so the provider is created without a TypeScript bridge and
  // reports `valid: null` instead of guessing.
  const provider = createJsTsCodeProvider(env, { budgetMs: 150000, attemptTimeoutMs: 70000 });
  const catalog = catalogModule.createCatalog([provider]);
  const host = createHost({
    providers: [provider],
    audience,
    timeoutMs: 170000,
    authenticate: async ({ authorization }) => {
      if (!tokenMatches(authorization, env)) return null;
      return {
        profileId,
        taskId,
        generation: 1,
        principalId: 'anonymous',
        bindingRef,
        policyVersion: 'js-ts-code-v1',
        registryDigest: catalog.digest,
        identity: {},
        allowedTools: ['write'],
        audience,
        operationId: 'user',
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
    },
    authorize: async () => true,
    resolveBindings: async () => ({}),
  });
  cachedHost = { host, env };
  return host;
}

function configured(env) {
  return env.MCP_JS_TS_CODE_ENABLED === 'true'
    && typeof env.MCP_JS_TS_CODE_TOKEN === 'string'
    && env.MCP_JS_TS_CODE_TOKEN.trim() !== '';
}

// Length-independent, content constant-time comparison of the bearer token.
function tokenMatches(authorization, env) {
  if (!configured(env)) return false;
  const match = /^Bearer ([^\s]+)$/.exec(String(authorization || ''));
  if (!match) return false;
  const provided = match[1];
  const expected = env.MCP_JS_TS_CODE_TOKEN;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export { configured, tokenMatches };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/js-ts-code') {
      // The route stays unavailable until it is explicitly enabled with a
      // dedicated bearer token; it is a billable LLM endpoint and must never
      // be an open proxy.
      if (!configured(env)) return new Response('not found', { status: 404 });
      if (!tokenMatches(request.headers.get('authorization'), env)) {
        return Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401, headers: { 'cache-control': 'no-store' } });
      }
      return hostFor(env).fetchHandler(request);
    }
    return new Response('not found', { status: 404 });
  },
};
