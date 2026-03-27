---
feature_ids: [F139]
related_features: [F102, F122, F048]
topics: [scheduler, heartbeat, task-runner, multi-agent]
doc_kind: spec
created: 2026-03-25
---

# F139: Unified Schedule Abstraction — 统一调度抽象

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

team lead问："我们现有的能力是不是已经功能上满足小龙虾的 heartbeat 覆盖的能力？"

**Ragdoll × Maine Coon共识**：事件驱动场景（GitHub webhook/邮件/消息唤醒猫）我们已经比龙虾 heartbeat polling 做得更好——秒级响应 vs 30 分钟轮询。但"没人找你但该主动检查"的自省能力（定时巡检、文档过期检查、stale issue 清理）还没有统一抽象。F102 的 TaskRunner 是 setInterval MVP，硬编码、不可配置、gate 返回 boolean 造成二次扫描。

team experience："不建议你这个可配置是编辑到什么 Markdown 文档里……能让人类跟你直接说自然语言，你帮别人去编辑，或者你有个 UI 去把东西呈现出来"。

**核心定位**：connector = 被动响应（有人找我），统一调度 = 主动巡检（没人找我但该看看）。前者已有且更好，后者是本 feature 要补的。

## What

### Phase 1a: 统一内部 Poller（纯后端，无前端 UI）

将现有 TaskRunner 升级为六维度 TaskSpec 模型（ADR-022）。**纯后端交付**——Phase 1a 落地后社区和其他猫可以直接基于 TaskSpec_P1 注册新 consumer（不需要等前端）。前端展示（Workspace 调度 Tab）在 Phase 2 统一做，届时把所有已注册任务 + run ledger 展示出来：

- **TaskSpec_P1 interface**：Trigger / Admission / Run / State / Outcome 五维度（Context Phase 2 实现）
- **typed signal gate**：gate 返回结构化 signal（不再 boolean），消除 F102 的二次扫描
- **subjectKey 统一锚点**：lease / cursor / dedupe / dispatch / run-ledger 共用主键
- **run ledger**：SQLite 记录每次调度结果（SKIP_NO_SIGNAL / RUN_DELIVERED / RUN_FAILED）
- **Task profiles**：`awareness`（宽松）/ `poller`（精确）预设，防组合爆炸
- **具体 consumer（team lead要求统一，不再加独立 setInterval）**：
  - `summary-compact` — 迁移 F102 SummaryCompactionTask（boolean → typed signal）
  - `cicd-check` — 迁移 F133 CiCdCheckPoller（第一个验证用例）
  - `conflict-check` — 新增 PR 冲突检测（push to main → mergeable 状态变化）
  - `review-comments` — 新增 PR comments 检测（人类 + 猫的 GitHub comments）

### Phase 1b: Actor + Cat Wake

- **actor.role 能力命名空间**：memory-curator / repo-watcher / health-monitor（非 roster 身份角色）
- **MCP async dispatch**：post_message → receipt tracking（assignedCatId / leaseKey / invocationId / completionState）
- **costTier hint**：cheap → Sonnet，deep → Opus

### Phase 2: Cron + Persistence + UI + Context

- **Workspace 调度 Tab（KD-7）**：和"开发""知识"平齐的顶级 Tab，展示所有 Phase 1a/1b 已注册的任务 + run ledger + 状态。Phase 1a 纯后端先行，Phase 2 补前端把全部任务可视化
- **Cron / event / hybrid triggers**：超越 interval-only
- **Context dimension**：session（new-thread / same-thread）× materialization（light / full）
- **自然语言配置**：用户说"每天早上 9 点检查 stale issue"→ 猫翻译成 TaskSpec
- **Task profiles 扩展**：`precise` 预设（cron 精度）

### Phase 3: Governance + Pack Ecosystem

- **电闸/备忘录分离**：task.spec.ts（人类审批）vs checklist.md（agent 可编辑）
- **anti-feedback-loop**：originTaskId + suppressionTTL 防事件回声
- **Pack marketplace 集成**：第三方任务模板发布/安装

## Acceptance Criteria

### Phase 1a（统一内部 Poller）✅
- [x] AC-A1: TaskSpec_P1 interface 实现，含 typed signal gate
- [x] AC-A2: subjectKey 贯穿 execute/cursor/dedupe/ledger 全链路（lease 仍为 task-level，subject-level lease 延后到 Phase 1b）
- [x] AC-A3: run ledger SQLite 表结构 + 写入逻辑
- [x] AC-A4: SummaryCompactionTask 迁移到新 TaskSpec（红→绿）
- [x] AC-A5: CiCdCheckPoller 迁移到新 TaskSpec（红→绿）
- [x] AC-A6: conflict-check + review-comments TaskSpec 注册可用
- [x] AC-A7: awareness / poller 两种 profile 可用
- [x] AC-A8: 现有 TaskRunner 行为不回归，纯 interval pollers 收敛为统一调度（GithubReviewWatcher 保留 IMAP idle + reconnect fallback，不在 interval 收敛范围）

### Phase 1b（Actor + Cat Wake）✅
- [x] AC-B1: actor.role resolver 从 cat-config.json 匹配猫
- [x] AC-B2: MCP dispatch + receipt tracking 端到端
- [x] AC-B3: costTier hint 影响选猫策略

### Phase 2（Cron + UI + Context）✅
- [x] AC-C1: cron/event trigger 可用
- [x] AC-C2: Context dimension（session × materialization）可配置
- [x] AC-C3: Hub panel 展示任务列表 + 运行状态
- [x] AC-C3b-1: 调度 API 返回 threadId（可空）用于每条任务实例展示（subjectKey → threadId join）
- [x] AC-C3b-2: 调度面板支持 scope 切换（All / Current Thread / 指定 Thread）一键过滤
- [x] AC-C3b-3: 无 thread 关联任务明确落在「No thread」分组，不丢失
- [x] AC-C4: 自然语言→TaskSpec 转换可用

### Phase 3（Governance + Pack）
- [ ] AC-D1: 电闸/备忘录分离权限模型
- [ ] AC-D2: anti-feedback-loop 防回声
- [ ] AC-D3: Pack 任务模板安装/卸载

## Dependencies

- **Evolved from**: F102（TaskRunner MVP + SummaryCompactionTask 是现有调度基座）
- **Related**: F122（统一调度队列 — invocation dispatch，不同关注面）
- **Related**: F048（Restart Recovery — 调度持久化需要的基础设施）
- **Related**: F129（Pack System — Phase 3 的生态集成目标）

## Risk

| 风险 | 缓解 |
|------|------|
| 过度抽象：8 个任务用六维度模型 overkill | Phase 1a 只实现核心 5 维度 + 2 profile，按需展开 |
| TaskRunner 迁移回归 | 红→绿 TDD，先有失败测试再改 |
| MCP dispatch 异步丢消息 | Phase 1b receipt tracking + run ledger 双重记录 |
| UI 配置复杂度 | 自然语言兜底，用户不需要理解 TaskSpec 细节 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 六维度 TaskSpec 模型（Trigger/Admission/Context/Run/State/Outcome + Actor + Governance） | 三猫调研 + GPT Pro 审阅 + Maine Coon review 收敛 | 2026-03-25 |
| KD-2 | typed signal gate 替代 boolean | 消除 F102 二次扫描 | 2026-03-25 |
| KD-3 | subjectKey 统一锚点 | 防主键分裂，Maine Coon review P1 | 2026-03-25 |
| KD-4 | actor.role = 能力命名空间 | Maine Coon review open question 收敛 | 2026-03-25 |
| KD-5 | UI + 自然语言配置（非 markdown 编辑） | team lead明确要求 | 2026-03-25 |
| KD-6 | 龙虾兼容但不照搬 | 事件驱动我们更好，只学主动自省语义 | 2026-03-25 |
| KD-7 | 调度面板 = Workspace 顶级 Tab（和"开发""知识"平齐） | team lead确认，不是子 Tab；展示在 Workspace，配置在对话区自然语言；Tab 图标用 SVG 不用 emoji | 2026-03-25 |

## Review Gate

- Phase A: Maine Coon review（跨 family 优先）
- Phase B: Maine Coon review + MCP dispatch 集成测试
- Phase C (Phase 2): Maine Coon review + **设计→代码保真度对照**（UX V2 设计稿 vs 实现截图，team lead明确要求）
