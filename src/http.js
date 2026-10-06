'use strict';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('bad json'), { statusCode: 400 }); }
}

function send(res, status, value) {
  const body = value == null ? '' : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function createHttpHandler({ protocol }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
    let message;
    try { message = await readJson(req); }
    catch (err) { return send(res, err.statusCode || 400, { error: err.message }); }
    if (Array.isArray(message)) return send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } });
    const reply = await protocol.handle({ message, authorization: req.headers.authorization, headers: req.headers });
    if (!reply) {
      res.writeHead(202);
      return res.end();
    }
    return send(res, 200, reply);
  };
}

module.exports = { createHttpHandler, MAX_BODY_BYTES };
