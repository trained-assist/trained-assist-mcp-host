'use strict';

const { createHostProvider } = require('trained-assist-search-skill/host-provider');

// Keep this equal to the immutable git dependency in package.json and package-lock.json.
const SEARCH_PROVIDER_VERSION = 'e8308ed23f9ad264753e119b7831d6f0737f8e15';

function createSearchProvider({ searchOrigin, fetchImpl } = {}) {
  return createHostProvider({ version: SEARCH_PROVIDER_VERSION, searchOrigin, fetchImpl });
}

module.exports = { createSearchProvider, SEARCH_PROVIDER_VERSION };
