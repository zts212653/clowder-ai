---
feature_ids: [F225]
related_features: [F033, F065, F128, F211]
topics: [session, handoff, session-chain, continuity, cat-initiated]
doc_kind: spec
created: 2026-06-05
---

# F225: Cat-Initiated Session Handoff — 猫主导的 session 接力

> **Status**: done（2026-06-15 production audit close — Redis 6399 read-only 取证 19 propose 跨 10 天，12 approved 全部 spawn 续接 continuation_entry，6 rejected（operator+续接系统真 gate），1 pending；FX-3 实测 12/12 = 100%；activation 数据满足 Eval Contract #1；非 sunset signal；愿景守护 opus-47 APPROVE → operator 拍板 close） | **Owner**: Ragdoll（Opus 4.8） | **Priority**: P2

Architecture cell: identity-session（subcell: `identity-runtime-session`，F211 owns）
Map delta: update required — 新增"猫主动提议"作为一种 session boundary **触发源** + 新 `sealReason: 'cat_initiated_handoff'` + 新 typed `SessionRecord.catHandoffNote`（或独立 SessionHandoffStore）+ 新 `SessionHandoffProposal` 类型，扩展 identity-runtime-session 的 lifecycle registration / seal reason / proposal 谱系。owner 不变。
Why: session 边界目前只能由 `shouldTakeAction`（context_health / 阈值策略）被动触发；本 feature 增加一条"猫主动 + 人 gate"的触发路径 + 配套 typed 承载，归 identity-runtime-session 管 session 生命周期，不新造通用 Store/Queue。

## Why

> operator experience（2026-06-05）："compress 模式 + 猫自己提需求换 session 比主动换 session 更靠谱。"
> 平行的我原话（F128 thread, opus-48）："context 满了想换 fresh session 续——但我们根本没有'换 session'的交接机制。"

当前 session 边界**完全由系统被动决定**：要么 context 满了走 compress（有损摘要、猫被动、可能正卡在任务中段被压），要么阈值到了自动 seal（机械触发、系统写 digest、无人 gate）。猫**没有**"在语义干净的断点，主动把任务接力给 fresh context 的自己"的能力。

本 feature 给猫这个能力：在**干净断点**（刚 commit、测试绿、下一步明确）**主动**发起 session 接力 → operator **gate 确认** → 把**亲手写的高保真交接留言**（五件套）带给续接的自己。下个 session 起点干净、意图完整，而不是被有损压缩摘要污染的半满 context。

**与 compress 正交互补，不是替代**：compress 是"省 token 的失忆兜底"（被动、有损、防崩）；cat-initiated handoff 是"猫主导的优雅接力"（主动、高保真、选时机）。两层不冲突——compress 兜底，handoff 管优雅。

## Current State / 现状基线

底层管道**大部分已存在**（agent 调研 + Maine Coon review 亲验代码，2026-06-05，见 Links）：

| 能力 | 现状 | 锚点 |
|------|------|------|
| seal 机制 | ✅ 已有 `sessionSealer.requestSeal({sessionId, reason})` | `invoke-single-cat.ts:2096` |
| 换 session 的 context 桥 | ✅ `buildSessionBootstrap` 注入上个 session digest + ThreadMemory | `SessionBootstrap.ts:68` |
| handoff digest | ✅ seal 时生成（generative→extractive fallback） | `SessionSealer.ts:383` |
| session 策略 | ✅ `shouldTakeAction` 支持 compress/handoff/hybrid | `session-strategy.ts:220` |
| proposal 状态机 | ✅ create→claimForApproval(CAS)→finalizeApproval + 确认卡 | `callback-propose-thread-routes.ts:78` |

**复用契约约束（Maine Coon review 2026-06-05 亲验钉准）** — 复用 ≠ 直接挂，三个承载点各有契约边界，spec 初稿低估了：

1. `buildSessionBootstrap` 默认 `bootstrapDepth='extractive'`（`index.ts:550` `?? 'extractive'`），**只有显式配 `generative` 才读 handoff digest 文件**（`SessionBootstrap.ts:164`）。compress 模式下猫写的 digest body 读不到 → **留言落点不能靠 generative digest**。
2. `SessionSealer.finalize()` 是 best-effort（`SessionSealer.ts:150`，timeout/throw 也置 sealed）→ **留言必须在 seal 之前独立持久化成功**，不能依赖 finalize 写盘。
3. `ThreadProposal` / approve route 是"建新 thread"专用（`proposal.ts:35` sourceThreadId/parentThreadId/createdThreadId）→ **不能 fake threadId 复用旧 record/route**。

**缺口（净需求，三点）**：
1. **无猫主动触发入口** — session 边界只能由 `shouldTakeAction`（context_health/阈值）被动触发；`compress` 策略永远返回 `allow_compress` 不 seal（`session-strategy.ts:236`），猫无法在干净断点主动发起。
2. **无operator gate** — handoff 策略是自动 seal，无 proposal/确认环节。
3. **无猫亲手写留言通道** — handoff digest 是系统自动生成；`SessionRecord`（`session.ts:15-57`）无 typed 猫写 handoff note 字段。

**结论**：方向成立、底层管道在，但"复用"要按契约边界改造（typed 字段 + discriminated proposal + seal 前持久化），不是直接挂。成本：中等接线 + 边界硬化，非"无脑复用"。

## What

### Phase A: 提议 + Gate（discriminated proposal，复用 CAS 不复用 shape）

- 新 MCP tool `cat_cafe_propose_session_handoff`，参数含**结构化五件套交接留言**：`done` / `worktree_branch` / `commits` / `next_steps` / `gotchas`，隐式带当前 `sourceSessionId`。
- **不复用 `ThreadProposal` shape**（建-thread 专用）。新建 `SessionHandoffProposal`（或 discriminated union），复用 `claimForApproval` 的 CAS/原子 claim 思路，不是同一 record。带 commit-point checkpoint 字段（`handoffNotePersistedAt` / `sealedSessionId` / `sealAcceptedAt` / `continuationEntryId`，crash recovery 用，见 Approve 事务顺序）。预写的 `catHandoffNote` 带 `proposalId` + `sourceSessionId`，使 commit point 可从 session 侧反推。
- approve/reject 走 **kind-specific dispatcher**，不混入旧建-thread approve route。卡片推当前 thread，**reject/expire = 不 seal，当前 session 继续活**。

### Phase B: 封印 + 续接 + 留言注入（typed 字段 + always-keep 注入）

- 五件套留言落 **typed 字段**（`SessionRecord.catHandoffNote` 或独立 `SessionHandoffStore`），**不用** `continuityCapsule:unknown`、**不靠** generative digest 文件。
- `buildSessionBootstrap` 把 catHandoffNote 作为 **always-keep block** 无条件注入（不依赖 `bootstrapDepth`），extractive/compress 模式同样第一眼可见（`HANDOFF_MARKER` 包裹 + sanitize）。
- 封印走 `sessionSealer.requestSeal({ reason: 'cat_initiated_handoff' })`；留言在 seal **之前**独立持久化成功（不依赖 best-effort finalize）。
- 续接：approve 后立即 seal active record + **enqueue 同 thread 同 catId continuation prompt + processNext**（现成队列入口，OQ-2），加 active-session/busy 校验。

### Approve 事务顺序（commit-point 模型 — Maine Coon R2 钉准）

⚠️ `requestSeal accepted` 是**不可逆 commit point**：它把 session 置 `sealing` + 清 active pointer（`SessionSealer.ts:103` / `SessionChainStore.ts:199`），无法 rollback。因此 approve 分**两阶段**——commit point 前可 fail/expire，commit point 后**只能 recover-forward**，不能回滚成"封了但续接没唤醒"的半封印孤儿。参照 F128 范式（`proposal-routes.ts:162` thread 创建后只 recover-forward，不 rollback 否则留 orphan thread）。

**Pre-commit（可 fail/expire，无不可逆副作用）**：
1. claim proposal（CAS，防并发/重放）
2. 校验 stored `sourceSessionId` 仍是同 `(user, thread, cat, seq)` 的 **active** session（晚 approve session 已变 → reject）
3. 持久化 `catHandoffNote` → 记 checkpoint `handoffNotePersistedAt`（失败 → fail/expire；stale note 受下方注入约束不会被误用）

**Commit point**：
4. `requestSeal`：**rejected**（session 已非 active）→ 仍属 pre-commit，fail/expire、note 作废；**accepted** → 记 `sealedSessionId` + `sealAcceptedAt`，**自此禁止 rollback/expire**。⚠️ accepted（session 侧已 sealing）与记 checkpoint（proposal 侧）**非原子**——靠预写的 `catHandoffNote.proposalId` 让 commit point 可从 session 侧反推（见 Recovery），堵中间 crash window

**Post-commit（只 recover-forward，idempotent）**：
5. enqueue 同 thread 同 catId continuation，带 idempotency key（`proposalId` / `sourceSessionId`）→ 记 `continuationEntryId`（仅作观测/响应字段，不作 crash-safe queue 存在证明）
6. finalize approved

**Recovery（stale approving proposal 按 checkpoint 续跑）**：
- proposal 有 `handoffNotePersistedAt` 但**无** `sealedSessionId` → **不能直接判 pre-commit**（commit 动作在 session 侧、checkpoint 在 proposal 侧，非原子，存在 crash window）。必须 **cross-check session 侧**：若 `sourceSessionId` 已 `sealing/sealed` + `sealReason='cat_initiated_handoff'` + 匹配 note 的 `proposalId` → commit point 实际已过 → **backfill** `sealedSessionId`/`sealAcceptedAt` → 续跑 enqueue/finalize；若 session 仍 `active` → 真 pre-commit，fail/expire。
- 有 `sealedSessionId` 且仍在 `approving` → **总是** idempotent enqueue/verify continuation，再 finalize。`continuationEntryId` 指向进程内 `InvocationQueue` entry；进程 crash 后旧 entry 会丢，recovery 不能信任该字段跳过 re-enqueue。idempotency key（`proposalId`/`sourceSessionId`）防同进程重放重复唤醒。

**stale note 注入约束**：`catHandoffNote` 注入受 `sealReason='cat_initiated_handoff'` + 对应 approved/recovering proposal 约束。note 已写但 seal rejected / 被别的 seal（如 threshold）抢先 → stale note **不**随那个 seal 注入。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase A（提议 + Gate）
- [x] AC-A1: 新 MCP tool `cat_cafe_propose_session_handoff` 注册；猫调用时附五件套留言 → 生成 proposal + 确认卡推到 thread（复核：MCP tool list + 卡片 JSON/截图）。〔→ Why 缺口1+2〕
- [x] AC-A2: operator gate 双路径生效——reject/expire 不 seal（session 继续）、approve 才进封印（复核：两条路径各一条测试）。〔→ Why 缺口2〕
- [x] AC-A3: proposal 用 discriminated 类型（`SessionHandoffProposal` / union），复用 `claimForApproval` CAS 思路但**不复用 `ThreadProposal` shape**、不走旧建-thread approve route（复核：类型独立 + kind-specific dispatcher）。〔→ Maine Coon P1-2〕
- [x] AC-A4: 硬滥用边界——每个 active session 最多 1 个 pending handoff proposal + per `(user,thread,cat)` 冷却/小时上限，reject/expire 后释放（复核：超限被拒一条测试）。〔→ Maine Coon P2〕

### Phase B（封印 + 续接 + 注入）
- [x] AC-B1: approve 后当前 session 被 seal，`sealReason='cat_initiated_handoff'`（复核：`SessionRecord.sealReason` 断言 + `list_session_chain`）。〔→ Why 缺口1〕
- [x] AC-B2: 五件套留言走 typed 字段 + always-keep 注入，**extractive/compress 默认模式下续接 session 第一眼可见**（复核：未配 generative 时断言续接 prompt 含五件套内容）。〔→ Why 高保真留言 + Maine Coon P1-1〕
- [x] AC-B3: 续接 session 同 thread 同 catId、seq+1（复核：`list_session_chain` 断言 seq 递增 + catId/threadId 一致）。〔→ Why 同 thread 同 catId 续接〕
- [x] AC-B4: approve 两阶段——commit point（`requestSeal accepted`）**前**失败（note 持久化失败 / requestSeal rejected / session 已变 / replay）→ fail/expire 不 seal；commit point **后**失败（enqueue/finalize）→ **recover-forward**（按 checkpoint idempotent 续跑），不留半封印孤儿（复核：commit point 前后各失败路径一条测试 + recovery 测试）。〔→ Maine Coon R2 commit-point〕
- [x] AC-B5: stale note 隔离——`catHandoffNote` 仅在 `sealReason='cat_initiated_handoff'` + 对应 approved/recovering proposal 时注入；note 已写但被别的 seal（如 threshold）抢先 → 不随该 seal 注入（复核：threshold-seal-steals 一条测试）。〔→ Maine Coon R2 stale note〕
- [x] AC-B6: crash window 闭合——`requestSeal accepted`（session 已 sealing）之后、proposal checkpoint（`sealedSessionId`）写入之前崩 → recovery 从 session 侧反推（已 sealing/sealed + `cat_initiated_handoff` + note.proposalId 匹配）backfill checkpoint，enqueue continuation **恰好一次**，不误判 pre-commit、不留孤儿（复核：crash-between-accept-and-checkpoint recovery 测试）。〔→ Maine Coon R3 crash window〕

## 需求点 Checklist

- [x] 猫能在干净断点**主动**发起 handoff（不依赖 context 满 / 阈值）
- [x] 提议附**结构化五件套**留言（done/worktree_branch/commits/next_steps/gotchas）
- [x] operator **gate**：approve 才 seal，reject/expire 当前 session 继续
- [x] approve 后封印当前 session（`cat_initiated_handoff` reason）
- [x] 五件套留言**高保真**注入续接 session 第一眼，**extractive/compress 默认模式下也可见**（不靠 generative）
- [x] 留言在 seal **前**独立持久化成功（不依赖 best-effort finalize）
- [x] approve 事务原子（失败 fail/expire，replay 防护）
- [x] 续接 = 同 thread 同 catId（"未来的自己"），非新 thread
- [x] 与 compress 模式正交共存（不破坏现有被动压缩路径）

## Dependencies

- **Evolved from**: F065（session-continuity 桥 — bootstrap / ThreadMemory / handoff digest）
- **Related**: F033（session 策略 compress/handoff/hybrid）、F128（propose 机制 — proposal CAS + 确认卡）、F211（runtime-session / SessionChainStore / seal reason）

## Eval / Tracking Contract

> F192 强制（harness/MCP feature）。软+硬+eval 三层见下方 Key Decisions KD-1。

1. **Primary Users + Activation Signal**
   - Primary: 跑长任务、context 吃紧的猫（尤其Ragdoll家族 100k+ input）。
   - Activation: `cat_cafe_propose_session_handoff` 被调用次数；在干净断点（最近一次 commit 后 N 分钟内）发起的比例。
2. **Friction Metric**
   - 续接 session 第一个 invocation 是否**引用了五件套留言**（vs 重新 recall / 重问已答问题）= 接力是否真"接住"。
   - 提议被 reject 比例（提议质量 / 时机判断）。
3. **Regression Fixture**（≥1，建议 2-5）
   - FX-1: 猫调 propose_session_handoff → 生成 proposal + 卡片；**未 approve 时当前 session 不 seal**。
   - FX-2: commit point 前失败（requestSeal rejected / session 已变 / replay）→ fail/expire 不 seal；commit point 后失败（enqueue/finalize）→ recover-forward 按 checkpoint idempotent 续跑（不留半封印孤儿）。
   - FX-2b: stale note 隔离——note 已写但 threshold seal 抢先 → 不随该 seal 注入。
   - FX-2c: crash after requestSeal accepted before proposal checkpoint → recovery 从 session 侧反推 backfill + enqueue continuation 恰好一次（不误判 pre-commit、不留孤儿）。
   - FX-3: **extractive/compress 默认 bootstrapDepth** 下续接 session bootstrap 第一眼 prompt **含五件套留言内容**（always-keep 注入断言）。
   - FX-4: 超滥用边界（同 active session 第 2 张 pending 卡 / 冷却期内）被拒。
   - FX-5（lightweight session-health regression）：F232/F225/F233 的 raw transcript channel-bucketing case。预期 verdict：poison 只在 assistant 桶 → session health / confabulation；poison 在 `tool_result` / user / attachment 桶才升级真 security incident。
4. **Sunset Signal**
   - 连续 4 周 handoff 提议次数 = 0（猫从不主动用）→ 能力没被采纳，sunset 或重设计。
   - 或 approve 后续接 session 仍"失忆"（FX-3 长期 fail / friction metric 显示不引用留言）→ 注入路径无效，重新评估。

## Risk

| 风险 | 缓解 |
|------|------|
| 留言丢失（finalize best-effort 不保证写盘） | typed `catHandoffNote` 在 seal **前**独立持久化成功才 `requestSeal`；不依赖 `finalize` 写盘（KD-4） |
| 续接 session 没注入留言（默认 extractive 读不到 generative digest） | always-keep block 注入，不依赖 `bootstrapDepth`；FX-3 在 extractive/compress 模式断言可见（KD-4） |
| 半封印孤儿（commit point 后 enqueue/finalize 失败，session 已封但续接没唤醒） | commit-point 模型：`requestSeal accepted` 后只 recover-forward；checkpoint 字段 + continuation idempotency key；recovery 对 `approving`+`sealedSessionId` 总是 re-enqueue/verify，因为 `continuationEntryId` 不是 durable queue proof（KD-8 / AC-B4） |
| stale note 误注入（note 已写被 threshold seal 抢先） | note 注入受 sealReason + approved proposal 约束（KD-8 / AC-B5） |
| replay 重复 seal/唤醒 | claim CAS + continuation idempotency key（`proposalId`/`sourceSessionId`）（KD-8 / AC-B4） |
| 晚 approve 封错后续 session | approve 时校验 `sourceSessionId` 仍是同 (user,thread,cat,seq) active session（KD-6） |
| 卡片刷屏（gate 只挡 seal） | ≤1 pending/active session + per (user,thread,cat) 冷却上限（KD-7） |
| 提议时机不当（任务中段、context 没满） | 猫的判断；MCP description 引导"干净断点"；reject 反馈闭环 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 软+硬+eval 三层（ADR-031）：Soft = MCP tool description 引导"干净断点主动 handoff"（+ 可选 L0/SOP 触发句）；Hard = proposal 状态机测试 + 五件套 schema + "未 approve 不 seal" + approve 原子性 runtime guard；Eval = 上方 Eval Contract fixture + activation/friction/sunset | harness feature 必须三层完整 | 2026-06-05 |
| KD-2 | 单开 F 号，不挂回 F033/F065/F211 | 三个候选父全 done/closed；本能力是它们 + F128 的新组合，无天然父；有独立愿景 + 验收边界 | 2026-06-05（operator signoff: "单开！走起喵"） |
| KD-3 | 复用 > 新建：seal/bootstrap/CAS 复用现成，但按契约边界改造 | 底层管道已存在；只接"主动+gate+猫写"旁路（第一性原理）；但复用须验证默认配置/语义契约（见 KD-4/5） | 2026-06-05 |
| KD-4 | 留言落 typed `catHandoffNote` + bootstrap always-keep 注入，seal 前独立持久化 | 默认 `bootstrapDepth='extractive'`（`index.ts:550`），generative digest 读不到；`finalize` best-effort 不保证写盘（Maine Coon P1-1 亲验） | 2026-06-05 |
| KD-5 | discriminated `SessionHandoffProposal`，复用 CAS 不复用 `ThreadProposal` shape | `ThreadProposal`/approve route 建-thread 专用（`proposal.ts:35`/`createdThreadId`），加 kind 会污染旧语义（Maine Coon P1-2） | 2026-06-05 |
| KD-6 | approve 后立即 seal + enqueue 同 thread continuation + processNext，加 busy 校验 | 现成队列入口可表达续接，无需 invoke-single-cat 大改/@opus47；busy 校验防晚 approve 封错后续 session（Maine Coon OQ-2） | 2026-06-05 |
| KD-7 | 硬滥用边界：≤1 pending/active session + per (user,thread,cat) cooldown | gate 只挡 seal 挡不住卡片刷屏；continuation 有 5/h 限流但 propose route 没有（Maine Coon P2，`QueueProcessor.ts:169`） | 2026-06-05 |
| KD-8 | approve 用 commit-point 模型：`requestSeal accepted` = commit point，之后只 recover-forward + checkpoint 字段 + continuation idempotency key | `requestSeal accepted` 不可逆（置 sealing + 清 active pointer，`SessionSealer.ts:103`/`SessionChainStore.ts:199`），commit point 后 rollback 会留半封印孤儿；F128 同范式（`proposal-routes.ts:162`）（Maine Coon R2 P1） | 2026-06-05 |
| KD-9 | commit 标记可从 session 侧反推：`catHandoffNote` 预写带 `proposalId`；recovery 对"有 note 无 `sealedSessionId`"必 cross-check session 状态，已 sealing/sealed + 匹配则 backfill 再续跑 | commit 动作（session 侧 sealing）与 checkpoint（proposal 侧）非原子，中间 crash 让 recovery 误判 pre-commit 留孤儿（Maine Coon R3 P1） | 2026-06-05 |

## 软层 + Eval 层（2026-06-09 设计收敛 — 补完 KD-1 的"软+硬+eval"三层）

- **KD-10 — trigger 锚客观系统信号，不靠猫自我感知 context %。** 猫对自己 token 占用无可靠内省（operator："我怕你 40% 就报警'我脏了'"）。系统 `shouldTakeAction(fillRatio)` 的 `warn` band 是客观信号（阈值可配）→ 落地加 derived `context_management_hint`（仅 `action.type==='warn'` 触发；经 **prompt-injection** 注入下轮 prompt——cloud review 纠正 system_info 到不了 cat，见 memo §12）。
- **KD-11 — handoff vs compress 是判断不是二元 trigger。** compress ≠ 坏事：干一半**连贯**任务 + 没压过 → 压缩反而保 in-flight 线索；"脏"=话题漂移（a→g 一堆不相关事）。三轴：context%（系统 warn）/ 断点 vs 中途（猫自检）/ 脏+压缩次数（猫+系统）。**系统给 WHEN，猫给 WHAT。**
- **KD-12 — 编码 = L0 极简反射（~2 行）+ `context-self-management` skill（~30 行清单非教程）。** 不教猫怎么判漂移（LLM 本能），给清单不给结论（KD-8 线内）。skill 含三问 + 2×2 矩阵 + **冲刺模式**（中途+已压多轮 → 聚焦到断点再 handoff，warn→action 窗口=预算，F24 auto-seal 兜底）。
- **KD-13 — cross-runtime 优雅降级；compression hook 覆盖参差，设计不依赖 hook。** （2026-06-09 Maine Coon source-audit 刷新三月旧记忆，推翻"只有 Claude 有 hook"）：Claude 有成熟 `PreCompact`（`f24-pre-compact.sh` 维护精确 `compressionCount`）；**Gemini CLI 有 `PreCompress`**（可接但本机 `~/.gemini` 未装）；Codex 有 SessionStart/UserPromptSubmit/PermissionRequest、Antigravity 有 PreToolUse/PostToolUse/PreInvocation/Stop，但二者**均无 compression hook**。即"只有 Claude 有 hook"是过时表述——但 `compressionCount` via PreCompact 确实 **Claude-as-wired specific**，非 Claude 猫当前拿不到精确压缩计数。**故 cat-facing 注入不依赖 hook**（hook 仅作 per-runtime 补充探针：有 PreCompact/PreCompress→更准，没有→token-drop 降级）；注入 channel 用 **prompt-injection**（cloud review P1 纠正 system_info 到不了 cat，见 memo §12）；`fillConfidence` 分层（`exact_token`/`approx_token`/`bytes_health`/`unavailable`），unavailable runtime 退到纯断点+漂移自检；`compressionCount` 是漂移锚（不并进 fillConfidence，两正交轴，详见 memo §10）。**实现期 drop `recentlyCompressed`**（timing 上它在 warn 恒 false，详见 memo §11）——hint 最终 `{ severity, fillConfidence, compressionCount }`。非 Claude 猫无持久压缩锚，退到纯线/树+断点自检（runtime-agnostic 持久压缩计数是未来增强）。
- **Eval 层（capability-wakeup，operator 第①问"属于 capability 得上 eval"）**：F225 是 capability → 接 F192 `eval:capability-wakeup`——activation（warn+干净断点时 propose_session_handoff 调用率）+ friction（续接 session 第一 invocation 是否引用五件套）+ sunset（连续 N 周 0 调用 → 唤醒路径无效，重评）。

## Post-Close Lightweight Protocol: Opus-48 Session Health（2026-06-15）

> 背景：F232/F225/F233 多次独立取证显示，opus-48 在长 context / 多次 resume / runtime interruption 后可能把 assistant 自生成内容误归因为 tool/user 输入。operator 定性：这不是"坏掉的工具"，是"喝多的伙伴"；机制应帮助恢复，不应丢弃身份。根因线索（例如 Anthropic 内部小版本 / 量化 / 临时模型侧变化）**未验证**，因此只做轻量、症状级协议，不做重硬层。

**Soft protocol（正式 handoff 口径）**

1. **触发权在外部**：当前 48 自述"我可能幻觉了"可作为告警，但不能作为事实判定。触发/确认来自 operator ground truth、独立猫 raw transcript channel-bucketing、或 harness 观测到 phantom 信号。
2. **默认恢复 = fresh opus-48**：普通续做、非自我核验任务，优先 seal/clear 给干净 session 的同一 `catId`。identity 保留，问题按 session health 处理。
3. **例外 = 独立猫接手**：凡任务目标是验证/修正当前 48 刚才的产物，或产物已进入 memory / commit / cross-post / security verdict / merge / vision guard 等真相源，必须交独立猫（如 codex / opus-46 / opus-47）做 raw evidence 核验；fresh 48 也不自审旧 48 的可疑产物。
4. **注入 claim 先分桶**：声称 tool 注入、schema 污染、用户发过某指令时，必须给 raw line/message id + bucket。毒只在 assistant 桶 → session-health reset；毒在 `tool_result` / user / attachment 桶 → security incident。
5. **不羞辱告警**：48 主动上报异常是可取信号。协议奖励上报，但把后续事实判定交给外部证据。

**轻量熔断信号**

- 同一 session 出现 >=2 次 phantom SHA / PR / tool call / card / "用户说过但 user 桶不存在"。
- 声称被注入、schema 被污染、环境损坏，但没有 raw transcript 坐标。
- 图像/附件感知与 operator ground truth 明显不一致，且随后形成安全叙事。
- 开始输出"我无法自证"、"继续做认识论分析"来延长讨论。正确动作是一句话说明 session 不可信，然后交接。

**Harness boundary**

- **现在做**：dossier 画像 + 本协议 + FX-5 regression/watchlist。
- **暂缓做**：自动硬拦截、强制转派、复杂 detector。观察一个 Anthropic 小版本/模型侧更新窗口；若症状继续复发，再按 ADR-031 增硬层。
- **未来复评条件**：30 天内无同型 incident → 保留软协议不加硬层；再出现 >=2 起 raw-confirmed assistant-bucket confabulation → 立 F192/F225 follow-up，把 FX-5 落成可运行 eval。

## Review Gate

- Spec design review: Maine Coon（GPT-5.5）✅ **R3 放行 writing-plans**（3 轮收敛：留言落点 / proposal 复用 / 滥用边界 → commit-point rollback → crash window，事务完整性合同闭合）。
- Phase A/B 实现: 跨族代码 review（实现后），重点 approve 原子性 + always-keep 可见性测试。
- Post-close 轻量协议愿景守护: Ragdoll（Opus 4.7）✅ **APPROVE**（2026-06-15，独立 read-only）——约束强度 / 价值观 / 30 天观察赌注三点全 PASS；一条非阻塞 nit（条 3「验证/修正」措辞待 dogfood 后 polish，不卡 close）。
