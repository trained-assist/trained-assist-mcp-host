'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createJsTsCodeProvider, detectModuleFormat, stripComments } = require('../src/js-ts-code.js');
const { createTypeScriptBridge } = require('../src/js-ts-code-tsc.js');

const tool = createJsTsCodeProvider({}, { tsc: createTypeScriptBridge() }).tools[0];
const call = (args) => tool.handler(args, {});

test('tool schema exposes the module format, existing_path and existing_code inputs', () => {
  const properties = tool.inputSchema.properties;
  assert.ok(properties.module, 'module input is declared');
  assert.deepEqual(properties.module.enum, ['cjs', 'esm', 'auto']);
  assert.ok(properties.existing_path, 'existing_path input is declared');
  assert.ok(properties.existing_code, 'existing_code input is declared');
  assert.equal(tool.providerId, 'js-ts-code');
});

test('the description tells the caller that the Code Mode sandbox cannot load modules', () => {
  assert.match(tool.description, /writePath/);
  assert.match(tool.description, /shell tool/);
});

test('module format detection tells CJS and ESM apart', () => {
  assert.equal(detectModuleFormat('const fs = require("fs");\nmodule.exports = fs;'), 'cjs');
  assert.equal(detectModuleFormat('import fs from "fs";\nexport const x = fs;'), 'esm');
  assert.equal(detectModuleFormat('export function add(a, b) { return a + b; }'), 'esm');
  assert.equal(detectModuleFormat('function add(a, b) { return a + b; }'), 'unknown');
});

test('comment stripping keeps URLs inside string literals intact', () => {
  const source = [
    '// leading comment',
    'const api = "https://api.example.com/v1"; // trailing comment',
    '/* block */',
    'const re = /https?:\\/\\/x/;',
    'export const value = api;',
  ].join('\n');
  const stripped = stripComments(source);
  assert.match(stripped, /https:\/\/api\.example\.com\/v1/);
  assert.doesNotMatch(stripped, /leading comment/);
  assert.doesNotMatch(stripped, /trailing comment/);
  assert.doesNotMatch(stripped, /block/);
});

test('comment stripping keeps template literals intact', () => {
  const stripped = stripComments('const url = `https://example.com//x`; // gone');
  assert.match(stripped, /https:\/\/example\.com\/\/x/);
  assert.doesNotMatch(stripped, /gone/);
});

test('noComments does not break TypeScript sources that contain URLs', async () => {
  const source = [
    'const api = "https://api.example.com/v1";',
    'export function fetchIt(url: string): string { return api + url; }',
  ].join('\n');
  const result = await call({ code: source, language: 'typescript', noComments: true });
  assert.equal(result.valid, true, result.error || result.note || '');
  assert.match(result.code, /https:\/\/api\.example\.com\/v1/);
});

test('validating an existing file reports a syntax error', async () => {
  const result = await call({ code: 'function broken( {', language: 'javascript' });
  assert.equal(result.valid, false);
  assert.ok(result.error);
});

test('validating an ES module succeeds', async () => {
  const result = await call({ code: 'import path from "node:path";\nexport const base = path.join("a", "b");', language: 'javascript' });
  assert.equal(result.valid, true, result.error || result.note || '');
  assert.equal(result.moduleFormat, 'esm');
});

test('validating a CommonJS module succeeds', async () => {
  const result = await call({ code: 'const path = require("node:path");\nmodule.exports = { base: path.join("a", "b") };', language: 'javascript' });
  assert.equal(result.valid, true, result.error || result.note || '');
  assert.equal(result.moduleFormat, 'cjs');
});

test('TypeScript validation reports a syntax error', async () => {
  const result = await call({ code: 'export const x: number = ;', language: 'typescript' });
  assert.equal(result.valid, false);
  assert.ok(result.error);
});

test('TypeScript validation reports valid code', async () => {
  const result = await call({ code: 'export const x: number = 1;', language: 'typescript' });
  assert.equal(result.valid, true, result.error || result.note || '');
});

test('writing a file lands inside the allowed root and refuses to escape it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsts-root-'));
  const scoped = createJsTsCodeProvider({}, { tsc: createTypeScriptBridge(), writeRoot: root }).tools[0];
  const ok = await scoped.handler({ code: 'export const ok = true;', language: 'javascript', write_path: 'nested/ok.js' }, {});
  assert.ok(ok.writtenTo, ok.warnings.join('; '));
  assert.equal(fs.readFileSync(path.join(root, 'nested/ok.js'), 'utf8'), 'export const ok = true;');

  const escaped = await scoped.handler({ code: 'export const ok = true;', language: 'javascript', write_path: '../escaped.js' }, {});
  assert.equal(escaped.writtenTo, undefined);
  assert.ok(escaped.warnings.some((w) => /allowed root/.test(w)));
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escaped.js')), false);
});

test('existing_path reads the file that should be modified', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsts-root-'));
  fs.writeFileSync(path.join(root, 'current.js'), 'export const current = 1;\n', 'utf8');
  const scoped = createJsTsCodeProvider({}, { tsc: createTypeScriptBridge(), writeRoot: root }).tools[0];
  const found = await scoped.handler({ code: 'export const current = 1;', language: 'javascript', existing_path: 'current.js' }, {});
  assert.equal(found.warnings.filter((w) => /existingPath/.test(w)).length, 0, found.warnings.join('; '));

  const missing = await scoped.handler({ code: 'export const current = 1;', language: 'javascript', existing_path: 'nope.js' }, {});
  assert.ok(missing.warnings.some((w) => /existingPath could not be read/.test(w)), missing.warnings.join('; '));
});

test('a runtime without dynamic evaluation reports valid: null instead of a false failure', async () => {
  // Cloudflare Workers forbid `new Function` at request time, so ESM code must
  // not be reported as invalid there.
  const workerish = createJsTsCodeProvider({}, {
    capabilities: { eval: false, spawn: false, fs: false, childProcess: null, fsModule: null, pathModule: null },
  }).tools[0];
  const result = await workerish.handler({ code: 'import path from "node:path";\nexport const base = path.join("a", "b");', language: 'javascript' }, {});
  assert.equal(result.valid, null);
  assert.match(result.note, /not verified/);
  assert.equal(result.error, null);
});

test('a runtime without a filesystem refuses to write and says why', async () => {
  const workerish = createJsTsCodeProvider({}, {
    capabilities: { eval: false, spawn: false, fs: false, childProcess: null, fsModule: null, pathModule: null },
  }).tools[0];
  const result = await workerish.handler({ code: 'export const ok = true;', language: 'javascript', write_path: 'out.js' }, {});
  assert.equal(result.writtenTo, undefined);
  assert.ok(result.warnings.some((w) => /not supported in this runtime/.test(w)), result.warnings.join('; '));
});

test('a missing Ladder key fails with an actionable message', async () => {
  const provider = createJsTsCodeProvider({ LADDER_API_KEY: '' }, { apiKey: '', apiKeyFile: '/nonexistent/ladder-api-key' });
  const previous = process.env.LADDER_API_KEY;
  delete process.env.LADDER_API_KEY;
  try {
    await assert.rejects(
      () => provider.tools[0].handler({ task_natural_language_description: 'write a function that adds two numbers' }, {}),
      /LADDER_API_KEY is not configured/,
    );
  } finally {
    if (previous !== undefined) process.env.LADDER_API_KEY = previous;
  }
});

test('no provider source file embeds a credential', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js-ts-code.js'), 'utf8');
  assert.doesNotMatch(source, /[a-f0-9]{64}/, 'src/js-ts-code.js must not contain a hardcoded key');
  const stdio = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'js-ts-code-stdio.js'), 'utf8');
  assert.doesNotMatch(stdio, /[a-f0-9]{64}/, 'scripts/js-ts-code-stdio.js must not contain a hardcoded key');
});

test('the Worker route stays unavailable until it is explicitly enabled', async () => {
  const worker = await import('../src/worker-js-ts-code.mjs');
  const disabled = { MCP_JS_TS_CODE_ENABLED: 'false' };
  const res = await worker.default.fetch(new Request('https://example.test/js-ts-code'), disabled);
  assert.equal(res.status, 404);

  const enabledWithoutToken = { MCP_JS_TS_CODE_ENABLED: 'true' };
  const res2 = await worker.default.fetch(new Request('https://example.test/js-ts-code'), enabledWithoutToken);
  assert.equal(res2.status, 404);
});

test('the Worker route rejects a missing or wrong bearer token', async () => {
  const worker = await import('../src/worker-js-ts-code.mjs');
  const env = { MCP_JS_TS_CODE_ENABLED: 'true', MCP_JS_TS_CODE_TOKEN: 's3cret-token' };
  const anonymous = await worker.default.fetch(new Request('https://example.test/js-ts-code'), env);
  assert.equal(anonymous.status, 401);
  const wrong = await worker.default.fetch(
    new Request('https://example.test/js-ts-code', { headers: { authorization: 'Bearer nope' } }),
    env,
  );
  assert.equal(wrong.status, 401);
  assert.equal(worker.tokenMatches('Bearer s3cret-token', env), true);
  assert.equal(worker.tokenMatches('Bearer s3cret-toke', env), false);
  assert.equal(worker.tokenMatches('Bearer s3cret-tokenX', env), false);
});
