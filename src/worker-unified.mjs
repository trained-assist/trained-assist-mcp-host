import machineWorker from './worker.mjs';
import humanWorker from './worker-human.mjs';
import codeWorker from './worker-js-ts-code.mjs';
import identityModule from './identity.js';
import humanModule from './human.js';

const { verifyKey } = identityModule;
const { HUMAN_SERVICE } = humanModule;

const MCP_PATH = '/mcp';

async function resolveMode(request, env) {
  if (env.MCP_MODE === 'human') return 'human';
  if (env.MCP_MODE === 'machine') return 'machine';
  const match = /^Bearer ([^\s]+)$/.exec(String(request.headers.get('authorization') || ''));
  if (!match) return 'machine';
  if (typeof env.MCP_IDENTITY_DB !== 'object' || env.MCP_IDENTITY_DB === null) return 'machine';
  const human = await verifyKey(env, match[1], { acceptedServices: [HUMAN_SERVICE, 'ladder'] });
  return human ? 'human' : 'machine';
}

export { resolveMode, verifyKey };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/js-ts-code') {
      return codeWorker.fetch(request, env);
    }
    if (url.pathname !== MCP_PATH) return new Response('not found', { status: 404 });
    const mode = await resolveMode(request, env);
    return mode === 'human' ? humanWorker.fetch(request, env) : machineWorker.fetch(request, env);
  },
};
