'use strict';

// 配置加载：config.json（可移植默认值） ← config.local.json（本机覆盖） ← 环境变量
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const PLATFORM = process.env.APPBRIDGE_PLATFORM || process.platform;

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base === undefined ? patch : patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && prev && typeof prev === 'object' && !Array.isArray(prev)
        ? deepMerge(prev, value)
        : value;
  }
  return out;
}

// 环境变量覆盖：APPBRIDGE_VAULT / APPBRIDGE_MODEL / APPBRIDGE_CONFIG
function envOverrides() {
  const out = {};
  if (process.env.APPBRIDGE_VAULT) out.vault = process.env.APPBRIDGE_VAULT;
  if (process.env.APPBRIDGE_MODEL) out.model = process.env.APPBRIDGE_MODEL;
  return out;
}

// 配置来源（后者覆盖前者）：
//   包内 config.json（默认值）
//   → 包内 config.local.json（开发机）
//   → 当前目录 config.local.json（使用者，安装后也能改）
//   → APPBRIDGE_CONFIG 指定的文件
//   → 环境变量
function configCandidates() {
  const list = [
    path.join(APP_ROOT, 'config.json'),
    path.join(APP_ROOT, 'config.local.json'),
    path.join(process.cwd(), 'config.local.json'),
  ];
  if (process.env.APPBRIDGE_CONFIG) list.push(path.resolve(process.env.APPBRIDGE_CONFIG));
  return list;
}

function loadConfig() {
  let merged = {};
  for (const file of configCandidates()) merged = deepMerge(merged, readJSON(file, {}));
  return deepMerge(merged, envOverrides());
}

// 把嵌套配置摊平成 "config.vault" 这样的键，供 {{config.vault}} 使用
function flattenConfig(config, prefix = 'config', out = {}) {
  for (const [key, value] of Object.entries(config || {})) {
    const full = `${prefix}.${key}`;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenConfig(value, full, out);
    else out[full] = value;
  }
  return out;
}

module.exports = { APP_ROOT, PLATFORM, loadConfig, flattenConfig, expandHome, deepMerge, readJSON };
