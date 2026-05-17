# TestflowView 显示条件修复

**日期**: 2026-05-17

## 问题

输入 `/sdt-new` 命令后，testflow 会先弹出 profile 选择面板（`question` 事件），但界面没有任何显示，用户看不到任何交互。而 `/sdt-test` 能正常显示，因为它执行过程中会先发 `step` 事件。

## 根因

`TestflowView` 的渲染条件过于依赖 `running` 状态：

```tsx
// 修改前
<Show when={s().running || s().done || s().error}>
```

`running` 只有在收到 `step` 事件时才会被设为 `true`。但 `testflow new` 的执行流程可能是：

1. 先发 `question`（用户选择 profile）
2. 再发 `step`（创建任务）
3. 发 `done`

所以当 `question` 先到时，`running` 仍是 `false`，整个面板就不渲染。

## 修改内容

**TestflowView.tsx** — 扩展显示条件：

```tsx
// 修改前
<Show when={s().running || s().done || s().error}>

// 修改后
<Show when={s().running || s().done || s().error || s().question || s().logs.length > 0}>
```

## 要点

### 事件驱动的显示条件

testflow CLI 发出的事件不一定按固定顺序。`question` 可能先于 `step` 到达（特别是在需要用户交互的场景），所以显示条件必须覆盖所有可能的内容类型，而不只是依赖 `running`。

### 新增的触发条件

| 条件 | 覆盖场景 |
|------|----------|
| `s().question` | profile 选择、确认提示等交互 |
| `s().logs.length > 0` | 只有 text/log 输出，没有 step/question |

## 想法

1. **按内容显示而非状态**: 之前用 `running/done/error` 是状态思维，但实际应该按"有没有内容要显示"来判断
2. **解耦事件与显示**: 显示条件应该覆盖所有事件类型对应的状态，而不是假设某个事件的到达顺序
3. **一致性**: 现在 `/sdt-new` 和 `/sdt-test` 的显示逻辑一致了——只要 testflow 发出了任何有意义的内容，界面就会渲染

## 相关文件

- `packages/kilo-vscode/webview-ui/src/components/chat/TestflowView.tsx`
- `packages/kilo-vscode/src/testagent/sdt-runner.ts` — 事件解析分发
- `packages/kilo-vscode/webview-ui/src/context/testflow.tsx` — 状态管理

## 参考

testflow 协议定义: `D:\project\testflow\testflow\src\types\protocol.types.ts`