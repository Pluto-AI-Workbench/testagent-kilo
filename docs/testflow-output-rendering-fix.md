# Testflow 输出渲染修复

## 问题描述

在 VS Code 插件中执行 `/sdt-*` 系列命令时，输出显示存在两个问题：

### 1. ANSI 转义码乱码
`testflow` CLI 输出带有终端颜色码（如 `□[32m√□[39m`），这些 ANSI 转义序列没有被剥离，直接显示成了乱码字符。

### 2. 目录树结构错乱
`testflow new` 等命令输出的目录树（使用 `├──`、`└──` 等字符）被当作普通 Markdown 文本渲染，导致等宽结构被换行打断，显示混乱。

### 3. 视觉混淆
初次尝试用 Markdown 代码块（` ``` `）包裹输出，虽然解决了格式问题，但导致 assistant 输出变成灰底块，与用户输入气泡视觉样式相同，破坏了对话的左右气泡区分感。

## 根本原因

| 问题 | 根源 |
|------|------|
| ANSI 乱码 | `testflow` 使用 `ora`/`winston colorize()` 输出带颜色码，`sdt-runner.ts` 没有 strip |
| 目录树错乱 | `appendLog` 把多行文本拼成一个 `text` part，webview 按 Markdown 渲染，等宽结构被折行 |
| 视觉混淆 | Markdown 代码块渲染成灰底块，与用户输入气泡样式冲突 |

## 解决方案

### 架构设计

采用三层处理：

1. **数据层（sdt-runner.ts）**：在数据源头 strip ANSI 码
2. **协议层（testflow-bridge.ts）**：给 testflow 输出的 text part 打标记（`testflow: true`）
3. **渲染层（AssistantMessage.tsx + testflow.css）**：识别标记，用 `<pre>` 渲染而非 Markdown

### 实现细节

#### 1. sdt-runner.ts - ANSI 码剥离

```typescript
// 添加 ANSI 正则（无需引入新依赖）
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

// stdout 非 JSON 行处理
rl.on("line", (line) => {
  if (!line.trim()) return
  try {
    const event = JSON.parse(line) as JsonLine
    this.dispatch(event)
  } catch {
    this.bridge.onText(stripAnsi(line))  // ← strip ANSI
  }
})

// stderr 处理
this.proc.stderr?.on("data", (chunk: Buffer) => {
  const text = stripAnsi(chunk.toString().trim())  // ← strip ANSI
  if (text) this.bridge.onLog("error", text)
})
```

**要点**：
- 使用标准 ANSI 正则，覆盖颜色、光标移动等所有转义序列
- 在 bridge 入口统一处理，覆盖所有 `/sdt-*` 命令

#### 2. testflow-bridge.ts - 协议标记

```typescript
private appendLog(text: string): void {
  if (!text.trim()) return
  this.logText = this.logText ? `${this.logText}\n${text}` : text

  if (!this.logPartID) {
    this.logPartID = uid()
  }

  this.post?.({
    type: "partUpdated",
    sessionID: this.sessionID,
    messageID: this.asstMsgID,
    part: {
      type: "text",
      id: this.logPartID,
      messageID: this.asstMsgID,
      text: this.logText,
      testflow: true,  // ← 标记为 testflow 输出
    },
  })
}
```

**要点**：
- 文本内容保持原样，不包代码块
- 通过 `testflow: true` 标记让渲染层识别

#### 3. AssistantMessage.tsx - 渲染分流

```typescript
// 识别 testflow log
function isTestflowLog(part: SDKPart): boolean {
  return part.type === "text" && !!(part as SDKPart & { testflow?: boolean }).testflow
}

// 渲染逻辑
const isTestflowLog = isTestflowLog(part)

return (
  <Show when={isTestflow || isTestflowLog || ...}>
    <Show when={isTestflowLog} fallback={
      <Show when={isTestflow} fallback={
        {/* 正常 Part 渲染 */}
      }>
        <TestflowToolCard part={part as unknown as ToolPart} />
      </Show>
    }>
      <pre class="testflow-log">{(part as SDKPart & { text: string }).text}</pre>
    </Show>
  </Show>
)
```

**要点**：
- 绕过 `<Markdown>` 组件，直接用 `<pre>` 渲染
- 保留等宽字体和换行结构

#### 4. testflow.css - 样式定义

```css
pre.testflow-log {
  margin: 4px 0;
  padding: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-foreground);
  background: transparent;  /* ← 关键：透明背景 */
  border: none;             /* ← 关键：无边框 */
}
```

**要点**：
- `background: transparent` 和 `border: none` 确保不会变成灰底块
- `white-space: pre-wrap` 保留换行和空格，同时允许自动折行
- 融入 assistant 消息区域，视觉上与用户输入气泡区分明显

## 效果

### 修复前
- ❌ ANSI 码显示为 `！□[32m√□[39m`
- ❌ 目录树 `├──` 结构被普通文本换行打断
- ❌ 所有输出挤在一起，无视觉分隔

### 修复后
- ✅ ANSI 码被完全剥离，文本干净
- ✅ 目录树等宽结构完整保留
- ✅ 等宽字体渲染，透明背景，融入对话流
- ✅ 与用户输入气泡视觉区分清晰

## 影响范围

- **所有 `/sdt-*` 命令**：`/sdt-new`、`/sdt-run`、`/sdt-test` 等
- **向后兼容**：不影响其他 text part 的渲染（通过 `testflow: true` 标记隔离）
- **无新依赖**：ANSI 正则自实现，无需引入 `strip-ansi` 包

## 文件清单

| 文件 | 改动 |
|------|------|
| `packages/kilo-vscode/src/testagent/sdt-runner.ts` | 新增 `stripAnsi` 函数，stdout/stderr 处理前 strip |
| `packages/kilo-vscode/src/testagent/testflow-bridge.ts` | `appendLog` 添加 `testflow: true` 标记 |
| `packages/kilo-vscode/webview-ui/src/components/chat/AssistantMessage.tsx` | 新增 `isTestflowLog` 判断，`<pre>` 渲染分流 |
| `packages/kilo-vscode/webview-ui/src/styles/testflow.css` | 新增 `.testflow-log` 样式 |

## 测试建议

1. 执行 `/sdt-new 测试任务` 检查目录树显示
2. 执行 `/sdt-test 你好` 检查多行输出格式
3. 执行 `/sdt-run` 检查带颜色的状态输出
4. 确认 assistant 输出与用户输入气泡视觉区分清晰

## 备注

- 本次修复遵循 testagent fork 规范，所有改动已标记 `testagent_change`
- ANSI 正则来自标准实现，覆盖 SGR、光标控制、清屏等所有常见转义序列
- 未来如需支持彩色输出，可在 CSS 中添加 ANSI 颜色映射（如 `ansi-to-html`）
