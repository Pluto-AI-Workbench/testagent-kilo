# Requirements Document

## Introduction

本文档定义了将 testagent-core CLI 从 Bun 运行时完全迁移到 Node.js 运行时的需求。testagent-core 项目当前使用 Bun 作为主要运行时，但已经具备了 Node.js 适配层（adapter.node.ts、pty.node.ts、db.node.ts）和独立的 nodejs-server 包。本次迁移的目标是将整个 CLI 切换到 Node.js 22.5.0+ 作为唯一运行时，移除对 Bun 的依赖，同时保持所有现有功能正常工作。

## Glossary

- **CLI**: Command Line Interface，指 packages/testagent-core/packages/opencode/src/index.ts 及其相关命令实现
- **Runtime_Adapter**: 运行时适配层，通过 package.json 的 imports 字段实现运行时选择（#hono、#pty、#db）
- **Build_System**: 构建系统，当前使用 Bun.build API 进行编译和打包
- **PTY**: Pseudo-Terminal，用于终端模拟的伪终端接口
- **Test_Framework**: 测试框架，当前使用 bun:test
- **nodejs-server**: 位于 packages/nodejs-server/ 的独立 Node.js 服务器包
- **Migration_Script**: 数据库迁移脚本，在首次启动时执行 JSON 到 SQLite 的迁移
- **VS_Code_Extension**: VS Code 扩展，位于 packages/kilo-vscode/，作为 CLI 的客户端

## Requirements

### Requirement 1: 移除 Bun 运行时依赖

**User Story:** 作为开发者，我希望 CLI 完全运行在 Node.js 上，这样可以简化部署和维护，避免依赖多个运行时。

#### Acceptance Criteria

1. THE CLI SHALL NOT import any modules from the "bun:" namespace
2. THE CLI SHALL NOT use any Bun-specific global APIs (Bun.build, Bun.serve, Bun.file, Bun.write, etc.)
3. THE package.json SHALL NOT list "bun" as a required engine
4. THE package.json SHALL specify Node.js version ">=22.5.0" as the required engine
5. WHEN the CLI is executed, THE Runtime SHALL be Node.js 22.5.0 or higher

### Requirement 2: 替换构建系统

**User Story:** 作为构建工程师，我希望使用适合 Node.js 的构建工具，这样可以生成兼容 Node.js 运行时的产物。

#### Acceptance Criteria

1. THE Build_System SHALL NOT use Bun.build API
2. THE Build_System SHALL use esbuild, rollup, or webpack for bundling
3. WHEN building the CLI, THE Build_System SHALL generate ESM format output compatible with Node.js
4. WHEN building the CLI, THE Build_System SHALL bundle all dependencies except externals (jsonc-parser, @lydell/node-pty, @parcel/watcher)
5. THE Build_System SHALL embed database migrations as compile-time constants
6. THE Build_System SHALL support cross-platform builds (linux, darwin, win32) with (arm64, x64) architectures
7. THE Build_System SHALL copy WASM assets (tree-sitter parsers) to the output directory

### Requirement 3: 统一 CLI 入口点

**User Story:** 作为用户，我希望使用统一的 CLI 入口点，这样可以简化命令行使用体验。

#### Acceptance Criteria

1. THE CLI SHALL use packages/nodejs-server/cli.mjs as the primary entry point
2. THE CLI SHALL integrate all commands from packages/opencode/src/cli/cmd/ into the unified entry point
3. WHEN the CLI is invoked, THE Entry_Point SHALL initialize logging, database migration, and command routing
4. THE CLI SHALL support all existing commands (run, serve, web, agent, providers, models, etc.)
5. THE CLI SHALL maintain backward compatibility with existing command-line arguments and options

### Requirement 4: 替换测试框架

**User Story:** 作为测试工程师，我希望使用 Node.js 兼容的测试框架，这样可以在 Node.js 环境中运行所有测试。

#### Acceptance Criteria

1. THE Test_Framework SHALL NOT use "bun:test" module
2. THE Test_Framework SHALL use Vitest or Node.js native test runner
3. WHEN running tests, THE Test_Framework SHALL execute all existing test files in packages/opencode/test/
4. THE Test_Framework SHALL support the same test syntax (describe, it, expect, beforeEach, afterEach)
5. THE Test_Framework SHALL generate JUnit XML reports for CI integration
6. THE Test_Framework SHALL support a 30-second timeout for long-running tests

### Requirement 5: 更新脚本和工具

**User Story:** 作为开发者，我希望所有脚本使用 Node.js 执行，这样可以保持工具链的一致性。

#### Acceptance Criteria

1. THE package.json scripts SHALL NOT use "bun run" commands
2. THE package.json scripts SHALL use "node" or "tsx" for executing TypeScript files
3. THE package.json scripts SHALL use "npm run" or "pnpm run" for workspace commands
4. WHEN executing development commands, THE Scripts SHALL use Node.js runtime
5. THE Scripts SHALL maintain the same functionality as the original Bun-based scripts

### Requirement 6: 验证运行时适配层

**User Story:** 作为系统架构师，我希望确认 Node.js 适配层完整且正确，这样可以保证所有功能在 Node.js 下正常工作。

#### Acceptance Criteria

1. THE Runtime_Adapter SHALL use adapter.node.ts for HTTP server and WebSocket support
2. THE Runtime_Adapter SHALL use pty.node.ts with @lydell/node-pty for terminal emulation
3. THE Runtime_Adapter SHALL use db.node.ts with Node.js native SQLite (node:sqlite) for database operations
4. WHEN the package.json imports field is resolved, THE Runtime SHALL select Node.js-specific modules
5. THE Runtime_Adapter SHALL provide the same interface as the Bun adapters

### Requirement 7: 更新依赖项

**User Story:** 作为依赖管理员，我希望移除 Bun 特定的依赖并添加 Node.js 替代品，这样可以确保所有依赖兼容 Node.js。

#### Acceptance Criteria

1. THE package.json SHALL NOT list "bun-pty" as a dependency
2. THE package.json SHALL list "@lydell/node-pty" and its platform-specific optional dependencies
3. THE package.json SHALL NOT list "@types/bun" as a devDependency
4. THE package.json SHALL list "@types/node" as a devDependency
5. THE package.json SHALL list "drizzle-orm/node-sqlite" compatible version
6. THE package.json SHALL list "@hono/node-server" and "@hono/node-ws" for server support

### Requirement 8: 保持 VS Code 扩展兼容性

**User Story:** 作为 VS Code 扩展用户，我希望扩展继续正常工作，这样可以无缝使用 Agent Manager 和其他功能。

#### Acceptance Criteria

1. THE CLI SHALL maintain the same HTTP + SSE API interface for client communication
2. THE CLI SHALL support the "testagent serve" command with the same options (port, hostname, password, username)
3. WHEN the VS Code extension spawns the CLI, THE CLI SHALL start successfully and respond to API requests
4. THE CLI SHALL emit the same process metadata and notifications that the extension expects
5. THE CLI SHALL maintain compatibility with @kilocode/sdk client library

### Requirement 9: 保留数据库迁移功能

**User Story:** 作为现有用户，我希望首次启动时自动迁移数据，这样可以无缝升级到新版本。

#### Acceptance Criteria

1. THE Migration_Script SHALL check for the existence of opencode.db marker file
2. WHEN the marker file does not exist, THE Migration_Script SHALL execute JSON to SQLite migration
3. THE Migration_Script SHALL display a progress bar during migration (with TTY detection)
4. WHEN migration completes successfully, THE Migration_Script SHALL create the marker file
5. WHEN migration fails, THE Migration_Script SHALL log the error and exit with code 1

### Requirement 10: 支持所有平台和架构

**User Story:** 作为跨平台用户，我希望 CLI 在所有支持的平台上运行，这样可以在不同操作系统上使用相同的工具。

#### Acceptance Criteria

1. THE CLI SHALL run on Linux (x64, arm64) with glibc and musl
2. THE CLI SHALL run on macOS (x64, arm64)
3. THE CLI SHALL run on Windows (x64, arm64)
4. THE CLI SHALL bundle platform-specific native dependencies (@lydell/node-pty, @parcel/watcher) as optional dependencies
5. WHEN the CLI is executed on any supported platform, THE Runtime SHALL load the correct native modules

### Requirement 11: 保持构建产物结构

**User Story:** 作为发布工程师，我希望构建产物保持相同的目录结构，这样可以兼容现有的发布流程。

#### Acceptance Criteria

1. THE Build_System SHALL output binaries to dist/{platform}-{arch}[-baseline][-abi]/bin/ directories
2. THE Build_System SHALL generate a package.json for each platform variant
3. THE Build_System SHALL create tar.gz archives for Linux and zip archives for other platforms
4. THE Build_System SHALL support smoke testing by running "{binary} --version" on the current platform
5. THE Build_System SHALL create an "opencode" alias/wrapper that invokes "testagent" for backward compatibility

### Requirement 12: 移除 Bun 特定的 CI/CD 配置

**User Story:** 作为 DevOps 工程师，我希望 CI/CD 流程使用 Node.js，这样可以简化构建环境配置。

#### Acceptance Criteria

1. THE GitHub Actions workflows SHALL NOT use "setup-bun" action for CLI builds
2. THE GitHub Actions workflows SHALL use "setup-node" action with Node.js 22.5.0+
3. THE GitHub Actions workflows SHALL use "npm install" or "pnpm install" instead of "bun install"
4. THE GitHub Actions workflows SHALL run tests using Node.js test runner
5. THE GitHub Actions workflows SHALL build the CLI using the Node.js-based build system

### Requirement 13: 更新开发工作流

**User Story:** 作为贡献者，我希望开发工作流使用 Node.js，这样可以降低新贡献者的入门门槛。

#### Acceptance Criteria

1. THE "dev" script SHALL use "node --conditions=browser" or "tsx" to run src/index.ts
2. THE "typecheck" script SHALL continue using "tsgo --noEmit" (unchanged)
3. THE "test" script SHALL use the new Test_Framework instead of "bun test"
4. THE "build" script SHALL use the new Build_System instead of "bun run script/build.ts"
5. WHEN a developer runs "npm run dev", THE CLI SHALL start in development mode with hot reload support (if applicable)

### Requirement 14: 文档更新

**User Story:** 作为文档维护者，我希望所有文档反映 Node.js 运行时，这样可以避免用户混淆。

#### Acceptance Criteria

1. THE README.md SHALL document Node.js 22.5.0+ as the required runtime
2. THE README.md SHALL NOT mention Bun as a runtime option
3. THE AGENTS.md SHALL update build and dev instructions to use Node.js commands
4. THE AGENTS.md SHALL update test instructions to use the new Test_Framework
5. THE documentation SHALL provide migration guide for existing Bun users

### Requirement 15: 性能和兼容性验证

**User Story:** 作为质量保证工程师，我希望验证 Node.js 版本的性能和兼容性，这样可以确保迁移不会引入回归。

#### Acceptance Criteria

1. WHEN the CLI starts, THE Startup_Time SHALL be within 10% of the Bun version
2. WHEN running commands, THE Command_Execution_Time SHALL be within 20% of the Bun version
3. WHEN running the test suite, THE Test_Execution_Time SHALL be within 30% of the Bun version
4. THE CLI SHALL pass all existing integration tests
5. THE CLI SHALL successfully communicate with the VS Code extension without errors
