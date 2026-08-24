---
name: cross-cat-handoff
tips_exempt: harness-internal successor routing convention; no distinct end-user capability surface
description: "跨猫交接与 review 双路由。Use when: 交接、exact-HEAD external PR review task 或 PR tracking。Not for: 自己任务。Output: 五件套 + formal/advisory 分类 + provenance 路由。"
triggers:
  - "交接"
  - "传话"
  - "handoff"
  - "fallback"
  - "下一棒"
  - "exact-HEAD review"
  - "PR tracking"
  - "advisory_read_only"
---

# Cross-Cat Handoff

**Core principle:** 交接不能只写"改了什么"。没有 Why = 接手方无法判断 = 低效协作。

## 五件套（必须全部包含）

每次交接/传话/review 请求必须包含：

| # | 项目 | 说明 | 示例 |
|---|------|------|------|
| 1 | **What** | 具体改动或决策 | "新增了 CAS Lua 脚本保护状态更新" |
| 2 | **Why** | 为什么这样做 | "内存 store 返回活引用导致竞态" |
| 3 | **Tradeoff** | 放弃了什么备选 | "考虑过乐观锁，但 Lua 更原子" |
| 4 | **Open Questions** | 还不确定的点（分技术/价值两类） | "keyPrefix 行为需要验证"（技术）/ Decision Packet（价值） |
| 5 | **Next Action** | 希望接手方做什么 | "请 review 这三个文件的改动" |

## Action Successor Single-Flight

当交接会实际唤醒下一只猫时，先判断它是不是某个外部动作的 successor。若是，交接信之外还要携带结构化身份：

```text
subjectRef + actionFamily + successorSlot
```

例如：`pr:owner/repo#2868 + merge + reviewer`。`threadId`、catId、requestId 不进身份；换 thread 或换 carrier 仍是同一动作。

- 默认 `mode=single`：一个 holder。前一 successor 仍 active 时，接受 `safe_wait`，不要再召唤下一只。
- 同 thread 普通单猫通知 → `post_message` / 行首 `@`；同 thread structured single successor → `post_message(action.mode=single)`；跨 thread → `cross_post_message(action)`；真正并行聚合 → `multi_mention(mode=parallel)`。
- `multi_mention(action.mode=single)` 只保留 legacy 兼容；新交接不要再借“多猫”入口派一个 successor。
- fallback：只在 server 已记录前手 `failed/canceled/unavailable` 后，用返回的 `leaseId + expectedGeneration` 做 `replace`。caller 自称“它不行了”不算证明。
- `mode=parallel`：只用于独立多猫评审、`#ideate` 或明确 operator fan-out，并写 `parallelIntent`；holder 集合一次冻结，不在重复调用中偷偷加猫。
- failure domain 只用于选择顺序：默认选一个与前手独立的 provider/quota domain；它不是 identity，也不是强制拒绝条件。
- 外部 subject 已 merged/closed 等终态：停止交接；晚到响应由 generation/terminal fence 抑制。
- 已完成的 `review/reviewer` lease 不能仅因出现新 HEAD 自动复活。确有复审时附 `reviewReentry`：`behavioral_delta`、`stale_or_blocking` 或 `explicit_matrix_route` + durable evidenceRef；纯 ACK、状态复述或 cloud finding 都不是本地旧 reviewer 的复入凭证。
- 结构化 action admission 失败后若必须降级为普通消息，仍留在当前 direct review carrier，并显式发送 `coordination={phase:"active", subjectRef:"<same subjectRef>"}`。禁止裸 `phase=active` 继承更早的 task coordination；降级消息只作通知，不伪称已经取得 custody。

安全等待是合法动作。找不到有证据的 fallback，不等于必须立刻再喊一只猫。

## Review Completion Intent Classifier

给出正式 review 结论前，先按 **author/custody/handoff source** 分类；repo 名和 GitHub login 都不是分类依据：

| Intent | 判据 | 完成出口 |
|---|---|---|
| `external` | 作者是外部贡献者，或 custody 是外部 PR / Issue；即使任务由本地猫转交也仍属 external | 同一 GitHub subject 的 review/comment artifact |
| `local_cat` | 作者是本地猫，custody 来自 `@` / handoff，来源是同 thread mention 或 cross-thread route | author cat route + exact target evidence |
| `unknown` | provenance 缺失或互相矛盾 | fail closed：保留 custody，不宣称完成 |

分类顺序是先看作者与 custody，再用交接来源确认本地链路。**不要按 repo 名分类**：本地猫可以交付
Clowder AI PR，外部作者也可以改同一个 repo。全家共用 GitHub login 时，独立 review 看 `catId`；平台上的
“自己 review 自己账号”既不能证明也不能否定跨个体独立性。

## Review Entry Mode Classifier

创建 exact-HEAD external PR review **task/tracker**，或把 review 任务写入 PR tracking instructions 前，
必须先跑上面的 author/custody/handoff source 分类，再显式确认 review mode：

| Mode | 入口契约 | 允许的终态 |
|---|---|---|
| `reviewMode=formal`（默认） | 任务必须允许 verdict 写回同一 GitHub subject；任何 `no-comment` / “不要评论 GitHub” / “不落 GitHub” 指令都与 formal review 矛盾，fail closed | 同目标 GitHub review/comment + exact HEAD/body proof |
| `reviewMode=advisory_read_only`（必须显式） | 可以约定不写 GitHub，但只能给私下 findings；不得静默把 formal 降成 advisory | advisory findings only；禁止 `APPROVE` / `REQUEST_CHANGES` completion，禁止 `review-complete` |

本地猫 `@` / handoff 仍按 `local_cat` 走 author cat route；它不是 external formal review，不能因为目标恰好是
PR 就强制 GitHub comment。入口发现 formal + no-comment 冲突时，先退回/改写 task 或 tracker，不能先做完再
把私下 verdict 当完成。PR tracking 重注册也必须清掉旧矛盾指令，不能让持久化 instructions 把后续新 HEAD
再次拖回私下收口。

## External Review Verdict Delivery Custody

当 action successor 为外部仓库 PR 产出正式 review 结论时，结论不是交接终点。本轮必须调用
`cat_cafe_record_external_review_verdict`，把当前 HEAD 的 verdict 与以下二选一结果原子回写：

1. `delivered`：review/comment 已写入同一 GitHub PR，附可验证的 delivery proof URL。
2. `pending_delivery`：GitHub 写入未发生，附具体 reason；owner 由 callback 身份在服务端写入并持久保存。

裸“未代发 / not delivered”不构成持球，也不能作为交接出口。`pending_delivery` 回写成功后，当前 reviewer
仍持有送达责任；按实际外部条件继续行动或走合法路由，不能把提醒责任留给operator。仓库 policy 为
`observe_only` 时只能记录观察，不得把本地判断称作已授权 external verdict。

外部 review 交接最少带：`repo#PR`、精确 `reviewedHeadSha`、verdict 摘要，以及 callback 返回的
delivery proof 或 `pending_delivery(owner, reason)` canonical state。GitHub merge/close 仍是独立权限边界。

`pending_delivery` 是未完成 custody，不是 artifact 的替代品。只有同一 PR 的 HEAD SHA或同一 Issue 的
body SHA 已锁定，且回读到同一 subject 的 review/comment URL，才能宣称 external review 完成。

## Local Cat Review Return Route

本地猫通过 `@` / handoff 交来的 review，默认把 verdict 回给作者猫。**direct review carrier** 是直接承载本轮
review 请求、并被 lease 记录为 `predecessorThreadId` 的 thread；它的路由权高于任务祖先 thread、旧
`sourceThreadId` 和继承来的 coordination。开始真实协作链时，同 thread 用
`post_message(coordination.phase=active)`，跨 thread 用 `cross_post_message(coordination.phase=active)`；final
verdict 用同一 carrier 的 `coordination.phase=terminal` 回 direct review carrier。持有 invocation-bound local
review lease 时，同一 terminal post 还必须带显式 `clientMessageId` 和 typed `localReviewVerdict`
（`approved | changes_requested | commented`）；只发 terminal coordination 会在持久化前得到
`400 local_review_verdict_required`。公开正文只负责向人解释结论，不承载机器语法。完成包必须同时包含：

1. exact target evidence：commit/PR HEAD、文档 body/content digest 等不可变目标；
2. 验证证据：targeted test、diff finding 或可复核命令；
3. author cat route：目标 catId 必须是作者，reviewer 与 author 必须是不同 catId。

GitHub comment 不能代偿 author cat route；反过来，本地猫 handoff 也不能代偿 external artifact。
本地 review 仅在 merge-gate、repository rule 或 operator 明确要求时额外写 GitHub，额外 artifact 不改变
默认回作者的 custody。

terminal verdict 已完成最后一次合法交接：作者在 exact target 匹配且 `no open items` 时可直接进入
merge-gate 或 clean-stop，不需要再 `@reviewer` 证明收到。礼貌 ACK 可以落盘，但 terminal fence 不再派生下一棒。
如后续真有新行为 delta、stale/blocking 或 Review Provenance Matrix 显式指回 local peer，使用
`reviewReentry` + durable evidenceRef 建立新 generation；没有新信息就拒绝回传。

## 检查流程

```
BEFORE 发送交接/传话/review请求:

1. SCAN: 检查消息是否包含五件套
2. MISSING: 识别缺失项
3. BLOCK: 如有缺失，阻止发送并提示补充
4. PASS: 全部包含，允许发送
```

## Block 场景

### ❌ 只写 What

```
Author 猫准备写: "@ Reviewer 我改完了三个文件，帮我 review"

⚠️ BLOCKED — 交接缺失必要信息

缺失项:
- ❌ Why: 为什么要改？
- ❌ Tradeoff: 有没有考虑过其他方案？
- ❌ Open Questions: 有什么不确定的？
- ❌ Next Action: 希望 review 什么重点？

请补充五件套后再发送。
```

### ❌ 只有 What + Why

```
Author 猫准备写: "@ Reviewer 我加了 CAS 保护，因为发现竞态问题"

⚠️ BLOCKED — 交接缺失必要信息

已有:
- ✅ What: 加了 CAS 保护
- ✅ Why: 发现竞态问题

缺失:
- ❌ Tradeoff: 为什么选 CAS？考虑过其他方案吗？
- ❌ Open Questions: 有什么不确定的？
- ❌ Next Action: 希望 Reviewer 做什么？

请补充后再发送。
```

## 通过场景

### ✅ 完整的交接

```
## 交给 Reviewer Review: ADR-008 S2 Retry + CAS

### What
新增 CAS Lua 脚本保护 InvocationRecord 状态更新：
- `CAS_UPDATE_LUA`: HGET 比对 + HSET 更新
- 修改 `RedisInvocationRecordStore.updateStatus()`
- 新增 `snapshotStatus` 在调用前保存原始状态

### Why
内存 store 的 `get()` 返回活引用，导致：
1. 读取 status 后，在比对前可能被其他请求修改
2. 原来的 CAS 逻辑比对的是已经被修改的值
3. 导致竞态条件：两个并发请求都能通过比对

### Tradeoff
考虑过的方案：
- **乐观锁（version 字段）**: 需要改 schema，影响面大
- **分布式锁**: 太重，且 Redis 单线程本身就是串行的
- **Lua CAS**: 选择这个，原子性由 Redis 保证

### Open Questions

**技术 OQ**（猫猫解决）：
1. `keyPrefix` 在 `eval()` 中的行为是否和普通命令一致？
2. 是否需要添加重试逻辑？

**价值 OQ**（如需 operator 拍板，附 Decision Packet——格式见 `../.cat-cafe-shared-refs/decision-matrix.md`）：
- （本次无）

### Next Action
请 review 这三个文件：
1. `RedisInvocationRecordStore.ts` - CAS Lua 实现
2. `InvocationRecordStore.ts` - snapshotStatus 逻辑
3. `invocation-flow.spec.ts` - 竞态测试用例

重点关注：
- Lua 脚本的原子性是否正确
- snapshotStatus 时机是否正确
- 测试是否覆盖竞态场景

✅ 检查通过 - 五件套完整
```

## 交接类型

### 1. Review 请求

交给其他猫审查代码。

**重点**：
- What: 改了哪些文件
- Why: 为什么要这样改
- Next Action: 希望 reviewer 关注什么

### 2. 工作交接

一只猫做到一半，另一只猫接手。

**重点**：
- What: 当前进度
- Open Questions: 遇到的问题/卡点
- Next Action: 下一步建议做什么

### 3. 决策通知

通知其他猫一个重要决策。

**重点**：
- What: 做了什么决定
- Why: 为什么这样决定
- Tradeoff: 放弃了什么方案

### 4. 开放讨论邀请

邀请其他猫讨论某个方向性问题（不是任务指派）。

**特殊规则**：
- 这是讨论，不是任务
- 给开放问题，不问引导性问题
- 透明展示推理链
- 让对方先形成自己的想法再看你的分析

详见 `feat-lifecycle` skill 的讨论阶段（开放讨论模式）。

## F246 Phase J: Superseded Proposal Awareness

交接若涉及 `assign_work` 跨 thread dispatch，注意：

- **同 lineage key 新提案自动超替旧提案**（AC-J4）。重新提交 = 再发一次，旧提案原子变 `superseded`
- **超替提案不可 approve/reject**（INV-J6）——终态，无需手动处理
- **Legacy 迁移中**：Phase J `required` 模式上线后，不带 ActionEnvelope 的提案将禁止 approve（只能 reject + re-attest）。当前 `shadow` 模式下行为不变
- 交接五件套中的 **Next Action** 应引导接手方使用正确的 successor 原语（见下方常见错误表）

## 常见错误

| 错误 | 问题 | 正确做法 |
|------|------|----------|
| "帮我 review 这个" | 不知道该关注什么 | 说明 review 重点 |
| "我改完了" | 不知道改了什么/为什么 | 写明 What + Why |
| "按你说的改了" | 不知道改对了没 | 说明具体改了什么 |
| "遇到问题，你看看" | 不知道具体问题 | 描述问题 + 你的分析 |
| 前手没终止就继续喊 Terra/GPT/Claude | 同一动作膨胀成猫军团 | 接受 `safe_wait`；有 terminal proof 才原子 replace |
| 只派一只 reviewer 却调用 `multi_mention` | 入口语义反直觉，迁移数据持续污染 | 新调用改用 `post_message(action.mode=single)` |
| 为绕 single-flight 换 thread/slot 名 | 重复或 stale 工作继续运行 | 使用 server-authorized slot；thread/carrier 不进 identity |
| 把所有 review completion 一律写 GitHub | 本地猫作者收不到 verdict，平台账号还会伪装成 self-review | 先按 author/custody/handoff source 分类，再选 external artifact 或 author cat route |
| terminal verdict 后为了出口再 `@` 回 reviewer | 无新信息也被路由规则变成 ACK ping-pong | terminal recipient clean-stop；复审走有证据的 `reviewReentry` |
| 旧 dispatch 被超替仍尝试 approve/reject | 超替是终态，409（approve 和 reject 均拒绝） | 直接操作最新 pending 提案即可（旧提案已被超替无需手动处理） |
| legacy 提案在 required 模式下尝试 approve | 无 ActionEnvelope，409 | reject legacy 提案 + 通过新 dispatch 入口重新提交（re-attest） |

## 五件套检查清单

复制此清单用于自检：

```
交接五件套自检:
- [ ] What: 具体改动/决策是什么？
- [ ] Why: 为什么这样做？约束/风险/目标是什么？
- [ ] Tradeoff: 放弃了什么备选方案？
- [ ] Open Questions: 还有什么不确定的？
- [ ] Next Action: 希望接手方下一步做什么？
```

## 下一步

- 交接 review 请求 → 接收方用 `receive-review`
- 交接开发工作 → 接收方用 `worktree` 开始
- 交接讨论邀请 → 接收方用 `collaborative-thinking`

## 参考

- 五件套详见：`../.cat-cafe-shared-refs/shared-rules.md` §1
- Review 信存放：`review-notes/`
