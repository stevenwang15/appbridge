'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MCP = path.join(__dirname, '..', 'bin', 'mcp.js');

function session(requests, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP 会话超时: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });

    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

function parseMessages(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test('MCP：握手 / 工具列表 / 调用工具', async () => {
  const { stdout, stderr } = await session([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: '通了' } } },
  ]);

  assert.strictEqual(stderr, '');
  const messages = parseMessages(stdout);
  const byId = new Map(messages.map((m) => [m.id, m]));

  const init = byId.get(1);
  assert.ok(init, '缺少 initialize 响应');
  assert.strictEqual(init.result.protocolVersion, '2024-11-05');
  assert.strictEqual(init.result.serverInfo.name, 'appbridge');
  assert.ok(init.result.capabilities.tools);

  const list = byId.get(2);
  assert.ok(Array.isArray(list.result.tools));
  assert.ok(list.result.tools.length >= 40, `工具太少: ${list.result.tools.length}`);
  for (const tool of list.result.tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]+$/, `工具名不合法: ${tool.name}`);
    assert.strictEqual(tool.inputSchema.type, 'object');
    assert.strictEqual(typeof tool.description, 'string');
  }

  const call = byId.get(3);
  assert.strictEqual(call.result.content[0].text, '通了');
});

test('MCP：点号工具名会被映射回内核名', async () => {
  const { stdout } = await session([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fs_list', arguments: { path: process.cwd() } },
    },
  ]);
  const messages = parseMessages(stdout);
  const call = messages.find((m) => m.id === 2);
  assert.ok(call.result && !call.result.isError, `调用失败: ${JSON.stringify(call)}`);
  const listing = JSON.parse(call.result.content[0].text);
  assert.ok(Array.isArray(listing));
  assert.ok(listing.includes('package.json'));
});

test('MCP：不存在的工具返回错误', async () => {
  const { stdout } = await session([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } },
  ]);
  const message = parseMessages(stdout).find((m) => m.id === 1);
  assert.strictEqual(message.error.code, -32602);
});

test('MCP：工具调用失败用 isError 回报，不炸进程', async () => {
  const { stdout } = await session([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fs_read', arguments: { path: '/etc/hosts' } },
    },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ]);
  const messages = parseMessages(stdout);
  const failed = messages.find((m) => m.id === 1);
  assert.strictEqual(failed.result.isError, true);
  assert.ok(messages.find((m) => m.id === 2), '后续请求应该还能处理');
});
