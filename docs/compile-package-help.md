testagent-kilo 与 testflow项目 编译打包说明

拉取子目录依赖 && 安装依赖

# 1、在testagent-kilo项目根目录下执行
# 初始化并更新所有 submodule
git submodule update --init --recursive

# 安装根目录依赖
bun install

# 安装 submodule 依赖
# 需开启VPN软件的tun模式
bun install --cwd packages/testagent-opencode
bun install --cwd packages/testagent-core

# 2、安装 testflow
# 在testflow仓库目录下执行
# 可能需要先安装shx，npm install shx
npm run build
npm install -g .

## 3、打包 VSIX

**第一步**：在 `packages/testagent-opencode` 中构建 CLI 二进制：

```bash
# macOS
bun bun:mac

# Windows
bun bun:windows
```

产物会自动复制到 `packages/kilo-vscode/bin/` 目录。

**第二步**：在 `packages/kilo-vscode` 中打包扩展：

📢 如果CLI 二级制无变化 可以不操作第一步，直接第二步构建插件

```bash
bun run testagent:vsix
```

VSIX 文件输出到 `packages/kilo-vscode/` 目录下。



# kilo-code AI聊天窗口 DEBUG方法，按 CTRL+SHIFT+P ，输入：Developer:Open Webview Developer Tools ，打开Console窗口查看日志
