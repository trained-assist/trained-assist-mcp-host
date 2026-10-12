'use strict';

const crypto = require('node:crypto');

const HUMAN_SERVICE = 'mcp-host';
const HUMAN_AUDIENCE = 'trained-assist:registry-mcp:test';

function humanToolsForRole(role) {
  const tools = ['identity.whoami'];
  if (role === 'recruiter') tools.push('recruiter.fixture_read');
  return tools;
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

function createHumanProvider() {
  return {
    id: 'identity-human',
    version: '1.0.0',
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
      {
        name: 'recruiter.fixture_read',
        description: 'Read a deterministic synthetic candidate marker (recruiter only).',
        inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, additionalProperties: false },
        requiredBindings: [],
        providerId: 'identity-human',
        handler: async (args, context) => {
          const nonce = args?.nonce || null;
          const trace = makeTrace(context.identity, 'recruiter.fixture_read', nonce);
          return {
            marker: 'recruiter-fixture-marker-v1',
            profileId: context.profileId,
            taskId: context.taskId,
            trace,
          };
        },
      },
    ],
  };
}

function humanScope(identity, catalogDigest) {
  const now = Date.now();
  return {
    profileId: `mcp-human:${identity.role}`,
    taskId: `user:${identity.userId}`,
    generation: 1,
    principalId: `user:${identity.userId}`,
    runId: crypto.randomUUID(),
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
    operationId: 'human-invocation',
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