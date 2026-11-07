'use strict';

// MCP 外壳的纯逻辑部分，方便单测（不碰 stdin/stdout）。
const TOOL_NAME_SAFE = /[^a-zA-Z0-9_-]/g;

function sanitizeToolName(name) {
  return String(name).replace(TOOL_NAME_SAFE, '_');
}

function buildToolList(invoker) {
  const tools = [];
  for (const item of invoker.list()) {
    const tool = invoker.get(item.name);
    if (tool.enabled === false) continue;

    const properties = {};
    const required = [];
    for (const [key, spec] of Object.entries(tool.params || {})) {
      const type = spec.type === 'number' ? 'number' : spec.type === 'boolean' ? 'boolean' : spec.type === 'array' ? 'array' : 'string';
      const property = { type, description: spec.description || '' };
      if (type === 'array') property.items = { type: 'string' };
      properties[key] = property;
      if (spec.required) required.push(key);
    }

    const notes = item.platform ? `（仅 ${item.platform.join('/')}）` : '';
    tools.push({
      name: sanitizeToolName(item.name),
      original: item.name,
      description: `${tool.desc || item.name}${notes}`,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: true,
      },
    });
  }
  return tools;
}

module.exports = { sanitizeToolName, buildToolList };
