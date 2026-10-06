'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('../src');
const { createSearchProvider, SEARCH_PROVIDER_VERSION } = require('../src/providers/search');

const audience = 'trained-assist-mcp-host:search-provider-test';
const searchOrigin = 'https://search.test.invalid';

test('pinned search provider is composed into MCP list and call with synthetic upstream data', async () => {
  const outbound = [];
  const provider = createSearchProvider({
    searchOrigin,
    fetchImpl: async (url, init) => {
      outbound.push({ url: String(url), redirect: init.redirect });
      return new Response(JSON.stringify({
        results: [{ url: 'https://result.example/fixture', title: 'Fixture result', content: 'Synthetic only' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  let host;
  host = createHost({
    providers: [provider],
    audience,
    authenticate: async () => ({
      taskId: 'search-host-test-task', generation: 1, profileId: 'synthetic-search-profile',
      principalId: 'synthetic-search-principal', runId: 'run-search-host-test',
      bindingRef: 'test:search:read', allowedTools: ['search_serp_free'],
      policyVersion: 'synthetic-search-policy-v1', registryDigest: host.catalog.digest,
      expiresAt: Date.now() + 60_000, audience,
    }),
  });

  assert.equal(provider.version, SEARCH_PROVIDER_VERSION);
  const listed = await host.protocol.handle({
    message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization: 'Bearer synthetic-run',
  });
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ['search_serp_free']);

  const called = await host.protocol.handle({
    message: {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'search_serp_free', arguments: { query: 'synthetic test input', num: 1 } },
    }, authorization: 'Bearer synthetic-run',
  });
  assert.deepEqual(JSON.parse(called.result.content[0].text).results, [{
    title: 'Fixture result', url: 'https://result.example/fixture', snippet: 'Synthetic only', position: 1,
  }]);
  assert.deepEqual(outbound.map(({ redirect }) => redirect), ['manual']);
  assert.equal(new URL(outbound[0].url).origin, searchOrigin);
});

test('search provider composition requires explicit trusted HTTPS egress configuration', () => {
  assert.throws(() => createSearchProvider({ searchOrigin: 'http://search.test.invalid' }), /HTTPS origin/);
});
