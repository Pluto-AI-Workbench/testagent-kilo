# testagent-kilo 与 testflow项目 编译打包说明

## 一、准备工作

### 1.1 拉取子目录依赖 && 安装依赖

```bash
# 在testagent-kilo项目根目录下执行
# 初始化并更新所有 submodule
git submodule update --init --recursive

# 安装根目录依赖
bun install

# 安装 submodule 依赖
# 需开启VPN软件的tun模式
bun install --cwd packages/testagent-opencode
bun install --cwd packages/testagent-core
```

### 1.2 安装 testflow

```bash
# 在testflow仓库目录下执行
# 可能需要先安装shx，npm install shx
npm run build
npm install -g .
```

---

## 二、CLI 二进制构建 (packages/testagent-opencode)

### 2.1 目标平台选择

| 目标 | 命令 | 产物大小 | 说明 |
|------|------|---------|------|
| macOS x64 | `bun bun:mac` | ~107 MB | 适用于 Intel Mac |
| macOS arm64 | `bun bun:mac-arm64` | ~93 MB | 适用于 Apple Silicon |
| Windows x64 | `bun bun:windows` | ~154 MB | 适用于 AVX2+ CPU |

**重要说明**：
- `win32-x64-baseline` 目标在 Windows 上无法自举构建（鸡生蛋蛋生鸡问题），需使用 `win32-x64` 替代
- `win32-x64` 目标需要 AVX2 CPU 指令集，但能正常工作
- 产物自动复制到 `packages/kilo-vscode/bin/` 目录

### 2.2 构建步骤

```bash
# 进入 opencode 包目录
cd packages/testagent-opencode/packages/opencode

# Windows 构建
bun bun:windows

# macOS 构建
bun bun:mac
```

### 2.3 手动处理（如果自动复制失败）

如果 `bun bun:windows` 的产物复制步骤失败，手动操作：

```bash
# 检查构建产物
ls -la packages/testagent-opencode/packages/opencode/dist/

# 手动复制到 kilo-vscode/bin/
# Windows
copy /Y packages\testagent-opencode\packages\opencode\dist\testagent.exe packages\kilo-vscode\bin\
copy /Y packages\testagent-opencode\packages\opencode\dist\opencode.cmd packages\kilo-vscode\bin\

# 验证
packages\kilo-vscode\bin\testagent.exe --version
```

---

## 三、VSIX 打包 (packages/kilo-vscode)

### 3.1 完整打包命令

```bash
cd packages/kilo-vscode
bun run testagent:vsix
```

这会依次执行：
1. `bun run rebuild-sdk` - 重建 SDK
2. `bun run typecheck` - 类型检查
3. `bun run lint` - 代码检查
4. `node esbuild.js --production` - esbuild 打包
5. `vsce package --no-dependencies` - 生成 VSIX

### 3.2 分步执行（便于调试）

```bash
cd packages/kilo-vscode

# 步骤1：确保 CLI 二进制存在
bun run prepare:cli-binary

# 步骤2：重建 SDK（可能失败，见 3.4 节）
bun run rebuild-sdk

# 步骤3：类型检查
bun run typecheck

# 步骤4：lint
bun run lint

# 步骤5：esbuild 打包
node esbuild.js --production

# 步骤6：生成 VSIX（不检查依赖）
vsce package --no-dependencies
```

### 3.3 VSIX 输出

- 文件名格式：`testagent-tscode-{version}.vsix`
- 输出目录：`packages/kilo-vscode/`
- 示例：`testagent-tscode-1.0.4.vsix`

### 3.4 SDK 构建失败处理

如果 `bun run rebuild-sdk` 失败（常见于 openai 模块 version.mjs 缺失问题），可以跳过：

```bash
# 方法1：直接使用 vsce 打包（依赖已满足时）
vsce package --no-dependencies

# 方法2：使用 prebuilt SDK（如果存在）
# 检查 packages/sdk/js/dist/ 是否已有产物
```

---

## 四、验证打包结果

### 4.1 检查 VSIX 内容

```powershell
# 使用 PowerShell 解压检查
$tmp = "$env:TEMP\vsix_check"
New-Item -ItemType Directory -Path $tmp -Force
Copy-Item "packages\kilo-vscode\testagent-tscode-1.0.4.vsix" "$tmp\test.vsix"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("$tmp\test.vsix", "$tmp\ext")
Get-ChildItem "$tmp\ext" -Recurse -File | Where-Object { $_.Name -eq "testagent.exe" } | Select-Object FullName, Length
```

### 4.2 预期结果

- `testagent.exe` 应存在于 `extension/bin/` 目录下
- 文件大小约 154 MB（非 baseline）
- VSIX 包大小约 67 MB（压缩后）

---

## 五、常见问题

### Q1: win32-x64-baseline 构建失败
**原因**：baseline 目标需要已存在的 baseline bun 来解压，无法在 Windows 上自举。
**解决**：使用 `--target=win32-x64` 或等待官方提供预编译 baseline。

### Q2: SDK 构建报 openai version.mjs 缺失
**原因**：openai@6.37.0 的依赖问题，某些版本缺少必要文件。
**解决**：尝试 `bun run --cwd ../sdk/js build` 或直接跳过 SDK 重建使用 `vsce package --no-dependencies`。

### Q3: esbuild.js 执行时间过长
**正常**：首次执行可能运行多个 watch 周期，确保构建完成即可。

---

## 六、调试技巧

### 6.1 查看 Webview 日志
按 `Ctrl+Shift+P`，输入：`Developer: Open Webview Developer Tools`

### 6.2 CLI 版本验证
```bash
packages\kilo-vscode\bin\testagent.exe --version
```

### 6.3 查看构建日志
esbuild.js 运行时会输出 `[build] Backend runtime: testagent-bun`，确认 bun 集成正常。

---

# kilo-code AI聊天窗口 DEBUG方法

按 CTRL+SHIFT+P ，输入：Developer: Open Webview Developer Tools ，打开Console窗口查看日志



# 手动构建

手动构建步骤：
cd packages/kilo-vscode
## 1. 类型检查
bun run typecheck
## 2. lint 检查
bun run lint
## 3. esbuild 打包
node esbuild.js --production
## 4. 生成 vsix（跳过依赖检查）
vsce package --no-dependencies
注意：vsce 命令需要已安装 vsce（npm install -g vsce），且当前目录必须是 packages/kilo-vscode。