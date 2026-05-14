# testflow 集成改动说明

## 改动概述

在 kilo-vscode 和 testflow CLI 两侧实现了集成框架。kilo-vscode 通过 `/sdt-*` 斜杠命令 spawn testflow 子进程，通过 stdout JSON Lines 双向通信，实时展示步骤进度、AI agent 状态、用户交互问答。testflow 通过 `KILO_INTEGRATION=1` 环境变量切换为 JSON Lines 输出模式。

## 一、kilo-vscode 侧改动

### 新增文件

| 文件 | 说明 |
|------|------|
| `packages/kilo-vscode/src/testagent/sdt-runner.ts` | SdtRunner 类：spawn testflow 子进程、解析 stdout JSON Lines、转发事件到 webview、回写 stdin |
| `packages/kilo-vscode/webview-ui/src/context/testflow.tsx` | TestflowProvider 上下文：管理 testflow 状态（步骤、问题、agent 状态），处理 extension 消息 |
| `packages/kilo-vscode/webview-ui/src/components/chat/TestflowView.tsx` | TestflowView 组件：渲染步骤进度、问题交互、agent 状态、终止按钮 |
| `packages/kilo-vscode/webview-ui/src/styles/testflow.css` | testflow 面板样式 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/kilo-vscode/src/KiloProvider.ts` | 导入 SdtRunner；拦截 `/sdt-*` 消息转给 SdtRunner；处理 `testflow.questionReply/questionReject/abort` webview 消息 |
| `packages/kilo-vscode/webview-ui/src/hooks/useSlashCommand.ts` | 新增 `/sdt-new` 斜杠命令 |
| `packages/kilo-vscode/webview-ui/src/types/messages.ts` | 新增 8 个 extension→webview 消息类型和 3 个 webview→extension 消息类型 |
| `packages/kilo-vscode/webview-ui/src/App.tsx` | 在 Provider 链中插入 `TestflowProvider` |
| `packages/kilo-vscode/webview-ui/src/components/chat/ChatView.tsx` | 在消息列表和输入框之间插入 `TestflowView` |
| `packages/kilo-vscode/webview-ui/src/styles/chat.css` | 引入 `testflow.css` |

## 二、testflow 侧改动

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/lib/kilo.ts` | kilo 集成通信层：`emit()` 输出 JSON Lines、`ask()` 向 webview 提问并等待 stdin 回复、`runAgent()` 调用 AI agent 并轮询等待完成、`isKiloIntegration()` 检测环境变量 |
| `src/core/ai-client.ts` | `createAIClient()` 工厂函数：从环境变量读取 server 配置，动态 import `@kilocode/sdk` 构造客户端 |
| `src/types/protocol.types.ts` | JSON Lines 协议类型定义（StepEvent、QuestionEvent、AgentStartEvent 等） |
| `src/types/kilocode-sdk.d.ts` | `@kilocode/sdk` 类型声明（可选依赖，未安装时 TS 不报错） |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/commands/new.ts` | 检测 `KILO_INTEGRATION` 环境变量，集成模式下：用 `emit()` 替代 `this.log()`；用 `ask()` 替代终端 readline 交互；错误时输出 `error` + `done` 事件；新增 `selectProfileKilo()` 方法 |
| `src/commands/validate.ts` | 集成模式下：用 `emit()` 替代 ora spinner 输出；捕获错误输出 `error` + `done` 事件 |
| `src/types/index.ts` | 导出 `protocol.types.js` |

### SDK 依赖安装

testflow 不在 `package.json` 中声明 `@kilocode/sdk` 依赖（因为 pnpm workspace 外无法使用 `file:` 协议，且 SDK 使用 catalog 协议不兼容）。通过动态 `import()` 按需加载，需要时通过 npm link 安装：

```bash
# 1. 在 kilo 仓库的 SDK 目录下创建全局 link
cd packages/sdk/js && npm link

# 2. 在 testflow 目录下链接 SDK
cd /path/to/testflow && npm link @kilocode/sdk
```

## 数据流

```
用户输入 "/sdt-new my-task"
  → webview sendMessage
  → KiloProvider.handleSendMessage() 检测 /sdt- 前缀
  → handleSdtCommand() 从 connectionService 获取 serverConfig
  → SdtRunner.run({ cmd, args, env: { OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD, OPENCODE_SESSION_ID, KILO_INTEGRATION: "1" } })
  → spawn("testflow", args, { env, stdio: ["pipe","pipe","pipe"] })
  → testflow 检测 KILO_INTEGRATION=1，切换为 JSON Lines 模式
  → testflow stdout 输出 JSON Lines（step/question/agent_start/agent_done/text/error/done）
  → SdtRunner 解析并 forward 为 testflow.* 消息到 webview
  → TestflowProvider 处理消息更新状态
  → TestflowView 渲染
  → 用户操作（点击问题选项/点击终止）→ webview → KiloProvider → SdtRunner → testflow stdin
```

## 环境变量

SdtRunner spawn testflow 时传入以下环境变量：

| 环境变量 | 说明 | 来源 |
|----------|------|------|
| `KILO_INTEGRATION` | 固定为 `"1"`，testflow 据此切换 JSON Lines 模式 | SdtRunner 硬编码 |
| `OPENCODE_SERVER_URL` | opencode server 地址 | `connectionService.getServerConfig().baseUrl` |
| `OPENCODE_SERVER_PASSWORD` | opencode server 密码 | `connectionService.getServerConfig().password` |
| `OPENCODE_SESSION_ID` | 当前 session ID（可选，不传则 runAgent 自动创建） | `currentSession?.id` |
| `OPENCODE_SERVER_USERNAME` | 认证用户名（默认 `opencode`） | 可选 |

## JSON Lines 协议

testflow 在 `KILO_INTEGRATION=1` 时输出以下 JSON Lines 事件：

| 事件类型 | 格式 | 说明 |
|----------|------|------|
| `step` | `{"type":"step","title":"...","status":"start/complete/exception","stage_id":"..."}` | 流程步骤进度 |
| `question` | `{"type":"question","id":"q1","header":"...","question":"...","options":[{"label":"...","description":"..."}],"multiple":false}` | 向用户提问 |
| `agent_start` | `{"type":"agent_start","skill":"...","prompt":"..."}` | AI agent 开始执行 |
| `agent_done` | `{"type":"agent_done","success":true,"summary":"..."}` | AI agent 执行完成 |
| `text` | `{"type":"text","text":"..."}` | 纯文本信息 |
| `log` | `{"type":"log","level":"info/warn/error","message":"..."}` | 日志 |
| `error` | `{"type":"error","code":"...","error":"..."}` | 错误 |
| `done` | `{"type":"done","exitCode":0,"summary":"..."}` | 流程结束 |

stdin 回复格式：

| 回复类型 | 格式 |
|----------|------|
| 用户回答 | `{"type":"question_reply","id":"q1","answers":["选项1"]}` |
| 用户拒绝 | `{"type":"question_reject","id":"q1"}` |

## 测试方式

### 0. 前置准备：安装 testflow 和 SDK link

```bash
# 1. 构建 testflow（在 testflow 仓库目录下）
cd D:\project\testflow\testflow
pnpm install
bun run build

# 2. 将 testflow 链接到全局
npm link

# 3. 验证 testflow 在 PATH 中可用
testflow --version

# 4. （可选）如果需要 AI agent 功能，链接 SDK
cd D:\project\pluto-testagent-kilo\testagent-kilo\packages\sdk\js
npm link
cd D:\project\testflow\testflow
npm link @kilocode/sdk
```

### 1. 单独测试 testflow 的 JSON Lines 模式

不需要 VS Code，直接在终端验证 testflow 在 `KILO_INTEGRATION=1` 下的输出：

```bash
# 设置环境变量后执行 testflow
set KILO_INTEGRATION=1
testflow new test-task --profile easy

# 预期输出为 JSON Lines，每行一个 JSON 对象：
# {"type":"step","title":"创建任务: test-task","status":"start"}
# {"type":"step","title":"创建任务: test-task","status":"complete"}
# {"type":"text","text":"任务创建成功！目录: ..."}
# {"type":"done","exitCode":0,"summary":"任务 test-task 创建成功"}
```

用 Node.js 模拟完整交互（含 question）：

```js
// test-kilo-integration.js
const { spawn } = require("child_process")
const readline = require("readline")

const proc = spawn("testflow", ["new", "test-task", "--profile", "easy"], {
  env: { ...process.env, KILO_INTEGRATION: "1" },
  stdio: ["pipe", "pipe", "pipe"],
})

readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  const event = JSON.parse(line)
  console.log("[event]", event.type, event)

  if (event.type === "question") {
    // 自动选择第一个选项
    const reply = { type: "question_reply", id: event.id, answers: [event.options[0].label] }
    proc.stdin.write(JSON.stringify(reply) + "\n")
  }
})

proc.on("close", (code) => console.log("[done] exit code:", code))
```

### 2. 验证斜杠命令注册

1. 启动插件：`bun run extension`（从仓库根目录）
2. 在 VS Code 中打开侧边栏 Kilo 面板
3. 在输入框输入 `/sdt`
4. 应出现下拉列表，包含 `sdt-new - 启动测试流程 - 创建新任务`

### 3. 验证 testflow 未安装时的错误反馈

1. 确认 testflow 不在 PATH 中（`testflow --version` 应失败）
2. 在聊天框输入 `/sdt-new test-task` 并按 Enter
3. 应在聊天区域看到 testflow 错误面板，显示 spawn 失败信息

### 4. 端到端测试（完整链路）

前置条件：testflow 已构建并 link 到全局（见第 0 步），且 VS Code 中 kilo 插件已启动。

1. 在 VS Code kilo 聊天框输入 `/sdt-new test-task --profile easy`
2. 观察聊天区域出现 testflow 面板，显示 "Testflow 运行中..."
3. 观察步骤 "创建任务: test-task" 出现并完成
4. 观察面板显示 "Testflow 完成" 和摘要
5. 若未指定 `--profile`，应在面板中弹出 profile 选择问题

异常路径测试：

- 点击问题"取消"：testflow 收到 `question_reject`，应输出 `done` 并退出
- 点击终止按钮：testflow 进程被 kill，面板显示已终止
- testflow 命令出错（如无效 taskname）：面板显示错误信息

### 5. 验证功能清单

| 功能 | 测试步骤 | 预期结果 |
|------|----------|----------|
| 斜杠命令 | 输入 `/sdt` | 下拉出现 `sdt-new` |
| 步骤进度 | 发送 `/sdt-new xxx` | 面板出现步骤列表，spinner 旋转 |
| 问题交互 | mock 输出 question 事件 | 面板显示问题选项，点击后回复到 stdin |
| Agent 状态 | mock 输出 agent_start | 面板显示 "AI Agent 执行中" + spinner |
| 终止按钮 | 点击终止按钮 | testflow 进程被 kill，面板显示已终止 |
| 错误反馈 | testflow 输出 error 事件 | 面板显示错误信息 |
| 流程完成 | testflow 输出 done 事件 | 面板显示完成状态和摘要 |

### 6. Git Tag 查看改动

```bash
# 查看所有改动
git diff testflow-integration-start..testflow-integration-end

# 查看改动文件列表
git diff --name-only testflow-integration-start..testflow-integration-end
```
