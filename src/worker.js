#!/usr/bin/env node
'use strict';

// 后台工作进程：被 cli.js 以 detached 方式拉起，跑完把状态写回 jobs/<id>/
const path = require('node:path');
const { createInvoker } = require('./invoke');
const { loadRecipe, runRecipe } = require('./recipe');
const jobs = require('./jobs');

const ROOT = process.env.APPBRIDGE_HOME ? path.resolve(process.env.APPBRIDGE_HOME) : path.join(__dirname, '..');
const RECIPE_DIR = process.env.APPBRIDGE_RECIPE_DIR ? path.resolve(process.env.APPBRIDGE_RECIPE_DIR) : path.join(ROOT, 'recipes');

async function main() {
  const [id, recipeName, setJson] = process.argv.slice(2);
  if (!id || !recipeName) {
    console.error('用法: node worker.js <jobId> <recipe> [setJson]');
    process.exit(2);
  }

  let set = {};
  try {
    set = setJson ? JSON.parse(setJson) : {};
  } catch {
    console.error('set 不是合法 JSON');
    process.exit(2);
  }

  const log = (line) => jobs.appendLog(ROOT, id, `[${new Date().toISOString()}] ${line}`);
  const collected = [];

  const markKilled = () => {
    jobs.updateStatus(ROOT, id, { state: 'killed', finishedAt: new Date().toISOString(), steps: collected });
    log('被终止');
    process.exit(143);
  };
  process.on('SIGTERM', markKilled);
  process.on('SIGINT', markKilled);

  jobs.updateStatus(ROOT, id, { state: 'running', startedAt: new Date().toISOString(), steps: collected });
  log(`开始 ${recipeName} set=${JSON.stringify(set)}`);

  try {
    const recipe = loadRecipe(recipeName, RECIPE_DIR);
    const invoker = createInvoker({ auditFile: path.join(ROOT, 'audit.jsonl') });
    const result = await runRecipe(recipe, invoker, {
      set,
      onStep: (step) => {
        collected.push(step);
        jobs.updateStatus(ROOT, id, { steps: collected });
        log(step.ok ? `ok   ${step.index}. ${step.id} ${step.ms}ms` : `失败 ${step.index}. ${step.id}: ${step.error}`);
      },
    });

    if (result.ok) {
      jobs.updateStatus(ROOT, id, { state: 'done', ok: true, finishedAt: new Date().toISOString(), steps: collected });
      log('完成');
      process.exit(0);
    }
    jobs.updateStatus(ROOT, id, { state: 'failed', ok: false, error: result.error, finishedAt: new Date().toISOString(), steps: collected });
    log(`失败: ${result.error}`);
    process.exit(1);
  } catch (err) {
    jobs.updateStatus(ROOT, id, { state: 'failed', ok: false, error: err.message, finishedAt: new Date().toISOString(), steps: collected });
    log(`异常: ${err.message}`);
    process.exit(1);
  }
}

main();
