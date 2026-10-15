'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHost } = require('../src');
const identity = require('../src/identity');
const { createHumanProvider, humanScope, HUMAN_SERVICE, HUMAN_AUDIENCE } = require('../src/human');
const { createZeroCredsWalletProvider, walletProfileFor, resolveWalletBindings, TOOL_NAMES } = require('../src/zerocreds-wallet');
const { createFakeD1, applyMigrations } = require('../test/helpers/fake-d1');

async function makeSetup({ mapped = true, service = HUMAN_SERVICE, audience = HUMAN_AUDIENCE } = {}) {
  const db = createFakeD1();
  await applyMigrations(db, ['migrations/0001_identity.sql', 'migrations/0002_identity_canonical.sql']);
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const env = {
    MCP_IDENTITY_DB: db,
    ZEROCREDS_WALLET_API_URL: 'https://wallet.sandbox.example',
    ZEROCREDS_WALLET_ISSUER: 'trained-assist-mcp-host',
    ZEROCREDS_WALLET_KEY_ID: 'sandbox-key-1',
    ZEROCREDS_WALLET_SIGNING_KEY: JSON.stringify(privateJwk),
    ZEROCREDS_WALLET_PROFILES: {
      async get(userId) {
        return mapped && userId === 'wallet-user' ? { owner_id: 'owner_123', profile_id: 'profile_default' } : null;
      },
    },
  };
  await identity.createUser(env, { userId: 'wallet-user', email: 'wallet@example.com', role: 'user', service });
  const { key, keyHash } = await identity.issueApiKey(env, { userId: 'wallet-user', label: 'wallet-test' });
  let capturedAssertion;
  const walletFetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://wallet.sandbox.example');
    capturedAssertion = options.headers.authorization.slice('Bearer '.length);
    const [header, claims, signature] = capturedAssertion.split('.');
    const unsigned = `${header}.${claims}`;
    assert.equal(crypto.verify(null, Buffer.from(unsigned), pair.publicKey, Buffer.from(signature, 'base64url')), true);
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(parsed.aud, 'zerocreds-wallet:human');
    assert.equal(parsed.owner_id, 'owner_123');
    assert.equal(parsed.profile_id, 'profile_default');
    assert.deepEqual(parsed.operations, ['wallet.forms.create']);
    assert.equal(parsed.caller_class, 'human');
    assert.ok(parsed.exp > parsed.iat && parsed.exp - parsed.iat <= 300);
    const body = JSON.parse(options.body);
    assert.equal('owner_id' in body, false);
    assert.equal('profile_id' in body, false);
    return new Response(JSON.stringify({
      form_id: 'a'.repeat(32), connection_id: 'connection_123',
      url: `https://wallet.sandbox.example/f/${'a'.repeat(32)}`,
      expires_at: new Date(Date.now() + 60000).toISOString(), state: 'pending',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const host = createHost({
    providers: [createHumanProvider(env), createZeroCredsWalletProvider(env, walletFetch)],
    audience,
    authenticate: async ({ authorization }) => {
      const token = /^Bearer ([^\s]+)$/.exec(String(authorization || ''))?.[1];
      const user = token && await identity.verifyKey(env, token, { acceptedServices: [HUMAN_SERVICE, 'ladder'] });
      if (!user) return null;
      return humanScope(user, host.catalog.digest, await walletProfileFor(env, user));
    },
    resolveBindings: async (input) => input.providerId === 'zerocreds-wallet'
      ? resolveWalletBindings({ ...input, env }) : {},
  });
  return { db, env, host, key, keyHash, captured: () => capturedAssertion, publicJwk };
}

function rpc(host, key, method, params = {}) {
  return host.protocol.handle({
    message: { jsonrpc: '2.0', id: crypto.randomUUID(), method, ...(method === 'tools/call' ? { params } : {}) },
    authorization: `Bearer ${key}`,
  });
}

test('authorized human profile lists and invokes the four ZeroCreds wallet tools with a scoped short-lived assertion', async () => {
  const { host, key, captured } = await makeSetup();
  const listed = await rpc(host, key, 'tools/list');
  const names = listed.result.tools.map(tool => tool.name);
  assert.deepEqual(names.filter(name => TOOL_NAMES.includes(name)).sort(), [...TOOL_NAMES].sort());
  const definition = listed.result.tools.find(tool => tool.name === 'zerocreds_wallet_form_create');
  assert.equal('owner_id' in definition.inputSchema.properties, false);
  assert.equal('profile_id' in definition.inputSchema.properties, false);
  assert.equal('destination' in definition.inputSchema.properties, false);

  const called = await rpc(host, key, 'tools/call', {
    name: 'zerocreds_wallet_form_create',
    arguments: { provider: 'github', fields: [{ name: 'token', label: 'Token', type: 'password', required: true }] },
  });
  assert.equal(called.result.isError, undefined, JSON.stringify(called.result));
  const output = JSON.parse(called.result.content[0].text);
  assert.equal(output.form_id, 'a'.repeat(32));
  assert.equal(output.connection_id, 'connection_123');
  assert.equal(JSON.stringify(output).includes(captured()), false);
  assert.equal(JSON.stringify(output).includes('owner_123'), false);
});

test('missing trusted profile mapping hides wallet tools and rejects direct calls', async () => {
  const { host, key } = await makeSetup({ mapped: false });
  const listed = await rpc(host, key, 'tools/list');
  assert.equal(listed.result.tools.some(tool => TOOL_NAMES.includes(tool.name)), false);
  const called = await rpc(host, key, 'tools/call', { name: 'zerocreds_wallet_form_create', arguments: { provider: 'github' } });
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /not authorized for this run/);
});

test('Ladder keys do not receive ZeroCreds wallet tools even when a profile mapping exists', async () => {
  const { host, key } = await makeSetup({ service: 'ladder' });
  const listed = await rpc(host, key, 'tools/list');
  assert.equal(listed.result.tools.some(tool => TOOL_NAMES.includes(tool.name)), false);
});

test('invalid wallet map values fail closed', async () => {
  const { env } = await makeSetup();
  env.ZEROCREDS_WALLET_PROFILES.get = async () => ({ owner_id: '../owner', profile_id: 'profile_default' });
  assert.equal(await walletProfileFor(env, { userId: 'wallet-user', service: HUMAN_SERVICE }), null);
});

test('disabled and expired personal keys cannot list or invoke wallet tools', async () => {
  const disabled = await makeSetup();
  assert.equal((await rpc(disabled.host, disabled.key, 'tools/list')).result.tools.some(tool => TOOL_NAMES.includes(tool.name)), true);
  await identity.setUserStatus(disabled.env, 'wallet-user', 'disabled');
  assert.equal((await rpc(disabled.host, disabled.key, 'tools/list')).error.code, -32001);
  assert.equal((await rpc(disabled.host, disabled.key, 'tools/call', { name: TOOL_NAMES[0], arguments: { provider: 'github' } })).error.code, -32001);

  const expired = await makeSetup();
  await expired.db.prepare('UPDATE identity_api_keys SET expires_at = ? WHERE key_hash = ?')
    .bind(Date.now() - 1000, expired.keyHash).run();
  assert.equal((await rpc(expired.host, expired.key, 'tools/list')).error.code, -32001);
  assert.equal((await rpc(expired.host, expired.key, 'tools/call', { name: TOOL_NAMES[0], arguments: { provider: 'github' } })).error.code, -32001);
});

test('a host with a mismatched audience rejects wallet listing and calls', async () => {
  const { host, key } = await makeSetup({ audience: 'trained-assist:wrong-audience' });
  assert.equal((await rpc(host, key, 'tools/list')).error.code, -32001);
  assert.equal((await rpc(host, key, 'tools/call', { name: TOOL_NAMES[0], arguments: { provider: 'github' } })).error.code, -32001);
});
