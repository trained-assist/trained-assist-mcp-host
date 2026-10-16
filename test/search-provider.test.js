'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('../src');

const SEARCH_SOURCE = '069ba8b2e6f8b02c4e9241fcb1514d3114a68466';
const SEARCH_ORIGIN = 'https://search.test.invalid';
const { createSearchProvider, createHostProvider, MAX_QUERY_CHARS, MAX_RESPONSE_BYTES } = require('../src/search');

test('search provider registers both search tools with pinned version', () => {
  const provider = createSearchProvider({ version: SEARCH_SOURCE, searchOrigin: SEARCH_ORIGIN, fetchImpl: async () => new Response('{}') });
  assert.equal(provider.id, 'trained-assist-search');
  assert.equal(provider.version, SEARCH_SOURCE);
  assert.deepEqual(provider.tools.map(t => t.name).sort(), ['search_serp_free', 'search_serper']);
  // free tool from createHostProvider
  assert.ok(provider.tools.find(t => t.name === 'search_serp_free'));
});

test('host catalog lists both search tools and digest is stable', () => {
  const provider = createSearchProvider({ version: SEARCH_SOURCE, searchOrigin: SEARCH_ORIGIN, fetchImpl: async () => new Response('{}') });
  const host = createHost({ providers: [provider], audience: 'a', authenticate: async () => null });
  const names = host.catalog.list().map(t => t.name).sort();
  assert.deepEqual(names, ['search_serp_free', 'search_serper']);
  assert.equal(typeof host.catalog.digest, 'string');
  assert.equal(host.catalog.digest.length, 64);
});

test('free adapter bounds: query length', async () => {
  const provider = createSearchProvider({ version: SEARCH_SOURCE, searchOrigin: SEARCH_ORIGIN, fetchImpl: async () => new Response('{}') });
  const free = provider.tools.find(t => t.name === 'search_serp_free');
  const out = await free.handler({ query: 'x'.repeat(MAX_QUERY_CHARS + 1) }, {});
  assert.equal(out.error, 'bad_request');
});

test('free adapter bounds: response bytes', async () => {
  const provider = createSearchProvider({
    version: SEARCH_SOURCE,
    searchOrigin: SEARCH_ORIGIN,
    fetchImpl: async () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
  });
  const free = provider.tools.find(t => t.name === 'search_serp_free');
  const out = await free.handler({ query: 'q' }, {});
  assert.equal(out.error, 'search_failed');
  assert.match(out.message, /exceeded the size limit/);
});

test('free adapter refuses redirects', async () => {
  const provider = createSearchProvider({
    version: SEARCH_SOURCE,
    searchOrigin: SEARCH_ORIGIN,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://unexpected.example/' } });
    },
  });
  const free = provider.tools.find(t => t.name === 'search_serp_free');
  const out = await free.handler({ query: 'q' }, {});
  assert.equal(out.error, 'search_failed');
  assert.match(out.message, /redirect refused/);
});

test('serper returns readable error when no key', async () => {
  const saved = process.env.SERPER_API_KEY;
  delete process.env.SERPER_API_KEY;
  try {
    const provider = createSearchProvider({ version: SEARCH_SOURCE, searchOrigin: SEARCH_ORIGIN, fetchImpl: async () => new Response('{}'), serperApiKey: '' });
    const serper = provider.tools.find(t => t.name === 'search_serper');
    const out = await serper.handler({ query: 'q' }, {});
    assert.equal(out.error, 'serper не сконфигрирован: нужен SERPER_API_KEY');
  } finally {
    if (saved !== undefined) process.env.SERPER_API_KEY = saved;
  }
});

test('createHostProvider is also available for adapter-only tests', () => {
  const provider = createHostProvider({ version: SEARCH_SOURCE, searchOrigin: SEARCH_ORIGIN, fetchImpl: async () => new Response('{}') });
  assert.deepEqual(provider.tools.map(t => t.name), ['search_serp_free']);
});
