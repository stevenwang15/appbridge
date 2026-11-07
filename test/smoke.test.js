'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createInvoker } = require('../src/invoke');
const { PLATFORM } = require('../src/config');
const { createZip } = require('../src/zip');
const { runRecipe } = require('../src/recipe');

const TOOLS = path.join(__dirname, '..', 'tools.json');
const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-'));
  const policy = {
    base: dir,
    allowExec: ['git', 'echo'],
    allowRead: ['.'],
    allowWrite: ['.'],
    allowNet: ['127.0.0.1'],
  };
  return { dir, invoker: createInvoker({ registryFile: TOOLS, policy }) };
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

test('echo 原样返回', async () => {
  const { invoker } = sandbox();
  const result = await invoker.call('echo', { text: '你好' });
  assert.strictEqual(result.data, '你好');
});

test('写文件再读回来', async () => {
  const { dir, invoker } = sandbox();
  const target = path.join(dir, 'a.md');
  await invoker.call('fs.write', { path: target, content: '第一行\n第二行\n' });
  const result = await invoker.call('fs.read', { path: target });
  assert.strictEqual(result.data, '第一行\n第二行\n');
});

test('白名单外的路径被拒绝', async () => {
  const { invoker } = sandbox();
  await assert.rejects(() => invoker.call('fs.read', { path: '/etc/hosts' }), /权限/);
});

test('--dry 只出计划，不落盘', async () => {
  const { dir, invoker } = sandbox();
  const target = path.join(dir, 'dry.md');
  const result = await invoker.call('fs.write', { path: target, content: 'x' }, { dry: true });
  assert.strictEqual(result.dry, true);
  assert.strictEqual(fs.existsSync(target), false);
});

test('配方按顺序执行，并能引用上一步输出', async () => {
  const { dir, invoker } = sandbox();
  const out = path.join(dir, 'out.md');
  const recipe = {
    name: 't',
    steps: [
      { id: 'echo', tool: 'echo', args: { text: '内容 A' } },
      { id: 'join', tool: 'text.join', args: { items: ['# 标题', '{{$1}}'], sep: '\n' } },
      { id: 'save', tool: 'fs.write', args: { path: out, content: '{{$2}}' } },
    ],
  };
  const result = await runRecipe(recipe, invoker, {});
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), '# 标题\n内容 A');
});

test('并行组：总耗时接近最慢一步，而不是累加', async () => {
  const { invoker } = sandbox();
  const recipe = {
    name: 'p',
    steps: [
      {
        id: 'g',
        parallel: [
          { id: 'a', tool: 'delay', args: { ms: 250 } },
          { id: 'b', tool: 'delay', args: { ms: 250 } },
          { id: 'c', tool: 'delay', args: { ms: 250 } },
        ],
      },
    ],
  };
  const startedAt = Date.now();
  const result = await runRecipe(recipe, invoker, {});
  const elapsed = Date.now() - startedAt;
  assert.strictEqual(result.ok, true);
  assert.ok(elapsed < 600, `应该并行执行，实际用了 ${elapsed}ms`);
  assert.strictEqual(result.steps[0].output.a, '等了 250ms');
});

test('并行组里一个失败不影响其他，但整组会报错', async () => {
  const { dir, invoker } = sandbox();
  const recipe = {
    name: 'p2',
    steps: [
      {
        id: 'g',
        parallel: [
          { id: 'ok', tool: 'echo', args: { text: 'fine' } },
          { id: 'bad', tool: 'fs.read', args: { path: '/etc/hosts' } },
        ],
      },
    ],
  };
  const result = await runRecipe(recipe, invoker, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.steps[0].output.ok, 'fine');
  assert.strictEqual(result.steps[0].failures.length, 1);
});

test('confirm 步骤没有 --yes 会被拦下', async () => {
  const { dir, invoker } = sandbox();
  const target = path.join(dir, 'confirm.md');
  const recipe = {
    name: 'c',
    steps: [{ id: 'w', tool: 'fs.write', args: { path: target, content: 'x' }, confirm: true }],
  };
  const blocked = await runRecipe(recipe, invoker, {});
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.needConfirm, 'w');
  assert.strictEqual(fs.existsSync(target), false);

  const allowed = await runRecipe(recipe, invoker, { yes: true });
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(fs.existsSync(target), true);
});

test('后台异步：派发立刻返回，wait 能等到完成', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-home-'));
  const recipeDir = path.join(home, 'recipes');
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(
    path.join(recipeDir, 'slow.json'),
    JSON.stringify({
      name: 'slow',
      steps: [
        { id: 'wait', tool: 'delay', args: { ms: 1500 } },
        { id: 'save', tool: 'fs.write', args: { path: path.join(home, 'done.txt'), content: 'ok' } },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(home, 'policy.json'),
    JSON.stringify({
      base: home,
      allowExec: ['git', 'echo'],
      allowRead: [home],
      allowWrite: [home],
      allowNet: ['127.0.0.1'],
    }),
  );

  const env = {
    ...process.env,
    APPBRIDGE_HOME: home,
    APPBRIDGE_RECIPE_DIR: recipeDir,
    APPBRIDGE_POLICY: path.join(home, 'policy.json'),
  };

  const startedAt = Date.now();
  const dispatched = await runCli(['run', 'slow', '--async'], env);
  const dispatchMs = Date.now() - startedAt;
  assert.strictEqual(dispatched.code, 0, dispatched.stderr);
  assert.ok(dispatchMs < 1000, `派发应该立刻返回，实际 ${dispatchMs}ms`);
  const match = dispatched.stdout.match(/已派发: (\S+)/);
  assert.ok(match, `没拿到任务号: ${dispatched.stdout}`);
  const jobId = match[1];

  const waited = await runCli(['wait', jobId, '--timeout', '15000'], env);
  assert.strictEqual(waited.code, 0, waited.stderr);
  assert.ok(waited.stdout.includes('完成'), waited.stdout);
  assert.strictEqual(fs.readFileSync(path.join(home, 'done.txt'), 'utf8'), 'ok');
});

test('fs.append / fs.find / fs.search', async () => {
  const { dir, invoker } = sandbox();
  const file = path.join(dir, 'sub', 'a.md');
  await invoker.call('fs.write', { path: file, content: '第一行\n关键词令牌\n' });
  await invoker.call('fs.append', { path: file, content: '追加行\n' });
  const read = await invoker.call('fs.read', { path: file });
  assert.strictEqual(read.data, '第一行\n关键词令牌\n追加行\n');

  const found = await invoker.call('fs.find', { path: dir, ext: 'md' });
  assert.strictEqual(found.data.length, 1);
  assert.ok(found.data[0].endsWith('a.md'));

  const hits = await invoker.call('fs.search', { path: dir, pattern: '关键词' });
  assert.strictEqual(hits.data.length, 1);
  assert.ok(hits.data[0].includes('关键词令牌'));
});

test('json.get 按点号路径取值', async () => {
  const { invoker } = sandbox();
  const result = await invoker.call('json.get', { data: { a: { b: [1, 2] } }, path: 'a.b.0' });
  assert.strictEqual(result.data, 1);
});

test('cli.run 支持标准输入', async () => {
  const { invoker } = sandbox();
  const policy = invoker.getPolicy();
  invoker.setPolicy({ ...policy, allowExec: [...policy.allowExec, 'cat'] });
  const result = await invoker.call('cli.run', { command: 'cat', stdin: '喂进去的内容' });
  assert.strictEqual(result.data, '喂进去的内容');
});

test('http POST + json 解析 + unwrap', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ echo: JSON.parse(body) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-http-'));
    const invoker = createInvoker({
      registryFile: TOOLS,
      policy: { base: dir, allowExec: [], allowRead: [dir], allowWrite: [dir], allowNet: ['127.0.0.1'] },
    });
    invoker.register('test.post', {
      desc: '测试用 POST',
      kind: 'http',
      method: 'POST',
      url: `http://127.0.0.1:${port}/echo`,
      parse: 'json',
      unwrap: 'body',
      body: { hello: '{{name}}' },
      params: { name: { type: 'string', required: true } },
    });
    const result = await invoker.call('test.post', { name: '世界' });
    assert.deepStrictEqual(result.data, { echo: { hello: '世界' } });
  } finally {
    server.close();
  }
});


test('相对路径挂在 policy.base 上，与 cwd 无关', async () => {
  const { dir, invoker } = sandbox();
  const result = await invoker.call('fs.write', { path: 'out/x.md', content: 'ok' });
  assert.strictEqual(result.data.path, path.join(dir, 'out', 'x.md'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'out', 'x.md'), 'utf8'), 'ok');
});

test('工具默认值可以从 config 读取', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-cfg-'));
  const vault = path.join(dir, 'fake-vault');
  fs.mkdirSync(vault);
  const invoker = createInvoker({
    registryFile: TOOLS,
    config: { vault, model: 'some-model' },
    policy: { base: dir, allowExec: [], allowRead: [vault], allowWrite: [dir], allowNet: [] },
  });
  const plan = await invoker.call('obs.list', {}, { dry: true });
  assert.strictEqual(plan.plan.path, vault);
});

test('平台不匹配的工具会被拒绝', async () => {
  const { dir, invoker } = sandbox();
  const otherPlatform = PLATFORM === 'darwin' ? 'win32' : 'darwin';
  invoker.register('only.other', { kind: 'echo', template: 'x', platform: [otherPlatform] });
  await assert.rejects(() => invoker.call('only.other', {}), /不支持/);
});


test('docx 写入后能读回（含 XML 转义）', async () => {
  const { dir, invoker } = sandbox();
  const file = path.join(dir, 'a.docx');
  await invoker.call('docx.write', { path: file, text: '第一段\n含 <尖括号> 和 & 符号' });
  const result = await invoker.call('docx.read', { path: file });
  assert.strictEqual(result.data.paragraphs, 2);
  assert.ok(result.data.text.includes('<尖括号>'));
  assert.ok(result.data.text.includes('& 符号'));
});

test('zip 列表与读取内部文件', async () => {
  const { dir, invoker } = sandbox();
  const file = path.join(dir, 'a.docx');
  await invoker.call('docx.write', { path: file, text: 'x' });
  const list = await invoker.call('zip.list', { path: file });
  assert.ok(list.data.some((e) => e.name === 'word/document.xml'));
  const inner = await invoker.call('zip.read', { path: file, entry: 'word/document.xml' });
  assert.ok(inner.data.includes('<w:document'));
});

test('xlsx 读取共享字符串与数字', async () => {
  const { dir, invoker } = sandbox();
  const file = path.join(dir, 'a.xlsx');
  fs.writeFileSync(
    file,
    createZip([
      { name: 'xl/sharedStrings.xml', data: '<?xml version="1.0"?><sst><si><t>名称</t></si><si><t>数值</t></si><si><t>甲</t></si></sst>' },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
      },
    ]),
  );
  const result = await invoker.call('xlsx.read', { path: file });
  assert.strictEqual(result.data.sheets.length, 1);
  assert.deepStrictEqual(result.data.sheets[0].rows[0], ['名称', '数值']);
  assert.deepStrictEqual(result.data.sheets[0].rows[1], ['甲', '42']);
});

test('csv 解析：引号、逗号、双引号转义', async () => {
  const { dir, invoker } = sandbox();
  const file = path.join(dir, 'a.csv');
  await invoker.call('fs.write', { path: file, content: 'name,note\n张三,"含,逗号"\n李四,"引号""转义"\n' });
  const result = await invoker.call('csv.read', { path: file, header: true });
  assert.strictEqual(result.data.count, 2);
  assert.strictEqual(result.data.rows[0].note, '含,逗号');
  assert.strictEqual(result.data.rows[1].note, '引号"转义');
});

test('写类工具必须走写白名单', async () => {
  const { dir, invoker } = sandbox();
  const policy = invoker.getPolicy();
  invoker.setPolicy({ ...policy, allowWrite: [] });
  await assert.rejects(() => invoker.call('fs.write', { path: path.join(dir, 'x.md'), content: 'x' }), /写入路径/);
});
