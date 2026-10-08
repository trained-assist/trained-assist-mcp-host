'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const { webcrypto } = require('node:crypto');
const { createHost } = require('../src');

let tokenSequence = 0;
const testAudience = 'trained-assist-mcp-host:test';
const testScope = (profileId = 'profile_a', taskId = 'task-a', runId = 'run-a', allowedTools = ['read_marker']) => ({
  taskId, generation: 1, profileId, principalId: `principal:${profileId}`, runId,
  bindingRef: `test-binding:${profileId}`, allowedTools, policyVersion: 'test-policy-v1',
  expiresAt: Date.now() + 60_000, audience: testAudience,
});
const providers = [{
  id: 'fixture',
  version: '1.0.0-test',
  tools: [{
    name: 'read_marker',
    description: 'Return the run identity and supplied marker.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
    handler: async ({ marker }, scope) => ({ marker, profileId: scope.profileId, taskId: scope.taskId }),
  }],
}];

function setup(options = {}) {
  const credentials = new Map();
  const token = `test-run-${++tokenSequence}`;
  credentials.set(token, testScope());
  let host;
  host = createHost({
    providers: options.providers || providers,
    audience: testAudience,
    authenticate: async ({ authorization }) => {
      const scope = credentials.get(String(authorization || '').replace(/^Bearer /, ''));
      return scope ? { ...scope, registryDigest: scope.registryDigest || host.catalog.digest } : null;
    },
    ...options,
  });
  return { host, token, credentials, authorization: `Bearer ${token}` };
}

test('catalog returns MCP definitions and rejects duplicate ownership', () => {
  const { host } = setup();
  assert.deepEqual(host.catalog.list(), [{
    name: 'read_marker', description: 'Return the run identity and supplied marker.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
  }]);
  assert.throws(() => createHost({ providers: [providers[0], { ...providers[0], id: 'duplicate-owner' }] }), { code: 'DUPLICATE_TOOL' });
});

test('trusted run scope filters tools/list and reaches the provider call', async () => {
  const { host, authorization } = setup();
  const listed = await host.protocol.handle({ message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization });
  assert.equal(listed.result.tools[0].name, 'read_marker');
  const called = await host.protocol.handle({
    message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_marker', arguments: { marker: 'proof' } } },
    authorization,
  });
  assert.deepEqual(JSON.parse(called.result.content[0].text), { marker: 'proof', profileId: 'profile_a', taskId: 'task-a' });
});

test('missing and malformed run scopes cannot list or call tools', async () => {
  const { host, credentials } = setup();
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await host.protocol.handle({ message, authorization: 'Bearer unknown' })).error.code, -32001);
  credentials.set('bad-scope', { ...testScope('profile_x'), generation: undefined });
  assert.equal((await host.protocol.handle({ message, authorization: 'Bearer bad-scope' })).error.code, -32001);
  credentials.set('expired', { ...testScope(), expiresAt: Date.now() - 1 });
  assert.equal((await host.protocol.handle({ message, authorization: 'Bearer expired' })).error.code, -32001);
  credentials.set('wrong-audience', { ...testScope(), audience: 'another-service' });
  assert.equal((await host.protocol.handle({ message, authorization: 'Bearer wrong-audience' })).error.code, -32001);
  credentials.set('wrong-registry', { ...testScope(), registryDigest: '0'.repeat(64) });
  assert.equal((await host.protocol.handle({ message, authorization: 'Bearer wrong-registry' })).error.code, -32001);
});

test('authorization callback runs for every call and sees immutable run scope', async () => {
  const seen = [];
  const { host, authorization } = setup({
    authorize: async ({ context, tool }) => { seen.push({ context, tool }); return false; },
  });
  const reply = await host.protocol.handle({
    message: { jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'read_marker' } },
    authorization,
  });
  assert.equal(reply.result.isError, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].context.profileId, 'profile_a');
  assert.equal(seen[0].context.principalId, 'principal:profile_a');
  assert.equal(seen[0].tool.providerId, 'fixture');
  assert.equal(Object.isFrozen(seen[0].context), true);
});

test('tool failures and timeouts are MCP tool errors, not protocol errors', async () => {
  const badSetup = setup({ providers: [{ id: 'bad', version: '1.0.0-test', tools: [{ name: 'bad', handler: async () => { throw new Error('controlled'); } }] }] });
  const failing = badSetup.host;
  badSetup.credentials.set(badSetup.token, testScope('p', 't', 'r', ['bad']));
  const failure = await failing.protocol.handle({ message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bad' } }, authorization: `Bearer ${badSetup.token}` });
  assert.equal(failure.error, undefined);
  assert.equal(failure.result.isError, true);
  assert.equal(failure.result.content[0].text, 'controlled');

  let slow;
  slow = createHost({
    providers: [{ id: 'slow', version: '1.0.0-test', tools: [{ name: 'slow', handler: (_args, context) => new Promise((resolve) => context.signal.addEventListener('abort', () => resolve('aborted'), { once: true })) }] }],
    audience: testAudience,
    authenticate: async () => ({ ...testScope('p', 't', 'r', ['slow']), registryDigest: slow.catalog.digest }), timeoutMs: 5,
  });
  const timeout = await slow.protocol.handle({ message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }, authorization: 'Bearer test' });
  assert.equal(timeout.result.isError, true);
  assert.equal(timeout.result.content[0].text, 'Tool timed out');
});

test('MCP cancellation aborts the provider signal and does not emit a notification response', async () => {
  const credentials = new Map([
    ['run-one', testScope('p', 't', 'run-1', ['wait'])],
    ['run-two', testScope('p', 't', 'run-2', ['wait'])],
  ]);
  let host;
  host = createHost({
    providers: [{ id: 'cancel', version: '1.0.0-test', tools: [{ name: 'wait', handler: (_args, context) => new Promise((resolve) => context.signal.addEventListener('abort', () => resolve('aborted'), { once: true })) }] }],
    audience: testAudience,
    authenticate: async ({ authorization }) => {
      const scope = credentials.get(String(authorization || '').replace(/^Bearer /, ''));
      return scope ? { ...scope, registryDigest: scope.registryDigest || host.catalog.digest } : null;
    },
  });
  const authorization = 'Bearer run-one';
  const call = host.protocol.handle({ message: { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'wait' } }, authorization });
  await new Promise((resolve) => setImmediate(resolve));
  await host.protocol.handle({ message: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } }, authorization: 'Bearer run-two' });
  const notification = await host.protocol.handle({ message: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } }, authorization });
  assert.equal(notification, null);
  const reply = await call;
  assert.equal(reply.result.content[0].text, 'aborted');
});

test('stdio JSON-RPC runs a read-only provider using one synthetic test-profile binding', async (t) => {
  const profileId = 'synthetic_profile_160';
  const bindingRef = 'test-only:profile-160:read';
  const records = new Map([[`${profileId}:marker-1`, { label: 'fixture readback', revision: 3 }]]);
  const credentials = new Map([['runner-scoped-test', testScope(profileId, 'task-160-test', 'run-160-test', ['fixture_read'])]]);
  let host;
  host = createHost({
    providers: [{ id: 'test-provider', version: '1.0.0-test', tools: [{
      name: 'fixture_read',
      description: 'Read a synthetic profile fixture.',
      inputSchema: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'] },
      requiredBindings: [bindingRef],
      handler: async ({ recordId }, run) => {
        if (run.bindings[bindingRef] !== `read:${profileId}`) throw new Error('wrong profile binding');
        return records.get(`${run.profileId}:${recordId}`) || null;
      },
    }] }],
    audience: testAudience,
    authenticate: async ({ authorization }) => {
      const scope = credentials.get(String(authorization || '').replace(/^Bearer /, ''));
      return scope ? { ...scope, registryDigest: host.catalog.digest } : null;
    },
    resolveBindings: async ({ context, required }) => {
      assert.equal(context.profileId, profileId);
      assert.deepEqual(required, [bindingRef]);
      return { [bindingRef]: `read:${profileId}` };
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map();
  const waiters = new Map();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    text += chunk;
    let newline;
    while ((newline = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      const reply = JSON.parse(line);
      replies.set(String(reply.id), reply);
      waiters.get(String(reply.id))?.(reply);
    }
  });
  const replyFor = (id) => replies.has(String(id)) ? Promise.resolve(replies.get(String(id))) : new Promise((resolve) => waiters.set(String(id), resolve));
  host.attachStdio({ input, output, authorization: 'Bearer runner-scoped-test' });
  t.after(() => { input.destroy(); output.destroy(); });

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-runner', version: 'test' } } })}\n`);
  assert.equal((await replyFor(1)).result.serverInfo.name, 'trained-assist-mcp-host');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  assert.deepEqual((await replyFor(2)).result.tools.map((tool) => tool.name), ['fixture_read']);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fixture_read', arguments: { recordId: 'marker-1' } } })}\n`);
  assert.deepEqual(JSON.parse((await replyFor(3)).result.content[0].text), { label: 'fixture readback', revision: 3 });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'unlisted_write', arguments: { recordId: 'marker-1' } } })}\n`);
  const denied = await replyFor(4);
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /Unknown tool/);
});

test('HTTP door accepts injected per-run auth and exposes no token mint route', async (t) => {
  const { host, authorization } = setup();
  const server = createServer((req, res) => host.httpHandler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_marker', arguments: { marker: 'http' } } }),
  });
  assert.equal(rpc.status, 200);
  const reply = await rpc.json();
  assert.equal(JSON.parse(reply.result.content[0].text).profileId, 'profile_a');
  const denied = await fetch(`${base}/mcp/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 404);
});

test('Fetch adapter accepts Runner remote MCP scope headers and dispatches the read-only tool', async () => {
  const seen = [];
  const { host, authorization } = setup({
    authenticate: async ({ authorization: supplied, headers }) => {
      seen.push({ supplied, taskId: headers.get('x-mcp-user-task-id'), profileId: headers.get('x-mcp-profile'), runId: headers.get('x-mcp-run-id') });
      const scope = testScope(headers.get('x-mcp-profile'), headers.get('x-mcp-user-task-id'), headers.get('x-mcp-run-id'));
      return supplied === authorization ? { ...scope, registryDigest: host.catalog.digest } : null;
    },
  });
  const response = await host.fetchHandler(new Request('https://mcp.test/mcp', {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      'x-mcp-user-task-id': 'task-160',
      'x-mcp-profile': 'profile_a',
      'x-mcp-run-id': 'run_01234567-89ab-cdef-0123-456789abcdef',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'read_marker', arguments: { marker: 'fetch-runtime' } } }),
  }));
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.deepEqual(JSON.parse(reply.result.content[0].text), {
    marker: 'fetch-runtime',
    profileId: 'profile_a',
    taskId: 'task-160',
  });
  assert.deepEqual(seen[0], {
    supplied: authorization,
    taskId: 'task-160',
    profileId: 'profile_a',
    runId: 'run_01234567-89ab-cdef-0123-456789abcdef',
  });
  assert.equal((await host.fetchHandler(new Request('https://mcp.test/mcp/token', { method: 'POST', body: '{}' }))).status, 404);
});

test('test Worker separates CP discovery scope from Runner invocation scope', async () => {
  const { default: worker } = await import('../src/worker.mjs');
  const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const e2eKeyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
  const e2ePublicJwk = await webcrypto.subtle.exportKey('jwk', e2eKeyPair.publicKey);
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const signProof = async (overrides = {}, signer = keyPair.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'trained-assist-agent-runner', aud: 'trained-assist:registry-mcp:test',
      sub: 'run_01234567-89ab-cdef-0123-456789abcdef', runId: 'run_01234567-89ab-cdef-0123-456789abcdef',
      userTaskId: 'task-160', profileId: 'integration-telegram-ux-v1', principalId: 'integration-telegram-ux-v1',
      serverId: 'trained-assist-registry-test', bindingRef: 'registry-mcp-test-160-read',
      allowedTools: ['registry.fixture_read'], policyVersion: 'registry-fixture-policy-v1',
      catalogueVersion: 'registry-fixture-catalogue-v1', registryDigest: workerDigest, scope: 'registry:fixture-read',
      iat: now - 1, exp: now + 30, ...overrides,
    };
    const input = `${b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
    return `${input}.${b64(await webcrypto.subtle.sign({ name: 'Ed25519' }, signer, Buffer.from(input)))}`;
  };
  const env = {
    MCP_TEST_AUTH_TOKEN: 'test-only-secret',
    MCP_TEST_PRINCIPAL_ID: 'integration-telegram-ux-v1',
    MCP_TEST_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    MCP_TEST_GENERATION: '1',
    MCP_TEST_RUNNER_PUBLIC_JWK: JSON.stringify(publicJwk),
    MCP_TEST_E2E_ENABLED: 'true',
    MCP_TEST_E2E_PUBLIC_JWK: JSON.stringify(e2ePublicJwk),
    MCP_TEST_CATALOGUE_VERSION: 'registry-fixture-catalogue-v1',
  };
  const request = (headers, message, requestEnv = env) => worker.fetch(new Request('https://mcp.test/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer test-only-secret', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(message),
  }), requestEnv);
  const baseScope = { 'x-mcp-user-task-id': 'task-160', 'x-mcp-profile': 'integration-telegram-ux-v1' };
  let workerDigest;

  const invalidKeyEnv = { ...env, MCP_TEST_RUNNER_PUBLIC_JWK: JSON.stringify({ ...publicJwk, d: 'private-material' }) };
  const invalidKeyResponse = await worker.fetch(new Request('https://mcp.test/mcp', {
    method: 'POST', headers: { authorization: 'Bearer test-only-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'invalid-jwk', method: 'tools/list' }),
  }), invalidKeyEnv);
  assert.equal(invalidKeyResponse.status, 503);

  const discovery = await request({
    ...baseScope,
    'x-mcp-operation': 'discovery',
    'x-mcp-generation': '1',
    'x-mcp-principal-id': 'integration-telegram-ux-v1',
  }, { jsonrpc: '2.0', id: 'catalogue-1', method: 'tools/list' });
  assert.equal(discovery.status, 200);
  assert.deepEqual((await discovery.json()).result.tools.map((tool) => tool.name), ['registry.fixture_read']);

  const discoveryNoRunId = await request({ ...baseScope, 'x-mcp-operation': 'discovery', 'x-mcp-generation': '1', 'x-mcp-principal-id': 'integration-telegram-ux-v1' },
    { jsonrpc: '2.0', id: 'catalogue-no-run', method: 'tools/list' });
  assert.equal((await discoveryNoRunId.json()).error, undefined);

  const discoveryCall = await request({
    ...baseScope,
    'x-mcp-operation': 'discovery',
    'x-mcp-generation': '1',
    'x-mcp-principal-id': 'integration-telegram-ux-v1',
  }, { jsonrpc: '2.0', id: 'bad-discovery-call', method: 'tools/call', params: { name: 'registry.fixture_read' } });
  assert.equal((await discoveryCall.json()).error.code, -32001);

  const discoveryWithRunId = await request({ ...baseScope, 'x-mcp-operation': 'discovery', 'x-mcp-generation': '1', 'x-mcp-principal-id': 'integration-telegram-ux-v1', 'x-mcp-run-id': 'run_01234567-89ab-cdef-0123-456789abcdef' },
    { jsonrpc: '2.0', id: 'catalogue-run-denied', method: 'tools/list' });
  assert.equal((await discoveryWithRunId.json()).error.code, -32001);

  const catalogResponse = await request({ ...baseScope, 'x-mcp-operation': 'discovery', 'x-mcp-generation': '1', 'x-mcp-principal-id': 'integration-telegram-ux-v1' },
    { jsonrpc: '2.0', id: 'digest', method: 'tools/list' });
  // The pinned test catalog digest is returned by the host instance used for this Worker request.
  workerDigest = (await catalogResponse.json()).result.tools.length ? (await import('../src/index.js')).createHost({ providers: [{ id: 'registry-fixture', version: '1.0.0-test', tools: [{ name: 'registry.fixture_read', description: 'Read the pinned marker from the Registry MCP test fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, requiredBindings: ['registry-mcp-test-160-read'], handler: async () => null }] }] }).catalog.digest : '';

  const invocation = await request({
    ...baseScope,
    'x-mcp-operation': 'invocation',
    'x-mcp-scope': 'registry:fixture-read',
    'x-mcp-run-id': 'run_01234567-89ab-cdef-0123-456789abcdef',
    'x-mcp-run-binding': await signProof(),
  }, { jsonrpc: '2.0', id: 'run-call', method: 'tools/call', params: { name: 'registry.fixture_read' } });
  assert.equal(invocation.status, 200);
  assert.deepEqual(JSON.parse((await invocation.json()).result.content[0].text), {
    marker: 'registry-fixture-marker-160-v1',
    profileId: 'integration-telegram-ux-v1',
    taskId: 'task-160',
    runId: 'run_01234567-89ab-cdef-0123-456789abcdef',
  });

  const e2eInvocation = await request({
    ...baseScope,
    'x-mcp-operation': 'invocation',
    'x-mcp-scope': 'registry:fixture-read',
    'x-mcp-run-id': 'run_01234567-89ab-cdef-0123-456789abcdef',
    'x-mcp-run-binding': await signProof({}, e2eKeyPair.privateKey),
  }, { jsonrpc: '2.0', id: 'e2e-run-call', method: 'tools/call', params: { name: 'registry.fixture_read' } });
  assert.equal(e2eInvocation.status, 200);
  assert.equal(JSON.parse((await e2eInvocation.json()).result.content[0].text).marker, 'registry-fixture-marker-160-v1');

  const e2eDisabledInvocation = await request({
    ...baseScope,
    'x-mcp-operation': 'invocation',
    'x-mcp-scope': 'registry:fixture-read',
    'x-mcp-run-id': 'run_01234567-89ab-cdef-0123-456789abcdef',
    'x-mcp-run-binding': await signProof({}, e2eKeyPair.privateKey),
  }, { jsonrpc: '2.0', id: 'e2e-run-call-disabled', method: 'tools/call', params: { name: 'registry.fixture_read' } }, { ...env, MCP_TEST_E2E_ENABLED: 'false' });
  assert.equal((await e2eDisabledInvocation.json()).error.code, -32001);

  const initialize = await request({}, { jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1' } } });
  assert.equal((await initialize.json()).result.protocolVersion, '2024-11-05');
  const initialized = await request({}, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized.status, 202);
  const invocationList = await request({
    ...baseScope,
    'x-mcp-operation': 'invocation',
    'x-mcp-scope': 'registry:fixture-read',
    'x-mcp-run-id': 'run_01234567-89ab-cdef-0123-456789abcdef',
    'x-mcp-run-binding': await signProof(),
  }, { jsonrpc: '2.0', id: 'run-list', method: 'tools/list' });
  assert.equal(invocationList.status, 200);
  assert.deepEqual((await invocationList.json()).result.tools.map((tool) => tool.name), ['registry.fixture_read']);

  const denyInvocation = async (headers, proof) => {
    const response = await request({ ...baseScope, 'x-mcp-operation': 'invocation', 'x-mcp-scope': 'registry:fixture-read', 'x-mcp-run-id': 'run_01234567-89ab-cdef-0123-456789abcdef', ...headers, ...(proof ? { 'x-mcp-run-binding': proof } : {}) },
      { jsonrpc: '2.0', id: 'denied-proof', method: 'tools/call', params: { name: 'registry.fixture_read' } });
    assert.equal((await response.json()).error.code, -32001);
  };
  await denyInvocation({}, null);
  await denyInvocation({}, await signProof({ runId: 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sub: 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
  await denyInvocation({}, await signProof({ bindingRef: 'another-binding' }));
  await denyInvocation({ 'x-mcp-scope': 'registry:write' }, await signProof());
  await denyInvocation({}, await signProof({ scope: 'registry:write' }));
  await denyInvocation({}, await signProof({ allowedTools: ['registry.fixture_write'] }));
  await denyInvocation({}, await signProof({ catalogueVersion: 'another-catalogue' }));
  await denyInvocation({}, await signProof({ unexpectedClaim: 'must-not-be-ignored' }));
  await denyInvocation({ 'x-mcp-operation': '' }, await signProof());
  await denyInvocation({ 'x-mcp-scope': '' }, await signProof());
  await denyInvocation({ 'x-mcp-profile': 'another-profile' }, await signProof());
  await denyInvocation({ 'x-mcp-user-task-id': 'another-task' }, await signProof());
  await denyInvocation({}, await signProof({ exp: Math.floor(Date.now() / 1000) - 1 }));
  await denyInvocation({}, `${(await signProof()).slice(0, -3)}abc`);

  const wrongPrincipal = await request({
    ...baseScope,
    'x-mcp-operation': 'discovery',
    'x-mcp-generation': '1',
    'x-mcp-principal-id': 'another-principal',
  }, { jsonrpc: '2.0', id: 'wrong-principal', method: 'tools/list' });
  assert.equal((await wrongPrincipal.json()).error.code, -32001);
});

test('MCP notifications have no response and batch requests fail explicitly', async (t) => {
  const { host, authorization } = setup();
  const server = createServer((req, res) => host.httpHandler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/mcp`;
  const notification = await fetch(base, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
  const batch = await fetch(base, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '[]' });
  assert.equal((await batch.json()).error.code, -32600);
});
