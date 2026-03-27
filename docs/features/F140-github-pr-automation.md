---
feature_ids: [F140]
related_features: [F133, F139, F141]
topics: [github, conflict-detection, review-feedback, pr-signals, automation]
doc_kind: spec
created: 2026-03-26
---

# F140: GitHub PR Signals — 冲突检测 + Review Feedback 全来源感知

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

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

### Phase C: 自动执行器 (Auto-executor)（未开工）

猫收到通知后**零人工干预自动执行**：

**1. 冲突自动 resolve**
- 猫收到冲突通知 → 在 worktree 中 `git fetch origin main && git rebase origin/main`
- 自动解决简单冲突 → push → 等下一轮 CI 通知
- 复杂冲突（无法自动 resolve）→ 通知team lead

**2. Review feedback 自动处理**
- 猫收到 review feedback 通知 → 自动加载 receive-review 模式 → 逐项处理
- 区分 review decision：requested changes / approve / comment → 不同自动处理策略

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

- [ ] AC-C1: 猫收到冲突通知后零人工干预自动 rebase + push（clean rebase 场景）
- [ ] AC-C2: 简单冲突（≤3 文件，non-binary）自动 resolve，复杂冲突通知team lead附冲突文件列表
- [ ] AC-C3: 猫收到 review feedback 后自动加载 receive-review 模式处理（CHANGES_REQUESTED 场景）
- [ ] AC-C4: TriggerIntent 流水线——intent 从 trigger → AgentRouter → SystemPromptBuilder 贯通
- [ ] AC-C5: ConflictAutoExecutor 测试覆盖：clean / simple-conflict / complex-escalation / worktree-not-found
- [ ] AC-C6: 安全护栏——只操作 feature worktree，绝不碰 main/runtime，操作超时 abort

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
