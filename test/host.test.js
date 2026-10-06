'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createHost } = require('../src');

const hostToken = `mcp_${'h'.repeat(40)}`;
const providers = [{
  id: 'fixture',
  tools: [{
    name: 'read_marker',
    description: 'Return the run identity and supplied marker.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
    handler: async ({ marker }, scope) => ({ marker, username: scope.username, taskId: scope.taskId }),
  }],
}];

function setup(options = {}) {
  const host = createHost({ providers, env: { MCP_HOST_TOKEN: hostToken }, ...options });
  const token = host.tokens.issue({ taskId: 'task-a', username: 'profile_a' });
  return { host, token, authorization: `Bearer ${token}` };
}

test('catalog returns MCP definitions and rejects duplicate ownership', () => {
  const { host } = setup();
  assert.deepEqual(host.catalog.list(), [{
    name: 'read_marker', description: 'Return the run identity and supplied marker.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
  }]);
  assert.throws(() => createHost({ providers: [providers[0], providers[0]] }), { code: 'DUPLICATE_TOOL' });
});

test('run token scopes every tools/list and tools/call request to task and profile', async () => {
  const { host, authorization } = setup();
  const listed = await host.protocol.handle({ message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization });
  assert.equal(listed.result.tools[0].name, 'read_marker');
  const called = await host.protocol.handle({
    message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_marker', arguments: { marker: 'proof' } } },
    authorization,
  });
  assert.deepEqual(JSON.parse(called.result.content[0].text), { marker: 'proof', username: 'profile_a', taskId: 'task-a' });
});

test('invalid, expired, and revoked run tokens cannot list or call tools', async () => {
  let now = 1000;
  const { host, token } = setup({ now: () => now });
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await host.protocol.handle({ message, authorization: 'Bearer rt_invalid' })).error.code, -32001);
  host.tokens.revoke(`Bearer ${token}`);
  assert.equal((await host.protocol.handle({ message, authorization: `Bearer ${token}` })).error.code, -32001);

  const expiring = host.tokens.issue({ taskId: 'task-b', username: 'profile_b' });
  now += 60 * 60 * 1000;
  assert.equal((await host.protocol.handle({ message, authorization: `Bearer ${expiring}` })).error.code, -32001);
});

test('authorization callback runs for every call and sees immutable run scope', async () => {
  const seen = [];
  const host = createHost({
    providers,
    env: { MCP_HOST_TOKEN: hostToken },
    authorize: async ({ context, tool }) => { seen.push({ context, tool }); return false; },
  });
  const token = host.tokens.issue({ taskId: 'task-c', username: 'profile_c' });
  const reply = await host.protocol.handle({
    message: { jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'read_marker' } },
    authorization: `Bearer ${token}`,
  });
  assert.equal(reply.result.isError, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].context.username, 'profile_c');
  assert.equal(seen[0].tool.providerId, 'fixture');
  assert.equal(Object.isFrozen(seen[0].context), true);
});

test('tool failures and timeouts are MCP tool errors, not protocol errors', async () => {
  const failing = createHost({ providers: [{ id: 'bad', tools: [{ name: 'bad', handler: async () => { throw new Error('controlled'); } }] }], env: { MCP_HOST_TOKEN: hostToken } });
  const token = failing.tokens.issue({ taskId: 't', username: 'u' });
  const failure = await failing.protocol.handle({ message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bad' } }, authorization: `Bearer ${token}` });
  assert.equal(failure.error, undefined);
  assert.equal(failure.result.isError, true);
  assert.equal(failure.result.content[0].text, 'controlled');

  const slow = createHost({
    providers: [{ id: 'slow', tools: [{ name: 'slow', handler: (_args, context) => new Promise((resolve) => context.signal.addEventListener('abort', () => resolve('aborted'), { once: true })) }] }],
    env: { MCP_HOST_TOKEN: hostToken }, timeoutMs: 5,
  });
  const slowToken = slow.tokens.issue({ taskId: 't', username: 'u' });
  const timeout = await slow.protocol.handle({ message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }, authorization: `Bearer ${slowToken}` });
  assert.equal(timeout.result.isError, true);
  assert.equal(timeout.result.content[0].text, 'Tool timed out');
});

test('MCP cancellation aborts the provider signal and does not emit a notification response', async () => {
  const host = createHost({ providers: [{ id: 'cancel', tools: [{ name: 'wait', handler: (_args, context) => new Promise((resolve) => context.signal.addEventListener('abort', () => resolve('aborted'), { once: true })) }] }], env: { MCP_HOST_TOKEN: hostToken } });
  const token = host.tokens.issue({ taskId: 'cancel-task', username: 'profile_cancel' });
  const call = host.protocol.handle({ message: { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'wait' } }, authorization: `Bearer ${token}` });
  await new Promise((resolve) => setImmediate(resolve));
  const otherToken = host.tokens.issue({ taskId: 'other-task', username: 'profile_cancel' });
  await host.protocol.handle({ message: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } }, authorization: `Bearer ${otherToken}` });
  assert.equal(host.tokens.verify(`Bearer ${otherToken}`).taskId, 'other-task');
  const notification = await host.protocol.handle({ message: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } }, authorization: `Bearer ${token}` });
  assert.equal(notification, null);
  const reply = await call;
  assert.equal(reply.result.content[0].text, 'aborted');
});

test('HTTP door mints scoped tokens and serves JSON-RPC without a session cookie', async (t) => {
  const { host } = setup();
  const server = createServer((req, res) => host.httpHandler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const minted = await fetch(`${base}/mcp/token`, {
    method: 'POST', headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'task-http', username: 'profile_http' }),
  });
  assert.equal(minted.status, 200);
  const { token, url } = await minted.json();
  assert.equal(url, '/mcp');
  const rpc = await fetch(`${base}${url}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_marker', arguments: { marker: 'http' } } }),
  });
  assert.equal(rpc.status, 200);
  const reply = await rpc.json();
  assert.equal(JSON.parse(reply.result.content[0].text).username, 'profile_http');
  const denied = await fetch(`${base}/mcp/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
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
