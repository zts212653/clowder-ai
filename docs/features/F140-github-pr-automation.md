---
feature_ids: [F140]
related_features: [F133, F139, F141]
topics: [github, conflict-detection, review-feedback, pr-signals, automation]
doc_kind: spec
created: 2026-03-26
---

# F140: GitHub PR Signals — 冲突检测 + Review Feedback 全来源感知

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Phase A-D Completed**: 2026-03-27 | **Reopened**: 2026-04-24（Phase E — 通知合流：severity 抽取 + 下线 email 路径） | **Completed**: 2026-04-25

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

team lead补充：

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
- 覆盖所有来源：Codex 云端 review、人类 reviewer、猫通过 `gh pr review` 留的 comments
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
- 复杂冲突（无法自动 resolve）→ 通知team lead

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
- [x] AC-C2: 简单冲突（≤3 文件，non-binary）自动 resolve，复杂冲突通知team lead附冲突文件列表
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
- [x] AC-E9: ~~Alpha 环境 3 场景证据门槛~~ — **降级 (2026-04-25 team lead拍板)**：alpha frontend 3011 webpack `.xterm` CSS loader 挂 + pinchtab MCP 503 → 浏览器端到端验收阻塞，且非 F140 scope。改用三件套凭证：(1) **Unit tests 79/79 全绿** 守护三场景核心 invariant（Scene 1 review-feedback-router test "P2 badge → header"; Scene 2 "no severity → no header"; Scene 3 filter Rule A only test + 人类 引用 setup 文案 not skip 守护）；(2) **双 family reviewer 复审 pass**（gpt52 + codex chat approve E.1+E.2 + 2 处 followup cleanup）；(3) **云端 codex bot 双 PR review pass**（PR #1380 "no major issues"; PR #1386 "Hooray"）。Production smoke：runtime 重启后下次实际 PR review 自然验证
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
| 自动 rebase 可能引入问题 | Phase B：复杂冲突不自动处理，通知team lead |
| Fork PR 的 comments 权限差异 | `gh api` fallback 到公开 API |
| ~~🔴 回声过滤缺失~~ | ✅ 已修 PR #761 — `isEchoComment` 谓词：author（selfGitHubLogin）+ body（trigger 模板）双重判定，外部 reviewer 不受影响 |
| **🔴 ConnectorIcon 遗漏** | `github-conflict` / `github-review-feedback` 未加入 ConnectorIcon switch，渲染成文字 fallback（✅ 已修 PR #757 后 hotfix） |
| ~~🔴 Review 双重消费~~ | ✅ 已修 PR #764 — 统一 `createGitHubFeedbackFilter()` 工厂：Rule A 自身过滤（两通道）+ Rule B 权威 bot 过滤（仅 F140 API polling），email 通道用 `isSelfAuthored` 保留 bot review 的权威消费权 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 基于 F139 统一调度，不搞独立 setInterval | team lead指示"不太喜欢很多套东西" | 2026-03-26 |
| KD-2 | 投递管道复用 F133 的 deliverConnectorMessage() | 体验一致，代码复用 | 2026-03-26 |
| KD-3 | 独立立项不挂 F133 | team lead指示"单独立项不要挂 F133" | 2026-03-26 |
| KD-4 | ReviewFeedbackRouter（非 ReviewCommentsRouter）| Maine Coon指出：contributor 在乎的不是"有没有 comment"，而是"review feedback 有没有改变 PR 的下一步动作"。只追 comments 不追 decision，信息不完整 | 2026-03-26 |
| KD-5 | review decision state（approved/requested changes/dismissed）进 Phase A | 比 label/assignee 更有行动价值：contributor 看到 requested changes 才知道"现在该改"，maintainer 看到 approved 才知道"可能 ready" | 2026-03-26 |
| KD-6 | Skill/SOP 更新是 Phase A 必须组件 | team lead指出：技术管道建了没有行为引导 = 通知发了猫不知道怎么处理 = 等于没做。F133 Phase B 就是做这件事 | 2026-03-26 |
| KD-7 | F140 定位为追踪层（PR Signals），发现层（Repo Inbox）独立为 F141 | team lead确认分开立项，可并发开发 | 2026-03-26 |
| KD-8 | PrComment → PrFeedbackComment（richer model：+author/filePath/line/commentType） | Maine Coon P1：现有 PrComment 只有 id/body/createdAt，支撑不了分区展示的消息格式 | 2026-03-26 |
| KD-9 | Conflict fingerprint 在 MERGEABLE 时清除 | Maine Coon P2：同一 headSha 因 base 变化再次冲突会被误 dedupe。检测到 MERGEABLE → 清 lastConflictFingerprint，下次 CONFLICTING 重新通知 | 2026-03-26 |
| KD-10 | Cursor commit 在 delivery 成功后，trigger 是 best-effort | Maine Coon P3：delivery 成功 = 主 side-effect 完成 → 立即 commitCursor。trigger() 失败不阻塞 cursor 推进，避免重发已投递消息 | 2026-03-26 |
| KD-11 | ReviewFeedbackTaskSpec 新建替换 ReviewCommentsTaskSpec | 最便宜的改名窗口，继续保留旧名字会造成语义债 | 2026-03-26 |
| KD-12 | patchConflictState() 独立新增，不复用 patchCiState() | CI/conflict 状态语义不同，硬塞一起变成"大杂烩 patch" | 2026-03-26 |
| KD-13 | 自动 rebase 采用「全自动 + 事后通知」（OQ-3 选项 C） | worktree 隔离低风险；半自动每次需人工确认违背自动化愿景；全自动无通知team lead不知情。选项 C 兼顾速度和可见性 | 2026-03-26 |
| KD-14 | 下线 email 通道（ReviewRouter + GithubReviewWatcher），统一走 polling（ReviewFeedbackTaskSpec）；前置：severity parser + setup-noise filter 搬到 polling 侧（E.1 → E.2 → E.3） | Polling 的事件面严格覆盖 email（conversation + inline + review decisions）；两套并行导致对同一 review 产生冲突叙事（🚀 vs P2 header）；F140 Phase A 原愿景"review feedback 全来源感知"就是 polling 通道做全集，email 是历史遗留。team lead 2026-04-24 拍板 | 2026-04-24 |
| KD-15 | Phase E cutover 时**删除** Rule B（authoritative-source 语义），不是迁移 | Maine Coon GPT-5.4 Design Gate P1 push back（2026-04-24）：Rule B 本来就在 polling 侧（`shouldSkipComment/shouldSkipReview`），email watcher 只用 `isSelfAuthored`（Rule A）。Cutover 后 polling 是唯一真相源，继续 skip "authoritative bot feedback" = bot review/inline comment 直接消失。只保留 Rule A（self-authored skip） | 2026-04-24 |
| KD-16 | Severity parser 严格格式 + FP 护栏 | Maine Coon指出现有 `\bP([0-3])\b` 会吃 `MP3`/`P100`/句内裸词且识别 P3（informational 不应进消息头）。采用三种严格格式（badge / 行首方括号 / 行首冒号）+ 排除代码块和 blockquote + 至少 5 条负例测试 | 2026-04-24 |
| KD-17 | E.3 代码清理以"3 场景证据门槛"触发，不以时间窗口 | Maine Coon P2：alpha 过 bot-P2 / bot-pass / 人类-CHANGES 三场景后才清，比"观察一周"更可执行。避免时间窗口既保守又不精确 | 2026-04-24 |

## Completion Sign-off (2026-04-25)

**原始痛点**（2026-04-24 PR #1376 thread）：team lead看到同一次 GitHub review 先出现 pass/summary，再被旧通道拉出过期 P1/P2，体感为"GitHub 通知有 bug"。

| team experience / 隐性愿景 | 当前实际状态 | 匹配？ |
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
