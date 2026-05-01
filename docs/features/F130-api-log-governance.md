---
feature_ids: [F130]
related_features: [F013, F045]
topics: [observability, infrastructure, logging]
doc_kind: spec
created: 2026-03-20
---

# F130: API 日志治理 — 四层分离 × 结构化落盘

> **Status**: done | **Completed**: 2026-03-20 | **Owner**: 金渐层 | **Reviewer**: Maine Coon | **Priority**: P1
>
> **Phase A merged**: PR [#600](https://github.com/zts212653/clowder-ai/pull/600) — `22e148ad` (2026-03-20)
> Reviewed by Maine Coon (gpt52) — 8 rounds. Closes [#594](https://github.com/zts212653/clowder-ai/issues/594).
> **Phase B+C merged**: PR [#601](https://github.com/zts212653/clowder-ai/pull/601) — `8e89df73` (2026-03-20)
> Reviewed by Maine Coon (gpt52) — 2 rounds. console.* 全量迁移 + logs:health 脚本。
>

## Why

team lead在排查飞书语音上传问题时发现（2026-03-20）：Fastify logger 只配了 stdout，没有 file transport。所有运行日志只在终端输出，terminal 关了就没了。一个多月裸奔。

Issue: [#594](https://github.com/zts212653/clowder-ai/issues/594)

实际病灶比 issue 描述更大：
- **Fastify logger**（pino）只有 stdout，无文件落盘（`index.ts` L182-186）
- **230 处 `console.log/error/warn`** 散布在 59 个文件中，完全绕过结构化日志
- **零 redaction** — API key、token 等敏感信息可能裸露在日志中
- 审计层（EventAuditLog）和取证层（CliRawArchive）一直在工作，真正缺的是 **运行日志层**

## What

### 日志四层架构（终态）

| 层 | 载体 | 保留期 | 职责 |
|---|---|---|---|
| 审计层 | `data/audit-logs/*.ndjson` | 90 天 | 关键业务事件，不可变（已有） |
| 取证层 | `data/cli-raw-internal-archive/` | 3-7 天 | CLI 原始事件重放（已有） |
| **运行层** | `data/logs/api/*.log` | 14 天 | **Pino 结构化 runtime log（新增）** |
| **进程层** | `data/logs/process/` | 7 天 | **start-dev.sh stderr capture + 未迁移 console 兜底（新增）** |

### Phase A: 止血 — Runtime Log 落盘

最小可交付的止血 PR：

1. **新建 `packages/api/src/infrastructure/logger.ts`** — 自建 Pino 实例
   - stdout + pino-roll file transport 双写
   - `pino-roll` 按天轮转，14 天保留
   - 日志落盘到 `data/logs/api/`
   - Redaction 配置（authorization, cookie, token, apiKey, secret 等）
   - LOG_LEVEL 环境变量支持

2. **改 `packages/api/src/index.ts`** — 传自建 logger 给 Fastify
   ```ts
   const app = Fastify({ logger: customLogger });
   ```

3. **改 `scripts/start-dev.sh`** — 进程层 stderr capture + 未迁移 console 兜底
   - stderr 落盘到 `data/logs/process/`，接住 tsx watch 输出、crash dump、初始化前异常
   - 未迁移的 `console.*` 通过 monkey-patch 重定向到 stderr，确保进程层兜底
   - 不使用 `tee` 管道（macOS bash 下所有 tee 方案均会产生孤儿进程，破坏 `kill $(jobs -p)` 清理）

4. **迁移 4 个核心模块的 `console.*`**：
   - `EventAuditLog.ts` — 去掉审计后多余的 console echo
   - `invoke-single-cat.ts` — 猫猫调用全链路（16 处）
   - `route-serial.ts` / `route-parallel.ts` — 路由编排（17+15 处）
   - `SocketManager.ts` — WebSocket 状态（8 处）

5. **安装依赖** — `pino-roll`（mcollina 维护的 pino 官方轮转 transport）

### Phase B: 统一 — Console 收编 + Logger 工厂

1. `packages/shared` 新建 `createLogger()` 工厂函数（底层 pino）
2. 剩余 `console.*` 逐步迁移（api 包约 80 处）
3. ESLint `no-console` rule（api 包内）
4. **MCP server 不改**（stdio transport 必须用 stderr）

### Phase C: 护栏 — 治理自动化

1. `pnpm logs:health` 脚本（磁盘占用、保留期检查、异常量告警）
2. 日志路径暴露到 config summary
3. `signals-in-app.log` 归位或删除（伪日志→业务 artifact）

## Acceptance Criteria

### Phase A（止血）✅
- [x] AC-A1: Fastify 使用自建 Pino 实例，stdout + file 双写
- [x] AC-A2: 运行日志落盘到 `data/logs/api/`，按天轮转，14 天保留
- [x] AC-A3: Pino redaction 配置覆盖敏感字段（authorization, cookie, token, apiKey, secret）
- [x] AC-A4: start-dev.sh 进程层 stderr 独立落盘到 `data/logs/process/`（含未迁移 console 兜底）
- [x] AC-A5: EventAuditLog 不再 console.log echo（审计层和运行层分离）
- [x] AC-A6: invoke-single-cat, route-serial, route-parallel, SocketManager 迁移到 logger
- [x] AC-A7: LOG_LEVEL 环境变量控制日志级别（默认 info）
- [x] AC-A8: 重启 API 后验证日志文件正确生成

### Phase B（统一）✅
- [x] AC-B1: api 包 `createModuleLogger()` 工厂已可用（logger.ts 导出）
- [x] AC-B2: api 包 console.* 全部迁移完成（89 处，仅保留 1 处 fatal handler + 4 处 bridge-script 浏览器代码）
- [ ] ~~AC-B3: ESLint no-console rule~~ — 项目无 ESLint 配置，Biome 替代，留待后续

### Phase C（护栏）✅
- [x] AC-C1: `pnpm logs:health` 脚本检查四层日志大小、保留期、错误量
- [x] AC-C2: logs:health 输出 config summary（LOG_LEVEL + 各层路径）

## Dependencies

- **Related**: F013（Audit Log v2 — 审计层已建立）
- **Related**: F045（NDJSON Observability — 同属可观测性领域）
- **Related**: LL-022（治理基线必须脚本化）

## Risk

| 风险 | 缓解 |
|------|------|
| pino-roll 在 worker thread 中写文件，崩溃时可能丢最后几条 | 进程层 capture 作为外层保险 |
| Phase A 未迁移的 ~80 处 console.log 无文件持久化 | monkey-patch console 到 stderr 兜底；Phase B 全量迁移后 gap 归零 |
| Phase A console 迁移范围膨胀 | 严格控制只迁 4 个核心模块，其余留 Phase B |
| Redaction 遗漏导致敏感信息落盘 | Phase C 补充审计脚本扫描日志文件 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 自建 Pino 实例传给 Fastify，不用 Fastify logger option | 更灵活，Fastify 外部也能用（启动/shutdown/后台任务） | 2026-03-20 |
| KD-2 | 四层分离（审计/取证/运行/进程），不合并 | 每层职责不同、保留期不同、格式不同 | 2026-03-20 |
| KD-3 | 进程层 capture 是长期外层保险，不是脚手架 | 接住 tsx watch 输出、初始化前异常、未迁移 console（systemd journal 类比） | 2026-03-20 |
| KD-4 | Phase A 范围严格控制，不做热路径大扫除 | 止血 PR 要 review 友好，大量 console 迁移留 Phase B | 2026-03-20 |
| KD-5 | Redaction 必须随 Phase A 同步上线 | 日志落盘等于把泄露面从终端复制到磁盘，必须同步脱敏 | 2026-03-20 |
| KD-6 | MCP server 保留 console.error | stdio transport 协议要求，stderr 是 MCP 的正确日志通道 | 2026-03-20 |
| KD-7 | 进程层只做 stderr redirect（不用 tee pipeline） | macOS bash 下 `cmd \| tee` / `> >(tee)` / `exec > >(tee)` 均产生孤儿进程，`kill $(jobs -p)` 无法清理。Pino stdout transport 已覆盖结构化日志的终端+文件双写；未迁移 console.* 通过 monkey-patch 重定向到 stderr 兜底。Phase B 全量迁移后 gap 归零 | 2026-03-21 |

## Review Gate

- Phase A: Maine Coon(gpt52) review — 8 rounds, all resolved
- Phase B/C: Maine Coon(gpt52) review — 2 rounds, all resolved

## 代码审计摘要

### 现有 Fastify logger 配置
```typescript
// packages/api/src/index.ts L182-186
const app = Fastify({
  logger: {
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  },
});
```

### console.* 分布（迁移后）
- `packages/api/src`: 1 处（fatal handler，保留）+ 6 处 logger.ts monkey-patch + 4 处 bridge-script（浏览器注入）
- `packages/mcp-server`: 13 处（stdio 协议，保留）
- `packages/web`: ~30 处（前端，不在范围）
- `scripts/`: ~17 处（独立脚本，保留）

### 已有落盘链路
- 审计层: `data/audit-logs/*.ndjson`（EventAuditLog，按天分片）
- 取证层: `data/cli-raw-internal-archive/YYYY-MM-DD/*.ndjson`（CliRawArchive，按 invocation 分片）
- 运行层: ❌ **缺失（本 Feature 补建）**
- 进程层: ❌ **缺失（本 Feature 补建）**
