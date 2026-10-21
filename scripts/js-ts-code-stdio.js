'use strict';

const { createHost } = require('../src/index.js');
const { createJsTsCodeProvider } = require('../src/js-ts-code.js');
const { createTypeScriptBridge } = require('../src/js-ts-code-tsc.js');
const { attachStdio } = require('../src/stdio.js');

const provider = createJsTsCodeProvider({}, {
  // `typescript` is a devDependency; the bridge is optional and the tool
  // degrades to `valid: null` for TypeScript when it is unavailable.
  tsc: createTypeScriptBridge(),
  // Files are written inside the workspace the agent works in.
  writeRoot: process.env.JS_TS_CODE_WRITE_ROOT || process.cwd(),
  budgetMs: 165000,
  attemptTimeoutMs: 75000,
});
const { createCatalog } = require('../src/catalog.js');
const catalog = createCatalog([provider]);

const host = createHost({
  providers: [provider],
  audience: 'trained-assist:js-ts-code',
  timeoutMs: 180000,
  authenticate: async () => ({
    profileId: 'local',
    taskId: 'local',
    generation: 1,
    principalId: 'local',
    bindingRef: 'local',
    policyVersion: 'js-ts-code-v1',
    registryDigest: catalog.digest,
    identity: {},
    allowedTools: ['write'],
    audience: 'trained-assist:js-ts-code',
    operationId: 'user',
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  }),
  authorize: async () => true,
  resolveBindings: async () => ({}),
});

host.attachStdio({ authorization: 'Bearer local' });
