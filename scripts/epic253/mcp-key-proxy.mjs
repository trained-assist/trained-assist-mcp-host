#!/usr/bin/env node
// mcp-key-proxy.mjs — local MCP forward proxy that injects a personal-key
// Authorization header for the identity-lane gateway (Epic #253 I05.c).
// The OpenCode client talks plain HTTP to 127.0.0.1; the key never enters
// opencode.json or the model-visible project files.
//
//   PROXY_PORT=8732 \
//   UPSTREAM_URL=https://trained-assist-mcp-host-identity.skillset-apply.workers.dev/mcp \
//   KEY_FILE=$HOME/.epic253-secrets/i05c-keys-20261012-a.json \
//   KEY_USER_ID=u-i05c-20261012-a-recruiter \
//     node scripts/epic253/mcp-key-proxy.mjs

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const port = Number(process.env.PROXY_PORT || 8732);
const upstream = process.env.UPSTREAM_URL || 'https://trained-assist-mcp-host-identity.skillset-apply.workers.dev/mcp';
const keyFile = process.env.KEY_FILE;
const keyUserId = process.env.KEY_USER_ID || '';
if (!keyFile) throw new Error('KEY_FILE is required');

const store = JSON.parse(readFileSync(keyFile, 'utf8'));
const key = store.keys?.[keyUserId];
if (!key) throw new Error(`no key for KEY_USER_ID=${keyUserId} in ${keyFile}`);

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` };
  const sessionHeader = req.headers['mcp-session-id'];
  if (sessionHeader) headers['mcp-session-id'] = String(sessionHeader);

  const upstreamResponse = await fetch(upstream, { method: 'POST', headers, body });
  const text = await upstreamResponse.text();

  let mcpMethod = 'unknown';
  let mcpId = null;
  let nonce = null;
  try {
    const parsed = JSON.parse(text);
    mcpMethod = parsed.method || `reply:${parsed.id}`;
    mcpId = parsed.id ?? null;
    nonce = parsed.params?.arguments?.nonce ?? null;
  } catch {}
  console.log(`proxy t=${Date.now()} mcp=${mcpMethod} id=${mcpId}${nonce ? ` nonce=${nonce}` : ''} upstream=${upstreamResponse.status}`);

  res.writeHead(upstreamResponse.status, { 'content-type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8' });
  res.end(text);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`proxy listening http://127.0.0.1:${port}/mcp -> ${upstream} (user=${keyUserId})`);
});
