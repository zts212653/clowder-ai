---
feature_ids: [F095]
related_features: []
topics: [frontend, ux, sidebar, navigation]
doc_kind: spec
created: 2026-03-10
status: done
---

# F095: Thread Sidebar 导航体验升级

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1
**Phase A~D completed: 2026-03-13** | **Phase E/F/G completed: 2026-03-27**
**Implementation**: PR #366 / #370 / #373 / #376 / #378 / #380 / #779

## Why

team lead反馈：Thread Sidebar 在当前 5-10 个项目时已经很难用（cat-cafe 174 条 thread 却排在第四位），新建对话窗口太小、不能命名、不能关联 feat、不能置顶。

**终态挑战**：当项目增长到 20-50 个时，扁平分组列表无论怎么排序都不可用。**这不是排序问题，是"只展示活跃的"问题。**

team experience：
> "你看我们有这么多每个都展开而且我想用的 cat cafe 在这么下面！这也太难用了"
> "我希望比如说我可以填写他的 thread 名字！甚至直接关联某个 feat！"
> "默认折叠！分组置顶、拖拽排序等你和Maine Coon一起讨论揣摩一下用户需求都给我优化一下！"
> "如果后续我们有 20 个项目 50 个项目怎么办？"

核心设计原则（家规 P1）：**每步产物是终态基座不是脚手架**。

## What

### Phase A: 折叠状态持久化 + 搜索可见性 ✅

最小改动，立即改善体验。

1. **折叠状态 localStorage 持久化**：展开/折叠操作实时写入 localStorage，刷新后恢复
2. **默认全部折叠**（首次访问无记忆时保持现状）
3. **搜索时强制展开匹配分组**：搜索命中的 thread 所在分组忽略折叠状态，直接展示
4. **当前活跃 thread 所在分组自动展开**：切换 thread 时，目标分组自动展开并滚到可见区域
5. **全部展开/全部折叠快捷操作**：sidebar 顶部加一个 toggle

### Phase B: 活跃工作区（核心终态设计） ✅

解决 50 个项目时的导航问题。核心思路：**不展示所有项目，只展示活跃的。**

Sidebar 布局从上到下：

```
┌─────────────────────────┐
│ 🔍 搜索（已有）          │
├─────────────────────────┤
│ 📌 置顶 (跨项目)         │  ← 现有，不变
├─────────────────────────┤
│ 🕐 最近对话 (≤8)         │  ← 新增：跨项目，按 lastActiveAt
│    不分组，快速触达       │
├─────────────────────────┤
│ 📁 活跃项目区            │  ← 新增概念
│  cat-cafe          [▼]  │    近 7 天有活动 OR 用户手动 pin
│  relay-station     [▼]  │    自动收纳不活跃项目
│  studio-flow       [▼]  │
├─────────────────────────┤
│ 📦 其他项目 (42)    [▶]  │  ← 折叠入口，不活跃项目收在这里
├─────────────────────────┤
│ ⭐ 收藏              [▶]  │  ← 现有，不变
└─────────────────────────┘
```

关键设计：

1. **活跃项目**定义：最近 7 天内有 thread 活动（`lastActiveAt`）的项目，**或**用户手动 pin 的项目
2. **不活跃项目**自动收纳到"其他项目"折叠区，点开可展开完整列表
3. **项目 pin**（区别于 thread pin）：用户可以手动将某个项目"钉"在活跃区，即使 7 天没活动也不会被收纳
4. **"最近对话"段**：跨所有项目，取最近 8 条活跃 thread，不按项目分组，提供快速触达
5. **活跃项目区内部排序**：pinned 项目在前，其余按最新活动时间排序（稳定排序，不漂移）

数据模型变更：
- 新增 `projectPinned: boolean` 字段（localStorage 存储，不需要后端）
- "最近对话"段：纯前端计算，取 `threads.sort(lastActiveAt).slice(0, 8)`
- "活跃项目"判断：纯前端计算，基于 threads 的 `lastActiveAt`

### Phase C: 新建对话增强 ✅

改善创建 Thread 的体验。

1. **Modal 增大**：当前 `max-w-[640px]` 够用但布局需优化
2. **Thread 命名**：新建时可填 title（可选，不填则后端自动生成）
3. **关联 Feat**：下拉选择 BACKLOG 中的活跃 feat，写入 thread metadata
4. **创建后置顶选项**：checkbox "创建后置顶"
5. **最近项目优先展示**：项目列表按最近活跃排序，不再纯字母序

后端变更：
- `POST /api/threads` 已支持 `title`，补 `backlogItemId` 和 `pinned` 入参
- 新增 `GET /api/backlog/active` 返回活跃 feat 列表（供下拉选择）

### Phase D: 软删除 + 回收站（终态数据安全）✅

**沉痛教训**：team lead误删 `thread_mmlv4v2oq6dxefr6`（73 条审计记录，cross-thread-sync 教训 thread），不可恢复。
Phase C hotfix 加了确认弹窗 + 审计事件（PR #378），但确认弹窗是**脚手架**，终态是**软删除 + 回收站**。

1. **软删除**：`DELETE /api/threads/:id` 改为标记 `deletedAt` 时间戳，不物理删除数据
2. **回收站 UI**：Sidebar 底部"回收站 (N)"入口，展示已删除 thread 列表
3. **恢复操作**：回收站内可一键恢复 thread（清除 `deletedAt`，所有关联数据恢复可见）
4. **自动清理**：`deletedAt` 超过 30 天的 thread 才执行物理删除（定时任务或惰性清理）
5. **已删除 thread 不出现在正常列表**：`GET /api/threads` 默认过滤 `deletedAt != null`

数据模型变更：
- Thread interface 新增 `deletedAt?: number`（时间戳，null = 未删除）
- ThreadStore.delete() → ThreadStore.softDelete()（设 deletedAt）
- 新增 ThreadStore.restore(id)（清除 deletedAt）
- 新增 ThreadStore.purge(id)（物理删除，仅回收站 30 天后或手动）
- GET /api/threads 新增 `?deleted=true` 查询参数（回收站列表）

### Phase E: 滚动位置稳定性（Bug Fix）✅

活跃 thread 上浮重排时，用户当前浏览位置不应跳动。

1. **scrollTop 保持**：thread 列表重排前记录 scrollTop，重排后恢复到相同视觉位置
2. **用户浏览时延迟重排**：如果用户正在手动滚动（或最近 2s 内有滚动操作），defer 重排到用户静止后
3. **当前查看位置锚定**：重排后，用户正在看的那块内容不移动

### Phase F: Project Context Menu + 快速新建 ✅

参考 Codex App 的项目管理体验（team lead截图 2026-03-27）。

1. **Project 右键菜单**：在项目名称上右键（或长按/hover 出按钮）显示 context menu
   - **Open in Finder**：打开项目对应的本地目录
   - **Edit name**：inline 编辑项目显示名称（Enter 确认 / Esc 取消）
   - **Archive threads**：归档该项目下所有 thread（复用 Phase D 软删除机制）
2. **快速新建 Thread 按钮**：项目名称旁的小图标，点击在该项目下直接新建 thread（跳过项目选择步骤）

### Phase G: 系统级 Thread 分类 + 删除保护 ✅

IM Hub 连接器等系统级 thread 需要专属管理，不应丢到"未分类"。

1. **系统级 Project 分类**：sidebar 新增"系统"分区（位于置顶区下方），IM Hub 连接器 thread 自动归入
2. **系统 thread 标识**：thread metadata 新增 `systemLevel: boolean`，IM Hub 创建的 thread 自动标记
3. **删除保护**：系统级 thread 不显示删除按钮；如需强制删除，要求打字输入 thread 名称确认（类似 GitHub 删除仓库的确认方式）

## Acceptance Criteria

### Phase A（折叠持久化 + 搜索可见性）
- [x] AC-A1: 展开/折叠某分组后刷新页面，保持上次的展开/折叠状态
- [x] AC-A2: 多个分组可以各自独立记忆状态
- [x] AC-A3: 首次访问（无 localStorage 记录）时保持默认全部折叠
- [x] AC-A4: localStorage key 有命名空间前缀（如 `cat-cafe:sidebar:`），不与其他功能冲突
- [x] AC-A5: 搜索时匹配 thread 所在分组强制展开（忽略折叠状态）
- [x] AC-A6: 切换 thread 时目标分组自动展开
- [x] AC-A7: "全部展开/全部折叠"按钮可用

### Phase B（活跃工作区）
- [x] AC-B1: Sidebar 展示"最近对话"段（跨项目，≤8 条，按 lastActiveAt）
- [x] AC-B2: 项目分为"活跃项目"和"其他项目"两个区域
- [x] AC-B3: 近 7 天无活动的项目自动收纳到"其他项目"
- [x] AC-B4: 用户可 pin/unpin 项目到活跃区（localStorage 持久化）
- [x] AC-B5: 活跃区内 pinned 项目在前，其余按最新活动时间排序
- [x] AC-B6: "其他项目"折叠区点击可展开完整列表
- [x] AC-B7: 50 个项目时 sidebar 仍然可用（活跃区仅展示 3-5 个活跃项目）

### Phase C（新建对话增强）
- [x] AC-C1: 新建对话时可填写 thread title
- [x] AC-C2: 新建对话时可从下拉选择关联的活跃 feat
- [x] AC-C3: 新建对话时可勾选"创建后置顶"
- [x] AC-C4: 项目列表按最近活跃排序（不再纯字母序）
- [x] AC-C5: 后端 `POST /api/threads` 支持 `backlogItemId` 和 `pinned` 入参

### Phase D（软删除 + 回收站）✅
- [x] AC-D1: DELETE /api/threads/:id 改为软删除（设 deletedAt，不物理删除）
- [x] AC-D2: 软删除后 thread 从正常列表消失（GET /api/threads 过滤 deletedAt）
- [x] AC-D3: 新增 GET /api/threads?deleted=true 返回回收站列表
- [x] AC-D4: 新增 POST /api/threads/:id/restore 恢复已删除 thread
- [x] AC-D5: Sidebar 回收站入口，展示已删除 thread 列表 + 恢复按钮
- [ ] AC-D6: deletedAt 超过 30 天的 thread 自动物理清理 — **延后**（需 cron 基建，team lead确认后续再做）
- [x] AC-D7: 级联数据（messages/tasks/memory）在软删除期间保留，物理删除时才清除

### Phase E（滚动位置稳定性）✅
- [x] AC-E1: 活跃 thread 上浮重排时，用户当前滚动位置不发生跳动
- [x] AC-E2: 用户正在手动滚动时，thread 列表不因重排打断浏览（锚定补偿机制）
- [x] AC-E3: 重排完成后，用户正在看的内容仍在原位可见

### Phase F（Project Context Menu + 快速新建）✅
- [x] AC-F1: 项目名称右键显示 context menu（Open in Finder / Edit name / Archive threads）
- [x] AC-F2: Open in Finder 打开项目本地目录
- [x] AC-F3: Edit name 可 inline 编辑项目显示名称（Enter 确认 / Esc 取消）
- [x] AC-F4: Archive threads 将项目下所有 thread 软删除（复用 Phase D 机制）
- [x] AC-F5: 项目名称旁有快速新建 Thread 图标按钮
- [x] AC-F6: 快速新建跳过项目选择，直接在目标项目下创建 thread

### Phase G（系统级 Thread 分类 + 删除保护）✅
- [x] AC-G1: Sidebar 有"系统"分区，IM Hub 连接器 thread 自动归入
- [x] AC-G2: 系统级 thread 有视觉标识区分（图标/标签）
- [x] AC-G3: 系统级 thread 删除需打字确认保护（GitHub 模式：按钮可见 + typed confirm）
- [x] AC-G4: 后端强制保护：DELETE /api/threads/:id 对系统 thread 需 ?force=true

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "能够记录我是不是展开或者默认折叠" | AC-A1~A4 | test + manual | [x] |
| R2 | "默认折叠" | AC-A3 | test | [x] |
| R3 | 搜到了但分组折叠看不到（Maine Coon发现） | AC-A5 | test | [x] |
| R4 | "我想用的 cat cafe 在这么下面" | AC-B1~B5 | screenshot | [x] |
| R5 | "如果后续我们有 20 个项目 50 个项目怎么办" | AC-B2~B7 | test + screenshot | [x] |
| R6 | "我可以填写他的 thread 名字" | AC-C1 | test + manual | [x] |
| R7 | "甚至直接关联某个 feat" | AC-C2 | test + manual | [x] |
| R8 | "我可以选择直接置顶" | AC-C3 | test + manual | [x] |
| R9 | "新建的那个窗口可能需要大点" | AC-C4 | screenshot | [x] |
| R10 | team lead误删 thread 不可恢复（沉痛教训） | AC-D1~D7 | test + manual | [x] |
| R11 | "面向终态开发"——确认弹窗是脚手架，软删除才是终态 | AC-D1 | test | [x] |
| R12 | "翻了半天之后你们一往上移我啥东西又没了"（滚动 bug） | AC-E1~E3 | manual | [x] |
| R13 | Codex App 参考：Open in Finder / Edit name / Archive threads | AC-F1~F4 | manual | [x] |
| R14 | Codex App 参考：项目旁快速新建 Thread 按钮 | AC-F5~F6 | manual | [x] |
| R15 | "IM Hub 得在最左边收录到系统级的 thread 里面" | AC-G1~G2 | manual + test | [x] |
| R16 | "系统级 thread 不能支持用户删除或者要打字确认" | AC-G3~G4 | manual + test | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Related**: 无直接依赖，ThreadSidebar 现有组件改造
- Phase C 后端需 `GET /api/backlog/active` 新接口

## Risk

| 风险 | 缓解 |
|------|------|
| localStorage 不可用（隐私模式等） | try-catch 降级为不记忆，不影响功能 |
| "活跃项目"阈值 7 天不合适 | 可配置化（localStorage），但先用 7 天验证 |
| "最近对话"和"置顶"有重叠显示 | 置顶 thread 不出现在"最近对话"段（去重） |
| Phase C feat 下拉需要后端接口 | 可先纯前端 hardcode，后端接口做为增强 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 从"折叠记忆"扩展为"导航体验升级" | team lead要求面向 50 项目终态设计（家规 P1） | 2026-03-11 |
| KD-2 | 用"活跃工作区"替代"分组置顶排序" | 排序解决不了 50 个项目的问题，核心是"只展示活跃的" | 2026-03-11 |
| KD-3 | V1 不做拖拽排序 | DnD 实现/可访问性成本高，pin + 自动收纳已覆盖 80% 场景 | 2026-03-11 |
| KD-4 | 项目 pin + 活跃判断均为纯前端 localStorage | 避免后端复杂度，sidebar 偏好是 per-device 的 | 2026-03-11 |

## Review Gate

- Phase A: Ragdoll实现 → Maine Coon review
- Phase B: Design Gate（前端 UX → team lead确认 wireframe）→ Ragdoll实现 → Maine Coon review
- Phase C: Design Gate（前端 UX → team lead确认 wireframe）→ Ragdoll实现 → Maine Coon review

## Known Issues (Post-completion)

| # | Issue | 优先级 | 描述 |
|---|-------|--------|------|
| I-1 | ~~删除 Thread 无二次确认~~ | ~~**P1**~~ | ✅ **已修复** (PR #378)：前端加确认弹窗（显示 thread 标题 + 不可恢复警告）。注意：仍为硬删除，软删除 + 回收站为后续增强。 |
| I-2 | ~~Thread 删除无审计事件~~ | ~~P2~~ | ✅ **已修复** (PR #378)：新增 `THREAD_DELETED` 审计事件，记录 deletedBy / threadTitle / projectPath。 |
| I-3 | Header 无线程标识 | P2 | ✅ **已修复** (PR #378)：ChatContainerHeader 显示当前 thread 标题 + 项目名，大厅显示"大厅"。 |
| I-4 | 仍为硬删除，无软删除/回收站 | P2 | 后续增强：soft delete + 30 天回收站。当前已有确认弹窗 + 审计兜底。 |
