import test from 'node:test'
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildToolDescriptors, toDshToolName } from '../toolset.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const REPO_ROOT = join(PKG_DIR, '..', '..')

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
const coreTools = JSON.parse(readFileSync(join(REPO_ROOT, 'tools.json'), 'utf8')).tools
const indexSource = readFileSync(join(PKG_DIR, 'index.js'), 'utf8')

test('package.json 声明了 dsh.bundle.patch 且文件存在', () => {
  const patch = pkg.dsh?.bundle?.patch
  assert.ok(patch, '缺少 dsh.bundle.patch')
  assert.ok(existsSync(join(PKG_DIR, patch)), `补丁文件不存在: ${patch}`)
})

test('cordis.patch.yml 把插件行插进 profile', () => {
  const yaml = readFileSync(join(PKG_DIR, 'cordis.patch.yml'), 'utf8')
  assert.match(yaml, /^-\s*insert:/m, '缺少 insert 段')
  assert.ok(yaml.includes(pkg.name), `补丁里没引用包名 ${pkg.name}`)
  assert.ok(yaml.includes('id: appbridge'), '缺少 id: appbridge')
})

test('index.js 导出 DSH 插件契约（name / inject / apply）', () => {
  assert.match(indexSource, /export const name = 'appbridge'/)
  assert.match(indexSource, /export const inject = \['tools'\]/)
  assert.match(indexSource, /export function apply\(ctx\)/)
  assert.match(indexSource, /from '@deepseek-ai\/dsh-tools'/, '必须从宿主拿 defineTool')
})

test('工具名去点号，且不重复', () => {
  assert.strictEqual(toDshToolName('git.log'), 'git_log')
  assert.strictEqual(toDshToolName('obs.backlinks'), 'obs_backlinks')
  const names = buildToolDescriptors().map((d) => d.name)
  assert.strictEqual(new Set(names).size, names.length, '有重名工具')
  for (const name of names) assert.match(name, /^[a-zA-Z0-9_]+$/)
})

test('每个内核工具都翻译成一条 DSH 工具描述', () => {
  const descriptors = buildToolDescriptors()
  const expected = Object.values(coreTools).filter((tool) => tool.enabled !== false).length
  assert.strictEqual(descriptors.length, expected)
  for (const descriptor of descriptors) {
    assert.strictEqual(typeof descriptor.name, 'string')
    assert.strictEqual(typeof descriptor.description, 'string')
    assert.strictEqual(typeof descriptor.run, 'function')
    assert.strictEqual(typeof descriptor.parameters, 'object')
    for (const spec of Object.values(descriptor.parameters)) {
      assert.ok(['string', 'number', 'boolean', 'array', 'object'].includes(spec.type), `参数类型不合法: ${spec.type}`)
    }
  }
})

test('描述符能真的执行（echo）', async () => {
  const echo = buildToolDescriptors().find((d) => d.name === 'echo')
  assert.ok(echo, '找不到 echo 描述符')
  const result = await echo.run({ text: '插件壳通了' })
  assert.deepStrictEqual(result, { text: '插件壳通了' })
})

test('写类工具在插件壳里仍然走权限白名单', async () => {
  const write = buildToolDescriptors().find((d) => d.name === 'fs_write')
  assert.ok(write)
  await assert.rejects(() => write.run({ path: '/etc/passwd', content: 'x' }), /权限/)
})
