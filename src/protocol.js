'use strict';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = Object.freeze({ name: 'trained-assist-mcp-host', version: '0.1.0' });

function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function createProtocol({ catalog, tokens, authorize = async () => true, timeoutMs = 45_000 }) {
  const pending = new Map();
  async function handle({ message, authorization }) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return error(message && message.id, -32600, 'Invalid Request');
    }
    const { id, method } = message;
    if (method === 'notifications/cancelled') {
      const scope = tokens.verify(authorization);
      const targetId = message.params && message.params.requestId;
      const active = pending.get(String(targetId));
      if (scope && active && active.taskId === scope.taskId && active.username === scope.username) {
        active.controller.abort(new Error('Request cancelled by client'));
      }
      return null;
    }
    if (id === undefined || id === null) return null;

    if (method === 'initialize') {
      return result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') {
      if (!tokens.verify(authorization)) return error(id, -32001, 'Unauthorized');
      return result(id, { tools: catalog.list() });
    }
    if (method !== 'tools/call') return error(id, -32601, `Method not found: ${method}`);

    const scope = tokens.verify(authorization);
    if (!scope) return error(id, -32001, 'Unauthorized');
    const params = message.params || {};
    if (typeof params.name !== 'string' || !params.name) return error(id, -32602, 'tools/call requires params.name');
    const tool = catalog.get(params.name);
    if (!tool) return result(id, { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true });
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments : {};
    const requestId = String(id);
    if (pending.has(requestId)) return error(id, -32600, 'Request id is already active');
    const controller = new AbortController();
    pending.set(requestId, { controller, taskId: scope.taskId, username: scope.username });
    const context = Object.freeze({ ...scope, providerId: tool.providerId, requestId, signal: controller.signal });
    try {
      if (!await authorize({ context, tool: { name: tool.name, providerId: tool.providerId } })) {
        return result(id, { content: [{ type: 'text', text: 'Tool is not authorized for this run' }], isError: true });
      }
      let timer;
      const output = await Promise.race([
        Promise.resolve().then(() => tool.handler(args, context)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Tool timed out'));
            controller.abort(new Error('Tool timed out'));
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
      return result(id, { content: [{ type: 'text', text } ] });
    } catch (err) {
      return result(id, { content: [{ type: 'text', text: String(err && err.message || 'Tool failed') }], isError: true });
    } finally {
      pending.delete(requestId);
    }
  }

  return { handle };
}

module.exports = { createProtocol, PROTOCOL_VERSION, SERVER_INFO };
