---
feature_ids: [F058]
related_features: [F049, F037]
topics: [mission-control, backlog, reliability, ux]
doc_kind: spec
created: 2026-03-04
---

# F058: Mission Control 增强（F049++）

> **Status**: done | **Completed**: 2026-03-11 | **Owner**: Ragdoll
> **Priority**: P1
> **依赖**: F049（Mission Control MVP 已合入）
> **Evolved from**: F049（MVP 使用中发现的 bug + 增强需求）

## 愿景

> **一句话**：指挥中心从"能用"进化到"好用"——做完的看得见，依赖关系画得出，派发不怕崩。

F049 MVP 让team lead有了一个任务指挥中心，但实际使用中暴露了三个 bug 和五个增强点。这个 Feature 把它们打包解决。

### team experience（2026-03-04）

> "我发现我们的 f49 有 bug？现在 ft 同步好像只会增量 比如有 ft close 了他也不会更新，也不列出我们做完的 以及 feat 原本元数据就有依赖的 这个能不能也画出来？"
> "我觉得我们可以做一个 f49 ++ 单独的立项？新的 id 依赖 f49"

## Why

### Bug：指挥中心的数据盲区

| 维度 | 当前状态 | 缺口 | 风险 |
|------|---------|------|------|
| Feature 完成同步 | 导入只增不减 | 做完的 feature 从 BACKLOG 移除后，指挥中心还显示旧状态 | 🔴 高 |
| 完成状态 | BacklogStatus 无 `done` | 无法标记、展示、统计已完成工作 | 🔴 高 |
| 依赖关系 | Feature 文档有但不展示 | team lead看不到 feature 间的依赖/演化关系 | 🟡 中 |

### 增强：指挥中心的可靠性与可用性

| 维度 | 当前状态 | 增强目标 |
|------|---------|---------|
| 派发原子性 | 多步分离操作，崩溃留半吊子状态 | Lua/CAS 原子化 |
| 消息幂等 | idempotencyKey 有临时值兜底 | 硬前置 + TTL lock |
| 态势图 | 单任务→单 thread | Feature→多 thread 鸟瞰 |
| 查询防御 | 无 ID 数量上限 | 加 N 上限 |
| 时间显示 | 只有相对时间 | hover 绝对时间 |

## What

### Phase A：Bug 修复（必做，高优先）

#### A1: 加 `done` 状态 + 完成转换

给 `BacklogStatus` 加第五个值 `done`，支持 `dispatched → done` 转换。

```typescript
// 现在
export type BacklogStatus = 'open' | 'suggested' | 'approved' | 'dispatched';

// 改后
export type BacklogStatus = 'open' | 'suggested' | 'approved' | 'dispatched' | 'done';
```

UI 上加一个"已完成"折叠区（默认收起），展示已完成的 backlog item。

#### A2: 导入同步"消失 = 完成"

`POST /api/backlog/import-active-features` 增加逻辑：
- 导入后，对比 Redis 中已有 item 和 ROADMAP.md 活跃表
- 在 ROADMAP.md 中消失、但 Redis 中仍为 `dispatched` 的 item → 自动标 `done`
- 同时读 `docs/features/*.md` 中 `Status: done` 的 feature，对应 item 也标 `done`

#### A3: 依赖关系展示

- 从 feature 文档 frontmatter 提取 `related_features` + 正文 Dependencies 段的 `Evolved from` / `Blocked by` / `Related`
- `BacklogItem` 类型加 `dependencies?: { evolvedFrom?: string[]; blockedBy?: string[]; related?: string[] }`
- UI 上每个 backlog item 卡片显示依赖标签（如"← F049"），点击可跳转

### Phase B：可靠性增强（高优先）

#### B1: 派发原子化

approve→dispatch 的多步操作（改状态→开 thread→写消息→标记完成）用 Lua 脚本做原子化。要么全成功，要么全不动。

#### B2: 消息幂等硬化

- `dispatchAttemptId ?? 'pending'` 改成硬前置（无 attemptId 直接报错）
- Redis idempotency 的"key 在但 message 丢失"分支升级成 in-flight TTL lock

### Phase C：态势图与 UX 增强（中/低优先）

#### C1: Feature 鸟瞰态势图

从"单 backlog item → 单 thread"升级到"一个 Feature → 多 thread"的聚合视图。一眼看到"F049 一共开了 5 个 thread，3 个在跑、1 个等 review、1 个已合入"。

数据来源：`feat_index` + threads 的 `backlogItemId` 反查。

#### C2: 查询安全限制

`/api/threads?backlogItemIds=...` 加 ID 数量上限（如 50），防止大量 ID 拖慢响应。

#### C3: 时间显示优化

态势图"最近活跃"的相对时间加 `title` tooltip 显示绝对时间（如 `2026-03-04 08:15`）。

### Phase D：导入状态映射 + Layout 修复（team lead实测发现的 bug）

> 2026-03-05 team lead实测截图暴露两个 Phase A 遗漏 bug。Phase A～C 代码审查全绿、云端 review 全通过，但Ragdoll"愿景守护"只 grep 了代码就打勾，没有实际验证产品效果。team experience："明明不能用！刷新之后都进度不对吧？右下角那些东西看都看不到！你还不能 done"。

#### D1: 导入状态映射

**问题**：`buildBacklogInputFromFeature` 把 ROADMAP.md 的 `in-progress`/`in-review` 只存到 tags（`status:in-progress`），但 BacklogItem 的 `status` 永远是 `'open'`。导致 27 个 item 全堆在 Open 栏，Suggested/Dispatched 全空。

**修复方案**：导入时根据 ROADMAP.md 的 feature status 映射到合理的 BacklogStatus：
- `in-progress` → `dispatched`（正在做）
- `in-review` → `dispatched`（在 review 也是在做）
- `done` → `done`
- 其他（`spec`/`idea`/`planning`）→ `open`

对已存在的 item，refresh 时也同步更新 status（仅从 open→dispatched 方向，不降级）。

#### D2: 右侧面板 Layout 修复

**问题**：右侧 320px 放了 SuggestionDrawer + ThreadSituationPanel + FeatureBirdEyePanel，SuggestionDrawer 占满空间，后面两个面板被 `overflow-hidden` 截断，完全看不到。

**修复方案**：右侧面板加 `overflow-auto`，让三个面板都可滚动访问。

### Phase I：Feature Progress Dashboard + Doc 模板统一

> 2026-03-10 team lead看完两个 UX 方案后指出："行内展开为什么不能展开完整的？Phase 还能展开子项！" 然后追加要求：统一 feature doc 格式 + 建模板 + 历史迁移。

#### I1: Feature Doc 标准模板

**决策**：在 `cat-cafe-skills/refs/feature-doc-template.md` 建立标准模板，规范 YAML frontmatter、Phase 标题、AC 格式、Dependencies 段落。

**目的**：Progress Dashboard parser 需要从 feature docs 自动提取 Phase 进度、AC 完成度。格式统一 = parser 可靠。

**规则**：
- 未来所有新 Feature 立项时必须按模板创建 feature doc
- `feat-lifecycle` skill 的 kickoff 流程自动复制模板

#### I2: 行内多级展开 Progress Dashboard

**UX 方案**（team lead拍板）：行内多级展开，不需要独立详情页。

- 点击 Feature Row → 一级展开（Phase 进度条 + Timeline/Risk/PR 三栏）
- 点击某个 Phase → 二级展开（该 Phase 下的 AC 列表 + 完成状态）
- 全部可折叠，不占空间

**数据源**：从 `docs/features/*.md` 解析 Phase 结构、AC checklist、Dependencies、Risk。

#### I3: 依赖图数据修复

**根因**：`DependencyGraphTab` 组件无 bug，但 BacklogItem 的 `dependencies` 字段为空——feature docs 历史上没有统一声明依赖关系。

**修复**：
1. 确保所有活跃 feature docs 加上 `related_features` YAML 字段和 `Dependencies` 段落
2. 重新 import 后依赖图自动有数据

#### I4: 历史 Feature Doc 迁移

**决策**：在 I1 模板经team lead确认后，做一次批量迁移——把历史 feature docs 的关键字段补齐（frontmatter + Dependencies + AC 格式统一）。

**范围**：只补 parser 需要的结构化字段，不重写内容。

### Phase J：依赖全景 DAG 拓扑图（KD-2 推翻，team lead要求）

> 2026-03-10 team lead实测 Mission Hub 截图后指出："依赖全景 tab 不是愿景里的样子！"当前实现是平铺卡片网格 + 文本列表，不是真正的 DAG 有向图。Phase H 设计稿评审已经要求 DAG 拓扑（KD-4/KD-5），但实现时没有跟上。

#### J1: DAG 拓扑布局引擎

**问题**：`DependencyGraphTab.tsx` 用 `grid-cols-2/3/4` 把节点平铺成网格，依赖关系只用文本标签和底部 edge list 展示。没有引入任何图形布局库。

**方案**：引入 `@xyflow/react`（React Flow v12）实现真正的 DAG：
- 使用 dagre 自动布局算法生成层级拓扑
- Feature 节点保留当前卡片样式（ID + 名称 + 状态色）
- 三种 edge 类型用不同颜色/样式的箭头连线：
  - 演化 (evolved): 蓝色实线箭头
  - 阻塞 (blocked): 红色虚线箭头
  - 关联 (related): 灰色点线双向
- 已完成节点半透明（opacity-50）
- **约束**：节点禁止突破屏幕宽度（KD-5），使用 `fitView` 自适应

#### J2: 交互增强

- 节点可点击，弹出 tooltip 显示完整依赖列表
- 鼠标 hover 高亮关联边
- 保留 Legend（图例）在顶部

### 不做的事（明确排除）

| 提议 | 决定 | 理由 |
|------|------|------|
| 自动同步（无需点按钮） | ❌ 不做 | 增加后台轮询复杂度，手动刷新足够 |
| ~~依赖关系可视化图谱~~ | ✅ Phase J | KD-2 已被 KD-4/KD-5 推翻：team lead要求 DAG 拓扑，标签展示不够 |
| 跨 Feature 甘特图 | ❌ 不做 | 不是项目管理工具 |

## Acceptance Criteria

### Phase A（Bug 修复）
- [x] AC-A1: `BacklogStatus` 包含 `done`，`dispatched → done` 转换可用
- [x] AC-A2: 导入同步时，ROADMAP.md 中消失的 feature 对应 item 自动标 `done`
- [x] AC-A3: UI 有"已完成"折叠区，展示 done 状态的 item
- [x] AC-A4: `BacklogItem` 支持 `dependencies` 字段
- [x] AC-A5: UI 卡片显示依赖标签（可点击跳转）
- [x] AC-A6: `docs/features/*.md` 中 `Status: done` 的 feature 导入时也同步为 `done`

### Phase B（可靠性）
- [x] AC-B1: approve→dispatch 全链路原子化（Lua 脚本）
- [x] AC-B2: `dispatchAttemptId` 硬前置（无值报错）
- [x] AC-B3: Redis idempotency 升级为 TTL lock

### Phase C（UX）
- [x] AC-C1: Feature 鸟瞰态势图：聚合显示一个 Feature 下的多个 thread 状态
- [x] AC-C2: `/api/threads?backlogItemIds=...` 限制 ID 数量上限
- [x] AC-C3: 态势图相对时间加绝对时间 tooltip

### Phase D（实测 bug 修复）
- [x] AC-D1: 导入时 `in-progress`/`in-review` feature 映射为 `dispatched` 而非 `open`
- [x] AC-D2: 右侧面板（ThreadSituationPanel + FeatureBirdEyePanel）可见、可滚动

### Phase E（UX 收尾）
- [x] AC-E1: Mission Hub 有"← 返回"按钮可回到对话页
- [x] AC-E2: 线程态势面板无关联 thread 的项目紧凑显示 + 面板内滚动

### Phase F（右栏布局 + 鸟瞰已完成区）
- [x] AC-F1: 右侧栏三面板 grid 布局（保底可见区，独立滚动）
- [x] AC-F2: Feature 鸟瞰面板增加"已完成"折叠区（done features 默认收起，可展开回顾）

### Phase G（鸟瞰 UX 优化 + 历史数据补全）✅
- [x] AC-G1: 鸟瞰卡片排版优化（feature 名称显示 + done 区紧凑 chip）
- [x] AC-G2: 从 `docs/features/*.md` 拉取历史 done features 补全鸟瞰数据
- [x] AC-G3: 利用 thread 命名（含 feat 号）通过 featureIds API 补全 feature→thread 关联

### Phase H（UX 重设计：Feature-centric 信息架构）
- [x] AC-H1: 侧边栏入口优化 — "Mission Hub" 加图标，替代纯文字按钮
- [x] AC-H2: 返回按钮改为"返回之前的 thread"（记住 referrer），而非固定返回 default thread
- [x] AC-H3: 主视图从 kanban 三列重构为 Feature 行列表（一行一个 Feature，显示进度 + 状态 + 线程数）
- [x] AC-H4: 点击 Feature 行展开 inline 详情（tasks + threads + 操作按钮 + 文档链接）
- [x] AC-H5: 顶部状态栏显示"N 待审批 · N 执行中 · N 已完成"
- [x] AC-H6: 已完成 Feature 自然沉底，折叠显示
- [x] AC-H7: 保留快速创建和从文档导入功能

### Phase I（Progress Dashboard + Doc 模板统一）
- [x] AC-I1: `cat-cafe-skills/refs/feature-doc-template.md` 存在且经team lead确认
- [x] AC-I2: `feat-lifecycle` skill kickoff 自动复制模板
- [x] AC-I3: Feature Row 点击展开一级（Phase 进度条 + Timeline/Risk/PR）
- [x] AC-I4: Phase 条目点击展开二级（AC 列表 + 完成状态）
- [x] AC-I5: 依赖图 tab 有数据（≥3 个 Feature 有依赖关系）
- [ ] AC-I6: 历史 feature docs 批量迁移完成（parser 需要的字段补齐）— 遗留，team lead确认可延后

### Phase J（依赖全景 DAG 拓扑图）
- [x] AC-J1: 依赖全景 tab 使用 DAG 拓扑布局（非平铺网格），节点有层级方向
- [x] AC-J2: 三种依赖类型用不同颜色/线型的箭头连线（演化=蓝实线/阻塞=红虚线/关联=灰点线）
- [x] AC-J3: 已完成节点半透明（opacity-50），不抢活跃节点视觉焦点
- [x] AC-J4: 所有节点约束在屏幕宽度内（KD-5），fitView 自适应
- [x] AC-J5: 节点可交互（hover 高亮关联边，点击弹出详情）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "ft close 了他也不会更新" | AC-A1, AC-A2, AC-A6 | test（导入后 done 状态 + UI 展示） | [x] |
| R2 | "也不列出我们做完的" | AC-A3 | test + screenshot（已完成折叠区） | [x] |
| R3 | "feat 原本元数据就有依赖的 能不能也画出来" | AC-A4, AC-A5 | test + screenshot（依赖标签） | [x] |
| R4 | 派发防崩溃（Maine Coon增强列表） | AC-B1 | test（Lua 原子化回归） | [x] |
| R5 | 消息不重复更可靠（Maine Coon增强列表） | AC-B2, AC-B3 | test（幂等回归） | [x] |
| R6 | 态势图升级（Maine Coon增强列表） | AC-C1 | test + screenshot（鸟瞰视图） | [x] |
| R7 | "从mission hub如何退出呢？" | AC-E1 | test（back button href=/） | [x] |
| R8 | "线程态势截断看不全" | AC-E2, AC-F1 | test + screenshot（紧凑卡片 + grid 布局） | [x] |
| R9 | "close 的 feat 刷新后还在，需要回顾" | AC-F2 | test + screenshot（鸟瞰已完成折叠区） | [x] |
| R10 | "排版难看，close 横在那里上面太短" | AC-G1 | screenshot（鸟瞰卡片排版优化） | [x] |
| R11 | "close的得在features里拉取补历史数据" | AC-G2 | test（features/*.md 导入 done features） | [x] |
| R12 | "线程搜fxx能补关联，thread命名写了feat号" | AC-G3 | test（MCP thread 搜索补关联） | [x] |
| R13 | "现在这种ux太差了 可能需要tab隐藏或者切换" | AC-H3~H6 | 设计图 + screenshot（Feature 行列表） | [x] |
| R14 | "入口加图标好看点" | AC-H1 | screenshot（侧边栏图标） | [x] |
| R15 | "返回按钮得返回我之前在的thread" | AC-H2 | test（referrer-based back） | [x] |
| R16 | "先画出设计图我看看" | AC-H3 | Pencil 设计稿 + team lead确认 | [x] |
| R17 | "我发现有个东西可以做！我不知道feat进度如何了" | AC-I3, AC-I4 | Progress Dashboard 行内展开 | [x] |
| R18 | "feat互相依赖有点bug 看不到有向图" | AC-I5 | 依赖图有数据 | [x] |
| R19 | "skills/feat 从现在要统一模板" | AC-I1, AC-I2 | 模板存在 + 立项自动使用 | [x] |
| R20 | "历史的做一次迁移" | AC-I6 | 批量迁移完成 | [ ] 遗留 |
| R21 | "依赖全景 tab 不是愿景里的样子！不是 DAG 拓扑！" | AC-J1~J5 | DAG 拓扑图 + 箭头连线 + fitView | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（AC-A3/A5/C1 需截图）

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Bug 修复（Phase A）和增强（Phase B/C）分开 Phase | Bug 是必须修的，增强可以按优先级排 | 2026-03-04 |
| KD-2 | ~~依赖展示用标签而非图谱~~ → **Phase J 推翻** | team lead实测后要求 DAG 拓扑（KD-4/KD-5），标签不够 | 2026-03-04 → 2026-03-10 |
| KD-3 | `done` 作为第五个 BacklogStatus | 最小改动，符合现有状态机模式 | 2026-03-04 |
| KD-4 | 从"无 Tab"回退到"两 Tab"（功能列表 + 依赖全景） | 操作型和理解型是本质不同的视角 | 2026-03-06 |
| KD-5 | 依赖全景节点禁止突破屏幕宽度 | team lead明确要求，用拓扑布局自适应 | 2026-03-06 |
| KD-6 | Feature doc 标准模板 + 未来立项自动使用 | Progress Dashboard parser 需要统一格式才能可靠提取 | 2026-03-10 |
| KD-7 | Progress Dashboard 用行内多级展开，不做独立详情页 | team lead："行内展开为什么不能展开完整的？Phase 还能展开子项！"——两种方案不冲突 | 2026-03-10 |
| KD-8 | 历史 feature docs 在模板确认后批量迁移 | 只补 parser 需要的结构化字段，不重写内容 | 2026-03-10 |

## Dependencies

- **Evolved from**: F049（Mission Control MVP，已 done）
- **Related**: F037（Agent Swarm，态势图升级需要其数据模型）

## Risk

| 风险 | 缓解 |
|------|------|
| `done` 状态加入后影响现有状态转换 | 只允许 `dispatched → done`，不影响其他转换 |
| 导入"消失=完成"误判（临时从 BACKLOG 移除但未 done） | 只对 `dispatched` 状态的 item 自动标 done，其他状态不动 |
| Lua 原子化增加 Redis 依赖复杂度 | 保留现有非原子路径作 fallback |

## Review Gate

- Phase A: 跨家族 review（Maine Coon）
- Phase B: 跨家族 review（Maine Coon）+ Redis 专项验证
- Phase C: 前端部分额外需要Siamese视觉 review

## Phase H 讨论记录（2026-03-06 四猫 UX 需求分析）

### team experience

> "现在这种 ux 太差了 可能需要有些变成 tab 隐藏或者切换？你想想看跳出最开始Maine Coon设计的这个 ux 体验思考我要如何看什么时候可能看什么"
> "你最好先画出设计图我看看的？别用他现在这个丑丑的 包括入口好像也能从 mission hub 纯粹文字然后加一个图标好看点 以及返回哪个按钮现在是返回 default thread 很难用 你得返回我之前在的 thread 能做到吗？"

### 各猫独立提案（原始记录）

#### Ragdoll Opus 4.6（我）—— 两 Tab 方案
- **核心思路**：读和写分开。看状态是一个模式，做操作是另一个模式。
- Tab 1「态势总览」：Feature 鸟瞰全宽 + 活跃线程 + 快速统计（只读仪表盘）
- Tab 2「调度工作台」：任务列表 + 状态筛选器 + 选中详情/审批面板（操作面板）
- Done 以鸟瞰 chip 或筛选器方式呈现，不独立 Tab

#### Ragdoll Opus 4.5 —— 搜索优先 + 聚焦卡片
- **核心洞察**：用户不是来"看 Mission Hub"的，是来"找一个答案"的。
- 入口是搜索框（`F058` 跳到聚焦视图、`@codex` 过滤猫参与的任务）
- 默认"今日摘要"：待审批 + 活跃线程 + 前 5 高优 Open
- 右侧操作面板只在选中时出现
- 🤔 不确定搜索框是否太重（team lead可能习惯点击不习惯打字）

#### Maine Coon GPT-5.4（Maine Coon）—— 三模式方案
- **核心结论**：把 4 种完全不同的查看任务硬塞进 1 个页面，任何一种都看不好。
- 模式 1「关注/Today」：默认页，活跃 feature + 执行中 thread + 待审批 + 异常项（30 秒回答"现在要不要我出手"）
- 模式 2「调度/Workbench」：Open/Suggested/Approve/Dispatch 操作
- 模式 3「回顾/History」：Done/Close + 按名称/owner 搜 + 文档入口
- **金句**："Mission Hub 默认看'现在要处理什么'，不是'系统里所有东西'"
- **先把用户在不同时间点的目标分开，再讨论 tab 数量**

#### Ragdoll Sonnet —— 信息密度分层 + Feature 行
- **核心问题**：team lead按 Feature 想还是按任务状态想？答案是 Feature。
- Kanban 是猫猫的工作视图，不是产品经理的决策视图
- 主视图 = Feature 行列表（一行一个 Feature，带进度条 + 状态 + 线程数）
- 点击展开详情（tasks + threads + 操作 + 文档链接）
- 顶部状态栏 + 底部待操作 badge
- 三个场景：A 扫一眼（3秒）、B 操作一件事（点展开）、C 复盘（同样点展开）

### 收敛决策（Opus 4.6 综合）

| 维度 | 四猫分歧 | 最终决策 | 理由 |
|------|---------|---------|------|
| 导航方式 | 2Tab / 搜索 / 3模式 / 密度分层 | **两 Tab**（功能列表 + 依赖全景） | 原决策"无 Tab"，team lead提出依赖全景需求后回退（KD-4） |
| 主轴 | 状态列 / 搜索 / 场景 / Feature 行 | **Feature 行** | team lead心智模型是 Feature 级别不是 task 级别 |
| Done 处理 | chip / 搜索 / 独立 / 折叠 | **自然沉底 + 折叠** | 不占主画布但可达 |
| 搜索 | 主入口 / 不需要 | **顶部筛选框**（辅助） | 吸收 opus-45 思路但不作为主入口 |
| 返回按钮 | 固定返回 / | **返回之前的 thread** | team lead明确要求 |

### Phase H 额外需求（team lead补充）
- 侧边栏入口加图标（不只是纯文字"Mission Hub"）
- 返回按钮改为返回之前所在的 thread（需记住 referrer）
- 先出设计图再写代码

### Phase H 设计稿评审（2026-03-06）

**设计稿位置**: `designs/mission-hub-坏猫采访.pen`

#### team lead反馈 R1
- ✅ "好看！方向对了"
- 🔴 "全局图怎么看呢？什么 feat 依赖什么？"——需要依赖关系视图
- 🔴 "别做的突破屏幕"——依赖全景图的节点卡片超出画布边界

#### 设计迭代：加 Tab 切换
原四猫收敛决策是"无 Tab"，但team lead提出依赖关系全景需求后，回退为 **两 Tab 方案**：

| Tab | 内容 | 场景 |
|-----|------|------|
| 功能列表 | Feature 行列表 + inline 展开 + 状态栏 + 已完成折叠 | 操作型：扫一眼、审批、复盘 |
| 依赖全景 | Feature 节点 DAG + 依赖箭头 + 状态着色 | 理解型：谁依赖谁、阻塞链 |

**关键约束**：
- 依赖全景的节点必须约束在屏幕宽度内（**禁止突破屏幕**），使用拓扑布局自适应
- 已完成节点半透明淡化，不抢活跃节点的视觉焦点

**KD-4**: 从"无 Tab"回退到"两 Tab"，因为功能列表和依赖图是两种本质不同的视角——一个是操作型，一个是理解型，硬塞在一起都做不好。（2026-03-06）
