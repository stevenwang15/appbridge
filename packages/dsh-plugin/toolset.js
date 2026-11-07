// toolset.js — 把内核的工具表翻译成 DSH 的工具描述。
// 这个文件不 import 任何 DSH 包，所以可以单独测试。
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const HERE = fileURLToPath(new URL('.', import.meta.url))

function loadCore() {
  try {
    return require('appbridge-core')
  } catch {
    // 开发态：直接指向仓库根的内核
    return require(join(HERE, '..', '..', 'src', 'index.js'))
  }
}

const TYPE_MAP = { number: 'number', boolean: 'boolean', array: 'array' }

/** DSH 的工具名走下划线风格，把 appbridge 的 `git.log` 变成 `git_log`。 */
export function toDshToolName(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, '_')
}

/**
 * 生成 DSH 工具描述。纯数据，方便测试和审阅。
 * @param core 内核模块（默认自动加载 appbridge-core）
 */
export function buildToolDescriptors(core = loadCore()) {
  const invoker = core.createInvoker({})
  const descriptors = []

  for (const item of invoker.list()) {
    const tool = invoker.get(item.name)
    if (tool.enabled === false) continue

    const parameters = {}
    for (const [key, spec] of Object.entries(tool.params || {})) {
      const type = TYPE_MAP[spec.type] || 'string'
      const entry = { type, required: spec.required === true }
      if (spec.description) entry.description = spec.description
      if (type === 'array') entry.items = { type: 'string' }
      parameters[key] = entry
    }

    descriptors.push({
      name: toDshToolName(item.name),
      original: item.name,
      description: `${tool.desc || item.name}${item.platform ? `（仅 ${item.platform.join('/')}）` : ''}`,
      parameters,
      run: async (args) => {
        const result = await invoker.call(item.name, args === undefined || args === null ? {} : args)
        const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
        return { text: text.length > 60000 ? `${text.slice(0, 60000)}…` : text }
      },
    })
  }

  return descriptors
}
