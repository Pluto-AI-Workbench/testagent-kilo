# SDT 命令重构设计记录

**日期**: 2026-05-17
**作者**: AI

## 修改背景

原有 `/sdt-test` 命令实现存在问题：
- `SdtTestRunner` 直接用 `spawn(opts.cmd, opts.args, ...)` 执行用户传入的第一个参数
- 如果 `/sdt-test` 后面没有跟参数，`opts.cmd` 为 `undefined`，导致进程无法启动
- 逻辑与 `/sdt-new` 不一致，且完全绕过了 `testflow` CLI

## 修改内容

### 1. sdt-runner.ts

**删除**: `SdtTestRunner` 类

**修改**: `SdtRunner.run()` 方法

```typescript
// 修改前
this.proc = spawn("testflow", opts.args, ...)

// 修改后
this.proc = spawn("testflow", [opts.cmd, ...opts.args], ...)
```

- 将 `opts.cmd` 作为 `testflow` 的第一个子命令参数传入
- 这样 `/sdt-new xxx` 执行 `testflow new xxx`
- `/sdt-test xxx` 执行 `testflow test xxx`

### 2. KiloProvider.ts

**删除**: `SdtTestRunner` 导入

**修改**: `handleSdtTestCommand()` 方法

```typescript
// 修改前: 创建新的 SdtTestRunner 实例，直接 spawn 用户命令
const testRunner = new SdtTestRunner()
testRunner.run({
  cmd: args[0],      // 用户传入的第一个参数
  args: args.slice(1),
  ...
})

// 修改后: 复用已有的 SdtRunner，cmd 固定为 "test"
this.sdtRunner.run({
  cmd: "test",
  args,              // 直接透传用户参数
  ...
})
```

## 机制说明

### 命令路由

```
用户输入 /sdt-<子命令> [参数...]
    ↓
KiloProvider.handleSdtCommand() 解析:
    cmd = "<子命令>"       // 去掉 "/sdt-" 前缀
    args = [参数...]
    ↓
┌─────────────────────────────────────────┐
│ if cmd === "test"                        │
│   handleSdtTestCommand(args)             │
│   → sdtRunner.run({ cmd: "test", args }) │
│   → testflow test [args...]              │
│                                          │
│ else                                     │
│   sdtRunner.run({ cmd, args })           │
│   → testflow <cmd> [args...]            │
└─────────────────────────────────────────┘
```

### 执行流程

```
Extension (Node.js)
    ↓ spawn("testflow", ["test", ...args])
testflow CLI 进程 (子进程)
    ↓ stdout JSON lines / stderr
Extension 读取解析
    ↓ postMessage
Webview 展示结果
```

### 状态管理

- `SdtRunner` 是单例，一个时刻只能运行一个 testflow 进程
- 如果已有进程运行，新调用会被拒绝并返回错误消息
- `abort()` 可以终止当前进程

## 设计想法

1. **统一入口**: 让 `/sdt-test` 和 `/sdt-new` 走同一套执行逻辑，只是子命令不同
2. **复用 `testflow` CLI**: 不再绕过 testflow 直接执行命令，确保所有 testflow 行为都经过统一的 CLI
3. **简化代码**: 删除了冗余的 `SdtTestRunner` 类，降低维护成本
4. **参数透传**: `handleSdtTestCommand` 直接把用户参数透传给 `testflow test`，不做额外处理