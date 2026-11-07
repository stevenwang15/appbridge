'use strict';

// 任务存储：一条后台任务 = jobs/<id>/{meta,status,log}
const fs = require('node:fs');
const path = require('node:path');

function jobsDir(root) {
  return path.join(root, 'jobs');
}

function paths(root, id) {
  const dir = path.join(jobsDir(root), id);
  return {
    dir,
    meta: path.join(dir, 'meta.json'),
    status: path.join(dir, 'status.json'),
    log: path.join(dir, 'log.txt'),
  };
}

function newJobId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function createJob(root, meta) {
  const id = newJobId();
  const p = paths(root, id);
  fs.mkdirSync(p.dir, { recursive: true });
  writeJSON(p.meta, meta);
  writeJSON(p.status, { id, state: 'queued', createdAt: new Date().toISOString(), steps: [] });
  return id;
}

function updateMeta(root, id, patch) {
  const p = paths(root, id);
  writeJSON(p.meta, { ...readJSON(p.meta, {}), ...patch });
}

function readStatus(root, id) {
  return readJSON(paths(root, id).status, null);
}

function updateStatus(root, id, patch) {
  const current = readStatus(root, id) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeJSON(paths(root, id).status, next);
  return next;
}

function appendLog(root, id, line) {
  try {
    fs.appendFileSync(paths(root, id).log, `${line}\n`);
  } catch {
    /* 日志写失败不影响任务 */
  }
}

function readLog(root, id, maxLines = 200) {
  try {
    const lines = fs.readFileSync(paths(root, id).log, 'utf8').split('\n');
    return lines.slice(-maxLines).join('\n').trimEnd();
  } catch {
    return '';
  }
}

function listJobs(root) {
  const dir = jobsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .map((id) => {
      const p = paths(root, id);
      const meta = readJSON(p.meta, {});
      return { id, recipe: meta.recipe || '-', ...(readStatus(root, id) || {}) };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function isFinished(status) {
  return Boolean(status && (status.state === 'done' || status.state === 'failed' || status.state === 'killed'));
}

module.exports = {
  ROOT_JOBS: 'jobs',
  createJob,
  updateMeta,
  readStatus,
  updateStatus,
  appendLog,
  readLog,
  listJobs,
  isFinished,
  paths,
};
