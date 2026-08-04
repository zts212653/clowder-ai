---
feature_ids: [F288]
related_features: [F088, F202, F240]
topics: [plugin, messaging, envelope, event-stream, idempotency]
doc_kind: spec
created: 2026-07-14
tips_exempt: K-1 establishes the kernel contract; the user-facing broker and configuration surface belong to K-2
---

# F288: Plugin Messaging Domain（K-1 messaging 域收敛）

**Status:** IMPLEMENTING（direction accepted #1271; PR #1270 in review）
**Lineage:** F240（IM connector plugins）→ plugins v0 proposal
**真相源:** `zts212653/clowder-ai-plugins` main `189f25d` — `docs/proposals/plugin-system-principles-and-v0-design.md` §3.1；issue #1 roadmap comment `#issuecomment-4969779486` 的 PR-2（K-1）。C-1 契约包 `@clowder-ai/plugin-contract@0.1.0-beta.5` 已发布，以精确版本+digest 为准。

## 一句话

内核提供 plugin-facing messaging 域：一个内容模型（MessagePayload），一个发送入口（`messaging.send(draft)`），两类可靠事件（`message.publish` / `message.elements.append`），幂等结算 ledger 与 durable ack cursor。

## User Journey

**Scope unit:** 一个 plugin instance 通过一个宿主签发的 ThreadHandle 操作一个 thread；每个订阅只绑定这个 handle，不跨 thread 共用 sequence。

**Primary journey（plugin developer）:**

1. 宿主给插件签发带发送/订阅权限的 ThreadHandle；插件不接触裸 threadId。
2. 插件用一个 `messaging.send(draft)` 发送文本、媒体引用或 rich block，并拿到可安全重试的同一 receipt。
3. 插件订阅该 handle，按 sequence 读取 output events；处理成功后 ack，未 ack 的事件可重投。
4. cursor 落后 retention 窗口时，插件收到明确 stale 状态，先取 snapshot，再从返回的 resume sequence 恢复实时读取。
5. 插件用 `messaging.appendElements` 给自己已发送的消息原子增补元素；重复 operationId 不重复追加，provenance 不会被增补洗白。

**Failure journey:** handle 被撤销、跨实例复用、越权 whisper、跨 thread reply、revision 冲突或非法 provenance 均 fail-closed，并返回稳定错误码；不会退化成裸 threadId 或静默跳过事件。

## 范围（§3.1 五件套）

1. **send 收敛**：`sendReply/sendRichMessage/sendMedia` 在插件契约面收敛为 `messaging.send(draft)`，返回宿主 receipt；同 idempotencyKey 重试返回同一 receipt。平台降级（卡片→纯文本等）仍归 connector adapter（不在本 PR）。
2. **canonical MessageEnvelope + ingress binding**：宿主接受 draft 后生成 canonical envelope（actor 宿主绑定、audience 宿主派生、`system` 仅宿主可产生、occurredAt UTC）。Draft 寻址只能用宿主签发的 `ThreadHandle`/`ConnectorBindingRef`——schema 层面不存在自报裸 threadId 的通道。
3. **事件流**：per-thread 单调 sequence；cursor = 每消费者（pluginInstanceId × subscription）durable ack；未 ack 至少一次投递 + 消费者凭 eventId 幂等；cursor 是 subscription-local opaque token；落后超出 retention 窗口 → stale 态走快照追平，不静默丢事件。
4. **appendElements**：原子增补；目标必须是宿主签发的 `MessageHandle`，且原寻址 handle 仍存活；`derivedFromElementId` 指向稳定 elementId；不改写原文；不把 `inference` 升格为 `observation/user_intent`；`baseRevision` 并发冲突检测。
5. **幂等结算 ledger**：send 键 =(pluginInstanceId, idempotencyKey)、append 键 =(pluginInstanceId, messageId, operationId)；实例作用域，插件间互不干扰，重装实例不复用旧键空间。

## 明确非目标

- Broker/握手/transport（K-2）、SDK（P-1）、存量 connector 迁移（P-7）、事件输入面（K-3a）、windows（K-3b）、schedule/state（K-5）
- `OutboundDeliveryHook` / `ConnectorRouter` / 现有三 send 呼叫点零改动
- user/cat 消息全量进事件流（K-1 只发射本域操作事件；全量覆盖待 P-7 出站消费者出现）
- cursor token 密码学签名（v0 不透明性是契约约束；跨 subscription 拒绝由服务端校验保证）

## 架构

```
packages/api/src/domains/messaging/
├── contract/host-types.ts  # host-side type definitions + MessagingError
├── contract/validate.ts   # fail-closed 校验 + bounds
├── envelope.ts            # StoredMessage ↔ MessageEnvelope 纯投影（零第二真相源）
├── handles.ts / ledger.ts / event-stream.ts / send-service.ts / append-service.ts
├── append-output.ts       # durable append outbox + lease-fenced emission state machine
├── append-elements.ts     # append 元素盖章、派生与累计 payload 约束
├── messaging-service.ts   # Facade —— K-2 Broker 的消费面
└── stores/                # memory + Redis 双实现（plugmsg:* keys）
```

**K-2 接缝**：本 PR 不在组合根实例化 domain——`createMessagingDomain({ messageStore, redis })` 就是 K-2 Host Broker 的装配点（roadmap 五步回边：K-1 merge → K-2 消费）。端到端行为由域测试全链覆盖（facade e2e：issue→send→subscribe→read→ack→append→snapshot）。

**关键设计决定**：
- **D-1** envelope = `StoredMessage` 纯投影；插件消息通过现有 `IMessageStore` 暴露为逻辑 `extra.pluginMessage` additive 扩展，Redis 内与宿主 `extra` 分字段持久化，避免双方并发更新互相覆盖；Hub UI 免费获得展示。
- **D-2** v0 subscription 绑定单 ThreadHandle；多 thread = 多 subscription——"不得以单一 sequence 跨 thread 推游标"由构造保证。
- **D-3** persist → emit → settle 顺序；事件 emit 以确定性 eventKey 在 retention 窗口内去重。窗口外 crash-retry 可能以同一 eventId 再投递，语义是 at-least-once，消费者继续凭 eventId 幂等；不声称永久 exactly-once。append 的持久 `appendOps` 同时作为小型 outbox：锁租约接管者在写入新 revision 前按 revision 顺序补齐已落库的前驱事件。其扁平 element IDs 必须按序精确等于 canonical elements 的 appended suffix；每个 suffix element 都带 writer 盖章，present `baseRevision` 精确等于前一 revision。append event insertion 必须携带当前 `AppendLease`；Memory 在同步临界区、Redis 在同一 Lua 中校验 token 后才分配 sequence，从而阻止 stale holder 在 rev3 后新增 rev2。`outputRevision/outputSequence` 每次只前进一个连续 revision。snapshot 先以 canonical projection 确定 current-state 可见集合，再以 `head-before → 完整 thread scan → head-after` 建稳定 fence，并只纳入 output watermark 已落在 fence 内的可见 revision；竞态三次仍不稳定则返回 `RETRYABLE_INFLIGHT`，不截断、不返回半快照。删除/tombstone 不属于 current snapshot，历史 event replay 语义保持独立。**Plugin-owned domain fence（#1269）**：plugin event cursors 与 host visibility cursors 有意不可比较；snapshot 只纳入 plugin-owned messages（由 `pluginMessage` 独立字段实体化），host-side visibility 变更不能突破插件域边界。
- **D-4** provenance.origin 宿主校验绑定：thread_handle 发送 origin 必为 self plugin；connector_binding 发送 origin.external 必须与 binding 记录一致；`host` origin 任何 draft 不可声明。
- **D-5** send 成功后持久化 MessageHandle 记录（opaque `mh_` prefixed token — 不等于 messageId, #1165），绑定 plugin instance、message、thread 与原 address handle；`SendReceipt.handle` 返回该 capability，消费者只能通过 receipt 获得它。append 在 claim ledger 前同时解析 MessageHandle 和仍存活、且 `canSubscribe=true` 的 parent handle，撤销任一层或 send-only grant 都 fail-closed。
- **whisper 边界（fail-closed）**：v0 事件流与 snapshot 只投递 public 消息；whisper 是 send-only 能力（targets ⊆ handle grant 允许集）。消费者可观察到 sequence 跳号（受限事件），单调性不受影响。
- **mentions**：v0 插件消息不解析/不触发 @ 路由（唤醒能力归 K-3a wake route）。

## 不变量（全部有对应测试）

INV-1 幂等 receipt 恒等；INV-2 system audience 双层不可达；INV-3 per-thread sequence 严格单调；INV-4 未 ack 重投/已 ack 不重投；INV-5 cursor token subscription-local；INV-6 append 不改写原文；INV-7 epistemic 不洗白（非 inference 增补必须 derivedFrom 同状态源）；INV-8 handle 跨实例/revoked 拒绝（含 MessageHandle→parent address handle 撤销链）；INV-9 落后窗口 → stale 不静默丢；INV-10 baseRevision 冲突零变更；INV-11 存量消息路径零回归；INV-12 append 幂等不重复追加；INV-13 append 的 live parent grant 必须可订阅；INV-14 lease 校验与 append event insertion 原子；INV-15 output watermark 逐 revision 连续前进；INV-16 successor 先补齐所有 predecessor output；INV-17 snapshot revN 后不出现更晚的旧 revision；INV-18 fenced holder 未被 canonical output 覆盖时不得 settle；INV-19 canonical hydration closed + bounded，append history 按序精确重建 stamped suffix；INV-20 media/rich payload 保持契约要求的 open object；INV-21 `getOrCreateMessageHandle` validates the full immutable binding tuple (kind, messageId, pluginInstanceId, parentHandleId, threadId, userId) before returning any indexed record — any field mismatch fails closed；INV-22 Memory and Redis `getOrCreateMessageHandle` are behaviorally identical: same inputs → same outcome (create/return/reject)；INV-23 wrong-kind indexed record (kind ≠ message_handle) fails closed (throws), never silently falls through to create.

## MessageHandle Authority Binding (INV-21 — INV-23)

A `MessageHandle` is an opaque host-issued capability (`mh_`-prefixed) that binds a plugin's send receipt to its message. The handle's **immutable binding tuple** is fixed at mint time and never changes:

```
(kind, messageId, pluginInstanceId, parentHandleId, threadId, userId)
```

`scope` is derived from the parent address handle at issuance and implied by `parentHandleId` — same parent record → same scope.

### Lifecycle

```
candidate record (HandleService.ensureMessageHandle)
  → getOrCreateMessageHandle (atomic: Memory sync critical section / Redis Lua)
    → [index miss]         CREATE:  persist record + reverse index → return (created=true)
    → [index hit, found]   VALIDATE full binding → return (created=false)
    → [index hit, missing] RECOVER: persist new record, overwrite index → return (created=true)
    → [index hit, mismatch] REJECT: throw (fail-closed)
```

HandleService.ensureMessageHandle wraps store-level rejections as `MessagingError('CONFLICT')`.

### Fail-Closed Validation Matrix

`getOrCreateMessageHandle` validates the full immutable binding before returning any existing record. Memory and Redis produce identical results for the same inputs (INV-22).

| # | Resolution path | Behavior | Error |
|---|---|---|---|
| M1 | Index hit, all fields match | Return existing record (idempotent) | — |
| M2 | Index hit, `kind ≠ message_handle` | Throw | index corruption (INV-23) |
| M3 | Index hit, `messageId` mismatch | Throw | index corruption |
| M4 | Index hit, `pluginInstanceId` mismatch | Throw | binding violation |
| M5 | Index hit, `parentHandleId` mismatch | Throw | binding violation |
| M6 | Index hit, `threadId` mismatch | Throw | binding violation |
| M7 | Index hit, `userId` mismatch | Throw | binding violation |
| M8 | Index miss (no entry) | Create new record | — |
| M9 | Index hit, record missing | Create new record (recovery) | — |

Atomicity boundary: Memory uses a synchronous critical section (no awaits between check and write). Redis uses a Lua script for index check + record create; TypeScript validates remaining binding fields (M4–M7) before returning the record to the caller.

Test anchor: `plugin-messaging-handle-binding.test.js` — one test per matrix row, both Memory and Redis.

## C-1 契约对齐点

Published: `@clowder-ai/plugin-contract@0.1.0-beta.5`。epistemic 值集 `observation|user_intent|inference`；element kinds v0 `text|media_ref|rich_block`；bounds（每 read 最多 32 events、每 envelope 最多 32 elements、64KB/element、256KB 总 payload、16 whisper targets）；错误码 `VALIDATION|PERMISSION|NOT_FOUND|CONFLICT|RETRYABLE_INFLIGHT|STALE_CURSOR`；receipt/subscribe/read/ack/snapshot API 形状；所有 closed input object 拒绝 unknown fields，whisper targets 去重。

## Ownership map delta（建议）

新增 cell `plugin-messaging`（K-1 起草，maintainer 定夺）：plugin-facing messaging 契约面。现有 transport cell（F088）继续持有 connector 出入站与平台降级。

## Quality Gate Report（review-ready）

**检查时间:** 2026-08-04（Asia/Shanghai）

**工作树:** feature checkout（branch `feat/k1-messaging-domain`）

**基线:** `upstream/main@ffa73bb8f`

**状态边界:** K-1 实现处于 PR review 迭代中（PR #1270 OPEN on base `ffa73bb8f`）。C-1 已发布 `@clowder-ai/plugin-contract@0.1.0-beta.5`。

### 愿景与五件套验收

| # | 原始需求 / AC | 状态 | 实现锚点 | 验证锚点 |
|---|---|---|---|---|
| 1 | 三类发送收敛为 `messaging.send(draft)`，同 key receipt 恒等 | ✅ | `send-service.ts`, `messaging-service.ts` | `plugin-messaging-send.test.js`, facade e2e |
| 2 | canonical envelope + 宿主签发 handle/binding，无裸 threadId 通道 | ✅ | `envelope.ts`, `handles.ts`, `contract/validate.ts` | envelope/handles/validate suites |
| 3 | per-thread 单调事件流 + durable ack + stale/snapshot | ✅ | `event-stream.ts`, memory/Redis event+cursor stores | event-log/event-stream/Redis suites |
| 4 | 原子 `appendElements` + revision/CAS + provenance 不洗白 | ✅ | `append-service.ts`, `MessageStore` CAS | append suite（含 lease takeover 乱序回归） |
| 5 | send/append 实例域幂等 ledger | ✅ | `ledger.ts`, memory/Redis ledger stores | ledger + Redis suites |

交付完整性：K-1 是可被 K-2 扩展消费的完整 domain slice；没有需要推倒重写的占位实现。Host Broker 装配面保持为 `createMessagingDomain(...)`。

### Fresh-context / Terra R1-R3 findings（均已关闭，待 Terra 复验）

1. trace 字段在持久化/投影中丢失。
2. retention trim 与 `read()` 竞态可静默跳事件。
3. snapshot 的 head/message 并行读取可越过未纳入快照的消息。
4. append 锁租约过期时旧写者可覆盖后继 revision；改为 revision CAS。
5. ledger 无 owner token 时旧 claimant 可释放/结算后继 claim。
6. Redis `pluginMessage` 白名单解析会丢字段且浅校验；统一严格 fail-closed parser。
7. append crash replay 在事件被 trim 后可能用重试输入改写相同 eventId 的 `baseRevision`；持久化原始值。
8. append 写入后、事件发射前锁租约接管会造成 revision 事件乱序；以持久 `appendOps` outbox repair 修复。RED 稳定复现 `op-2/rev3 → op-1/rev2`，GREEN 为正确顺序。
9. append 接受裸 `messageId`，可绕过父 handle 撤销；改为宿主签发 MessageHandle + parent handle 双重存活解析。
10. snapshot 可能纳入 fence 之后才完成输出的消息，且固定 200 条截断会静默漏历史；改为 canonical output watermark + 完整扫描 + 双 head 稳定 fence。
11. K-1 手写 mirror 相对 C-1 candidate 漂移；closed-object/whisper uniqueItems 已 fail-closed，read 与 envelope element 上限统一为 32。
12. soft-delete 发生在 publish/append watermark 完成前会让 snapshot 永久 `RETRYABLE_INFLIGHT`；改为先用 canonical projection 派生最终可见集合，只对实际可返回 envelope 检查 output watermark。
13. send-only parent handle 仍可 append；`resolveForAppend()` 现在要求 live parent `canSubscribe=true`，并在 ledger claim 前拒绝。
14. outbox/watermark 仍允许 stale emitter 在 successor rev3 与 retention trim 后新增 rev2；append event insertion 现在由 current lease 原子 fencing，fenced write 不消耗 sequence，watermark 逐 revision 前进。
15. Redis hydration parser 仍接受 unknown fields、33 elements 与 duplicate IDs；memory/Redis 现在共享同一 closed/bounded canonical parser，且无 permissive fallback。
16. strict hydration 只校验 append-op 引用已知且不重复，未证明它按序覆盖实际 appended suffix；parser 现在逐 operation 消费 canonical suffix，同时核验 writer 的 element stamp、operation 前置 derivation 与 present `baseRevision = producedRevision - 1`。

诊断记录：`docs/bug-report/redis-plugin-message-array-collapse/bug-report.md`、`docs/bug-report/append-event-order-after-lock-expiry/bug-report.md`。

### Dogfood-Your-Slice

Scope verdict: ✅ 必做（plugin developer 可感知的 kernel contract）

真实路径：issue handle → subscribe → send → read → ack → append → read → snapshot → send replay → append replay → Hub content。

结果：11 步全部通过，使用仓库官方 isolated Redis runner；临时 dogfood 脚本已删除，未残留测试工件。

发现并修复：Redis 独立字段回读、replyTo 同 thread/存在性校验，以及上述 fresh-context 竞态。

### 验证证据

| 命令 / 检查 | 结果 |
|---|---|
| K-1 非 Redis 定向套件 | 195/195 pass ✅（R5: +11 binding matrix; R6: +6 stale-claimant + 2 scope; R7: +1 whisper mutation defense） |
| 官方 isolated Redis 定向套件 | 18/18 pass ✅ + 8 binding matrix tests（runner 分配非保留随机端口，DB 15） |
| R2 三项 Red → Green | send-only append、snapshot rev3 后新增 rev2、strict hydration 均精确 RED；聚焦 GREEN 25/25 ✅ |
| R3 append-history Red → Green | Terra 最小反例在 envelope suite 精确 10/11 RED → 11/11 GREEN；append replay + memory/Redis parser consumer 21/21 ✅ |
| `pnpm check` | K-1 files clean；pre-existing upstream feature-truth warnings (F237/F247/F251) cause non-zero exit — no F288-specific issues |
| `pnpm lint` | exit 0 ✅；仅存量 web warnings |
| `pnpm -r --if-present run build` | exit 0 ✅ |
| `git diff --check` | exit 0 ✅ |
| `pnpm test` | exit 1：upstream 镜像的 fork-only 脚本/文档/capability 等已知基线失败；接管前 branch/base failing-set 对照全等，最终运行未出现 K-1 failure |
| `pnpm --filter @cat-cafe/api test:redis` | exit 1：该命令在 isolated Redis 下运行完整 API 套件，仍命中同组 upstream/fork 基线失败；K-1 Redis 定向 18/18 独立全绿 |

### 机械门禁与 reviewer focus

- `.pen` 匹配：无；UI diff：无；设计稿对照不适用。
- 根目录媒体/设计工件（工作树 + 已提交差异）：无。
- PR：#1270 OPEN on `zts212653/clowder-ai`（base `ffa73bb8f`）。Review rounds: R1-R6 complete, currently in R7.
- ≥3 轮 state-object gate：(1) append output 连续复发→已提交 `feature-specs/2026-07-16-k1-r2-emission-fencing.md`。(2) MessageHandle authority binding R2/R3/R4 连续 P1→R5 spec-first: INV-21/22/23 + validation matrix (本文件§MessageHandle Authority Binding)→矩阵驱动 adversarial tests + Memory/Redis 行为对齐。(3) Service-level stale-claimant settlement coverage R4/R5→R6: service-level tests with InterceptingLedgerStore exercising real SendService/AppendService settlement branches。
- R2+ failure-mode sweep：从 append history 的 writer/parser 漂移抽象出 ordered-suffix invariant，并扫描 `baseRevision`、element stamping、operation-local derivation、memory/Redis 两个 consumer；均已纳入单一 parser 与回归表。
- `check-hotfix-pattern.mjs`、`check-fallback-layers.mjs` 与 `check:architecture-ownership` 在 upstream 公开 checkout 不存在；已手工等效检查：无 hotfix 语义、无同文件新增三层 fallback。
- 350 行硬限：append output coordinator 与 strict parser helpers 按单一职责拆分；K-1 本轮 source/test 单文件最大 349 行 ✅。
- upstream delta：PR base `ffa73bb8f` vs current `upstream/main` — 1 Web-only commit (HubCatEditor), no messaging overlap。
- Architecture cell：建议新增 `plugin-messaging`；ownership map 尚未更新，留给 reviewer/maintainer 判定（warning-only）。
- 编号：F288 由 maintainer 在 #1271 direction verdict §3 正式分配（`fdf351a54` 注册）。

[宪宪/Claude Opus 4.6🐾, initial quality gate by 砚砚/GPT-5.6 Sol🐾]
