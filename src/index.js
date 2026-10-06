'use strict';

const { createCatalog } = require('./catalog');
const { createTokenStore } = require('./tokens');
const { createProtocol } = require('./protocol');
const { createHttpHandler } = require('./http');
const { attachStdio } = require('./stdio');

function createHost({ providers = [], env = process.env, now = Date.now, authorize, timeoutMs } = {}) {
  const catalog = createCatalog(providers);
  const tokens = createTokenStore({ env, now });
  const protocol = createProtocol({ catalog, tokens, authorize, timeoutMs });
  return {
    catalog,
    tokens,
    protocol,
    httpHandler: createHttpHandler({ protocol, tokens }),
    attachStdio: (options) => attachStdio(protocol, options),
  };
}

module.exports = { createHost };
