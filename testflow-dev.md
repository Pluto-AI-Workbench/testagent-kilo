# TestFlow SDT 命令集成方案

## 概述

在 VS Code 扩展中添加 `/sdt-new <taskname>` 斜杠命令，调用 testflow 的 `TaskScaffolder` 创建测试任务目录，然后通过 `promptAsync` 发送消息给 opencode AI 执行后续操作。

## 架构设计

```
用户输入 /sdt-new test-demo
    ↓
PromptInput.tsx 匹配斜杠命令
    ↓
session.sendCommand("sdt-new", "test-demo")
    ↓
session.tsx 拦截 → 转为 { type: "sdtNew", taskName: "test-demo" }
    ↓
KiloProvider.ts 接收 sdtNew 消息
    ↓
handleSdtNew("test-demo")
    ↓
1. TaskScaffolder.create() 创建任务目录
2. resolveSession() 获取会话
3. promptAsync() 发送 prompt 给 AI
    ↓
AI 读取 Skill 文件 → 执行任务
```

## 修改文件清单

### 1. Git Submodule

文件：`.gitmodules`

添加 testflow 作为 submodule：
```bash
git submodule add https://github.com/Pluto-AI-Workbench/testflow.git packages/testflow
```

### 2. 根目录 package.json

在 `workspaces.packages` 数组中添加 `"packages/testflow"`。

### 3. packages/testflow/package.json

将 `name` 从 `"testflow"` 改为 `"@testagent/testflow"`。

### 4. packages/kilo-vscode/package.json

在 `dependencies` 中添加：
```json
"@testagent/testflow": "workspace:*"
```

### 5. useSlashCommand.ts

路径：`packages/kilo-vscode/webview-ui/src/hooks/useSlashCommand.ts`

添加命令定义（不设置 action，让命令走 sendCommand 路径）：
```typescript
{
  name: "sdt-new",
  description: "创建新的测试任务",
  hints: ["task", "testflow"],
}
```

### 6. messages.ts

路径：`packages/kilo-vscode/webview-ui/src/types/messages.ts`

添加消息类型并加入 WebviewMessage 联合类型：
```typescript
export interface SdtNewRequest {
  type: "sdtNew"
  taskName: string
}
```

### 7. session.tsx（关键改动）

路径：`packages/kilo-vscode/webview-ui/src/context/session.tsx`

在 `sendCommand` 函数开头拦截 `/sdt-new`，转换为 `sdtNew` 消息：
```typescript
if (command === "sdt-new") {
  const taskName = args.trim()
  if (taskName) {
    const messageID = Identifier.ascending("message")
    const sid = currentSessionID()
    if (sid) addOptimistic(sid, messageID, `/sdt-new ${taskName}`, files)
    vscode.postMessage({ type: "sdtNew", taskName })
  }
  return
}
```

**为什么需要这步**：
- 斜杠命令匹配后走 `sendCommand` 路径，会发到 opencode 的 command 系统
- opencode 没有注册 `sdt-new` 命令，会报 "Command not found"
- 所以需要在 webview 端拦截，绕过 opencode command 系统

### 8. KiloProvider.ts

路径：`packages/kilo-vscode/src/KiloProvider.ts`

**8a. 消息处理 case：**
```typescript
case "sdtNew": {
  this.handleSdtNew(message.taskName).catch((e) =>
    console.error("[TestAgent] handleSdtNew failed:", e),
  )
  break
}
```

**8b. handleSendMessage 中的备用解析（可选）：**
```typescript
if (text.startsWith("/sdt-new ")) {
  const taskName = text.replace("/sdt-new ", "").trim()
  if (taskName) {
    await this.handleSdtNew(taskName)
    return
  }
}
```

**8c. handleSdtNew 方法：**
```typescript
private async handleSdtNew(taskName: string): Promise<void> {
  // 1. TaskScaffolder.create() 创建任务目录
  // 2. resolveSession() 获取会话
  // 3. promptAsync() 发送 prompt 给 AI
}
```

## 构建步骤

```bash
# 1. 安装依赖
cd C:\code\testagent-kilo
bun install

# 2. 构建 testflow（生成 dist/index.d.ts 类型声明）
cd packages\testflow
bun run build

# 3. 构建 CLI 二进制（可选，CLI 无变化时跳过）
cd ..\testagent-opencode
bun bun:windows

# 4. 打包 VSIX
cd ..\kilo-vscode
bun run testagent:vsix
```

## 测试步骤

1. 安装 VSIX 到 VS Code
2. 打开 Extension Host 输出通道（Ctrl+Shift+U）
3. 在聊天框输入 `/sdt-new test-demo`
4. 按 Enter 发送
5. 观察日志输出

## 预期结果

1. 工作目录下创建 `test-demo` 文件夹（含 skill、template、config.yaml 等）
2. AI 收到 prompt，读取 `skill/demand_clarify_skill.md`
3. AI 执行测试需求澄清任务
4. 产物保存到 `test-demo/artifact/demand_clarify/`

## 调试日志

关键日志标签：`[TestAgent] SDT`

```
[TestAgent] SDT: Intercepted /sdt-new command, taskName: test-demo
[TestAgent] SDT: Posted sdtNew message to extension
[TestAgent] SDT: Received sdtNew message, taskName: test-demo
[TestAgent] SDT: handleSdtNew called with taskName: test-demo
[TestAgent] SDT: Importing TaskScaffolder...
[TestAgent] SDT: Creating task directory in: C:\code
[TestAgent] SDT: Created task directory: C:\code\test-demo
[TestAgent] SDT: Resolving session...
[TestAgent] SDT: Session resolved, sid: xxx dir: xxx
[TestAgent] SDT: Sending prompt to AI, messageID: sdt-xxx
[TestAgent] SDT: Prompt sent successfully
```
