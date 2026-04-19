---
feature_ids: [F168]
related_features: [F141, F116, F140, F055, F122]
topics: [community, orchestration, opensource]
doc_kind: spec
created: 2026-04-18
---

# F168: Community Operations Board — 社区事务编排引擎

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

team lead现在是人肉 dispatcher：手动 @ 猫看 issue/PR、手动分配线程、手动跟进进度、手动叮嘱"好好看 skill"、手动触发 guardian 验证。现有 F141（发现层）+ F116（ops skill）有完整的流程定义，但缺少**状态管理**和**自动编排**——流程靠team lead口头驱动，进度靠team lead脑子记。

### team experience（需求讨论 2026-04-18，完整语境）

**核心痛点**：
> "现在全看我喊你们去看有点麻烦"
> "你们得想想得做管理的啊，不然上次这个任务派发给什么线程的猫，然后他们进度如何，是合入还是正在拉扯还是 issue 怎么样了"
> "比如 issue xxx 的 pr yyy 现在正在 xxx 线程负责"

**team lead现在的人肉话术**（应被系统取代）：
> - 看到新 issue/PR → "加载开源社区管理 skills，看看这个 PR inbound 流程，maintainer 身份而言这个 PR 对我们自己有益吗？他的内容是什么？我们值得 merge 和 intake 吗？"
> - 方向评估 → "我一般会 at 两只猫，因为一只猫视角大概率有偏颇。但如果是二次 review 一般只会一只"
> - 决定 intake → "那你走 intake 回家的流程吧，merge 然后读 SOP 走流程回家。记得一定要好好看看 intake skills，大多数猫猫都会犯错，而且是从以前到现在每次 intake 都会有各种错误没有一次不是"
> - intake 完成后 → "我建议你守护一下这个 intake 流程，大概率猫猫会丢三落四，你自己加载 skills 看看"
> - 卡点 → "卡点只在于这个 issue 和这个 PR 本质我们能不能 intake？除非是 bug fix 这种确定 bug 那你们不用找我"

**社区系统 thread 调度模式**：
> "比如是 feat153 的 PR，这个 feat 就是社区小伙伴负责，我们是全丢一个 thread？我们家自己开发 feat 是全丢一个 thread 的"
> "但是新来一个假设社区小伙伴的 feat160，此时还没创建 thread，这个新的谁来分配？"

**前端心智模型**：
> "不应该和失败的 mission hub（我几乎不打开）那样放在独立的页面。应该和成功的 workspace 里面的开发、记忆、调度、任务那些 tab 一样挂在右边"
> "大多数我们的操作！谁自己手点啊！都是和猫猫自然语言。所以似乎这个能力应该是打开了社区系统 thread，右边可以看到社区事务管理，然后里边就是看板了"
> "比如说我可以点击跳转到 feat153 里面去看这个社区处理进度，毕竟猫猫跑在 thread 里！我觉得应该这样联动才是对的！"

**架构约束**：
> "未来这个 feat 最后一个阶段就是要允许社区其他小伙伴用你们这套管理他们自己的社区！你们在架构设计上必须是解耦的！"
> "人家也是用自己家里搭建的猫猫咖啡呀！不是用这本地这个！但是必须是比如说你的 landy 可以管理 clowder-ai 也能管理其他 landy 的自己的仓"

**初版交互策略**：
> "我建议我们最开始的 A-C 的完整版本，这里的 issue 和 PR 触发别是自动的巡检，而是我手动点击"
> "issue 112 发送给系统猫（如果没有被具体线程接单）"
> "PR 555 已经分配给线程了，那可能就是走的自动的 review，就是对方一旦有新的 commit 且 CI 绿了，就自动推送到这个 thread 的 channel"
> "社区管理看板虽然比如说多久更新一次状态，但是必须有一个按钮手动同步状态"

**视觉规范**：
> "别用 emoji 用 SVG"

### 目标

把team lead从"人肉编排器"解放成"决策者"——猫猫自动发现、分拣、分配、跟踪、守护，team lead只需要在关键节点拍板。

## What

### Phase A: 定方向卡片 + Inbox 首猫分拣

把team lead的人肉 dispatch 话术模板化为标准流程：

1. **定方向卡片（Direction Card）**：猫猫 triage 完后，向 Inbox thread 发一张结构化 rich block：
   - 事项来源（issue/PR #、repo）
   - 是什么（一句话）
   - 关联 feat（如有）
   - Ownership 5 问结果（Q1-Q5 pass/warn/fail）
   - 猫的建议（WELCOME / NEEDS-DISCUSSION / POLITELY-DECLINE）
   - 需要team lead决定什么（明确标注 or "猫自决"）

   **实现方式（KD-10 gpt52 review）**：初版用 `RichCardBlock`（`kind: 'card'`），5 问结果放 `fields` 数组（`{ label: 'Q1 愿景', value: 'PASS' }`），tone 映射建议结果。`card.fields` 目前不支持 `icon` 字段，SVG 图标需后续扩展 `CardField` 类型；初版接受文本 badge 降级（PASS/WARN/FAIL）
2. **双猫方向交叉**：首猫 triage 后自动 @ 第二只猫独立评估方向（不等team lead喊），两猫意见汇总后再标记是否需要team lead拍板。bugfix 场景猫自决，不需双猫
3. **路由分发**：
   - 已有 feat → 路由到该 feat thread，@ 负责猫
   - 全新事项 + team lead OK → 首猫创建新 thread 并分配
   - bugfix（猫自决）→ 首猫就地分配或自行处理

### Phase B: 社区事务台账 + 生命周期跟踪

**真相源原则（KD-11 gpt52 review P1）**：PR 侧**不另建平行台账**，直接投影自现有 `pr_tracking` TaskItem（`TaskStore` where `kind === 'pr_tracking'`），其 `automationState.ci/review/conflict` 已经是 CI/review 通知的权威数据。Issue 侧独立建模为 `CommunityIssueItem`。看板是两个 read model 的聚合视图。

#### 1. Issue 数据模型（`CommunityIssueItem`，独立存储）

```typescript
interface CommunityIssueItem {
  id: string;
  repo: string;                          // 来源仓库（多仓库，不 hardcode）
  issueNumber: number;
  issueType: 'bug' | 'feature' | 'enhancement' | 'question';
  title: string;
  state: IssueState;                     // 见下方状态机
  replyState: 'unreplied' | 'replied';   // 有没有回复过对方
  consensusState?: 'discussing' | 'consensus-reached' | 'stalled'; // 讨论进度
  assignedThreadId: string | null;       // 工作线程
  assignedCatId: string | null;          // 负责猫
  linkedPrNumbers: number[];             // 关联的 PR（一个 issue 可能有多个 PR）
  directionCard: object | null;          // 定方向卡片快照
  ownerDecision: 'accepted' | 'declined' | null; // team lead拍板
  relatedFeature: string | null;         // 关联 feat（如 'F056'）
  lastActivity: { at: number; event: string };
  createdAt: number;
  updatedAt: number;
}

type IssueState = 'unreplied' | 'discussing' | 'pending-decision' | 'accepted' | 'declined' | 'closed';
```

#### 2. Issue 状态机

```
unreplied → discussing → pending-decision → accepted / declined
                 ↓                              ↓
            (replyState/consensusState         (closed)
             独立于 state 更新)
```

| 状态 | 含义 | 触发 |
|------|------|------|
| unreplied | 新来的，还没人搭理 | 手动"发送给系统猫"创建 |
| discussing | 已回复，讨论中 | 猫回复后 |
| pending-decision | 双猫看过，需要team lead拍板 | 双猫意见汇总后 |
| accepted | team lead同意 | team lead在对话中拍板 |
| declined | 礼貌回绝 | team lead/猫自决拒绝 |
| closed | GitHub issue 已关闭 | 同步 GitHub 状态 |

`replyState` 和 `consensusState` 独立于 `state` 更新——讨论中的 issue 可能是"已回复+待复现"也可能是"已回复+达成一致"。

#### 3. PR 视图（投影自 `pr_tracking` TaskItem，不另建存储）

看板 PR 区域从 `TaskStore` 读取 `kind === 'pr_tracking'` 的 TaskItem，投影以下字段：

| 看板展示 | 数据来源（真实字段） | 推导逻辑 |
|---------|---------------------|---------|
| PR # + 标题 | `TaskItem.title` + `subjectKey`（格式 `pr:{owner/repo}#{num}`） | 解析 subjectKey 得 repo + number |
| CI 状态 | `ci.lastBucket` (`CiBucket = 'pass' \| 'fail' \| 'pending'`) | `'pass'` → CI 绿；`'fail'` → CI 红；`'pending'` / 无值 → 进行中 |
| Review 活跃 | `review.lastCommentCursor` / `lastDecisionCursor` | cursor 递增 = 有新 review 活动；`lastNotifiedAt` 判断是否已通知 |
| 新 commit 检测 | `ci.headSha` + `ci.lastFingerprint`（格式 `${headSha}:${bucket}`） | `lastFingerprint` 不以 `headSha:` 开头 → headSha 已变更 → 有新 commit |
| Merge/关闭 | `closedAt` | 非 null → PR 已关闭/合并 |
| Conflict | `conflict.mergeState` (`'CONFLICTING' \| 'MERGEABLE' \| 'UNKNOWN'`) | `'CONFLICTING'` → 有冲突；`'MERGEABLE'` → 可合并；`'UNKNOWN'` → 待重试 |
| 负责猫 | `TaskItem.ownerCatId` | 直接读取 |
| 所在线程 | `TaskItem.threadId` | 直接读取 |
| 关联 issue | 从 `CommunityIssueItem.linkedPrNumbers` 反查 | 遍历 issue 表匹配 |

**看板 PR 分组推导规则**（基于真实 `AutomationState` 字段）：

```typescript
function derivePrGroup(task: TaskItem): PrBoardGroup {
  const { ci, conflict, closedAt } = task.automationState ?? {};

  if (closedAt != null) {
    // Phase D 扩展 intake 状态后细分 intake-in-progress / intake-done
    return 'completed';
  }
  // 新 commit 检测：lastFingerprint 格式是 `${headSha}:${bucket}`
  // 如果 headSha 变了但还没生成新 fingerprint → 有未通知的新 commit
  const hasNewCommit = ci?.headSha && ci.lastFingerprint
    && !ci.lastFingerprint.startsWith(`${ci.headSha}:`);
  if (hasNewCommit && ci?.lastBucket === 'pass') {
    return 're-review-needed';  // 新 commit + CI 绿 → 需要 re-review
  }
  if (conflict?.mergeState === 'CONFLICTING') {
    return 'has-conflict';
  }
  return 'in-review';  // 默认：正在 review
}
```

**PR re-review 信号**：已分配 PR 的新 commit + CI 绿 → F140 现有 `CiCdCheckTaskSpec` 已自动推送到 thread。看板只需读取最新状态，不需要自己发通知。

**Intake 状态**：当前 `pr_tracking` 无 intake 字段。如需在看板展示 intake 进度，Phase D 时扩展 `AutomationState` 加 `intake?: { state, guardianCatId }`。

#### 4. 触发模式（初版 A-C）

- **Issue 未接单**：team lead在看板手动点击"发送给系统猫"触发 triage，不自动巡检
- **PR 已分配到线程**：自动——F140 `CiCdCheckTaskSpec` 已有 commit+CI 推送能力，看板消费其状态
- **看板状态**：定时刷新（建议 5 分钟）+ **手动同步按钮**（team lead随时可点击强制刷新）

#### 5. 多仓库支持

repo 是绑定参数，一个 Cat Café 实例可管理多个 repo。`CommunityIssueItem.repo` + `pr_tracking` 的 `subjectKey`（格式 `pr:{owner/repo}#{num}`）天然支持多仓库。

#### 6. 持久化

TTL=0（铁律 #5），用户数据默认持久化

### Phase C: 管理视图（Workspace tab + 社区系统 thread 联动）

**设计决策**：不做独立页面（Mission Hub 教训：独立页面team lead几乎不打开）。社区管理作为 **Workspace 右侧 tab**，与对话流并存——用户心智不变，操作在自然语言中完成，看板是辅助视图。

**前置基础设施（KD-12 gpt52 review P2）**：现有 `workspaceMode` 枚举只有 `dev | recall | schedule | tasks`（`chatStore.ts`），`WorkspacePanel` 只渲染四种，无 thread-scoped 自动切换机制。Phase C 需要：
1. 扩展 `workspaceMode` 枚举加 `community`
2. `WorkspacePanel` 加 `CommunityPanel` 分支
3. Thread metadata 加 `preferredWorkspaceMode?: WorkspaceMode`（有界联合 `'dev' | 'recall' | 'schedule' | 'tasks' | 'community'`），打开社区系统 thread 时自动切到 `community`
4. `useWorkspaceNavigate` 加 `community` 导航支持

#### 布局（设计草图，最终 UI 用 Pencil 出稿）

```
┌─ 社区系统 Thread（左侧对话）─────┬─ Workspace 右侧面板 ─────────────────┐
│                                  │ [开发] [记忆] [调度] [任务] [社区]    │
│ [系统猫]：                        │                                      │
│ ┌────────────────────────────┐   │ repo: [clowder-ai v]  [同步状态 ⟳]  │
│ │ 定方向卡片 #42              │   │                                      │
│ │ 深色模式支持                 │   │ == Issues ===========================│
│ │ 关联: F056 (子需求)         │   │                                      │
│ │ 5问: pass/pass/warn/pass   │   │ -- 未回复 (1) ---------------------- │
│ │ 建议: WELCOME              │   │ #52 SSO支持  feature  2h ago        │
│ │ !需要team lead: 纳入backlog?   │   │                                      │
│ └────────────────────────────┘   │ -- 讨论中 (2) ---------------------- │
│                                  │ #48 日志延迟  bug  已回复 待复现 1d  │
│ team lead: 要，挂 F056 下           │ #42 深色模式  feat  达成一致→PR#58 3h│
│                                  │                                      │
│ [系统猫]：                        │ -- 待team lead定方向 (1) --------------- │
│ 已路由到 F056 thread，            │ #50 插件系统  feat  双猫看过 F056相关│
│ @codex 开始 review               │    [发送给系统猫]                     │
│                                  │                                      │
│                                  │ -- 已结论 (3) ------------ [收起 v]  │
│                                  │ #39 启动崩溃  bug  accepted→PR#401   │
│                                  │ #35 ARM支持  feat  declined 已回复   │
│                                  │                                      │
│                                  │ == Pull Requests =================== │
│                                  │                                      │
│                                  │ -- Review 中 (2) ------------------- │
│                                  │ PR#58  深色模式 <-#42 F056 @codex CI✓│
│                                  │ PR#412 日志格式 <-#48 F153 @opus  CI✓│
│                                  │                                      │
│                                  │ -- 待 re-review (1) ---------------- │
│                                  │ PR#405 配置热加载 <-#31 作者push CI…│
│                                  │                                      │
│                                  │ -- Intake 中 (1) ------------------- │
│                                  │ PR#398 Docker <-#29 merged intake中  │
│                                  │                                      │
│                                  │ -- 完成 (8) ------------- [收起 v]   │
│                                  │                                      │
│                                  │       [点击 item → 跳转到工作线程]    │
└──────────────────────────────────┴──────────────────────────────────────┘
```

#### 交互定义

| 操作 | 行为 |
|------|------|
| 打开社区系统 thread | 右侧自动切到"社区" tab |
| 点击 item 行 | 跳转到该 item 的工作 thread（如 F153 thread） |
| 点击 issue/PR 编号 | 新 tab 打开 GitHub 页面 |
| repo 下拉 | 切换仓库视图（多仓库场景） |
| [同步状态] 按钮 | 手动触发从 GitHub 同步最新状态 |
| 状态组折叠/展开 | team lead自行收起不关心的组 |
| [发送给系统猫] 按钮 | 未接单 issue 手动触发 triage（初版，非自动巡检） |
| 定方向卡片里的拍板 | 在对话中自然语言回复即可（不需要 UI 按钮） |

#### UX 原则

1. **左边聊天，右边看板** — 跟现有 Workspace tab 一模一样的心智模型
2. **拍板在对话里** — 不做额外的审批按钮，team lead直接在系统 thread 里回复
3. **看板是只读导航** — 不在看板上做操作（除手动同步和发送给系统猫），所有操作都通过和猫对话完成
4. **item 是入口不是终点** — 点进去到 thread 才是工作现场
5. **图标用 SVG 不用 emoji** — 设计规范

#### Issue 与 PR 分区

看板分两个区域（Issues / Pull Requests），因为生命周期不同：
- **Issues**：重点是"有没有回复""讨论到哪了""需不需要team lead定方向"
- **PRs**：重点是"谁在 review""有没有新 commit 要 re-review""intake 进度"
- **Issue ↔ PR 关联**：PR 行显示 `<-#issue号`，一眼看到来龙去脉

### Phase D: Intake 硬门禁 + Guardian 自动触发

把team lead的"你去守护一下"变成系统自动触发：

1. **Intake 完成信号**：负责猫声称 intake 完成 + reviewer 放行 → 自动触发 guardian 猫
2. **Guardian 自动分配**：从 roster 中选一只（≠ author ≠ reviewer），自动 @ 并加载 intake skill
3. **Guardian sign-off 作为 merge 硬门禁**：缺 guardian 确认 → merge-gate 自动拦截
4. **Intake checklist 强制**：不是靠叮嘱"好好看 skill"，而是系统验证 checklist 每项都有证据

## Acceptance Criteria

### Phase A（定方向卡片 + Inbox 分拣）
- [ ] AC-A1: 首猫 triage 后自动向 Inbox 发结构化定方向卡片（rich block）
- [ ] AC-A2: 定方向卡片包含：事项来源、关联 feat、5 问结果、猫建议、team lead决策点
- [ ] AC-A3: 首猫自动 @ 第二只猫交叉评估方向（非 bugfix 场景）
- [ ] AC-A4: 两猫意见汇总后，自动标记是否需要team lead拍板
- [ ] AC-A5: 已有 feat 事项自动路由到该 feat thread 并 @ 负责猫
- [ ] AC-A6: 全新事项经team lead OK 后，首猫创建新 thread 并分配负责猫

### Phase B（台账 + 生命周期）
- [x] AC-B1: `CommunityIssueItem` 独立存储，持久化（TTL=0）
- [x] AC-B2: Issue 状态机 6 态 + `replyState` / `consensusState` 独立更新
- [x] AC-B3: PR 视图投影自 `pr_tracking` TaskItem，不另建存储（单一真相源）
- [x] AC-B4: Issue ↔ PR 关联：`linkedPrNumbers` 可追溯
- [x] AC-B5: 未接单 issue 支持team lead手动触发"发送给系统猫"
- [x] AC-B6: 已分配 PR 的 commit+CI 信号由 F140 现有 `CiCdCheckTaskSpec` 推送，看板消费状态
- [x] AC-B7: 支持多仓库绑定，repo 是配置参数非 hardcode
- [x] AC-B8: 看板支持手动同步状态按钮 + 定时刷新（建议 5 分钟）

### Phase C（管理视图 — Workspace tab）
- [x] AC-C1: 社区系统 thread 存在，作为中央对话入口
- [x] AC-C2: `workspaceMode` 枚举扩展 `community`；`WorkspacePanel` 渲染 `CommunityPanel`
- [x] AC-C3: Thread metadata 加 `preferredWorkspaceMode?: WorkspaceMode`，打开社区系统 thread 自动切到 `community`
- [x] AC-C4: 看板分 Issues（`CommunityIssueItem`）/ Pull Requests（`pr_tracking` 投影）两区域
- [x] AC-C5: 每个 item 一行摘要（repo + # + 标题 + 类型 + 负责猫 + 最后活跃）
- [x] AC-C6: 点击 item 跳转到对应 feat thread（工作现场联动）
- [x] AC-C7: repo 下拉筛选 + 状态/负责猫/时间范围筛选
- [x] AC-C8: 手动同步按钮 + 定时刷新
- [x] AC-C9: 所有图标用 SVG，不用 emoji
- [x] AC-C10: 最终 UI 用 Pencil 出设计稿

### Phase D（Intake 硬门禁）
- [ ] AC-D1: Intake 完成 + reviewer 放行 → 系统自动 @ guardian 猫
- [ ] AC-D2: Guardian 从 roster 自动选择（≠ author ≠ reviewer）
- [ ] AC-D3: 缺 guardian sign-off → merge-gate 自动拦截
- [ ] AC-D4: Intake checklist 每项需要证据，系统验证非人工叮嘱

## Dependencies

- **Related**: F141（GitHub Repo Inbox — 发现层，本 feature 消费其事件）
- **Related**: F116（opensource-ops skill — 流程定义，本 feature 编排其流程）
- **Related**: F140（PR Tracking — 本 feature 消费 PR 状态变化信号）
- **Related**: F055（Plan Board — 可能共享前端看板组件）
- **Related**: F122（Unified Dispatch — 可能复用调度基础设施）
- **Related**: F086（Multi-Mention — Phase A 双猫交叉依赖 multi_mention）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase A 改 skill 可能影响现有 triage 流程 | 渐进式：先加卡片模板，不改现有判断逻辑 |
| 多仓库 webhook 配置复杂度 | 复用 F141 已有的 allowlist 机制，扩展为 per-repo 配置 |
| Guardian 自动触发可能产生 @ 风暴 | 限频：同一 item 最多触发一次 guardian |
| 状态机复杂度 | Phase B 先实现线性状态流转，分支/回退后续迭代 |
| 初版手动触发可能team lead还是觉得麻烦 | 验证 MVP 后 Phase E 再加自动巡检 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 单实例多仓库，非多租户 | 每人自建 Cat Café 实例，不做 SaaS；data model 按 repo 隔离 | 2026-04-18 |
| KD-2 | Inbox 首猫分拣制 | 中央入口 + 分发，team lead只看 Inbox 就知全局 | 2026-04-18 |
| KD-3 | 方向评估必须双猫 | team lead："一只猫视角大概率有偏颇"，非 bugfix 场景强制双猫交叉 | 2026-04-18 |
| KD-4 | Intake guardian 由系统自动触发 | team lead："每次 intake 都出错没有一次不是"→ 不靠叮嘱靠门禁 | 2026-04-18 |
| KD-5 | 管理视图是 Workspace tab 而非独立页面 | Mission Hub 教训：独立页面team lead几乎不打开；操作在自然语言中完成，看板是辅助视图 | 2026-04-18 |
| KD-6 | 社区系统 thread 作为中央入口 | 类似 IM Hub 系统 thread，首猫分拣+team lead拍板都在对话中；看板通过 thread 跳转联动到 feat thread | 2026-04-18 |
| KD-7 | Issue 和 PR 分区展示 | 生命周期不同：Issue 重"回复/讨论/定方向"，PR 重"review/re-review/intake" | 2026-04-18 |
| KD-8 | 初版手动触发 + 手动同步 | team lead："最开始别是自动巡检，而是我手动点击"。已分配 PR 的 commit+CI 通知除外（自动） | 2026-04-18 |
| KD-9 | 所有图标用 SVG 不用 emoji | team lead明确要求 + 设计规范 | 2026-04-18 |
| KD-10 | Direction Card 初版用 `card` + `fields` 文本 badge | `card.fields` 无 `icon` 字段，SVG 图标需后续扩展 `CardField`；初版接受 PASS/WARN/FAIL 文本降级（gpt52 review P2） | 2026-04-18 |
| KD-11 | PR 不另建台账，投影自 `pr_tracking` | 现有 `TaskStore` 的 `pr_tracking` 已是 CI/review/conflict 权威数据源；双写会导致状态漂移（gpt52 review P1） | 2026-04-18 |
| KD-12 | Phase C 需补 `community` workspace mode 基础设施 | 现有枚举只有 4 态；需扩展 `WorkspaceMode = 'dev' \| 'recall' \| 'schedule' \| 'tasks' \| 'community'`（fail-closed 有界枚举），thread metadata 用 `WorkspaceMode` 类型不用 string（gpt52 review P2） | 2026-04-18 |

## Review Gate

- Phase A: 跨家族 review（skill 改动）
- Phase B: 跨家族 review（数据模型 + API）
- Phase C: Pencil 设计稿 → team lead UX 审核 → 实现。图标 SVG 不用 emoji
- Phase D: 跨家族 review + team lead确认门禁策略
