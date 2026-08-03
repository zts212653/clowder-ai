---
feature_ids: [F140]
related_features: [F133, F139, F141, F168, F280]
topics: [github, conflict-detection, review-feedback, pr-signals, automation]
doc_kind: spec
created: 2026-03-26
tips_exempt: agent-facing tracking policy is surfaced in MCP parameter descriptions and pr-signals/mcp-callbacks refs; no separate web capability tip
---

# F140: GitHub PR Signals — 冲突检测 + Review Feedback 全来源感知

> ## ⛔ 契约冻结（2026-07-29，operator signoff msg `0001785311364054-000054-656d056c`）
>
> **本 Feature 的 wake 契约已移交 F280 Unified Wait Contract。**
> F140 从此不再接受新的 post-completion 补丁——下面那串从 2026-05-07 到 2026-07-20 的
> 修正记录（backlog guard → `intent` 轴 → routing 修正 ×2 → CI state-only → `wakePolicy` 轴）
> 本身就是病历：一个 done 的 Feature 被当活体补锅了三个月，因为"哪些事件该唤醒猫"
> 从一开始就被建模成了事件订阅，而不是等待契约。
>
> `intent` 与 `wakePolicy` 将在 F280 Phase B 随 PR adapter 切换**同 PR 删除**，不留 deprecation 期。
> 新的噪音问题请开在 F280，不要在这里加第三个开关。采集/冲突检测部分仍以本文件为真相源。

> **Status**: done（wake 契约 superseded by F280） | **Owner**: Ragdoll | **Priority**: P1 | **Phase A-D Completed**: 2026-03-27 | **Reopened**: 2026-04-24（Phase E — 通知合流：severity 抽取 + 下线 email 路径） | **Completed**: 2026-04-25
> **Post-completion hardening**: 2026-05-07 — Review Feedback backlog guard（merged/closed 自收敛 + stale commit 过滤 + 同 PR/target-cat queue coalesce）
> **Post-completion correction**: 2026-06-18 — PR #2394 (squash 1d42b8f36) fixed PR review feedback routing to preserve the PR-tracking registration thread. #949 auto-rotation / PR #2372 backlink was the wrong layer: context overflow belongs to invocation hydration, not thread ownership. Review feedback no longer creates `MR review (auto-rotated...)` threads, and legacy already-rotated tracking tasks are repaired back to their source thread before delivery. If such a repair happens, the original thread receives an explicit routing-anomaly audit warning; this is fault exposure, not a redirect design.
> **Post-completion correction audit**: 2026-06-18 — PR #2404 (squash bcabe177) keeps legacy routing repair visible even when feedback is filtered, persists the repair only after audit delivery succeeds, and makes the repair thread update conditional to avoid overwriting a fresh re-registration.
> **Post-completion**: 2026-06-03 — PR-tracking wake intent（PR #2070）：`register_pr_tracking` 加 `intent: review|merge`，CI-pass 仅 intent=merge 唤醒；删 approval 推断 + dead poller
> **Post-completion correction**: 2026-07-05 — PR #2756 (squash 089d089d1) changed review-intent CI-pass from "thread message but no wake" to true state-only recording: update `automationState.ci` without connector message/freshness unread; `intent=merge` pass and all CI failures still notify.
> **Post-completion hardening**: 2026-07-20 — PR #3095 adds an actor-aware tracking `wakePolicy`, independent from `intent`: the backward-compatible default remains `all_feedback`; `human_participant_activity` wakes for GitHub `User` activity while retaining GitHub `Bot` activity as durable state-only truth.
> **Post-completion correction**: 2026-07-20 — PR #3113 makes legacy combined PR comment cursors migrate to independent inline/conversation cursors as durable state-only backfill. Historical human comments still enter the event log and advance both cursors, but cannot create connector delivery, freshness, F168 cloud wake, or invocation.
> **Post-completion hardening**: 2026-07-27 — F128 approved formal external-PR children now carry canonical PR metadata and reconcile an owner-valid `review + human_participant_activity` tracker, closing the repeated maintainer-transition gap seen in clowder-ai#1210 and F88.

## 三层架构定位

```
① F141 发现层 (Repo Inbox) → "仓库里来了新东西"（webhook 被动推送）
② 认领层 (Triage)           → "谁来跟？"（register_pr_tracking）
③ F140 追踪层 (PR Signals)  → "这个 PR 现在怎么样了？"（F139 轮询）
     └─ F133: CI Signals (done)
     └─ F140: Conflict + Review Feedback Signals (本 Feature)
```

**产品域命名**：GitHub Automation > GitHub PR Signals > F140

## Why

社区开发者（fork 用户）在讨论 AI 开发中的核心痛点：

> 郑亚林："当前我们都使用 AI 开发，存在的代码冲突比较会比较大，后面我们提交代码这部分怎么搞"
> 胡兴哲："猫猫挂 webhook，收到冲突，自动处理...比如别人 MR 了以后，我的代码有一条 message 是冲突，这块好像要增强一下"
> 胡兴哲："基于 github 就是几乎都可以自动"

operator补充：

> "review 的不止是云端的 codex 而是你给他们的 comments 哦，这个估计也得覆盖？"
> "这个就是社区里那几个人讨论的那个，我们单独立项不要挂 F133"

**角色需求**（Maine Coon GPT-5.4 分析）：

- **Contributor 最想知道**："我现在要不要动手？"
  - 冲突出现 → 要动手 rebase
  - review feedback（comments + requested changes）→ 要动手改
  - approved → 可以准备 merge

- **Maintainer 最想知道**："这个 PR 现在是 ready、blocked、还是需要我介入？"
  - 冲突 → PR blocked
  - review state 变化 → PR 进展
  - approved → 可能 ready

**现状 Gap**：F133 解决了 CI/CD 状态追踪，但 PR 冲突检测和全来源 review feedback 感知仍未闭环。F139 Phase 1a 已交付统一调度框架（TaskRunnerV2 + TaskSpec_P1），并注册了 `conflict-check` 和 `review-comments` 的骨架（gate 能感知，execute 是 stub）。本 Feature 补完 execute 层：投递 + 唤醒猫 + 行为引导。

## What

### Phase A: 投递管道 + 消息路由 + 行为引导

在 F139 Phase 1a 已注册的 TaskSpec 基础上，实现 execute 函数的实际投递逻辑：

**1. ConflictRouter**
- 格式化冲突消息：哪个 PR、`mergeStateStatus` 变化（MERGEABLE → CONFLICTING）
- 通过 `deliverConnectorMessage()` 投递到注册 PR 的 thread
- `ConnectorInvokeTrigger` urgent 唤醒猫

**2. ReviewFeedbackRouter**
- 格式化 review feedback 消息：
  - 新 comments：谁留的、在哪个文件、说了什么
  - review decision 变化：approved / requested changes / dismissed
- 覆盖所有来源：Codex remote review、人类 reviewer、猫通过 `gh pr review` 留的 comments
- 投递到 thread + 唤醒猫

**3. ConnectorSource 注册**
- `github-conflict`：冲突通知 connector（orange/warning 主题）
- `github-review-feedback`：Review feedback connector（slate 主题，复用 GitHubIcon）

**4. ConnectorBubble 渲染**
- 两个新 connector 类型的图标渲染（复用 GitHubIcon SVG，按 connector 类型区分颜色/badge）

**5. Skill/SOP 更新**（行为引导——没有 Skill 引导的信号投递 = 无效）
- `merge-gate` SKILL.md：告知猫猫注册 PR 后会收到三类通知（CI + 冲突 + review feedback）
- `receive-review` SKILL.md：补充 GitHub PR review feedback 入口的处理流程
- `opensource-ops` SKILL.md：maintainer 处理社区 PR 的冲突/review 状态
- `refs/pr-signals.md`：新增——PR Signals 通知格式、处理策略、配置说明

### Phase B: 自动响应引导层 (Auto-response Guidance)

猫收到冲突/review feedback 通知后的操作引导——消息级 action hints + Skill 行为决策树，猫据此知道该做什么并按 Skill 流程执行：

**1. 冲突 action hint**
- 冲突消息附带 rebase 操作指引（KD-13: 全自动 + 事后通知）
- Skill 层（merge-gate / pr-signals）定义简单/复杂冲突分级决策树

**2. Review feedback action hint**
- Review feedback 消息按 decision 类型（CHANGES_REQUESTED / APPROVED / COMMENTED）附带分流操作指引
- Skill 层（receive-review / pr-signals）定义 review 处理入口

> **注**：Phase B 是引导层——猫看到 action hint 后仍需按 Skill 流程手动执行操作。真正的零点击自动执行器（代码层面自动 rebase + push + 处理 review）见 Phase C。

### Phase C: 自动执行器 (Auto-executor) ✅

猫收到通知后**零人工干预自动执行**：

**1. 冲突自动 resolve**
- 猫收到冲突通知 → 在 worktree 中 `git fetch origin main && git rebase origin/main`
- 自动解决简单冲突 → push → 等下一轮 CI 通知
- 复杂冲突（无法自动 resolve）→ 通知operator

**2. Review feedback 自动处理**
- 猫收到 review feedback 通知 → 自动加载 receive-review 模式 → 逐项处理
- 区分 review decision：requested changes / approve / comment → 不同自动处理策略

### Phase D: 注册校验护栏

> **愿景**：PR tracking 是面向开源社区的通用功能——社区小伙伴在自己的项目里也能用。注册接口不能假设仓库是哪个，但也不能接受不存在的仓库名（脏数据会让 F139 轮询器查错 repo）。
>
> **守护**：不硬编码 `zts212653/cat-cafe`，用 `gh repo view` 动态校验。合法 repo 全放行，非法 repo 全拦截。
>
> **根因**：2026-03-25 一次 merge-gate 注册了 `anthropic-cat-cafe/cat-cafe#743`（repo 不存在），脏数据驻留导致 CI/CD Check 轮询假仓库。

**改动**：`callbacks.ts` 和 `pr-tracking.ts` 的两条注册路径，在 `prTrackingStore.register()` 前加 `gh repo view` 校验

### Phase E（通知合流 — severity 抽取 + 下线 email 路径）✅ completed 2026-04-25

>
> **愿景闭环**：Phase A 起的目标是"review feedback 全来源感知"，但 severity 感知能力只落在了遗留 email 通道。合流的前置是把 severity 能力搬到 polling 通道，再下线 email。

**E.1 Severity parser + setup-noise filter（前置 — 不能反序）**

- **Severity 抽取**：在 `buildReviewFeedbackContent()` 里加严格 parser，扫 `newComments`（inline + conversation）+ `newDecisions`（review body）每条 body，抽出最高 severity（P0 > P1 > P2，**不识别 P3** — informational）→ 消息头追加 `**Review 检测到 P0/P1/P2**`。复用 polling 已 fetch 的数据，不引入额外 API call
- **三种严格格式**（任一匹配才算）：
  - shields.io badge：`img.shields.io/badge/P[0-2]-`
  - 行首方括号：`^\[P[0-2]\]`（或独立 token 边界）
  - 行首冒号：`^(\*\*)?P[0-2](\*\*)?:`
- **护栏**（FP 防御）：
  - 排除 fenced code block（` ``` ` 内）
  - 排除 blockquote（`> ` 开头的行，通常是引用旧 finding）
  - 拒绝句内裸词（`I think this is P1` / `P100` / `MP3` 不触发）
- **Setup-noise filter**（搬自 legacy email-channel Rule 3）：factory `createSetupNoiseFilter(botLogins)` 返回 context-aware predicate（接 `{author, body, commentType}`），polling gate 在 `fetchComments` 后应用。**Scope 严格收窄**：只吞满足所有三条的 comment——`author ∈ botLogins` + `commentType=conversation` + body 含 setup sentence 且无 `codex review` content。inline / 非 bot author / bot 含 review content 全不吞；**人类 reviewer 引用 setup 文案不被过滤**（关键守护，保留 legacy classifier 负例语义）。裸 `@codex review` 和触发模板回声**归 Rule A**（`shouldSkipComment` self-authored skip）处理，E.1 不在 setup-noise filter 重复判定

**E.2 下线 email bootstrap + 删除 Rule B 语义（合流切换）**

- **删除 Rule B（authoritative-source 语义）**：`createGitHubFeedbackFilter()` 不再读 `authoritativeReviewLogins` 去 skip bot review/inline comment——cutover 后 polling 是唯一真相源，skip 掉 bot feedback = 数据丢失。只保留 Rule A（self-authored skip）
- **配置清理**：`GITHUB_AUTHORITATIVE_REVIEW_LOGINS` 环境变量删除（或改名 + 语义改为"窄 setup-noise 识别 allowlist"），env-registry 文案同步更新（原"email channel is authoritative source"描述失效）
- **bootstrap 停用**：`startGithubReviewWatcher()` 从 `src/index.ts` 移除调用，`.env.example` + deployment doc 撤 `GITHUB_REVIEW_IMAP_USER/PASS/HOST/PORT/PROXY/POLL_INTERVAL_MS` 字段
- **证据门槛**：alpha 环境验证至少 3 个场景后才进 E.3：
  - Scene 1：bot review 含 P2 inline comment（应在消息头显示 P2）
  - Scene 2：bot review pass / no severity（应不加 header）
  - Scene 3：人类 reviewer CHANGES_REQUESTED / COMMENTED（应正常渲染，不被 Rule B 吞）

**E.3 代码清理（独立 PR）**

- 删除文件：`GithubReviewWatcher.ts` / `github-review-bootstrap.ts` / `ReviewRouter.ts` / `ReviewContentFetcher.ts` / `GithubReviewMailParser.ts` / `ProcessedEmailStore.ts` + 相关 tests（`review-router.test.js` / `review-content-fetcher.test.js` 等）
- `github-feedback-filter.ts`：精简为只有 Rule A（self-authored skip），删除 `authoritativeReviewLogins` option
- 从 `infrastructure/email/index.ts` 移除对应导出
- `src/index.ts` 移除 watcher 启动逻辑和 Rule B 配置传递

### Post-completion hardening（Review Feedback backlog guard）✅ completed 2026-05-07

> **根因**：ReviewFeedbackTaskSpec 只依赖 pr_tracking task 的 `done` 状态，不独立查询 PR 生命周期；GitHub review 决策没有带 `commit_id` 进入本地模型，无法过滤旧 head review。长任务活跃时，ConnectorInvokeTrigger 只按单条 messageId 去重，同一 PR 的 review-feedback 会逐条进入自动处理队列。

**修复**：
- Review feedback gate 独立查询 PR metadata：`merged/closed` 直接把 pr_tracking task 标 `done`，不再 fetch/投递 feedback
- `PrFeedbackComment` / `PrReviewDecision` 带 `commitId`，当 GitHub item 的 `commitId !== current headSha` 时视为 stale，推进 cursor 但不通知
- Connector trigger 增加 policy `coalesceKey`，F140 review-feedback 以 `subjectKey + target cat` coalesce；同一 PR/同一 owner 在 active thread 下只保留一个 queued invocation，同时保留 urgent 升级和 in-flight follow-up 重新排队语义

### Post-completion: PR-tracking wake intent ✅ completed 2026-06-03（PR #2070）

> **根因**：F217 把 Actions 留开 + 两个 guard workflow（pr-followup-guard / shared-state-guard）仍产生 check-run，私人仓 PR 上重新出现 `github-ci` 事件。但 `register_pr_tracking` 把 review feedback + CI/CD + conflict 写死成三合一、**没有 intent**：猫"喊 review 等反馈"和"等 CI 绿去 merge"被塞进同一个 tracking，系统分不清 CI-pass 是噪音还是动作信号。operator点名两类被误伤的场景：开源仓 outbound PR 等 CI 绿 merge、owner 盯别人 PR 等 CI 绿代 merge。

> **错层教训**：本次最初 4 轮（R1-R4）试图在 CI-green 那刻**推断** intent（用 approval-state：`isHeadApproved` + stale-head 绑定 + in-place-DISMISSED 现查 + transport 重试），每轮 reviewer 抓的新 edge case 都是这个错抽象的症状——「补锅匠」战术勤劳、战略卡在错的层。Maine Coon（GPT-5.5/5.4）把根因拉回 intent 模型后，整套 approval 推断删除、edge case 蒸发。

**修复**：
- `register_pr_tracking`（schema + callbacks handler + MCP tool）加 optional `intent: 'review' | 'merge'`（默认 `review`），结构化持久到 `task.automationState.intent`；re-register 不指定时保留已有 intent（deep-merge 不丢 ci/review cursors）。**intent 是任务意图、不是 repo 类型**（私人仓可 merge、开源仓可只 review）。
- `CiCdCheckTaskSpec` / `CiCdRouter` CI-pass：`intent==='merge'` 才投递并唤醒（normal → merge-gate），否则只更新 CI state/fingerprint，不投递 connector 消息；CI fail 两种 intent 都 urgent 唤醒。一次查表，删除 approval 推断（`isHeadApproved` / retry-marker / `fetchPrReviews`）。
- 删遗留 dead poller（`CiCdCheckPoller` + `github-ci-bootstrap`），util 迁 `ci-status-fetcher`。
- 文档收敛：`cicd-tracking.md` / `pr-signals.md` / `merge-gate` / opensource-ops（outbound / hotfix）/ repo-inbox / mcp-callbacks 对齐 intent 语义；开源/owner-merge 路径显式 `intent='merge'`；merge-gate 写清 fingerprint 时机契约（翻 merge 要在 CI 没绿前，已绿则 `gh pr checks` 自查）。
- **后续噪音收口（2026-06-04，operator）**：
  - `cancelled` run 不再误判 failure（PR #2087）——push 新 commit 时 GitHub 自动取消旧 run，`computeAggregateBucket` 原把 `cancelled` 当 fail → superseded-run 假 CI-fail 唤醒。改：按 GitHub success 态口径（success/skipped/neutral），`cancelled` 既非 fail 也非 success；`pass` 需至少一个真 positive，`cancelled`-only → `pending`（不当假绿灯）。
  - cat-cafe 私人仓两个 PR guard workflow（`pr-followup-guard` / `shared-state-guard`）已 `gh workflow disable`——与本地 `pnpm gate`（`check:followup-tails` + `preflight-shared-state`）重复、且制造 CI 噪音；F217 已定私人仓不靠 server-side gate。桌面构建/发布 workflow 保留。可逆（`gh workflow enable`）。
  - 2026-07-05 follow-up（PR #2756，squash 089d089d1）：`intent=review` / absent intent 的 CI-pass 不再投递 `github-ci` connector message，只更新 `automationState.ci` 的 `headSha/lastFingerprint/lastBucket`。根因是“静默但投递线程消息”仍会产生 freshness 未读，后续把 CI 成功重新变成唤醒噪音。`intent=merge` 的 CI-pass 与 CI fail 保持投递 + 唤醒。

### Post-completion: actor-aware tracking wake policy ✅ implemented 2026-07-20（PR #3095）

> **根因**：PR #1185 型开源 review 流程中，不同 HEAD generation 的 cloud reviewer 过程性 feedback 都是新的 GitHub 事件，因此既不属于同 HEAD duplicate，也不应被 F167 的 custody 去重吞掉。旧 F140 契约只有 `intent=review|merge`，无法表达“保留 automation truth，但只为人类参与者叫醒 reviewer”。

**契约**：
- `register_pr_tracking` / `register_issue_tracking` 增加独立 `wakePolicy`，结构化持久到 `task.automationState.wakePolicy`；re-register 不指定时保留已有值。缺省为 `all_feedback`，守住 #1002 的全 feedback 投递行为。
- `human_participant_activity` 只用 GitHub REST `user.type` 分类：`User`（PR/issue author 或任意第三方人类）投递；`Bot` state-only；缺失或未知 actor type fail-safe 投递。`authorAssociation=OWNER|MEMBER` 只是 repo 权限关系，不参与人类/author 身份判定；subject author 用 GitHub subject metadata 的 author login。
- 精确 self echo / setup-noise 仍走既有 suppression；issue critical/security 协议继续优先唤醒。`intent` 决定等待哪类信号，`wakePolicy` 决定哪些 actor 能把已采集信号升级为 delivery，两者不互相推断。

**耐久性与 seam**：
- `ReviewFeedbackTaskSpec` 与 `IssueCommentTaskSpec` 都先 append event log / apply projector，再执行 actor policy。Bot-only batch 仍推进 collection/delivery cursor，但不创建 work item，因此没有 connector delivery、freshness unread、trigger invocation 或 hold retirement。
- GitHub pollers把 REST `user.type` 与 subject author metadata带进统一策略；actor metadata不可得时不会误抑制。
- F168 `ExternalReviewCoordinator` 仍记录 cloud observation、current-HEAD readiness 与 pending wake provenance；在 `human_participant_activity` 下只截断 `deliverReady`，返回 `wake_policy_state_only`。这是 delivery policy，不是丢弃 feedback，也不扩张 F177 routing guard / F167 custody scope。
- PR tracking 的 legacy combined comment cursor 不能直接 seed 两个 GitHub endpoint（ID 空间不可比较），因此会从两个 source 的 0 cursor 回填。首轮为每个 source 固化 snapshot frontier；`id <= target` 的 backfill（包括旧 HEAD inline comment）照常 append/project event log 并推进 source cursor，但不进入 actor delivery 或 F168 comment candidate。任一 source 未到 target 时持久化 `commentCursorMigrationPending=true` 与两个 target；其他 source 在 snapshot target 之后的新活动仍正常 live，不被全局 pending 误抑制。Review decision cursor 独立，不受 comment migration 抑制；issue tracking 没有这条 split-cursor migration 路径。

**验证边界**：actor matrix 覆盖 subject author / third-party human / self / Bot / unknown；PR 与 issue 都有 durable state-only regression；显式及缺省 `all_feedback` 守住 #1002。发布后只做一个 #1185 型 replay/smoke，不新建无 ground truth 的长期 F192 指标。

### Post-completion: inbound maintainer ownership transition

> **根因**：F128 能创建正式 external-PR review child，F140 也能追踪人类活动，但两者之间只有文字约定。Maintainer 把 findings 交给外部作者后，如果 reviewer 忘记手工注册 tracker，child 不会收到作者新 HEAD；clowder-ai#1210 与 F88 都需要 operator 再次提醒。Gate-keeping thread 又被正确禁止直接注册，因此缺口必须在已批准 child 的 owner transition 上闭合。

**契约**：
- `propose_thread` 只对“单一 canonical clowder-ai PR + 明确 formal review intent”持久化 `{repoFullName, prNumber, mode=formal_review}`；advisory、triage、任意 URL 引用、多 PR 歧义都不产生 tracking context。
- Approval 先以最终 `preferredCats` 解析实际 child owner。恰好一个 owner 时，server 把 canonical PR 原子合入 child `threadMetadata.prs`，并对全局 `pr:<repo>#<number>` subject 创建或 upsert `pr_tracking`：owner/thread 精确绑定 child，`intent=review`，`wakePolicy=human_participant_activity`。
- 没有 owner 或多个 owner 时 fail closed：metadata 仍保留，但不猜 tracker owner；source gate-keeping thread 始终没有 tracker。既有 subject 属于其他 user 时也不抢占。
- Findings 交付给 external author 后 tracker 保持 active。重复 approve、边界获取失败后的重试、以及 thread 已创建但 proposal finalize 中断的 stale recovery 都重跑同一幂等 reconcile；既有 cursor/status 不回退。
- 后续 activity 继续复用 actor-aware 契约：GitHub `User` 与 unknown metadata fail-safe 唤醒，`Bot` durable state-only；无需叠加 timed hold，也不新增 eval。

## Acceptance Criteria

### Phase A（投递管道 + 消息路由 + 行为引导）✅
- [x] AC-A1: PR mergeable 状态从 MERGEABLE → CONFLICTING 时，冲突消息投递到注册 PR 的 thread
- [x] AC-A2: 冲突消息通过 ConnectorInvokeTrigger urgent 唤醒猫
- [x] AC-A3: GitHub PR 上的新 comments（不限来源）投递到注册 PR 的 thread
- [x] AC-A4: Review decision 变化（approved / requested changes / dismissed）投递到 thread
- [x] AC-A5: Review feedback 唤醒猫处理
- [x] AC-A6: ConnectorSource `github-conflict` 和 `github-review-feedback` 注册，ConnectorBubble 正确渲染图标
- [x] AC-A7: 冲突状态迁移去重 — CONFLICTING 后 push 新 commit 回到 MERGEABLE 不重复通知
- [x] AC-A8: Comments/review cursor 去重 — 同一 comment/review 只通知一次，cursor 仅在 execute 成功后推进
- [x] AC-A9: 测试覆盖：ConflictRouter + ReviewFeedbackRouter 单元测试
- [x] AC-A10: merge-gate / receive-review / opensource-ops SKILL.md 更新
- [x] AC-A11: refs/pr-signals.md 新增

### Phase B（自动响应引导层）✅
- [x] AC-B1: 冲突消息附带 rebase action hint + Skill 行为决策树
- [x] AC-B2: pr-signals.md 定义简单/复杂冲突分级（≤3 文件 vs 复杂）
- [x] AC-B3: Review feedback 消息按 decision 类型附带分流 action hint

- [x] AC-C1: 猫收到冲突通知后零人工干预自动 rebase + push（clean rebase 场景）
- [x] AC-C2: 简单冲突（≤3 文件，non-binary）自动 resolve，复杂冲突通知operator附冲突文件列表
- [x] AC-C3: 猫收到 review feedback 后自动加载 receive-review 模式处理（CHANGES_REQUESTED 场景）— suggestedSkill routing wired，full auto-processing deferred（intent is hint not constraint）
- [x] AC-C4: TriggerIntent 流水线——intent 从 trigger → AgentRouter → SystemPromptBuilder 贯通
- [x] AC-C5: ConflictAutoExecutor 测试覆盖：clean / simple-conflict / complex-escalation / worktree-not-found
- [x] AC-C6: 安全护栏——只操作 feature worktree，绝不碰 main/runtime，操作超时 abort

### Phase D（注册校验护栏）✅ — PR #773 merged 2026-03-27
- [x] AC-D1: `register-pr-tracking` 写入前校验 `repoFullName` 指向真实存在且调用者有权限的 GitHub 仓库（`gh repo view` 可解析）
- [x] AC-D2: 校验不硬编码当前仓库——任何合法 GitHub 仓库都可注册，只拦截不存在/无权限的
- [x] AC-D3: 两条注册路径（`/api/pr-tracking` + `/api/callbacks/register-pr-tracking`）都加校验
- [x] AC-D4: 测试覆盖：合法 repo 通过、不存在 repo 拒绝、格式错误 repo 拒绝

### Phase E（通知合流 — severity 抽取 + 下线 email 路径）✅ done
- [x] AC-E1: `buildReviewFeedbackContent()` 扫 `newComments` + `newDecisions` 所有 body，抽出最高 severity 生成 `**Review 检测到 P0/P1/P2**` 消息头（**P3 不识别** — informational） — SHA 645ac9de8
- [x] AC-E2: severity 识别支持三种严格格式：shields.io `img.shields.io/badge/P[0-2]-` / 行首 `[P0-2]` / 行首 `P0-2:` `**P0-2**:` — SHA 06cbe1959
- [x] AC-E3: FP 护栏：排除 fenced code block 内、排除 blockquote（`> ` 行）、拒绝句内裸词（`I think this is P1` / `P100` / `MP3` 都不触发） — SHA 06cbe1959
- [x] AC-E4: 多条 findings 取最高 severity（P0 > P1 > P2）；无匹配则不加 header（保持现状） — SHA 06cbe1959 + 645ac9de8
- [x] AC-E5: 单元测试覆盖：severity-parser 18 / setup-noise 9 / review-feedback-router 12 / review-feedback-spec 31，**共 70 tests 4 suites 全绿**，含 FP 负例 9 条（fenced/blockquote/badge × P1/P2 + 句内裸词 + P100 + MP3 + P3 + empty）— SHA 06cbe1959 + 77cf7ec28
- [x] AC-E6: Setup-noise filter 搬自 legacy email-channel Rule 3，factory `createSetupNoiseFilter(botLogins)` 返回 context-aware predicate（接 `{author, body, commentType}`），polling 侧在 gate 应用。**Scope 严格收窄**：只吞 `author ∈ botLogins` + `commentType=conversation` + body 含 setup sentence 且无 `codex review` content；inline / 非 bot author / bot 含 review content 全不吞。守护负例：人类 reviewer 引用 setup 文案不被过滤（保留 legacy classifier 负例语义）。裸 `@codex review` / 触发模板回声**归 Rule A** 处理（self-authored skip），E.1 不重复 — SHA 77cf7ec28 + 67a820f2c
- [x] AC-E7: **删除** Rule B（authoritative-source 语义）：`createGitHubFeedbackFilter()` 简化为 Rule A only（self-authored）；`GITHUB_AUTHORITATIVE_REVIEW_LOGINS` env 改名 `GITHUB_SETUP_NOISE_BOT_LOGINS` + 老 env 标 `[DEPRECATED]` 兜底向后兼容（env-registry.ts 已注册新 entry） — SHA 00d7a834
- [x] AC-E8: bootstrap 移除 `startGithubReviewWatcher()` 调用 + `ReviewRouter`/`GhCliReviewContentFetcher`/`MemoryProcessedEmailStore` 实例化删除（dead code post-watcher）+ shutdown handler `stopGithubReviewWatcher` call 移除 + 无用 imports 清理 — SHA 00d7a834（`.env.example` 原本就无 IMAP 字段）
- [x] AC-E9: ~~Alpha 环境 3 场景证据门槛~~ — **降级 (2026-04-25 operator拍板)**：alpha frontend 3011 webpack `.xterm` CSS loader 挂 + pinchtab MCP 503 → 浏览器端到端验收阻塞，且非 F140 scope。改用三件套凭证：(1) **Unit tests 79/79 全绿** 守护三场景核心 invariant（Scene 1 review-feedback-router test "P2 badge → header"; Scene 2 "no severity → no header"; Scene 3 filter Rule A only test + 人类 引用 setup 文案 not skip 守护）；(2) **双 family reviewer 复审 pass**（gpt52 + codex chat approve E.1+E.2 + 2 处 followup cleanup）；(3) **云端 codex bot 双 PR review pass**（PR #1380 "no major issues"; PR #1386 "Hooray"）。Production smoke：runtime 重启后下次实际 PR review 自然验证
- [x] AC-E10: 代码清理（独立 PR #1398, squash 397df85c）— 删除 11 文件（6 src: GithubReviewWatcher / github-review-bootstrap / ReviewRouter / ReviewContentFetcher / GithubReviewMailParser / ProcessedEmailStore + 5 tests）+ 清 `infrastructure/email/index.ts` 8 组 deprecated re-exports + 清 `src/index.ts` E.2 残注释 + 6 处其他文件残留注释。`github-feedback-filter.ts` Rule A only 已在 E.2 完成。Maine Coon GPT-5.5 双轮 review (P2 6 处注释残留 → fix → no-findings) + 云端 codex "Swish! no major issues" — SHA 397df85c

## Dependencies

- **Evolved from**: F133（CI/CD tracking — 投递管道模式复用）
- **Blocked by**: F139 Phase 1a（统一调度框架 — ✅ 已合入 PR #747）
- **Sibling**: F141（Repo Inbox 发现层 — 不阻塞，可并发）
- **Related**: F139（conflict-check + review-comments TaskSpec 骨架由 F139 交付）

## Risk

| 风险 | 缓解 |
|------|------|
| `gh api` 查 mergeable 有延迟（GitHub 异步计算） | 首次 UNKNOWN 状态跳过，下一轮重查 |
| Comments 量大导致消息洪水 | cursor 去重 + 同一 PR 聚合通知（不逐条） |
| 自动 rebase 可能引入问题 | Phase B：复杂冲突不自动处理，通知operator |
| Fork PR 的 comments 权限差异 | `gh api` fallback 到公开 API |
| ~~🔴 回声过滤缺失~~ | ✅ 已修 PR #761 — `isEchoComment` 谓词：author（selfGitHubLogin）+ body（trigger 模板）双重判定，外部 reviewer 不受影响 |
| **🔴 ConnectorIcon 遗漏** | `github-conflict` / `github-review-feedback` 未加入 ConnectorIcon switch，渲染成文字 fallback（✅ 已修 PR #757 后 hotfix） |
| ~~🔴 Review 双重消费~~ | ✅ 已修 PR #764 — 统一 `createGitHubFeedbackFilter()` 工厂：Rule A 自身过滤（两通道）+ Rule B 权威 bot 过滤（仅 F140 API polling），email 通道用 `isSelfAuthored` 保留 bot review 的权威消费权 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 基于 F139 统一调度，不搞独立 setInterval | operator指示"不太喜欢很多套东西" | 2026-03-26 |
| KD-2 | 投递管道复用 F133 的 deliverConnectorMessage() | 体验一致，代码复用 | 2026-03-26 |
| KD-3 | 独立立项不挂 F133 | operator指示"单独立项不要挂 F133" | 2026-03-26 |
| KD-4 | ReviewFeedbackRouter（非 ReviewCommentsRouter）| Maine Coon指出：contributor 在乎的不是"有没有 comment"，而是"review feedback 有没有改变 PR 的下一步动作"。只追 comments 不追 decision，信息不完整 | 2026-03-26 |
| KD-5 | review decision state（approved/requested changes/dismissed）进 Phase A | 比 label/assignee 更有行动价值：contributor 看到 requested changes 才知道"现在该改"，maintainer 看到 approved 才知道"可能 ready" | 2026-03-26 |
| KD-6 | Skill/SOP 更新是 Phase A 必须组件 | operator指出：技术管道建了没有行为引导 = 通知发了猫不知道怎么处理 = 等于没做。F133 Phase B 就是做这件事 | 2026-03-26 |
| KD-7 | F140 定位为追踪层（PR Signals），发现层（Repo Inbox）独立为 F141 | operator确认分开立项，可并发开发 | 2026-03-26 |
| KD-8 | PrComment → PrFeedbackComment（richer model：+author/filePath/line/commentType） | Maine Coon P1：现有 PrComment 只有 id/body/createdAt，支撑不了分区展示的消息格式 | 2026-03-26 |
| KD-9 | Conflict fingerprint 在 MERGEABLE 时清除 | Maine Coon P2：同一 headSha 因 base 变化再次冲突会被误 dedupe。检测到 MERGEABLE → 清 lastConflictFingerprint，下次 CONFLICTING 重新通知 | 2026-03-26 |
| KD-10 | Cursor commit 在 delivery 成功后，trigger 是 best-effort | Maine Coon P3：delivery 成功 = 主 side-effect 完成 → 立即 commitCursor。trigger() 失败不阻塞 cursor 推进，避免重发已投递消息 | 2026-03-26 |
| KD-11 | ReviewFeedbackTaskSpec 新建替换 ReviewCommentsTaskSpec | 最便宜的改名窗口，继续保留旧名字会造成语义债 | 2026-03-26 |
| KD-12 | patchConflictState() 独立新增，不复用 patchCiState() | CI/conflict 状态语义不同，硬塞一起变成"大杂烩 patch" | 2026-03-26 |
| KD-13 | 自动 rebase 采用「全自动 + 事后通知」（OQ-3 选项 C） | worktree 隔离低风险；半自动每次需人工确认违背自动化愿景；全自动无通知operator不知情。选项 C 兼顾速度和可见性 | 2026-03-26 |
| KD-14 | 下线 email 通道（ReviewRouter + GithubReviewWatcher），统一走 polling（ReviewFeedbackTaskSpec）；前置：severity parser + setup-noise filter 搬到 polling 侧（E.1 → E.2 → E.3） | Polling 的事件面严格覆盖 email（conversation + inline + review decisions）；两套并行导致对同一 review 产生冲突叙事（🚀 vs P2 header）；F140 Phase A 原愿景"review feedback 全来源感知"就是 polling 通道做全集，email 是历史遗留。operator 2026-04-24 拍板 | 2026-04-24 |
| KD-15 | Phase E cutover 时**删除** Rule B（authoritative-source 语义），不是迁移 | Maine Coon GPT-5.4 Design Gate P1 push back（2026-04-24）：Rule B 本来就在 polling 侧（`shouldSkipComment/shouldSkipReview`），email watcher 只用 `isSelfAuthored`（Rule A）。Cutover 后 polling 是唯一真相源，继续 skip "authoritative bot feedback" = bot review/inline comment 直接消失。只保留 Rule A（self-authored skip） | 2026-04-24 |
| KD-16 | Severity parser 严格格式 + FP 护栏 | Maine Coon指出现有 `\bP([0-3])\b` 会吃 `MP3`/`P100`/句内裸词且识别 P3（informational 不应进消息头）。采用三种严格格式（badge / 行首方括号 / 行首冒号）+ 排除代码块和 blockquote + 至少 5 条负例测试 | 2026-04-24 |
| KD-17 | E.3 代码清理以"3 场景证据门槛"触发，不以时间窗口 | Maine Coon P2：alpha 过 bot-P2 / bot-pass / 人类-CHANGES 三场景后才清，比"观察一周"更可执行。避免时间窗口既保守又不精确 | 2026-04-24 |

## Completion Sign-off (2026-04-25)

**原始痛点**（2026-04-24 PR #1376 thread）：operator看到同一次 GitHub review 先出现 pass/summary，再被旧通道拉出过期 P1/P2，体感为"GitHub 通知有 bug"。

| operator experience / 隐性愿景 | 当前实际状态 | 匹配？ |
|----------------------|-------------|--------|
| "我们的github通知有bug吧？" | 根因已定位为 email watcher + polling 双通道并行投递；Phase E 三 PR 完成合流 | ✅ |
| "最新的是让你pass的消息" | Polling 通道保留 review summary / conversation 内容，并在同一条 Review Feedback 消息内呈现 | ✅ |
| "又会拉之前的过期的 p1 p2 的消息" | Email watcher bootstrap 下线并物理删除 11 个 legacy 文件；旧通道不再能二次投递 | ✅ |
| 隐性：severity 能力不能丢 | Severity parser 前移到 polling，支持 badge / 行首 `[P0-2]` / 行首 `P0-2:`，多 finding 取最高 | ✅ |
| 隐性：不要引入新 FP / 误吞 | 79/79 targeted tests 覆盖 fenced code / blockquote / setup-noise / Rule A only；云端 Codex 三轮 review pass | ✅ |

**Close verdict**：F140 Phase E 结构性消除了 review notification 双源冲突。Polling 是唯一真相源；email/IMAP review watcher 已从启动路径和源码层删除。功能状态重回 done。

## Design Gate 讨论归档

**参与者**: Ragdoll (@opus) + Maine Coon (@gpt52, GPT-5.4)
**日期**: 2026-03-26
**结论**: **通过**，with 3 条约束补入 spec

**Maine Coon核心贡献**:
1. 确认文件结构：ConflictRouter + ReviewFeedbackRouter 独立，不合并
2. 建议 ReviewFeedbackTaskSpec 新建替换而非就地改名（语义债）
3. 发现 PrComment 太瘦，需要 richer model（author/filePath/line/commentType）
4. 发现 conflict fingerprint 在 base 变化后同 SHA 再冲突的误 dedupe 风险
5. 指出 cursor commit 与 trigger 的事务边界：delivery 成功即 commit，trigger 是 best-effort
6. 同意 OQ-1 urgent + OQ-2 聚合三分区
7. 同意 patchConflictState 独立新增

## Review Gate

- Phase A: Maine Coon (codex/gpt52) cross-family review
- Phase B: Maine Coon (codex/spark) cross-family review — 放行, 无 P1/P2
- Phase B+ dedup fix: Maine Coon (codex/spark) cross-family review — 三审放行（P1×2 修复后）, 无 P1/P2
- Phase C: Maine Coon (codex/spark) R1 review — 3 P1 发现 + 修复确认放行。云端 Codex R2 — "No major issues"
- Phase D: Maine Coon (codex/spark) cross-family review — 放行, 无 P1/P2。云端 Codex R1 1 P1（catch-all→区分 infra failure）修复后 R2 通过
- Phase E.1: Maine Coon (gpt52 + codex) cross-family review + 云端 Codex — P0/P1/P2 修复后通过
- Phase E.2: Maine Coon (gpt52 + codex) cross-family review + 云端 Codex — P2 注释残留修复后通过
- Phase E.3: Maine Coon GPT-5.5 双轮 review + 云端 Codex — P2 注释残留修复后 no-findings
