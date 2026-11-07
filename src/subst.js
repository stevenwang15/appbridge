'use strict';

// {{name}} 替换。整串就是一个占位符时，保留原始类型（数组/数字不被转成字符串）。
const TOKEN = /\{\{\s*([\w.$-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*([\w.$-]+)\s*\}\}$/;

function has(vars, key) {
  return Object.prototype.hasOwnProperty.call(vars, key);
}

function subst(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE);
    if (whole && has(vars, whole[1])) return vars[whole[1]];
    return value.replace(TOKEN, (match, key) => (has(vars, key) ? String(vars[key]) : match));
  }
  if (Array.isArray(value)) return value.map((item) => subst(item, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = subst(v, vars);
    return out;
  }
  return value;
}

function coerce(spec, value) {
  const type = spec && spec.type;
  if (value === undefined || value === null) return value;
  if (type === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (type === 'boolean') return value === true || value === 'true';
  if (type === 'array') {
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (type === 'string') return String(value);
  // 没声明类型：原样保留（对象/数组/布尔都不被转成字符串）
  return value;
}

module.exports = { subst, coerce };
