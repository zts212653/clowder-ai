# Startup & Commands

## Quick Start

```bash
pnpm start
```

This is the main entry point. It automatically:

1. Creates a runtime worktree (for safe auto-updates)
2. Starts Redis (unless `--memory` is used)
3. Builds and starts the API server and frontend
4. Opens the Hub at **http://localhost:3003**

## Startup Flags

### `pnpm start --quick`

Skip the build step. Use this after your initial build when no source code has changed. Good for fast restarts during daily use.

```bash
# 跳过构建，快速启动（适用于代码未更改时）
pnpm start --quick
```

### `pnpm start --memory`

Skip Redis and use in-memory storage instead. All data (memory, threads, tasks) will be lost when the process stops.

```bash
# 不依赖 Redis，数据存于内存（重启后丢失）
pnpm start --memory
```

### `pnpm start --daemon`

Run all services in the background (daemon mode). The terminal is released immediately.

```bash
pnpm start --daemon
```

### `pnpm start:direct`

Run directly from the current checkout without creating an auto-update worktree. Use this to pin to the exact version you have checked out.

```bash
# 直接运行当前版本，不自动更新
pnpm start:direct
```

## Service Management

| Command             | Description                        |
|---------------------|------------------------------------|
| `pnpm start:status` | Check whether services are running |
| `pnpm stop`         | Stop all running services          |

## Development

| Command      | Description                                |
|--------------|--------------------------------------------|
| `pnpm build` | Build all packages                         |
| `pnpm dev`   | Start in development mode with hot-reload  |
| `pnpm check` | Run linting and quality checks (Biome)     |
| `pnpm test`  | Run the full test suite                    |

## Optional Services

### Embedding (Local Semantic Rerank)

To enable local semantic rerank for the memory system, install the **Embedding** service from Console settings — the installer creates `~/.cat-cafe/embed-venv` with the right backend for your platform (MLX on Apple Silicon, fastembed/ONNX or sentence-transformers elsewhere). On Windows, `pnpm start` / `pnpm start:direct` then auto-launches the embedding server when Console reports the service as installed + enabled. Uninstalling or disabling via Console will skip the autostart.

## Platform-Specific Install

### Linux (one-liner)

```bash
bash scripts/install.sh
```

Options:

| Flag                | Effect                                    |
|---------------------|-------------------------------------------|
| `--start`           | Start services immediately after install  |
| `--memory`          | Use in-memory storage (no Redis required) |
| `--registry=<URL>`  | Use a custom npm registry                 |

Example:

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
