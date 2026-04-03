---
feature_ids: [F139]
related_features: [F102, F122, F048]
debt_ids: []
topics: [scheduler, heartbeat, task-runner, multi-agent]
doc_kind: spec
created: 2026-03-25
status: done
completed: 2026-03-28
---

# F139: Unified Schedule Abstraction — 统一调度抽象

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-03-28

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

### Phase 2（Cron + UI + Context）⚠️ C4 未达成愿景
- [x] AC-C1: cron/event trigger 可用
- [x] AC-C2: Context dimension（session × materialization）可配置
- [x] AC-C3: Hub panel 展示任务列表 + 运行状态
- [x] AC-C3b-1: 调度 API 返回 threadId（可空）用于每条任务实例展示（subjectKey → threadId join）
- [x] AC-C3b-2: 调度面板支持 scope 切换（All / Current Thread / 指定 Thread）一键过滤
- [x] AC-C3b-3: 无 thread 关联任务明确落在「No thread」分组，不丢失
- [ ] ~~AC-C4: 自然语言→TaskSpec 转换可用~~ → 回退：只实现了正则解析层，未打通注册，前端无反馈。愿景是"对话式注册"不是"NL 输入框"。拆分到 Phase 2.6 + Phase 3A

### Phase 2.5（Display Contract 显示契约收口）✅
- [x] AC-E1: `TaskSpec_P1` 新增 `display?: TaskDisplayMeta`（label + category + description + subjectKind）
- [x] AC-E2: `ScheduleTaskSummary` 透传 `display` + 新增 `subjectPreview: string | null`（后端计算，前端不解析 subjectKey）
- [x] AC-E3: 5 个现有任务（summary-compact / cicd-check / conflict-check / review-feedback / repo-scan）全部补齐 `display` 声明
- [x] AC-E4: SchedulePanel 前端改为纯渲染：`task.display?.label ?? fallback`，删除 `humanizeSubject()` / `categorize()` 猜测逻辑（保留 fallback 兼容）
- [x] AC-E5: `subjectPreview === null` 时前端展示 `display.description`，不展示原始 subjectKey

### Phase 3A（对话式任务注册 + 面板最终态 — 核心愿景交付） ✅
- [x] AC-F1: 删除 NL 输入框，替换为"对话入口 CTA"——引导用户在 thread 里和猫对话注册任务
- [x] AC-F2: Footer 改为当前健康摘要（`All healthy` / `Attention needed`），不再显示历史累计 failed 数
- [x] AC-F3: RunLedger 增加 `error_summary` 字段，`RUN_FAILED` 时写入人类可读失败原因
- [x] AC-F4: Task row 显示最近一次运行状态（idle / delivered / failed），点开可查最近 N 次运行历史 + 失败原因
- [x] AC-G1: 猫在对话中识别"调度注册意图"（如"每天九点发 anthropic 新闻"），命中受支持的任务模板
- [x] AC-G2: 生成 `ScheduleRegistrationDraft`（templateId + trigger + target + deliveryThreadId + actor + display），展示给用户确认
- [x] AC-G3: 用户确认后写入持久化表（SQLite），registry 从持久化表 materialize 动态任务
- [x] AC-G4: 动态任务与代码注册任务统一管理（展示/暂停/删除/运行历史）
- [x] AC-G5: MVP 模板集（≥3 个：news-digest / repo-watch / stale-issue-cleanup 或同等）

### Phase 3B（Governance + Pack） ✅
- [x] AC-D1: 电闸/备忘录分离权限模型
- [x] AC-D2: anti-feedback-loop 防回声
- [x] AC-D3: Pack 任务模板安装/卸载

### Phase 4（Template Execution + Builtin Control — 最后一公里）✅
- [x] AC-H1: reminder 模板真实执行——到达 cron 时刻后向 deliveryThreadId 投递提醒消息，ledger 记录 RUN_DELIVERED
- [x] AC-H2a: web-digest 模板真实执行——server-fetch 路径可用（HTML→text 提取+截断+投递），browser-automation 路由正确标记 JS 重站点（needsBrowser 检测），SSRF 防护到位
- [x] AC-H2b: JS 重站点 browser 路径接线——`web-digest` 在 `needs-browser` 分支存真实 trigger message 后通过 `invokeTrigger` 唤醒猫，并带 `suggestedSkill: browser-automation`（PR #826）
- [x] AC-H3: repo-activity 模板真实执行——查询 GitHub repo 新 issue/PR（cursor 追踪已见），投递到 deliveryThreadId
- [x] AC-H4: Builtin 任务面板控制——所有任务（不限 dynamic）在 SchedulePanel 支持 pause/resume，后端复用 task override API
- [x] AC-H5: 端到端验证——team lead在 thread 说"每天九点提醒我喝水"，任务注册、到点执行、消息投递、面板可控，全链路走通

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
| UI 配置复杂度 | 对话式注册兜底，用户不需要理解 TaskSpec 细节 |
| AC 过度声称 | Phase 2 的 AC-C4 被标完成但未达愿景（只有正则解析，没有注册）。教训：AC 标完成前必须端到端验证用户可用 |

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
| KD-8 | 任务声明 display metadata（label/category/description/subjectKind），前端不再猜 | team lead + Maine Coon(gpt52) 讨论收敛：静态展示归 TaskSpec，动态对象展示归 API subjectPreview，前端纯渲染 | 2026-03-26 |
| KD-9 | category 采用对象导向分类（pr/repo/thread/system/external），弃 Custom | Maine Coon提出：Custom 是废桶，对象导向更稳，未来"叼邮箱"归 external | 2026-03-26 |
| KD-10 | 任务注册 = 对话驱动，不是 NL 输入框；面板只管展示/管理 | team lead明确指出：W1 猫是 Agent 不是 API，用户在 thread 里和猫说话注册任务。NL 输入框违背愿景 | 2026-03-27 |
| KD-11 | 对话式注册先做模板化（受支持模板），不做任意 NL→TaskSpec 生成 | Maine Coon(gpt52) 建议：任意生成无审计线、无确认边界、重启丢失。模板化 = Draft/Confirm/Persist/Load 四步 | 2026-03-27 |
| KD-12 | Phase 重排：3A（对话注册 + 面板最终态）→ 3B（Governance+Pack）。team lead指示：不止血，直接面向最终状态开发 | 动态注册是 Pack 的前置依赖。止血是浪费，一步到位 | 2026-03-27 |

## Review Gate

- Phase A: Maine Coon review（跨 family 优先）
- Phase B: Maine Coon review + MCP dispatch 集成测试
- Phase C (Phase 2): Maine Coon review + **设计→代码保真度对照**（UX V2 设计稿 vs 实现截图，team lead明确要求）

## 2026-03-31 Addendum（Issue #320）

### 背景

Issue #320 暴露出 F139/F140 的结构性割裂：

- PR tracking 存在 Redis `pr-tracking:*`
- 任务系统存在 Redis `task:*` / `tasks:thread:*`
- SchedulePanel 展示依赖 scheduler SQLite `task_run_ledger`

三套数据互不对齐，导致 Current Thread 视图无法正确呈现 PR 相关调度上下文，`cat_cafe_list_tasks` 也无法发现 PR tracking 任务。

### 新决策（KD-13 ~ KD-17）

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-13 | **移除独立 PrTrackingStore**，PR tracking 直接落到统一 Task Store（同一份 Redis 模型） | 消除双写/漂移，避免“路由数据”和“任务数据”各自为政 | 2026-03-31 |
| KD-14 | Task schema 扩展 `kind/subject_key/automation_state`，并新增 `tasks:subject:*` 与 `tasks:kind:*` 索引 | scheduler gate 需要按 subject 与 kind 精确检索，不再全量扫 + 业务拼装 | 2026-03-31 |
| KD-15 | `subject_key` 规范统一为 `kind:value`：`pr:{repo}#{num}` / `thread:{threadId}` / `repo:{owner/repo}` / `external:{id}` | 统一解析语义，消除 `thread-` 与 `thread:`、`pr-` 与 `repo-` 混用 | 2026-03-31 |
| KD-16 | `task_run_ledger` 增补 `task_ref_id/thread_id/run_id`，workItem 写入时携带 thread 维度 | Current Thread 过滤不再依赖 subject_key 字符串猜测 | 2026-03-31 |
| KD-17 | `register_pr_tracking` 采用 task upsert（subject 唯一）+ 生命周期闭环（open=doing, closed/merged=done） | 让 TaskPanel / SchedulePanel / MCP list_tasks 看到同一实体 | 2026-03-31 |

### 统一模型（目标态）

`TaskItem` 分为两类：

- `kind=work`：人类/猫协作任务（现有 todo/doing/blocked/done）
- `kind=pr_tracking`：PR 自动化任务（review-feedback / cicd-check / conflict-check 共享）

`pr_tracking` 任务最小字段：

- `subject_key`: `pr:{repoFullName}#{prNumber}`（唯一）
- `threadId` / `ownerCatId` / `createdBy` / `status`
- `automation_state`:
  - `ci`: `headSha/lastFingerprint/lastBucket/lastNotifiedAt/enabled`
  - `conflict`: `mergeState/lastFingerprint/lastNotifiedAt`
  - `review`: `lastCommentCursor/lastDecisionCursor/lastNotifiedAt`
  - `closedAt/archivedAt`

### 业务流（register_pr_tracking → scheduler → UI）

1. `cat_cafe_register_pr_tracking` 命中 `/api/callbacks/register-pr-tracking`
2. 服务端从 invocation record 解析 `threadId/catId/userId`，构造 `subject_key=pr:{repo}#{pr}`
3. Task Store 执行 upsert：
   - 新建：`kind=pr_tracking,status=doing`
   - 已存在同 subject：更新 thread/cat/user 与 enabled state
4. `review-feedback/cicd-check/conflict-check` 的 gate 改为 `listByKind('pr_tracking')`
5. execute 完成后：
   - patch 对应 task 的 `automation_state`
   - 写入 ledger（带 `task_ref_id/thread_id/run_id/subject_key`）
6. `/api/schedule/tasks?threadId=...` 直接按 `thread_id` + 任务绑定关系过滤
7. `/api/tasks` 与 `cat_cafe_list_tasks` 返回同一份 Task Store 数据（可按 `kind` 过滤）

### 接口调整

- `GET /api/schedule/tasks`：新增可选 `threadId` 参数
  - 无 `threadId`：返回全局调度视图
  - 有 `threadId`：返回当前线程相关任务（含 PR tracking 关联的 builtin poller）
- `GET /api/tasks` / `/api/callbacks/list-tasks`：新增可选 `kind` 过滤（`work|pr_tracking|all`）
- `cat_cafe_list_tasks`：透传 `kind`（默认 `all`），不再因“task:* 为空”漏掉 PR tracking

### 一致性与生命周期

- **单一真相源**：PR tracking 只存 Task Store；删除 `pr-tracking:*`
- **写入顺序**：deliver/route 成功 → patch task state → append ledger（同 `run_id`）
- **幂等键**：`subject_key` 唯一 upsert；`run_id` 防重复 ledger
- **TTL 对齐**：
  - `status != done` 的 `pr_tracking` 不过期
  - `done` 后进入归档 TTL（例如 30 天）
  - 清理任务同时清理 `tasks:subject:*` / `tasks:kind:*` / `tasks:thread:*` 索引

### 迁移（一次性切换，无兼容层）

面向现网已知 9 条 `pr-tracking:*`（PR #174/#268/#296/#298/#304/#305/#309/#318/#319）：

1. 进入维护窗口并暂停 scheduler（防迁移期间并发写）
2. 扫描 `pr-tracking:all`，读取每条 hash
3. 逐条生成 `pr_tracking` Task（subject 唯一 upsert）并写入新索引
4. 校验：
   - 迁移任务数 = 9
   - 覆盖 thread 数 = 5
   - `tasks:subject:*` 可反查全部 9 个 PR
5. 删除旧键：`pr-tracking:all` + 全量 `pr-tracking:{repo}#{pr}`
6. 启动新版本 scheduler，执行 smoke：
   - `cat_cafe_list_tasks(kind=pr_tracking)` 返回 9 条
   - SchedulePanel Current Thread 能看到对应 PR 任务

> 说明：该 addendum 定义的是 #320 的目标态设计，不是兼容期方案。实施时按一次性 cutover 执行。
