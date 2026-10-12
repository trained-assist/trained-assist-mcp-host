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
import { execFileSync } from 'node:child_process';

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

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${key}`,
    'accept-encoding': 'identity'
  };
  const sessionHeader = req.headers['mcp-session-id'];
  if (sessionHeader) headers['mcp-session-id'] = String(sessionHeader);

  try {
    const upstreamResponse = await fetch(upstream, { method: 'POST', headers, body });

    const contentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8';
    const contentEncoding = upstreamResponse.headers.get('content-encoding');
    console.error(`[proxy] upstream content-encoding: ${contentEncoding || 'none'}`);

    const rawBody = Buffer.from(await upstreamResponse.arrayBuffer());

    let responseBody = rawBody;
    if (contentEncoding === 'zstd') {
      console.error('[proxy] decompressing zstd...');
      responseBody = execFileSync('zstd', ['-d'], { input: rawBody, maxBuffer: 10 * 1024 * 1024 });
    } else if (contentEncoding) {
      console.error('[proxy] unknown encoding:', contentEncoding);
    }

    const finalContentType = contentType.includes('charset') ? contentType : contentType + '; charset=utf-8';
    res.writeHead(upstreamResponse.status, {
      'content-type': finalContentType,
      'content-length': Buffer.byteLength(responseBody),
      'cache-control': 'no-cache'
    });
    res.end(responseBody);
  } catch (err) {
    console.error('proxy error:', err);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'proxy error' }, id: null }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`proxy listening http://127.0.0.1:${port}/mcp -> ${upstream} (user=${keyUserId})`);
});