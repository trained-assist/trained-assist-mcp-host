'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHost } = require('../src');
const identity = require('../src/identity');
const { createHumanProvider, humanScope, humanToolsForRole, HUMAN_SERVICE } = require('../src/human');
const { AGENT_BINDING, AGENT_ISSUER, AGENT_POLICY, AGENT_SCOPE, AGENT_SERVER, DEFAULT_USER_CATALOGUE, HUMAN_AUDIENCE } = require('../src/human');
const { createFakeD1, applyMigrations } = require('../test/helpers/fake-d1');

const migrationFiles = [
  'migrations/0001_identity.sql',
  'migrations/0002_identity_canonical.sql',
];

async function setup() {
  const db = createFakeD1();
  await applyMigrations(db, migrationFiles);
  const env = { MCP_IDENTITY_DB: db };
  let host;
  host = createHost({
    providers: [createHumanProvider()],
    audience: HUMAN_AUDIENCE,
    authenticate: async ({ authorization }) => {
      const match = /^Bearer ([^\s]+)$/.exec(String(authorization || ''));
      if (!match) return null;
      const human = await identity.verifyKey(env, match[1], { acceptedServices: [HUMAN_SERVICE, 'ladder'] });
      return human ? humanScope(human, host.catalog.digest) : null;
    },
  });
  return { host, env, db };
}

async function seedUser(env, { userId, email, role, service = HUMAN_SERVICE, status = 'active' }) {
  return identity.createUser(env, { userId, email, role, service, status });
}

async function listTools(host, authorization) {
  return host.protocol.handle({ message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization });
}

async function callTool(host, authorization, name, args) {
  return host.protocol.handle({
    message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    authorization,
  });
}

function toolNames(response) {
  return response.result.tools.map((tool) => tool.name);
}

test('initialize returns tools capability', async () => {
  const { host } = await setup();
  const response = await host.protocol.handle({
    message: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
  });
  assert.equal(response.result.capabilities.tools !== undefined, true);
});

test('recruiter key sees the product user catalog without synthetic fixture tools', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  const response = await listTools(host, `Bearer ${key}`);
  assert.deepEqual(toolNames(response).sort(), ['google_docs.connect', 'google_docs.get_document', 'identity.whoami']);
});

test('non-recruiter key sees the same product catalog without synthetic fixture tools', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-sales', email: 'sales@example.com', role: 'sales' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-sales', label: 'sales-key' });
  const response = await listTools(host, `Bearer ${key}`);
  assert.deepEqual(toolNames(response).sort(), ['google_docs.connect', 'google_docs.get_document', 'identity.whoami']);
});

test('whoami returns caller identity and trusted trace without secrets', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key, keyHash } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  const response = await callTool(host, `Bearer ${key}`, 'identity.whoami', {});
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.userId, 'user-rec');
  assert.equal(payload.role, 'recruiter');
  assert.equal(payload.trace.userId, 'user-rec');
  assert.equal(payload.trace.keyHash, keyHash);
  assert.equal(payload.trace.tool, 'identity.whoami');
  assert.equal(payload.trace.nonce, null);
  assert.equal(JSON.stringify(payload).includes(key), false);
});

test('synthetic fixture tool is unavailable in the user-facing product catalog', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  const response = await callTool(host, `Bearer ${key}`, 'recruiter.fixture_read', { nonce: 'fixture-probe' });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Unknown tool/);
  assert.equal(JSON.stringify(response).includes('fixture-marker'), false);
});

test('bad key is denied without identity', async () => {
  const { host } = await setup();
  const response = await listTools(host, 'Bearer not-a-real-key');
  assert.equal(response.error.code, -32001);
});

test('missing authorization is denied', async () => {
  const { host } = await setup();
  const response = await listTools(host, undefined);
  assert.equal(response.error.code, -32001);
});

test('revoked key is denied on the next request', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key, keyHash } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  assert.equal((await listTools(host, `Bearer ${key}`)).error, undefined);
  assert.equal(await identity.revokeApiKey(env, keyHash), true);
  assert.equal((await listTools(host, `Bearer ${key}`)).error.code, -32001);
});

test('disabled user is denied on the next request', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  assert.equal((await listTools(host, `Bearer ${key}`)).error, undefined);
  assert.equal(await identity.setUserStatus(env, 'user-rec', 'disabled'), true);
  assert.equal((await listTools(host, `Bearer ${key}`)).error.code, -32001);
});

test('Ladder personal key is accepted on the MCP gateway', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-ladder', email: 'ladder@example.com', role: 'recruiter', service: 'ladder' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-ladder', label: 'ladder-key', service: 'ladder' });
  const response = await listTools(host, `Bearer ${key}`);
  assert.deepEqual(toolNames(response).sort(), ['google_docs.connect', 'google_docs.get_document', 'identity.whoami']);
});

test('expired key is denied', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key', expiresAt: Date.now() - 1000 });
  const response = await listTools(host, `Bearer ${key}`);
  assert.equal(response.error.code, -32001);
});

test('role policy keeps recruiter tool out of non-recruiter catalog', () => {
  assert.deepEqual(humanToolsForRole('recruiter').sort(), ['google_docs.connect', 'google_docs.get_document', 'identity.whoami']);
  assert.deepEqual(humanToolsForRole('user').sort(), ['google_docs.connect', 'google_docs.get_document', 'identity.whoami']);
  assert.deepEqual(humanToolsForRole('admin').sort(), ['google_docs.connect', 'google_docs.get_document', 'identity.whoami']);
});

test('human worker fetch path serves tools/list and tools/call over HTTP', async () => {
  const { default: humanWorker } = await import('../src/worker-human.mjs');
  const db = createFakeD1();
  await applyMigrations(db, migrationFiles);
  const env = { MCP_IDENTITY_DB: db };
  await identity.createUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });

  const listed = await humanWorker.fetch(
    new Request('https://human.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    env,
  );
  const listedBody = await listed.json();
  assert.equal(listed.status, 200);
  assert.deepEqual(listedBody.result.tools.map((t) => t.name).sort(), ['google_docs.connect', 'google_docs.get_document', 'identity.whoami']);

  const called = await humanWorker.fetch(
    new Request('https://human.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recruiter.fixture_read', arguments: { nonce: 'http-nonce' } } }),
    }),
    env,
  );
  const calledBody = await called.json();
  assert.equal(calledBody.result.isError, true);
  assert.match(calledBody.result.content[0].text, /Unknown tool/);
  assert.equal(JSON.stringify(calledBody).includes('fixture-marker'), false);
});

test('runner-signed run grant exposes only its scoped user tools without a personal key', async () => {
  const { default: humanWorker } = await import('../src/worker-human.mjs');
  const db = createFakeD1();
  await applyMigrations(db, migrationFiles);
  const env = { MCP_IDENTITY_DB: db, MCP_RUNNER_AUTH_TOKEN: 'runner-transport-token-1234567890', MCP_USER_CATALOGUE_VERSION: DEFAULT_USER_CATALOGUE };
  await identity.createUser(env, { userId: 'user-agent', email: 'agent@example.com', role: 'user' });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  env.MCP_RUNNER_PUBLIC_JWK = JSON.stringify(publicKey.export({ format: 'jwk' }));
  const host = createHost({ providers: [createHumanProvider(env)], audience: HUMAN_AUDIENCE });
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: AGENT_ISSUER, aud: HUMAN_AUDIENCE, sub: 'run_12345678-1234-1234-1234-123456789abc',
    userId: 'user-agent', profileId: 'telegram-test-profile', userTaskId: 'task-test-1',
    runId: 'run_12345678-1234-1234-1234-123456789abc', ownerGeneration: 2,
    serverId: AGENT_SERVER, bindingRef: AGENT_BINDING, scope: AGENT_SCOPE, policyVersion: AGENT_POLICY,
    catalogueVersion: DEFAULT_USER_CATALOGUE, catalogueDigest: host.catalog.digest,
    allowedTools: ['identity.whoami', 'google_docs.get_document'], iat: now, exp: now + 300,
  };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(claims)}`;
  const proof = `${unsigned}.${crypto.sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`;
  const headers = {
    authorization: `Bearer ${env.MCP_RUNNER_AUTH_TOKEN}`,
    'x-mcp-run-binding': proof,
    'x-mcp-operation': 'invocation',
    'x-mcp-scope': AGENT_SCOPE,
    'x-mcp-user-task-id': claims.userTaskId,
    'x-mcp-profile': claims.profileId,
    'x-mcp-run-id': claims.runId,
  };
  const listed = await humanWorker.fetch(new Request('https://human.example/mcp', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), env);
  const listedBody = await listed.json();
  assert.deepEqual(listedBody.result.tools.map(tool => tool.name).sort(), claims.allowedTools.sort());

  const called = await humanWorker.fetch(new Request('https://human.example/mcp', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'identity.whoami', arguments: {} } }),
  }), env);
  const result = await called.json();
  const identityResult = JSON.parse(result.result.content[0].text);
  assert.equal(identityResult.userId, 'user-agent');
  assert.equal(identityResult.trace.keyHash, null);

  const mismatched = await humanWorker.fetch(new Request('https://human.example/mcp', {
    method: 'POST', headers: { ...headers, 'x-mcp-run-id': 'run_other', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  }), env);
  assert.equal((await mismatched.json()).error.code, -32001);

  await identity.setUserStatus(env, 'user-agent', 'disabled');
  const disabled = await humanWorker.fetch(new Request('https://human.example/mcp', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
  }), env);
  assert.equal((await disabled.json()).error.code, -32001);
});

test('machine fixture worker catalog digest is unchanged by the human worker', async () => {
  const { machineProvider } = await import('../src/worker.mjs');
  const { createCatalog } = require('../src/catalog');
  const digestBefore = createCatalog([machineProvider]).digest;

  const { default: humanWorker } = await import('../src/worker-human.mjs');
  assert.equal(typeof humanWorker.fetch, 'function');
  const { createHumanProvider } = require('../src/human');
  const humanCatalog = createCatalog([createHumanProvider()]);

  const { machineProvider: machineAfter } = await import('../src/worker.mjs');
  const digestAfter = createCatalog([machineAfter]).digest;
  assert.equal(digestAfter, digestBefore);
  assert.notEqual(humanCatalog.digest, digestBefore);
});

test('mode routing: personal key selects human, missing D1 selects machine', async () => {
  const { resolveMode } = await import('../src/worker-unified.mjs');
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  const humanReq = { headers: { get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${key}` : null) } };
  assert.equal(await resolveMode(humanReq, env), 'human');

  const machineReq = { headers: { get: () => 'Bearer machine-token' } };
  assert.equal(await resolveMode(machineReq, env), 'machine');
  assert.equal(await resolveMode({ headers: { get: () => null } }, env), 'machine');
  assert.equal(await resolveMode(machineReq, {}), 'machine');
});

test('machine token without required headers is denied', async () => {
  const { default: machineWorker } = await import('../src/worker.mjs');
  const machineEnv = {
    MCP_TEST_AUTH_TOKEN: 'mtok',
    MCP_TEST_PRINCIPAL_ID: 'integration-telegram-ux-v1',
    MCP_TEST_EXPIRES_AT: '2100-01-01T00:00:00Z',
    MCP_TEST_RUNNER_PUBLIC_JWK: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'x' }),
    MCP_TEST_CATALOGUE_VERSION: 'registry-fixture-catalogue-v1',
  };
  const initReq = new Request('https://example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer mtok' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  const initRes = await machineWorker.fetch(initReq, machineEnv);
  const initBody = await initRes.json();
  const sessionId = initBody.result?.sessionId || initBody.id;
  assert.ok(sessionId, 'initialize establishes a session');

  const callReq = new Request('https://example.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer mtok',
      'mcp-session-id': String(sessionId),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'registry.fixture_read', arguments: {} } }),
  });
  const callRes = await machineWorker.fetch(callReq, machineEnv);
  const callBody = await callRes.json();
  assert.equal(callBody.error?.code, -32001, 'invocation without run headers is denied');
});
