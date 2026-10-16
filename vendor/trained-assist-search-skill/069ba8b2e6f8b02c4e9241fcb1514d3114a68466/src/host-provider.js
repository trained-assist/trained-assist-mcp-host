'use strict';

const { tools } = require('./mcp-skills/tools/99c-search-searxng');

const TOOL_NAME = 'search_serp_free';
const MAX_QUERY_CHARS = 500;
const MAX_REQUESTS_PER_CALL = 2;
const MAX_RESPONSE_BYTES = 1_000_000;

function normalizedSearchOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('searchOrigin must be a valid HTTPS origin'); }
  if (url.protocol !== 'https:' || url.origin === 'null' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('searchOrigin must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

async function boundedResponse(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.();
    throw new Error('Search provider response exceeded the size limit');
  }
  if (!response.body?.getReader) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('Search provider response exceeded the size limit');
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Search provider response exceeded the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const statusWithoutBody = [204, 205, 304].includes(response.status);
  return new Response(statusWithoutBody ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createHostProvider({ version, searchOrigin, fetchImpl = globalThis.fetch } = {}) {
  if (typeof version !== 'string' || !/^[a-f0-9]{40}$/.test(version)) {
    throw new TypeError('provider version must be a pinned 40-character source commit');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const origin = normalizedSearchOrigin(searchOrigin);

  return {
    id: 'trained-assist-search',
    version,
    tools: [{
      name: TOOL_NAME,
      description: tools[TOOL_NAME].description,
      inputSchema: tools[TOOL_NAME].inputSchema,
      handler: async (args, run) => {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query.length > MAX_QUERY_CHARS) {
          return { error: 'bad_request', message: `search_serp_free: query exceeds ${MAX_QUERY_CHARS} characters` };
        }

        let requestCount = 0;
        const boundedFetch = async (input, init = {}) => {
          const target = new URL(input);
          if (target.protocol !== 'https:' || target.origin !== origin) {
            throw new Error('Search provider egress refused: origin is not allowlisted');
          }
          requestCount += 1;
          if (requestCount > MAX_REQUESTS_PER_CALL) {
            throw new Error('Search provider request budget exceeded');
          }
          const signals = [init.signal, run?.signal].filter((signal) => signal instanceof AbortSignal);
          const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
          const response = await fetchImpl(target, { ...init, redirect: 'manual', ...(signal ? { signal } : {}) });
          if (response.status >= 300 && response.status < 400) {
            throw new Error('Search provider redirect refused');
          }
          return boundedResponse(response);
        };

        return tools[TOOL_NAME].handler(args, {
          ...run,
          env: {
            FREE_SEARCH_BACKEND: 'searxng',
            SEARXNG_URL: origin,
            FREE_SEARCH_SEARXNG_COOLDOWN_MS: '0',
          },
          fetchImpl: boundedFetch,
        });
      },
    }],
  };
}

module.exports = { createHostProvider, MAX_QUERY_CHARS, MAX_REQUESTS_PER_CALL, MAX_RESPONSE_BYTES };
