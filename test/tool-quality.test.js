'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalog } = require('../src/catalog');
const { createHumanProvider } = require('../src/human');
const { createZeroCredsWalletProvider } = require('../src/zerocreds-wallet');
const { createSearchProvider, SEARCH_SKILL_COMMIT } = require('../src/search');
const { createJsTsCodeProvider } = require('../src/js-ts-code');

/**
 * Tool quality gates: snake_case params + description budget.
 *
 * These tests enforce the "declarative tool naming" contract introduced
 * by the js-ts-code refactor (67% token reduction) across all catalogs.
 *
 * - All inputSchema property names MUST be snake_case (no camelCase).
 * - Tool descriptions MUST stay under the character budget.
 *
 * Known allowlist for pre-existing camelCase params (each is a contract
 * change requiring coordinated pin updates across repos):
 */

const CAMEL_CASE_ALLOWLIST = [
  // google_docs.get_document uses documentId (camelCase).
  // Renaming to document_id would change human catalog digest
  // and break control-plane USER_MCP_DIGEST pin (cross-repo update required).
  'google_docs.get_document.documentId',
];

// Maximum characters for a tool description.
// Current longest: search_serper (704). Budget set at 800 to allow
// search examples while catching runaway verbosity (old js-ts-code was ~1500).
const MAX_DESCRIPTION_CHARS = 800;

// Get all catalogs under test
async function getCatalogs() {
  const { machineProvider } = await import('../src/worker.mjs');
  return {
    'human+wallet': createCatalog([createHumanProvider({}), createZeroCredsWalletProvider({})]),
    'machine': createCatalog([
      machineProvider,
      createSearchProvider({
        version: SEARCH_SKILL_COMMIT,
        searchOrigin: 'https://search.test.invalid',
        serperApiKey: '',
      }),
    ]),
    'js-ts-code': createCatalog([createJsTsCodeProvider({}, {})]),
  };
}

function isCamelCase(str) {
  // Detects camelCase: starts with lowercase, then has uppercase
  // e.g., documentId, taskNaturalLanguageDescription
  return /^[a-z]+[A-Z][A-Za-z]*$/.test(str);
}

function checkSnakeCase(catalogs) {
  const violations = [];
  for (const [catName, catalog] of Object.entries(catalogs)) {
    for (const tool of catalog.list()) {
      const props = Object.keys((tool.inputSchema && tool.inputSchema.properties) || {});
      for (const prop of props) {
        if (isCamelCase(prop)) {
          const key = `${tool.name}.${prop}`;
          if (!CAMEL_CASE_ALLOWLIST.includes(key)) {
            violations.push(`${catName}: ${key}`);
          }
        }
      }
    }
  }
  return violations;
}

function checkDescriptionBudget(catalogs) {
  const violations = [];
  for (const [catName, catalog] of Object.entries(catalogs)) {
    for (const tool of catalog.list()) {
      const len = (tool.description || '').length;
      if (len > MAX_DESCRIPTION_CHARS) {
        violations.push(`${catName}: ${tool.name} = ${len} chars (limit ${MAX_DESCRIPTION_CHARS})`);
      }
    }
  }
  return violations;
}

test('all catalog tools use snake_case parameter names', async () => {
  const catalogs = await getCatalogs();
  const violations = checkSnakeCase(catalogs);
  assert.equal(
    violations.length,
    0,
    'Found camelCase parameter names (not in allowlist):\n' + violations.join('\n')
  );
});

test('tool descriptions stay within character budget', async () => {
  const catalogs = await getCatalogs();
  const violations = checkDescriptionBudget(catalogs);
  assert.equal(
    violations.length,
    0,
    'Found descriptions exceeding budget (' + MAX_DESCRIPTION_CHARS + ' chars):\n' + violations.join('\n')
  );
});