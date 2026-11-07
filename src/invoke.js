'use strict';

// 工具调用器：查表 → 补参数 → 解析成具体调用 → 查范围 → 执行 → 记账
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

const { subst, coerce } = require('./subst');
const office = require('./office');
const csvLib = require('./csv');
const { readEntries, readEntry } = require('./zip');
const { APP_ROOT, PLATFORM, loadConfig, flattenConfig, expandHome } = require('./config');

const ROOT = path.join(__dirname, '..');
const DEFAULT_REGISTRY = process.env.APPBRIDGE_TOOLS
  ? path.resolve(process.env.APPBRIDGE_TOOLS)
  : path.join(ROOT, 'tools.json');
const DEFAULT_POLICY = process.env.APPBRIDGE_POLICY
  ? path.resolve(process.env.APPBRIDGE_POLICY)
  : path.join(ROOT, 'policy.json');

const META_KEYS = new Set(['desc', 'params', 'kind', 'enabled', 'meta']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', 'dist', 'build', '.next', '.venv', '__pycache__']);

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 路径范围：目录当整棵子树用；".../**" 也当整棵子树用。
function matchPattern(pattern, target, base) {
  const root = path.resolve(base || process.cwd());
  const p = path.resolve(root, pattern);
  const t = path.resolve(root, target);
  if (p.endsWith(path.sep + '**')) {
    const prefix = p.slice(0, -3);
    return t === prefix || t.startsWith(prefix + path.sep);
  }
  return t === p || t.startsWith(p + path.sep);
}

function resolveParams(toolName, tool, given, configVars) {
  const specs = tool.params || {};
  const params = {};
  for (const [key, spec] of Object.entries(specs)) {
    const provided = given && Object.prototype.hasOwnProperty.call(given, key);
    let value = provided
      ? given[key]
      : typeof spec.default === 'string'
        ? subst(spec.default, configVars || {})
        : spec.default;
    if ((value === undefined || value === null) && spec.required) {
      throw new Error(`工具 ${toolName} 缺少参数: ${key}`);
    }
    if (value === undefined || value === null) {
      value = spec.type === 'array' ? [] : spec.type === 'boolean' ? false : '';
    }
    value = coerce(spec, value);
    if (typeof value === 'string') value = expandHome(value);
    params[key] = value;
  }
  for (const [key, value] of Object.entries(given || {})) {
    if (!(key in specs)) params[key] = value;
  }
  return params;
}

// 把工具声明里的 {{参数}} 解析成一次具体的调用
function buildPlan(tool, params, configVars) {
  const vars = { ...params, ...(configVars || {}) };
  const plan = { kind: tool.kind };
  for (const [key, value] of Object.entries(tool)) {
    if (META_KEYS.has(key) || key === 'platform') continue;
    plan[key] = subst(value, vars);
  }
  return plan;
}

// 范围配置里的路径也支持 {{config.vault}} 和 ~，base 固定相对程序目录（与 cwd 无关）
function normalizePolicy(raw, configVars) {
  const expand = (value) => (typeof value === 'string' ? expandHome(subst(value, configVars || {})) : value);
  const base = expand(raw.base === undefined ? '.' : raw.base);
  return {
    base: path.resolve(APP_ROOT, base || '.'),
    allowExec: raw.allowExec || [],
    allowRead: (raw.allowRead || []).map(expand),
    allowWrite: (raw.allowWrite || []).map(expand),
    allowNet: raw.allowNet || [],
  };
}

const PATH_KINDS = new Set(['fs', 'office', 'zip', 'csv']);

function checkPermission(policy, toolName, plan) {
  const outOfScope = (msg) => {
    throw new Error(`[范围] ${toolName}: ${msg}`);
  };
  const readList = policy.allowRead || [];
  const writeList = policy.allowWrite || [];
  const checkPath = (target, list, label, field) => {
    if (!target) return;
    if (!list.some((p) => matchPattern(p, target, policy.base))) {
      outOfScope(`${label}不在 ${field} 中: ${path.resolve(policy.base || '.', String(target))}`);
    }
  };

  if (PATH_KINDS.has(plan.kind) && !plan.path) outOfScope('缺少 path');

  // path 按读/写判断；src 只读；dest 只写
  if (plan.path && (PATH_KINDS.has(plan.kind) || plan.writes !== undefined)) {
    if (plan.writes === true) checkPath(plan.path, writeList, '写入路径', 'allowWrite');
    else checkPath(plan.path, readList, '读取路径', 'allowRead');
  }
  if (plan.src) checkPath(plan.src, readList, '源路径', 'allowRead');
  if (plan.dest) checkPath(plan.dest, writeList, '目标路径', 'allowWrite');

  if (plan.kind === 'cli') {
    const cmd = path.basename(String(plan.command || ''));
    if (!(policy.allowExec || []).includes(cmd)) outOfScope(`命令不在 allowExec 中: ${cmd}`);
  }

  if (plan.kind === 'http') {
    let host;
    try {
      host = new URL(String(plan.url)).hostname;
    } catch {
      outOfScope(`URL 非法: ${plan.url}`);
    }
    if (!(policy.allowNet || []).includes(host)) outOfScope(`网络目标不在 allowNet 中: ${host}`);
  }
}

function walkFiles(root, limit, out = []) {
  if (out.length >= limit) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, limit, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

// 路径展示：在 cwd 内用相对路径，在外用绝对路径（避免一堆 ../../..）
function displayPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith('..') ? path.resolve(file) : rel;
}

function runFsFind(plan) {
  const root = String(plan.path || '.');
  const ext = String(plan.ext || '').replace(/^\./, '');
  const limit = Number(plan.limit || 200);
  return walkFiles(root, 5000)
    .filter((file) => !ext || file.endsWith(`.${ext}`))
    .slice(0, limit)
    .map((file) => displayPath(file));
}

function runFsSearch(plan) {
  const root = String(plan.path || '.');
  const limit = Number(plan.limit || 50);
  let re;
  try {
    re = new RegExp(String(plan.pattern));
  } catch {
    throw new Error(`正则不合法: ${plan.pattern}`);
  }
  const hits = [];
  for (const file of walkFiles(root, 5000)) {
    if (hits.length >= limit) break;
    let text;
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) {
        hits.push(`${displayPath(file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

function runFsTags(plan) {
  const root = String(plan.path || '.');
  const limit = Number(plan.limit || 100);
  const counts = new Map();
  for (const file of walkFiles(root, 20000)) {
    if (!file.endsWith('.md')) continue;
    let text;
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/(?:^|[\s(（])#([\p{L}\p{N}_/-]+)/gu)) {
      const tag = match[1];
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function runFsBacklinks(plan) {
  const root = String(plan.path || '.');
  const note = String(plan.note || '');
  if (!note) throw new Error('缺少 note');
  const limit = Number(plan.limit || 100);
  const needle = note.replace(/\.md$/, '');
  const hits = [];
  for (const file of walkFiles(root, 20000)) {
    if (!file.endsWith('.md')) continue;
    let text;
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes(`[[${needle}]]`) || text.includes(`[[${needle}|`) || text.includes(`[[${needle}#`)) {
      hits.push(displayPath(file));
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

function runFs(plan) {
  const target = String(plan.path);
  const op = plan.op || 'read';
  if (op === 'read') return fs.readFileSync(target, 'utf8');
  if (op === 'list') return fs.readdirSync(target).sort();
  if (op === 'find') return runFsFind(plan);
  if (op === 'search') return runFsSearch(plan);
  if (op === 'tags') return runFsTags(plan);
  if (op === 'backlinks') return runFsBacklinks(plan);
  if (op === 'write' || op === 'append') {
    const content = plan.content === undefined ? '' : String(plan.content);
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    if (op === 'append') fs.appendFileSync(target, content);
    else fs.writeFileSync(target, content);
    return { path: path.resolve(target), bytes: Buffer.byteLength(content) };
  }
  throw new Error(`未知 fs 操作: ${op}`);
}

function runText(plan) {
  const op = plan.op || 'join';
  const items = Array.isArray(plan.items) ? plan.items : plan.items === undefined ? [] : [plan.items];
  if (op === 'join') {
    const sep = plan.sep === undefined ? '\n' : String(plan.sep);
    return items.map((item) => (typeof item === 'string' ? item : String(item))).join(sep);
  }
  if (op === 'upper') return String(plan.text || '').toUpperCase();
  throw new Error(`未知 text 操作: ${op}`);
}

function runJson(plan) {
  const op = plan.op || 'get';
  if (op === 'get') {
    const keys = String(plan.path || '').split('.').filter(Boolean);
    let current = plan.data;
    for (const key of keys) {
      if (current === null || current === undefined) return null;
      current = current[key];
    }
    return current === undefined ? null : current;
  }
  throw new Error(`未知 json 操作: ${op}`);
}

function runDelay(plan) {
  const ms = Math.max(0, Number(plan.ms) || 0);
  return new Promise((resolve) => {
    setTimeout(() => resolve(`等了 ${ms}ms`), ms);
  });
}

function runCli(plan) {
  const command = String(plan.command || '');
  const args = Array.isArray(plan.args) ? plan.args.map(String) : [];
  const cwd = path.resolve(String(plan.cwd || '.'));
  const timeout = Number(plan.timeout || 60000);
  const input = plan.stdin === undefined ? null : String(plan.stdin);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} 超时（${timeout}ms）`));
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${command} 启动失败: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = String(stderr).trim() || String(stdout).trim();
        return reject(new Error(`${command} 退出码 ${code}: ${detail.slice(0, 500)}`));
      }
      resolve(stdout.replace(/\n$/, ''));
    });

    child.stdin.end(input === null ? '' : input);
  });
}

function runHttp(plan) {
  const url = new URL(String(plan.url || ''));
  const lib = url.protocol === 'https:' ? https : http;
  const method = String(plan.method || 'GET').toUpperCase();
  const timeout = Number(plan.timeout || 10000);

  const bodySource = plan.body;
  const payload =
    bodySource === undefined || bodySource === null
      ? null
      : typeof bodySource === 'string'
        ? bodySource
        : JSON.stringify(bodySource);

  const headers = { ...(plan.headers || {}) };
  if (payload !== null) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, timeout, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (text.length > 4_000_000) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => {
        let body = text;
        if (plan.parse === 'json') {
          try {
            body = JSON.parse(text);
          } catch {
            /* 解析失败就保留原文 */
          }
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP 超时')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function runZip(plan) {
  const buffer = fs.readFileSync(plan.path);
  const op = plan.op || 'list';
  if (op === 'list') return office.zipList(buffer);
  if (op === 'read') {
    const wanted = String(plan.entry || '');
    const entries = readEntries(buffer);
    const entry = entries.find((e) => e.name === wanted);
    if (!entry) throw new Error(`压缩包里没有: ${wanted}`);
    const data = readEntry(buffer, entry);
    const text = data.toString('utf8');
    return text.includes('\u0000') ? { bytes: data.length } : text;
  }
  if (op === 'extract') {
    const dest = path.resolve(String(plan.dest || '.'));
    const entries = readEntries(buffer);
    fs.mkdirSync(dest, { recursive: true });
    const written = [];
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      const target = path.resolve(dest, entry.name);
      if (target !== dest && !target.startsWith(dest + path.sep)) continue; // 防目录穿越
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, readEntry(buffer, entry));
      written.push(entry.name);
    }
    return { dest, count: written.length, files: written.slice(0, 200) };
  }
  throw new Error(`未知 zip 操作: ${op}`);
}

function runOffice(plan) {
  const op = plan.op || '';
  if (op === 'docx-read') return office.docxRead(fs.readFileSync(plan.path));
  if (op === 'docx-write') {
    const buffer = office.docxWrite(plan.text === undefined ? '' : String(plan.text));
    fs.mkdirSync(path.dirname(path.resolve(String(plan.path))), { recursive: true });
    fs.writeFileSync(plan.path, buffer);
    return { path: path.resolve(String(plan.path)), bytes: buffer.length };
  }
  if (op === 'xlsx-read') return office.xlsxRead(fs.readFileSync(plan.path));
  if (op === 'pptx-read') return office.pptxRead(fs.readFileSync(plan.path));
  throw new Error(`未知 office 操作: ${op}`);
}

function runCsv(plan) {
  const op = plan.op || 'read';
  if (op === 'read') {
    const text = fs.readFileSync(plan.path, 'utf8');
    const header = plan.header === true || plan.header === 'true';
    const rows = csvLib.parse(text, { header });
    return { rows, count: rows.length };
  }
  throw new Error(`未知 csv 操作: ${op}`);
}

function execute(plan) {
  switch (plan.kind) {
    case 'echo':
      return Promise.resolve(plan.template);
    case 'text':
      return Promise.resolve(runText(plan));
    case 'json':
      return Promise.resolve(runJson(plan));
    case 'fs':
      return Promise.resolve(runFs(plan));
    case 'cli':
      return runCli(plan);
    case 'http':
      return runHttp(plan).then((result) => {
        if (plan.allowError !== true && result.status >= 400) {
          const detail =
            typeof result.body === 'string' ? result.body.slice(0, 300) : JSON.stringify(result.body).slice(0, 300);
          throw new Error(`HTTP ${result.status}: ${detail}`);
        }
        if (plan.unwrap && result.status >= 200 && result.status < 300) {
          const keys = String(plan.unwrap).split('.').filter(Boolean);
          let current = result;
          for (const key of keys) {
            if (current === null || current === undefined) return null;
            current = current[key];
          }
          return current === undefined ? null : current;
        }
        return result;
      });
    case 'delay':
      return runDelay(plan);
    case 'zip':
      return Promise.resolve(runZip(plan));
    case 'office':
      return Promise.resolve(runOffice(plan));
    case 'csv':
      return Promise.resolve(runCsv(plan));
    default:
      return Promise.reject(new Error(`未知工具类型: ${plan.kind}`));
  }
}

function createInvoker(options = {}) {
  const config = options.config || loadConfig();
  const configVars = flattenConfig(config);
  const registry = options.registry
    ? { ...options.registry }
    : { ...loadJSON(options.registryFile || DEFAULT_REGISTRY).tools };
  let policy = normalizePolicy(
    options.policy || loadJSON(options.policyFile || DEFAULT_POLICY),
    configVars,
  );
  const auditFile = options.auditFile || null;

  function audit(entry) {
    if (!auditFile) return;
    try {
      fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
    } catch {
      /* 审计失败不影响主流程 */
    }
  }

  async function call(name, given = {}, callOptions = {}) {
    const tool = registry[name];
    if (!tool) throw new Error(`没有这个工具: ${name}`);
    if (tool.enabled === false) throw new Error(`工具已禁用: ${name}`);

    if (tool.platform && !tool.platform.includes(PLATFORM)) {
      throw new Error(`工具 ${name} 不支持 ${PLATFORM}（需要 ${tool.platform.join('/')}）`);
    }

    const params = resolveParams(name, tool, given, configVars);
    const plan = buildPlan(tool, params, configVars);
    // 相对路径统一挂到 policy.base 上：范围检查和实际执行必须是同一个根，
    // 否则结果会随“从哪个目录启动”而变。
    // 只有真的碰文件系统的类型才归一化路径（json.get 的 path 是取值表达式，不能动）
    if (PATH_KINDS.has(plan.kind) && plan.path) plan.path = path.resolve(policy.base, String(plan.path));
    if (plan.kind === 'cli' && plan.path) plan.path = path.resolve(policy.base, String(plan.path));
    if (plan.src) plan.src = path.resolve(policy.base, String(plan.src));
    if (plan.dest) plan.dest = path.resolve(policy.base, String(plan.dest));
    if (plan.kind === 'cli') plan.cwd = path.resolve(policy.base, String(plan.cwd || '.'));
    checkPermission(policy, name, plan);

    if (callOptions.dry) return { ok: true, dry: true, tool: name, plan };

    const startedAt = Date.now();
    try {
      const data = await execute(plan);
      const ms = Date.now() - startedAt;
      audit({ ts: new Date().toISOString(), tool: name, plan, ok: true, ms });
      return { ok: true, tool: name, data, ms, plan };
    } catch (err) {
      const ms = Date.now() - startedAt;
      audit({ ts: new Date().toISOString(), tool: name, plan, ok: false, error: err.message, ms });
      throw err;
    }
  }

  return {
    call,
    get: (name) => registry[name],
    list: () =>
      Object.entries(registry).map(([name, tool]) => ({
        name,
        desc: tool.desc,
        kind: tool.kind,
        enabled: tool.enabled !== false,
        platform: tool.platform || null,
        runnable: tool.enabled !== false && (!tool.platform || tool.platform.includes(PLATFORM)),
      })),
    getConfig: () => config,
    register: (name, tool) => {
      registry[name] = tool;
    },
    getPolicy: () => policy,
    setPolicy: (next) => {
      policy = normalizePolicy(next, configVars);
    },
    has: (name) => Boolean(registry[name]),
  };
}

module.exports = { createInvoker, buildPlan, checkPermission, matchPattern, resolveParams, normalizePolicy };
