# testflow × kilo-vscode 集成方案设计

> 基于 `docs/design.md` 中的思路，经过代码调研后的可行性分析与细化方案。

## 一、方案总评

**整体可行**，架构思路（进程边界 + JSON Lines + @kilocode/sdk）是合理的。以下按层分析可行性、风险和需要调整的点。

---

## 二、架构确认

```
┌─────────────────────────────────────────────────────────────┐
│  kilo-vscode webview                                        │
│  /sdt-* 斜杠命令  →  question UI  →  步骤进度  →  完成摘要  │
└──────────┬──────────────────────────────────┬───────────────┘
           │ postMessage                      │ postMessage
           ▼                                  ▼
┌──────────────────────────────────────────────────────────────┐
│  KiloProvider (extension host)                                │
│  拦截 /sdt-* → SdtRunner.run()                               │
│  SdtRunner: spawn testflow, 解析 stdout JSON Lines,          │
│             转发到 webview, 回写 stdin (question reply)       │
└──────────┬───────────────────────────────────────────────────┘
           │ spawn (stdio: pipe)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  testflow CLI                                                │
│  检测 KILO_INTEGRATION=1 → JSON Lines 模式                   │
│  emit({type:"step/question/agent_start/agent_done/text/done"})│
│  ask() → emit question → 阻塞等 stdin 回复                  │
│  runAgent() → client.session.promptAsync() + SSE 等待        │
└──────────┬───────────────────────────────────────────────────┘
           │ @kilocode/sdk (HTTP + SSE)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  opencode server (已运行)                                    │
│  client.session.create() / promptAsync() / event.subscribe() │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、可行性分析

### 3.1 斜杠命令注册 — ✅ 直接可行

**现状**：`useSlashCommand.ts` 维护一个 `SlashCommandEntry[]` 数组，每个命令有 `name`、`description`、`hints`、`action`。

**改动**：在 `all` 数组中追加 `/sdt-new` 等命令。这些命令不执行本地 `action`，而是将 `/sdt-xxx` 文本填入输入框（类似已有的 `/compact` 等命令走 sendMessage 通道），由 extension host 侧拦截处理。

```ts
// useSlashCommand.ts — 追加到 all 数组
{
  name: "sdt-new",
  description: "启动测试流程 - 创建新任务",
  hints: ["testflow", "new task"],
  // 不设 action → 选中后填入 "/sdt-new " 到输入框，由用户按 Enter 发送
},
```

### 3.2 Extension Host 拦截 — ✅ 可行，需注意细节

**现状**：`KiloProvider.handleWebviewMessage()` 中 `case "sendMessage"` 调用 `handleSendMessage()`，最终走 `client.session.promptAsync()`。

**改动**：在 `handleSendMessage()` 入口处检测 `/sdt-` 前缀，拦截并转给 `SdtRunner`。

**关键细节**：

1. **必须使用 `src/util/process.ts` 的 `spawn`**，不能用 `child_process.spawn` 直接调用（Windows 上会闪 cmd 窗口）。设计文档中的代码需修正。

2. **`connectionService.getServerConfig()` 返回 `{ baseUrl, password }`**（`types.ts:9`），构造环境变量时直接用即可。认证 header 格式为 `Basic ${Buffer.from("opencode:" + password).toString("base64")}`（见 `connection-service.ts:606`）。

3. **`resolveSession()`** 需要先调用以获取或创建 session，再将 sessionID 传给 testflow。testflow 可以复用当前 session 或自建新 session，两种策略各有优劣（见 3.4 节）。

### 3.3 SDK 在 testflow CLI 中的可用性 — ⚠️ 需要适配

**核心 API 可用性确认**：

| API | 路径 | 状态 |
|-----|------|------|
| `createKiloClient()` | `@kilocode/sdk/v2/client` | ✅ 接受 `{ baseUrl, headers }` 构造 |
| `client.session.create()` | `KiloClient.session.create()` | ✅ POST `/session`，返回 session |
| `client.session.promptAsync()` | `KiloClient.session.promptAsync()` | ✅ POST `/session/{id}/prompt_async`，即发即忘 |
| `client.event.subscribe()` | `KiloClient.event.subscribe()` | ✅ GET `/event` (SSE)，返回 `AsyncGenerator` |

**风险点**：

1. **Node.js fetch 兼容性**：SDK 的 SSE 客户端（`serverSentEvents.gen.ts`）依赖 `fetch` 和 `ReadableStream`。Node.js 18+ 内置 `fetch`，但 SSE 解析用到了 `TextDecoderStream` 和 `pipeThrough`，需要 Node.js 18.0+。testflow 的 `engines` 要求 `node >= 18.0.0`，满足条件。

2. **SDK duplex 选项**：`createKiloClient()` 内部设置了 `duplex: "half"` 和自定义 `fetch`（`client.ts:47-61`）。在 Node.js 环境中，默认的 `fetch` 已支持 duplex，但 SDK 的自定义 fetch 逻辑是为 VS Code webview 环境写的。**testflow 中构造 client 时，应直接用 SDK 默认行为**，不传 `fetch`，让 Node.js 原生 fetch 接管即可。

3. **依赖安装**：testflow 是独立仓库，不能用 `workspace:*`。需从 npm 安装 `@kilocode/sdk`（如果已发布）或通过 `npm link` / git dependency 引用。建议：
   - 开发阶段：`npm link @kilocode/sdk`
   - 生产阶段：发布 SDK 到内部 npm registry

4. **SSE 等待 session idle 的实现**：这是 `runAgent()` 的核心难点。`promptAsync` 是 fire-and-forget，需通过 SSE 监听 `session.updated` 事件来判定 agent 是否完成。具体逻辑：

```ts
async function waitForSessionIdle(client: KiloClient, sessionID: string, timeout = 300_000): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const { stream } = await client.event.subscribe()
    for await (const event of stream) {
      if (event.type === "session.updated" && event.properties?.sessionID === sessionID) {
        if (event.properties.status === "idle") return
      }
      if (controller.signal.aborted) throw new Error("timeout waiting for session idle")
    }
  } finally {
    clearTimeout(timer)
  }
}
```

**注意**：SSE 是全局事件流（所有 session 的事件），需要按 sessionID 过滤。且需要处理 SSE 重连、超时、进程中断等情况。

### 3.4 Session 策略 — ⚠️ 需要决策

testflow 调用 AI 时，有两种 session 使用策略：

**方案 A：复用当前 session（传 `OPENCODE_SESSION_ID`）**

- 优点：AI 的执行结果直接出现在用户当前聊天中，用户可看到完整上下文
- 缺点：testflow 和 sidebar 同时操作同一 session 有并发风险；sidebar 的 SSE listener 会自动渲染 AI 响应，与 testflow 的进度事件可能冲突/重复
- 适用场景：testflow 是 sidebar 的延伸，AI 输出本就属于当前对话

**方案 B：testflow 自建 session**

- 优点：完全隔离，无并发冲突；testflow 流程独立，不污染用户当前聊天
- 缺点：用户在 sidebar 看不到 AI 的实际执行内容，只能看 testflow 输出的摘要；session 可能出现在 session 列表中造成困惑
- 适用场景：testflow 是独立编排器，需要自己的 session 上下文

**推荐：方案 B（自建 session）**。理由：

1. testflow 的阶段编排逻辑需要独立控制 session（不同阶段可能需要不同上下文），不适合与用户聊天混用。
2. sidebar 的 `KiloProvider` 已有完善的 SSE 事件处理逻辑，同一 session 的双重 SSE 订阅会产生混乱。
3. testflow 完成后，可通过 `testflow.text` 事件将关键摘要推送到当前聊天，用户无需直接看 AI 的原始输出。
4. 如果用户确实需要查看 AI 执行详情，可在 webview 中提供"查看 agent 会话"的链接，跳转到对应 session。

### 3.5 JSON Lines 协议 — ✅ 可行，需细化

设计文档中的协议事件类型（`step`、`question`、`agent_start`、`agent_done`、`text`、`done`）是合理的。补充建议：

1. **testflow 需要双模式**：终端模式（当前 oclif 行为）和集成模式（JSON Lines）。建议通过环境变量 `KILO_INTEGRATION=1` 切换，而非命令行参数，这样 testflow 代码改动最小。

2. **新增 `error` 事件类型**：testflow 异常退出时，应有结构化的错误事件：
   ```json
   {"type":"error","code":"ARTIFACT_NOT_FOUND","message":"产物文件 xxx 不存在"}
   ```

3. **新增 `log` 事件类型**：testflow 的 `ora` spinner 和日志在集成模式下不可见，可转为 log 事件供 webview 展示：
   ```json
   {"type":"log","level":"info","message":"正在校验产物文件..."}
   ```

4. **stdin 协议**：webview → extension → SdtRunner → testflow stdin，需要统一消息格式：
   ```json
   {"type":"question_reply","id":"q1","answers":["确认"]}
   {"type":"question_reject","id":"q1"}
   {"type":"abort"}
   ```

### 3.6 Webview UI 扩展 — ✅ 可行，工作量适中

需要新增的 webview 组件/改动：

1. **消息类型**：在 `messages.ts` 中新增 `testflow.*` 系列消息类型
2. **Question UI**：复用现有的 `QuestionRequestMessage` 机制（已有 `questionReply`/`questionReject` 消息类型），或新建独立的 `TestflowQuestionDock` 组件
3. **步骤进度**：新增 `TestflowStepView` 组件，渲染 `step` 事件的进度
4. **Agent 状态**：复用现有的 spinner 模式或新增轻量版

**建议复用现有 Question 机制**：kilo-vscode 已有完整的 question 流程（`QuestionRequestMessage` → webview 展示 → 用户操作 → `QuestionReplyRequest`/`QuestionRejectRequest`），testflow 的 question 可以映射到同一套 UI，避免重复开发。SdtRunner 将 testflow 的 `question` 事件转换为 `QuestionRequestMessage` 格式即可。

---

## 四、需要修正的设计细节

### 4.1 spawn 调用必须用 wrapper

设计文档中 `KiloProvider.ts` 使用 `child_process.exec()`/`spawn()`，**必须改为** `src/util/process.ts` 提供的 wrapper：

```ts
import { spawn } from "../util/process"  // NOT from "child_process"

const proc = spawn("testflow", ["new", taskName, "--dir", workspaceDir], {
  cwd: workspaceDir,
  env: { ...process.env, OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD, KILO_INTEGRATION: "1" },
  stdio: ["pipe", "pipe", "pipe"],
})
```

### 4.2 testflow 的 `--profile` 交互问题

当前 `testflow new` 在未指定 `--profile` 时会进入终端交互（`readline`），在集成模式下这会阻塞。**集成模式下必须强制指定 `--profile`**，或在未指定时通过 `question` 事件让 webview 选择。

建议：testflow 在 `KILO_INTEGRATION=1` 模式下，`--profile` 为必填参数；kilo-vscode 侧在用户输入 `/sdt-new` 后，通过 question 让用户选择 profile，再将选择结果拼入命令行。

### 4.3 SDK 依赖安装方式

设计文档写 `"@kilocode/sdk": "workspace:*"`，但 testflow 是独立仓库，无法使用 workspace 协议。实际方案：

```json
{
  "dependencies": {
    "@kilocode/sdk": "file:../testagent-kilo/packages/sdk/js"
  }
}
```

或发布到内部 npm registry 后直接引用版本号。开发阶段用 `npm link`。

### 4.4 SSE 等待逻辑的健壮性

`runAgent()` 中 "等待 session idle" 的逻辑是整个方案的技术难点。需要处理：

- SSE 连接建立前的 `promptAsync` 可能已完成（竞态）
- SSE 重连后的事件去重
- 超时处理（agent 可能卡住）
- process 被 abort 时的 SSE 清理

建议实现方式：

```ts
async function runAgent(opts: RunAgentOpts): Promise<AgentResult> {
  const { client, sessionID, prompt, skill } = opts
  const text = skill ? `@${skill} ${prompt}` : prompt

  emit({ type: "agent_start", skill, prompt })

  // 先发 prompt
  await client.session.promptAsync(
    { sessionID, parts: [{ type: "text", text }] },
    { throwOnError: true },
  )

  // 轮询 session status 作为备选方案（更可靠）
  const result = await pollSessionIdle(client, sessionID, {
    timeout: 300_000,
    interval: 2_000,
  })

  emit({ type: "agent_done", success: result.status === "idle", summary: result.summary })
  return result
}

async function pollSessionIdle(client: KiloClient, sessionID: string, opts: PollOpts) {
  const deadline = Date.now() + opts.timeout
  while (Date.now() < deadline) {
    const { data } = await client.session.status({ directory: opts.directory })
    const status = data?.[sessionID]
    if (status === "idle") return { status: "idle" }
    await new Promise(r => setTimeout(r, opts.interval))
  }
  throw new Error("agent timeout")
}
```

**推荐轮询而非纯 SSE**：轮询更简单、更可靠，SSE 在 CLI 环境下的连接管理复杂度高。性能影响可忽略（2s 间隔的 HTTP GET）。

---

## 五、改动清单与文件映射

### 5.1 kilo-vscode 侧

| 文件 | 改动 | 说明 |
|------|------|------|
| `webview-ui/src/hooks/useSlashCommand.ts` | 追加 `/sdt-new` 等命令 | 注册斜杠命令 |
| `webview-ui/src/types/messages.ts` | 新增 `testflow.*` 消息类型 | Extension ↔ Webview 通信协议 |
| `webview-ui/src/components/chat/TestflowView.tsx` | **新建** | 渲染 testflow 步骤/进度 |
| `src/testagent/sdt-runner.ts` | **新建** | spawn testflow，解析 JSON Lines，管理生命周期 |
| `src/KiloProvider.ts` | 拦截 `/sdt-*`，调用 SdtRunner | handleSendMessage 入口处 |

### 5.2 testflow 侧

| 文件 | 改动 | 说明 |
|------|------|------|
| `package.json` | 添加 `@kilocode/sdk` 依赖 | SDK 通信 |
| `src/lib/kilo.ts` | **新建** | `emit()`, `ask()`, `runAgent()` 封装 |
| `src/core/ai-client.ts` | **新建** | `createAIClient()` 工厂函数 |
| `src/commands/new.ts` | 支持集成模式 | 检测 `KILO_INTEGRATION` 环境变量 |
| `src/types/protocol.types.ts` | **新建** | JSON Lines 协议类型定义 |

---

## 六、开发优先级建议

### P0 — 最小可行集成（打通链路）

1. **SdtRunner**：spawn testflow + 解析 stdout JSON Lines + 转发到 webview
2. **testflow 集成模式**：`KILO_INTEGRATION=1` 时输出 JSON Lines，禁用 ora/readline 交互
3. **斜杠命令注册**：`/sdt-new` 填入输入框
4. **KiloProvider 拦截**：检测 `/sdt-*` 前缀，转给 SdtRunner
5. **webview 基础渲染**：`text` 和 `done` 事件渲染为聊天消息

### P1 — 交互增强

6. **Question 机制**：testflow `ask()` → webview 展示选项 → stdin 回复
7. **步骤进度**：`step` 事件渲染进度条/步骤列表
8. **Agent 执行**：`runAgent()` + session idle 等待 + `agent_start/done` 事件
9. **Abort 支持**：webview 中止 → SdtRunner kill 进程

### P2 — 体验优化

10. **产物校验**：testflow 在 AI 调用前校验前置产物，失败时输出 `error` 事件
11. **日志流**：`log` 事件实时展示 testflow 内部日志
12. **Session 链接**：完成后提供"查看 agent 会话"链接

---

## 七、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| SDK 在 Node.js CLI 中 SSE 行为不稳定 | `runAgent()` 等待不可靠 | 用轮询替代 SSE，降级到 `client.session.status()` 轮询 |
| testflow 进程异常退出，SdtRunner 未收到 `done` 事件 | webview 卡在等待状态 | SdtRunner 监听 `proc.on("close")` 和 `proc.on("error")`，补发 `done` 事件 |
| Windows 上 testflow 不在 PATH | spawn 失败 | SdtRunner 启动前 `which testflow` 检查，失败时提示用户安装 |
| 同一 session 被 testflow 和 sidebar 同时操作 | 消息混乱 | testflow 自建独立 session（方案 B） |
| testflow 命令耗时过长 | 用户等待体验差 | 支持后台运行 + 进度条 + abort |

---

## 八、与 design.md 的差异对照

| design.md 中的描述 | 本方案的调整 | 原因 |
|---|---|---|
| `exec()` 调用 testflow | 改为 `spawn()` via `src/util/process.ts` | exec 一次性执行无法双向通信；Windows 需 windowsHide |
| `"@kilocode/sdk": "workspace:*"` | 改为 npm link / 内部 registry | testflow 是独立仓库，不支持 workspace 协议 |
| 复用 `OPENCODE_SESSION_ID` | 改为 testflow 自建 session | 避免与 sidebar SSE 冲突，隔离编排逻辑 |
| SSE 等待 session idle | 改为轮询 `client.session.status()` | SSE 在 CLI 环境中连接管理复杂，轮询更可靠 |
| 新建 `TestflowQuestionDock` | 建议复用现有 Question 机制 | 避免重复开发，已有完整 question UI 流程 |
| `--profile` 可选交互 | 集成模式下必填或通过 question 选择 | 避免 readline 阻塞 stdin |
| 未提及 testflow 双模式 | 通过 `KILO_INTEGRATION=1` 环境变量切换 | 最小改动实现 JSON Lines 模式 |
