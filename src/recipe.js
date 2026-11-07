'use strict';

// 配方执行器：按顺序跑步骤；支持 parallel 组并行；支持 confirm 闸门
const fs = require('node:fs');
const path = require('node:path');
const { subst, coerce } = require('./subst');
const { flattenConfig } = require('./config');

function builtins() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    stamp: String(Math.floor(d.getTime() / 1000)),
    cwd: process.cwd(),
  };
}

function recipeFile(name, dir) {
  return path.join(dir, name.endsWith('.json') ? name : `${name}.json`);
}

function loadRecipe(name, dir) {
  const file = recipeFile(name, dir);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error(`配方 ${name} 没有步骤`);
  }
  return { ...raw, file };
}

function listRecipes(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { name: raw.name || f.replace(/\.json$/, ''), when: raw.when || '', steps: (raw.steps || []).length, file: f };
      } catch {
        return { name: f.replace(/\.json$/, ''), when: '(解析失败)', steps: 0, file: f };
      }
    });
}

function resolveArgs(recipe, provided, configVars) {
  const base = builtins();
  const scope = { ...(configVars || {}), ...base };
  const vars = { ...scope };
  for (const [key, spec] of Object.entries(recipe.args || {})) {
    let value = provided && Object.prototype.hasOwnProperty.call(provided, key) ? provided[key] : spec.default;
    if ((value === undefined || value === null) && spec.required) {
      throw new Error(`配方 ${recipe.name} 缺少参数: ${key}`);
    }
    value = coerce(spec, value);
    if (typeof value === 'string') value = subst(value, scope);
    vars[key] = value;
  }
  return vars;
}

async function runSingle(step, vars, invoker, options) {
  const stepArgs = subst(step.args || {}, vars);
  return invoker.call(step.tool, stepArgs, { dry: options.dry });
}

// 并行组：组内各步骤互不依赖，同时发起；用 Promise.allSettled 保证一个失败不会打断其他
async function runParallelGroup(group, vars, invoker, options) {
  const entries = group.parallel;
  const startedAt = Date.now();
  const settled = await Promise.allSettled(entries.map((sub) => runSingle(sub, vars, invoker, options)));
  const output = {};
  const failures = [];
  settled.forEach((result, index) => {
    const key = entries[index].id || String(index);
    if (result.status === 'fulfilled') {
      output[key] = options.dry ? '(演练)' : result.value.data;
    } else {
      output[key] = null;
      failures.push({ id: key, error: result.reason && result.reason.message });
    }
  });
  return { output, failures, ms: Date.now() - startedAt };
}

async function runRecipe(recipe, invoker, options = {}) {
  const configVars = options.configVars || (invoker.getConfig ? flattenConfig(invoker.getConfig()) : {});
  const vars = resolveArgs(recipe, options.set, configVars);
  const steps = [];
  const emit = (entry) => {
    if (typeof options.onStep === 'function') options.onStep(entry);
  };

  for (let index = 0; index < recipe.steps.length; index += 1) {
    const step = recipe.steps[index];
    const label = step.id || String(index + 1);

    if (step.confirm && !options.yes && !options.dry) {
      const error = `步骤 ${label} 需要确认，加 --yes 才能执行`;
      const entry = { index: index + 1, id: label, tool: step.tool || '(parallel)', ok: false, error };
      steps.push(entry);
      emit(entry);
      return { ok: false, steps, error, needConfirm: label };
    }

    // ── 并行组 ──
    if (Array.isArray(step.parallel)) {
      const { output, failures, ms } = await runParallelGroup(step, vars, invoker, options);
      vars[`$${index + 1}`] = output;
      for (const [key, value] of Object.entries(output)) {
        vars[`steps.${label}.${key}`] = value;
      }
      const entry = {
        index: index + 1,
        id: label,
        kind: 'parallel',
        ok: failures.length === 0,
        output,
        failures,
        ms,
      };
      steps.push(entry);
      emit(entry);
      if (failures.length > 0 && step.onError !== 'continue') {
        return { ok: false, steps, error: `并行组 ${label} 有步骤失败: ${failures.map((f) => f.id).join(', ')}` };
      }
      continue;
    }

    // ── 单步 ──
    try {
      const result = await runSingle(step, vars, invoker, options);
      const value = options.dry ? '(演练)' : result.data;
      vars[`$${index + 1}`] = value;
      vars[`steps.${label}`] = value;
      const entry = { index: index + 1, id: label, tool: step.tool, ok: true, output: value, ms: result.ms };
      steps.push(entry);
      emit(entry);
    } catch (err) {
      const entry = { index: index + 1, id: label, tool: step.tool, ok: false, error: err.message };
      steps.push(entry);
      emit(entry);
      if (step.onError !== 'continue') return { ok: false, steps, error: err.message };
    }
  }

  return { ok: true, steps, args: vars };
}

module.exports = { runRecipe, loadRecipe, listRecipes, builtins, resolveArgs };
