'use strict';

const { createCatalog } = require('./catalog');
const { createProtocol } = require('./protocol');
const { createHttpHandler } = require('./http');
const { createFetchHandler } = require('./fetch');
const { attachStdio } = require('./stdio');
const search = require('./search');

function createHost({ providers = [], authenticate, authorize, resolveBindings, audience, now, timeoutMs } = {}) {
  const catalog = createCatalog(providers);
  const protocol = createProtocol({ catalog, authenticate, authorize, resolveBindings, audience, now, timeoutMs });
  return {
    catalog,
    protocol,
    httpHandler: createHttpHandler({ protocol }),
    fetchHandler: createFetchHandler({ protocol }),
    attachStdio: (options) => attachStdio(protocol, options),
  };
}

module.exports = { createHost };
Object.assign(module.exports, search);
module.exports.search = search;
