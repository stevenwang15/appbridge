'use strict';

// 体检：这台机器上哪些工具真的能用，哪些缺什么
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { subst } = require('./subst');
const { expandHome, flattenConfig, PLATFORM } = require('./config');

function which(command) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

function probePort(host, port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

function resolveDefault(value, configVars) {
  if (typeof value !== 'string') return null;
  const expanded = expandHome(subst(value, configVars));
  return expanded.includes('{{') ? null : expanded;
}

async function checkTool(tool, configVars) {
  if (tool.enabled === false) return { ok: false, reason: '已禁用' };

  if (tool.platform && !tool.platform.includes(PLATFORM)) {
    return { ok: false, reason: `只支持 ${tool.platform.join(' / ')}` };
  }

  if (tool.kind === 'cli') {
    const command = String(tool.command || '');
    if (!command) return { ok: false, reason: '命令未配置' };
    if (command.includes('{{')) return { ok: true, note: '命令由调用时指定' };
    const found = which(command);
    return found ? { ok: true, note: found } : { ok: false, reason: `找不到命令 ${command}` };
  }

  if (tool.kind === 'http') {
    const url = String(tool.url || '');
    if (!url) return { ok: false, reason: 'URL 未配置' };
    if (url.includes('{{')) return { ok: true, note: 'URL 由调用时指定' };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: `URL 不合法: ${url}` };
    }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    const reachable = await probePort(parsed.hostname, port);
    return reachable
      ? { ok: true, note: `${parsed.hostname}:${port}` }
      : { ok: false, reason: `连不上 ${parsed.hostname}:${port}` };
  }

  if (tool.kind === 'fs') {
    const specs = tool.params || {};
    const key = 'vault' in specs ? 'vault' : 'path' in specs ? 'path' : null;
    if (!key) return { ok: true, note: '路径由调用时指定' };
    const resolved = resolveDefault(specs[key].default, configVars);
    if (!resolved) return { ok: true, note: '路径由调用时指定' };
    return fs.existsSync(resolved)
      ? { ok: true, note: resolved }
      : { ok: false, reason: `路径不存在: ${resolved}` };
  }

  return { ok: true };
}

async function runDoctor(invoker) {
  const config = invoker.getConfig();
  const configVars = flattenConfig(config);
  const rows = [];
  for (const tool of invoker.list()) {
    const raw = invoker.get(tool.name);
    // eslint-disable-next-line no-await-in-loop
    const result = await checkTool(raw, configVars);
    rows.push({ name: tool.name, kind: tool.kind, desc: tool.desc, ...result });
  }
  return { config, rows };
}

module.exports = { runDoctor, which, probePort };
