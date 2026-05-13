# TestFlow SDT 命令集成

## 概述

在 VS Code 扩展中添加 `/sdt-new <taskname>` 斜杠命令，调用 testflow 的 `TaskScaffolder` 创建测试任务目录，然后发送消息给 opencode AI 执行后续操作。

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `.gitmodules` | 添加 testflow submodule 配置 |
| `package.json` | workspaces 添加 `packages/testflow` |
| `packages/testflow/package.json` | name 改为 `@testagent/testflow` |
| `packages/kilo-vscode/package.json` | dependencies 添加 `@testagent/testflow` |
| `packages/kilo-vscode/webview-ui/src/hooks/useSlashCommand.ts` | 添加 `/sdt new` 命令定义 |
| `packages/kilo-vscode/webview-ui/src/types/messages.ts` | 添加 `SdtNewRequest` 消息类型 |
| `packages/kilo-vscode/src/KiloProvider.ts` | 添加 `handleSdtNew()` 方法和斜杠命令解析逻辑 |

## 详细改动

### 1. 添加 testflow 为 git submodule

```bash
git submodule add https://github.com/Pluto-AI-Workbench/testflow.git packages/testflow
```

### 2. package.json (根目录)

在 `workspaces.packages` 数组中添加 `"packages/testflow"`。

### 3. packages/testflow/package.json

将 `name` 从 `"testflow"` 改为 `"@testagent/testflow"`，使其可通过 workspace 协议引用。

### 4. packages/kilo-vscode/package.json

在 `dependencies` 中添加：
```json
"@testagent/testflow": "workspace:*"
```

### 5. useSlashCommand.ts

添加 `/sdt-new` 命令定义：
```typescript
{
  name: "sdt-new",
  description: "创建新的测试任务",
  hints: ["task", "testflow"],
  // 不设置 action，让用户输入完整命令
}
```

### 6. messages.ts

添加消息类型定义：
```typescript
export interface SdtNewRequest {
  type: "sdtNew"
  taskName: string
}
```

并将其添加到 `WebviewMessage` 联合类型中。

### 7. KiloProvider.ts

**7a. 添加消息处理 case：**
```typescript
case "sdtNew": {
  this.handleSdtNew(message.taskName).catch((e) =>
    console.error("[TestAgent] handleSdtNew failed:", e),
  )
  break
}
```

**7b. 添加斜杠命令解析逻辑（handleSendMessage 方法开头）：**
```typescript
if (text.startsWith("/sdt-new ")) {
  const taskName = text.replace("/sdt-new ", "").trim()
  if (taskName) {
    await this.handleSdtNew(taskName)
    return
  }
}
```

**7c. 添加 handleSdtNew 方法：**
- 调用 `TaskScaffolder.create()` 创建任务目录
- 调用 `session.promptAsync()` 发送消息给 AI，指示其读取 Skill 文件并执行任务

## 调用链路

```
用户输入 /sdt-new test-demo
    ↓
useSlashCommand.ts → 输入框显示 /sdt-new 
    ↓
用户继续输入任务名称，按 Enter
    ↓
sendMessage → KiloProvider.handleSendMessage()
    ↓
解析 /sdt-new 前缀 → 提取 taskName
    ↓
handleSdtNew(taskName)
    ↓
1. TaskScaffolder.create() 创建任务目录
   - skill/*.md (Skill 提示词)
   - template/*.md (产物模板)
   - config.yaml (流程配置)
2. session.promptAsync() 发送给 AI
    ↓
AI 读取 Skill 文件 → 执行测试需求澄清任务
    ↓
产物保存到 taskDir/artifact/demand_clarify/
```

## 构建步骤

```bash
# 1. 安装依赖
cd C:\code\testagent-kilo
bun install

# 2. 构建 testflow
cd packages\testflow
bun run build

# 3. 构建 CLI 二进制
cd ..\testagent-opencode
bun bun:windows

# 4. 打包 VSIX
cd ..\kilo-vscode
bun run testagent:vsix
```

## 测试步骤

1. 安装生成的 VSIX 文件到 VS Code
2. 在聊天框输入 `/sdt-new`，应看到命令提示
3. 继续输入任务名称，如 `/sdt-new test-demo`
4. 按 Enter 发送

**预期结果：**
- 工作目录下创建 `test-demo` 文件夹（含 skill、template 等）
- AI 读取 `skill/demand_clarify_skill.md` 并执行任务
- 产物输出到 `test-demo/artifact/demand_clarify/`
