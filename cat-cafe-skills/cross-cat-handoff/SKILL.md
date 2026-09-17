---
name: cross-cat-handoff
tips_exempt: "This revision makes handoff templates optional while retaining required context and custody; it is an internal delivery convention with no new user action."
description: "跨猫交接与 review 双路由。Use when: 交接、exact-HEAD external PR review task 或 PR tracking。Not for: 自己任务。Output: 足够接手的交接与适用的责任/审查回执。"
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

交接要让接手者能够正确继续。家里的历史坑是只报改动、没有缘由与上下文；栏目格式服务这个目标。

## 必须做到

- 让接手者明确目标与范围、关键缘由/约束、真实进度与证据，以及下一步由谁做什么。
- 会影响下一步判断的风险、取舍和未知不能漏；已有且有效的上下文可准确引用，没有真实取舍或未决问题不编造栏目内容。
- 交接对象、授权、责任与审查证据服从实际选中的路径。下面的 structured successor、external review 与 local review 契约按场景适用，接口必填字段不因 prose 简写而省略。
- 未完成、未送达、未验证如实说明；一次交接是否完成看合法出口与接手需要，不看五个标题是否齐全。

五项提示、例子和排版均为可选参考，可以直接使用、改造或替换；不按模型资格决定方法选择，也不因未采用模板另设审批。只处理自己任务时不进入交接流程。

## Action Successor Single-Flight

当交接会实际唤醒下一只猫时，先判断它是不是某个支持 structured successor 的动作。local cat review 已退出此路径；implement/task_done 与 external review 等仍受下面规则约束。若是，交接信之外还要携带结构化身份：

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
- local cat review 的初审与复审直接用 ordinary A2A；不要尝试 `review/reviewer` lease、复入字段、generation 或 replacement。新 HEAD 需要判断时发一条新的普通 review 请求；旧 verdict 只作历史证据。

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
review 请求的 thread；它的路由权高于任务祖先 thread、旧 `sourceThreadId` 和继承来的 coordination。初审和
复审都用 ordinary durable A2A；不要附 structured action、review lease、generation、replacement authority 或
review coordination。reviewer 在同一 carrier 行首 `@author`，同时带显式 `clientMessageId`、typed
`localReviewVerdict`（`approved | changes_requested | commented`）、`reviewedHeadSha`、`reviewSubjectRef`、
`acceptedSourceRef` 和 `acceptedRevision`。公开正文解释结论与
findings / evidence refs，typed fact 作为机器 authority。完成包必须同时包含：

1. exact target evidence：commit/PR HEAD、文档 body/content digest 等不可变目标；
2. 验证证据：targeted test、diff finding 或可复核命令；
3. author cat route：目标 catId 必须是作者，reviewer 与 author 必须是不同 catId。

GitHub comment 不能代偿 author cat route；反过来，本地猫 handoff 也不能代偿 external artifact。
本地 review 仅在 merge-gate、repository rule 或 operator 明确要求时额外写 GitHub，额外 artifact 不改变
默认回作者的 custody。

verdict 已完成最后一次合法交接：作者在 exact target 匹配且 `no open items` 时可直接进入 merge-gate 或
clean-stop，不需要再 `@reviewer` 证明收到。如后续真有行为 delta、stale/blocking 或 Review Provenance Matrix
显式指回 local peer，发一条新的普通 review 请求；没有新信息就拒绝回传。旧 verdict 保留为历史证据，但不批准新 HEAD。

## 可选参考：交接五项

不知道怎样组织信息时，可以用这五项起步或查漏；它们不是缺一栏就禁发的表单。

| 提示 | 可帮助想清什么 |
|---|---|
| What | 具体改动、决定或当前状态 |
| Why | 目标、原因与关键约束 |
| Tradeoff | 存在真实取舍时说明理由 |
| Open Questions | 影响接手的未知或阻塞；技术与价值问题分清 |
| Next Action | 接手者需要做的具体动作 |

例如：

> 空输入会让提交失败；本轮已修复解析边界，复现和红绿验证见 PR X。请核查另一入口是否受同一问题影响，并对 HEAD Y 给结论。

如果这是正式 review 请求，还要携带该路径要求的 target/source 字段。复杂状态交接可展开恢复、并发和未决边界；简单交接可直接用短段落。关键事实已有准确来源时引用即可。

## 可选参考：不同交接的重点

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
- 交接的下一步应引导接手方使用正确的 successor 原语（见下方常见错误表）

## 常见错误

| 错误 | 问题 | 正确做法 |
|------|------|----------|
| "帮我 review 这个" | 不知道该关注什么 | 说明 review 重点 |
| "我改完了" | 不知道改了什么/为什么 | 写明 What + Why |
| "按你说的改了" | 不知道改对了没 | 说明具体改了什么 |
| "遇到问题，你看看" | 不知道具体问题 | 描述问题 + 你的分析 |
| 前手没终止就继续喊 Terra/GPT/Claude | 同一动作膨胀成猫军团 | 接受 `safe_wait`；有 terminal proof 才原子 replace |
| 只派一只本地 reviewer 却调用 `multi_mention` | 无必要地扩大调用与责任 | local review 用 ordinary durable A2A；其他动作按其 successor 契约选择入口 |
| 为绕 single-flight 换 thread/slot 名 | 重复或 stale 工作继续运行 | 使用 server-authorized slot；thread/carrier 不进 identity |
| 把所有 review completion 一律写 GitHub | 本地猫作者收不到 verdict，平台账号还会伪装成 self-review | 先按 author/custody/handoff source 分类，再选 external artifact 或 author cat route |
| verdict 后为了出口再 `@` 回 reviewer | 无新信息也被路由规则变成 ACK ping-pong | recipient clean-stop；有实质新内容才发新的普通 review 请求 |
| 旧 dispatch 被超替仍尝试 approve/reject | 超替是终态，409（approve 和 reject 均拒绝） | 直接操作最新 pending 提案即可（旧提案已被超替无需手动处理） |
| legacy 提案在 required 模式下尝试 approve | 无 ActionEnvelope，409 | reject legacy 提案 + 通过新 dispatch 入口重新提交（re-attest） |

## 自检

接手者能从消息与引用读到目标、依据、风险和下一步吗？真实进度与适用的责任/审查回执相符吗？这些是完成标准；五项提示仅帮助查漏。

## 下一步

- 本地 review 请求与回执契约 → `request-review`；作者收到反馈后才用 `receive-review`
- 交接开发工作 → 接收方按现有任务与风险继续，需要隔离时用 `worktree`
- 交接讨论邀请 → 接收方用 `collaborative-thinking`

## 参考

- 交接要求与五项参考：`../.cat-cafe-shared-refs/shared-rules.md` §1
- Review 信存放：`review-notes/`
