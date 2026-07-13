---
feature_ids: [F048]
related_features: [F039, F194, F220]
topics: [restart, recovery, invocation, queue, redis, worklist, a2a]
doc_kind: note
created: 2026-02-28
---

# F048: Restart Recovery — 重启自愈（Invocation/Queue 恢复）

> **Status**: Phase A done / Phase A+ done / Phase B idea | **Owner**: Ragdoll → 金渐层（Phase A+）
> **Created**: 2026-02-28
> **Priority**: P1（Phase A+A+ 已交付）
> **Phase**: A ✅ / A+ ✅ / B idle

---

## Why

当前 Cat Café 的执行模型依赖外部子进程（例如 `codex` CLI）进行流式输出。API/runtime 一旦重启：
- **in-flight invocation 基本等于挂掉**（子进程/管道断开）
- 队列（InvocationQueue）目前是内存态，重启会丢失排队条目

这会导致用户体验不确定（“重启后发生了什么？”），也让后续做队列 Redis 持久化变成“只做一半会更诡异”的半能力。

## What

分两段交付（2026-03-06 三猫讨论决策）：

### Phase A — 启动收尸（轻量，correctness fix）

API 重启后，sweep Redis 里残留的 `running`/`queued` invocation records → 标为 `failed(error=process_restart)` → 清理对应 TaskProgress → 写 audit log。

**为什么现在就要做**：`InvocationRecordStore` 在有 Redis 时已是持久化的（`RedisInvocationRecordStore`，TTL 7 天）。执行开始后状态写成 `running`，如果 API 在终态前崩掉，record 会跨重启保留。retry 端点只允许 `failed/queued`，`running` 返回 409 → 用户看到"在跑"但永远不会结束，且无法 retry。

### Phase A+ — 用户可见通知（Phase A 的自然延伸，intake 自社区 PR #78）

Phase A 只做了后台清理（用户不可见），Phase A+ 补上用户可见层：sweep 完成后，给受影响的 thread 发可见错误消息。

**来源**：开源社区 clowder-ai PR #78 / Issue #77（bouillipx 提交）。手动 port 含两处修正。

### Phase B — 队列 + Worklist 持久化（重型，后做）

**InvocationQueue 持久化**（原有 scope）：
- `InvocationQueue` 迁到 Redis
- 重启后恢复排队条目并继续消费
- `processing` 条目回滚语义

**WorklistRegistry 持久化**（2026-07-13 scope 扩展，intake 自 F220 evidence handoff）：
- `WorklistRegistry`（`WorklistRegistry.ts:194`，module-level `new Map()`）迁到 Redis——与 InvocationQueue 同构问题，同构修法
- WorklistRegistry 管 A2A 串行 dispatch 的"下一棒是谁"，重启蒸发 = 静默丢弃已解析的 @mention target
- Boot reconcile：启动时检查 Redis 中残留的 worklist 条目，对未完成的串行链做 requeue 或 fail+通知
- `threadIndex`（`WorklistRegistry.ts:197`，reverse index `new Map()`）同步持久化

**Phase A+ 双重启边界 case**（2026-07-13 补充）：
- 快速连续重启（stop→start→stop→start）可能导致中间实例的 sweep 通知丢失——第一次 sweep 标 `failed` + 发通知，中间实例被杀，最终实例启动时 record 已是 `failed` 不再通知
- 需要验证 Phase A+ 通知的幂等性/持久性：sweep 后的通知是否一定落盘，还是可能随中间实例一起丢失

**实际案例**（2026-07-13 04:58 UTC）：
- Ragdoll opus turn `a272cb69` 在执行 `git commit && push` 的 tool_call 中被 graceful shutdown 杀死（Redis log 04:58:19 "bye bye"与 CLI transcript 04:58:15 最后事件对齐）
- 串行 worklist 中排队的 @sol dispatch 蒸发——sol 从未被触发，thread 静默 2h24m 无任何可见通知
- Fable 完整调查证据：thread `thread_mriwjlo1955spve4` 消息 `000096` + `000124`（Redis log + process table + transcript + git log 四方对齐）

## Acceptance Criteria — Phase A

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] 启动时 sweep：扫描 Redis 中 status=`running` 的 invocation records，标为 `failed`（error 含 `process_restart`）
- [x] 启动时 sweep：扫描 status=`queued` 且创建时间 > 阈值的 records，同样收敛
- [x] 清理对应的 TaskProgress 快照（避免前端恢复”幽灵进度”）
- [x] 写 audit log（orphan 数量、收敛结果）
- [x] retry 端点在 sweep 后能正常工作（status=`failed` → 可 retry）
- [x] 有测试覆盖：模拟 stale running record → 启动 sweep → 验证状态收敛

## Acceptance Criteria — Phase A+（用户通知，intake 自社区 PR #78）

- [x] AC-A+1: sweep 完成后，给每个受影响的 thread 发一条可见错误消息（列出被中断的猫猫）
- [x] AC-A+2: 消息持久化走 `source` 字段（如 `startup-reconciler`），不走 `catId: null`，确保 WS 和历史回放语义一致
- [x] AC-A+3: thread 级去重 — 同一 thread 的多个孤儿 invocation 合并为一条通知
- [x] AC-A+4: append/broadcast best-effort — 通知失败不影响启动主流程
- [x] AC-A+5: messageStore 和 socketManager 是 optional deps — memory mode 下正常跳过
- [x] AC-A+6: 有测试覆盖：模拟 sweep 后验证通知发送、去重、失败不阻塞

## Acceptance Criteria — Phase B（后续）

- [ ] AC-B1: 重启后：InvocationQueue 不丢（queued 条目可恢复）
- [ ] AC-B2: 不出现”双执行”（at-least-once + 去重）
- [ ] AC-B3: 前端清晰可见：哪些因重启被中断、哪些仍在队列
- [ ] AC-B4: 重启后：WorklistRegistry 串行链不丢——已解析的 @mention target 列表可恢复，未执行的 target 被 requeue 或 fail+通知（2026-07-13 新增）
- [ ] AC-B5: Phase A+ 双重启幂等性——快速连续重启后，受影响 thread 仍收到可见中断通知（2026-07-13 新增）

## Key Decisions

- **A/B 分段交付（2026-03-06 三猫讨论）**：不再坚持"要做就做完整体验"。Phase A 先补 correctness 缺口（启动收尸），Phase B 再做队列持久化
- **收尸策略用 `failed` 而非新增 `interrupted` 状态**：避免前端新增渲染分支，直接清除 TaskProgress 让前端回到"无进度"态。error 字段标注 `process_restart` 作为区分
- **不扫 ndjson 推断死亡**（否决旧分支 `fix/invocation-restart-guard` 的方案）：直接在启动时 sweep Redis stale records，更直接可靠
- **Phase A+ 持久化走 `source` 不走 `catId: null`**（2026-03-16 三猫 review 收敛）：因为历史接口 `messages.ts:956` 把 `catId=null && !source` 映射成 `user`，直接写库会导致刷新后变成"用户消息"。走 `source` 字段（如 `startup-reconciler`）则映射为 `connector`，语义正确

## Evidence（三猫讨论关键证据）

| 证据 | 位置 | 说明 |
|------|------|------|
| InvocationRecord 是 Redis 持久化 | `RedisInvocationRecordStore.ts` | 有 Redis 时用 Redis-backed store，TTL 7 天 |
| 执行时写 `running` | `messages.ts:~400` | status update 在执行开始时 |
| 启动无 reconcile | `index.ts:~467` | 启动流程只有 audit log + CLI config regen |
| retry 拒绝 `running` | `invocations.ts:76` | 只允许 `failed\|queued`，running → 409 |
| TaskProgress 也持久化 | `RedisTaskProgressStore.ts` | 前端恢复时会显示”幽灵进度” |
| InvocationQueue 是内存态 | `InvocationQueue.ts:38` | `private queues = new Map()`，重启丢失 |
| WorklistRegistry 是内存态 | `WorklistRegistry.ts:194` | module-level `new Map()`，A2A 串行 dispatch worklist，重启丢失（2026-07-13 补充） |
| threadIndex 是内存态 | `WorklistRegistry.ts:197` | reverse index `new Map()`，随 WorklistRegistry 一起丢失 |

## Ghost Branch Audit（2026-02-28 幽灵分支盘点）

| 分支 | 结论 | 说明 |
|------|------|------|
| `fix/invocation-restart-guard` | ❌ 不复活 | 方案不合理（扫 ndjson），但能力需要 → F048-A |
| `feat/f92-skills-lifecycle-hardening` | ✅ 已在 main | git cherry 确认等价，远端已删 |
| `feat/f98-session-query-tools` | ✅ 已在 main | 行为级核对确认，远端已删 |
| `feat/f97-connector-invoke` | ✅ 已在 main | 行为级核对确认，远端已删 |
| `feat/f032-agent-plugin-architecture` | ✅ 已在 main | 行为级核对确认，远端已删 |

## Risk / Blast Radius

- 风险：错误的恢复语义可能造成重复执行、状态错乱、用户困惑
- 缓解：明确语义（restart = cancel old + replay new），并用去重键/幂等保护

## Dependencies

- **Related**: F039（消息排队投递）
- **Cross-ref**: F220（A2A 可观测·可靠·可恢复）— WorklistRegistry 蒸发是 F220 "A2A 静默掉球" 的 infra 根因之一；Phase B 修复后 F220 的 restart 维度自动收口
- Redis（持久化、CAS、启动 reconcile）

## Review Gate

| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| R1→R5 | codex（本地） | 放行（P1×4 全修） | 2026-03-06 |
| R1→R2 | gpt52（本地） | 放行（P1×1 全修） | 2026-03-06 |
| R1 | codex（云端） | 1 P2（已修）| 2026-03-06 |
| Phase A+ R1 | codex（本地） | P1+P2 退回 | 2026-03-17 |
| Phase A+ R2 | codex（本地） | 放行（P1+P2 全修） | 2026-03-17 |
| Phase A+ R3 | codex（本地） | 放行（云审 P2 补丁确认） | 2026-03-17 |
| Phase A+ Cloud R1 | codex（云端） | 1 P2（已修） | 2026-03-17 |
| Phase A+ Cloud R2 | codex（云端） | 👍 通过 | 2026-03-17 |
