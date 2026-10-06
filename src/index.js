'use strict';

const { createCatalog } = require('./catalog');
const { createProtocol } = require('./protocol');
const { createHttpHandler } = require('./http');
const { attachStdio } = require('./stdio');

function createHost({ providers = [], authenticate, authorize, resolveBindings, audience, now, timeoutMs } = {}) {
  const catalog = createCatalog(providers);
  const protocol = createProtocol({ catalog, authenticate, authorize, resolveBindings, audience, now, timeoutMs });
  return {
    catalog,
    protocol,
    httpHandler: createHttpHandler({ protocol }),
    attachStdio: (options) => attachStdio(protocol, options),
  };
}

module.exports = { createHost };
