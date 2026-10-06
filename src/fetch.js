'use strict';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function createFetchHandler({ protocol, maxBodyBytes = MAX_BODY_BYTES }) {
  return async function fetchHandler(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/mcp') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > maxBodyBytes) return Response.json({ error: 'body too large' }, { status: 413 });

    let raw;
    try {
      raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > maxBodyBytes) {
        return Response.json({ error: 'body too large' }, { status: 413 });
      }
    } catch {
      return Response.json({ error: 'bad request body' }, { status: 400 });
    }

    let message;
    try { message = JSON.parse(raw); }
    catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
    if (Array.isArray(message)) {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } });
    }

    const reply = await protocol.handle({
      message,
      authorization: request.headers.get('authorization'),
      headers: request.headers,
    });
    if (!reply) return new Response(null, { status: 202 });
    return Response.json(reply, { status: 200 });
  };
}

module.exports = { createFetchHandler, MAX_BODY_BYTES };
