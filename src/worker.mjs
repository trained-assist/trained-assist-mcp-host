import hostModule from './index.js';

const { createHost } = hostModule;
const serverId = 'trained-assist-registry-test';
const toolName = 'registry.fixture_read';
const audience = 'trained-assist:registry-mcp:test';
const profileId = 'integration-telegram-ux-v1';
const bindingRef = 'registry-mcp-test-160-read';
const policyVersion = 'registry-fixture-policy-v1';
const fixtureMarker = 'registry-fixture-marker-160-v1';
const required = [
  'MCP_TEST_AUTH_TOKEN',
  'MCP_TEST_PRINCIPAL_ID',
  'MCP_TEST_EXPIRES_AT',
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
  return required.every((key) => typeof env[key] === 'string' && env[key].trim())
    && Number.isFinite(Date.parse(env.MCP_TEST_EXPIRES_AT))
    && Number.isSafeInteger(Number(env.MCP_TEST_GENERATION || 1))
    && Number(env.MCP_TEST_GENERATION || 1) > 0;
}

function hostFor(env) {
  if (cachedHost && cachedEnv === env) return cachedHost;
  cachedHost = createHost({
    providers: [{
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
    }],
    audience,
    authenticate: async ({ authorization, headers, method }) => {
      const match = /^Bearer ([^\s]+)$/.exec(String(authorization || ''));
      if (!match || !await sameSecret(match[1], env.MCP_TEST_AUTH_TOKEN)) return null;
      const taskId = headers?.get?.('x-mcp-user-task-id') || '';
      const requestProfileId = headers?.get?.('x-mcp-profile') || '';
      const requestedOperation = headers?.get?.('x-mcp-operation') || '';
      const generation = Number(env.MCP_TEST_GENERATION || 1);
      if (!taskId || taskId.length > 200 || requestProfileId !== profileId) return null;
      let runId;
      if (requestedOperation === 'discovery') {
        const requestGeneration = Number(headers?.get?.('x-mcp-generation'));
        const requestPrincipalId = headers?.get?.('x-mcp-principal-id') || '';
        if (method !== 'tools/list' || requestGeneration !== generation || requestPrincipalId !== env.MCP_TEST_PRINCIPAL_ID) return null;
        runId = `discovery:${taskId}:${generation}`;
      } else {
        if (requestedOperation && requestedOperation !== 'invocation') return null;
        runId = headers?.get?.('x-mcp-run-id') || '';
        if (!/^run_[a-f0-9-]{36}$/.test(runId)) return null;
      }
      return {
        taskId,
        generation,
        profileId,
        principalId: env.MCP_TEST_PRINCIPAL_ID,
        runId,
        bindingRef,
        allowedTools: [toolName],
        policyVersion,
        registryDigest: cachedHost?.catalog.digest,
        expiresAt: Date.parse(env.MCP_TEST_EXPIRES_AT),
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
  return cachedHost;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('not found', { status: 404 });
    if (!configured(env)) return new Response('test MCP binding is not configured', { status: 503 });
    return hostFor(env).fetchHandler(request);
  },
};
