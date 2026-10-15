'use strict';

const crypto = require('node:crypto');
const { createGoogleDocsProvider } = require('./google-docs');

const HUMAN_SERVICE = 'mcp-host';
const HUMAN_AUDIENCE = 'trained-assist:registry-mcp:test';

function humanToolsForRole(_role) {
  // The product user catalog contains only real user capabilities. Test fixtures
  // are served by worker.mjs and must never leak into this user-facing gateway.
  return ['identity.whoami', 'google_docs.connect', 'google_docs.get_document'];
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

function humanScope(identity, catalogDigest) {
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
    },
    allowedTools: humanToolsForRole(identity.role),
    audience: HUMAN_AUDIENCE,
    operationId: 'user',
    expiresAt: now + 15 * 60 * 1000,
  };
}

module.exports = {
  humanToolsForRole,
  createHumanProvider,
  humanScope,
  makeTrace,
  HUMAN_SERVICE,
  HUMAN_AUDIENCE,
};
