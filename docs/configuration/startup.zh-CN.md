# 启动与命令

## 快速开始

```bash
pnpm start
```

这是主入口。它会自动完成以下操作：

1. 创建一个运行时 worktree（用于安全的自动更新）
2. 启动 Redis（除非使用 `--memory`）
3. 构建并启动 API 服务器和前端
4. 在 **http://localhost:3003** 打开 Hub

## 启动标志

### `pnpm start --quick`

跳过构建步骤。在完成初次构建后、源代码未发生变化时使用。适合日常使用中的快速重启。

```bash
# 跳过构建，快速启动（适用于代码未更改时）
pnpm start --quick
```

### `pnpm start --memory`

跳过 Redis，改用内存存储。所有数据（记忆、线程、任务）都会在进程停止时丢失。

```bash
# 不依赖 Redis，数据存于内存（重启后丢失）
pnpm start --memory
```

### `pnpm start --daemon`

在后台运行所有服务（守护进程模式）。终端会立即释放。

```bash
pnpm start --daemon
```

### `pnpm start:direct`

直接从当前检出的代码运行，不创建自动更新 worktree。使用它可将版本固定在你已检出的确切版本上。

```bash
# 直接运行当前版本，不自动更新
pnpm start:direct
```

## 服务管理

| 命令                | 说明                               |
|---------------------|------------------------------------|
| `pnpm start:status` | 检查服务是否正在运行               |
| `pnpm stop`         | 停止所有正在运行的服务             |

## 开发

| 命令         | 说明                                       |
|--------------|--------------------------------------------|
| `pnpm build` | 构建所有包                                 |
| `pnpm dev`   | 以开发模式启动，支持热重载                 |
| `pnpm check` | 运行代码检查与质量检查（Biome）            |
| `pnpm test`  | 运行完整测试套件                           |

## 可选服务

### Embedding（本地语义重排）

要为记忆系统启用本地语义重排，请从 Console 设置中安装 **Embedding** 服务 —— 安装程序会创建 `~/.cat-cafe/embed-venv`，并为你的平台配置合适的后端（Apple Silicon 上使用 MLX，其他平台使用 fastembed/ONNX 或 sentence-transformers）。在 Windows 上，当 Console 报告该服务已安装且已启用时，`pnpm start` / `pnpm start:direct` 会自动启动 embedding 服务器。通过 Console 卸载或禁用该服务则会跳过自动启动。

## 平台专属安装

### Linux（一行命令）

```bash
bash scripts/install.sh
```

选项：

| 标志                | 作用                                      |
|---------------------|-------------------------------------------|
| `--start`           | 安装后立即启动服务                        |
| `--memory`          | 使用内存存储（无需 Redis）                |
| `--registry=<URL>`  | 使用自定义 npm registry                   |

示例：

```bash
# Install and start immediately with in-memory storage
# 安装后立即启动，使用内存模式
bash scripts/install.sh --start --memory
```

### Windows

```powershell
# Step 1: Install dependencies
# 第一步：安装依赖
scripts/install.ps1

# Step 2: Start services
# 第二步：启动服务
scripts/start-windows.ps1
```
