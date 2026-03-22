# Review Request: runtime-worktree macOS smoke contract fixes

Review-Target-ID: fix-runtime-worktree-smoke
Branch: fix/runtime-worktree-smoke

## What
- 归一化 `runtime-worktree.sh` 的 `CAT_CAFE_RUNTIME_DIR` / 默认 runtime 路径，消除 macOS `/tmp` → `/private/tmp` 别名导致的 worktree 误报
- 在 `pnpm start` / `pnpm runtime:sync` 链路中，把根 checkout 的 `.env` / `.env.local` 镜像到 sibling runtime worktree
- 给 `runtime-worktree-script.test.js` 补回归测试，覆盖 symlink alias + `.env` 镜像
- 更新 `README.md` / `SETUP.md`，把 `.env` 真相源和 runtime-worktree 启动契约写清楚

## Why
- 这轮 `clowder-ai` 隔离 smoke 暴露了两个 release blocker：
  1. fresh clone 放在 macOS `/tmp/...` 时，runtime worktree 初始化成功后又报 `runtime worktree not found`
  2. `pnpm start` 不会吃 source checkout 的 `.env`，用户按 README 改根目录 `.env` 后，真正启动出来的还是 runtime 默认端口
- 这两个问题不修，`README/SETUP` 的安装契约就不成立，`v0.1.0` 不该切

## Original Requirements
> 做一轮隔离的 README/SETUP macOS smoke  
> 目标还是 clowder-ai  
> 但必须强制隔离端口/Redis，不能碰家里 runtime  
> 这轮过了，才说明“别人按文档真能装起来”  
> 如果这轮 smoke 过 直接切 v0.1.0
- 来源：当前 thread `0001774174231109-000018-e5f2d0a5`
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff
- 没有改成“source checkout 直接启动、不走 runtime worktree”，因为这会动到公开仓当前默认启动架构
- `.env` 镜像保持最小边界：只同步 `.env` / `.env.local`，不引入其他 source-side 本地文件

## Open Questions
- `sync_runtime_env_files()` 现在在 `init/sync/start` 三个点调用，边界是否合适，还是应该再收敛成单一点位
- `is_api_running()` 读取 runtime `.env` 的端口 fallback 是否足够稳，还是要进一步抽成统一 runtime 配置解析

## Next Action
- 请按严格标准 review `runtime-worktree.sh` 的路径归一化和 `.env` 镜像边界
- 如果放行，我就直接开 `clowder-ai` PR 并请求 formal review

## 自检证据

### Spec 合规
- 这轮不是新功能，是 release blocker 修复
- 目标是把 `README/SETUP` 的启动契约修回真实可用：macOS fresh clone + `pnpm start` 必须能在隔离端口起起来，而且 source `.env` 改动要真生效到 runtime worktree
- 没有改动 runtime 主逻辑，不碰家里 runtime，也没有扩展公开仓启动形态

### 测试结果
- `node --test packages/api/test/runtime-worktree-script.test.js` → `8 pass, 0 fail`
- 隔离 smoke（fresh clone + clean env）：
  - API `/health` → `200`
  - Frontend `/` → `200`
  - runtime 实际启动端口：Frontend `7303` / API `7304` / Preview `7400`
  - 日志包含 `synced .env into runtime worktree`
  - 停服后 `7303/7304/7400` 无残留监听

### 相关文档
- README: `README.md`
- Setup guide: `SETUP.md`
- Incident lesson: `docs/lessons-learned.md` 中的 `LL-035`
