'use strict';

function validateTool(tool, providerId) {
  if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
    throw new TypeError(`Provider ${providerId} has a tool without a name`);
  }
  if (typeof tool.handler !== 'function') {
    throw new TypeError(`Provider ${providerId} tool ${tool.name} has no handler`);
  }
  return {
    name: tool.name,
    description: String(tool.description || ''),
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    providerId,
    handler: tool.handler,
  };
}

function createCatalog(providers = []) {
  const byName = new Map();
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw new TypeError('Every provider needs a stable id');
    }
    for (const declared of provider.tools || []) {
      const tool = validateTool(declared, provider.id);
      const previous = byName.get(tool.name);
      if (previous) {
        throw Object.assign(new Error(`Duplicate MCP tool ${tool.name} (${previous.providerId}, ${tool.providerId})`), {
          code: 'DUPLICATE_TOOL',
        });
      }
      byName.set(tool.name, tool);
    }
  }
  return {
    list: () => [...byName.values()].map(({ handler, providerId, ...definition }) => definition),
    get: (name) => byName.get(name) || null,
  };
}

module.exports = { createCatalog };
