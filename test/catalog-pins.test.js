'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCatalog } = require('../src/catalog');
const { createHumanProvider } = require('../src/human');
const { createZeroCredsWalletProvider } = require('../src/zerocreds-wallet');
const { createSearchProvider, SEARCH_SKILL_COMMIT } = require('../src/search');

/**
 * Catalog digest pin synchronization test.
 *
 * These digests are pinned in external consumers and in this repo's README.
 * If a tool's name, description, or inputSchema changes, the digest changes,
 * and this test will fail — forcing the developer to deliberately update:
 *
 *   1. This test's expected constants
 *   2. trained-assist-control-plane/src/router/user-sandbox-mcp.ts:8 (USER_MCP_DIGEST)
 *   3. trained-assist-control-plane/src/router/mcp-catalogue.ts:12 (TEST_REGISTRY_DIGEST)
 *   4. runner-serverless-api/src/cloudflare/run-coordinator.ts:30 (MCP_TEST.digest)
 *   5. runner-serverless-api/src/adapters/remote-mcp.ts:94 (registryDigest check)
 *   6. This repo's README.md (two digests)
 *
 * Human + wallet catalog (served at /mcp):
 *   - 7 tools: identity.whoami, google_docs.connect, google_docs.get_document,
 *     zerocreds_wallet_form_create, _form_status, _connection_status, _connection_revoke
 *   - Pinned in control-plane USER_MCP_DIGEST and this README line 11
 *
 * Machine fixture catalog (fixture-only, no search):
 *   - 1 tool: registry.fixture_read
 *   - Pinned in control-plane TEST_REGISTRY_DIGEST and runner MCP_TEST.digest
 *
 * Machine fixture + search catalog (served at /mcp in test worker):
 *   - 3 tools: registry.fixture_read, search_serp_free, search_serper
 *   - Pinned in this README line 63
 */

const EXPECTED = {
  // human + wallet catalog (control-plane USER_MCP_DIGEST, README line 11)
  'human+wallet': '483e6d2f949b32c05a70186f4e25aba291b1483eeb0bdc9a7a3bca4b9b7cdf11',

  // fixture-only catalog (control-plane TEST_REGISTRY_DIGEST, runner MCP_TEST.digest)
  'fixture-only': '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',

  // fixture + search catalog (README line 63)
  'fixture+search': 'fcfc1bda07f5ba348a97002489fbb621c495394ca84b3d2aeb0a1ec71cb55c7b',
};

// Known pre-existing camelCase param that we document but don't fix yet (would break
// control-plane USER_MCP_DIGEST pin and require cross-repo coordinated release).
// TODO: rename google_docs.get_document.documentId → document_id in a coordinated release.
const CAMEL_CASE_ALLOWLIST = [
  'google_docs.get_document.documentId',
];

test('catalog digests match external pins', async () => {
  const { machineProvider } = await import('../src/worker.mjs');

  const humanWallet = createCatalog([
    createHumanProvider({}),
    createZeroCredsWalletProvider({}),
  ]).digest;

  const fixtureOnly = createCatalog([machineProvider]).digest;

  const fixtureSearch = createCatalog([
    machineProvider,
    createSearchProvider({
      version: SEARCH_SKILL_COMMIT,
      searchOrigin: 'https://search.test.invalid',
      serperApiKey: '',
    }),
  ]).digest;

  assert.equal(
    humanWallet,
    EXPECTED['human+wallet'],
    'human+wallet catalog digest drifted — update this test AND control-plane USER_MCP_DIGEST AND README line 11'
  );

  assert.equal(
    fixtureOnly,
    EXPECTED['fixture-only'],
    'fixture-only catalog digest drifted — update this test AND control-plane TEST_REGISTRY_DIGEST AND runner MCP_TEST.digest'
  );

  assert.equal(
    fixtureSearch,
    EXPECTED['fixture+search'],
    'fixture+search catalog digest drifted — update this test AND README line 63'
  );
});

test('README pins match computed digests', () => {
  const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');

  // Human catalog digest: line 11 in README
  const humanMatch = readme.match(/The complete human catalog digest is `([a-f0-9]{64})`/);
  assert.ok(humanMatch, 'README missing "complete human catalog digest" pin');
  assert.equal(
    humanMatch[1],
    EXPECTED['human+wallet'],
    'README human catalog digest pin does not match expected value'
  );

  // Fixture+search catalog digest: line 63 in README
  const fixtureMatch = readme.match(/catalog digest `([a-f0-9]{64})`.*registry-fixture-marker-160-v1/);
  assert.ok(fixtureMatch, 'README missing fixture catalog digest pin (marker registry-fixture-marker-160-v1)');
  assert.equal(
    fixtureMatch[1],
    EXPECTED['fixture+search'],
    'README fixture catalog digest pin does not match expected value'
  );
});