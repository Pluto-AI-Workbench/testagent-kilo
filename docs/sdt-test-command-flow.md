# /sdt-test 命令完整交互流程

本文档记录从 kilo-vscode 扩展输入 `/sdt-test` 命令后，到 testflow 执行，再到 opencode AI 交互的完整流程。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     VS Code Webview                             │
│  useSlashCommand.ts → TestflowProvider → TestflowView           │
└──────────────────────────┬──────────────────────────────────────┘
                           │ postMessage / onMessage
┌──────────────────────────▼──────────────────────────────────────┐
│                     VS Code Extension                           │
│  KiloProvider.ts → SdtRunner.ts → spawn("testflow")             │
└──────────────────────────┬──────────────────────────────────────┘
                           │ 子进程 stdin/stdout (JSON Lines)
┌──────────────────────────▼──────────────────────────────────────┐
│                     testflow CLI                                │
│  commands/test.ts → lib/kilo.ts → @kilocode/sdk                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP REST API
┌──────────────────────────▼──────────────────────────────────────┐
│                     opencode Server                             │
│  session.ts → prompt.ts → llm.ts → AI Model                    │
└─────────────────────────────────────────────────────────────────┘
```

## 第一阶段：Webview 层

### 1.1 命令定义

**文件**: `packages/kilo-vscode/webview-ui/src/hooks/useSlashCommand.ts:150-154`

```typescript
{
  name: "sdt-test",
  description: "testflow测试",
  hints: ["testflow", "test"],
}
```

- 命令没有定义 `action` 属性
- 选择后会将 `/sdt-test ` 填入输入框，等待用户输入参数并发送

### 1.2 命令选择逻辑

**文件**: `useSlashCommand.ts:213-235`

```typescript
const select = (cmd, textarea, setText, onSelect) => {
  if (cmd.action) {
    // 有 action 直接执行
    cmd.action()
    return
  }
  // 无 action，填入文本框
  const text = `/${cmd.name} `
  textarea.value = text
  setText(text)
  textarea.setSelectionRange(pos, pos)
  textarea.focus()
}
```

### 1.3 消息接收与状态管理

**文件**: `packages/kilo-vscode/webview-ui/src/context/testflow.tsx`

TestflowProvider 负责接收 extension 发来的 testflow 消息并管理状态：

```typescript
const handle = (msg: ExtensionMessage) => {
  switch (m.type) {
    case "testflow.text":      // 日志文本
    case "testflow.step":      // 步骤更新
    case "testflow.question":  // 交互式问题
    case "testflow.agent_start":  // AI 开始执行
    case "testflow.agent_done":   // AI 执行完成
    case "testflow.log":       // 日志
    case "testflow.error":     // 错误
    case "testflow.done":      // 流程结束
  }
}
```

### 1.4 UI 渲染

**文件**: `packages/kilo-vscode/webview-ui/src/components/chat/TestflowView.tsx`

根据 TestflowProvider 的状态渲染：
- 步骤列表 (`steps`)
- AI 执行状态 (`agentRunning`)
- 交互式问题 (`question`)
- 日志 (`logs`)
- 摘要 (`summary`)

## 第二阶段：Extension 层

### 2.1 消息拦截

**文件**: `packages/kilo-vscode/src/KiloProvider.ts:2782-2786`

```typescript
private async handleSendMessage(text, sessionID, ...) {
  // 拦截 /sdt-* 命令
  if (text.startsWith("/sdt-")) {
    await this.handleSdtCommand(text, sessionID)
    return
  }
  // 正常消息走 AI 会话...
}
```

### 2.2 命令路由

**文件**: `KiloProvider.ts:2713-2744`

```typescript
private async handleSdtCommand(text: string, sessionID?: string) {
  const parts = text.trim().split(/\s+/)
  const cmd = parts[0].slice(5)  // 去掉 "/sdt-" 前缀
  const args = parts.slice(1)

  if (cmd === "test") {
    await this.handleSdtTestCommand(args, sessionID)
    return
  }

  // 其他子命令 (如 sdt-new)
  this.sdtRunner.run({ cmd, args, ... })
}
```

**命令映射**:
- `/sdt-test hello` → `cmd="test"`, `args=["hello"]` → `testflow test hello`
- `/sdt-new mytask` → `cmd="new"`, `args=["mytask"]` → `testflow new mytask`

### 2.3 测试命令处理

**文件**: `KiloProvider.ts:2746-2768`

```typescript
private async handleSdtTestCommand(args: string[], sessionID?: string) {
  const serverConfig = this.connectionService.getServerConfig()
  const sid = sessionID ?? this.currentSession?.id ?? ""
  const workspaceDir = this.getContextDirectory()

  this.sdtRunner.run({
    cmd: "test",
    args,
    cwd: workspaceDir,
    env: {
      OPENCODE_SERVER_URL: serverConfig.baseUrl,
      OPENCODE_SERVER_PASSWORD: serverConfig.password,
      OPENCODE_SESSION_ID: sid,
    },
    sessionID: sid,
    post: (msg) => this.postMessage(msg),
  })
}
```

### 2.4 SdtRunner：子进程管理

**文件**: `packages/kilo-vscode/src/testagent/sdt-runner.ts`

#### 启动子进程

```typescript
run(opts: SdtRunnerOpts): void {
  if (this.running) {
    opts.post({ type: "testflow.error", error: "Another testflow process is already running" })
    return
  }

  this.proc = spawn("testflow", [opts.cmd, ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, KILO_INTEGRATION: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  })
}
```

**关键环境变量**:
| 变量 | 说明 |
|------|------|
| `KILO_INTEGRATION=1` | 启用 JSON Lines 通信模式 |
| `OPENCODE_SERVER_URL` | opencode 服务器地址 |
| `OPENCODE_SERVER_PASSWORD` | 认证密码 |
| `OPENCODE_SESSION_ID` | 关联的 AI 会话 ID |

#### stdout 事件解析

```typescript
const rl = readline.createInterface({ input: this.proc.stdout! })
rl.on("line", (line) => {
  try {
    const event = JSON.parse(line)
    this.dispatch(event)
  } catch {
    this.forward("text", { text: line })
  }
})
```

#### 事件分发

```typescript
private dispatch(event: JsonLine): void {
  const type = event.type as string
  switch (type) {
    case "step":
    case "question":
    case "agent_start":
    case "agent_done":
    case "text":
    case "log":
    case "error":
    case "done":
      this.forward(type, event)
      break
    default:
      this.forward("text", { text: JSON.stringify(event) })
  }
}
```

#### 消息转发格式

```typescript
private forward(type: string, payload: Record<string, unknown>): void {
  this.post?.({
    type: `testflow.${type}`,  // 添加 testflow. 前缀
    sessionID: this.sessionID,
    ...payload,
  })
}
```

### 2.5 交互式问题处理

**文件**: `KiloProvider.ts:632-640`

```typescript
case "testflow.questionReply":
  this.sdtRunner.reply(message.id, message.answers)
  break
case "testflow.questionReject":
  this.sdtRunner.reject(message.id)
  break
case "testflow.abort":
  this.sdtRunner.abort()
  break
```

**SdtRunner 回复机制**:

```typescript
reply(id: string, answers: string[]): void {
  this.proc.stdin.write(JSON.stringify({ type: "question_reply", id, answers }) + "\n")
}
```

## 第三阶段：testflow CLI

### 3.1 入口文件

**文件**: `testflow/src/index.ts`

```typescript
export { run } from '@oclif/core';
```

使用 oclif 框架，命令自动从 `src/commands/` 目录加载。

### 3.2 test 命令实现

**文件**: `testflow/src/commands/test.ts`

```typescript
export default class Test extends Command {
  static args = {
    prompt: Args.string({ default: 'hi' }),
  }
  static flags = {
    sessionID: Flags.string({ char: 's' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Test)

    // 发送步骤事件
    if (isKiloIntegration()) {
      emit({ type: 'step', title: '测试命令', status: 'start' })
    }

    // 调用 AI
    const aiResult = await runAgent({
      sessionID: flags.sessionID || '',
      directory: process.cwd(),
      prompt: args.prompt,
    })

    // 发送完成事件
    if (isKiloIntegration()) {
      emit({ type: 'step', title: '测试命令', status: 'complete' })
      emit({ type: 'done', exitCode: 0, summary: '测试完成' })
    }
  }
}
```

### 3.3 Kilo 集成通信层

**文件**: `testflow/src/lib/kilo.ts`

#### 环境检测

```typescript
export const isKiloIntegration = (): boolean =>
  process.env.KILO_INTEGRATION === '1'
```

#### 事件发射

```typescript
export function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n')
}
```

#### 交互式问题

```typescript
export function ask(opts: AskOptions): Promise<string[]> {
  emit({ type: 'question', ...opts })
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin })
    rl.once('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.type === 'question_reply') resolve(msg.answers)
      else if (msg.type === 'question_reject') reject(new Error('user rejected'))
    })
  })
}
```

### 3.4 AI 客户端创建

**文件**: `testflow/src/core/ai-client.ts`

```typescript
export async function createAIClient(): Promise<any> {
  const baseUrl = process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:8001'
  const password = process.env.OPENCODE_SERVER_PASSWORD || ''

  const headers: Record<string, string> = {}
  if (password) {
    headers['Authorization'] = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  }

  // 使用 @kilocode/sdk
  const sdk = await import(sdkPath)
  _client = sdk.createKiloClient({ baseUrl, headers })
  return _client
}
```

### 3.5 runAgent 函数

**文件**: `testflow/src/lib/kilo.ts:47-81`

```typescript
export async function runAgent(opts: RunAgentOpts) {
  const client = opts.client ?? await createAIClient()
  const sessionID = opts.sessionID || process.env.OPENCODE_SESSION_ID || ''

  // 如果没有 sessionID，创建新会话
  if (!sessionID) {
    const { data: session } = await client.session.create({ directory: opts.directory })
    opts.sessionID = session.id
  }

  const text = opts.skill ? `@${opts.skill} ${opts.prompt}` : opts.prompt

  emit({ type: 'agent_start', skill: opts.skill, prompt: opts.prompt })

  try {
    const { data } = await client.session.prompt(
      { sessionID: opts.sessionID, directory: opts.directory, parts: [{ type: 'text', text }] },
      { throwOnError: true },
    )

    const summary = data?.parts
      ?.filter((p) => p.type === 'text')
      ?.map((p) => p.text)
      ?.join('') ?? ''

    emit({ type: 'agent_done', success: true, summary })
    return { success: true, summary }
  } catch (err) {
    emit({ type: 'agent_done', success: false, summary: err.message })
    return { success: false, summary: err.message }
  }
}
```

## 第四阶段：opencode Server

### 4.1 HTTP API 路由

**文件**: `packages/opencode/src/server/instance/session.ts:854-896`

```typescript
.post("/:sessionID/message", ...)
  async (c) => {
    const sessionID = c.req.valid("param").sessionID
    const body = c.req.valid("json")
    const msg = await AppRuntime.runPromise(
      SessionPrompt.Service.use((svc) => svc.prompt({ ...body, sessionID })),
    )
    stream.write(JSON.stringify(msg))
  }
```

### 4.2 SessionPrompt 服务

**文件**: `packages/opencode/src/session/prompt.ts`

#### prompt 函数

```typescript
const prompt = Effect.fn("SessionPrompt.prompt")(function* (input: PromptInput) {
  const session = yield* sessions.get(input.sessionID)
  const message = yield* createUserMessage(input)

  return yield* KiloSessionPromptQueue.enqueue(
    input.sessionID,
    message.info.id,
    loop({ sessionID: input.sessionID }),
    lastAssistant(input.sessionID),
  )
})
```

#### 核心循环 runLoop

```typescript
const runLoop = Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID) {
  while (true) {
    yield* status.set(sessionID, { type: "busy" })
    let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

    // 获取最后的用户消息和助手消息
    let lastUser, lastAssistant
    for (const msg of msgs) { ... }

    // 检查是否完成
    if (lastAssistant?.finish && !hasToolCalls) break

    // 获取模型
    const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)

    // 处理子任务
    if (task?.type === "subtask") {
      yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
      continue
    }

    // 构建系统提示
    const agent = yield* agents.get(lastUser.agent)
    const tools = yield* resolveTools({ agent, session, model, ... })
    const system = [...env, ...skills, ...instructions]

    // 调用 LLM
    const result = yield* handle.process({
      user: lastUser, agent, system, messages: modelMsgs, tools, model
    })

    if (result === "break") break
  }
})
```

### 4.3 LLM 服务

**文件**: `packages/opencode/src/session/llm.ts`

```typescript
export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
}
```

使用 Vercel AI SDK 作为抽象层，支持 500+ AI 模型提供商。

## 完整调用链时序图

```
┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  User   │    │ Webview  │    │Extension │    │ testflow │    │ opencode │
└────┬────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘
     │              │              │              │              │
     │ 输入 /sdt-test hello        │              │              │
     │─────────────>│              │              │              │
     │              │              │              │              │
     │ 发送消息      │              │              │              │
     │─────────────>│              │              │              │
     │              │ postMessage  │              │              │
     │              │─────────────>│              │              │
     │              │              │              │              │
     │              │              │ 拦截 /sdt-   │              │
     │              │              │ handleSdtCommand             │
     │              │              │              │              │
     │              │              │ spawn("testflow test hello") │
     │              │              │─────────────>│              │
     │              │              │              │              │
     │              │              │              │ emit(step)   │
     │              │              │<─────────────│              │
     │              │              │              │              │
     │              │              │              │ session.prompt()
     │              │              │              │─────────────>│
     │              │              │              │              │
     │              │              │              │              │ LLM.stream()
     │              │              │              │              │ AI 响应
     │              │              │              │              │
     │              │              │              │ response     │
     │              │              │              │<─────────────│
     │              │              │              │              │
     │              │              │              │ emit(agent_done)
     │              │              │<─────────────│              │
     │              │              │              │              │
     │              │ postMessage  │              │              │
     │              │<─────────────│              │              │
     │              │              │              │              │
     │ 渲染结果      │              │              │              │
     │<─────────────│              │              │              │
     │              │              │              │              │
     │              │              │ emit(done)   │              │
     │              │              │<─────────────│              │
     │              │              │              │              │
     │              │              │ 进程退出      │              │
     │              │              │              │              │
```

## 事件类型映射表

| testflow stdout 事件 | SdtRunner 转发 | Webview 处理 |
|---------------------|----------------|--------------|
| `{ type: "step" }` | `testflow.step` | 添加到步骤列表 |
| `{ type: "question" }` | `testflow.question` | 显示交互式问题 |
| `{ type: "agent_start" }` | `testflow.agent_start` | 显示 AI 执行中 |
| `{ type: "agent_done" }` | `testflow.agent_done` | 隐藏 AI 执行状态 |
| `{ type: "text" }` | `testflow.text` | 添加到日志 |
| `{ type: "log" }` | `testflow.log` | 添加到日志 |
| `{ type: "error" }` | `testflow.error` | 显示错误 |
| `{ type: "done" }` | `testflow.done` | 显示完成状态 |
| 非 JSON 文本 | `testflow.text` | 添加到日志 |

## 相关文件索引

### kilo-vscode (Extension)

| 文件 | 职责 |
|------|------|
| `webview-ui/src/hooks/useSlashCommand.ts` | 斜杠命令定义和选择逻辑 |
| `webview-ui/src/context/testflow.tsx` | Testflow 状态管理 |
| `webview-ui/src/components/chat/TestflowView.tsx` | Testflow UI 渲染 |
| `webview-ui/src/types/messages.ts` | 消息类型定义 |
| `src/KiloProvider.ts` | Extension 核心，命令拦截和路由 |
| `src/testagent/sdt-runner.ts` | testflow 子进程管理 |

### testflow

| 文件 | 职责 |
|------|------|
| `src/commands/test.ts` | test 子命令实现 |
| `src/commands/new.ts` | new 子命令实现 |
| `src/lib/kilo.ts` | Kilo 集成通信层 |
| `src/core/ai-client.ts` | AI 客户端工厂 |
| `src/core/stages-graph/` | 阶段依赖图（复杂流程） |

### opencode

| 文件 | 职责 |
|------|------|
| `src/server/instance/session.ts` | HTTP API 路由 |
| `src/session/prompt.ts` | SessionPrompt 服务核心 |
| `src/session/llm.ts` | LLM 调用抽象层 |
