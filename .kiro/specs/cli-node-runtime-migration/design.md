# Design Document: CLI Node.js Runtime Migration

## Overview

本设计文档描述了将 testagent-core CLI 从 Bun 运行时完全迁移到 Node.js 22.5.0+ 运行时的技术方案。迁移的核心目标是：

1. **统一运行时**：使用 Node.js 作为唯一运行时，移除对 Bun 的依赖
2. **保持功能完整性**：所有现有 CLI 命令和功能保持不变
3. **利用现有适配层**：充分利用已实现的 Node.js 适配层（adapter.node.ts、pty.node.ts、db.node.ts）
4. **简化工具链**：统一构建、测试和开发工具到 Node.js 生态系统
5. **保持兼容性**：确保 VS Code 扩展和其他客户端无缝工作

### 迁移范围

**包含的包**：
- `packages/testagent-core/packages/opencode/` - 核心 CLI 实现
- `packages/testagent-core/packages/nodejs-server/` - Node.js 服务器包
- 相关的构建脚本和配置文件

**不包含的包**（保持不变）：
- `packages/kilo-vscode/` - VS Code 扩展（客户端）
- `packages/sdk/js/` - SDK（自动生成）
- 其他 workspace 包

### 关键约束

1. **Node.js 版本**：要求 Node.js >= 22.5.0（支持 node:sqlite）
2. **运行时适配层**：通过 package.json imports 字段实现运行时选择
3. **数据库迁移**：首次启动时自动执行 JSON 到 SQLite 的迁移
4. **跨平台支持**：Linux (x64, arm64)、macOS (x64, arm64)、Windows (x64, arm64)
5. **向后兼容**：保持与 VS Code 扩展的 API 兼容性

## Architecture

### 高层架构

```
┌─────────────────────────────────────────────────────────────┐
│                     VS Code Extension                        │
│                  (packages/kilo-vscode/)                     │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP + SSE
                         │ @kilocode/sdk
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Unified CLI Entry Point                    │
│              packages/nodejs-server/cli.mjs                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  • Logging initialization                            │  │
│  │  • Database migration check                          │  │
│  │  • Command routing (yargs)                           │  │
│  │  • Process metadata setup                            │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Runtime Adapter Layer (Node.js)                 │
│         (package.json imports field resolution)              │
│  ┌──────────────┬──────────────┬──────────────────────┐    │
│  │   #hono      │    #pty      │        #db           │    │
│  │ adapter.node │  pty.node    │     db.node          │    │
│  │              │              │                      │    │
│  │ @hono/node-  │ @lydell/     │  node:sqlite         │    │
│  │ server       │ node-pty     │  drizzle-orm/        │    │
│  │ @hono/node-ws│              │  node-sqlite         │    │
│  └──────────────┴──────────────┴──────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Core CLI Commands                         │
│         packages/opencode/src/cli/cmd/*                      │
│  • run      • serve    • web      • agent                   │
│  • models   • providers • mcp     • acp                     │
│  • export   • import   • session  • db                      │
│  • github   • pr       • stats    • debug                   │
└─────────────────────────────────────────────────────────────┘
```

### 统一 CLI 入口点设计

当前状态：
- `packages/opencode/src/index.ts` - 完整的 CLI 实现（使用 Bun）
- `packages/nodejs-server/cli.mjs` - 简化的服务器入口点（仅支持 serve 命令）

目标状态：
- `packages/nodejs-server/cli.mjs` - 统一的 CLI 入口点（支持所有命令）
- 复用 `packages/opencode/src/index.ts` 的命令定义和逻辑

**实现策略**：

方案 A（推荐）：**构建时整合**
- 使用 esbuild 将 `src/index.ts` 编译为 ESM 格式
- 输出到 `dist/node/index.js`
- `cli.mjs` 作为轻量级包装器，导入并执行编译后的代码
- 优点：保持代码结构清晰，构建产物优化
- 缺点：需要构建步骤

方案 B：**运行时整合**
- `cli.mjs` 直接使用 tsx 或 Node.js loader 加载 TypeScript
- 优点：开发时无需构建
- 缺点：生产环境需要额外依赖，启动速度较慢

**选择方案 A**，因为：
1. 生产环境性能更好
2. 与现有构建流程一致
3. 可以进行代码优化和 tree-shaking

### 运行时适配层

运行时适配层通过 package.json 的 `imports` 字段实现，Node.js 会根据 `--conditions` 标志自动选择正确的实现：

```json
{
  "imports": {
    "#db": {
      "node": "./src/storage/db.node.ts",
      "default": "./src/storage/db.bun.ts"
    },
    "#pty": {
      "node": "./src/pty/pty.node.ts",
      "default": "./src/pty/pty.bun.ts"
    },
    "#hono": {
      "node": "./src/server/adapter.node.ts",
      "default": "./src/server/adapter.bun.ts"
    }
  }
}
```

**适配层接口**：

1. **#db (数据库)**
   - `db.node.ts`: 使用 `node:sqlite` + `drizzle-orm/node-sqlite`
   - 接口：`init(path: string) => DrizzleDB`

2. **#pty (伪终端)**
   - `pty.node.ts`: 使用 `@lydell/node-pty`
   - 接口：`spawn(command, args, options) => IPty`

3. **#hono (HTTP 服务器)**
   - `adapter.node.ts`: 使用 `@hono/node-server` + `@hono/node-ws`
   - 接口：`serve(app: Hono, options) => Server`

**迁移后的变化**：
- 移除 `"bun"` 条件分支
- 将 `"default"` 指向 Node.js 实现
- 确保所有导入使用 `#` 前缀而非直接路径


## Components and Interfaces

### 1. 构建系统组件

#### BuildOrchestrator
**职责**：协调整个构建流程

**接口**：
```typescript
interface BuildOrchestrator {
  build(options: BuildOptions): Promise<BuildResult>
}

interface BuildOptions {
  platform: Platform[]  // ['linux', 'darwin', 'win32']
  arch: Arch[]          // ['x64', 'arm64']
  mode: 'development' | 'production'
  outDir: string
}

interface BuildResult {
  artifacts: Artifact[]
  duration: number
  success: boolean
}
```

**实现**：
- 使用 esbuild 作为底层构建引擎
- 支持并行构建多个平台/架构组合
- 生成构建报告和元数据

#### MigrationEmbedder
**职责**：将数据库迁移脚本嵌入到构建产物中

**接口**：
```typescript
interface MigrationEmbedder {
  loadMigrations(dir: string): Promise<Migration[]>
  embedMigrations(migrations: Migration[]): string
}

interface Migration {
  name: string
  timestamp: number
  sql: string
}
```

**实现**：
- 扫描 `migration/` 目录
- 解析迁移文件名提取时间戳
- 生成 `OPENCODE_MIGRATIONS` 常量定义
- 通过 esbuild 的 `define` 选项注入

#### WasmAssetCopier
**职责**：复制 WASM 资源到输出目录

**接口**：
```typescript
interface WasmAssetCopier {
  copyWasmAssets(packages: string[], outDir: string): Promise<void>
}
```

**实现**：
- 查找 node_modules 中的 WASM 文件
- 复制到 `dist/node/chunks/` 目录
- 支持的包：web-tree-sitter、tree-sitter-bash、tree-sitter-powershell

### 2. CLI 入口点组件

#### UnifiedCLI
**职责**：统一的 CLI 入口点，整合所有命令

**接口**：
```typescript
interface UnifiedCLI {
  initialize(): Promise<void>
  parseArgs(args: string[]): Promise<void>
  execute(): Promise<number>
}
```

**实现**：
```typescript
// cli.mjs (简化版)
#!/usr/bin/env node --experimental-sqlite

import { CLI } from "./node.js"

const cli = new CLI()
await cli.initialize()
await cli.parseArgs(process.argv.slice(2))
const exitCode = await cli.execute()
process.exit(exitCode)
```

**初始化流程**：
1. 设置环境变量（AGENT=1, OPENCODE=1, OPENCODE_PID）
2. 初始化日志系统
3. 检查并执行数据库迁移
4. 注册所有命令
5. 解析命令行参数

### 3. 数据库迁移组件

#### JsonMigration
**职责**：首次启动时执行 JSON 到 SQLite 的迁移

**接口**：
```typescript
interface JsonMigration {
  run(db: DrizzleDB, options: MigrationOptions): Promise<void>
  needsMigration(): Promise<boolean>
}

interface MigrationOptions {
  progress?: (event: ProgressEvent) => void
}

interface ProgressEvent {
  current: number
  total: number
  label: string
}
```

**实现**：
- 检查 marker 文件（`opencode.db`）是否存在
- 如果不存在，执行迁移：
  1. 读取旧的 JSON 数据文件
  2. 转换为 SQLite 格式
  3. 显示进度条（TTY 检测）
  4. 创建 marker 文件
- 如果迁移失败，记录错误并退出

### 4. 测试框架组件

#### TestRunner
**职责**：执行测试套件

**接口**：
```typescript
interface TestRunner {
  run(options: TestOptions): Promise<TestResult>
}

interface TestOptions {
  pattern?: string
  timeout?: number
  reporter?: 'default' | 'junit' | 'json'
  reporterOutfile?: string
}

interface TestResult {
  passed: number
  failed: number
  skipped: number
  duration: number
}
```

**实现**：
- 使用 Vitest 作为测试框架
- 支持与 bun:test 相同的 API（describe, it, expect, beforeEach, afterEach）
- 生成 JUnit XML 报告用于 CI
- 支持 30 秒超时配置

### 5. 开发服务器组件

#### DevServer
**职责**：开发模式下运行 CLI

**接口**：
```typescript
interface DevServer {
  start(options: DevOptions): Promise<void>
  stop(): Promise<void>
}

interface DevOptions {
  watch?: boolean
  conditions?: string[]
}
```

**实现**：
- 使用 tsx 或 node --loader 运行 TypeScript
- 支持 `--conditions=browser` 标志
- 可选的文件监听和热重载

## Data Models

### 构建配置模型

```typescript
interface BuildConfig {
  // 入口点配置
  entrypoints: {
    cli: string          // src/index.ts
    node: string         // src/node.ts
  }
  
  // 输出配置
  output: {
    dir: string          // dist/node
    format: 'esm'
    sourcemap: boolean
  }
  
  // 外部依赖（不打包）
  external: string[]     // ['jsonc-parser', '@lydell/node-pty', '@parcel/watcher']
  
  // 平台配置
  platforms: PlatformConfig[]
}

interface PlatformConfig {
  platform: 'linux' | 'darwin' | 'win32'
  arch: 'x64' | 'arm64'
  baseline?: boolean     // 是否为 baseline 构建
  abi?: string          // 'glibc' | 'musl'
}
```

### 迁移数据模型

```typescript
interface MigrationData {
  // 嵌入的迁移脚本
  migrations: Migration[]
  
  // 迁移状态
  status: {
    completed: boolean
    markerPath: string
    lastRun?: Date
  }
}

interface Migration {
  name: string           // 20240101120000_initial
  timestamp: number      // Unix timestamp
  sql: string           // SQL 脚本内容
}
```

### 包依赖模型

```typescript
interface PackageDependencies {
  // 运行时依赖
  dependencies: {
    'jsonc-parser': string
    '@lydell/node-pty': string
    '@parcel/watcher': string
    '@hono/node-server': string
    '@hono/node-ws': string
    'drizzle-orm': string
  }
  
  // 可选依赖（平台特定）
  optionalDependencies: {
    '@lydell/node-pty-darwin-arm64': string
    '@lydell/node-pty-darwin-x64': string
    '@lydell/node-pty-linux-arm64': string
    '@lydell/node-pty-linux-x64': string
    '@lydell/node-pty-win32-arm64': string
    '@lydell/node-pty-win32-x64': string
    '@parcel/watcher-darwin-arm64': string
    '@parcel/watcher-darwin-x64': string
    '@parcel/watcher-linux-arm64-glibc': string
    '@parcel/watcher-linux-x64-glibc': string
    '@parcel/watcher-win32-arm64': string
    '@parcel/watcher-win32-x64': string
  }
  
  // 开发依赖
  devDependencies: {
    '@types/node': string
    'esbuild': string
    'vitest': string
    'tsx': string
  }
}
```

### 命令模型

```typescript
interface Command {
  name: string
  description: string
  options: CommandOption[]
  handler: (args: any) => Promise<void>
}

interface CommandOption {
  name: string
  type: 'string' | 'boolean' | 'number'
  description: string
  default?: any
  required?: boolean
}

// 示例：serve 命令
const ServeCommand: Command = {
  name: 'serve',
  description: 'Start HTTP + SSE server',
  options: [
    { name: 'port', type: 'string', default: '4096' },
    { name: 'hostname', type: 'string', default: '0.0.0.0' },
    { name: 'password', type: 'string', required: false },
    { name: 'username', type: 'string', default: 'opencode' },
  ],
  handler: async (args) => {
    // 实现
  }
}
```


## Error Handling

### 错误分类

1. **构建错误**
   - esbuild 编译失败
   - 迁移脚本加载失败
   - WASM 资源复制失败
   - 平台特定依赖缺失

2. **运行时错误**
   - Node.js 版本不兼容（< 22.5.0）
   - 数据库迁移失败
   - 命令执行失败
   - 适配层初始化失败

3. **依赖错误**
   - 缺少必需的 npm 包
   - 平台特定可选依赖缺失
   - 版本冲突

### 错误处理策略

#### 构建时错误处理

```typescript
class BuildError extends Error {
  constructor(
    message: string,
    public phase: 'compile' | 'embed' | 'copy' | 'package',
    public details?: any
  ) {
    super(message)
    this.name = 'BuildError'
  }
}

// 使用示例
try {
  await esbuild.build(config)
} catch (err) {
  throw new BuildError(
    'esbuild compilation failed',
    'compile',
    { config, error: err }
  )
}
```

**处理原则**：
- 构建失败时立即停止，不生成部分产物
- 记录详细的错误信息和上下文
- 提供可操作的错误消息（如缺少依赖时提示安装命令）

#### 运行时错误处理

```typescript
// Node.js 版本检查
function checkNodeVersion() {
  const version = process.versions.node
  const major = parseInt(version.split('.')[0])
  
  if (major < 22) {
    console.error(`Error: Node.js 22.5.0 or higher is required (current: ${version})`)
    console.error('Please upgrade Node.js: https://nodejs.org/')
    process.exit(1)
  }
}

// 数据库迁移错误处理
async function runMigration() {
  try {
    await JsonMigration.run(db, { progress })
  } catch (err) {
    Log.Default.error('migration failed', { error: err })
    console.error('Database migration failed. Please check the log file.')
    console.error(`Log file: ${Log.file()}`)
    process.exit(1)
  }
}

// 命令执行错误处理
try {
  await cli.parse()
} catch (err) {
  if (err instanceof NamedError) {
    const formatted = FormatError(err)
    if (formatted) {
      UI.error(formatted)
    }
  } else {
    Log.Default.error('fatal', { error: err })
    UI.error('Unexpected error, check log file for details')
  }
  process.exitCode = 1
}
```

#### 适配层错误处理

```typescript
// db.node.ts
export function init(path: string) {
  try {
    const sqlite = new DatabaseSync(path)
    return drizzle({ client: sqlite })
  } catch (err) {
    if (err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      throw new Error(
        'node:sqlite is not available. Please use Node.js 22.5.0 or higher with --experimental-sqlite flag.'
      )
    }
    throw err
  }
}

// pty.node.ts
export function spawn(command: string, args: string[], options: any) {
  try {
    return pty.spawn(command, args, options)
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        '@lydell/node-pty is not installed or platform-specific binary is missing. ' +
        'Please run: npm install'
      )
    }
    throw err
  }
}
```

### 错误恢复机制

1. **数据库迁移失败恢复**
   - 不创建 marker 文件
   - 下次启动时重新尝试迁移
   - 提供手动迁移工具（`testagent db migrate`）

2. **构建失败恢复**
   - 清理部分生成的文件
   - 提供详细的错误报告
   - 建议检查依赖和配置

3. **命令执行失败恢复**
   - 记录错误到日志文件
   - 显示用户友好的错误消息
   - 提供相关文档链接

### 日志记录

```typescript
// 统一日志接口
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "cli" })

// 不同级别的日志
log.debug("debug message", { data: value })
log.info("info message", { data: value })
log.warn("warning message", { error: err })
log.error("error message", { error: err })

// 日志配置
await Log.init({
  print: process.argv.includes("--print-logs"),  // 是否输出到 stderr
  dev: Installation.isLocal(),                   // 开发模式
  level: "INFO"                                  // 日志级别
})
```

**日志文件位置**：
- Linux: `~/.local/share/testagent/logs/`
- macOS: `~/Library/Application Support/testagent/logs/`
- Windows: `%LOCALAPPDATA%\testagent\logs\`

## Testing Strategy

### 测试框架选择：Vitest

**选择理由**：
1. 与 bun:test API 高度兼容（describe, it, expect, beforeEach, afterEach）
2. 原生支持 ESM 和 TypeScript
3. 快速的测试执行速度
4. 丰富的断言库和 mock 功能
5. 支持 JUnit XML 报告（CI 集成）
6. 活跃的社区和良好的文档

**替代方案**：
- Node.js 原生 test runner：功能较少，生态不成熟
- Jest：配置复杂，ESM 支持不佳

### 测试配置

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试文件匹配模式
    include: ['test/**/*.test.ts'],
    
    // 超时配置
    testTimeout: 30000,
    hookTimeout: 30000,
    
    // 环境配置
    environment: 'node',
    
    // 报告器配置
    reporters: process.env.CI 
      ? ['default', 'junit']
      : ['default'],
    
    // JUnit 报告输出
    outputFile: {
      junit: '.artifacts/unit/junit.xml'
    },
    
    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'test/**',
        'script/**',
        '**/*.test.ts',
        'dist/**'
      ]
    }
  }
})
```

### 测试迁移策略

#### 1. API 兼容性映射

Vitest 与 bun:test 的 API 基本兼容，无需修改测试代码：

| bun:test API | Vitest API | 兼容性 |
|--------------|------------|--------|
| `describe()` | `describe()` | ✅ 完全兼容 |
| `it()` | `it()` | ✅ 完全兼容 |
| `test()` | `test()` | ✅ 完全兼容 |
| `expect()` | `expect()` | ✅ 完全兼容 |
| `beforeEach()` | `beforeEach()` | ✅ 完全兼容 |
| `afterEach()` | `afterEach()` | ✅ 完全兼容 |
| `beforeAll()` | `beforeAll()` | ✅ 完全兼容 |
| `afterAll()` | `afterAll()` | ✅ 完全兼容 |
| `mock()` | `vi.mock()` | ⚠️ 语法略有不同 |
| `spyOn()` | `vi.spyOn()` | ⚠️ 语法略有不同 |

#### 2. Mock 迁移

```typescript
// Bun 风格
import { mock } from "bun:test"
const fn = mock(() => "result")

// Vitest 风格
import { vi } from "vitest"
const fn = vi.fn(() => "result")
```

#### 3. 测试文件结构

保持现有的测试文件结构不变：

```
packages/opencode/test/
├── tool/
│   ├── tool.test.ts
│   └── ...
├── storage/
│   ├── db.test.ts
│   └── ...
├── cli/
│   ├── cmd.test.ts
│   └── ...
└── kilocode/
    └── ...
```

### 测试类型

#### 1. 单元测试

测试独立的函数和模块：

```typescript
// test/storage/db.test.ts
import { describe, it, expect } from 'vitest'
import { init } from '#db'

describe('Database', () => {
  it('should initialize database', () => {
    const db = init(':memory:')
    expect(db).toBeDefined()
  })
  
  it('should execute queries', async () => {
    const db = init(':memory:')
    const result = await db.execute('SELECT 1 as value')
    expect(result.rows[0].value).toBe(1)
  })
})
```

#### 2. 集成测试

测试组件之间的交互：

```typescript
// test/cli/serve.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Server } from '#hono'

describe('Serve Command', () => {
  let server: any
  
  beforeEach(async () => {
    server = await Server.listen({ port: 0, hostname: 'localhost' })
  })
  
  afterEach(async () => {
    await server.stop()
  })
  
  it('should start server', () => {
    expect(server.port).toBeGreaterThan(0)
  })
  
  it('should respond to health check', async () => {
    const response = await fetch(`http://localhost:${server.port}/health`)
    expect(response.status).toBe(200)
  })
})
```

#### 3. 端到端测试

测试完整的 CLI 命令：

```typescript
// test/cli/e2e.test.ts
import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { promisify } from 'util'

const exec = promisify(require('child_process').exec)

describe('CLI E2E', () => {
  it('should show version', async () => {
    const { stdout } = await exec('node cli.mjs --version')
    expect(stdout).toMatch(/\d+\.\d+\.\d+/)
  })
  
  it('should show help', async () => {
    const { stdout } = await exec('node cli.mjs --help')
    expect(stdout).toContain('Commands:')
  })
})
```

### CI 集成

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '22.5.0'
      
      - name: Install dependencies
        run: npm install
      
      - name: Run tests
        run: npm test
        env:
          CI: true
      
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: .artifacts/unit/junit.xml
```

### 性能基准测试

```typescript
// test/benchmark/startup.test.ts
import { describe, it, expect } from 'vitest'
import { performance } from 'perf_hooks'

describe('Performance', () => {
  it('should start within acceptable time', async () => {
    const start = performance.now()
    
    // 启动 CLI
    await import('../../src/index.ts')
    
    const duration = performance.now() - start
    
    // 应该在 2 秒内启动
    expect(duration).toBeLessThan(2000)
  })
})
```


## Build System Design

### 从 Bun.build 迁移到 esbuild

#### 当前构建流程（Bun）

```typescript
// script/build-node.ts (当前)
await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
})
```

#### 新构建流程（esbuild）

```typescript
// script/build-node.ts (新)
import * as esbuild from 'esbuild'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

// 1. 加载迁移脚本
async function loadMigrations(dir: string) {
  const entries = await readdir(join(dir, 'migration'), { withFileTypes: true })
  const migrationDirs = entries
    .filter(e => e.isDirectory() && /^\d{14}/.test(e.name))
    .map(e => e.name)
    .sort()
  
  const migrations = await Promise.all(
    migrationDirs.map(async (name) => {
      const file = join(dir, 'migration', name, 'migration.sql')
      const sql = await readFile(file, 'utf-8')
      const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
      const timestamp = match
        ? Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6])
          )
        : 0
      return { sql, timestamp, name }
    })
  )
  
  return migrations
}

// 2. 构建配置
async function build() {
  const migrations = await loadMigrations(process.cwd())
  
  const result = await esbuild.build({
    entryPoints: ['./src/node.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22.5',
    format: 'esm',
    outdir: './dist/node',
    sourcemap: true,
    external: [
      'jsonc-parser',
      '@lydell/node-pty',
      '@parcel/watcher'
    ],
    define: {
      'OPENCODE_MIGRATIONS': JSON.stringify(migrations),
      'OPENCODE_CHANNEL': JSON.stringify('stable')
    },
    logLevel: 'info',
    metafile: true
  })
  
  // 3. 生成构建报告
  const text = await esbuild.analyzeMetafile(result.metafile)
  console.log(text)
}

build().catch(err => {
  console.error('Build failed:', err)
  process.exit(1)
})
```

#### esbuild 配置详解

**基础配置**：
```typescript
{
  // 入口点
  entryPoints: ['./src/node.ts', './src/index.ts'],
  
  // 打包模式
  bundle: true,                    // 打包所有依赖
  
  // 平台和目标
  platform: 'node',                // Node.js 平台
  target: 'node22.5',              // 目标 Node.js 版本
  
  // 输出格式
  format: 'esm',                   // ESM 模块格式
  outdir: './dist/node',           // 输出目录
  
  // Source map
  sourcemap: true,                 // 生成 source map
  
  // 外部依赖（不打包）
  external: [
    'jsonc-parser',                // JSON 解析器
    '@lydell/node-pty',            // PTY 库（原生模块）
    '@parcel/watcher'              // 文件监听（原生模块）
  ]
}
```

**高级配置**：
```typescript
{
  // 代码分割
  splitting: false,                // 不启用代码分割（CLI 单文件）
  
  // Tree shaking
  treeShaking: true,               // 启用 tree shaking
  
  // 压缩
  minify: process.env.NODE_ENV === 'production',
  
  // 定义常量
  define: {
    'OPENCODE_MIGRATIONS': JSON.stringify(migrations),
    'OPENCODE_CHANNEL': JSON.stringify('stable'),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
  },
  
  // 日志级别
  logLevel: 'info',
  
  // 元数据（用于分析）
  metafile: true
}
```

### 跨平台构建支持

#### 构建脚本架构

```typescript
// script/build.ts
import * as esbuild from 'esbuild'
import { copyFile, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

interface Platform {
  os: 'linux' | 'darwin' | 'win32'
  arch: 'x64' | 'arm64'
  abi?: 'glibc' | 'musl'
  baseline?: boolean
}

const PLATFORMS: Platform[] = [
  // Linux
  { os: 'linux', arch: 'x64', abi: 'glibc' },
  { os: 'linux', arch: 'x64', abi: 'musl' },
  { os: 'linux', arch: 'arm64', abi: 'glibc' },
  { os: 'linux', arch: 'arm64', abi: 'musl' },
  
  // macOS
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'arm64' },
  
  // Windows
  { os: 'win32', arch: 'x64' },
  { os: 'win32', arch: 'arm64' },
]

async function buildForPlatform(platform: Platform) {
  const suffix = [
    platform.os,
    platform.arch,
    platform.abi,
    platform.baseline ? 'baseline' : undefined
  ].filter(Boolean).join('-')
  
  const outdir = join('dist', suffix, 'bin')
  
  console.log(`Building for ${suffix}...`)
  
  // 1. 构建主程序
  await esbuild.build({
    entryPoints: ['./src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22.5',
    format: 'esm',
    outdir,
    sourcemap: true,
    external: ['jsonc-parser', '@lydell/node-pty', '@parcel/watcher'],
    define: {
      'OPENCODE_MIGRATIONS': JSON.stringify(migrations),
      'OPENCODE_CHANNEL': JSON.stringify('stable')
    }
  })
  
  // 2. 复制 WASM 资源
  await copyWasmAssets(outdir)
  
  // 3. 生成 package.json
  await generatePackageJson(outdir, platform)
  
  // 4. 创建可执行文件包装器
  await createExecutableWrapper(outdir, platform)
  
  console.log(`✓ Built ${suffix}`)
}

async function buildAll() {
  await Promise.all(PLATFORMS.map(buildForPlatform))
}
```

#### WASM 资源复制

```typescript
// script/copy-wasm.ts
import { readdir, copyFile, mkdir } from 'fs/promises'
import { join } from 'path'

const WASM_PACKAGES = [
  'web-tree-sitter',
  'tree-sitter-bash',
  'tree-sitter-powershell'
]

async function copyWasmAssets(outdir: string) {
  const chunksDir = join(outdir, 'chunks')
  await mkdir(chunksDir, { recursive: true })
  
  const nodeModulesDirs = [
    join(process.cwd(), 'node_modules'),
    join(process.cwd(), '../../node_modules')
  ]
  
  for (const pkg of WASM_PACKAGES) {
    for (const nmDir of nodeModulesDirs) {
      const pkgDir = join(nmDir, pkg)
      
      try {
        const files = await readdir(pkgDir, { recursive: true })
        
        for (const file of files) {
          if (!file.endsWith('.wasm')) continue
          
          const src = join(pkgDir, file)
          const dest = join(chunksDir, file.split('/').pop()!)
          
          await copyFile(src, dest)
          console.log(`  Copied WASM: ${file.split('/').pop()}`)
        }
        
        break // 找到包后跳出
      } catch (err) {
        // 包不存在，尝试下一个目录
        continue
      }
    }
  }
}
```

#### 平台特定 package.json 生成

```typescript
// script/generate-package-json.ts
import { writeFile } from 'fs/promises'
import { join } from 'path'

async function generatePackageJson(outdir: string, platform: Platform) {
  const pkg = {
    name: '@opencode-ai/server',
    version: '0.1.0',
    type: 'module',
    description: 'OpenCode AI Server - Node.js standalone distribution',
    bin: {
      'nodejs-server': './cli.mjs',
      'testagent': './cli.mjs',
      'opencode': './cli.mjs'
    },
    engines: {
      node: '>=22.5.0'
    },
    dependencies: {
      'jsonc-parser': '^3.3.1',
      '@lydell/node-pty': '1.2.0-beta.10',
      '@parcel/watcher': '^2.5.0'
    },
    optionalDependencies: getOptionalDependencies(platform)
  }
  
  await writeFile(
    join(outdir, 'package.json'),
    JSON.stringify(pkg, null, 2)
  )
}

function getOptionalDependencies(platform: Platform) {
  const deps: Record<string, string> = {}
  
  // 只包含当前平台的可选依赖
  const key = `@lydell/node-pty-${platform.os}-${platform.arch}`
  deps[key] = '1.2.0-beta.10'
  
  const watcherKey = `@parcel/watcher-${platform.os}-${platform.arch}${
    platform.abi ? `-${platform.abi}` : ''
  }`
  deps[watcherKey] = '^2.5.0'
  
  return deps
}
```

#### 可执行文件包装器

```typescript
// script/create-wrapper.ts
import { writeFile, chmod } from 'fs/promises'
import { join } from 'path'

async function createExecutableWrapper(outdir: string, platform: Platform) {
  const isWindows = platform.os === 'win32'
  
  if (isWindows) {
    // Windows: 创建 .cmd 文件
    const wrapper = `@echo off
node --experimental-sqlite "%~dp0\\index.js" %*
`
    await writeFile(join(outdir, 'testagent.cmd'), wrapper)
  } else {
    // Unix: 创建 shell 脚本
    const wrapper = `#!/bin/sh
exec node --experimental-sqlite "$(dirname "$0")/index.js" "$@"
`
    const path = join(outdir, 'testagent')
    await writeFile(path, wrapper)
    await chmod(path, 0o755)
  }
  
  // 创建 opencode 别名
  if (isWindows) {
    await writeFile(
      join(outdir, 'opencode.cmd'),
      `@echo off\ncall "%~dp0\\testagent.cmd" %*\n`
    )
  } else {
    const path = join(outdir, 'opencode')
    await writeFile(path, `#!/bin/sh\nexec "$(dirname "$0")/testagent" "$@"\n`)
    await chmod(path, 0o755)
  }
}
```

### 构建产物结构

```
dist/
├── linux-x64-glibc/
│   └── bin/
│       ├── index.js
│       ├── index.js.map
│       ├── chunks/
│       │   ├── tree-sitter.wasm
│       │   ├── tree-sitter-bash.wasm
│       │   └── tree-sitter-powershell.wasm
│       ├── package.json
│       ├── testagent
│       └── opencode -> testagent
├── linux-x64-musl/
│   └── bin/
│       └── ...
├── darwin-arm64/
│   └── bin/
│       └── ...
└── win32-x64/
    └── bin/
        ├── index.js
        ├── testagent.cmd
        └── opencode.cmd
```

### 构建优化

#### 1. 并行构建

```typescript
async function buildAll() {
  const results = await Promise.allSettled(
    PLATFORMS.map(platform => buildForPlatform(platform))
  )
  
  const failed = results.filter(r => r.status === 'rejected')
  if (failed.length > 0) {
    console.error(`${failed.length} builds failed`)
    process.exit(1)
  }
  
  console.log('All builds completed successfully')
}
```

#### 2. 增量构建

```typescript
import { stat } from 'fs/promises'

async function needsRebuild(src: string, dest: string): Promise<boolean> {
  try {
    const [srcStat, destStat] = await Promise.all([
      stat(src),
      stat(dest)
    ])
    return srcStat.mtime > destStat.mtime
  } catch {
    return true // 目标文件不存在
  }
}
```

#### 3. 缓存优化

```typescript
// 使用 esbuild 的增量构建
let ctx: esbuild.BuildContext | undefined

async function buildIncremental() {
  if (!ctx) {
    ctx = await esbuild.context({
      // ... 配置
    })
  }
  
  await ctx.rebuild()
}

// 清理
process.on('exit', () => {
  ctx?.dispose()
})
```


## Development Workflow

### 开发脚本设计

#### package.json 脚本配置

```json
{
  "scripts": {
    "dev": "tsx --conditions=node ./src/index.ts",
    "dev:watch": "tsx watch --conditions=node ./src/index.ts",
    "build": "node script/build.ts",
    "build:node": "node script/build-node.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ci": "vitest run --reporter=junit --reporter=default --outputFile=.artifacts/unit/junit.xml",
    "typecheck": "tsgo --noEmit",
    "lint": "eslint src/ test/",
    "clean": "rm -rf dist .artifacts"
  }
}
```

### dev 脚本实现

#### 方案 1：使用 tsx（推荐）

```bash
# 直接运行 TypeScript
tsx --conditions=node ./src/index.ts

# 带监听模式
tsx watch --conditions=node ./src/index.ts
```

**优点**：
- 无需构建步骤
- 支持 TypeScript
- 支持文件监听
- 启动速度快

**缺点**：
- 需要额外依赖 tsx

#### 方案 2：使用 Node.js loader

```bash
# 使用 Node.js 的 TypeScript loader
node --loader ts-node/esm --conditions=node ./src/index.ts
```

**优点**：
- 使用 Node.js 原生功能
- 无需额外工具

**缺点**：
- 配置复杂
- 启动速度较慢

#### 方案 3：构建后运行

```bash
# 先构建
npm run build:node

# 再运行
node --experimental-sqlite dist/node/index.js
```

**优点**：
- 运行速度最快
- 与生产环境一致

**缺点**：
- 需要构建步骤
- 开发体验较差

**选择方案 1（tsx）**，因为：
1. 开发体验最好
2. 支持热重载
3. 无需构建步骤
4. 社区广泛使用

### 开发环境配置

#### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowJs": true,
    "checkJs": false,
    "outDir": "./dist",
    "rootDir": "./src",
    "removeComments": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "paths": {
      "#db": ["./src/storage/db.node.ts"],
      "#pty": ["./src/pty/pty.node.ts"],
      "#hono": ["./src/server/adapter.node.ts"]
    }
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### .env 配置

```bash
# .env.development
NODE_ENV=development
OPENCODE_LOG_LEVEL=DEBUG
OPENCODE_PRINT_LOGS=true
OPENCODE_PURE=false
```

### 调试配置

#### VS Code launch.json

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug CLI",
      "runtimeArgs": [
        "--experimental-sqlite",
        "--loader",
        "tsx"
      ],
      "args": [
        "${workspaceFolder}/src/index.ts",
        "--print-logs"
      ],
      "cwd": "${workspaceFolder}",
      "env": {
        "NODE_ENV": "development",
        "OPENCODE_LOG_LEVEL": "DEBUG"
      },
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Serve Command",
      "runtimeArgs": [
        "--experimental-sqlite",
        "--loader",
        "tsx"
      ],
      "args": [
        "${workspaceFolder}/src/index.ts",
        "serve",
        "--port",
        "4096",
        "--print-logs"
      ],
      "cwd": "${workspaceFolder}",
      "env": {
        "NODE_ENV": "development"
      },
      "console": "integratedTerminal"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Tests",
      "runtimeArgs": [
        "--experimental-vm-modules",
        "${workspaceFolder}/node_modules/vitest/vitest.mjs",
        "run",
        "${file}"
      ],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal"
    }
  ]
}
```

### 热重载支持

#### 使用 tsx watch

```typescript
// script/dev.ts
import { spawn } from 'child_process'
import { watch } from 'chokidar'

let child: any = null

function start() {
  if (child) {
    child.kill()
  }
  
  child = spawn('tsx', [
    '--conditions=node',
    './src/index.ts',
    ...process.argv.slice(2)
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development'
    }
  })
}

// 监听文件变化
const watcher = watch('src/**/*.ts', {
  ignored: /(^|[\/\\])\../,
  persistent: true
})

watcher.on('change', (path) => {
  console.log(`File changed: ${path}`)
  console.log('Restarting...')
  start()
})

// 初始启动
start()

// 清理
process.on('SIGINT', () => {
  if (child) child.kill()
  watcher.close()
  process.exit(0)
})
```

### 依赖管理

#### 移除 Bun 依赖

```json
// package.json - 移除
{
  "devDependencies": {
    "@types/bun": "...",  // 移除
    "bun-pty": "..."      // 移除
  }
}
```

#### 添加 Node.js 依赖

```json
// package.json - 添加
{
  "dependencies": {
    "@lydell/node-pty": "1.2.0-beta.10",
    "@parcel/watcher": "^2.5.0",
    "@hono/node-server": "1.19.11",
    "@hono/node-ws": "1.3.0",
    "drizzle-orm": "^0.30.0"
  },
  "optionalDependencies": {
    "@lydell/node-pty-darwin-arm64": "1.2.0-beta.10",
    "@lydell/node-pty-darwin-x64": "1.2.0-beta.10",
    "@lydell/node-pty-linux-arm64": "1.2.0-beta.10",
    "@lydell/node-pty-linux-x64": "1.2.0-beta.10",
    "@lydell/node-pty-win32-arm64": "1.2.0-beta.10",
    "@lydell/node-pty-win32-x64": "1.2.0-beta.10",
    "@parcel/watcher-darwin-arm64": "^2.5.0",
    "@parcel/watcher-darwin-x64": "^2.5.0",
    "@parcel/watcher-linux-arm64-glibc": "^2.5.0",
    "@parcel/watcher-linux-x64-glibc": "^2.5.0",
    "@parcel/watcher-win32-arm64": "^2.5.0",
    "@parcel/watcher-win32-x64": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "esbuild": "^0.20.0",
    "vitest": "^1.6.0",
    "tsx": "^4.7.0"
  }
}
```

### CI/CD 更新

#### GitHub Actions 工作流

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node-version: ['22.5.0', '22.x']
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Type check
        run: npm run typecheck
      
      - name: Run tests
        run: npm run test:ci
        env:
          CI: true
      
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-${{ matrix.os }}-${{ matrix.node-version }}
          path: .artifacts/unit/junit.xml

  build:
    runs-on: ubuntu-latest
    needs: test
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22.5.0'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
      
      - name: Smoke test
        run: |
          node --experimental-sqlite dist/node/index.js --version
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-artifacts
          path: dist/
```

#### 移除 Bun 相关配置

```yaml
# 移除 .github/actions/setup-bun/action.yml
# 移除 .github/workflows 中的 bun 相关步骤

# 替换为
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '22.5.0'
```

### 性能监控

#### 启动时间监控

```typescript
// src/util/perf.ts
import { performance } from 'perf_hooks'

export class PerfMonitor {
  private marks = new Map<string, number>()
  
  mark(name: string) {
    this.marks.set(name, performance.now())
  }
  
  measure(name: string, startMark: string, endMark?: string) {
    const start = this.marks.get(startMark)
    const end = endMark ? this.marks.get(endMark) : performance.now()
    
    if (!start) throw new Error(`Start mark ${startMark} not found`)
    
    const duration = (end || performance.now()) - start
    console.log(`[PERF] ${name}: ${duration.toFixed(2)}ms`)
    
    return duration
  }
}

// 使用
const perf = new PerfMonitor()

perf.mark('start')
await Log.init()
perf.measure('Log initialization', 'start')

perf.mark('db-start')
await Database.init()
perf.measure('Database initialization', 'db-start')
```

#### 内存使用监控

```typescript
// src/util/memory.ts
export function logMemoryUsage() {
  const usage = process.memoryUsage()
  
  console.log('Memory usage:')
  console.log(`  RSS: ${(usage.rss / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  Heap Total: ${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  Heap Used: ${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  External: ${(usage.external / 1024 / 1024).toFixed(2)} MB`)
}

// 定期监控
if (process.env.NODE_ENV === 'development') {
  setInterval(logMemoryUsage, 60000) // 每分钟
}
```

### 文档更新

#### README.md 更新

```markdown
# testagent CLI

## Requirements

- Node.js >= 22.5.0

## Installation

\`\`\`bash
npm install -g @opencode-ai/server
\`\`\`

## Development

\`\`\`bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run with watch mode
npm run dev:watch

# Run tests
npm test

# Build
npm run build
\`\`\`

## Running

\`\`\`bash
# Start server
testagent serve --port 4096

# Run agent
testagent run "your prompt"

# Show help
testagent --help
\`\`\`
```

#### AGENTS.md 更新

```markdown
## Build and Dev

- **Dev**: `npm run dev` (runs from root) or `tsx --conditions=node src/index.ts`
- **Extension**: `npm run extension` (build + launch VS Code with the extension in dev mode)
- **Typecheck**: `npm run typecheck` (uses `tsgo`, not `tsc`)
- **Test**: `npm test` from `packages/testagent-core/`
- **Single test**: `npm test -- test/tool/tool.test.ts`
- **Build**: `npm run build`

## Requirements

- Node.js >= 22.5.0
- npm or pnpm

## Migration from Bun

If you were previously using Bun:

1. Install Node.js 22.5.0 or higher
2. Remove Bun-specific dependencies
3. Run `npm install` to install Node.js dependencies
4. Use `npm run dev` instead of `bun run dev`
5. Use `npm test` instead of `bun test`
```


## Implementation Plan

### 阶段 1：准备工作（1-2 天）

#### 1.1 环境准备
- [ ] 安装 Node.js 22.5.0+
- [ ] 安装必要的 npm 包（esbuild, vitest, tsx）
- [ ] 创建功能分支 `feat/node-runtime-migration`

#### 1.2 依赖更新
- [ ] 更新 package.json：
  - 移除 `@types/bun`
  - 移除 `bun-pty`
  - 添加 `@types/node`
  - 添加 `@lydell/node-pty` 及平台特定依赖
  - 添加 `esbuild`, `vitest`, `tsx`
- [ ] 运行 `npm install` 验证依赖安装

#### 1.3 代码审查
- [ ] 审查所有使用 Bun API 的代码
- [ ] 列出需要替换的 Bun 特定功能
- [ ] 确认运行时适配层的完整性

### 阶段 2：构建系统迁移（2-3 天）

#### 2.1 创建 esbuild 构建脚本
- [ ] 实现 `script/build-node.ts`（使用 esbuild）
- [ ] 实现迁移脚本加载逻辑
- [ ] 实现 WASM 资源复制逻辑
- [ ] 测试单平台构建

#### 2.2 跨平台构建支持
- [ ] 实现 `script/build.ts`（多平台构建）
- [ ] 实现平台特定 package.json 生成
- [ ] 实现可执行文件包装器生成
- [ ] 测试所有平台构建

#### 2.3 构建验证
- [ ] 验证构建产物结构
- [ ] 验证 WASM 资源复制
- [ ] 验证迁移脚本嵌入
- [ ] 运行 smoke test

### 阶段 3：测试框架迁移（2-3 天）

#### 3.1 Vitest 配置
- [ ] 创建 `vitest.config.ts`
- [ ] 配置测试超时、报告器等
- [ ] 配置覆盖率收集

#### 3.2 测试迁移
- [ ] 更新测试文件中的 mock 语法（bun:test → vitest）
- [ ] 运行所有测试，修复失败的测试
- [ ] 验证 JUnit 报告生成

#### 3.3 CI 集成
- [ ] 更新 GitHub Actions 工作流
- [ ] 移除 setup-bun action
- [ ] 添加 setup-node action
- [ ] 验证 CI 测试通过

### 阶段 4：CLI 入口点统一（2-3 天）

#### 4.1 重构 cli.mjs
- [ ] 整合所有命令定义
- [ ] 实现日志初始化
- [ ] 实现数据库迁移检查
- [ ] 实现命令路由

#### 4.2 命令迁移
- [ ] 验证所有命令在 Node.js 下工作
- [ ] 测试命令行参数解析
- [ ] 测试环境变量设置

#### 4.3 集成测试
- [ ] 测试 `testagent serve` 命令
- [ ] 测试 `testagent run` 命令
- [ ] 测试其他所有命令
- [ ] 验证与 VS Code 扩展的兼容性

### 阶段 5：开发工作流更新（1-2 天）

#### 5.1 脚本更新
- [ ] 更新 package.json scripts
- [ ] 实现 dev 脚本（使用 tsx）
- [ ] 实现 dev:watch 脚本
- [ ] 测试开发模式

#### 5.2 调试配置
- [ ] 创建 VS Code launch.json
- [ ] 测试调试配置
- [ ] 文档化调试流程

#### 5.3 性能监控
- [ ] 实现启动时间监控
- [ ] 实现内存使用监控
- [ ] 收集性能基准数据

### 阶段 6：文档和验证（1-2 天）

#### 6.1 文档更新
- [ ] 更新 README.md
- [ ] 更新 AGENTS.md
- [ ] 创建迁移指南
- [ ] 更新贡献指南

#### 6.2 性能验证
- [ ] 对比 Bun 和 Node.js 的启动时间
- [ ] 对比命令执行时间
- [ ] 对比测试执行时间
- [ ] 记录性能数据

#### 6.3 兼容性验证
- [ ] 测试所有平台（Linux, macOS, Windows）
- [ ] 测试所有架构（x64, arm64）
- [ ] 测试 VS Code 扩展集成
- [ ] 测试数据库迁移

### 阶段 7：清理和发布（1 天）

#### 7.1 代码清理
- [ ] 移除所有 Bun 相关代码
- [ ] 移除未使用的导入
- [ ] 运行 linter 和 formatter
- [ ] 代码审查

#### 7.2 最终测试
- [ ] 运行完整测试套件
- [ ] 运行 CI 流程
- [ ] 手动测试关键功能
- [ ] 性能回归测试

#### 7.3 发布准备
- [ ] 创建 changeset
- [ ] 更新版本号
- [ ] 准备发布说明
- [ ] 合并到主分支

## Verification and Validation

### 功能验证清单

#### 1. 构建系统验证

```bash
# 验证构建成功
npm run build

# 验证构建产物
ls -la dist/node/
ls -la dist/node/chunks/

# 验证迁移脚本嵌入
grep -r "OPENCODE_MIGRATIONS" dist/node/

# 验证 WASM 资源
ls dist/node/chunks/*.wasm
```

#### 2. CLI 命令验证

```bash
# 验证版本
node --experimental-sqlite dist/node/index.js --version

# 验证帮助
node --experimental-sqlite dist/node/index.js --help

# 验证 serve 命令
node --experimental-sqlite dist/node/index.js serve --port 4096 &
curl http://localhost:4096/health
kill %1

# 验证其他命令
node --experimental-sqlite dist/node/index.js models
node --experimental-sqlite dist/node/index.js providers
```

#### 3. 测试验证

```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- test/tool/tool.test.ts

# 生成覆盖率报告
npm test -- --coverage

# 验证 JUnit 报告
npm run test:ci
cat .artifacts/unit/junit.xml
```

#### 4. 开发工作流验证

```bash
# 验证 dev 模式
npm run dev -- --version

# 验证 watch 模式
npm run dev:watch &
# 修改文件，观察重启
kill %1

# 验证类型检查
npm run typecheck
```

#### 5. 跨平台验证

```bash
# Linux
docker run -it --rm -v $(pwd):/app node:22.5.0 bash -c "cd /app && npm install && npm test"

# macOS
# 在 macOS 机器上运行
npm install && npm test

# Windows
# 在 Windows 机器上运行
npm install
npm test
```

### 性能验证

#### 1. 启动时间对比

```bash
# Bun 版本
time bun run --conditions=browser ./src/index.ts --version

# Node.js 版本
time node --experimental-sqlite dist/node/index.js --version

# 目标：Node.js 版本应在 Bun 版本的 110% 以内
```

#### 2. 命令执行时间对比

```bash
# Bun 版本
time bun run --conditions=browser ./src/index.ts models

# Node.js 版本
time node --experimental-sqlite dist/node/index.js models

# 目标：Node.js 版本应在 Bun 版本的 120% 以内
```

#### 3. 测试执行时间对比

```bash
# Bun 版本
time bun test

# Node.js 版本
time npm test

# 目标：Node.js 版本应在 Bun 版本的 130% 以内
```

### 兼容性验证

#### 1. VS Code 扩展集成

```typescript
// 测试脚本
import { spawn } from 'child_process'

async function testExtensionIntegration() {
  // 启动 CLI 服务器
  const cli = spawn('node', [
    '--experimental-sqlite',
    'dist/node/index.js',
    'serve',
    '--port', '4096'
  ])
  
  // 等待服务器启动
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  // 测试 API 端点
  const response = await fetch('http://localhost:4096/health')
  console.assert(response.status === 200, 'Health check failed')
  
  // 测试 SSE 连接
  const sse = new EventSource('http://localhost:4096/events')
  sse.onmessage = (event) => {
    console.log('Received SSE event:', event.data)
  }
  
  // 清理
  cli.kill()
  sse.close()
}

testExtensionIntegration()
```

#### 2. 数据库迁移验证

```bash
# 删除现有数据库
rm -rf ~/.local/share/testagent/opencode.db

# 运行 CLI（应触发迁移）
node --experimental-sqlite dist/node/index.js --version

# 验证迁移完成
ls -la ~/.local/share/testagent/opencode.db

# 验证数据库内容
sqlite3 ~/.local/share/testagent/opencode.db ".tables"
```

### 回归测试

#### 1. 现有功能测试

```bash
# 运行完整测试套件
npm test

# 验证所有测试通过
echo $?  # 应该是 0
```

#### 2. 集成测试

```bash
# 启动服务器
node --experimental-sqlite dist/node/index.js serve --port 4096 &
SERVER_PID=$!

# 运行集成测试
npm run test:integration

# 清理
kill $SERVER_PID
```

#### 3. 端到端测试

```bash
# 测试完整工作流
node --experimental-sqlite dist/node/index.js run "create a hello world script"

# 验证输出
ls hello.js
node hello.js
```

### 验收标准

迁移完成后，必须满足以下所有标准：

1. **功能完整性**
   - ✅ 所有 CLI 命令正常工作
   - ✅ VS Code 扩展正常连接
   - ✅ 数据库迁移正常执行
   - ✅ 所有测试通过

2. **性能要求**
   - ✅ 启动时间在 Bun 版本的 110% 以内
   - ✅ 命令执行时间在 Bun 版本的 120% 以内
   - ✅ 测试执行时间在 Bun 版本的 130% 以内

3. **跨平台支持**
   - ✅ Linux (x64, arm64) 正常工作
   - ✅ macOS (x64, arm64) 正常工作
   - ✅ Windows (x64, arm64) 正常工作

4. **开发体验**
   - ✅ dev 模式正常工作
   - ✅ 测试框架正常工作
   - ✅ 调试配置正常工作
   - ✅ 文档完整且准确

5. **CI/CD**
   - ✅ GitHub Actions 工作流正常
   - ✅ 测试报告正常生成
   - ✅ 构建产物正确生成

## Risk Assessment and Mitigation

### 高风险项

#### 1. 性能回归

**风险**：Node.js 版本可能比 Bun 版本慢

**影响**：用户体验下降

**缓解措施**：
- 使用 esbuild 优化构建产物
- 启用 V8 编译缓存
- 优化启动流程
- 如果性能差距过大，考虑保留 Bun 作为可选运行时

#### 2. 原生模块兼容性

**风险**：@lydell/node-pty 或 @parcel/watcher 在某些平台上不可用

**影响**：CLI 无法在某些平台上运行

**缓解措施**：
- 使用 optionalDependencies
- 提供降级方案（如使用 child_process 替代 pty）
- 在 CI 中测试所有平台

#### 3. 数据库迁移失败

**风险**：首次启动时迁移失败导致 CLI 无法使用

**影响**：用户无法使用 CLI

**缓解措施**：
- 充分测试迁移逻辑
- 提供详细的错误信息
- 提供手动迁移工具
- 保留旧数据作为备份

### 中风险项

#### 4. 测试框架差异

**风险**：Vitest 与 bun:test 的行为差异导致测试失败

**影响**：需要修改测试代码

**缓解措施**：
- 逐步迁移测试
- 对比测试结果
- 使用兼容的 API

#### 5. 构建复杂度增加

**风险**：esbuild 配置复杂，维护成本增加

**影响**：开发效率下降

**缓解措施**：
- 文档化构建流程
- 提供构建脚本模板
- 使用构建工具的最佳实践

### 低风险项

#### 6. 文档过时

**风险**：文档未及时更新

**影响**：用户困惑

**缓解措施**：
- 在迁移过程中同步更新文档
- 提供迁移指南
- 在 PR 中包含文档更新

#### 7. 依赖版本冲突

**风险**：新依赖与现有依赖冲突

**影响**：安装失败

**缓解措施**：
- 使用 npm 的 overrides 字段
- 锁定关键依赖版本
- 在 CI 中测试依赖安装

## Conclusion

本设计文档详细描述了将 testagent-core CLI 从 Bun 运行时迁移到 Node.js 22.5.0+ 运行时的技术方案。迁移的核心策略是：

1. **利用现有适配层**：充分利用已实现的 Node.js 适配层（adapter.node.ts、pty.node.ts、db.node.ts）
2. **统一 CLI 入口点**：将所有命令整合到 `packages/nodejs-server/cli.mjs`
3. **使用成熟工具**：采用 esbuild（构建）、Vitest（测试）、tsx（开发）等成熟工具
4. **保持兼容性**：确保与 VS Code 扩展和其他客户端的 API 兼容性
5. **渐进式迁移**：分阶段实施，每个阶段都有明确的验证标准

通过遵循本设计文档，我们可以：
- 移除对 Bun 的依赖，简化工具链
- 保持所有现有功能正常工作
- 确保性能在可接受范围内
- 支持所有目标平台和架构
- 提供良好的开发体验

迁移完成后，testagent-core CLI 将成为一个纯 Node.js 项目，更易于维护和部署。
