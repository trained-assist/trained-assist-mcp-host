'use strict';

// End-to-end smoke test of the local stdio MCP server: initialize, list the
// tools, call `write` and check that the answer is usable.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'scripts', 'js-ts-code-stdio.js');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id != null && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function main() {
  const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  console.log('initialize:', init.result.serverInfo);

  const list = await send('tools/list', {});
  const tool = list.result.tools[0];
  console.log('tools/list:', list.result.tools.map((t) => t.name).join(', '));
  console.log('schema has module/existingPath:', Boolean(tool.inputSchema.properties.module && tool.inputSchema.properties.existingPath));

  const call = await send('tools/call', {
    name: 'write',
    arguments: {
      task: 'Write an ES module that exports a function `slugify(value)` that lowercases the input, replaces every non alphanumeric character with a dash and collapses repeated dashes.',
      language: 'javascript',
      module: 'esm',
    },
  });
  const payload = JSON.parse(call.result.content[0].text);
  console.log('valid:', payload.valid, 'moduleFormat:', payload.moduleFormat);
  console.log('warnings:', JSON.stringify(payload.warnings));
  console.log('code:\n' + payload.code);
  console.log('usage:', JSON.stringify(payload.usage));
  if (payload.valid !== true) throw new Error(`generated code did not validate: ${payload.error || payload.note}`);
  if (!/export\s/.test(payload.code)) throw new Error('expected ESM output');
  if (/require\s*\(/.test(payload.code)) throw new Error('ESM output must not use require()');
}

main()
  .then(() => { child.kill(); process.exit(0); })
  .catch((err) => { console.error('SMOKE FAILED:', err); child.kill(); process.exit(1); });
