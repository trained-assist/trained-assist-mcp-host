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
    authenticate: async () => ({
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
    }),
    authorize: async () => true,
    resolveBindings: async () => ({}),
  });
  cachedHost = { host, env };
  return host;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/js-ts-code') return hostFor(env).fetchHandler(request);
    return new Response('not found', { status: 404 });
  },
};
