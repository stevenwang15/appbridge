'use strict';

// CSV 解析（支持引号包裹、双引号转义、CRLF）
function parse(text, options = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const cleaned = rows.filter((r) => r.some((c) => c !== ''));

  if (options.header && cleaned.length > 0) {
    const header = cleaned[0];
    return cleaned.slice(1).map((r) => {
      const obj = {};
      header.forEach((key, index) => {
        obj[key] = r[index] === undefined ? '' : r[index];
      });
      return obj;
    });
  }
  return cleaned;
}

module.exports = { parse };
