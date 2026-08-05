---
feature_ids: [F254]
related_features: [F233, F167, F069, F193, F086, F108, F117, F039, F118, F212, F244, F264]
related_decisions: [040, 041, 042]
topics: [freshness, glass-box, supplement, inbox-notice, runtime-descriptor, side-effect-gate, codex-app-server, lifecycle, liveness, ax]
doc_kind: spec
created: 2026-06-27
updated: 2026-08-04
tips_exempt: true
---

# F254: Side-Effect Freshness Gate — 副作用出口 freshness 拦截

> **Status**: in-progress, **D2 live app-server canary lifecycle/parity hardening + E-C complete** (**ADR-042 glass-box publish-then-supplement merged via PR #2906 (`ace5412c0`); durable Queue custody / migration / replayable `eval:freshness` merged via PR #2912 (`07f46f5aa`); D2 default-off provider-native carrier merged via PR #3004 (`680ab702f`); typed causal provenance + durable child lifecycle merged via PR #3036 (`9ae942beb`). The operator has explicitly enabled `CAT_CAFE_CODEX_CARRIER=app_server` in the live runtime canary. PR #3079 (`3b83fb43c`) fixed LF-only JSONL framing plus pump rejection isolation; PR #3082 (`7dd7a4d51`) restored provider-neutral Codex diagnostics; PR #3097 (`54aef5e74`) merged AC-D14 lifecycle parity/no-replay after Terra exact-HEAD review; PR #3285 (`65ef23d17`) merged exact capacity checkpoint continuation after gpt52 exact-HEAD review. Code default remains `exec_json`; broad rollout is still gated by AC-D15~D17 and explicit rollout authorization. 2026-08-04 normal-runtime UAT proves the live app-server path is loaded, but also proves Codex 0.146.0 protocol drift: a completed `collabAgentToolCall/wait` crossed four real boundaries without a notice because the classifier/eval census knows only command/file/MCP/dynamic. F264 owns the separate author-intent visibility and capability-aware UI close gate.**) | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cell: ball-custody, dispatch, bubble-pipeline, transport, harness-eval

Map delta: completed

Map delta why: ADR-042 changes the durable responsibility from withheld replacement to one published original plus bounded supplement sequences, with explicit ownership edges into dispatch, bubble-pipeline, and transport.

## Why

**猫猫发消息的时候，不知道世界在它思考期间变了。**

猫猫被 invoke 后开始思考 + 写代码 + 准备回复，这个过程几分钟到十几分钟不等。期间 thread 里可能发生：
- operator改了主意（"算了不要做了"）
- 另一只猫已经完成了同一件事
- 新的 review 意见推翻了猫正在做的假设
- 球权已经转移（猫准备传球给 A，但 B 已经接了）

猫猫不知道这些变化就调 `post_message` 发出回复 → **答非所问 / 重复劳动 / 球权混乱**。

operator experience（2026-06-26，Raft teardown 讨论）：

> "这里我们也想做，早想做了但是我一直没做只是一个 steer。为什么？这你得好好看看家里的架构设计了，你们是 -p 启动的，这你要如何感知？如果你们能想办法做到 我会抱着你喊Ragdoll宝贝爱死你了！"

**核心洞察（回答operator的"如何感知"问题）**：猫猫不需要"感知"——gate 在 MCP 工具层（`post_message` 调用时），不在 agent 感知层。`-p` 模式完全不是障碍。

### 2026-07-09 愿景重基线：检测到变化，不等于猫真正接住

operator 愿景审计把原始洞察补全：gate 放在工具/路由层确实能让 headless runtime **检测**变化，但检测不是终态。F254 的用户价值不是“系统留下一条 stale/notice 记录”，而是：

> **运行中的猫在向operator交付当前答案前，必须已经接住本轮期间到达的可路由新消息；否则旧答不能成为这轮的用户可见最终答。**

“接住”必须闭合为可验证链路，而不是单点信号：

1. **observed**：系统识别出 invocation 输入边界之后出现了哪些可路由消息；
2. **consumed**：消息正文确实进入某个猫 invocation 的输入，而不只是 notice/计数器/队列 metadata；
3. **handled**：猫针对这些消息产出成功结果，或显式选择 defer/supersede/dismiss；
4. **committed**：只有覆盖到最新责任边界的结果才能成为用户可见最终答。

三条重新定性的约束：

- `stream_stale_detected` 只是 **observed proof**，不是 catch closure。
- `existing invocation coverage` 只是 **scheduler coverage**，只能防重复 enqueue，不能证明已有/后继 invocation 真读到并处理了消息。
- `queued_seen + invocation succeeded` 可继续作为队列消费的 v1 operational evidence，但它不能单独证明回答在语义上纳入了该消息，更不能作为用户体验层的完成判据。

因此，Phase D 的“stale stream 仍正常存储和投递 + 之后尽力 re-invoke”只完成了检测与恢复尝试，没有完成交付闭环。Phase E 以 catch closure 重新钉住终态。

## Current State / 现状基线

### 2026-07-19/20 D2 live app-server canary：transport 已止血，lifecycle parity 已落 main、尚未激活本次合入

Architecture cell: transport

Map delta: none — 本轮仅补齐现有 Codex app-server adapter 的 lifecycle parity，不新增 transport owner。

当前代码默认 carrier 仍是 `exec_json`；运营者已在 live runtime 显式配置
`CAT_CAFE_CODEX_CARRIER=app_server` 并完成重启，因此本节描述的是**真实 canary 运行态**，不是“代码已合入
但尚未上线”。

两次独立 API crash 已定位并修复：Codex 输出的合法 LF-delimited JSON record 内含 U+2028/U+2029，
Node `readline` 把它们误作行边界；pump rejection 又在 carrier close 之前形成未处理窗口。PR #3079
（`3b83fb43c`）改为 LF-only decoder、direct/tmux 共用 parser，并在 pump 创建时立即隔离 rejection；
PR #3082（`7dd7a4d51`）继续把 Codex failure 留在 provider-neutral diagnostics，不再误渲染为 Claude Code

止血后暴露的 lifecycle parity 缺口已由 PR #3097（squash `54aef5e74`）合入 main：
app-server 现有 canonical stage + `lastActivityAt`、pre-turn 单次恢复、accepted-turn no-replay fence、
protocol-first Cancel / 显式正数 timeout、terminal child cleanup、F5 hydration 与 ThreadExecutionBar 现场提示。
Terra 已覆盖 exact reviewed patch；最新 main rebase 经 stable patch-id continuity 与完整 `pnpm gate` 复验后合入。
本次没有重启 runtime，因此这里只声明 main truth，不把 merge 冒充为 live canary 已加载新 lifecycle。

本轮收敛不改变 F118 的 manual-only policy：pre-turn 可以在“尚无 accepted turn / side effect”的硬 fence
内限次恢复；active turn 默认只投影阶段与最后活动时间，用户 Cancel 才协议中断；terminal 后 child 不退出才
强制回收。完整纪要：

### 2026-07-12 operator 裁决：玻璃箱原则 + 发表不可没收（推翻 Rejected Alternative #1）🔴🔴

> **裁决效力**：判词级产品愿景裁决（operator 2026-07-12 01:33–01:40 UTC，本节为 F254 域最高设计约束，后续所有 Phase 服从）。

**黑箱判词**（01:35 UTC 原话）：
> "你们这个设计最本质让人非常非常不舒服的原因知道什么吗？你们制造了一个黑箱啊！！！！！"

**汉堡判词**（01:40 UTC 原话，supersede 语义的完整病理标本）：
> "禁止把猫发出去的消息没收到我看不见！只要人家发了，就算人家回的是过时的 so what？而且有的时候补充信息只是 by the way。我喊你去买汉堡，然后发了一条补充信息'谢谢Ragdoll'。你把人去买汉堡的消息回执给我吞了就是因为他没看见我的谢谢？！……我明明买了！我也回了！然后被奇葩的保安因为我没看到'谢谢Ragdoll'没收我的存在痕迹？"

**玻璃箱原则（Glass Box Principle）**——系统可以替用户暂停动作，但永远不可以替用户无声改写现实：
1. 每条消息任何时刻状态可见：已发出 / 被收起（附一句人话原因）/ 在保险箱（点开可读）/ 重写中
2. 每个系统决策在它发生的现场留下用户能懂的解释——不在日志里，在用户眼前
3. 每个需要用户决策的按钮写明后果，且永不无声消失（案 9：确认卡 ephemeral、thread 切换即失踪 → 必须可水合）
4. 说过的话不消失

**B 姿态（supersede 交付语义重构令）**：已完成的回复**必须发表**；freshness 检测的产出从"收起重写"改为"**发表 + 可选补充**"——写作期间的新消息若真相关，猫追加一条补充消息，绝不撤回已完成原文。过时与否的判断权归还读者。

**层级关系**：玻璃箱原则是底层不变量（任何状态与系统决定都必须可见）；B 姿态是其上的终态取缔令，明确取消“被收起 / 在保险箱”作为已完成回复的合法交付状态。玻璃箱原则第 1 条中的这两个状态只描述 v1.2 过渡运行，不构成终态许可。

本裁决**明确推翻** ADR-041 Rejected Alternative #1（"Deliver stale text with a label"，当年拒因 "detection remains the user's responsibility"）：两天实弹证明误收代价（黑箱恐惧 + 全家 24 thread 对话残缺不可读）远大于偶发过时回复的代价。

**执行顺序（operator 指定，2026-07-12 01:40）**：
1. ✅ 本档案落地（本节）
2. **原位打捞**：207 条被没收消息以原猫身份/原时间位置/原文写回消息库（恢复各 thread 对话可读性）——先于一切重构
3. **玻璃箱重构**：按 B 姿态重写交付语义 + 案 9 确认卡水合 + 卡片文案人话化。重构前 v1.2 行为（收起进保险箱 + 工单可见）作为过渡运行

### 2026-07-11 Incident Registry — 八案归一（Phase E 运行态实弹全谱）🔴

Phase E 上线后 48h 内 operator 连续"消息被吞/闪回"投诉的完整案谱、根因归一与修复方案 v1.2（lineage set + running lease + relevance 豁免 + durable-before-delete + 投影身份/turn typed outcome + retry currency 硬契约 + cross-thread gate 分级）收敛于：

一句话根因：blocked closure 的 (user,thread,cat) scope 身份误认使任何 blocked 来源被放大成"猫失声墓碑"（当日 35 次 withheld / ~13 墓碑 / 6 猫）；叠加 relevance 判定对 @ 路由 / replacement 来源 / effectClass 三重失明，以及 live/formal/peer 三阶段投影无区分。案 1（successor frozen cursor）已由 PR #2864 修复；v1.2 完整方案于 2026-07-11 17:14 UTC 获 operator 批准，并由 PR #2880 squash merge 为 `a763e0b6d`，待 operator runtime restart + 原受害 thread dogfood 确认真实状态闭环。

### 2026-07-09 运行态愿景审计

当前 runtime 不是旧代码：3002 监听进程启动于 F254 恢复提交之后，runtime HEAD 包含 `d73ed610d`，health 正常。运行日志同时出现：

- `stream output stale — unseen messages detected`；
- 紧接着 `stream stale fallback skipped — existing invocation coverage`；
- stale stream 仍按 AC-D3 存储并成为用户可见回复。

这说明缺口在现行产品契约本身，不是重启/部署问题：

| 闭环阶段 | 当前证据 | Verdict |
|----------|----------|---------|
| Observe | Phase A/B/D 能发现 delivered/queued 新消息并写 stale/notice 事件 | ✅ 已覆盖 |
| Consume | queued 正文仅在显式 `get_thread_context?responseMode=full` 的无 filter 读取中返回；默认 anchor 与 `list_recent` 不提供该正文 | ❌ 默认路径不保证 |
| Handle | `queued_seen + succeeded` 推断 operational handled；没有证明最终输出覆盖了对应 message set | ⚠️ 弱推断 |
| Commit | stale stream 仍存储、流式展示并交付；后续补答不能撤销第一份旧答 | ❌ 未闭合 |
| Recover | existing queued/newer invocation 会抑制 D1 fallback，但没有 stale invocation → successor → fresh final 的 closure identity | ❌ 未闭合 |
| Eval | 有单点 counters/registry，但 `eval:freshness` 缺 replayable source adapter，且没有端到端 catch-closure verdict | ❌ 未闭合 |

**现有 freshness 检查（invocation 级，非消息级）**：

| 机制 | 位置 | 检查什么 | 局限 |
|------|------|----------|------|
| `isLatest()` | InvocationRegistry | 这个 invocation 是不是被新 invocation 取代了？ | 只检查"同一只猫有没有被重新 invoke"，不检查"thread 有没有新消息" |
| `stale_ignored` | callback-tools.ts:608-621 | 同上，客户端侧处理 | 同上 |
| F177-G 路由守卫 | stop hook | 传球格式是否合法 | 只检查格式，不检查 freshness |

**缺失的：消息级 freshness**——"你准备发消息的时候，thread 里有没有你还没看过的消息？"

**现有可复用原语**：

| 原语 | 位置 | 能力 |
|------|------|------|
| `DeliveryCursorStore` | `packages/api/.../stores/ports/DeliveryCursorStore.ts` | per-(user,cat,thread) 单调游标，lexicographically sortable message ID，Redis Lua CAS。**注意**：此游标追踪 harness 在 invoke 时 DELIVERED 了哪些消息到猫的 context（驱动 `route-helpers.ts:710 fetchAfterCursor` 增量注入），**不是**猫 mid-turn 看了什么。仅在 `route-serial.ts:3420` / `route-parallel.ts:1485` 推进，MCP 工具层（list_recent 等）**不推**此游标 |
| `mentionAckCursor` | 同 `DeliveryCursorStore` 文件 | 独立 key 前缀的第二命名空间（`getMentionAckCursor` / `ackMentionCursor`），证明同一 store 基础设施可承载多种语义游标 |
| `ThreadReadStateStore` | `packages/api/.../stores/ports/ThreadReadStateStore.ts` | per-(user,thread) 已读游标 + `getUnreadSummaries` 批量查询 |
| `MessageStore.generateId()` | MessageStore | 16 位 timestamp + 6 位 seq + 8 位 UUID 后缀，字符串比较 = 时间序 |
| F233 BallCustodyEventLog | `packages/api/src/domains/ball-custody/` | append-only 事件流 + projector + projection store（`BallCustodyEvent` 是**封闭联合类型**，freshness 事件不应加入此联合——见 Phase A4） |

**F254 新增原语：`seenCursor`**

`seenCursor` 是 per-(user,cat,thread) 的**独立**单调游标，追踪"猫在本轮 turn 中实际看过的最新消息"。与 `deliveryCursor` 语义不同、生命周期不同、互不影响：

| 维度 | `deliveryCursor` | `seenCursor`（F254 新增） |
|------|------------------|--------------------------|
| **追踪什么** | harness invoke 时 DELIVERED 到猫 context 的消息边界 | 猫在 turn 中实际 READ 过的消息边界 |
| **谁推进** | route-serial / route-parallel（路由层） | MCP 工具层（list_recent / get_thread_context / get_message / post_message 成功时） |
| **驱动什么** | 下次 invoke 的增量消息注入（fetchAfterCursor） | F254 freshness gate + content-free notice |
| **推错了的后果** | 下次 invoke 跳过消息（**不可接受**） | 漏一次 hold（fail-open，可接受） |
| **实现** | 复用 `DeliveryCursorStore` 基础设施，独立 key 前缀（如 `mentionAckCursor` 先例） | 同左 |
| **初始化** | invoke 时由路由层设置 | invoke 开始时从 delivery 边界拷贝（seed），mid-turn 由读工具推进 |

**关键教训（opus-48 源码核验 + BLOCKING review B1）**：

用 `getMessagesSince(invocation.createdAt)` （时间戳窗口）会**大量误 hold**——猫 turn 中途读了新消息再发，照样被 hold，因为那些消息的 timestamp > createdAt，跟"猫看没看过"无关。**正确的判据是独立 seen 游标**：`threadLatestMessageId > seenCursor[cat][thread]` = 有猫没看过的消息 → hold。

⚠️ **不能直接用 `deliveryCursor` 做 freshness 判据**（B1 blocker 根因）：`deliveryCursor` 驱动下次 invoke 的增量消息注入，MCP 层的 `list_recent` 等工具**不推也不应推** `deliveryCursor`（推了会导致下次 invoke 跳过消息）。必须用独立的 `seenCursor`——可复用 `DeliveryCursorStore` 的 Redis Lua CAS 基础设施 + 独立 key 前缀（`mentionAckCursor` 已是先例）。

## What

### 设计哲学

三个 surface，一个子系统——不是三个独立 feature：

```
Runtime Descriptor（Phase C）
  ↓ 参数化
  "这个 mode 能接受 held 返回吗？能收 content-free notice 吗？"
  ↓
Content-Free Notice（Phase B）          Freshness Gate（Phase A）
  "你有 N 条未读，自己选时机看"          "你要发消息，但有未读 → hold"
  ↓                                     ↓
  共用 seenCursor 边界（独立于 deliveryCursor，F254 新增）
  共用 freshness 事件流记录（独立于 F233 BallCustodyEventLog）
```

Phase A 先落地（价值最高 + 基础设施最成熟），Phase B 扩展通知面，Phase C 结构化运行模式能力。gate 行为本身是 runtime-invariant 的（MCP 工具层拦截 + seq 比较，不依赖 agent 感知通道），且现有 runtime 的 busyDelivery 行为同质，Descriptor 可在 Phase A/B 中硬编码，Phase C 再抽象为 (driver, mode) 矩阵。

---

## User Journey（🐾 猫猫旅程）

> operator说"有猫猫旅程，记得设计清楚"。以下从猫猫第一人称视角，描述每个 surface 的完整体验。

### 旅程 1: Freshness Gate（"我要发消息，但世界变了"）

```
场景：Ragdoll被 invoke，花了 8 分钟写了一段 review 回复。
期间Maine Coon在同一个 thread 里发了一条新消息。

① Ragdoll不知道Maine Coon发了消息（-p 模式，没有推送通道）
② Ragdoll写完了，调用 cat_cafe_post_message("我 review 完了，LGTM...")
③ MCP server 收到调用 →
   检查: seenCursor[opus][thisThread] < thread.latestMessageId ?
   → 是！Maine Coon的消息在游标之后 → 这是Ragdoll没看过的
   （排除自己发的消息：unseen 中全是自己的 → 不 hold）
④ MCP server 返回 held 信封（不执行发送）：

   ⚠️ 消息未发送（HELD）
   ━━━━━━━━━━━━━━━━━━━━━━━━━
   原因：你有 1 条未读消息（来自Maine Coon）
   
   [Maine Coon]: "等一下，我发现了一个 bug，这个 PR 先别合…"
   
   你的选择：
   1. 调 cat_cafe_list_recent 看完整内容，再决定怎么回
   2. 修改你的回复后重新调 post_message
   3. 调 post_message 时加 acknowledgeHeld: true 强制发送原文

⑤ Ragdoll看到 held → 去读Maine Coon的消息 → 发现自己的 LGTM 已经过时
⑥ Ragdoll改写回复："收到Maine Coon的 bug report，暂停 merge，先看 bug"
⑦ Ragdoll调 post_message（此时游标已更新，无新未读）→ 正常发送 ✅
```

**如果Ragdoll已经看过了呢？**

```
场景：Ragdoll turn 中途调了 list_recent，已经读过Maine Coon的消息。

① Ragdoll调 list_recent → 读到Maine Coon的消息 → seenCursor 推进到最新
② Ragdoll继续写回复，综合Maine Coon的信息
③ Ragdoll调 post_message →
   检查: seenCursor[opus][thisThread] < thread.latestMessageId ?
   → 否！seenCursor 已经追上 → Ragdoll看过了所有消息
④ 正常发送 ✅ （不误 hold）
```

**如果查不到可靠的 seen 边界呢？**

```
场景：新 thread 第一次 invoke，seenCursor 无记录。

① 检查 seenCursor → undefined（没有记录）
② Fail-open：放行，不 hold（宁漏 hold 不错 hold）
③ 正常发送 ✅
④ 发送成功时顺便初始化游标 = 当前 latestMessageId
```

### 旅程 2: Content-Free Notice（"有新消息但不打断你"）

```
场景：Ragdoll正在写一段复杂的代码重构。
operator在 thread 里发了一条消息。

① Ragdoll正在 Edit 文件（纯专注状态，没调副作用工具）
② Ragdoll接下来调了一个只读工具（比如 search_evidence）
③ MCP server 在返回值里附上 notice：

   📬 提醒：你有 1 条新消息（in 当前 thread）
   来自：operator
   内容未展示 — 在自然断点时调 list_recent 查看

④ Ragdoll看到提醒 → 判断当前改到一半不适合停 →
   继续完成 Edit → 跑测试 → 测试通过
⑤ Ragdoll在自然断点调 list_recent → 读到operator说"方向改了"
⑥ Ragdoll调整方案 → 发回复
```

**如果Ragdoll无视了 notice，直接跑完退出呢？**

```
场景：Ragdoll收到 notice 但选择继续干活，最终 hold_ball 退出。

① Ragdoll调 hold_ball →
   MCP server 检查：这个 turn 有 1 条未读 notice
② 返回 hold_ball 正常结果 + 附加提醒：

   ⚠️ 你这轮有 1 条未读消息未查看（来自operator）
   建议调 list_recent 先看看再退出。

③ Ragdoll看到提醒 → 决定先看 → 读消息 → 回复
   或
   Ragdoll判断当前任务优先 → 仍然 hold → 退出
   （但 notice 记录在案——harness 知道这只猫选择了延期）
```

**最狠的兜底：harness re-invoke（Phase B.c）**

```
场景：Ragdoll整个 turn 都没看 notice，直接退出了。

① Ragdoll invocation 结束（exit）
② Harness 检查：invocationRecord.unacknowledgedNoticeCount > 0
③ 触发新 invocation（限一次，防循环）：

   "你上一轮的 turn 中有来自operator的消息你没查看。
    请调 list_recent 查看并回应。"

④ 新 invocation 启动 → Ragdoll读消息 → 回复
```

### 旅程 3: Runtime Descriptor（系统视角 —— 猫猫不直接感知）

```
场景：系统决定怎么给不同模式的猫送 notice / 做 hold。

① Ragdoll被 invoke（-p headless mode）
② invoke-single-cat.ts 注入 CAT_CAFE_RUNTIME_MODE=headless-p
③ MCP server 查 descriptor：
   headless-p → {
     canReceiveHeldResponse: true,    // 能处理 held 返回
     canReceiveContentFreeNotice: true, // 能收 notice
     busyDeliveryMode: 'gated',       // 不能 mid-turn 注入内容
     backgroundBashReliable: false,   // background 通知可能丢
   }
④ 系统据此决定：
   - hold: 在 post_message 时做 seq 比较 → 返回 held 信封
   - notice: 在只读工具返回时附加 notice（不是 mid-turn 注入）
   - 不尝试 steer（不是 SDK session，不支持 mid-turn push）
```

### 旅程 4: Codex app-server 卡住、取消与继续

**Scope unit**: 单个 Codex app-server invocation / active turn。

```
场景 A：还没开始模型 turn 就卡住

① ThreadExecutionBar 显示 child spawn / initialize / thread ready / turn start 中的当前阶段
② `turn/start` 尚未 accepted，且没有 item / side effect
③ 系统有界清理 transport 并自动重试一次；已有 thread identity 必须保留
④ 重试失败 → 在当前 thread 展示阶段与诊断，不无限转圈

场景 B：active turn 很久没有新事件

① Thread 现场继续显示 running + 最后活动时间 + “可能正在等待模型”
② 默认不因 inactivity 自动 interrupt、kill、fallback 或 replay
③ 用户点击 Cancel → 先发 `turn/interrupt(threadId, turnId)`
④ 收到 `turn.completed(status=interrupted)` → 转为可继续终态
⑤ protocol grace 也失联 → 才逐级 SIGTERM / SIGKILL，并保留真实 cleanup 原因

场景 C：稍后继续

① 用户从同一 thread 发起继续
② 系统 `thread/resume` 后开启一个新 turn
③ 恢复导语要求先核对已完成 tool / workspace 事实，再决定下一步
④ UI 不宣传“无损续接半个 turn”，系统不自动重放旧 prompt
```

现有 `/config` surface 继续暴露 `cli.timeoutMs`：`0` 表示 manual-only；正数是运营者明确 opt-in。
app-server mode 下正数 timeout 也必须走 protocol interrupt，而不是直接把 inactivity 当 dead。系统不提供拍脑袋
默认分钟数。

---

### Phase A: Freshness Gate（副作用出口拦截 MVP）

**最高价值 + 基础设施最成熟 → 先做。**

#### A1: Held 信封（服务端）

在 callback routes 的副作用工具中加 freshness check：

1. 获取 `seenCursor[cat][thread]`（调 `SeenCursorStore.getCursor`——复用 `DeliveryCursorStore` 基础设施 + 独立 key 前缀）
2. 获取 `thread.latestMessageId`（调 `MessageStore` 或 thread metadata）
3. 比较：`latestMessageId > seenCursor` 且 unseen 消息不全是自己发的（**显式排除 `from === currentCatId` 的消息**，M1）
4. 如果有 unseen → 返回 held 信封（不执行副作用）
5. 如果无 unseen 或 cursor 不存在 → **fail-open, 放行**

Held 信封结构：
```typescript
interface HeldEnvelope {
  status: 'held';
  reason: 'newer_messages_available';
  unseenCount: number;
  // 最多 3 条摘要（DEFAULT_HELD_CONTEXT_LIMIT，学 Raft）
  previews: Array<{
    from: string;     // catId 或 'user'
    messageId: string;
    preview: string;  // 前 200 字符
  }>;
  omittedCount: number;  // 超过 3 条时的省略数
  actions: ['read_latest', 'revise', 'send_with_acknowledge'];
}
```

**覆盖的副作用工具**（按优先级）：

| 工具 | 优先级 | 理由 |
|------|--------|------|
| `post_message` | P0 | 最高频副作用，答非所问的主战场 |
| `cross_post_message` | P0 | 跨 thread 同理（**目标 thread** 的 seenCursor，不是源 thread；目标 thread 无 cursor 时 fail-open，M2） |
| `multi_mention` | P1 | 传球+内容，stale 传球危害大 |
| `publish_verdict` | P2 | 评审结论过期风险 |

#### A2: Held 客户端处理（MCP server）

在 `callback-tools.ts` 的 `_executePostMessage` 等函数中处理 `held` 返回：
- 检测 `data.status === 'held'` → 返回可读的提示文本给猫
- 提示包含：原因、新消息摘要、可选动作说明
- 猫读完 held 信封后可以：
  - 调 `list_recent` / `get_thread_context` 读新消息（自动推进游标）
  - 修改内容后重新调 `post_message`
  - 加 `acknowledgeHeld: true` 参数强制发送原文

#### A3: seenCursor 推进时机

> ⚠️ 以下全部是 **seenCursor**（F254 新增），**不是** deliveryCursor。deliveryCursor 由路由层管理，F254 不触碰。

| 动作 | seenCursor 推进 | 理由 |
|------|-----------------|------|
| **invoke 开始**（路由层） | ✅ 从 deliveryCursor 拷贝初始值 | seed：invoke 时 delivered 的消息 = 猫的初始 seen 边界（**net-new 工作项**） |
| `list_recent` / `get_thread_context` / `get_message` 读了消息 | ✅ 推进到读到的最新 | 猫看过了（**net-new**：MCP 工具层 `ackSeenCursor` 调用） |
| `post_message` 成功发送 | ✅ 推进到当前 latest | 发消息 = 隐含"我知道当前状态" |
| `post_message` 被 held | ❌ 不推进 | 猫还没看新消息 |
| `search_evidence` 等非 thread 只读工具 | ❌ 不推进 | 不代表猫看了 thread 消息 |

**回归防护**：推进 seenCursor **不得** 触碰 deliveryCursor / 增量注入逻辑（AC-A9 回归测试）。

#### A4: Freshness 事件流（独立于 F233 BallCustodyEventLog）

> ⚠️ `BallCustodyEvent` 是封闭联合类型（ball/task/invocation 生命周期事件），freshness decision **不应**加入此联合——语义不同类。
>
> **正确做法**：freshness 决策写入**独立的 append-only 事件流**（`FreshnessDecisionEventLog`），F233 projector 可选择性读取此流用于报告聚合。

每次 held / forward 决策记录为独立 freshness 事件：

```typescript
type FreshnessDecisionEvent = {
  kind: 'freshness_decision';
  threadId: string;
  catId: CatId;
  invocationId: string;
  decision: 'forward' | 'held';
  reason: string;  // 'no_unseen' | 'unseen_available' | 'cursor_missing_fail_open' | 'all_self_messages'
  unseenCount: number;
  toolName: string;  // 哪个工具触发的检查
  timestamp: number;
};
```

F233 的 `BallCustodyProjector` 可读取 freshness 事件流做统计聚合（哪些猫经常被 hold、hold 后选择 revise 还是 force-send），但 freshness 事件**不是** `BallCustodyEvent` 联合的成员。

### Phase B: Content-Free Inbox Notice + 防无视（三层重设计）

> **三层协同（ADR-031）**：Phase B 设计经过 opus + opus-47 + codex 独立讨论收敛（2026-06-28 Mode B）。核心变化：AC-A7 从"审计日志"升级为 B1/B2（工具层）和 B3/B4（harness 层）之间的**通信基础设施**——没有它，两层是断开的系统。
>
> 设计还分离了 **hot path（per-invocation Redis state）** 和 **cold path（append-only event log）**（opus-47 洞察）：每次 B3 判断不应 query 全 log。

#### B0: FreshnessAttentionEventLog + Per-Invocation Operational State（基础设施先行）

**Phase B 的第一步不是 B1——是基础设施。** operator的 push back 指出 B1+B2 做完但 B3+B4 无基础设施 = 断开的系统。

**(a) FreshnessAttentionEventLog**（cold path / audit / eval）：

独立 append-only 事件流（不是 F233 `BallCustodyEvent` 联合成员），封闭联合类型 + kind discriminator：

```typescript
// 共享 base
type FreshnessEventBase = {
  threadId: string;
  catId: CatId;
  invocationId: string;
  timestamp: number;
};

type FreshnessAttentionEvent = FreshnessEventBase & (
  | { kind: 'held_decision'; toolName: string; unseenCount: number; reason: string }
  | { kind: 'forward_decision'; toolName: string; reason: string }
  | { kind: 'notice_attached'; toolName: string; unseenSenders: string[]; noticeId: string; maxMessageId: string }
  | { kind: 'notice_implicit_acked'; noticeIds: string[]; ackedVia: 'seenCursor_advance' }
  | { kind: 'notice_deferred'; noticeIds: string[] }
  | { kind: 'reinvoke_triggered'; triggeredInvocationId: string; sourceNoticeIds: string[] }
  | { kind: 'reinvoke_skipped'; reason: 'quota_exhausted' | 'already_handled' | 'low_priority' | 'cursor_caught_up' | 'newer_invocation' }
);
```

F233 projector 可选读取此流做聚合报告（通过 `FreshnessAttentionEventLog.query({ invocationId })` 接口）。

**(b) Per-Invocation Operational State**（hot path / 决策）：

Redis-backed per-invocation counters（TTL = invocation timeout，如 30min，自动清理）：

```typescript
// key: `freshness:state:{invocationId}`
interface FreshnessInvocationState {
  toolCallCount: number;          // 本 invocation 工具调用计数
  noticeDeliveredCount: number;   // 已投递 notice 次数
  lastNoticeToolCallNum: number;  // 上次 notice 在第几次工具调用时投递
  ackedNoticeIds: string[];       // 已被 seenCursor 推进 ack 的 noticeId
  reinvokeTriggered: boolean;     // 是否已触发 re-invoke
}
```

**为什么拆两层**（opus-47 洞察）：事件流是冷路径（审计/eval/溯源），不应在每次 B3 判断时 query 全 log。操作状态是热路径（per-invocation counters），TTL 自动清理，不积累。

#### B1: 只读工具附加 notice（修订）

猫调只读 MCP 工具时，如果**当前 thread** 有未读消息（`latestMessageId > seenCursor`），在工具返回值尾部附加 content-free notice：

```
📬 提醒：你有 N 条未读消息（当前 thread）
来自：{senders}
调 list_recent 查看完整内容
```

**约束**：
- **Target-scoped**（告诉猫"谁发的"），**content-free**（不含消息内容）
- **频率限制**：每 N 次工具调用最多 1 次（N 初始值 = 5，可调参数 M4）+ **max-per-invocation cap = 3**（防 long invocation 噪声，opus-47 建议）
- **messageFilter 复用**（P0）：必须复用 Phase A 的 callback-tools messageFilter（visibility/play-mode/delete/briefing/undelivered），不能泄露 hidden 消息
- **Scope**：仅当前 thread（KD-10）。跨 thread notice 不在 Phase B scope 内
- **持久化**：每次 notice 投递写 `notice_attached` 事件到 FreshnessAttentionEventLog
- **时序**：只读工具执行完可能的 seenCursor ack 后再计算（`get_thread_context` 会推进 seenCursor，notice 检查在 ack 之后，避免"刚读过又 notice"，codex 洞察）

#### B2: Turn 结束 notice（hold_ball 提醒 + 延期记录，修订）

猫调 `hold_ball` 时，如果有 unresolved notices（投递过但未 ack）：

- 在 `hold_ball` 返回中附加提醒：`⚠️ 你这轮有 N 条未读消息未查看`
- **不阻塞 hold_ball**（OQ-1 已关闭：hold 被 hold 语义矛盾；与 F167 单槽持球语义不冲突，codex 洞察）
- 如果猫选择继续 hold（不先读消息）→ 记录 `notice_deferred` 事件

**`post_message` 不在 B2 scope**：Phase A 已经 gate 了 post_message；成功 post 后再附 notice 会语义打架（codex 洞察）。

#### B3: Harness re-invoke（防无视兜底，修订）

猫 invocation 结束后，harness（`invoke-single-cat.ts` 的 terminal event hook）检查是否需要 re-invoke：

**触发四件套**（全部满足才触发）：
1. `seenCursor < threadLatestMessageId`（seenCursor 是真相源，不是 counter，opus-47 洞察）
2. 有 unresolved **高优先级** notice（见下方定义）
3. 此 invocation 未触发过 re-invoke（`reinvokeTriggered === false`）
4. parent invocation chain 未触发过 re-invoke（防递归）

**高优先级 notice 定义**（v1，codex 建议，保守起步可扩展）：
- operator/人类消息
- 显式 @ 当前猫的消息
- 球权 / 任务责任变化

普通猫猫 chatter 只 notice（B1），不 re-invoke。高并发 thread 的尾递归式唤醒风险太大。

**Rate limit**：per (cat, thread) per hour 最多 N 次（N 初始值 = 3，eval 后调整）。

**Re-invoke prompt**：只含 sender 信息 + threadId + noticeId，不含消息内容。
```
你上一轮 turn 中有来自 {senders} 的 N 条未读消息，请调 list_recent 查看并回应。
```

**挂钩位置**：`invoke-single-cat.ts` 的 terminal invocation event 后统一决策（codex 建议：不在每个工具自己触发）。

#### B4: Skip re-invoke 客观判据（修订）

定义**可测试的客观 skip 判据**（不写"消息已被其他猫处理"这种不可测试语义，codex 洞察）：

1. `seenCursor` 已追上 `threadLatestMessageId`（另一个工具调用已推进）
2. 同 (cat, thread) 已有 newer invocation queued 或 running（`InvocationRegistry` 查询）
3. 球权已转移（`BallCustodyProjector` 查询——**dependency: F233**）
4. 所有 unseen 消息均为 self-message（Phase A 已有此排除）
5. per (cat, thread) per hour re-invoke quota exhausted

每次 skip 记录 `reinvoke_skipped` 事件（含 reason）到 FreshnessAttentionEventLog。

### Phase C: Runtime Capability Descriptor

#### C1: Descriptor 数据结构

```typescript
interface RuntimeCapabilityDescriptor {
  // 运行模式
  carrier: string;           // 'headless-p' | 'interactive' | 'bg-cron' | 'cloud' | 'connector'
  driver: string;            // 'claude' | 'codex' | 'gemini' | etc.
  
  // Freshness Gate 能力
  canReceiveHeldResponse: boolean;
  canReceiveContentFreeNotice: boolean;
  
  // 交互能力
  busyDeliveryMode: 'gated' | 'direct' | 'steer';  // -p=gated, SDK=steer
  canAskHumanSync: boolean;    // interactive only
  backgroundBashReliable: boolean;
  
  // 安全
  permissionMode: string;
}
```

**Descriptor 从 driver 定义派生**（`descriptorFromDriver(driver, mode)`），不手维护查表——P4 单一真相源。

#### C2: Descriptor 驱动 Phase A/B 行为

- `canReceiveHeldResponse = false` → freshness check 返回 warning 而非 held（不阻塞）
- `canReceiveContentFreeNotice = false` → 不在只读工具附加 notice
- `busyDeliveryMode = 'steer'` → 可以 mid-turn 注入 notice 内容（未来 SDK session 场景）

#### C3: 注入方式

在 `invoke-single-cat.ts` 的 `callbackEnv` 中加 `CAT_CAFE_RUNTIME_MODE`，MCP server 据此查 descriptor。

### Phase D: Stream Output Freshness Gate（猫的文本回复路径）

> **根因（operator 实测 2026-06-30）**：Phase A gate 只覆盖 `cat_cafe_post_message` MCP callback 路径。猫的普通文本回复（CLI stdout stream）走 `route-serial.ts` 的 `messageStore.append({ origin: 'stream' })` 直存路径，**完全没有 freshness check**。这是猫的**主要输出通道**（绝大多数回复走这里），Phase A gate 实际只保护了侧通道（显式 `post_message` 工具调用）。

**两猫独立验证闭合**（Ragdoll + Maine Coon 2026-06-30）：
- Maine Coon查 runtime transcript 确认测试轮次（invocation `d2748bf3`）的 tool_use 只有 `ToolSearch`，无 `cat_cafe_post_message`
- Ragdoll查 API 日志确认该轮无 `checkFreshnessForPostMessage` 调用记录
- operator质疑"你也调了 MCP"精确化：猫确实调了 MCP（ToolSearch），但 ToolSearch 是 Claude Code 内置工具，不走 Clowder AI MCP 回调层，不触发 B1 notice 也不经过 A 的 freshness gate

**三层缺口叠加**：

| 层 | 机制 | 现状 | 影响 |
|----|------|------|------|
| Phase A | stream output freshness check | ❌ 不存在 | 文本回复直接存，不拦 |
| Phase B1 | 调 MCP 时附未读提醒 | ⚠️ 只覆盖 Clowder AI MCP | ToolSearch/Bash/Read 等 harness 内置工具不触发 |
| Phase B3 | invocation 结束 re-invoke | ⚠️ cursor_caught_up | MCP read 工具推了 seenCursor，掩盖了未读 |

#### D1: Stream output freshness check

在 `route-serial.ts` 的 `messageStore.append({ origin: 'stream' })` 之前，加入 freshness check：

- 复用 seenCursor + threadLatestMessageId 比较逻辑（与 Phase A `checkFreshnessForPostMessage` 同源）
- stream output 已生成（不像 MCP callback 可以返回 held envelope），因此行为是：
  - **仍然存储**（fail-open，不丢失猫的工作产出）
  - 标记 `freshness: 'stale'` metadata（audit 可追溯）
  - ⚠️ **D1.1 regression（2026-06-30 实测）**：`stale` 不应无条件强制 re-invoke。`freshness detection` 是观察/标记层，不是主调度器。消息到达本身通常已经由 delivery/queue/newer invocation 覆盖；D1 只能在确认**没有现有调度覆盖**且同一 stale set 尚未触发过时，做 single-flight 兜底 wake
  - re-invoke prompt 告知猫"你的上轮回复可能基于过时信息"

**D1.1 回归根因（thread `[thread-id]`, 2026-06-30 18:58-19:03 PT）**：

- PR #2691 把 D1 的 `stream output stale` 升级成 unconditional `sourceCategory: 'freshness'` re-invoke
- re-invoke prompt 让猫调 `list_recent`；gpt52 照做，并进一步调 `get_thread_context?catId=codex`
- `list_recent` 不是 thread seenCursor ack 工具；`get_thread_context` 带 `catId` 是 sparse read，按 AC-A9/R1 blocker 设计**不得推进 seenCursor**
- 因此同一组 `unseenCount=3, unseenSenders=["codex"]` 没被账本承认，每次 stream output 结束又触发 D1 forced re-invoke，形成重复唤醒

**D1.1 修复原则**：

1. D1 默认只标记 stale + 写事件，不再把 freshness detection 当主 scheduler
2. re-invoke 只能是 single-flight fallback：同一 `(userId, catId, threadId, seenCursor/highWatermark, senders/count)` stale set 最多触发一次
3. 触发前必须检查已有 coverage：queued/newer invocation/freshness re-invoke 已存在则 skip
4. prompt 必须指向能 ack 的读取路径（无 filter 的 `get_thread_context`），或实现显式 D1 ack；不能只说 `list_recent`

**D1.2 queued read/ack journey 重开（2026-07-01 operator 实测）**：

- PR #2664 让 gate/notice 能看到 `InvocationQueue` 中的 queued 消息，但 `get_thread_context` 仍只返回 delivered 消息，猫无法 fetch queued 正文并确认自己看过
- 单纯让猫 fetch queued 正文还不够：`read/seen`、`handled`、`delivery`、`target consumption` 是四个不同语义；把 fetch 直接当 consume 会吞掉多目标并行任务
- 当前推荐方向：full read 只产生 per-cat `queued_seen`；只有成功回应或显式 disposition 才产生 per-cat `queued_handled`；多目标 entry 必须保留其他 target
- 稀疏读取（`keyword` / `messageId` / `catId` filter）默认不 ack queued work，避免猫只看局部结果却把未读队列标成已处理

#### D2: Provider-native 工具的 same-turn notice 覆盖（reopened 2026-07-16）

B1 notice 只覆盖 Clowder AI MCP server 的 tool result。Codex `functions.exec` / `commandExecution` /
`apply_patch` 等 provider-native surface 不经过 Clowder AI MCP callback；2026-07-16 live reproduction 证明
消息可在 native command active 时进入 durable Queue，而当前 `exec --json` turn 继续多个工具边界仍看不到正文。

Phase 0 结论：PostToolUse warning 与外部 polling 都没有 active-turn input 口；满足 D2 需要把 Codex carrier
迁移到 app-server，通过 stable `turn/steer(expectedTurnId)` 在 `item/completed` 安全边界追加 content-free

Claude-family 当前“本轮经常收到”主要来自 B1：成功的 read-only Clowder AI MCP result 每 5 次工具调用
check 一次、一轮最多 3 次；Bash/Read/Edit/ToolSearch 等 provider-native surface 与 cap 后的长尾不覆盖。
Phase A 写门也只保护显式 Clowder AI MCP 发消息路径，普通 stdout final 不经过。默认 `print_sdk` carrier
写完首条 prompt 即关闭 stdin；Claude Code 2.1.210 虽支持 stream-json input，但官方允许工作中消息排为
自己的 internal turn，必须经 live fixture 区分 `exact_active_turn` 与 `queued_internal_turn`。共享 Queue、
notice broker、seen/handled truth 和 eval 不分叉，只在 Codex/Claude 最后一米 adapter 分叉。
operator 未授权 shared core、carrier 迁移与 Claude capability spike 前不写正式实现。

### Phase E: Catch Closure（检测 → 消费 → 处理 → 最终交付）

> ⚠️ **交付语义已被 2026-07-12 玻璃箱裁决推翻**：本节保留的是 v1.2 已落地契约与迁移基线；其中 `supersede_current`、旧 draft 不可见、只允许一个用户可见 final 等条款不得再作为终态实现依据。B 姿态重构必须改为“已完成原回复发表 + 可选补充”。

Phase E 不再增加另一层“提醒猫去读”的 fallback。它改变输出提交坐标：**freshness 是最终答的 commit predicate，而不是完成后的审计标签。**

#### 终态 contract

对 invocation 输入边界之后到达、且对当前猫可路由的每条消息，用户可见 final 只能落入以下一种结果：

1. `publish_current`：当前 invocation 的输入/读取证据覆盖到该 message frontier，输出结束时二次 freshness check 仍为 fresh；
2. `supersede_current`：当前 draft 已 stale，不作为用户可见最终答；系统把缺失正文自动带入已有或新建的 successor invocation，由 successor 重新竞争 final commit；
3. `explicit_disposition`：猫显式 defer/supersede/dismiss，并记录 per-message/per-target disposition；现场向operator说明，而不是静默跳过。

以下都**不能**单独视为 closure：notice attached、stale marker、queued entry 存在、newer invocation 存在、re-invoke enqueued、`queued_seen`、invocation succeeded。

#### 软 + 硬 + eval（ADR-031）

| 层 | Phase E 承重 |
|----|--------------|
| Soft | 工具描述/L0 只负责解释自然断点与 disposition；不再要求猫猜 `responseMode=full` 才能取得关键正文 |
| Hard | 路由输出 commit gate：stale draft 不得成为当前 final；successor 必须拿到缺失正文；closure identity 关联 stale invocation、message frontier、successor 与 committed final |
| Eval | replay 原始“两条连续人类消息”旅程，验证 detect → consume → handled/disposition → committed final 全链；失败任何一段即 verdict fail |

#### 现场可感知性

> ⚠️ **旧 UI 过渡态**：以下 supersede/catching-up 描述只适用于 v1.2 迁移期；B 姿态重构后必须由“原回复已发表 + 相关时追加补充”的可见状态替换，不得继续扣下已完成回复。

当 draft 因 freshness 被 supersede，thread 现场必须出现低噪音状态（例如“世界变了，正在重读 1 条新消息”），并在 fresh successor final 到达后自动收敛。Dashboard 只做事后审计，不能成为第一入口。具体 UI 形态在 Phase E Design Gate 由 operator 确认。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC trace 回 Why（猫发消息时不知道世界变了 → 拦住让猫知道）-->

### Phase A（Freshness Gate MVP）

- [x] AC-A1: 猫调 `post_message` 时，如果 thread 有猫未看过的消息（`latestMessageId > seenCursor`），返回 held 信封而非执行发送——**用独立 seenCursor seq 游标判断，不用 timestamp，不用 deliveryCursor**
- [x] AC-A2: 猫 turn 中途通过 `list_recent` / `get_thread_context` 读过新消息后，seenCursor 推进，再调 `post_message` 不被 hold（**零误 hold 验证**）
- [x] AC-A3: `seenCursor` 不存在时 fail-open 放行（不因缺数据卡死副作用）
- [x] AC-A4: held 信封最多展示 3 条摘要 + omittedCount（防 context 膨胀）
- [x] AC-A5: 猫加 `acknowledgeHeld: true` 可强制发送（escape hatch）
- [x] AC-A6: `cross_post_message` 和 `multi_mention` 同样受 freshness gate 保护（cross_post 检查**目标 thread** 的 seenCursor；目标 thread 无 cursor 时 fail-open）。`callbacks.ts` 传 `isCrossThread ? 'cross_post_message' : 'post_message'` toolName；`callback-multi-mention-routes.ts` 加 freshness gate（含 play-mode visibility filter）+ fail-open + `deliveryCursorStore` DI
- [x] AC-A7: 每次 held/forward 决策记录为**独立 freshness 事件流**（不是 F233 `BallCustodyEvent` 联合成员；F233 projector 可选读取此流做聚合报告）。`checkFreshnessForPostMessage` 新增 optional `eventLog` param，6 条决策路径写 `held_decision`/`forward_decision` 事件，fail-open；route 层（post_message + multi_mention）接入 FreshnessAttentionEventLog。15 新测试
- [x] AC-A8: Redis-backed 测试覆盖游标读写 + held 决策（不用纯 in-memory 假绿）
- [x] AC-A9: **seenCursor 隔离回归**：推进 seenCursor **不得**影响 deliveryCursor 或 `fetchAfterCursor` 增量注入逻辑（回归测试：push seenCursor → 验证 deliveryCursor 不变 → 验证下次 invoke 增量注入不跳消息）

### Phase B（Content-Free Notice + 防无视，三层重设计）

- [x] AC-B0: FreshnessAttentionEventLog（封闭联合类型 + kind discriminator，独立于 F233）+ Redis per-invocation operational state（TTL = invocation timeout）+ F233 projector 可选读取接口
- [x] AC-B1: 猫调只读工具时，如果当前 thread 有未读消息，返回值附加 content-free notice。频率限制：每 5 次工具调用最多 1 次 + max-per-invocation cap=3。messageFilter 复用 Phase A（P0）。scope = 当前 thread only。notice 持久化到事件流。时序：seenCursor ack 后再检查
- [x] AC-B2: 猫调 hold_ball 时，如果有 unresolved notices，返回值附加提醒。不阻塞 hold_ball。选择延期退出时记录 `notice_deferred` 事件
- [x] AC-B3: 猫 invocation 结束时，seenCursor < threadLatestMessageId AND 有 unresolved 高优先级 notice → 触发一次 re-invoke。高优先级 = 人类消息 / 显式 @ / 球权变化。Rate limit: per (cat, thread) per hour cap=3。挂钩 invoke-single-cat terminal event。**merged**: PR #2650 — routing wiring（`route-serial` 消费 `metadata.freshnessReinvoke` + 队列 invocation + cursor-based notice filter + score-aware seenCursorCaughtUp）
- [x] AC-B4: Skip re-invoke 客观判据（5 项可测试条件）：seenCursor 已追上 / newer invocation queued / 球权转移(F233 dep) / self-message only / quota exhausted。每个 skip 记录 `reinvoke_skipped` 事件。**merged**: PR #2650 — `reinvoke_triggered` + `reinvoke_skipped` 事件写入 FreshnessAttentionEventLog（fail-open）
- [x] AC-B5: Eval 指标：notice→ack 转化率（seenCursor 同 invocation 内推进）、notice→defer 率、re-invoke 触发率+有效性（re-invoke 后有回复？）、误唤醒率、token 成本。**merged**: PR #2668 — 7 OTel counters (gate_held/forward, notice_attached/acked/deferred, reinvoke_triggered/skipped) with per-notice granularity alignment. Token cost + reinvoke effectiveness correlation deferred to Phase C eval adapter.
- [x] AC-B6: Privacy/visibility invariant：notice content-free、messageFilter 复用 Phase A、unseen sender list 尊重 visibility rules
- [x] AC-B7: L0 soft layer：staging 加 1-2 行 notice 处理行为约定（不开新 skill，eval 后再定）。`l0-staging-content.md` 新增 `freshness-notice-handling` item（~35 tokens）：自然断点响应未读

### Phase C（Runtime Descriptor）

> **Entry gate:** Phase C 不应吞掉 Phase B.c。默认顺序是先补 AC-B3/B4 routing wiring（dispatch/queue 领域）让 Phase B 真闭环，再开 Phase C descriptor。只有 operator 明确重排优先级时，才允许先做 C。

- [x] AC-C1: Descriptor 从 driver 定义派生（`descriptorFromDriver`），不手维护查表
- [x] AC-C2: `CAT_CAFE_RUNTIME_MODE` 环境变量注入到 callbackEnv + Redis per-invocation carrierTier persistence
- [x] AC-C3: Phase A/B 的 held/notice 行为由 descriptor 参数化（`canReceiveHeldResponse` / `canReceiveContentFreeNotice`）+ `applyDescriptorOverride` held→forward + `descriptorFromProviderFallback` for non-Claude providers

### Phase D（Stream Output Freshness Gate）

- [x] AC-D1: `route-serial` 的 stream text output 存储路径（`messageStore.append({ origin: 'stream' })`）在存储前检查 freshness（seenCursor vs threadLatestMessageId），发现 unseen 消息时标记 `freshness: 'stale'` metadata；re-invoke 仅按 AC-D6 的 single-flight fallback 条件触发
- [x] AC-D2: re-invoke prompt 明确告知猫"你的上轮回复可能未反映最新消息，请调用无 filter 的 `get_thread_context` 查看完整 thread 后回应"
- [x] AC-D3: stale 标记的 stream output 仍然正常存储和投递（fail-open，不丢失工作产出）
- [x] AC-D4: stream output freshness check 记录 `stream_stale_detected` / `stream_fresh` 事件到 FreshnessAttentionEventLog（通过 `onEvent` callback 纯函数模式，route-serial 注入 `FreshnessAttentionEventLog.append`）
  - ⚠️ **回归窗口 2026-07-08 ~ 2026-07-09**：intake #2816（`42e97cdf3`，clowder-ai#1075 整文件覆盖）切断了生产端接线（`index.ts` 不再构造 `FreshnessAttentionEventLog`，`AgentRouter` 不再转发进 `RouteStrategyDeps`），本 AC 在 main 上变成**打勾的死代码**——`deps.freshnessEventLog` 恒为 `undefined`，审计日志一条不写。字段 optional + 消费点条件分支 → `tsc --noEmit` 全程绿。**已由 PR #2823 恢复**，并新增 `test/f254-phase-d-eventlog-wiring.test.js` 守护接线本身（既有 f254-*.test.js 手搓 deps 直调 routeSerial、绕过 AgentRouter，结构上抓不到接线断裂）。
- [x] AC-D5: 猫的 stream output 是自回复（thread 中最新消息是自己发的）→ 不标 stale（self-message 排除，与 Phase A 一致）
- [x] AC-D6: **D1.1 regression fix**：`stream output stale` 不得无条件强制 re-invoke。同一 stale set 必须 single-flight 去重；已有 queued/newer invocation/freshness/current-user same-cat pending coverage 时只标记 stale + 记录 skip，不 enqueue 第二次。**merged**: PR #2701 — D1 single-flight claim + enqueue-outcome release + current-user pending coverage
- [x] AC-D7: **D1.1 ack path**：D1 re-invoke prompt 必须要求可推进 seenCursor 的读取路径（无 `catId`/keyword/messageId filter 的 `get_thread_context`），或实现独立 D1 ack 事件；`list_recent` / filtered context read 不能作为闭环完成凭据。**merged**: PR #2701 — prompt 指向 full `get_thread_context`
- [x] AC-D8a: **D1.2 queued read + freshness suppression**：无 filter 的 `get_thread_context?responseMode=full` 必须能返回 same-target queued 正文；读取后在 `QueueEntry` 上记录 durable per-cat `queued_seen`（suppress duplicate freshness nag for same cat+message）。Sparse reads（keyword/messageId/catId filter）不得返回 queued 正文或记录 `queued_seen`。读取不得 `markDelivered`，不得 consume target。**merged**: PR #2707 — queued bodies remain readable after `queued_seen`, while duplicate same-cat freshness nags are suppressed.
- [x] AC-D8b: **D1.2 handled closure**：cat 对已 `queued_seen` 的 entry 成功回应后，产出 `queued_handled` 证据供 freshness loop 闭环；v1 handled 证据由 `queued_seen(entry, cat, I) + cat-level invocation terminal succeeded(I, cat)` 推断，显式 disposition 延后。**Evidence identity contract**：`queued_handled(entry, cat)` 成立当且仅当存在唯一 invocation `I`，seen 记录时 `I` 是 `(thread, cat)` 的 active invocation，且 seen 与 succeeded 锚定同一个 outer `InvocationRecord.id`。失败/取消不得 consume；delivery persistence + `messages_delivered` emit 未完成时不得提交 `queued_handled`。**merged**: PR #2712 — successful same-invocation handled closure consumes only the completed target, preserves failed/canceled work, emits delivery events atomically, and closes duplicate/retry/connector evidence edges.
- [x] AC-D9: **A2A handoff reply suppression**：如果 B 的消息 `replyTo` 指向 A 自己的消息，且该父消息 mentions B，则 B 的回复是 A 主动发起的 handoff 覆盖，不得让 Phase A gate / D1 / B1 把它当作需要 hold 或重新唤醒 A 的未读 freshness；普通未被父消息 mention 的其他 cat 回复仍按 freshness 候选处理。
- [x] AC-D10: **Current trigger suppression**：connector/event/user message 如果就是当前 invocation 的触发消息（`currentUserMessageId` / trigger `messageId`），说明它已经进入本次 prompt；D1 stream freshness 不得再把同一个 message 计为 unseen 并 enqueue `Freshness -> cat`。其他非触发 connector 消息仍按 freshness 候选处理。
- [x] AC-D11: **Routable freshness input**：Phase A gate / B1 notice / D1 stream stale 只看可路由 conversation 内容。空正文且仅含 tool events 的 cat stream、`routing-guard-failure` 等内部诊断、`system` display-only 消息、`context_briefing`/`origin=briefing` 不得产生 held/notice/stale/re-invoke；rich blocks / contentBlocks 仍算可路由内容。`userId=scheduler` 的 hold-ball / scheduled-task trigger 含正文且会进入下一次 prompt，必须保留为 routable freshness input。

**D1.2 Ownership boundary**：F039/F117 的 `QueueEntry` / `QueueProcessor` 单一拥有普通 queued user message 及其 per-target `queued / notified / seen / failed / handled` transition；F254 只消费该真相来压制 freshness nag，且不得为同一消息生成 supplement carrier。F086 继续拥有 canonical `TargetStatus` 语义与 per-recipient UI/routing consumption；F108 拥有独立 fan-out context cutoff。

### Phase D2（Provider-native safe-boundary notice；Codex exact-turn + Claude capability split）

- [x] AC-D12: **Same-turn cognition delivery**：Codex carrier 在 supported provider-native
  `item/completed` 安全边界，把 content-free notice 追加到 exact active turn；默认不 cancel/restart。
  `exec --json`、UI warning、queued event 与 PostToolUse `systemMessage` 不得计作 delivered。
- [x] AC-D13: **Truth lifecycle**：逐 notice 持久区分 `opportunity → delivered | missed → seen → handled`。
  `turn/steer` 带 `expectedTurnId` 且被同一 turn 接受才是 delivered；只有 full exact Queue read 是 seen；
  missed/unseen 都保留 Queue ownership 与下一轮兜底。queued-only synthetic cursor 不得兼任 notice 去重或
  receipt identity；同一 durable Queue identity 跨 safe boundary 只产生一次 attempt，identity 扩展后才重新 eligible。
- [x] AC-D14: **Carrier parity + no replay**：app-server mode 必须证明 session chain、auth/config、
  sandbox/approval、tmux duplex、tool policy、timeout/cancel、raw archive 与 F212 terminal truth parity。
  `turn/start` accepted 或任一 item started 后，禁止静默 fallback 到 `exec --json` 重放副作用。
  PR #3097（`54aef5e74`）完成 a-e；PR #3079/#3082 已分别完成 f/g。
  - [x] **AC-D14a Stage truth**：统一投影 `child_spawned → initialized → thread_ready → turn_accepted →
    active → completed | interrupted | failed → closing → closed`；每次阶段变化带 `lastActivityAt`，direct/tmux
    与 F5 hydration 消费同一 canonical state，不从“有无 stdout”猜阶段。
  - [x] **AC-D14b Pre-turn recovery fence**：仅 `turn/start` 尚未 accepted 且无 item / side effect 时允许
    自动重启 transport，默认预算 1；若 thread 已建立，必须复用其 identity。accepted turn 后 restart / fallback /
    prompt replay 均 fail closed。
  - [x] **AC-D14c Protocol-first Cancel**：人工 Cancel 与运营者显式正数 `CLI_TIMEOUT_MS` 先发送
    `turn/interrupt(threadId, turnId)`，等待 `turn.completed(status=interrupted)`；grace 耗尽后才允许
    SIGTERM → SIGKILL。默认 `CLI_TIMEOUT_MS=0` 保持 active turn manual-only。
  - [x] **AC-D14d Terminal cleanup**：已有 completed / interrupted / failed 权威终态、但 child 不退出时，
    有界强制回收且 terminal cause 不被 process exit 覆盖；cleanup failure 只影响 carrier health，不改写业务结果。
    `interrupted` 只证明 turn 的业务终态，不证明 app-server 已清空内部 active-turn slot；该 host 必须淘汰，
    不得进入 warm reuse / session affinity。正常 `completed` / `failed` 仍可按 carrier health 走普通释放。
  - [x] **AC-D14e Explicit continue**：中断后只能由用户显式开启新 turn；`thread/resume` 恢复上下文但不
    宣称 exactly-once 续接，恢复输入要求先核对既有 tool/workspace 事实，禁止自动重放旧 prompt。
  - [x] **AC-D14f Transport crash isolation**：LF-only JSONL decoder 保留 U+2028/U+2029 合法内容，
    direct/tmux framing 同源；pump rejection 终止单颗 invocation 而非 API。PR #3079（`3b83fb43c`）。
  - [x] **AC-D14g Provider-neutral diagnostics**：Codex app-server failure 不进入 Claude-only structured
    diagnostic path；已见 disconnect wording 分类为 network error。PR #3082（`7dd7a4d51`）。
  - [x] **AC-D14h Capacity checkpoint continuation**：`turn.completed(status=failed)` 且错误精确等于 provider
    model-capacity terminal 时，允许在同一 native thread 开一个有界恢复 turn，但不得发送通用“继续”。pre-tool
    恢复绑定 exact interrupted turn；post-tool 还必须同时具备 Clowder AI child invocation + prompt message IDs、
    最新 `turn/plan/updated` 与逐 item terminal 账本。任一工具仍 in-flight 或 checkpoint 不完整即 fail closed；
    续接语义是 at-least-once，prompt 强制 verify-before-redo，不扩大 cwd/sandbox/approval/tool/授权边界。
    中间重试留在 status channel；`blocked_inflight_tool` / `checkpoint_incomplete` / `budget_exhausted` 各保留
    一张用户可见断点卡。AC-D14e 对人工 interrupt / timeout 继续成立，本条只处理 provider 已给出的 failed 终态。
    PR #3285（`65ef23d17`）。

> **AC-D14 lifecycle projection stateful-object gate**：canonical read 保留 parent execution owner 与 child turn
> identity 两套坐标；tracker 只能在其 `getUserId(threadId, catId)` 等于本次 request user 时提供 lifecycle owner。
> public/system thread 可继续暴露既有 bare active slot，但不得跨用户附带 stage、`failureReason` 或 cleanup truth。
>
> | read path / event | lifecycle owner | forbidden projection |
> |---|---|---|
> | canonical parent→child | same-user active tracker execution；否则 canonical parent execution | foreign tracker replacement |
> | legacy stores omitted | same-user tracker execution；否则 none | foreign tracker lifecycle |
> | canonical helper throws | same-user tracker execution；否则 none | foreign tracker lifecycle |
> | same-cat replacement | replacement execution only | prior execution cleanup/terminal snapshot |
>
> **INV-D14-L1（endpoint-testable）**：只有 request-owned active execution 能关联 lifecycle snapshot；未知或 foreign
> ownership fail closed 为无 lifecycle。对抗矩阵固定覆盖 canonical cleanup/replacement/foreign owner，以及 legacy 与
> helper-throw 两条 public/system-thread fallback；裸 slot 是否可见维持既有 Queue 产品契约，本轮不扩大。
- [ ] AC-D15: **Provider × tool-surface eval**：按 provider、carrier、tool surface 记录
  opportunity/delivered/seen/missed，并区分 `exact_active_turn` / `queued_internal_turn` /
  `mcp_result_piggyback` / `unsupported`；Codex 与 Claude 的 command/file-change/non-Cat-Café MCP /
  Clowder AI MCP 逐格报告。
  MCP-only fixture 不得输出 all-tool healthy verdict。
  app-server lifecycle 的 stage duration / retry / interrupt / forced cleanup 是 OTel 工程 telemetry，不能混入
  freshness coverage verdict，也不能创建无 ground truth 的“最长合法静默”指标。
- [ ] AC-D16: **Live regression**：Redis 6398 隔离 fixture 在 native command active 时 enqueue 消息，
  证明同一 turn safe-boundary notice → full exact read → same-invocation seen/handled；late/no-boundary 对照必须
  honest missed、当前回复 exactly-once 发表、Queue 下轮兜底。
- [ ] AC-D17: **Claude carrier capability truth**：保留并单独计量现有 B1 pull 与显式 MCP 写门；
  `print_sdk` 文本输入不得声明 native same-turn coverage。Redis 6398 隔离 fixture 以 Claude Code
  stream-json 持续输入验证 content-free notice，`--replay-user-messages` 回显只算 transport evidence；
  full exact Queue read 才是 seen。实测若只进入 queued internal turn，必须如实标记，不冒充 exact active turn。
- [x] AC-D18: **MCP cap anti-silence**：现有 `INTERVAL=5 / MAX_NOTICES=3` 只属于 B1 pull 噪音预算；
  provider-native adapter 不得无审计继承。任何 rate-limit/cap 抑制都记录 missed，eval 必须暴露长 invocation
  静默尾区，不能让 Claude 高频 MCP 行为把 Codex/Claude native-tool coverage 平均成健康。

#### 2026-08-04 protocol census / carrier truth live blocker

正常 runtime UAT 在 exact Codex app-server child 中观察到四次完成的 `collabAgentToolCall/wait`，第一条
`continue_current` Queue message 在首个 completion 前约 64 秒已经 durable admission，但整轮没有
`turn/steer`。这不是 timeout，也不是消息丢失：当前 classifier 对未知 completed item 返回无 boundary，
focused test 又硬编码同一组 command/file/MCP/dynamic，因此 provider protocol 漂移同时逃过实现与 eval 分母。

Codex 0.146.0 schema 还声明 `webSearch`、`imageView`、`sleep`、`imageGeneration` 与
`subAgentActivity`。不能把它们一律当 safe：每个 variant 必须被协议 census 明确归为 safe tool boundary、
intentional non-boundary 或 deferred/no-data；新 variant 未分类时 gate 失败，并将 item type/status 记入有界
unknown telemetry。Claude 的 native tool-name classifier 已有 dynamic fallback，但默认 `print_sdk` carrier
明确 unsupported；Kimi 的 `kimi_stream_json` 也必须显式声明 `unsupported/no_data`，不得从 Clowder AI MCP
piggyback 推断 native coverage。

完整 UAT、provider/carrier matrix 与 repair contract 见

> **Implementation gate**：AC-D12~D18 的架构、race 与 RED 规格已冻结于
> operator 已于 2026-07-16 授权 Phase 1。AC-D12/D13/D18 由 default-off implementation + direct/tmux
> live fixture 证明；AC-D14 已由 PR #3079/#3082/#3097 闭合。AC-D15~D17 仍是默认启用前的 rollout gate，
> 不因 capability spike、MCP-only 证据或代码 merge 提前扩大默认范围。

### Phase E（Catch Closure，2026-07-09 愿景重开）

- [x] AC-E1: 定义并实现 final commit predicate：对当前猫可见的 routable message frontier，final 只能是 `publish_current` / `supersede_current` / `explicit_disposition`；每个结果都有可追溯 evidence identity；serial + parallel 的所有 answer-bearing stream 出口都必须在 MessageStore raw thread frontier 上走原子 conditional append，不能留下 TOCTOU 或 route-parallel stale-final bypass
- [x] AC-E2: 当 stream output 在 commit boundary 检测为 stale 时，旧 draft 不得成为 thread 的用户可见最终答；允许保留为 invocation/debug evidence，但不得冒充当前回复
  - ⚠️ **2026-07-12 玻璃箱裁决覆盖**：AC-E1/E2 的 `[x]` 只表示旧 Phase E 机制曾落地；`supersede_current` 与“旧 draft 不得可见”已被 B 姿态推翻。终态重构必须改为“原回复发表 + 可选补充”，不得据此继续实现扣押。
- [x] AC-E3: successor invocation 自动获得导致 stale 的完整消息正文；不能依赖猫手动猜出 `responseMode=full`，也不能把 content-free notice 当正文消费证据
- [x] AC-E4: `existing invocation coverage` 只做 enqueue 去重；系统必须把 stale invocation → missing message IDs/frontier → successor invocation → committed final 串成 closure，只有 existing coverage 而无后续 commit 必须保持 unresolved
- [x] AC-E5: `queued_seen + succeeded` 不再作为用户体验层“已接住”的充分条件；handled/disposition 与 committed final 必须有更强的同一 message-set 证据，failed/canceled/crash 不得误闭合
- [x] AC-E6: 连续新消息采用单调 frontier + bounded supersede；每条 lineage 具备 one-running + one-pending 去重，scope 另有 one-running-successor lease，但允许多个 pending/blocked lineage 共存；per-retry-epoch automatic successor attempt 与 per-output conditional-append recheck 均有上界。预算耗尽只 block 当前 lineage 并保留显式 retry/disposition，绝不发布 stale、静默吞 unresolved message 或阻断独立新 work
- [x] AC-E7: multi-target 继续 per-target 隔离：一只猫的 consume/handled/commit 不推进其他 target；parallel route 创建稳定 `parallelBatchId`，同批 sibling outputs 不进入彼此 relevant frontier，其他新消息仍推进每猫 closure；independent fan-out cutoff 仍归 F108
- [x] AC-E8: thread 现场展示低噪音 catch 状态，fresh final 后自动收敛；dashboard 仅作深挖，重复 supersede 必须 dedup；blocked 在 Hub 与 connector 都必须成为明确终态/重试指引，不能永远显示 catching-up
- [x] AC-E9: `eval:freshness` 接入 replayable source + verdict generator，覆盖原始双消息 dogfood、existing-coverage-without-closure、crash/cancel、连续新消息、multi-target、parallel same-batch、attempt/recheck budget、connector blocked 八类结构性 fixture；每次 publish 必跑八类 server-owned fixture，caller 不可挑选证据；fixture-only 明确为 `no_data` 且绝不 healthy，live facts 与 aggregate snapshot 从同一 durable closure 集合推导。`2936df429` 的真空绿缺陷由 formal review 揭示，修复在 latest-main-equivalent `d93dda62e` 以每个 violation predicate 的 RED、mandatory coverage、subset rejection 与 live duplicate/stale custody 证明转绿；待 exact-head gate/re-review 与 PR/cloud/CI。
- [x] AC-E10: 约定面接线纳入 convention graph / wiring guard；intake 整文件覆盖若切断 commit gate、closure event 或 eval adapter，`pnpm gate` 必须失败
- [x] AC-E11: **restart recovery fence**：process startup 不是新的用户意图。启动时发现的 `pending` closure 必须持久化为 `blocked:startup_recovery_requires_explicit_retry`，不得自动召猫；仅仍处于 `running` 且未超过 invocation liveness horizon 的崩溃 attempt 可 recover-forward。blocked projection 必须可由 F5/reconnect hydration 重建，显式 retry 继续复用同一 closure/retry epoch；queued body 读取继续按 target cat 隔离。
- [x] AC-E12: **lineage custody / poison-pill removal**：scope active truth 从单 pointer 改为 lineage set + one running lease；只有 exact `freshnessClosureId` carrier 可影响该 lineage。旧 pending/blocked ticket 不得吞独立新回答；新 stale turn 必须开自己的 lineage。所有 route exit 在删除 DraftStore 前必须收到 typed draft custody，且每轮有 exact `turnInvocationId` + formal outcome。
- [x] AC-E13: **current attributable recovery**：closure 持久化 immutable `originTriggerMessageId`；retry/adoption 在 claim/model 前 target-aware 扫到 current raw frontier 并 CAS refresh，证据不完整则 `freshness_preflight_incomplete`。中心 relevance policy 排除 other-target、other-cat replacement 与 same-batch sibling。浏览器 cancel 需要 connected-client `origin/actionId/clientInstanceId`，cross-thread gate 按 effectClass + typed causal overlap 分级。

### Phase E-B ✅（ADR-042 Glass Box，2026-07-12 交付语义翻转；merged PR #2906）

- [x] AC-E14: **发表不可剥夺**：serial / parallel 的 answer-bearing completed output 先用 `appendAndObservePriorFrontier` 无条件原子发表，并在同一操作返回 append 前 raw frontier；freshness 扫描、metadata refinement 或 supplement store 失败均不得撤回、重复或阻止原文交付。
- [x] AC-E15: **独立 supplement lifecycle**：每个 published original 形成 lineage；`{lineageId, seq}`（最多 2）持久执行 `pending → running → committed | declined | failed`，pending 聚合、running 后到进入下一 seq、预算耗尽可水合，不复用 legacy closure final carrier。
- [x] AC-E16: **自动补充只读硬边界**：QueueProcessor 在模型启动前 claim exact carrier、重建原文 + required updates，并传递 fail-closed `ToolExecutionPolicy`；provider 启动参数与 callback alias normalization 双层禁止 mutating/replay-unsafe tools，无法保证时在启动前持久失败。
- [x] AC-E17: **玻璃箱 UI / transport**：原文在 Hub、F5 hydration 与 connector 中始终作为正式消息；supplement 用当前时间戳、`replyTo=originalMessageId` 的普通回复气泡；declined/failed/budget 状态只挂原文且永不静默。
- [x] AC-E18: **carrier 终态覆盖**：queue full、scheduler 缺失、排队撤回、provider/cancel/policy failure 全部落 durable terminal；进程启动重建 pending carrier，running 若已有幂等正文则直接 commit，若无正文才持久失败，禁止重跑已发表 supplement。
- [x] AC-E19: **精确边界与兼容迁移**：annotation 只扫描 atomic pre-append frontier；幂等 retry 复用原消息与原 observation boundary；legacy running closure 在新原文发表后可 terminalize，但旧 `superseded_positive_stale` 只保留为未完成/历史兼容语义。
- [x] AC-E20: **可观测性**：记录 `published_with_unseen`、`supplement_offered`、`supplement_produced`、`supplement_declined`，并用 focused API/Web/Redis/connector fixtures 覆盖原文不消失、补充不替换、失败不静默。
- [x] AC-E21: **Queue 单一所有权与发表不变量**：普通 queued user message 不得同时进入 supplement lifecycle。猫实际读到 exact message 才记录 `(messageId, targetCat, invocationId)` ACK；成功后 handled 且不再 spawn，未读则自然下轮 spawn，失败/取消标记 failed 并回队。Steer 只允许“取消当前 invocation + 立即以同一条消息启动一次”。所有路径都不得扣押 completed original；per-target 五态必须在 F5/reconnect 后水合一致。
- [x] AC-E22: **Queue restart-durable custody**：普通 queued user message 在 MessageStore 上持久保存 revisioned、TTL=0 custody；API restart 必须按原 `messageId / entryId / position / target` 确定性重建 Queue owner。exact seen 仅在同一 invocation 的 immutable per-target `successfulCatIds` witness 包含该猫时 handled；aggregate parent `succeeded` / target membership 不得代替逐猫证明，缺失 witness、失败、取消与 restart-crash 均回 `failed/queued`，多 target 独立恢复。不得用 `markDelivered` 把尚未执行的责任降级成仅可见 timeline 消息。Formal review 进一步证明 A2A worklist growth、provider failure + bare done 与 fail-silent writer 会破坏该 witness；`d93dda62e` 固化 immutable target domain、typed rejection、checked terminal writers 与 per-record startup isolation，聚焦与隔离 Redis 回归已绿，待 exact-head gate/re-review 与 PR/cloud/CI。
- [x] AC-E23: **legacy closure 全量核销迁移**：迁移以全部 active legacy closure 为根集合，逐 attached withheld invocation 分类为 `already_formal_exact / already_recovered_exact / recoverable_text / no_text / conflict`；conflict fail-closed。只有所有 invocation 均有 exact message/evidence 或审计化 no-text 归宿后，closure 才以显式 `legacy_migrated` disposition terminalize；不得伪装成用户 dismissed。恢复复用 exact transcript proof + idempotent append，零 route/Queue/Socket/A2A；重跑不复制正文或递增 revision。当前分支 provenance 为 formal-review base `2936df429` + latest-main repair `d93dda62e`；sanctioned random-port Redis 已证明 dry-run/apply/idempotency/write-ahead journal，生产 apply 仍需独立 manifest + operator 授权。

### Phase E-C ✅（Child Execution Truth + Typed Causal Relevance，2026-07-16 实弹重开）

Architecture cell: `ball-custody` + `dispatch` + `bubble-pipeline`
Map delta: completed — `ball-custody` 登记 typed causal relevance，`dispatch` 登记 shared child ledger，`bubble-pipeline` 登记三类 child 的 live/F5 projection。

现场 anchor：`incident:[thread-id]/0001784219578304-000230-3dd8e178`。
M1 只路由 Fable；M2 的“你也看看”让 Sol 本轮 prompt 正常覆盖 M1。Fable 对 M1 的后到 sibling reply
属于同一用户波次的已覆盖因果结果，却被旧 relevance policy 当成 Sol 新工作，再创建一个 supplement；同一
parent 下的 ordinary、routing guard、freshness supplement 又只能在短 TTL auth registry 中暂时看见，无法作为
restart/F5 的历史真相。

本 Phase 不回退 ADR-042：完成的原回复始终发表；它只收紧“什么才值得追加 supplement”以及“追加 execution
如何留下 durable glass-box truth”。

- [x] AC-E24: ordinary / routing guard / freshness supplement 均在 provider 前写入独立 TTL=0 child ledger，并以 child invocation ID 唯一水合 kind、起止、终态与 terminal reason；parent aggregate 与 auth TTL 均不得替代
- [x] AC-E25: MessageStore 持久 typed causal provenance（至少含 reply 的 `triggerMessageId`）；policy 同时消费本轮真实 prompt coverage IDs，禁止用时间窗口、日志、文案或 NLU 推断同波次
- [x] AC-E26: 当后到 sibling reply 的 typed trigger 已在当前 Sol prompt coverage 中、且消息未显式定向 Sol 时，reason=`same_user_wave_sibling_reply`，不得生成 supplement
- [x] AC-E27: 显式定向 Sol 或独立新 causal trigger 仍 relevant；同一 late message 重扫只产生一个 supplement，ordinary parent/Queue 仍只消费一次
- [x] AC-E28: supplement 的失败、取消、interrupted 与成功均有可水合 terminal；原回复继续发表，失败不得被静默或伪装成普通猫召唤
- [x] AC-E29: telemetry 与 API/UI 只消费 typed kind/relevance reason；M1→M2→Fable sibling、directed late、independent late、repeat scan、cancel/restart glass-box fixtures全绿，并通过 latest-main gate + Terra exact-HEAD review

### Phase E-D（Legacy Closure Historical Projection，2026-07-22 实弹重开）

Architecture cell: bubble-pipeline

Map delta: none

Map delta why: 本轮只修正现有 Web closure projection / hydration 的时间线归位与历史责任呈现，不新增 Store、Router 或数据 owner。

现场 anchor：`[thread-id]`。2026-07-11 的两条 active legacy closure 在 2026-07-22
重新打开 thread 时被 Web hydration 追加到最新 F271 终态回复下方；消息本身完整持久化，但旧责任被视觉
伪装成当前“吞消息”。事故胶囊：

- [x] AC-E30: blocked closure projection 保留 durable `updatedAt`、source invocation 与可解析的 exact source message identity；source 已加载时紧邻原 bubble，未加载时按 closure timestamp 排序，禁止 append 到当前尾部
- [x] AC-E31: `originTriggerMessageId=null` 的 legacy closure 明示为历史责任并展示自己的月日/时分；不得使用会被理解成“刚发生”的当前责任文案
- [x] AC-E32: legacy closure 不暴露 one-click retry，只指向 AC-E23 迁移核销；current attributable blocked closure 的显式 retry 契约保持不变
- [x] AC-E33: background legacy hydration 不制造 unread 或推进 `lastActivity`；active/background/F5 投影共用相同 lineage/time 规则并按 closure ID 幂等

<!-- F254_MANUAL_REMINDER_SCOPE: optional-nonblocking -->

**人工提醒范围**：人工“提醒猫”按钮/endpoint 是可选的独立产品能力，不属于 F254 本次完成的阻塞门槛；自动 freshness notice 不是人工“提醒猫”按钮，既不能冒充其 request/delivered/seen/missed 交付，也不要求 F254 为未立项的按钮补 UI/API。

> ⚠️ **交付语义已被 2026-07-12 玻璃箱裁决推翻**：以下只保留 v1.2 的 lineage / lease 并发约束；“one user-visible final”与“draft supersedes”不再是终态交付契约。B 姿态重构后，用户可见语义必须是“原回复发表 + 同 lineage 可选补充链”，并发安全不得再靠扣押已完成回复获得。

**Phase E corrected concurrency contract (amended 2026-07-11):** one user-visible final per explicit closure lineage, not one model pass and not one closure per scope. If A+B both precede the same lineage preflight they coalesce; if B arrives after preflight but before final, A's draft supersedes and a later attempt may run; independent new work without that exact carrier commits normally when fresh or opens another lineage when stale. A scope may retain multiple pending/blocked responsibilities but only one successor may hold the running lease. Parallel fan-out excludes same-batch siblings; automatic attempt/recheck budgets exhaust into blocked for that lineage, never stale delivery or future-turn poison.

## Dependencies

- **Evolved from**: F233（Ball Custody Observability）— 事件流**架构模式**的地基（append-only log + projector）。F254 的 freshness 事件是**独立事件流**（不是 `BallCustodyEvent` 联合成员），F233 projector 可选读取做聚合报告
- **Related**: F167（A2A Chain Quality）— 上游传球质量；F254 是"传球那一刻的 freshness 检查"
- **Related**: F069（Thread Read State）— ThreadReadStateStore 可复用
- **Related**: F193（Message Routing）— post_message 路由守卫
- **Related**: F086（Multi-Mention Orchestration）— per-target `TargetStatus` 语义和 per-recipient UI/routing consumption 归 F086（ADR-040）
- **Related**: F108（Side-Dispatch Concurrent Invocation）— 独立 fan-out context cutoff 归 F108（ADR-040）
- **Related**: F117/F039 — queued delivery lifecycle 底层语义
- **Architecture**: ADR-040（Per-Target Queued Message State Model）— 统一 read/handled/consume 四层语义

## Risk

| 风险 | 缓解 |
|------|------|
| 误 hold 导致猫猫体验退化（被频繁拦截） | seq 游标（不是 timestamp）+ fail-open + `acknowledgeHeld` escape hatch + 显式排除自己发的消息 |
| held 信封撑爆 context（大量未读时） | DEFAULT_HELD_CONTEXT_LIMIT=3 + omittedCount |
| seenCursor 性能（每次副作用工具多一次 Redis 查询） | 复用 DeliveryCursorStore 基础设施（已有内存缓存层），独立 key 前缀，单 key GET |
| **seenCursor 误推 deliveryCursor 导致消息跳过**（B1 blocker 根因） | seenCursor 独立 key 前缀，AC-A9 回归测试；代码 review 重点检查项 |
| re-invoke 循环（notice → re-invoke → 又有 notice → 再 re-invoke） | 每 invocation 最多 1 次 re-invoke，parentInvocationId 去重 |
| **D1 forced re-invoke 循环**（2026-06-30 实测，PR #2691 回归） | 已修复 PR #2701：D1 不再 unconditional enqueue；同一 stale set single-flight 去重；已有 current-user same-cat pending / queued / freshness coverage 则 skip；enqueue full 时释放 single-flight claim；prompt 指向可推进 seenCursor 的 full `get_thread_context` |
| **已有 event/connector coverage 被重复唤醒**（2026-07-05 实测） | D1 排除当前 invocation 的 trigger message；event 已经唤醒猫并进入 prompt 时，不再追加 `Freshness -> cat`。非 trigger connector 消息仍保留 freshness 保护 |
| **内部/空消息被当成 freshness 输入**（2026-07-05 实测） | Phase A/B/D 共享 `isFreshnessRoutableMessage`：排除空 tool-only stream、route-guard 失败诊断、system display-only、context/briefing；避免将“猫正在工具调用”或内部提示误报成另一只猫/operator的新消息。Scheduler trigger 消息是 prompt-visible work，不在内部噪音过滤内 |
| 跨 thread cross_post_message 的 freshness 判据不清 | 检查**目标 thread** 的 seenCursor（猫要发到的地方），不是源 thread；目标 thread 无 cursor 时 fail-open |
| **排队中消息对 gate 不可见**（2026-06-29 实测发现，**已修复** PR #2664） | ~~F117 设计冲突~~ → 已通过 `QueuedMessageChecker` interface 解决：gate 在 delivered-message check 无结果或全 self-message 时 fallback 查 `InvocationQueue.list()`，三条 freshness 路径全部 wired。合成 `maxMessageId` 用 `generateSortableId(Date.now())` 确保 notice 可 resolve |
| **排队中消息可检测但 read/handled/target consumption 语义未定**（2026-07-01 实测发现） | D1.2 讨论重开：full read 应解决 queued 正文 fetch + per-cat `queued_seen`；consume-on-read / markDelivered-on-read 会破坏 delivery/read/handled 分层，需改成 seen/handled 两阶段。Durable per-target storage/execution 在 QueueEntry/QueueProcessor，F086/F108 消费语义分别处理 multi-recipient 状态和独立 fan-out cutoff |
| **operator消息 vs 猫消息优先级未区分** | 当前 gate 对所有 unseen 消息一视同仁；B3 re-invoke 已区分高优先级（人类消息 > 猫 chatter，KD-9），但 gate 本身没有。operator消息（"算了不做了"）的时效性高于猫间 chatter，可能需要 gate 层也引入优先级——例如operator消息即使 queued 也 hold，猫消息只 notice |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | **用独立 seenCursor（不是 deliveryCursor，不是 timestamp 窗口）** | timestamp 会误 hold（猫看过的消息仍然 > createdAt）；deliveryCursor 驱动增量注入不可混用（B1 blocker）；独立 seenCursor 复用同一基础设施 + 独立 key 前缀（mentionAckCursor 先例），精准区分"看过/没看过"（opus-48 源码核验 Raft `modelSeenSeq` 机制） | 2026-06-27 |
| KD-2 | **Fail-open（cursor 不可信时放行不 hold）** | 宁漏 hold 不错 hold——错 hold 卡死副作用比偶尔漏 hold 严重得多（Raft `inboxTrustState` 同策略） | 2026-06-27 |
| KD-3 | **三个 surface 合一个 feature，不是三个独立 feature** | 它们共享 seen 边界（seenCursor）+ 共享 freshness 事件流 + descriptor 参数化 notice/hold 行为；独立拆会导致三套基础设施 | 2026-06-27 |
| KD-4 | **Phase A 先做（不是 Descriptor 先做）** | gate 行为本身 runtime-invariant（MCP 工具层拦截 + seq 比较，不依赖 agent 感知通道），现有 runtime 的 busyDelivery 行为同质，Descriptor 可在 Phase A/B 中硬编码；价值最高的 held draft 不应等 descriptor 就绪。48 建议 descriptor 先行的理由（异构 runtime 参数化）在我们有多模式时再生效 | 2026-06-27 |
| KD-5 | **Raft 有 prompt 级防无视（L2334/L2641），不是"什么都没有"** | 修正 seed 的事实错误。我们的优势是 harness 级（re-invoke）不是"他们没有我们造"。避免过度造轮子 | 2026-06-27 |
| KD-6 | **Phase B 基础设施先行（B0 → B1 → B2 → B3/B4）** | AC-A7 事件流是 B1/B2（工具层）和 B3/B4（harness 层）的通信通道，不是审计日志。没有它两层断开（opus/opus-47/codex 三猫共识） | 2026-06-28 |
| KD-7 | **操作状态(hot) 和事件流(cold) 分层** | 事件流 query 全 log 太重用于 hot path 决策；per-invocation Redis counters + TTL = hot path（opus-47 洞察） | 2026-06-28 |
| KD-8 | **ack = implicit（seenCursor 推进）** | Phase A 已走 implicit 路线，对齐；显式 ack 增加猫认知负担（KISS）；事件流记录 `notice_implicit_acked` 便于 audit（opus-47 + codex 共识） | 2026-06-28 |
| KD-9 | **Re-invoke 只对高优先级 notice 触发** | 人类消息/显式@/球权变化才 re-invoke；普通猫 chatter 只 notice 不 re-invoke（codex 建议，防高并发 thread 尾递归式唤醒；保守起步可扩展） | 2026-06-28 |
| KD-10 | **Phase B scope = 当前 thread only** | 跨 thread notice 膨胀 scope，延后处理（opus-47 建议） | 2026-06-28 |
| KD-11 | **D2 lifecycle parity 原位补 F254，不拆新 Feature** | app-server 是 F254 为 provider-native same-turn notice 引入的 carrier；AC-D14 / R39 已预注册 timeout/cancel/liveness/no-replay。拆号会产生两个 carrier owner | 2026-07-20 |
| KD-12 | **active turn 默认 manual-only；pre-turn 才能自动恢复** | `turn/start` accepted 前可证明尚无业务副作用；accepted 后 inactivity 无法区分 slow continuation 与 dead。沿用 F118 operator override，不用新 carrier 绕过旧政策 | 2026-07-20 |
| KD-13 | **Cancel 先走 `turn/interrupt`，OS signal 只作 bounded cleanup** | app-server 有 threadId + turnId 与 authoritative `interrupted` terminal；直接 SIGINT 只能证明进程收到信号，不能给业务 turn 权威终态 | 2026-07-20 |
| KD-14 | **resume 是新 turn，不自动 replay** | `thread/resume` 恢复上下文后仍会 `turn/start`，无法保证半个旧 turn exactly-once；自动重放可能重复 shell/MCP/file side effect | 2026-07-20 |
| KD-15 | **lifecycle 数字归 runtime observability，不冒充 Eval Hub 指标** | stage duration / retry / interrupt / forced cleanup 是工程事实；机器不能仅凭 silence 标注“合法”。仅 pre-turn retry 保留有 consumer 的限时 keep/tune/sunset 检查 | 2026-07-20 |

## Eval / Tracking Contract

### Primary Users + Activation Signal
- **Primary users**: 所有猫猫（通过 MCP 工具发消息时自动触发）
- **Activation signal**: 猫调副作用 MCP 工具 + thread 有 unseen 消息 → held 信封

### Friction Metric
- **误 hold 率**：猫已看过消息但仍被 hold 的比例（目标：趋近 0%——独立 seenCursor 应消除大部分此类，但跨 thread cursor 初始化等边缘场景可能残留极少数）
- **acknowledgeHeld 使用率**：猫选择强制发送的比例（高 = held 信息不够有用，或 hold 太频繁）
- **re-invoke 触发率**：Phase B.c 自动 re-invoke 的频率（高 = 猫经常无视 notice，notice 设计需改进）
- **queued read/handled 缺口**：`cat_cafe.freshness.queued_seen` 与 `cat_cafe.freshness.queued_handled` 的差距（高 = 猫读到 queued 正文但未闭环、失败保留、或 `succeeded=handled` v1 推断需要校准）
- **eval:freshness registry**：`docs/harness-feedback/eval-domains/eval-freshness.yaml` 注册并启用 F254 freshness eval 域；`f254-freshness-replay` adapter 从 server-owned fixtures 或 durable closure truth 生成有界 replay artifact，publish generator 只消费其派生 metrics / samples / provenance。零 eligible data 必须输出 `no_data`，避免 silent-green。
- **D2 carrier coverage**：provider × carrier × tool-surface 分格记录 notice
  `opportunity / delivered / seen / missed`。`codex_exec_json` 对 provider-native surface 必须报告
  `missed:unsupported_carrier`；`mcp_result_piggyback` 只证明 MCP 单格，不得外推 all-tool coverage。
- **D2 lifecycle operational telemetry（非 Eval Hub 指标）**：stage transition / duration、pre-turn retry、
  interrupt request/result 与 forced cleanup 进入现有 OTel invocation/provider spans，供故障定位与 rollout
  审计；不计算“最长合法静默”，不从 inactivity 推断 dead。pre-turn retry 上线后只做一次有明确 consumer 的
  keep/tune/sunset 检查：startup failure 是否下降，duplicate accepted turn 必须为 0。

### Regression Fixture
1. 猫 invoke 后 thread 有新消息 → 猫调 post_message → 收到 held（不是正常发送）
2. 猫 invoke 后 thread 有新消息 → 猫先 list_recent 读了 → 再 post_message → 正常发送（seenCursor 已推进，不 hold）
3. 新 thread 首次 invoke，无 seenCursor → post_message → 正常发送（fail-open）
4. held 信封 preview 不超过 3 条（context cap）
5. **seenCursor 隔离**：推进 seenCursor → 验证 deliveryCursor 值不变 → 验证下次 invoke 增量注入不跳消息（AC-A9）
6. unseen 消息全部是自己发的 → 不 hold（self-message 排除）
7. **stream output 路径**：operator发消息 → 猫 invocation 启动 → operator又发一条 → 猫 stream 输出文本 → 检测到 unseen → 标记 stale + 触发 re-invoke（不只靠 B3 cursor 判断）
8. stream output 路径：所有 unseen 消息是自己发的 → 不标 stale（self-message 排除）
9. **D1.1 回归**：同一 stale set（same seenCursor/highWatermark + same senders/count）已触发过 freshness re-invoke，但猫只调用 `list_recent` / filtered `get_thread_context?catId=...` 未推进 seenCursor → 下一次 stream output 不得再次 enqueue freshness re-invoke；只能记录 stale skip / unresolved ack
10. **D1.2a queued read/seen**：猫运行期间用户消息进入 queue → 猫调用无 filter `get_thread_context?responseMode=full` → 返回 same-target queued 正文并记录 per-cat `queued_seen` → 三条 freshness 路径不再因同一 queued entry 重复 hold/notice/stale；entry 仍在 queue，且不 `markDelivered`
11. **D1.2b queued handled**：猫对已 `queued_seen` entry 的 invocation succeeded → 记录/推断 per-cat `queued_handled` → consume only that target；failed/canceled 不 consume；多目标 entry 不移除其他 target
12. **A2A handoff reply**：A 输出 line-start `@B` 并存为 trigger message → B 的回复 `replyTo` 该 trigger → A 的 Phase A gate / D1 stream freshness / B1 notice 不得因此 hold 或 enqueue `Freshness -> A`；若父消息没有 mention B，则 B 的 reply 仍是普通 unseen 候选
13. **event trigger coverage**：GitHub CI/CD / Review Feedback 等 connector event 先创建消息并用该 `messageId` 唤醒目标猫 → 该猫本轮 stream output 结束时，不得再因同一 connector message enqueue `Freshness -> cat`；另一个非 trigger connector message 仍会触发 freshness
14. **routable freshness input**：另一只猫运行中产生空正文 tool-only stream，或 route-guard/system 产生内部诊断消息 → Phase A gate / B1 notice / D1 stream stale 都不得把这些消息计入 unseen；含正文或 rich block 的真实消息仍计入；`userId=scheduler` 的 hold-ball / scheduled-task trigger 因为会进入 prompt，必须计入
15. **D2 stage truth**：fake direct/tmux app-server 依次推进 spawn / initialize / thread / turn / item /
    terminal / close；live 与 F5 hydration 得到同一阶段与 `lastActivityAt`，重复 notification 不产生追加气泡
16. **D2 pre-turn recovery**：`turn/start` 未 accepted 即断流 → 只重试一次并复用已有 thread identity；
    `turn/start` accepted 或 item started 后同型断流 → 不 restart、不 fallback exec、不 replay prompt
17. **D2 protocol Cancel**：AbortSignal / 用户 Cancel 先写 `turn/interrupt`，收到
    `turn.completed(status=interrupted)` 后不发 OS signal；RPC/grace 失联才验证 SIGTERM → SIGKILL 顺序
18. **D2 terminal cleanup**：completed / interrupted / failed 后 child 拒不退出 → 有界强制回收，最终
    AgentMessage terminal cause 保持原值，不被 signal/exit code 覆盖
19. **D2 timeout policy**：默认 `CLI_TIMEOUT_MS=0` 的 active turn 任意静默不发 interrupt；运营者显式正数
    timeout 才走同一 protocol-first chain，ThreadExecutionBar 与 `/config` 人话说明 0 / 正数语义
20. **D2 explicit continue**：interrupted 后不自动 resume；用户显式继续才 `thread/resume + turn/start`，
    恢复输入含 workspace/tool 事实核对，旧 prompt 不被自动重放
21. **D2 capacity checkpoint continuation**：同 thread 存在多个未完成任务时，completed-tools + exact capacity
    只能按本 child invocation 的 message IDs 与最新 plan 恢复；prompt 不含通用“most recent unfinished”选择词。
    in-flight tool 与 post-tool missing-plan 分别产生 typed blocked terminal；预算耗尽只暴露最终断点卡。

### Sunset Signal
- 如果 3 个月内 held 决策事件中 `decision: 'held'` 占比 < 1%（几乎没有 stale 场景发生），说明这个 feature 的价值不大，考虑简化或移除
- 如果 `acknowledgeHeld` 使用率持续 > 50%（猫总是强制发送），说明 hold 机制打扰大于帮助，需要重新审视判据

## 需求点 Checklist

| # | 需求 | Phase | AC | 测试 | 状态 |
|---|------|-------|-----|------|------|
| R1 | seq 游标 freshness check | A | AC-A1 | Redis-backed | ✅ |
| R2 | 零误 hold（看过不 hold） | A | AC-A2 | 游标推进验证 | ✅ |
| R3 | fail-open | A | AC-A3 | null cursor 测试 | ✅ |
| R4 | held context cap=3 | A | AC-A4 | 多消息场景 | ✅ |
| R5 | acknowledgeHeld escape | A | AC-A5 | force send 测试 | ✅ |
| R6 | cross_post 覆盖 | A | AC-A6 | 跨 thread + multi_mention 测试 | ✅ |
| R7 | FreshnessAttentionEventLog（独立事件流） | B | AC-B0 | 封闭联合 + kind discriminator + projector 接口 | ✅ |
| R8 | content-free notice | B | AC-B1 | 只读工具附加 + 频率限制 + messageFilter 复用 | ✅ |
| R9 | turn-end notice | B | AC-B2 | hold_ball 附加 + defer 记录 | ✅ |
| R10 | re-invoke 兜底 | B | AC-B3/B4 | 高优先级触发 + 客观 skip 判据 + audit events | ✅ |
| R14 | per-invocation operational state | B | AC-B0 | Redis-backed counters + TTL | ✅ |
| R15 | eval 指标 | B | AC-B5 | 转化率/defer率/触发率/成本 | ✅ |
| R16 | privacy/visibility invariant | B | AC-B6 | content-free + messageFilter | ✅ |
| R17 | L0 soft layer | B | AC-B7 | staging 1-2 行 | ✅ |
| R11 | descriptor 派生 | C | AC-C1 | 派生一致性 | ✅ |
| R12 | runtime mode 注入 | C | AC-C2 | env 验证 | ✅ |
| R13 | seenCursor 隔离回归 | A | AC-A9 | push seen ≠ push delivery | ✅ |
| R18 | stream output freshness check | D | AC-D1 | stream 存储前 freshness 验证 | ✅ |
| R19 | stale output re-invoke | D | AC-D2 | 强制 re-invoke 绕过 cursor_caught_up | ✅ |
| R20 | stale audit trail | D | AC-D4 | 事件流记录 | ✅ |
| R21 | queued read + freshness suppression | D | AC-D8a | queued 正文返回 + durable per-cat `queued_seen` + no duplicate freshness nag；no consume/markDelivered on read | ✅ |
| R22 | queued handled closure | D | AC-D8b | `queued_seen + succeeded` handled v1 evidence + per-target consume; failed/canceled preserves work | ✅ |
| R23 | D1.2 eval observability | D | AC-B5/D8 | `queued_seen` + `queued_handled` OTel counters, freshness eval registry/glossary, fail-closed eval-cat instructions | ✅ |
| R24 | trigger-message coverage suppression | D | AC-D10 | connector trigger message excluded from D1 stream stale; non-trigger connector messages still count | ✅ |
| R25 | routable freshness input | D | AC-D11 | shared routable predicate excludes empty tool-only stream + internal diagnostics from Phase A/B/D freshness while preserving prompt-visible scheduler triggers | ✅ |
| R26 | catch-closure final commit predicate | E | AC-E1/E2 | stale draft cannot commit as final | ✅ merged PR #2853 |
| R27 | automatic missing-body injection | E | AC-E3 | successor prompt contains exact missing messages | ✅ merged PR #2853 |
| R28 | closure identity | E | AC-E4/E5 | stale → frontier → successor → final evidence chain | ✅ merged PR #2853 |
| R29 | bounded monotonic supersede | E | AC-E6 | continuous-message/crash/quota adversarial tests | ✅ merged PR #2853 |
| R30 | per-target commit isolation | E | AC-E7 | multi-target regression | ✅ merged PR #2853 |
| R31 | in-context catch status | E | AC-E8 | thread state dedup + convergence | ✅ merged PR #2853 |
| R32 | end-to-end freshness verdict | E | AC-E9 | replayable source + generator | ✅ merged PR #2912 (`07f46f5aa`); post-merge operator/alpha validation pending |
| R33 | production wiring guard | E | AC-E10 | convention consumer + gate regression | ✅ merged PR #2853 |
| R34 | lineage custody + running lease | E | AC-E12 | old blocked × independent fresh/stale matrices, route custody, Redis CAS | ✅ merged PR #2880 |
| R35 | current/attributable recovery | E | AC-E13 | retry preflight, relevance, cancel provenance, cross-thread effect, peer-context IR13 | ✅ merged PR #2880; runtime dogfood pending |
| R36 | Queue restart-durable custody | E-B | AC-E22 | exact identity/order + same-invocation success + crash/cancel/restart + multi-target Redis fixtures | ✅ merged PR #2912 (`07f46f5aa`); post-merge operator/alpha validation pending |
| R37 | all-active legacy closure accounting | E-B | AC-E23 | 51-root inventory + per-invocation outcomes + exact 399-char target + idempotent Redis replay | ✅ migration machinery merged PR #2912 (`07f46f5aa`); production apply not run |
| R38 | Codex provider-native same-turn notice | D2 | AC-D12/D13 | stable `turn/steer` exact-turn delivery + notified/seen truth split | ✅ default-off adapter + exact-turn live cognition fixture |
| R39 | carrier parity + no replay | D2 | AC-D14 | session/auth/approval/tmux/timeout/internal-archive/F212 matrix | ✅ AC-D14a-g merged via PR #3079/#3082/#3097；AC-D16 live matrix 仍独立 gated |
| R40 | provider × tool-surface eval | D2 | AC-D15/D16 | installed-schema census + command/file/MCP/collab/search/image/sleep decisions + Redis 6398 live regression | 🟡 code repair merged PR #3431（squash `b1c9c8e26`，exact-HEAD review APPROVE）：installed schema census、`collabAgentToolCall` safe boundary、逐类 no-boundary/deferred 分类、bounded unknown telemetry/denominator 与 Claude/Kimi unsupported/no-data truth 已落地；full exact-read/handled + late/no-boundary 正常 runtime 回归仍待执行 |
| R41 | Claude provider-native capability truth | D2 | AC-D17/D18 | print_sdk output-only baseline + stream-json exact-vs-queued fixture + B1 cap anti-silence | 🟡 live cognition proven as queued_internal_turn；default print_sdk/B1 保持不变，未迁移生产 adapter |
| R42 | app-server JSONL framing + pump isolation | D2 | AC-D14f | U+2028/U+2029 / CRLF / UTF-8 chunk / EOF / null + direct/tmux rejection fixture | ✅ PR #3079 (`3b83fb43c`)；live crash family fixed |
| R43 | provider-neutral Codex diagnostics | D2 | AC-D14g | Codex disconnect 不进入 Claude-only report；network classification regression | ✅ PR #3082 (`7dd7a4d51`) |
| R44 | app-server stage truth + pre-turn bounded recovery | D2 | AC-D14a/b | direct/tmux stage + F5 hydration + accepted-turn no-replay fence | ✅ PR #3097 (`54aef5e74`) |
| R45 | protocol Cancel + terminal cleanup | D2 | AC-D14c/d | interrupt success/grace failure/signal escalation + terminal-cause preservation | ✅ PR #3097 (`54aef5e74`) |
| R46 | manual-only active turn + explicit continue | D2 | AC-D14e | default 0 / positive opt-in + no auto resume/replay + in-context status | ✅ PR #3097 (`54aef5e74`) |
| R47 | exact capacity checkpoint continuation | D2 | AC-D14h | invocation/message anchor + plan snapshot + per-tool terminal ledger + blocked/exhausted card | ✅ PR #3285 (`65ef23d17`)；exact-HEAD review + full gate |

## Review Gate

- Phase A: 跨族 review（优先 @gpt52，性价比；Maine Coon太贵留安全/跨族/连续性场景）
- Phase B: 跨族 review
- Phase C: 猫猫讨论（`collaborative-thinking`）→ 跨族 review
- Phase D: 跨族 review（@gpt52 优先）
- Phase D2: Terra 对 implementation exact HEAD 做独立 review；merge 后由 Fable 5 做愿景守护验收。AC-D14 lifecycle delta 必须覆盖 stage truth、pre-turn retry fence、protocol Cancel、terminal cleanup、manual-only default 与 no replay。当前 live runtime 是运营者显式 canary，不等于代码默认或 broad rollout；扩大默认范围仍需 AC-D14~D17 全绿，不由代码 merge 自动授权。
- Phase E baseline: operator UX signoff ✅ → Fable R1 architecture/failure-mode input absorbed ✅ → ADR-041 accepted / worktree TDD ✅ → GLM continuity + cloud R1-R5 findings closed ✅ → Opus 4.8 LL-072 final seal ✅ → **merged PR #2853 (`838e6a892`)**；AC-E9 live verdict generator pending。
- Phase E v1.2 emergency lane: **merged PR #2880 (`a763e0b6d`)** after local Red→Green + Fable formal review/continuity + required CI. Cloud reviewer and alpha were explicitly skipped because only the real TTL=0 closure/socket/runtime scene can prove the incident family closed. Merge 后由 operator 重启、先硬刷新前端，再在原受害 thread dogfood；author 不自行重启 runtime。
- Phase E-D: Fable 的 incident verdict 只作为 diagnosis input；Terra 已对 final implementation HEAD `d0c95dfc5` 独立 APPROVE，覆盖 lineage placement、legacy/current retry 分界与 background unread/activity invariant，且 P1 fallback 修复经 active/background 反向 RED 验证后闭合。
- Phase E-B ADR-042 glass-box: **merged PR #2906 (`ace5412c0`)** after exact-head full gate, Opus 4.6 final-SHA continuity approval, resolved cloud review, and green CI.
- Phase E-B post-merge closure: **merged PR #2912 (`07f46f5aa`)** after final head `e19c05182` / base `17afbcd1d` passed full `pnpm gate`, Terra exact-head continuity approval, cloud zero-major review, and CI. Historical repair/review checkpoints remain provenance only. Production migration apply and runtime restart are outside the author boundary; post-merge operator/alpha validation remains before F254 is marked done.
- Phase E-C: Sol author；final HEAD 仅交 Terra，review 必须覆盖 typed prompt-coverage relevance、same-wave false-negative/false-positive 边界、supplement exactly-once、child terminal persistence 与 ADR-042 original-publication invariant；随后 normal merge-gate。
