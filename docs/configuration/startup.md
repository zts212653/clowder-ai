# Startup & Commands

## Quick Start

```bash
pnpm start
```

This is the main entry point. It automatically:

1. Runs from your current checkout, using its `.env` (no extra worktree, no switch to `origin/main`)
2. Starts Redis (unless `--memory` is used)
3. Builds and starts the API server and frontend
4. Opens the Hub at **http://localhost:3003**

If this checkout already has a `../cat-cafe-runtime` worktree from an earlier version, `pnpm start` keeps using it so its settings stay in effect; stop it with `pnpm runtime:stop`, or use `pnpm start:direct` to start this checkout instead (see SETUP.md).

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

Always run directly from the current checkout, even if a runtime worktree exists. Use this to pin to the exact version you have checked out.

```bash
# 直接运行当前版本，不自动更新
pnpm start:direct
```

### `pnpm runtime:start` (optional)

Start from an isolated runtime worktree (`../cat-cafe-runtime`) that tracks `origin/main` and syncs on each start. Manage it with `pnpm runtime:status`, `pnpm runtime:restart` and `pnpm runtime:stop`.

```bash
pnpm runtime:start
```

## Service Management

| Command             | Description                        |
|---------------------|------------------------------------|
| `pnpm start:status` | Check whether services are running |
| `pnpm stop`         | Stop services started from this checkout (`pnpm runtime:stop` for a runtime worktree) |

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
