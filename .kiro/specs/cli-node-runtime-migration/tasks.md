# Implementation Plan: CLI Node.js Runtime Migration

## Overview

本实施计划将 testagent-core CLI 从 Bun 运行时完全迁移到 Node.js 22.5.0+ 运行时。迁移按照 7 个阶段组织，每个阶段包含独立的任务单元，确保增量验证和最小化风险。

## Tasks

### Phase 1: 准备工作（1-2 天）

- [ ] 1. 环境和依赖准备
  - [ ] 1.1 验证 Node.js 版本要求
    - 在 `packages/testagent-core/packages/nodejs-server/cli.mjs` 中添加 Node.js 版本检查（>= 22.5.0）
    - 如果版本不符合要求，显示错误消息并退出
    - _Requirements: 1.5, 2.4_
  
  - [ ] 1.2 更新 package.json 依赖
    - 在 `packages/testagent-core/packages/nodejs-server/package.json` 中添加 Node.js 运行时依赖
    - 添加 `@types/node` 到 devDependencies
    - 添加 `esbuild`, `vitest`, `tsx` 到 devDependencies
    - 移除 `@types/bun` 依赖
    - 设置 `engines.node` 为 `">=22.5.0"`
    - 移除 `engines.bun` 字段
    - _Requirements: 1.4, 7.3, 7.4, 7.6_
  
  - [ ] 1.3 添加平台特定的可选依赖
    - 在 `packages/testagent-core/packages/nodejs-server/package.json` 中添加 `@lydell/node-pty` 平台特定包到 optionalDependencies
    - 添加 `@parcel/watcher` 平台特定包到 optionalDependencies
    - 包含所有支持的平台：linux (x64, arm64, glibc, musl), darwin (x64, arm64), win32 (x64, arm64)
    - _Requirements: 7.2, 10.4_

- [ ] 2. Checkpoint - 验证依赖安装
  - 运行 `npm install` 或 `pnpm install` 确保所有依赖正确安装
  - 验证平台特定的可选依赖已正确安装
  - 确保所有测试通过，询问用户是否有问题

### Phase 2: 构建系统迁移（2-3 天）

- [ ] 3. 创建 esbuild 构建脚本
  - [ ] 3.1 实现迁移脚本加载器
    - 在 `packages/testagent-core/script/build-node.ts` 中创建 `loadMigrations()` 函数
    - 扫描 `migration/` 目录，解析迁移文件名提取时间戳
    - 返回包含 sql、timestamp、name 的迁移对象数组
    - _Requirements: 2.5, 11.2_
  
  - [ ] 3.2 实现基础 esbuild 配置
    - 在 `packages/testagent-core/script/build-node.ts` 中创建 esbuild 构建函数
    - 配置入口点：`./src/node.ts` 和 `./src/index.ts`
    - 设置 platform: 'node', target: 'node22.5', format: 'esm'
    - 配置 external 依赖：jsonc-parser, @lydell/node-pty, @parcel/watcher
    - 通过 define 选项注入 OPENCODE_MIGRATIONS 和 OPENCODE_CHANNEL
    - 输出到 `./dist/node/` 目录，启用 sourcemap
    - _Requirements: 2.2, 2.3, 2.4_
  
  - [ ] 3.3 实现 WASM 资源复制
    - 在 `packages/testagent-core/script/copy-wasm.ts` 中创建 `copyWasmAssets()` 函数
    - 查找 node_modules 中的 WASM 文件（web-tree-sitter, tree-sitter-bash, tree-sitter-powershell）
    - 复制到 `dist/node/chunks/` 目录
    - _Requirements: 2.7_
  
  - [ ] 3.4 实现跨平台构建支持
    - 在 `packages/testagent-core/script/build.ts` 中创建 `buildForPlatform()` 函数
    - 支持所有平台和架构组合：linux (x64, arm64, glibc, musl), darwin (x64, arm64), win32 (x64, arm64)
    - 为每个平台生成独立的构建产物到 `dist/{platform}-{arch}[-abi]/bin/`
    - _Requirements: 2.6, 10.1, 10.2, 10.3, 11.1_
  
  - [ ] 3.5 生成平台特定的 package.json
    - 在 `packages/testagent-core/script/generate-package-json.ts` 中创建 `generatePackageJson()` 函数
    - 为每个平台生成包含正确依赖的 package.json
    - 只包含当前平台的可选依赖
    - 设置 bin 字段指向 cli.mjs
    - _Requirements: 11.2_
  
  - [ ] 3.6 创建可执行文件包装器
    - 在 `packages/testagent-core/script/create-wrapper.ts` 中创建 `createExecutableWrapper()` 函数
    - Unix 平台：创建带 shebang 的 shell 脚本，添加 `--experimental-sqlite` 标志
    - Windows 平台：创建 .cmd 批处理文件
    - 创建 opencode 别名指向 testagent
    - _Requirements: 11.5_

- [ ] 4. Checkpoint - 验证构建系统
  - 运行构建脚本，确保所有平台的构建产物正确生成
  - 验证 WASM 资源已复制到正确位置
  - 在当前平台上运行 `{binary} --version` 进行冒烟测试
  - 确保所有测试通过，询问用户是否有问题

### Phase 3: 测试框架迁移（2-3 天）

- [ ] 5. 配置 Vitest 测试框架
  - [ ] 5.1 创建 Vitest 配置文件
    - 在 `packages/testagent-core/vitest.config.ts` 中创建配置
    - 设置测试文件匹配模式：`test/**/*.test.ts`
    - 配置超时：testTimeout 和 hookTimeout 设为 30000ms
    - 配置报告器：默认使用 'default'，CI 环境添加 'junit'
    - 配置 JUnit 输出路径：`.artifacts/unit/junit.xml`
    - _Requirements: 4.2, 4.5_
  
  - [ ] 5.2 迁移测试文件中的 mock 语法
    - 查找所有使用 `import { mock } from "bun:test"` 的测试文件
    - 替换为 `import { vi } from "vitest"` 和 `vi.fn()` 或 `vi.mock()`
    - 更新 spyOn 调用为 `vi.spyOn()`
    - _Requirements: 4.1, 4.4_
  
  - [ ]* 5.3 运行测试套件验证兼容性
    - 运行 `vitest run` 执行所有测试
    - 验证所有测试通过或识别需要修复的测试
    - 确保测试执行时间在可接受范围内（Bun 版本的 130% 以内）
    - _Requirements: 4.3, 15.3_

- [ ] 6. Checkpoint - 验证测试框架
  - 确保所有单元测试通过
  - 验证 JUnit 报告正确生成
  - 询问用户是否有问题

### Phase 4: CLI 入口点统一（2-3 天）

- [ ] 7. 统一 CLI 入口点
  - [ ] 7.1 更新 cli.mjs 入口点
    - 修改 `packages/testagent-core/packages/nodejs-server/cli.mjs`
    - 添加 shebang：`#!/usr/bin/env node --experimental-sqlite`
    - 导入编译后的 `./dist/node/index.js`
    - 设置环境变量：AGENT=1, OPENCODE=1, OPENCODE_PID
    - 初始化日志系统
    - _Requirements: 3.1, 3.2, 3.3_
  
  - [ ] 7.2 实现数据库迁移检查
    - 在 CLI 初始化流程中添加数据库迁移检查
    - 检查 `opencode.db` marker 文件是否存在
    - 如果不存在，执行 JSON 到 SQLite 的迁移
    - 显示进度条（TTY 检测）
    - 迁移成功后创建 marker 文件
    - 迁移失败时记录错误并退出
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  
  - [ ] 7.3 整合所有 CLI 命令
    - 确保 cli.mjs 支持所有现有命令：run, serve, web, agent, providers, models, mcp, acp, export, import, session, db, github, pr, stats, debug
    - 验证命令路由正确工作
    - 保持所有命令行参数和选项的向后兼容性
    - _Requirements: 3.4, 3.5_
  
  - [ ] 7.4 验证运行时适配层选择
    - 确认 package.json imports 字段正确配置
    - 验证 #db 导入解析到 db.node.ts
    - 验证 #pty 导入解析到 pty.node.ts
    - 验证 #hono 导入解析到 adapter.node.ts
    - 测试适配层在 Node.js 环境下正常工作
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 8. Checkpoint - 验证 CLI 功能
  - 运行 `testagent --version` 验证版本显示
  - 运行 `testagent --help` 验证帮助信息
  - 测试 `testagent serve` 命令启动服务器
  - 确保所有测试通过，询问用户是否有问题

### Phase 5: 开发工作流更新（1-2 天）

- [ ] 9. 更新 package.json 脚本
  - [ ] 9.1 替换 dev 脚本
    - 将 `"dev": "bun run --conditions=browser src/index.ts"` 替换为 `"dev": "tsx --conditions=node ./src/index.ts"`
    - 添加 `"dev:watch": "tsx watch --conditions=node ./src/index.ts"` 支持文件监听
    - _Requirements: 5.1, 13.1_
  
  - [ ] 9.2 替换 test 脚本
    - 将 `"test": "bun test"` 替换为 `"test": "vitest run"`
    - 添加 `"test:watch": "vitest"` 支持监听模式
    - 添加 `"test:ci": "vitest run --reporter=junit --reporter=default --outputFile=.artifacts/unit/junit.xml"`
    - _Requirements: 5.3, 13.3_
  
  - [ ] 9.3 替换 build 脚本
    - 将 `"build": "bun run script/build.ts"` 替换为 `"build": "node script/build.ts"`
    - 添加 `"build:node": "node script/build-node.ts"` 用于单平台构建
    - _Requirements: 5.4, 13.4_
  
  - [ ] 9.4 保持 typecheck 脚本不变
    - 验证 `"typecheck": "tsgo --noEmit"` 继续正常工作
    - _Requirements: 13.2_

- [ ] 10. Checkpoint - 验证开发工作流
  - 运行 `npm run dev` 验证开发模式启动
  - 运行 `npm run test` 验证测试执行
  - 运行 `npm run build` 验证构建成功
  - 询问用户是否有问题

### Phase 6: 文档和验证（1-2 天）

- [ ] 11. 更新文档
  - [ ] 11.1 更新 README.md
    - 将 Node.js 22.5.0+ 标注为必需运行时
    - 移除所有 Bun 相关的安装和使用说明
    - 更新安装命令为 `npm install` 或 `pnpm install`
    - 更新运行命令示例
    - _Requirements: 14.1, 14.2_
  
  - [ ] 11.2 更新 AGENTS.md
    - 更新构建和开发指令使用 Node.js 命令
    - 将 `bun run dev` 替换为 `npm run dev`
    - 将 `bun test` 替换为 `npm test`
    - 更新测试框架说明为 Vitest
    - _Requirements: 14.3, 14.4_
  
  - [ ] 11.3 创建迁移指南
    - 在文档中添加从 Bun 迁移到 Node.js 的指南
    - 说明用户需要安装 Node.js 22.5.0+
    - 说明数据库自动迁移流程
    - 提供常见问题解答
    - _Requirements: 14.5_

- [ ] 12. VS Code 扩展兼容性验证
  - [ ]* 12.1 测试扩展启动 CLI
    - 启动 VS Code 扩展
    - 验证扩展能够成功 spawn testagent serve 进程
    - 检查进程元数据和通知正确发送
    - _Requirements: 8.3, 8.4_
  
  - [ ]* 12.2 测试 HTTP + SSE API
    - 验证扩展能够通过 HTTP 与 CLI 通信
    - 测试 SSE 事件流正常工作
    - 验证 @kilocode/sdk 客户端库兼容性
    - _Requirements: 8.1, 8.2, 8.5_
  
  - [ ]* 12.3 端到端功能测试
    - 测试 Agent Manager 功能
    - 测试会话创建和管理
    - 测试命令执行和响应
    - _Requirements: 15.4_

- [ ] 13. 性能基准测试
  - [ ]* 13.1 测量启动时间
    - 记录 CLI 启动时间
    - 与 Bun 版本对比，确保在 110% 以内
    - _Requirements: 15.1_
  
  - [ ]* 13.2 测量命令执行时间
    - 测试常用命令的执行时间
    - 与 Bun 版本对比，确保在 120% 以内
    - _Requirements: 15.2_

- [ ] 14. Checkpoint - 验证文档和兼容性
  - 确保所有文档更新完成
  - 验证 VS Code 扩展正常工作
  - 确认性能指标在可接受范围内
  - 询问用户是否有问题

### Phase 7: 清理和发布（1 天）

- [ ] 15. 移除 Bun 相关代码
  - [ ] 15.1 移除 Bun 特定的导入
    - 搜索并移除所有 `import ... from "bun:..."` 语句
    - 移除 Bun 全局 API 的使用（Bun.build, Bun.serve, Bun.file, Bun.write）
    - _Requirements: 1.1, 1.2_
  
  - [ ] 15.2 移除 Bun 适配层文件
    - 删除或标记为废弃：db.bun.ts, pty.bun.ts, adapter.bun.ts
    - 更新 package.json imports 字段，移除 "bun" 条件分支
    - 将 "default" 条件指向 Node.js 实现
    - _Requirements: 1.3_
  
  - [ ] 15.3 清理构建产物
    - 删除旧的 Bun 构建产物
    - 运行 `npm run clean` 清理临时文件
    - 重新构建所有平台的产物

- [ ] 16. 更新 CI/CD 配置
  - [ ] 16.1 更新 GitHub Actions workflows
    - 在 `.github/workflows/test.yml` 中移除 setup-bun action
    - 添加 setup-node action，指定 Node.js 22.5.0+
    - 将 `bun install` 替换为 `npm install` 或 `pnpm install`
    - 将 `bun test` 替换为 `npm test`
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
  
  - [ ] 16.2 更新构建 workflow
    - 在 `.github/workflows/publish.yml` 中更新构建步骤
    - 使用 Node.js 构建系统替代 Bun
    - 验证所有平台的构建产物正确生成
    - _Requirements: 12.5_

- [ ] 17. 最终验证和发布
  - [ ]* 17.1 运行完整测试套件
    - 运行所有单元测试
    - 运行所有集成测试
    - 验证所有测试通过
    - _Requirements: 15.4_
  
  - [ ]* 17.2 跨平台冒烟测试
    - 在 Linux、macOS、Windows 上测试构建产物
    - 验证 `testagent --version` 和 `testagent serve` 正常工作
    - 确认平台特定依赖正确加载
    - _Requirements: 10.5, 11.4_
  
  - [ ] 17.3 创建 changeset
    - 运行 `bunx changeset add` 创建 changeset 文件
    - 选择 `major` 版本（破坏性变更：移除 Bun 支持）
    - 描述：从用户角度说明迁移到 Node.js 22.5.0+ 运行时
    - 提及数据库自动迁移和向后兼容性

- [ ] 18. Final Checkpoint - 发布准备
  - 确保所有测试通过
  - 验证文档完整且准确
  - 确认 CI/CD 流程正常工作
  - 准备发布说明
  - 询问用户是否准备好发布

## Notes

- 任务标记 `*` 的为可选测试任务，可以跳过以加快 MVP 交付
- 每个任务都引用了具体的需求编号，确保可追溯性
- Checkpoint 任务确保增量验证，及早发现问题
- 构建系统迁移是关键路径，需要优先完成
- VS Code 扩展兼容性验证至关重要，确保用户体验不受影响
- 性能基准测试帮助识别性能回归
- 跨平台支持需要在多个操作系统上验证

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["3.1", "3.2"] },
    { "id": 2, "tasks": ["3.3", "3.4", "5.1"] },
    { "id": 3, "tasks": ["3.5", "3.6", "5.2"] },
    { "id": 4, "tasks": ["5.3", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 6, "tasks": ["9.1", "9.2", "9.3", "9.4"] },
    { "id": 7, "tasks": ["11.1", "11.2", "11.3"] },
    { "id": 8, "tasks": ["12.1", "12.2", "12.3", "13.1", "13.2"] },
    { "id": 9, "tasks": ["15.1", "15.2", "15.3"] },
    { "id": 10, "tasks": ["16.1", "16.2"] },
    { "id": 11, "tasks": ["17.1", "17.2", "17.3"] }
  ]
}
```
