# testflow × kilo-vscode 集成设计方案

## 一、背景与目标

在 kilo-vscode 插件的聊天界面中增加斜杠命令（如 `/sdt-new`），触发后启动 testflow CLI 流程。testflow 作为编排层，可以向用户提问、调用 opencode agent 执行 skill、根据结果决定下一步，整个过程的进度和交互实时展示在 kilo-vscode 界面上。

### 两个项目的关系

kilo 和 testflow 是**两个完全独立的仓库**，通过"进程边界 + 约定协议"关联：

- kilo-vscode extension host spawn testflow 子进程
- 通过环境变量传入 opencode server 地址和 session ID
- 通过 stdout/stdin JSON Lines 双向通信
- testflow 直接 HTTP 调用 opencode server API

代码层面零依赖，唯一需要同步的是双方约定的 JSON Lines 协议格式。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  kilo-vscode (VS Code Extension)                            │
│                                                             │
│  ┌──────────────┐  消息   ┌──────────────────────────────┐  │
│  │  webview     │ ──────► │  extension host              │  │
│  │              │         │  (KiloProvider.ts)           │  │
│  │  /sdt-new    │ ◄────── │  拦截 /sdt-* 消息            │  │
│  │  输入框      │  事件   │  spawn testflow 进程         │  │
│  │  question UI │         │  转发 testflow 输出          │  │
│  └──────────────┘         └──────────┬───────────────────┘  │
│                                      │ spawn                 │
└──────────────────────────────────────┼──────────────────────┘
                                       │
               ┌───────────────────────▼─────────────────────┐
               │  testflow CLI                                │
               │                                             │
               │  testflow new <taskname>                    │
               │  ├─ 读取 OPENCODE_SERVER_URL (env)          │
               │  ├─ 读取 OPENCODE_SESSION_ID (env)          │
               │  ├─ 输出 JSON Lines 到 stdout               │
               │  └─ 通过 HTTP 驱动 opencode agent           │
               └──────────────┬──────────────────────────────┘
                              │ HTTP + SSE
               ┌──────────────▼──────────────────────────────┐
               │  opencode server（已在运行）                 │
               │                                             │
               │  POST /session/:id/prompt_async             │
               │  GET  /event  (SSE 事件流)                  │
               │  POST /question/:id/reply                   │
               └─────────────────────────────────────────────┘
```

---

## 三、通信协议：JSON Lines

### 3.1 testflow → extension host（stdout）

每行一个 JSON 对象，共 7 种事件类型：

```ts
type TestflowEvent =
  // 普通文本进度
  | { type: "text"; text: string }

  // 步骤标题（显示为加粗标题行）
  | { type: "step"; title: string; status: "start" | "done" | "error" }

  // 向用户提问（在 kilo UI 弹出 question dock）
  | {
      type: "question"
      id: string
      header: string
      question: string
      options: { label: string; description: string }[]
      multiple?: boolean
      custom?: boolean
    }

  // 通知 UI：opencode agent 开始执行
  | { type: "agent_start"; skill?: string; prompt: string }

  // 通知 UI：opencode agent 执行完成
  | { type: "agent_done"; success: boolean; summary?: string }

  // 整个流程结束
  | { type: "done"; exitCode: number; summary?: string }

  // 错误
  | { type: "error"; message: string }
```

### 3.2 extension host → testflow（stdin）

```ts
type TestflowInput =
  // 用户回答了 question
  | { type: "question_reply"; id: string; answers: string[] }

  // 用户关闭/拒绝了 question
  | { type: "question_reject"; id: string }

  // 用户中止流程
  | { type: "abort" }
```

---

## 四、各层改动范围

### 4.1 webview 层

**改动文件：`packages/kilo-vscode/webview-ui/src/hooks/useSlashCommand.ts`**

注册 `/sdt-*` 命令。不设置 `action`，走默认路径（把命令名填入输入框，用户补充参数后 Enter 发送）：

```ts
// testagent_change start
{
  name: "sdt-new",
  description: "通过 testflow 创建新任务",
  hints: ["testflow", "task", "new"],
},
// testagent_change end
```

**改动文件：`packages/kilo-vscode/webview-ui/src/types/messages.ts`**

新增 testflow 相关消息类型（extension → webview 方向）：

```ts
// testagent_change start
export interface TestflowTextMessage {
  type: "testflow.text"
  sessionID: string
  text: string
}

export interface TestflowStepMessage {
  type: "testflow.step"
  sessionID: string
  title: string
  status: "start" | "done" | "error"
}

export interface TestflowQuestionMessage {
  type: "testflow.question"
  sessionID: string
  id: string
  header: string
  question: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}

export interface TestflowQuestionResolvedMessage {
  type: "testflow.questionResolved"
  id: string
}

export interface TestflowAgentStartMessage {
  type: "testflow.agentStart"
  sessionID: string
  skill?: string
  prompt: string
}

export interface TestflowAgentDoneMessage {
  type: "testflow.agentDone"
  sessionID: string
  success: boolean
  summary?: string
}

export interface TestflowDoneMessage {
  type: "testflow.done"
  sessionID: string
  exitCode: number
  summary?: string
}

export interface TestflowErrorMessage {
  type: "testflow.error"
  sessionID: string
  message: string
}
// testagent_change end
```

新增 webview → extension 方向的回复消息：

```ts
// testagent_change start
export interface TestflowQuestionReplyMessage {
  type: "testflow.questionReply"
  id: string
  answers: string[]
}

export interface TestflowQuestionRejectMessage {
  type: "testflow.questionReject"
  id: string
}

export interface TestflowAbortMessage {
  type: "testflow.abort"
  sessionID: string
}
// testagent_change end
```

**新增文件：`packages/kilo-vscode/webview-ui/src/components/chat/TestflowQuestionDock.tsx`**

复用现有 `question-dock.css` 样式，渲染 testflow 发来的 question，用户选择后通过 `vscode.postMessage` 发回。

### 4.2 extension host 层

**新增文件：`packages/kilo-vscode/src/testagent/sdt-runner.ts`**

核心模块，负责进程管理和协议转换：

```ts
// testagent_change - new file
import { spawn, ChildProcess } from "child_process"
import * as readline from "readline"

export class SdtRunner {
  private proc: ChildProcess | null = null

  run(opts: {
    cmd: string           // "new"
    args: string[]        // ["taskname"]
    sessionID: string
    serverUrl: string     // opencode server URL，如 http://127.0.0.1:16384
    post: (msg: unknown) => void
  }) {
    this.proc = spawn("testflow", [opts.cmd, ...opts.args], {
      env: {
        ...process.env,
        OPENCODE_SERVER_URL: opts.serverUrl,
        OPENCODE_SESSION_ID: opts.sessionID,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    readline.createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      try {
        const event = JSON.parse(line)
        this.dispatch(event, opts.sessionID, opts.post)
      } catch {
        opts.post({ type: "testflow.text", sessionID: opts.sessionID, text: line })
      }
    })

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      opts.post({ type: "testflow.text", sessionID: opts.sessionID, text: chunk.toString() })
    })

    this.proc.on("close", (code) => {
      opts.post({ type: "testflow.done", sessionID: opts.sessionID, exitCode: code ?? 1 })
      this.proc = null
    })
  }

  reply(id: string, answers: string[]) {
    this.write({ type: "question_reply", id, answers })
  }

  reject(id: string) {
    this.write({ type: "question_reject", id })
  }

  abort() {
    this.write({ type: "abort" })
  }

  private write(msg: unknown) {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n")
  }

  private dispatch(event: { type: string; [k: string]: unknown }, sid: string, post: (m: unknown) => void) {
    switch (event.type) {
      case "text":
        post({ type: "testflow.text", sessionID: sid, text: event.text })
        break
      case "step":
        post({ type: "testflow.step", sessionID: sid, title: event.title, status: event.status })
        break
      case "question":
        post({ type: "testflow.question", sessionID: sid, ...event })
        break
      case "agent_start":
        post({ type: "testflow.agentStart", sessionID: sid, skill: event.skill, prompt: event.prompt })
        break
      case "agent_done":
        post({ type: "testflow.agentDone", sessionID: sid, success: event.success, summary: event.summary })
        break
      case "done":
        post({ type: "testflow.done", sessionID: sid, exitCode: event.exitCode, summary: event.summary })
        break
      case "error":
        post({ type: "testflow.error", sessionID: sid, message: event.message })
        break
    }
  }
}
```

**改动文件：`packages/kilo-vscode/src/KiloProvider.ts`**

在 webview 消息处理器中拦截 `/sdt-` 前缀的 prompt，以及处理 question 回复：

```ts
// testagent_change start
// 在 sendMessage 处理逻辑中，发送前检查
if (text.startsWith("/sdt-")) {
  const parts = text.slice(1).split(" ")
  const cmd = parts[0].slice(4)   // "new"
  const args = parts.slice(1)     // ["taskname"]
  const serverUrl = this.connectionService.getServerConfig()?.baseUrl ?? ""
  sdtRunner.run({ cmd, args, sessionID, serverUrl, post: (m) => this.postMessage(m) })
  return
}

// 处理 question 回复
case "testflow.questionReply":
  sdtRunner.reply(message.id, message.answers)
  break
case "testflow.questionReject":
  sdtRunner.reject(message.id)
  break
case "testflow.abort":
  sdtRunner.abort()
  break
// testagent_change end
```

### 4.3 testflow CLI 层（独立仓库）

testflow 内部实现两个工具函数，供各命令使用：

**`src/lib/kilo.ts`**（新增）

```ts
import * as readline from "readline"

// 输出 JSON Line 到 stdout
export function emit(event: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(event) + "\n")
}

// 向用户提问，阻塞等待 stdin 回复
export function ask(opts: {
  id: string
  header: string
  question: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}): Promise<string[]> {
  emit({ type: "question", ...opts })
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    rl.once("line", (line) => {
      rl.close()
      const msg = JSON.parse(line)
      if (msg.type === "question_reply" && msg.id === opts.id) resolve(msg.answers)
      else if (msg.type === "question_reject") reject(new Error("user rejected"))
      else if (msg.type === "abort") reject(new Error("aborted"))
    })
  })
}

// 调用 opencode agent 执行 prompt，等待 session 变为 idle
export async function runAgent(opts: {
  serverUrl: string
  sessionID: string
  prompt: string
  skill?: string
}): Promise<{ success: boolean; summary?: string }> {
  const text = opts.skill ? `@${opts.skill} ${opts.prompt}` : opts.prompt

  emit({ type: "agent_start", skill: opts.skill, prompt: opts.prompt })

  // 先订阅 SSE，再发送 prompt，避免竞态
  const result = await new Promise<{ success: boolean; summary?: string }>((resolve) => {
    const es = new EventSource(`${opts.serverUrl}/event`)
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data)
      if (ev.type !== "session.updated") return
      if (ev.properties?.sessionID !== opts.sessionID) return
      const status = ev.properties?.status
      if (status === "idle") {
        es.close()
        resolve({ success: true, summary: ev.properties?.title })
      }
      if (status === "error") {
        es.close()
        resolve({ success: false })
      }
    }
    es.onerror = () => {
      es.close()
      resolve({ success: false })
    }

    fetch(`${opts.serverUrl}/session/${opts.sessionID}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => resolve({ success: false }))
  })

  emit({ type: "agent_done", success: result.success, summary: result.summary })
  return result
}
```

**`src/commands/new.ts`**（示例命令实现）

```ts
import { emit, ask, runAgent } from "../lib/kilo"

export async function cmdNew(taskname: string) {
  const server = process.env.OPENCODE_SERVER_URL!
  const sessionID = process.env.OPENCODE_SESSION_ID!

  emit({ type: "step", title: `创建任务: ${taskname}`, status: "start" })

  // 向用户确认
  const answers = await ask({
    id: "confirm",
    header: "确认任务",
    question: `确认要创建任务 "${taskname}" 吗？`,
    options: [
      { label: "确认", description: "继续执行" },
      { label: "取消", description: "放弃" },
    ],
  })

  if (answers[0] === "取消") {
    emit({ type: "done", exitCode: 0, summary: "已取消" })
    return
  }

  // 调用 opencode agent
  const result = await runAgent({
    serverUrl: server,
    sessionID,
    prompt: `执行任务 ${taskname}`,
    skill: "my-skill",
  })

  if (!result.success) {
    emit({ type: "error", message: "agent 执行失败" })
    emit({ type: "done", exitCode: 1 })
    return
  }

  emit({ type: "step", title: `创建任务: ${taskname}`, status: "done" })
  emit({ type: "done", exitCode: 0, summary: `任务 ${taskname} 创建成功` })
}
```

---

## 五、数据流时序

```
用户输入 "/sdt-new my-task" 并按 Enter
    │
    ▼
webview → extension: sendMessage { text: "/sdt-new my-task", sessionID }
    │
    ▼
extension: 检测到 /sdt- 前缀，不走 opencode，转给 SdtRunner
    │
    ▼
SdtRunner: spawn("testflow", ["new", "my-task"], { env: { OPENCODE_SERVER_URL, OPENCODE_SESSION_ID } })
    │
testflow stdout: {"type":"step","title":"创建任务: my-task","status":"start"}
    │
    ▼
extension → webview: { type: "testflow.step", title: "创建任务: my-task", status: "start" }
    │
    ▼
webview: 在 chat 显示步骤标题

testflow stdout: {"type":"question","id":"q1","header":"确认任务",...}
    │
    ▼
extension → webview: { type: "testflow.question", ... }
    │
    ▼
webview: 弹出 TestflowQuestionDock
    │
用户点击"确认"
    │
    ▼
webview → extension: { type: "testflow.questionReply", id: "q1", answers: ["确认"] }
    │
    ▼
SdtRunner: proc.stdin.write('{"type":"question_reply","id":"q1","answers":["确认"]}\n')
    │
    ▼
testflow: 收到回答，继续执行

testflow stdout: {"type":"agent_start","skill":"my-skill","prompt":"执行任务 my-task"}
    │
    ▼
extension → webview: { type: "testflow.agentStart", ... }（显示 spinner）
    │
testflow: POST /session/:id/prompt_async → opencode 开始执行 skill
testflow: 监听 GET /event SSE，等待 session idle
    │
opencode agent 执行完成，SSE 推送 session.updated status=idle
    │
testflow stdout: {"type":"agent_done","success":true,"summary":"..."}
    │
    ▼
extension → webview: { type: "testflow.agentDone", ... }（隐藏 spinner）

testflow stdout: {"type":"done","exitCode":0,"summary":"任务创建成功"}
    │
    ▼
extension → webview: { type: "testflow.done", ... }（流程结束）
```

---

## 六、改动文件汇总

### kilo 仓库（`packages/kilo-vscode/`）

| 文件 | 类型 | 说明 |
|------|------|------|
| `webview-ui/src/hooks/useSlashCommand.ts` | 改动 | 注册 `/sdt-*` 命令 |
| `webview-ui/src/types/messages.ts` | 改动 | 新增 testflow 消息类型 |
| `webview-ui/src/components/chat/TestflowQuestionDock.tsx` | 新增 | testflow question UI 组件 |
| `src/testagent/sdt-runner.ts` | 新增 | spawn/管理 testflow 进程 |
| `src/KiloProvider.ts` | 改动 | 拦截 `/sdt-*` 消息，接入 SdtRunner |

所有改动均在 `packages/kilo-vscode/` 内，不触碰 `packages/opencode/` 共享代码，无需 `kilocode_change` 标记。

### testflow 仓库（独立）

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/lib/kilo.ts` | 新增 | emit / ask / runAgent 工具函数 |
| `src/commands/new.ts` | 新增/改动 | 具体命令实现 |

---

## 七、两个项目的关联方式

### 运行时关联

```
kilo-vscode
  └─ spawn testflow（PATH 中或配置绝对路径）
       ├─ env: OPENCODE_SERVER_URL=http://127.0.0.1:16384
       └─ env: OPENCODE_SESSION_ID=session_xxx
```

### 协议约定

双方唯一需要同步的是 JSON Lines 格式。早期用文档约定（本文件），协议稳定后可抽出 `@testagent/sdt-protocol` 共享包。

### testflow 的安装

| 阶段 | 方式 |
|------|------|
| 开发阶段 | 配置绝对路径，或把 testflow 目录加入 PATH |
| 生产阶段 | 打包进 VSIX（类似 opencode CLI 的做法），或要求用户单独安装 |

---

## 八、测试方式

### 8.1 协议层测试（不依赖 kilo，纯 testflow 侧）

在 testflow 仓库中，用脚本模拟 extension host 的行为：

```bash
# mock-host.sh：模拟 extension host，读取 testflow 输出并自动回复 question
OPENCODE_SERVER_URL=http://127.0.0.1:16384 \
OPENCODE_SESSION_ID=test-session-001 \
testflow new my-task | while IFS= read -r line; do
  echo "[stdout] $line"
  type=$(echo "$line" | jq -r '.type')
  if [ "$type" = "question" ]; then
    id=$(echo "$line" | jq -r '.id')
    # 自动回复第一个选项
    label=$(echo "$line" | jq -r '.options[0].label')
    echo "{\"type\":\"question_reply\",\"id\":\"$id\",\"answers\":[\"$label\"]}"
  fi
done
```

或者用 Node.js 写更完整的 mock：

```ts
// test/mock-host.ts
import { spawn } from "child_process"
import * as readline from "readline"

const proc = spawn("testflow", ["new", "test-task"], {
  env: {
    ...process.env,
    OPENCODE_SERVER_URL: "http://127.0.0.1:16384",
    OPENCODE_SESSION_ID: "test-session-001",
  },
  stdio: ["pipe", "pipe", "pipe"],
})

readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  const event = JSON.parse(line)
  console.log("[event]", event)

  if (event.type === "question") {
    // 自动选第一个选项
    const reply = { type: "question_reply", id: event.id, answers: [event.options[0].label] }
    proc.stdin!.write(JSON.stringify(reply) + "\n")
  }
})

proc.on("close", (code) => console.log("[done] exit code:", code))
```

运行：`npx ts-node test/mock-host.ts`

### 8.2 opencode server 连通性测试（不依赖 kilo UI）

在 opencode server 已启动的情况下，直接测试 testflow 能否正确调用 agent：

```bash
# 1. 先确认 server 在运行
curl http://127.0.0.1:16384/session

# 2. 获取一个已有的 session ID
SESSION_ID=$(curl -s http://127.0.0.1:16384/session | jq -r '.[0].id')

# 3. 运行 testflow，观察它是否能正确发送 prompt 并等待结果
OPENCODE_SERVER_URL=http://127.0.0.1:16384 \
OPENCODE_SESSION_ID=$SESSION_ID \
testflow new test-task
```

### 8.3 extension host 单元测试（kilo 侧，不依赖真实 testflow）

在 `packages/kilo-vscode/` 中，用 mock 进程测试 SdtRunner：

```ts
// src/testagent/sdt-runner.test.ts
import { SdtRunner } from "./sdt-runner"
import { EventEmitter } from "events"

test("SdtRunner 正确解析 text 事件", (done) => {
  const runner = new SdtRunner()
  const messages: unknown[] = []

  // 注入 mock 进程（不真正 spawn testflow）
  runner.runWithProcess(
    mockProcess(['{"type":"text","text":"hello"}\n']),
    "session-1",
    (msg) => {
      messages.push(msg)
      expect(messages[0]).toEqual({ type: "testflow.text", sessionID: "session-1", text: "hello" })
      done()
    },
  )
})

test("SdtRunner 正确转发 question_reply 到 stdin", () => {
  const runner = new SdtRunner()
  const written: string[] = []
  const proc = mockProcess([], written)
  runner.runWithProcess(proc, "session-1", () => {})
  runner.reply("q1", ["确认"])
  expect(written[0]).toBe('{"type":"question_reply","id":"q1","answers":["确认"]}\n')
})
```

### 8.4 端到端手动测试（完整链路）

**前置条件：**
1. kilo-vscode 插件已启动（opencode server 在 16384 端口运行）
2. testflow 在 PATH 中可用

**步骤：**

1. 在 kilo-vscode 聊天框输入 `/sdt-new`，确认下拉菜单出现该命令
2. 选中后输入 `my-task`，按 Enter
3. 观察聊天界面出现步骤标题 "创建任务: my-task"
4. 观察弹出 question dock，显示确认选项
5. 点击"确认"，观察 question dock 关闭
6. 观察出现 agent 执行中的 spinner
7. 等待 agent 完成，观察 spinner 消失，显示完成摘要

**异常路径测试：**

- 点击"取消"：流程应正常结束，显示"已取消"
- 关闭 question dock（点 X）：testflow 收到 `question_reject`，应优雅退出
- 在 agent 执行中点击中止按钮：testflow 收到 `abort`，应终止进程

### 8.5 协议兼容性检查

每次修改 JSON Lines 协议时，对照以下检查表：

- [ ] `TestflowEvent` 类型定义（kilo `messages.ts`）已更新
- [ ] `TestflowInput` 类型定义（kilo `messages.ts`）已更新
- [ ] `SdtRunner.dispatch()` 的 switch 分支已覆盖新事件
- [ ] testflow `src/lib/kilo.ts` 的 `emit()` 调用格式一致
- [ ] mock-host 测试脚本已更新
