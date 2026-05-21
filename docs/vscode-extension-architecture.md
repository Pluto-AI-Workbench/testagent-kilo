# VS Code 插件架构：与 opencode 和 testflow 的交互机制

> 本文档描述 `packages/kilo-vscode/` 插件如何与 CLI 后端（opencode）以及 testflow 工具交互，涵盖前后端两条链路。

---

## 目录

1. [整体架构](#整体架构)
2. [与 opencode 的交互](#与-opencode-的交互)
   - [后端进程启动](#后端进程启动)
   - [HTTP + SSE 通信](#http--sse-通信)
   - [SDK 层](#sdk-层)
   - [服务端路由结构](#服务端路由结构)
3. [与 testflow 的交互](#与-testflow-的交互)
   - [触发机制](#触发机制)
   - [进程通信协议](#进程通信协议)
4. [前端展示差异](#前端展示差异)
   - [opencode 消息渲染](#opencode-消息渲染)
   - [testflow 面板渲染](#testflow-面板渲染)
   - [对比总结](#对比总结)
5. [关键文件索引](#关键文件索引)

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                               │
│                                                                 │
│  extension.ts                                                   │
│  ├── KiloConnectionService (全局单例)                            │
│  │   ├── ServerManager / NodeServerManager  ← 启动 CLI 进程      │
│  │   ├── KiloClient (SDK HTTP 客户端)                            │
│  │   └── SdkSSEAdapter (SSE 重连循环)                            │
│  │                                                              │
│  ├── KiloProvider (侧边栏 chat webview 宿主)                     │
│  ├── AgentManagerProvider (多 session 面板)                      │
│  └── SdtRunner (spawn testflow 进程)          ← testagent 专属   │
│                                                                 │
│  ↕  vscode.postMessage / onDidReceiveMessage                    │
│                                                                 │
│  Webview (Chromium 沙箱, SolidJS)                               │
│  ├── ChatView                                                   │
│  │   ├── MessageList  ← opencode 消息流                          │
│  │   └── TestflowView ← testflow 面板（testagent 专属）           │
│  └── TestflowProvider (testflow 状态 store)                     │
│                                                                 │
│  ↕  HTTP + SSE (localhost, Basic Auth)                          │
│                                                                 │
│  CLI 进程 (Bun binary 或 Node.js cli.mjs)                       │
│  └── Hono HTTP Server                                           │
│      ├── GET  /global/event          ← 全局 SSE 事件流           │
│      ├── GET  /global/health         ← 健康轮询                  │
│      ├── PUT  /kilocode/testagent/user ← 同步用户 ID             │
│      ├── POST /session/create        ← 创建 session             │
│      └── ...                                                    │
│                                                                 │
│  testflow 进程 (按需 spawn)           ← testagent 专属           │
│  └── stdout JSON lines / stdin JSON lines                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 与 opencode 的交互

### 后端进程启动

编译时通过 esbuild `define` 注入 `BACKEND_RUNTIME`，决定运行时类型：

| 运行时 | 管理类 | 行为 |
|--------|--------|------|
| `testagent-bun` | `ServerManager` | spawn `bin/testagent serve --port 0`（Bun 二进制） |
| `testagent-nodejs` | `NodeServerManager` | spawn `node --experimental-sqlite nodejs-server/cli.mjs --port 0` |

两种方式共同点：
- 生成随机 `password`，通过 `OPENCODE_SERVER_PASSWORD` 环境变量传入
- 监听 stdout 解析端口号（`parseServerPort`）
- 30 秒超时，失败则 reject

Bun 版本额外行为：
- 解析 stderr 中的 `[TESTAGENT_NOTIFICATION]` JSON 行，弹出 VS Code 通知
- 传入 `TESTAGENT_USER_ID`、`TESTAGENT_USER_NAME`、`KILO_CLIENT=vscode` 等专属环境变量

### HTTP + SSE 通信

连接建立流程（`KiloConnectionService.doConnect()`）：

```
serverManager.getServer()
  → { port, password }
  → createKiloClient({ baseUrl: "http://127.0.0.1:<port>", Authorization: "Basic opencode:<password>" })
  → new SdkSSEAdapter(client)
  → sseClient.connect()        ← 等待 SSE "connected" 状态后 resolve
  → startHealthPoll()          ← 每 10s GET /global/health 作为第二检测通道
  → syncUserId()               ← PUT /kilocode/testagent/user 同步 VS Code 登录态
```

**SSE 重连策略**（`SdkSSEAdapter`）：
- 外层 `while (!aborted)` 循环，指数退避（250ms → 30s 上限）
- 每次连接有独立 `AbortController`，15s 无心跳则强制重连
- 服务端每 10s 发一次 `server.heartbeat`，给 5s 宽限窗口
- 收到事件后广播给所有注册的 `KiloProvider` 实例

**Webview ↔ Extension Host 通信**：

Webview 无法直接调用 SDK，所有 HTTP 请求由 Extension Host 代理：
- Webview → Extension Host：`vscode.postMessage({ type: "sendMessage", ... })`
- Extension Host → Webview：`panel.webview.postMessage({ type: "partUpdated", ... })`
- SSE 事件由 `KiloProvider` 接收后，过滤出当前 session 相关事件再转发给 webview

### SDK 层

SDK 由 `packages/opencode/src/server/` 的 OpenAPI spec **自动生成**，位于 `packages/sdk/js/src/gen/`，不要手动编辑。

`createKiloClient()` 的关键处理：
- 注入 `x-kilo-directory` header（GET 请求时重写为 `?directory=` 查询参数）
- 设置 `duplex: "half"` 兼容 Node.js 流式请求
- 禁用 Bun 默认请求超时（SSE 长连接需要）

### 服务端路由结构

```
/global/event              → 全局 SSE，包装 GlobalBus 所有事件为 { directory, payload }
/global/health             → 健康检查，返回 { healthy: true, version }
/global/config             → 全局配置 GET/PATCH
/global/dispose            → 销毁所有 Instance
/kilocode/testagent/user   → testagent 专属：同步用户 ID 和 token（PUT）
/session/*                 → session CRUD、消息发送
/permission/*              → 权限请求列表和回复
/question/*                → 问题交互
/suggestion/*              → 建议交互
/network/*                 → 网络等待管理
```

---

## 与 testflow 的交互

testflow 是 testagent 专属功能（全部标注 `testagent_change`），通过 `/sdt-*` 斜杠命令触发，与 opencode 完全独立。

### 触发机制

```
用户输入 /sdt-new <args>
  → KiloProvider.handleSdtCommand()
  → SdtRunner.run({ cmd, args, cwd, env: { KILO_INTEGRATION: "1" }, sessionID, post })
  → spawn("testflow", [cmd, ...args], { stdio: ["pipe", "pipe", "pipe"] })
```

`SdtRunner` 是 Extension Host 中的一个独立类（`src/testagent/sdt-runner.ts`），与 `KiloConnectionService` 无关。

### 进程通信协议

**testflow → 插件（stdout JSON lines）：**

| 事件类型 | 含义 | 关键字段 |
|----------|------|----------|
| `step` | 执行步骤更新 | `title`, `status`（start/complete/exception）, `stage_id` |
| `question` | 需要用户回答 | `id`, `header`, `question`, `options`, `multiple`, `custom` |
| `agent_start` | AI agent 开始执行 | `skill`, `prompt` |
| `agent_done` | AI agent 执行完毕 | — |
| `text` | 普通文本输出 | `text` |
| `log` | 日志行 | `level`, `message` |
| `error` | 错误信息 | `error` |
| `done` | 进程结束 | `exitCode`, `summary` |

每条事件被包装为 `testflow.<type>` 后通过 `post()` 回调发给 webview。

**插件 → testflow（stdin JSON lines）：**

```json
{ "type": "question_reply", "id": "<id>", "answers": ["选项A"] }
{ "type": "question_reject", "id": "<id>" }
```

`abort()` 直接 `proc.kill("SIGTERM")`。

---

## 前端展示差异

这是两者最直观的区别所在。

> **注意**：以下描述的是改造后的状态。testflow 现在复用 opencode 的对话 UI 渲染路径，不再有独立的 `TestflowView` 面板。

### opencode 消息渲染

opencode 的 AI 对话通过 **`MessageList` + `VscodeSessionTurn` + `AssistantMessage`** 渲染，数据来自 SDK SSE 事件流。

**渲染链路：**

```
SSE 事件 (message.part.updated)
  → KiloProvider 接收 → postMessage 给 webview
  → session context store 更新 (data.store.part[messageId])
  → MessageList 虚拟化列表重新渲染
  → VscodeSessionTurn → AssistantMessage
  → For each part → Dynamic<PART_MAPPING[part.type]>
```

**Part 类型映射（`PART_MAPPING`）：**

| Part 类型 | 渲染组件 | 说明 |
|-----------|----------|------|
| `text` | Markdown 渲染器 | AI 回复文本，流式追加 |
| `reasoning` | 折叠推理块 | 思维链内容 |
| `tool` | `ToolRegistry.render(tool)` | 工具调用卡片（bash、read、write 等） |
| `tool` (question) | `QuestionDock` | 内联问题交互 |
| `tool` (suggest) | `SuggestBar` | 内联建议交互 |
| `tool` (todowrite/todoread) | `TodoToolCard` | 完成后才显示 |

**特点：**
- 消息按 **turn（轮次）** 组织，每个用户消息对应一组 assistant parts
- 使用 `Virtualizer` 虚拟化长列表，支持自动滚动
- 数据持久化在 session store，切换 session 后可恢复
- 工具调用有完整的 pending → running → completed 状态流转
- 权限请求（`PermissionDock`）显示在底部 dock，不嵌入消息流

### testflow 面板渲染

testflow 通过 **`TestflowMessageBridge`**（Extension Host）将进程事件翻译成标准的 `messageCreated` + `partUpdated` 消息，注入到当前 session，由 `MessageList` 原生渲染。

**渲染链路：**

```
testflow 进程 stdout JSON line
  → SdtRunner.dispatch() → TestflowMessageBridge 方法
  → bridge.post() → KiloProvider.postMessage()
  → webview session store 更新（messageCreated / partUpdated）
  → MessageList → VscodeSessionTurn → AssistantMessage
  → PART_MAPPING["tool"] → ToolRegistry.render("testflow-*")
  → TestflowStepTool / TestflowQuestionTool / TestflowAgentTool
```

**事件 → Part 映射（`TestflowMessageBridge`）：**

| testflow 事件 | 生成的 Part | tool 名称 | 状态流转 |
|--------------|------------|-----------|---------|
| `step` (start) | `tool` part | `testflow-step` | `running` |
| `step` (complete/exception) | `tool` part 更新 | `testflow-step` | `completed` / `error` |
| `question` | `tool` part | `testflow-question` | `pending`（等待回答） |
| 用户回答问题 | `tool` part 更新 | `testflow-question` | `completed` |
| `agent_start` | `tool` part | `testflow-agent` | `running` |
| `agent_done` | `tool` part 更新 | `testflow-agent` | `completed` |
| `text` / `log` | `text` part | — | 追加到同一 part |
| `error` | `text` part | — | 前缀 `! ` |
| `done` | 更新 assistant message `time.completed` + `sessionStatus idle` | — | — |

**问题交互流程：**

```
testflow 进程暂停等待
  → bridge.onQuestion() → partUpdated (testflow-question, pending)
  → TestflowQuestionTool 渲染选项按钮
  → 用户点击 → vscode.postMessage({ type: "testflow.questionReply", id, answers })
  → KiloProvider → sdtRunner.reply() → bridge.onQuestionAnswered()
  → partUpdated (testflow-question, completed)
  → testflow 进程 stdin 收到 question_reply，继续执行
```

**关键文件：**

| 文件 | 职责 |
|------|------|
| `src/testagent/testflow-bridge.ts` | 事件翻译层，生成 messageCreated/partUpdated |
| `src/testagent/sdt-runner.ts` | spawn testflow 进程，调用 bridge 方法 |
| `webview-ui/src/components/chat/TestflowToolRenderers.tsx` | 三个 tool 渲染器 + 注册函数 |
| `webview-ui/src/styles/testflow.css` | tool 渲染器样式 |

### 对比总结

| 维度 | opencode 消息渲染 | testflow 渲染（改造后） |
|------|------------------|------------------|
| **数据来源** | SDK SSE 事件流（HTTP 长连接） | 子进程 stdout → `TestflowMessageBridge` 翻译 |
| **渲染组件** | `MessageList` + `AssistantMessage` | 同上（完全复用） |
| **组织方式** | 按 turn（轮次）分组，多消息历史 | 同上（每次 `/sdt-*` 产生一个新 turn） |
| **状态管理** | session context store（持久化） | 同上（持久化，可滚动历史） |
| **流式更新** | Part 级别增量更新（`partUpdated`） | 同上（bridge 生成相同格式的 `partUpdated`） |
| **交互方式** | 权限/问题 dock，工具调用内联 | 工具调用内联（`testflow-question` tool part） |
| **历史恢复** | 切换 session 后完整恢复 | 同上 |
| **位置** | 占据主消息区域（可滚动） | 同上 |
| **虚拟化** | 有（`Virtualizer`） | 同上 |
| **并发** | 多 session 并行，各自独立 | 同一时刻只能运行一个 testflow 进程 |
| **生命周期** | 与 session 绑定，长期存在 | 与 session 绑定（改造后持久化） |
| **自定义 tool** | `bash`、`read`、`edit` 等 | `testflow-step`、`testflow-question`、`testflow-agent` |

---

## 关键文件索引

### Extension Host

| 文件 | 职责 |
|------|------|
| `src/extension.ts` | 插件入口，注册所有 Provider 和命令 |
| `src/services/cli-backend/connection-service.ts` | 共享连接服务（server + SDK + SSE） |
| `src/services/cli-backend/server-manager.ts` | 启动 Bun `testagent serve` 二进制 |
| `src/services/cli-backend/node-server-manager.ts` | 启动 Node.js `cli.mjs` 服务 |
| `src/services/cli-backend/sdk-sse-adapter.ts` | SSE 重连循环，事件 pub/sub |
| `src/services/cli-backend/runtime.ts` | 编译时后端选择（`BACKEND_RUNTIME`） |
| `src/KiloProvider.ts` | 侧边栏 chat webview 宿主，testflow 命令处理 |
| `src/agent-manager/AgentManagerProvider.ts` | 多 session worktree 面板 |
| `src/testagent/sdt-runner.ts` | spawn testflow 进程，桥接 webview |

### Webview

| 文件 | 职责 |
|------|------|
| `webview-ui/src/components/chat/ChatView.tsx` | 主 chat 容器，集成 MessageList 和 TestflowView |
| `webview-ui/src/components/chat/MessageList.tsx` | 虚拟化消息列表，渲染 opencode 对话 |
| `webview-ui/src/components/chat/AssistantMessage.tsx` | 渲染 assistant message 的所有 parts |
| `webview-ui/src/components/chat/TestflowView.tsx` | testflow 执行面板 |
| `webview-ui/src/context/testflow.tsx` | testflow SolidJS context/store |
| `webview-ui/src/context/session.tsx` | opencode session 状态管理 |

### CLI 后端

| 文件 | 职责 |
|------|------|
| `packages/testagent-core/packages/opencode/src/server/server.ts` | Hono HTTP 服务器入口 |
| `packages/testagent-core/packages/opencode/src/server/routes/global.ts` | `/global/*` 路由 + SSE |
| `packages/testagent-core/packages/opencode/src/server/routes/testagent.ts` | `/kilocode/testagent/*` 专属路由 |
| `packages/testagent-core/packages/opencode/src/server/routes/instance/event.ts` | 实例级 SSE |

### SDK

| 文件 | 职责 |
|------|------|
| `packages/sdk/js/src/v2/client.ts` | `createKiloClient()` 工厂函数 |
| `packages/sdk/js/src/gen/sdk.gen.ts` | 自动生成的 `KiloClient` 类型化方法 |
| `packages/sdk/js/src/gen/types.gen.ts` | 自动生成的所有 API 类型 |
