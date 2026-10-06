'use strict';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = Object.freeze({ name: 'trained-assist-mcp-host', version: '0.1.0' });

function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function createProtocol({ catalog, authenticate = async () => null, authorize = async () => true, resolveBindings = async () => ({}), audience, now = Date.now, timeoutMs = 45_000 }) {
  const pending = new Map();
  async function runScope(authorization) {
    let scope;
    try { scope = await authenticate({ authorization }); }
    catch { return null; }
    if (!scope || typeof scope.profileId !== 'string' || !scope.profileId
        || typeof scope.taskId !== 'string' || !scope.taskId
        || !Number.isSafeInteger(scope.generation) || scope.generation < 1
        || typeof scope.principalId !== 'string' || !scope.principalId
        || typeof scope.runId !== 'string' || !scope.runId
        || typeof scope.bindingRef !== 'string' || !scope.bindingRef
        || typeof scope.policyVersion !== 'string' || !scope.policyVersion
        || scope.registryDigest !== catalog.digest
        || scope.audience !== audience
        || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= now()
        || !Array.isArray(scope.allowedTools)
        || scope.allowedTools.some((name) => typeof name !== 'string' || !name.trim())
        || new Set(scope.allowedTools).size !== scope.allowedTools.length) return null;
    return Object.freeze({
      profileId: scope.profileId,
      taskId: scope.taskId,
      generation: scope.generation,
      principalId: scope.principalId,
      runId: scope.runId,
      bindingRef: scope.bindingRef,
      policyVersion: scope.policyVersion,
      registryDigest: scope.registryDigest,
      audience: scope.audience,
      expiresAt: scope.expiresAt,
      operationId: String(scope.operationId || ''),
      allowedTools: [...scope.allowedTools],
    });
  }
  async function handle({ message, authorization }) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return error(message && message.id, -32600, 'Invalid Request');
    }
    const { id, method } = message;
    if (method === 'notifications/cancelled') {
      const scope = await runScope(authorization);
      const targetId = message.params && message.params.requestId;
      const active = pending.get(String(targetId));
      if (scope && active && active.runId === scope.runId) {
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
      const scope = await runScope(authorization);
      if (!scope) return error(id, -32001, 'Unauthorized');
      return result(id, { tools: catalog.list(scope.allowedTools) });
    }
    if (method !== 'tools/call') return error(id, -32601, `Method not found: ${method}`);

    const scope = await runScope(authorization);
    if (!scope) return error(id, -32001, 'Unauthorized');
    const params = message.params || {};
    if (typeof params.name !== 'string' || !params.name) return error(id, -32602, 'tools/call requires params.name');
    const tool = catalog.get(params.name);
    if (!tool) return result(id, { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true });
    if (scope.allowedTools && !scope.allowedTools.includes(tool.name)) {
      return result(id, { content: [{ type: 'text', text: `Tool is not authorized for this run: ${tool.name}` }], isError: true });
    }
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments : {};
    const requestId = String(id);
    if (pending.has(requestId)) return error(id, -32600, 'Request id is already active');
    const controller = new AbortController();
    pending.set(requestId, { controller, runId: scope.runId });
    const context = Object.freeze({ ...scope, providerId: tool.providerId, requestId, signal: controller.signal });
    try {
      if (!await authorize({ context, tool: { name: tool.name, providerId: tool.providerId } })) {
        return result(id, { content: [{ type: 'text', text: 'Tool is not authorized for this run' }], isError: true });
      }
      const resolvedBindings = await resolveBindings({ context, providerId: tool.providerId, required: [...tool.requiredBindings] });
      const bindings = {};
      for (const bindingRef of tool.requiredBindings) {
        const value = resolvedBindings && resolvedBindings[bindingRef];
        if (value === undefined || value === null || value === '') throw new Error(`Required binding is unavailable: ${bindingRef}`);
        bindings[bindingRef] = value;
      }
      const providerContext = Object.freeze({ ...context, bindings: Object.freeze(bindings) });
      let timer;
      const output = await Promise.race([
        Promise.resolve().then(() => tool.handler(args, providerContext)),
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
