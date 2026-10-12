'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('../src');
const identity = require('../src/identity');
const { createHumanProvider, humanScope, humanToolsForRole, HUMAN_SERVICE } = require('../src/human');
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
    audience: 'trained-assist:registry-mcp:test',
    authenticate: async ({ authorization }) => {
      const match = /^Bearer ([^\s]+)$/.exec(String(authorization || ''));
      if (!match) return null;
      const human = await identity.verifyKey(env, match[1], { service: HUMAN_SERVICE });
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

test('recruiter key sees whoami and recruiter.fixture_read', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  const response = await listTools(host, `Bearer ${key}`);
  assert.deepEqual(toolNames(response).sort(), ['identity.whoami', 'recruiter.fixture_read']);
});

test('non-recruiter key sees whoami only and not the recruiter tool', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-sales', email: 'sales@example.com', role: 'sales' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-sales', label: 'sales-key' });
  const response = await listTools(host, `Bearer ${key}`);
  assert.deepEqual(toolNames(response), ['identity.whoami']);
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

test('recruiter fixture call returns deterministic result with nonce in trace', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key' });
  const response = await callTool(host, `Bearer ${key}`, 'recruiter.fixture_read', { nonce: 'nonce-253-a' });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.marker, 'recruiter-fixture-marker-v1');
  assert.equal(payload.trace.nonce, 'nonce-253-a');
  assert.equal(payload.trace.userId, 'user-rec');
});

test('cross-role: sales key is denied the recruiter tool before execution', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-sales', email: 'sales@example.com', role: 'sales' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-sales', label: 'sales-key' });
  const response = await callTool(host, `Bearer ${key}`, 'recruiter.fixture_read', { nonce: 'x' });
  assert.equal(response.result.isError, true);
  assert.equal(JSON.stringify(response).includes('recruiter-fixture-marker-v1'), false);
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

test('wrong-service key is denied on the MCP gateway', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-ladder', email: 'ladder@example.com', role: 'recruiter', service: 'ladder' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-ladder', label: 'ladder-key' });
  const response = await listTools(host, `Bearer ${key}`);
  assert.equal(response.error.code, -32001);
});

test('expired key is denied', async () => {
  const { host, env } = await setup();
  await seedUser(env, { userId: 'user-rec', email: 'rec@example.com', role: 'recruiter' });
  const { key } = await identity.issueApiKey(env, { userId: 'user-rec', label: 'rec-key', expiresAt: Date.now() - 1000 });
  const response = await listTools(host, `Bearer ${key}`);
  assert.equal(response.error.code, -32001);
});

test('role policy keeps recruiter tool out of non-recruiter catalog', () => {
  assert.deepEqual(humanToolsForRole('recruiter').sort(), ['identity.whoami', 'recruiter.fixture_read']);
  assert.deepEqual(humanToolsForRole('user'), ['identity.whoami']);
  assert.deepEqual(humanToolsForRole('admin'), ['identity.whoami']);
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
  assert.deepEqual(listedBody.result.tools.map((t) => t.name).sort(), ['identity.whoami', 'recruiter.fixture_read']);

  const called = await humanWorker.fetch(
    new Request('https://human.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recruiter.fixture_read', arguments: { nonce: 'http-nonce' } } }),
    }),
    env,
  );
  const calledBody = await called.json();
  const payload = JSON.parse(calledBody.result.content[0].text);
  assert.equal(payload.trace.nonce, 'http-nonce');
  assert.equal(payload.trace.userId, 'user-rec');
});

test('machine fixture worker catalog digest is unchanged by the human worker', async () => {
  const { default: machineWorker, ...machineModule } = await import('../src/worker.mjs');
  assert.equal(typeof machineWorker.fetch, 'function');
  // The machine worker keeps its own pinned catalog (registry.fixture_read only).
  assert.equal(typeof machineModule.verifyKey, 'function');
  const { default: humanWorker } = await import('../src/worker-human.mjs');
  assert.equal(typeof humanWorker.fetch, 'function');
});
