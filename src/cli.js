#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInvoker } = require('./invoke');
const { loadRecipe, runRecipe, listRecipes } = require('./recipe');
const jobs = require('./jobs');
const { runDoctor } = require('./doctor');
const { PLATFORM } = require('./config');

const ROOT = process.env.APPBRIDGE_HOME ? path.resolve(process.env.APPBRIDGE_HOME) : path.join(__dirname, '..');
const RECIPE_DIR = process.env.APPBRIDGE_RECIPE_DIR ? path.resolve(process.env.APPBRIDGE_RECIPE_DIR) : path.join(ROOT, 'recipes');
const WORKER = path.join(__dirname, 'worker.js');

function parseArgv(argv) {
  const out = { _: [], set: {}, yes: false, dry: false, json: false, asyncy: false, timeout: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--yes' || token === '-y') out.yes = true;
    else if (token === '--dry') out.dry = true;
    else if (token === '--json') out.json = true;
    else if (token === '--async') out.asyncy = true;
    else if (token === '--timeout') out.timeout = Number(argv[++i] || 0);
    else if (token === '--set' || token === '-s') {
      const kv = argv[++i] || '';
      const at = kv.indexOf('=');
      if (at > 0) out.set[kv.slice(0, at)] = kv.slice(at + 1);
    } else out._.push(token);
  }
  return out;
}

function short(value, limit = 220) {
  if (value === null || value === undefined) return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replace(/\n/g, ' ⏎ ');
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function printStep(step) {
  const head = step.ok ? '▸' : '✗';
  const tag = step.kind === 'parallel' ? ' [并行组]' : '';
  console.log(`  ${head} ${step.index}. ${step.id}${tag} ${step.tool ? `(${step.tool})` : ''} — ${step.ms === undefined ? '' : `${step.ms}ms`}`);
  if (step.ok) {
    if (step.kind === 'parallel') {
      for (const [key, value] of Object.entries(step.output || {})) console.log(`      ${key}: ${short(value)}`);
    } else {
      console.log(`      ${short(step.output)}`);
    }
  } else {
    console.log(`      ${step.error}`);
  }
}

function printStatus(status, id) {
  const stateMap = { queued: '排队中', running: '运行中', done: '完成', failed: '失败', killed: '已终止' };
  console.log(`任务 ${id}`);
  console.log(`  状态: ${stateMap[status.state] || status.state}`);
  if (status.error) console.log(`  错误: ${status.error}`);
  const steps = status.steps || [];
  if (steps.length > 0) {
    const okCount = steps.filter((s) => s.ok).length;
    console.log(`  步骤: ${okCount}/${steps.length} 成功`);
    for (const step of steps) printStep(step);
  }
}

async function cmdRun(argv) {
  const [name] = argv._;
  if (!name) {
    console.error('用法: appbridge run <配方名> [--set k=v] [--yes] [--dry] [--async]');
    process.exit(2);
  }

  if (argv.asyncy) {
    const id = jobs.createJob(ROOT, { recipe: name, set: argv.set });
    const child = spawn(process.execPath, [WORKER, id, name, JSON.stringify(argv.set)], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    jobs.updateMeta(ROOT, id, { pid: child.pid });
    jobs.appendLog(ROOT, id, `[${new Date().toISOString()}] 已派发 pid=${child.pid}`);
    console.log(`已派发: ${id}`);
    console.log(`查看进度: node src/cli.js job ${id}`);
    return;
  }

  const recipe = loadRecipe(name, RECIPE_DIR);
  const invoker = createInvoker({ auditFile: path.join(ROOT, 'audit.jsonl') });
  console.log(`运行配方: ${recipe.name}${argv.dry ? '（演练，不真正执行）' : ''}`);
  const result = await runRecipe(recipe, invoker, {
    set: argv.set,
    yes: argv.yes,
    dry: argv.dry,
    onStep: printStep,
  });
  console.log(result.ok ? '完成' : `失败: ${result.error}`);
  if (argv.json) console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

function cmdJobs() {
  const list = jobs.listJobs(ROOT);
  if (list.length === 0) {
    console.log('没有后台任务');
    return;
  }
  for (const job of list) {
    const steps = job.steps || [];
    const ok = steps.filter((s) => s.ok).length;
    console.log(`${job.id}  ${String(job.state).padEnd(8)} ${job.recipe || '-'}  ${ok}/${steps.length} 步  ${job.createdAt || ''}`);
  }
}

function cmdJob(id) {
  if (!id) {
    console.error('用法: appbridge job <id>');
    process.exit(2);
  }
  const status = jobs.readStatus(ROOT, id);
  if (!status) {
    console.error(`没有这个任务: ${id}`);
    process.exit(1);
  }
  printStatus(status, id);
  const log = jobs.readLog(ROOT, id, 40);
  if (log) console.log(`\n--- 日志 ---\n${log}`);
}

async function cmdWait(id, timeoutMs) {
  if (!id) {
    console.error('用法: appbridge wait <id> [--timeout 毫秒]');
    process.exit(2);
  }
  const deadline = Date.now() + (timeoutMs || 60000);
  for (;;) {
    const status = jobs.readStatus(ROOT, id);
    if (!status) {
      console.error(`没有这个任务: ${id}`);
      process.exit(1);
    }
    if (jobs.isFinished(status)) {
      printStatus(status, id);
      process.exit(status.state === 'done' ? 0 : 1);
    }
    if (Date.now() > deadline) {
      console.error('等待超时');
      process.exit(124);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function cmdKill(id) {
  if (!id) {
    console.error('用法: appbridge kill <id>');
    process.exit(2);
  }
  const status = jobs.readStatus(ROOT, id);
  if (!status) {
    console.error(`没有这个任务: ${id}`);
    process.exit(1);
  }
  if (jobs.isFinished(status)) {
    console.log(`任务已结束（${status.state}），无需终止`);
    return;
  }
  try {
    const meta = JSON.parse(require('node:fs').readFileSync(jobs.paths(ROOT, id).meta, 'utf8'));
    if (meta.pid) process.kill(meta.pid, 'SIGTERM');
  } catch (err) {
    console.error(`终止失败: ${err.message}`);
  }
  jobs.updateStatus(ROOT, id, { state: 'killed', finishedAt: new Date().toISOString() });
  console.log(`已终止 ${id}`);
}

async function cmdCall(argv) {
  const [name] = argv._;
  if (!name) {
    console.error('用法: appbridge call <工具> [--set k=v] [--dry]');
    process.exit(2);
  }
  const invoker = createInvoker({ auditFile: path.join(ROOT, 'audit.jsonl') });
  const result = await invoker.call(name, argv.set, { dry: argv.dry });
  if (argv.dry) {
    console.log(JSON.stringify(result.plan, null, 2));
    return;
  }
  console.log(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2));
  console.error(`(${result.ms}ms)`);
}

async function cmdDoctor() {
  const invoker = createInvoker({});
  const { config, rows } = await runDoctor(invoker);
  const ok = rows.filter((r) => r.ok);
  const bad = rows.filter((r) => !r.ok);

  console.log(`平台: ${PLATFORM}  Node: ${process.version}`);
  console.log(`知识库: ${config.vault}`);
  console.log(`默认模型: ${config.model}`);
  console.log('');
  console.log(`可用 (${ok.length})`);
  for (const row of ok) {
    console.log(`  ✓ ${row.name.padEnd(14)} ${String(row.kind).padEnd(6)} ${row.note || ''}`);
  }
  if (bad.length > 0) {
    console.log('');
    console.log(`不可用 (${bad.length})`);
    for (const row of bad) {
      console.log(`  ✗ ${row.name.padEnd(14)} ${String(row.kind).padEnd(6)} ${row.reason || ''}`);
    }
  }
  console.log('');
  console.log(`合计 ${ok.length}/${rows.length} 个工具在这台机器上可用`);
}

function cmdTools() {  const invoker = createInvoker({});
  for (const tool of invoker.list()) {
    console.log(`${tool.name.padEnd(14)} ${String(tool.kind).padEnd(7)} ${tool.desc || ''}`);
  }
}

function cmdRecipes() {
  const list = listRecipes(RECIPE_DIR);
  if (list.length === 0) {
    console.log('recipes/ 目录是空的');
    return;
  }
  for (const recipe of list) {
    console.log(`${recipe.name.padEnd(16)} ${String(recipe.steps).padStart(2)} 步  ${recipe.when || ''}`);
  }
}

function cmdHelp() {
  console.log(`appbridge — 工具调用器 + 配方执行器

  node src/cli.js doctor                     体检：这台机器上哪些工具能用
  node src/cli.js tools                      列出工具
  node src/cli.js call <工具> [--set k=v]     直接调一个工具
  node src/cli.js recipes                    列出配方
  node src/cli.js run <配方> [--set k=v]      前台跑
  node src/cli.js run <配方> --dry            只看要调什么，不执行
  node src/cli.js run <配方> --async          后台跑，立刻返回任务号
  node src/cli.js jobs                       列出后台任务
  node src/cli.js job <id>                   看某个任务
  node src/cli.js wait <id>                  等它跑完
  node src/cli.js kill <id>                  终止`);
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const [command, ...rest] = argv._;
  argv._ = rest;

  switch (command) {
    case 'run':
      return cmdRun(argv);
    case 'jobs':
      return cmdJobs();
    case 'job':
      return cmdJob(rest[0]);
    case 'wait':
      return cmdWait(rest[0], argv.timeout);
    case 'kill':
      return cmdKill(rest[0]);
    case 'tools':
      return cmdTools();
    case 'recipes':
      return cmdRecipes();
    case 'call':
      return cmdCall(argv);
    case 'doctor':
      return cmdDoctor();
    default:
      return cmdHelp();
  }
}

main().catch((err) => {
  console.error(`出错: ${err.message}`);
  process.exit(1);
});
