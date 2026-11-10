---
feature_ids: [F048]
related_features: [F039, F194]
topics: [restart, recovery, invocation, queue, redis]
doc_kind: note
created: 2026-02-28
---

# F048: Restart Recovery — 重启自愈（Invocation/Queue 恢复）

> **Status**: Phase A done / Phase A+ done / Phase B idea / Phase C in progress | **Owner**: Ragdoll → 金渐层（Phase A+）→ Ragdoll（@opus55，Phase C）
> **Created**: 2026-02-28
> **Priority**: P1（Phase A+A+ 已交付）
> **Phase**: A ✅ / A+ ✅ / B idle / C 🚧（代码已合入 #6873，等首次重启实测 AC-C7）

---

## Why

当前 Clowder AI 的执行模型依赖外部子进程（例如 `codex` CLI）进行流式输出。API/runtime 一旦重启：
- **in-flight invocation 基本等于挂掉**（子进程/管道断开）
- 队列（InvocationQueue）目前是内存态，重启会丢失排队条目

这会导致用户体验不确定（“重启后发生了什么？”），也让后续做队列 Redis 持久化变成“只做一半会更诡异”的半能力。

## What

### 重启后继续原工作

更新并重启到包含 Phase C 的版本后，被这次重启中断的猫会在原对话收到一条续做消息，
并从原任务和执行记录接着核对。主人不需要为每只猫重新创建任务；没有续做消息时，
先查看原对话的实际状态，再明确请原负责人继续。

主动停止、仍有进程保护、已在等待或处理队列、守望猫，以及连续被重启打断的自动续做，
不会再次自动叫回。续做不会复活上一轮已退役的会话授权。本阶段仍保留 AC-C7 的首次
实际重启验收缺口，不能把源码合入说成当前运行版本已经完成恢复验证。

分两段交付（2026-03-06 三猫讨论决策）：

### Phase A — 启动收尸（轻量，correctness fix）

API 重启后，sweep Redis 里残留的 `running`/`queued` invocation records → 标为 `failed(error=process_restart)` → 清理对应 TaskProgress → 写 audit log。

**为什么现在就要做**：`InvocationRecordStore` 在有 Redis 时已是持久化的（`RedisInvocationRecordStore`，TTL 7 天）。执行开始后状态写成 `running`，如果 API 在终态前崩掉，record 会跨重启保留。retry 端点只允许 `failed/queued`，`running` 返回 409 → 用户看到"在跑"但永远不会结束，且无法 retry。

### Phase A+ — 用户可见通知（Phase A 的自然延伸，intake 自社区 PR #78）

Phase A 只做了后台清理（用户不可见），Phase A+ 补上用户可见层：sweep 完成后，给受影响的 thread 发可见错误消息。

**来源**：开源社区 clowder-ai PR #78 / Issue #77（bouillipx 提交）。手动 port 含两处修正。

> **2026-11-09 按 main 核对（Ragdoll/opus55）**：A+ 的线程提示自 2026-10-15 #5576 起不再发送（`StartupReconciler.ts` 中 `notifiedThreads = 0`，注释说明恢复不再另发聊天提示）。现在改由 `TurnExecutionStartupReconciler` 把被打断的执行标成 `process_restart`，被打断的那条回复自己收尾成中断状态。下方 AC-A+ 的勾选记录的是 2026-03 交付时的状态，本次不改勾选。
> 重启后自动把被打断的猫叫回来接着做，见下方 Phase C。

### Phase B — 队列持久化（重型，后做）

- `InvocationQueue` 迁到 Redis
- 重启后恢复排队条目并继续消费
- `processing` 条目回滚语义

### Phase C — 重启后自动叫回被打断的猫

**要解决的事**：现在几乎随时都有猫在跑。每次重启（不管是计划内的，还是崩了），You 都得先记下谁在跑，重启后再叫一只猫挨个喊「可以继续了」。几十次下来没丢过事，因为猫能读聊天记录和记忆接着做。所以只需要把他手动做的第二步自动化。

**做法**：启动收尾已经会把被这次重启打断的执行统一标成 `process_restart`，计划内重启和崩溃都一样。在队列恢复之后，按（线程，猫）去重，给每只被打断的猫在原线程投递一条续做消息并叫醒它。投递走家里统一的消息加队列入口（`deliverConnectorMessage` → `PersistedQueueDelivery`），消息作者是 `system:restart-recovery`，在线程里可见。

**权限**：续做那一轮按 `ownerAuthProvenance: 'unknown'`、不带工具限制运行，跟普通定时提醒叫醒的猫一样。被打断那一轮的回调授权在启动收尾时已经退役，按 ADR-042 的规则不能复活，所以这里不继承它。和 You 手动喊继续相比，少的是只给严格认证用户的几项能力（例如事情目录的自动注入）；如果实际用下来不够，再考虑在执行还活着时就把授权封存下来。

**明确不做**：不拦消息、不冻结准入、不改排队、不碰定时任务和插件；重启前不需要任何准备步骤；不证明「全部停稳」；不存进度存档；不改谁有权重启（ADR-039 照旧）；不做错开唤醒或并发控制。F323 Phase B 撤回（#5201）的那一套，这里一样都不碰。

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

- [ ] 重启后：队列不丢（queued 条目可恢复）
- [ ] 不出现”双执行”（at-least-once + 去重）
- [ ] 前端清晰可见：哪些因重启被中断、哪些仍在队列

## Acceptance Criteria — Phase C（重启后自动叫回被打断的猫）

- [x] AC-C1: 启动收尾后，这次被标成 `process_restart` 的每个执行，都按（线程，猫）给那只猫在原线程投递一条续做消息，并经由队列叫醒它；消息在线程里可见，作者为 `system:restart-recovery`。
- [x] AC-C2: 幂等：投递键由被打断的那个执行决定，启动收尾重跑或投递重试都不会产生第二条。
- [x] AC-C3: 以下情况不叫：主动停掉的（终态原因不是 `process_restart`）；进程还活着、启动时受保护的；守望猫；同一线程里已有发给这只猫、正在等待或正在处理的队列项。
- [x] AC-C4: 防循环：如果被打断的那一轮本身就是由续做消息触发的（同一只猫连续两次被重启打断），不再自动叫回，只记日志。这是为了避免「猫的操作把 runtime 弄崩 → 自动叫回 → 又弄崩」的死循环。
- [x] AC-C5: 尽力而为：某一条投递失败只记日志，不影响启动，也不影响其他猫。
- [x] AC-C6: 续做那一轮的权限是 `ownerAuthProvenance: 'unknown'`、不带工具限制，不复活已退役的授权。
- [ ] AC-C7: 真实验收：合入后第一次 runtime 重启（激活本改动那次）时，当时在跑的猫都在原线程收到续做消息并接着干，You 不需要做任何事；被手动停掉的猫不被叫回。

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
