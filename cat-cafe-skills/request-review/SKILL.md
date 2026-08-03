---
name: request-review
tips_exempt: harness-internal review routing convention; no distinct end-user capability surface
description: >
  Route a change to a non-author local peer when local review is the selected independent validation source.
  Use when: risk routing chooses a stateful local reviewer for implementation, governance, or semantic context.
  Not for: cloud as the selected source, vision-guardian acceptance, self-check, or review feedback handling.
  Output: risk-matched review packet in the current thread/PR; mailbox archive only when the change needs the full packet.
triggers:
  - "请 review"
  - "帮我看看"
  - "request review"
---

> **SOP definition**: `sop-definitions/development.yaml` stage `review`。

# Request Review

把当前 diff、最高风险面和真实验证证据送到一只非作者猫眼前。默认只选一个合适的独立验证源；local peer、cloud、愿景守护各按自己的风险触发，不能因为“进入 review”就自动叠加。

## 先选验证源

| 风险需要 | 独立验证源 |
|---|---|
| 家里语境、skill/SOP/治理文字、实现语义 | local peer（本 skill） |
| 安全 / 鉴权 / 生产数据 / 外部契约，或需要 context-blind 代码扫描 | cloud；不再同时把同一问题默认发 local |
| 用户可见 feature 的终态是否符合愿景 | 愿景守护；在 feature close 触发，不是每个 PR 的 reviewer |

安全、数据或契约高风险需要不同视角时可以叠加；叠加理由必须指向不同风险面。相同目的的重复 reviewer 不增加门禁强度，只增加等待。

**选择边界**：只有新增了需要第二只猫判断的实质内容，或风险面明确要求独立验证时才进入本 skill；“有 diff”“SHA 变了”“开了 PR”都不是独立触发器。机械登记、已审内容转录、低风险 direct-main docs 与可证明 continuity 可以 `skip/reuse`。一旦选择 review，同一个体不能 review 自己，证据须覆盖最终实质内容（exact SHA 或 continuityProof）。

## 发请求前

| 证据 | 何时必需 | 缺失动作 |
|---|---|---|
| 当前 diff / branch / HEAD | 始终 | BLOCKED — reviewer 不审漂移目标 |
| 五轴风险判断（行为、数据、安全、契约、不可逆） | 始终 | BLOCKED — 无法判断 review 深度 |
| 与风险匹配的验证输出 | 始终 | BLOCKED — 先跑 targeted 或 full gate |
| 原始需求摘录 | 涉及用户意图 / 愿景 | BLOCKED — reviewer 无法判断做没做对 |
| Architecture cell / Map delta / Why | 结构或 ownership 变化 | BLOCKED — 回设计面补齐 |
| author 浏览器 preview 记录 | 前端行为 / 视觉变化 | BLOCKED — author 先实际打开页面验证 |
| 根目录工件闸门 | 有媒体 / 设计证据 | BLOCKED — 先归档或移出仓库根 |

### 前端证据边界

前端验证劳动属于 author：自己启动/复用正确的 preview，走一遍关键交互，并记录 URL、操作和结果。截图、录屏、DOM assertion、Playwright 输出都可以作为证据载体；**缺截图本身不是 operator 补劳动的许可证**。

- 禁止把“请operator打开页面 / 截图给我”当 review 前置条件。
- 视觉差异需要看画面时，author 自己采截图；浏览器能力暂不可用就如实 BLOCKED 或换可用验证面，不能把劳动转嫁给 operator。
- 未合入改动验证当前 worktree，不能拿 runtime `3003/3004` 冒充。

## Review packet 深度

### 结构化轻审

低风险、单一语义面的 diff 直接在当前 thread 或 PR 发，不新增 mailbox 文档：

```text
Review target: <branch@HEAD>
Scope: <changed files / one-line intent>
Risk: <最高风险面，或 none + 理由>
Evidence: <真实命令 / preview 结果>
Ask: checked=<请 reviewer 指认最高风险面> verdict=approve|block
```

### 完整 packet

跨组件、状态对象、架构或高风险 change 使用 [`refs/review-request-template.md`](../refs/review-request-template.md)。只有需要跨 session 持久交接时才存 `review-notes/YYYY-MM-DD-{topic}-review-request.md`；PR/thread 已足够追溯时不另造归档。

完整 packet 额外包含：

- `Original Requirements`：≤5 行原话 + 真相源路径；
- `Architecture Ownership`：cell / map delta / why；
- 技术 OQ 与价值 OQ 分开；价值 OQ 才附 Decision Packet；
- 验证命令、输出与 frontend preview 证据；
- `Review-Target-ID`（需要 review sandbox 时用于 `/tmp/cat-cafe-review/{id}/{reviewer}`）。

## 工具落点与工件检查

```bash
git status --short
git diff --name-only origin/main...HEAD
git status --short | rg '^.. [^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'
git diff --name-only origin/main...HEAD | rg '^[^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'
```

两条工件命令应无输出。用 `apply_patch` 时尤其要确认改动只落在目标 worktree，主 worktree 仍干净。

## Review sandbox（按需）

只有 reviewer 需要启动未合入应用时才创建 detached / read-only sandbox：

```text
/tmp/cat-cafe-review/{review-target-id}/{reviewer-handle}
```

统一入口 `pnpm review:start`，请求中记录实际 web/api 端口。只审 diff 或治理文字时不启动 sandbox；要改代码则 TAKEOVER，另开正式 worktree。

## Verdict return route

### Review Entry Mode Classifier（先于 task / PR tracking）

exact-HEAD external PR review 在写 task 或 PR tracking instructions 时就必须定型，不能等 verdict 出来再补出口：

- `reviewMode=formal`（默认）：任务必须授权写回同一 GitHub subject。formal task/tracker 出现 `no-comment`、
  “不要评论 GitHub”或“不落 GitHub”即互相矛盾，fail closed；退回改写，不能私下做完。
- `reviewMode=advisory_read_only`（必须显式）：允许只读私下审计，但输出只能是 advisory findings；不得产出
  `APPROVE` / `REQUEST_CHANGES` 完成态，也不得进入 `review-complete`。
- `local_cat` handoff：继续走 author cat route，不因 review target 是 PR 而强制 GitHub comment。

先按 **author/custody/handoff source** 判 external / local_cat / unknown，再判 mode。不要把缺少 GitHub 写入授权
静默解释为 advisory；没有显式 `advisory_read_only` 就按 formal 冲突处理。PR tracking 路径同样适用，旧
instructions 中的 no-comment 禁令必须在新 HEAD 复审前清除。

正式结论前按 **author/custody/handoff source** 分类，repo 名和 GitHub login 不参与分类：

- 外部作者或 external PR / Issue custody：verdict 必须写回同一 GitHub subject，并绑定精确 PR HEAD / Issue body digest；没有 review/comment URL 就还没完成。
- 本地猫通过 `@` / handoff 交来的 review：默认走 author cat route。开始真实 review 链时，同 thread 用 `post_message(coordination.phase=active)`，跨 thread 用 `cross_post_message(coordination.phase=active)`；final verdict 用同一 carrier 的 `coordination.phase=terminal` 回原 route。包内带 final HEAD / content digest 与独立验证证据，不强制 GitHub comment。

两条完成证据不能互相代偿。本地 review 只有在 **merge-gate、repository rule 或 operator** 明确要求时才额外写 GitHub；额外 artifact 不取代回作者猫的 custody。

terminal verdict 是这条 direct review coordination 的最后一次必达投递。作者确认 exact target、`no open items` 后直接进入 merge-gate 或 clean-stop；不再为了“出口必须有 @”回传 courtesy ACK。即使作者补发礼貌 ACK，terminal fence 也只持久化、不再唤醒 reviewer。

已完成 review lease 只有出现需要判断力的新信息才可重开。新 exact HEAD 复审必须携带 `reviewReentry`：`behavioral_delta`、`stale_or_blocking` 或 `explicit_matrix_route` 三选一，并附 durable evidenceRef；初审省略该字段。cloud finding 不是把本地旧 reviewer 拉回来的理由，纯 ACK / 状态复述 / 无新信息也不是。

需要额外 GitHub artifact 时，家里共享 GitHub login 不能用 `gh pr review --approve` 自我账号审批，应使用 `gh pr comment {N} --body-file <verdict.md>` 留逻辑 verdict，并包含：

- APPROVE / REQUEST_CHANGES / COMMENT；
- 覆盖的 final HEAD SHA；
- 独立验证证据；
- reviewer 自己的身份签名。

共享 login 不改变“author catId ≠ reviewer catId”的铁律，也不能把平台 self-review 当成跨个体 review。

## Feedback 循环

- P1/P2 修复后，只让**提出该 finding 的活跃 review source**覆盖新 HEAD。
- cloud finding 修复回 cloud；local finding 修复回 local。不要把二者叠成常驻双门。
- R2+ 同型 finding 再出现时，author 给出 Failure-Mode Sweep（pattern / scanned / fixed / N/A），避免 reviewer 逐点补锅。

## 正反灰例

- 正例：skill/SOP 语义改动 → 一只跨族 local peer，targeted checks，跳 cloud。
- 正例：auth callback 变更 → cloud + full gate；若还需要家里状态语义，再有理由叠 local。
- 反例：local 已审纯文案，又因“流程到了”触发 cloud。
- 反例：author 没 preview，要求 operator 截图后才肯发 review。
- 灰例：前端 copy-only 改动仍应由 author preview；截图可选，DOM/页面证据足够时不阻塞。

## Common Mistakes

| 错误 | 后果 | 修正 |
|---|---|---|
| 把 local、cloud、guardian 当固定三连 | 同一风险重复付费 | 每个源写清独立触发理由 |
| 所有请求都建 mailbox | 为追溯再造追溯 | light 用 thread/PR packet |
| “没有截图”就把球扔给 operator | 用户替 author 做 QA | author 自跑 preview，截图只是载体 |
| 只因 reviewer SHA ≠ 新 HEAD 就重开 review | 机械 rebase/合并重复烧判断力 | 先做 continuityProof；只有新增实质内容才回 active source |
| 本地 finding 修完又找 cloud 续签 | review source 串线 | 回对应 active source |
| terminal verdict 后 author 再 `@reviewer` ACK | 双方无 open items 仍制造乒乓 | clean-stop；新复审必须提供 `reviewReentry` |

## 和其他 skill 的区别

- `quality-gate`：author 自证；本 skill 是选中 local peer 后的独立验证。
- `receive-review`：处理已经收到的 finding。
- `merge-gate`：消费选定 review source 与验证证据，决定合入。

## 下一步

收到 local verdict 后进入 `receive-review`；放行且证据覆盖 final HEAD 后进入风险匹配的 `merge-gate`。
