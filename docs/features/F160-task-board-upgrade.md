---
feature_ids: [F160]
related_features: [F055, F049, F131, F056]
topics: [task-board, thread-sidebar, workspace, ux, mcp-tools, protocol]
doc_kind: spec
created: 2026-04-12
---

# F160: 毛线球升级 — Thread-Level Persistent Task Board

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1

## Why

### team experience（2026-04-11 thread 讨论）

> "为什么毛线球长期任务从来没有被任何猫用过？是因为这个能力猫猫不知道？"
> "为什么一个东西有两个展示的地方？"

### 当前问题

毛线球（TaskPanel）自上线以来 **从未被任何猫主动使用过**。三猫头脑风暴（Ragdoll+Maine Coon+Siamese，2026-04-11）诊断出四个根因：

| 根因 | 解释 |
|------|------|
| **协议缺失** | 猫猫 system prompt 里没有 `list_tasks`/`create_task`，猫根本不知道自己能创建任务 |
| **创建入口缺失** | MCP 只有 `update_task`，没有 `cat_cafe_create_task`——能改不能建 |
| **展示边界模糊** | 毛线球 vs 猫猫祟祟（PlanBoard）的职责从未明确定义，PR tracking 泄漏进毛线球只是症状 |
| **UI 存在感为零** | 嵌在 ThreadSidebar 最底部，`tasks.length === 0` 时直接 `return null`——没人知道它在 |

### 三层任务架构（三猫共识，零分歧）

| 层级 | 组件 | 范围 | 数据源 | 生命周期 |
|------|------|------|--------|---------|
| **Mission Hub** (F049) | BacklogCenter | 项目/Feature 级 | ROADMAP.md + feature specs | 跨 thread |
| **🧶 毛线球** (本 Feature) | TaskPanel → TaskBoard | Thread 级 | TaskStore `kind=work` | 持久化，跨 session |
| **猫猫祟祟** (F055) | PlanBoardPanel | Invocation 级 | catInvocations | 随调用结束消失 |

> **教训**：持久实体如果没有创建入口、prompt 暴露、skill 编排、显示边界，就等于没做完。

## What

### Phase A: Protocol Closure — 让猫知道、让猫能用 ✅

**目标**：补齐协议层，让猫猫能发现和创建任务，不改 UI。

#### A1: MCP 工具补齐

新增 `cat_cafe_create_task` MCP tool：

```typescript
// 入参
{
  threadId: string;      // 当前 thread
  title: string;         // 任务标题
  why: string;           // 为什么要做
  ownerCatId?: CatId;    // 负责猫（可选，默认 null）
}
// 出参：TaskItem
```

约束：
- `kind` 强制 `'work'`（MCP 不允许创建 `pr_tracking` 任务）
- `createdBy` 从当前猫身份取
- `status` 默认 `'todo'`
- `subjectKey` 默认 `null`（work 任务不需要 dedup key）

#### A2: System Prompt 暴露

在 SystemPromptBuilder 的 thread 上下文块中加入任务能力描述：

```
## 🧶 毛线球（Thread Tasks）
你可以为当前 thread 创建和管理持久化任务。
- cat_cafe_create_task: 创建新任务
- cat_cafe_update_task: 更新任务状态（todo/doing/blocked/done）
- cat_cafe_list_tasks: 查看当前 thread 的任务列表
适用场景：team lead提了需要跟踪的事项、多猫协作分工、长期追踪项。
不要用于临时执行步骤（那是猫猫祟祟 PlanBoard 的职责）。
```

#### A3: Existing Tool 增强

- `cat_cafe_list_tasks`：确认支持 `threadId` + `kind=work` 过滤（已有 API，需确认 MCP tool 暴露）
- `cat_cafe_update_task`：已存在，确认输入参数完备

### Phase B: UI Upgrade — 从隐藏列表到 Workspace Tab ✅

**目标**：毛线球从 ThreadSidebar 底部的隐藏列表升级为 Workspace 右面板的独立 Tab。

**Design Gate 结论**（2026-04-14 通过）：
- `任务` 放在 Workspace mode pill 层，和 开发/记忆/调度 同级
- doing/blocked 默认展开，todo/done 默认折叠（折叠偏好用 localStorage 记忆）
- 新建入口用 inline composer，不开 modal
- 设计稿：`designs/F160-task-board-phase-b-ux.pen`

#### B1: Workspace Tab 接入

在右面板 Workspace 导航中新增第 4 个 Tab「任務」：

- Tab 图标：毛线球 SVG（设计语言 F056 四大宪章 — Cafe Metaphors）
- Tab 切换逻辑：复用 F131 Workspace Navigator 的 `rightPanelMode` 机制
- 旧 TaskPanel 从 ThreadSidebar 移除

#### B2: TaskBoard 四段式布局

```
┌─────────────────────────────┐
│  🧶 毛线球          [+ 新任务] │  ← 标题栏 + 创建入口
├─────────────────────────────┤
│  ◉ 进行中 (doing)     2     │  ← 蓝色左边框
│  ┌─ 修复登录超时 ─── 🐱Ragdoll ─┐│
│  └─────────────────────────┘│
│  ┌─ API 文档更新 ─── 🐱Maine Coon ─┐│
│  └─────────────────────────┘│
├─────────────────────────────┤
│  ⊘ 阻塞中 (blocked)   1     │  ← 红色左边框 + 高亮
│  ┌─ 等依赖方回复 ─── 🐱Siamese ─┐│
│  └─────────────────────────┘│
├─────────────────────────────┤
│  ○ 待办 (todo)         3     │  ← 灰色，默认折叠
│  ···                        │
├─────────────────────────────┤
│  ● 已完成 (done)       5     │  ← 绿色，默认折叠
│  ···                        │
└─────────────────────────────┘
```

设计规范（遵循 F056 + DESIGN.md）：

- **Surface**: `bg-cafe-surface` 画布底，任务卡片 `bg-cafe-surface-elevated`
- **Cards**: `border border-cafe rounded-xl p-3`，左边框 4px 色带表示状态
- **Typography**: 任务标题 14px/500（Body/Nav 层级），why 文本 12px/400（Caption）
- **Cat Avatar**: 复用 `<CatAvatar>` 组件，14px，persona 色环
- **Status Colors**: doing=`--cafe-crosspost` 蓝系, blocked=`--cafe-accent` 暖红, todo=`--cafe-text-muted`, done=绿色
- **Spacing**: 8px grid — 段间 gap-3, 卡片内 p-3, 段标题 px-3
- **Border Radius**: 卡片 12px (`rounded-xl`)，符合 Cards 规范
- **Hover**: `hover:-translate-y-0.5 transition-transform ease-out` 微上浮
- **Dark Mode**: 自动跟随 semantic token，无额外工作
- **Blocked 高亮**: `bg-red-50`/dark:`bg-red-950/20` 底色，视觉上最先引起注意
- **折叠**: todo/done 默认折叠，点击段标题展开，`transition-all ease-out 200ms`

#### B3: 创建入口

标题栏右侧 `[+]` 按钮，点击展开 inline 创建表单：
- 标题输入框 + "为什么"输入框（可选）
- ~~负责猫下拉选择（从 thread 猫列表取）~~ → Phase B 实际交付：不含 owner 选择器，任务默认 unassigned，猫可通过 `cat_cafe_update_task` 自行领取。后续如需 owner 选择器另开 Feature。
- 提交调用 `POST /api/tasks`（复用现有 API）

#### B4: 任务卡片交互

- 点击卡片展开详情（why 文本 + 创建时间 + 来源）
- 状态切换：卡片内 status pill 点击切换（todo→doing→blocked/done）
- 拖拽排序：Phase B 暂不做（三猫共识：先做好基础，拖拽是锦上添花）

### Phase C: Skill Automation — 让猫主动用起来 ✅

**目标**：在关键 Skill 节点自动提示/创建任务，形成闭环。

#### C1: Skill 编排集成

在以下 Skill 流程中加入任务自动化钩子：

| Skill | 触发点 | 自动行为 | 状态 |
|-------|--------|---------|------|
| `feat-lifecycle` Kickoff | Feature 立项后 | 创建"完成 Fxxx" work 任务 | ✅ AC-C1 |
| `receive-review` | 收到 review 反馈 | 为每个 P1/P2 创建修复任务 | ✅ AC-C2 |
| `debugging` | Bug 诊断完成 | 创建修复任务（含根因 why） | ➖ 未纳入 AC，后续按需补 |
| `cross-cat-handoff` | 交接时 | 创建交接任务给目标猫 | ➖ 未纳入 AC，后续按需补 |

#### C2: 任务提醒

- 猫猫进入 thread 时，如果有 `blocked` 任务，system prompt 附加提醒 ✅ AC-C3
- ~~定期检查：如果任务 `doing` 超过 3 天无更新，在 thread 内提醒负责猫~~ → 未纳入 AC，后续按需补

## Acceptance Criteria

### Phase A（Protocol Closure）✅
- [x] AC-A1: `cat_cafe_create_task` MCP tool 可用，创建的任务 `kind=work`，出现在 TaskPanel
- [x] AC-A2: SystemPromptBuilder 包含毛线球能力描述，猫猫知道如何创建/查看/更新任务
- [x] AC-A3: `cat_cafe_list_tasks` 在 MCP 中可用，支持 `threadId` + `kind` 过滤
- [x] AC-A4: 回归测试：PR tracking 任务仍然不出现在毛线球（PR #958 守护）

### Phase B（UI Upgrade）✅
- [x] AC-B1: 毛线球从 ThreadSidebar 底部移至 Workspace 右面板独立 Tab
- [x] AC-B2: 四段式布局（doing/blocked/todo/done），blocked 高亮，todo/done 默认折叠
- [x] AC-B3: 人工创建入口（`[+]` 按钮 + inline 表单）可用
- [x] AC-B4: 任务卡片展开详情 + 状态切换可用
- [x] AC-B5: 遵循 F056 设计语言（semantic token / 8px grid / warm radius / dark mode）
- [x] AC-B6: 无视觉回归（ThreadSidebar 移除 TaskPanel 后布局正常）

### Phase C（Skill Automation）✅
- [x] AC-C1: feat-lifecycle kickoff 自动创建 thread 任务
- [x] AC-C2: receive-review 为 P1/P2 自动创建修复任务
- [x] AC-C3: blocked 任务在猫进入 thread 时触发 system prompt 提醒

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "为什么毛线球从来没有被任何猫用过？" | AC-A1, AC-A2, AC-C1~C3 | MCP tool 测试 + prompt 检查 + skill 自动化 | [x] |
| R2 | "为什么一个东西有两个展示的地方？" | AC-B1, AC-B6 | 毛线球只在 Workspace Tab，旧 ThreadSidebar 入口已移除 | [x] |
| R3 | 三猫共识：协议先行，先让猫能用再改 UI | AC-A1~A4 | Phase A 独立验收通过 (PR #1116) | [x] |
| R4 | 三猫共识：四段式布局，blocked 高亮 | AC-B2 | Phase B 实现 + Design Gate 通过 | [x] |
| R5 | 三猫共识：Skill 自动编排形成闭环 | AC-C1~C3 | feat-lifecycle + receive-review 自动创建 + blocked 提醒 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 三层任务架构：Mission Hub / 毛线球 / 猫猫祟祟 | 三猫头脑风暴零分歧，层级清晰不重叠 | 2026-04-11 |
| KD-2 | Phase A 协议先行，不先动 UI | 根因是猫不知道能力存在，补协议 ROI 最高 | 2026-04-11 |
| KD-3 | 毛线球升级为 Workspace 右面板独立 Tab | 嵌在 ThreadSidebar 底部存在感为零，Tab 级入口才配得上持久化任务板 | 2026-04-11 |
| KD-4 | MCP `create_task` 强制 `kind=work` | 防止 MCP 创建 pr_tracking 任务（PR #958 教训） | 2026-04-12 |
| KD-5 | Phase B 暂不做拖拽排序 | 三猫共识：先做好基础，拖拽是锦上添花 | 2026-04-11 |
| KD-6 | Status 色彩遵循 F056 semantic token | 不新增色值，复用 cafe-crosspost(蓝)/cafe-accent(红)/cafe-text-muted(灰) | 2026-04-12 |

## Dependencies

- **Evolved from**: F029（删除右面板"任务统计"死区 — 毛线球的前身被清理后重新定义）
- **Related**: F055（猫猫祟祟/PlanBoard — 调用级，互补关系）
- **Related**: F049（Mission Hub — 项目级，互补关系）
- **Related**: F131（Workspace Navigator — Tab 机制复用）
- **Related**: F056（设计语言 — UI 规范遵循）
- **Related**: PR #958（PR tracking 泄漏修复 — Phase A 需守护回归）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase A 补了协议但猫仍不主动用 | Phase C 的 Skill 自动编排兜底 |
| Workspace Tab 过多（已有 3 个加这个 = 4）| 右面板空间充裕，且任务是高频操作 |
| 任务与 PlanBoard 边界模糊导致用户困惑 | spec 明确定义三层架构 + system prompt 里写清区别 |
| 人工创建入口增加 UI 复杂度 | inline 表单，不弹 modal，轻量交互 |

## Review Gate

- Phase A: 跨家族 review（纯后端/协议层）
- Phase B: **team lead review**（前端 UI/UX，需 Design Gate 确认 wireframe）+ 跨家族 code review
- Phase C: 跨家族 review
