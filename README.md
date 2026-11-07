# appbridge

> 给 agent 的一组动词，不是给 AI 的一把 shell。
> A verb table for agents — not a shell for the model.

把电脑上的东西（文件、命令行、本机模型、Obsidian、Office 文档）变成 agent 能安全调用的工具，
再把「先干什么、后干什么」存成可复用的**配方**。

- **零外部依赖**：只用 Node 内置模块，一个 `node` 就能跑
- **两种外壳**：中立 MCP server（任何宿主都能接）+ DeepSeek Harness 插件
- **内核与插件分开**：插件是薄壳，逻辑全在内核，换宿主不用重写

```
48 个工具 · 10 种工具类型 · 7 个配方 · 32 个测试 · 176 KB
```

## 为什么不是直接给 AI shell

| | 给 AI 一个 shell | 给 AI 这 48 个工具 |
|---|---|---|
| 能跑什么 | 任何命令 | 48 个固定动词 |
| 能不能读 `~/.ssh` | 能 | 不能，路径不在白名单 |
| 能不能 `rm -rf ~` | 能 | 不能，`rm` 不在白名单 |
| 参数怎么传 | 拼字符串，有注入风险 | 数组传参，不经过 shell |
| 谁干了什么 | 没有记录 | `audit.jsonl` 每条都记 |

它不会让 AI 更快，它让 AI **只能在你划的圈里动**。

## 快速开始

```bash
git clone https://github.com/stevenwang15/appbridge.git
cd appbridge

node bin/cli.js doctor            # 体检：这台机器上哪些工具能用
node bin/cli.js tools             # 48 个工具
node bin/cli.js call sys.info     # 直接调一个
node bin/cli.js run vault-search --set "q=适当性"   # 跑配方
```

`doctor` 检查四件事：平台对不对、命令装没装、端口通不通、路径存不存在。

```bash
cp config.json config.local.json  # 然后改里面的 vault / model
```

## 三种用法

### 1. 命令行

```bash
node bin/cli.js doctor
node bin/cli.js call docx.read --set path=报告.docx
node bin/cli.js run parallel-demo --async          # 后台跑
node bin/cli.js jobs / wait <id> / kill <id>
```

### 2. MCP server（中立外壳，推荐）

任何支持 MCP 的宿主都能接，不依赖宿主版本：

```json
{
  "mcpServers": {
    "appbridge": {
      "command": "node",
      "args": ["/absolute/path/to/appbridge/bin/mcp.js"]
    }
  }
}
```

DeepSeek Harness / Claude Desktop / Cursor / 任何 MCP 客户端通用。接上就是 48 个工具。

### 3. DeepSeek Harness 插件

```bash
npm install appbridge-dsh-plugin
```

插件把内核工具注册成 DSH 原生工具（`ctx.tools.register` + `defineTool`），实现见
[`packages/dsh-plugin`](packages/dsh-plugin)。

> 插件壳依赖宿主提供的 `@deepseek-ai/dsh-tools`。如果你的 DSH 版本不暴露它，
> 用上面的 MCP 方式接入，功能完全一样。

## 48 个工具

**Office（不装 Office 也能用）** — docx/xlsx/pptx 本质是 zip + XML，用 Node 内置 zlib 自己解析
`docx.read` `docx.write` `xlsx.read` `pptx.read`

**压缩包 / 表格** `zip.list` `zip.read` `zip.extract` `csv.read`

**文件** `fs.read` `fs.write` `fs.append` `fs.list` `fs.find` `fs.search`

**Obsidian** `obs.list` `obs.search` `obs.read` `obs.write` `obs.append` `obs.tags` `obs.backlinks`

**命令 / 版本库** `cli.run` `git.log` `git.status` `git.diff` `git.branch` `git.show`

**系统** `sys.info` `sys.disk` `sys.process` `sys.screenshot` `sys.notify` `sys.say` `clip.read` `clip.write` `app.open`

**图片** `img.info` `img.resize` `textutil.convert`

**本机模型 / 网络** `ollama.models` `ollama.chat` `http.get`

**数据加工** `text.join` `json.get` `echo` `delay`

加一个工具 = 往 `tools.json` 加一段 JSON，不用写代码：

```json
"git.status": {
  "desc": "git 工作区改动",
  "kind": "cli",
  "command": "git",
  "args": ["status", "--short"],
  "cwd": "{{repo}}",
  "params": { "repo": { "type": "string", "default": "." } }
}
```

## 配方：步骤的顺序

```json
{
  "name": "vault-search",
  "when": "在 Obsidian 库里搜关键词",
  "args": { "q": { "type": "string", "required": true } },
  "steps": [
    { "id": "hits", "tool": "obs.search", "args": { "pattern": "{{q}}" } },
    { "id": "body", "tool": "text.join", "args": { "items": "{{$1}}", "sep": "\n" } },
    { "id": "save", "tool": "fs.write", "args": { "path": "out/search.md", "content": "{{$2}}" } }
  ]
}
```

变量：`{{参数}}`、`{{$1}}`（第 1 步输出）、`{{date}}` `{{time}}` `{{stamp}}` `{{cwd}}`

配方是**数据不是脚本**：agent 能填参数生成，人能直接改，每一步都能单测。

## 异步执行

**配方内并行**

```json
{ "id": "slow", "parallel": [
   { "id": "a", "tool": "delay", "args": { "ms": 800 } },
   { "id": "b", "tool": "delay", "args": { "ms": 800 } } ] }
```

实测 3×800ms：顺序 2.44s，并行 **0.84s**。

**整条配方后台跑** — `--async` 31ms 返回任务号，状态落盘 `jobs/<id>/`，可跨进程查、等、杀。

## 安全闸

```json
{
  "base": ".",
  "allowExec": ["git", "node", "osascript", "screencapture", "sips", "ps", "textutil", "tesseract", "blender"],
  "allowRead": ["./**", "{{config.vault}}/**"],
  "allowWrite": ["./**", "{{config.vault}}/**"],
  "allowNet": ["127.0.0.1", "localhost"]
}
```

- **路径**：`path` 按读/写判定，`src` 只读，`dest` 只写
- **命令**：必须在 `allowExec` 里
- **网络**：host 必须在 `allowNet` 里

`base` 固定相对程序目录，不跟 cwd 走。

> 已知限制：`cli` 类工具只能约束「跑哪个命令」，管不住命令自己往哪写。要严格隔离得靠系统沙箱。

## 可移植性

| 文件 | 放什么 | 进版本库 |
|---|---|---|
| `config.json` | 可移植默认值 | 是 |
| `config.local.json` | 本机差异（知识库路径、模型名） | 否 |

环境变量：`APPBRIDGE_VAULT` `APPBRIDGE_MODEL` `APPBRIDGE_PLATFORM` `APPBRIDGE_POLICY`

平台差异自动降级：macOS 专属工具标了 `"platform": ["darwin"]`。

```bash
APPBRIDGE_PLATFORM=linux node bin/cli.js doctor    # 38/48
APPBRIDGE_PLATFORM=win32 node bin/cli.js doctor    # 36/48
```

## 仓库结构

```
appbridge/                 内核（npm: appbridge-core）
├── bin/cli.js             命令行入口
├── bin/mcp.js             MCP server 入口（中立外壳）
├── src/invoke.js          工具调用器
├── src/recipe.js          配方执行器
├── src/jobs.js            后台任务
├── src/doctor.js          体检
├── src/zip.js             ZIP 读写
├── src/office.js          docx / xlsx / pptx
├── src/mcp.js             MCP 工具描述
├── src/config.js          配置合并
├── tools.json             48 个工具
├── policy.json            权限
├── recipes/               配方
└── packages/dsh-plugin/   DSH 插件壳（薄）

测试：32 个（内核 25 + 插件契约 7）
```

## 开发者

```bash
node --test test/                       # 内核测试
node --test packages/dsh-plugin/test/   # 插件契约测试
```

## License

MIT
