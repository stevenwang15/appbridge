#!/usr/bin/env node
'use strict';

// 中立的 MCP 外壳。任何支持 MCP 的宿主（DeepSeek Harness / Claude / Cursor / …）
// 都能通过 stdio 接上这 48 个工具，不需要知道 appbridge 的内部结构。
const readline = require('node:readline');
const { createInvoker } = require('../src/invoke');
const { sanitizeToolName, buildToolList } = require('../src/mcp');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'appbridge';
const SERVER_VERSION = '0.1.0';
const MAX_TEXT = 60000;

function buildTools(invoker) {
  const tools = new Map();
  for (const tool of buildToolList(invoker)) tools.set(tool.name, tool);
  return tools;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function dispatch(message, context) {
  const { id, method } = message;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    reply(id, {});
    return;
  }

  if (method === 'tools/list') {
    reply(id, {
      tools: [...context.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
    return;
  }

  if (method === 'tools/call') {
    const params = message.params || {};
    const wanted = String(params.name || '');
    const tool = context.tools.get(wanted) || context.tools.get(sanitizeToolName(wanted));
    if (!tool) {
      fail(id, -32602, `没有这个工具: ${wanted}`);
      return;
    }
    try {
      const result = await context.invoker.call(tool.original, params.arguments || {});
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      reply(id, { content: [{ type: 'text', text: text.slice(0, MAX_TEXT) }] });
    } catch (err) {
      reply(id, { content: [{ type: 'text', text: `出错: ${err.message}` }], isError: true });
    }
    return;
  }

  fail(id, -32601, `不支持的方法: ${method}`);
}

function main() {
  const invoker = createInvoker({ auditFile: process.env.APPBRIDGE_AUDIT || null });
  const context = { invoker, tools: buildTools(invoker) };

  const rl = readline.createInterface({ input: process.stdin });
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const text = line.trim();
    if (text.length === 0) return;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
        return;
      }
      try {
        await dispatch(message, context);
      } catch (err) {
        fail(message.id, -32603, err.message);
      }
    });
  });

  rl.on('close', () => {
    queue.finally(() => process.exit(0));
  });
}

main();
