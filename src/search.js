'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Pinned source commit of trained-assist-search-skill. The host never vendors a
// floating branch; this value is also validated by the domain adapter.
const SEARCH_SKILL_COMMIT = '069ba8b2e6f8b02c4e9241fcb1514d3114a68466';

const vendorRoot = './vendor/trained-assist-search-skill/' + SEARCH_SKILL_COMMIT + '/src';
const hostProviderModule = require('./vendor/trained-assist-search-skill/069ba8b2e6f8b02c4e9241fcb1514d3114a68466/src/host-provider.js');
const serperModule = require('./vendor/trained-assist-search-skill/069ba8b2e6f8b02c4e9241fcb1514d3114a68466/src/mcp-skills/tools/99-search-serper.js');

const createHostProvider = hostProviderModule.createHostProvider;
const MAX_QUERY_CHARS = hostProviderModule.MAX_QUERY_CHARS;
const MAX_RESPONSE_BYTES = hostProviderModule.MAX_RESPONSE_BYTES;
const MAX_REQUESTS_PER_CALL = hostProviderModule.MAX_REQUESTS_PER_CALL;
const { tools: serperTools, searchSerper } = serperModule;
const SEARCH_SERPER_TOOL = 'search_serper';
const SEARCH_SERP_FREE_TOOL = 'search_serp_free';

const DEFAULT_SEARCH_ORIGIN = 'https://search.test.invalid';

function trustedKey(options) {
  if (options == null) return undefined;
  return options.serperApiKey || options.SERPER_API_KEY || options.serperKey
    || options.apiKey || options.env?.SERPER_API_KEY || process.env.SERPER_API_KEY;
}

function trustedOrigin(options) {
  return (options && (options.searchOrigin || options.search_origin || options.SEARCH_ORIGIN || options.MCP_SEARCH_ORIGIN
    || (options.env && (options.env.SEARCH_ORIGIN || options.env.MCP_SEARCH_ORIGIN)))) || DEFAULT_SEARCH_ORIGIN;
}

function trustedFetch(options) {
  return (options && (options.fetchImpl || options.fetch || options.safeFetch)) || (globalThis && globalThis.fetch);
}

function createSearchProvider(options = {}) {
  const pinnedVersion = (options && (options.version || options.commit || options.sourceCommit)) || SEARCH_SKILL_COMMIT;
  const searchOrigin = trustedOrigin(options);
  const fetchImpl = trustedFetch(options);
  const apiKey = trustedKey(options);

  const freeProvider = createHostProvider({ version: pinnedVersion, searchOrigin, fetchImpl });

  const serperTool = Object.assign({}, serperTools[SEARCH_SERPER_TOOL], {
    name: SEARCH_SERPER_TOOL,
    requiredBindings: [...((serperTools[SEARCH_SERPER_TOOL] && serperTools[SEARCH_SERPER_TOOL].requiredBindings) || [])],
    providerId: 'trained-assist-search',
    handler: async (args, run) => searchSerper({
      query: args && args.query,
      num: args && args.num,
      gl: args && args.gl,
      hl: args && args.hl,
      apiKey: run && run.bindings && run.bindings.serperApiKey ? run.bindings.serperApiKey : apiKey,
      fetchImpl: fetchImpl,
    }),
  });

  return {
    id: 'trained-assist-search',
    version: pinnedVersion,
    tools: [...(freeProvider.tools || []), serperTool],
  };
}

// Aliases for callers using either host-skill or product-provider naming.
const createSearchSkillProvider = createSearchProvider;
const createTrainedAssistSearchProvider = createSearchProvider;
const createSearchSkillHostProvider = createSearchProvider;

module.exports = {
  SEARCH_SKILL_COMMIT,
  SEARCH_SOURCE: SEARCH_SKILL_COMMIT,
  SEARCH_ORIGIN: DEFAULT_SEARCH_ORIGIN,
  SEARCH_SERP_FREE_TOOL,
  SEARCH_SERPER_TOOL,
  createHostProvider,
  createSearchProvider,
  createSearchSkillProvider,
  createTrainedAssistSearchProvider,
  createSearchSkillHostProvider,
  createProvider: createSearchProvider,
  MAX_QUERY_CHARS,
  MAX_REQUESTS_PER_CALL,
  MAX_RESPONSE_BYTES,
  MAX_QUERY_CHARS,
  // Compatibility re-exports for modules that look for a default factory.
  default: { createSearchProvider, createHostProvider },
};
