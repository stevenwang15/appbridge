// appbridge — DeepSeek Harness 插件壳（薄）。
//
// 这个文件只做一件事：把内核的工具表注册成 DSH 原生工具。
// 所有逻辑（工具调用器、配方、权限、异步任务）都在 appbridge-core 里。
//
// 如果当前宿主没有暴露 @deepseek-ai/dsh-tools，改用 MCP 方式接入：
//     node <appbridge-core>/bin/mcp.js
// MCP 是中立协议，不依赖 DSH 版本。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildToolDescriptors } from './toolset.js'

export const name = 'appbridge'
export const inject = ['tools']

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', required: true } },
  additionalProperties: false,
}

export function apply(ctx) {
  const disposers = []

  for (const descriptor of buildToolDescriptors()) {
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: descriptor.name,
          description: descriptor.description,
          parameters: descriptor.parameters,
          output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          execute: (args) => descriptor.run(args),
        }),
      ),
    )
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载时单个失败不影响其余 */
      }
    }
  }
}

/** 导出给测试：注册表契约，不挂载。 */
export { buildToolDescriptors }
