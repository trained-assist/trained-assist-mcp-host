'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

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
    requiredBindings: [...new Set(tool.requiredBindings || [])],
    providerId,
    handler: tool.handler,
  };
}

function createCatalog(providers = []) {
  const byName = new Map();
  const providerIds = new Set();
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
      throw new TypeError('Every provider needs a stable id');
    }
    if (typeof provider.version !== 'string' || !provider.version.trim()) {
      throw new TypeError(`Provider ${provider.id} needs a pinned version`);
    }
    if (providerIds.has(provider.id)) throw new TypeError(`Duplicate provider id ${provider.id}`);
    providerIds.add(provider.id);
    for (const declared of provider.tools || []) {
      const tool = validateTool(declared, provider.id);
      if (tool.requiredBindings.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,300}$/.test(id))) {
        throw new TypeError(`Provider ${provider.id} tool ${tool.name} has an invalid binding ref`);
      }
      const previous = byName.get(tool.name);
      if (previous) {
        throw Object.assign(new Error(`Duplicate MCP tool ${tool.name} (${previous.providerId}, ${tool.providerId})`), {
          code: 'DUPLICATE_TOOL',
        });
      }
      byName.set(tool.name, tool);
    }
  }
  const digestInput = [...byName.values()].map(({ name, description, inputSchema, providerId, requiredBindings }) => ({
    name, description, inputSchema, providerId, requiredBindings,
    providerVersion: providers.find((provider) => provider.id === providerId).version,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const digest = crypto.createHash('sha256').update(canonical(digestInput)).digest('hex');
  return {
    digest,
    list: (allowedTools) => [...byName.values()]
      .filter((tool) => !allowedTools || allowedTools.includes(tool.name))
      .map(({ handler, providerId, requiredBindings, ...definition }) => definition),
    get: (name) => byName.get(name) || null,
  };
}

module.exports = { createCatalog };
