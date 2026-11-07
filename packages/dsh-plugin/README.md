# appbridge-dsh-plugin

DeepSeek Harness 插件壳。**薄**：只做一件事——把 `appbridge-core` 的工具注册成 DSH 原生工具。

所有逻辑（工具调用器、配方、权限、异步任务、Office 解析）都在内核里。换宿主时这个包可以整个丢掉。

## 装

```bash
npm install appbridge-core appbridge-dsh-plugin
```

或者在 DSH 的插件目录里：

```bash
npm install appbridge-dsh-plugin
```

DSH 会读 `package.json` 里的 `dsh.bundle.patch`，把 `cordis.patch.yml` 的插件行插进 profile 组合。

## 它注册了什么

每个 `appbridge-core` 的工具注册成一条 DSH 工具：

| appbridge | DSH 工具名 |
|---|---|
| `git.log` | `git_log` |
| `obs.search` | `obs_search` |
| `docx.read` | `docx_read` |

命名规则：非 `[a-zA-Z0-9_]` 一律换成 `_`。

参数直接映射内核的 `params`（type / required / description），返回值统一是 `{ text }`，
`render` 出来就是一个文本块。

## 契约

```js
export const name = 'appbridge'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name, description, parameters, output, execute }))
  return dispose // 卸载函数
}
```

`defineTool` 来自宿主提供的 `@deepseek-ai/dsh-tools`。

## 如果宿主不提供 `@deepseek-ai/dsh-tools`

用 MCP 方式接入，功能完全一样，而且不依赖 DSH 版本：

```json
{
  "mcpServers": {
    "appbridge": {
      "command": "node",
      "args": ["node_modules/appbridge-core/bin/mcp.js"]
    }
  }
}
```

## 测试

```bash
node --test test/
```

7 个测试：包清单、补丁文件、模块导出、工具名映射、工具数量、执行、权限穿透。

测试不 import `index.js`（它依赖宿主包），而是测 `toolset.js` 这个纯数据层。

## License

MIT
