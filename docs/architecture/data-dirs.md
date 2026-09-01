---
topics: [data-dirs, runtime, deployment]
doc_kind: operations
created: 2026-05-21
issue: 671
---

# 数据目录三根模型 — DATA_DIR / CACHE_DIR / LOG_DIR

> Issue: [#671 — 统一运行时数据路径](https://github.com/zts212653/clowder-ai/issues/671)

## 设计

运行时有 12 条数据路径，按生命周期划成三组，由三个环境变量统一控制：

| 根 | 含义 | 子路径 | 内容 | 不能丢吗？ |
|----|------|--------|------|------------|
| `DATA_DIR` | 持久数据 | `evidence.sqlite` | F102 记忆 SQLite | ✅ |
| | | `world.sqlite` | F093 World Engine SQLite | ✅ |
| | | `transcripts/` | F24 session transcript | ✅ |
| | | `audit-logs/` | append-only 审计日志 | ✅ |
| | | `cli-raw-archive/` | CLI 原始流量归档 | ✅ |
| | | `uploads/` | 用户上传文件（头像、附件、参考音频） | ✅ |
| | | `redis/` | Redis 持久化数据（dump.rdb + AOF） | ✅ |
| | | `redis-backups/` | Redis 定时备份快照 | ✅ |
| | | `cat-cafe/` | .cat-cafe 运行时可写状态（账户、凭证、catalog、治理…） | ✅ |
| `CACHE_DIR` | 可重建缓存 | `tts/` | TTS 音频缓存 | ❌ |
| | | `connector-media/` | 微信/飞书等下载的临时媒体 | ❌ |
| `LOG_DIR` | 日志 | — | Pino 滚动日志（直接使用 LOG_DIR，无子目录） | ❌ |

每个根的语义清晰：备份只需要照顾 `DATA_DIR`；磁盘紧张时可以放心清 `CACHE_DIR`；日志按 `LOG_DIR` 接独立磁盘/集中化平台。

## 行为

### 未设置根

各路径沿用 legacy 默认（保持向后兼容）：

- `evidence.sqlite` / `world.sqlite` → `{repoRoot}/`
- `transcripts/` → `{monorepoRoot}/data/transcripts`
- `audit-logs/` / `cli-raw-archive/` / `tts/` / `connector-media/` → `{cwd}/data/{name}`
- `uploads/` → `packages/api/uploads/`（模块相对，保证 connector outbound delivery 看到同一份）
- `redis/` → `~/.cat-cafe/redis-{profile}/`（由 `start-dev.sh` 基于 REDIS_PROFILE/PORT 动态推导）
- `redis-backups/` → `~/.cat-cafe/redis-backups/{profile}/`（同上）
- `cat-cafe/` → `{projectRoot}/.cat-cafe/`（50+ 消费方通过此路径读写账户、凭证、catalog 等运行时状态）
- `LOG_DIR` → `{cwd}/data/logs/api`

### 设置根

```bash
DATA_DIR=/srv/clowder/data
CACHE_DIR=/srv/clowder/cache
LOG_DIR=/var/log/clowder
```

各路径变为 `{root}/{子路径}`（LOG_DIR 直接使用，不加子目录）。三个根独立，可以只设其中一个。

## 启动期自动迁移

服务启动时（Fastify 初始化后、SQLite/TranscriptWriter 等消费方初始化前）会：

1. **侦测**：legacy 路径有数据 + 新根下对应位置为空 → 列为待迁移
2. **空间预检**：在目标卷上调用 `statfs`，要求可用空间 ≥ 待迁移总量 × 1.5
3. **迁移**：
   - 同盘：`fs.rename`（原子）
   - 跨盘：`fs.copyFile` → `sha256` 校验 → 删除源
   - SQLite 主文件迁移时一并搬运 `-wal` / `-shm` / `-journal` sidecar
4. **失败保护**：
   - 空间不足 → 整体放弃迁移，输出 `abortedReason: insufficient-disk-space: need X bytes at Y, have Z`，所有 legacy 数据保持原位
   - 单条迁移失败 → 该条 legacy 保持原位、log warning；其他可迁移条目继续

启动迁移成功不需要重启（一切都在消费方初始化之前完成）。

`LOG_DIR` 不参与 API 启动迁移：Pino 在 module load 时就绑定了 LOG_DIR，没有 logger restart 流程做不到安全切换。**设置 LOG_DIR 仅影响后续写入；legacy 日志保留在旧路径，需要时由运维手动搬迁。**

`redis/`、`redis-backups/` 和 `cat-cafe/` 不参与 API 启动迁移（它们由 `start-dev.sh` 在服务启动前于 shell 层迁移）。

- **Redis**：当 `DATA_DIR` 已设且 legacy Redis 目录存在于旧路径时，shell 脚本在启动 `redis-server` 之前将整个目录 `mv` 到 `${DATA_DIR}/redis`。跨设备 fallback 使用 `cp -a` + `rm -rf`。
- **`.cat-cafe/` 状态**：当 `DATA_DIR` 已设时，shell 脚本将 `{projectRoot}/.cat-cafe/` 移动到 `${DATA_DIR}/cat-cafe/`，然后在原位创建指向新路径的 symlink（`ln -sfn`）。这样 50+ 消费方继续用 `resolve(projectRoot, '.cat-cafe', file)` 就透明地读写到新路径。跨设备同样 fallback 到 `cp -a` + `rm -rf`。

## 运行时迁移

如果首次启动迁移因磁盘紧张失败，腾出空间后可以不重启就重试：

```bash
# 只读：看当前布局和待迁移工作
curl -H "X-Cat-Cafe-User: $OWNER_ID" \
  http://localhost:3004/api/config/data-dirs

# 写：触发迁移（owner-only）
curl -XPOST -H "X-Cat-Cafe-User: $OWNER_ID" \
  http://localhost:3004/api/config/data-dirs/migrate
```

响应包含 `restartRecommended: true` 时务必重启服务 —— SQLite 等消费方在内存里持有的句柄仍然指向 legacy inode，需要重启才会重新打开到新路径。

## 部署 checklist

1. 确认目标卷有足够空间（建议 ≥ 当前 legacy 数据总量 × 2）
2. `.env` 加 `DATA_DIR` / `CACHE_DIR` / `LOG_DIR`（按需选择，可只设其中一个）
3. 重启服务 → 启动日志会输出 `[#671] Data-dirs migration completed`
4. 日志的 `movedCount` / `skippedCount` / `failedCount` 是迁移结果摘要；`abortedReason` 出现说明空间检查没过
5. 验证：`GET /api/config/data-dirs` 应该看到 `pendingMigration.hasWork: false`

## 注意

- **uploads 归 DATA_DIR**：虽然名义上像"缓存"，但里面是用户上传的真实文件，丢了就没了。issue 原稿曾把它放在 CACHE_DIR 下，最终决定归 DATA_DIR。
- **目标已有数据**：如果新根下对应位置已经有非空数据（例如部分迁移过 / 手动复制过），该条会被 `skipReason: target-not-empty` 跳过，避免覆盖。需要重新迁移就先手动清空目标。
- **环境变量优先级**：相对路径会用 `path.resolve()` 解析（相对 cwd），空字符串/纯空白视为未设置。
- **测试隔离**：测试代码原本通过 `process.env.AUDIT_LOG_DIR=tempDir` 等 legacy var 隔离写入。Phase 2 后改为 `process.env.DATA_DIR=tempDir`，audit/upload/transcripts 自动落到 `tempDir/{audit-logs,uploads,transcripts}`。读取时拼上子路径。

## 相关代码

- `packages/api/src/config/data-dirs.ts` — resolver + introspection
- `packages/api/src/config/data-dirs-migration.ts` — migration engine（排除 logs/redis/catCafeState — 它们由 shell 层迁移）
- `packages/api/src/index.ts` — 启动期接入
- `packages/api/src/routes/config.ts` — GET / POST 端点
- `scripts/start-dev.sh` — Redis DATA_DIR 集成 + shell 层迁移
- `scripts/user-redis.sh` — 个人 Redis DATA_DIR 集成
- `packages/api/test/data-dirs.test.js` — resolver 单测（34）
- `packages/api/test/data-dirs-migration.test.js` — migration 单测（19）
