---
feature_ids: [F226]
related_features: [F063, F190, F195, F102, F139, F160]
topics: [presentation, demo, workspace, floating-surface, ux]
doc_kind: spec
created: 2026-06-06
---

# F226: Presentation Surface / Demo Mode

> **Status**: Phase A merged (#2126) + 尺寸快捷 enhancement merged (#2131, operator dogfood 验收满意) | **Owner**: Ragdoll Opus-4.8 | **Priority**: P1

## Why

operator做华为 AutoHarness 这类汇报时，演法是：右侧 workspace 打开 PPT 图/文档当"讲解地图"，左侧动态切真实证据（thread / chat / Memory Hub / Eval Hub / commit / PR）。**痛点**：右侧 workspace 是**单一格子**，PPT 和"毛线球（任务）、定时任务、记忆系统"全挤在同一个位置轮流显示——一切证据，PPT 当场被顶掉，演示流被打断。

> operator experience（2026-06-06）：
> - "我想给大家展示我们的毛线球，比如说定时任务、记忆系统，**这些其实也都在右边呢，和 workspace 一个位置**"
> - "这个右边的 workspace **可以变成漂浮窗口，然后能回归回去**"

**价值**：让operator演示时能把**文件/md 文档抽成浮窗常驻**（operator的"PPT"本质就是 md 讲稿），右侧 docked 生态位就腾出来、可以切 mode tab 展示记忆/定时任务/毛线球给观众看真实功能——**文件浮窗 + 右侧切证据两者并存**，讲完**回归归位**，演示流全程不被打断，且有清晰退出，普通使用不被布局困住。

> operator精确化（2026-06-06 + 截图）：浮的对象是**文件/md**，**不是**让记忆/定时/任务浮。后三者本就在右侧 mode tab 展示，问题是「5 个 mode tab（开发/记忆/定时/任务/社区）挤同一生态位互斥——切到定时任务就没法同时看 md」。解法 = 把 md 拎出来浮着，生态位让给其他 tab。

## Current State / 现状基线

实测代码证据（2026-06-06，Ragdoll + Maine Coon双猫核实）：

- **右侧是单格子双层状态**：`rightPanelMode: status|workspace|transcript` + `workspaceMode: dev|recall|schedule|tasks|community`（`chatStore.ts`）。PPT(dev)、记忆(recall)、定时任务(schedule)、毛线球(tasks)、社区(community) 共享同一右侧格子，由 `WorkspacePanel.tsx:714-815` 的 mode 按钮**原地轮换**，互相替换。
- **F063 Presentation Lock 已存在但跨路由失效**：它锁 workspace 内容、切 thread 时保持（已测），但 `WorkspacePanel` 经 `ChatContainer` 挂在 `(chat)/layout.tsx`，**只在 `/` 和 `/thread/*` 内存活**。切到 `/memory`、`/mission-hub`、`/settings`(Eval Hub) 等全屏独立路由时，`(chat)` layout 整个卸载 → `WorkspacePanel` 从 DOM 消失（`AppShell.tsx:42,64` + `(chat)/layout.tsx:15-21`）。
- **F195 FloatingTranscriptWindow 是技术先例**：已用 `react-rnd + portal(document.body)` 做可拖拽浮窗，但同样挂在 `ChatContainer` 下 → 同样无法跨路由存活。可复用其技术路线，但 host 层级必须上提。
- **F102 历史约束**：完整 Memory Hub 已从 workspace mode 升为 `/memory` 一级页面，workspace 只保留 Recall Feed。**本 feature 不得把 Memory Hub 塞回右栏**；证据区继续用一级页面。

## What

### Phase A: Floating Presentation Surface Host（MVP — 文件/图片/PPT 图）

- 新增 **AppShell/root 级 `FloatingPresentationSurfaceHost`**，mount 在 `(chat)` route group **之上**、在 `WorkspacePanel` **之外**——无论 ① 切 workspace mode tab（开发→定时/记忆/任务，主场景）还是 ② 切全屏路由（`/memory` 等）都**不卸载**（KD-1）。
- 新增全局 `presentationSurface` 状态：`{ placement: 'docked'|'floating', content: fileSnapshot{worktreeId, filePath, tabs?, fileKind, renderMode:'rendered'|'raw', line?, scrollTop?, title}, pos{x,y}, size{w,h}, minimized }`，挂全局 store，不绑 `(chat)`。**snapshot 限文件相关字段、不带 `workspaceMode`**——否则实现者可能意外把 recall/tasks/schedule 也做成可浮，破坏 KD-4 边界（Maine Coon P2）。
- **回坞/关闭契约**（核心流程，Maine Coon P1）：`dock back` = 把 docked workspace 切回 `dev` mode + 恢复浮窗文件快照（worktreeId/filePath/tabs/renderMode/line/scrollTop）；`close`/`minimize` **不改**当前 docked mode——演示时 docked 可能正停在「定时任务」，收回讲稿浮窗不该把它踢回 dev。
- **tear-off content snapshot**（KD-2）：detach 时把当前右侧内容**快照成浮窗副本**，docked workspace **保留**——右侧格子仍可切 dev/recall/schedule/tasks/community。不是搬走唯一 panel。
- 拖拽/resize/回坞复用 `react-rnd`（F195 先例）。
- 入口：`WorkspacePanel` header 的 detach 按钮（F063 锁按钮旁）+ **全局召回开关放 ActivityBar**（跨路由可见，在 Memory Hub 时也能召回/收起浮窗）。
- 退出：dock back 按钮 + `Esc`。

### Phase B（非本需求，记录边界）: 其他 mode 不浮

- operator 2026-06-06 明确：**记忆/定时任务/毛线球不需要浮窗**。它们在右侧 docked mode tab（开发/记忆/定时/任务/社区）正常展示即可——浮的只有文件/md，目的就是把文件腾出生态位、让 docked 能切去展示这些 mode。
- 仅当未来出现「多份内容同时浮」的新需求再评估，**非本 feature scope**。

### Phase C（评估）: F063 lock 语义合并 + terminal/browser detach

- MVP 稳定后评估把 `presentationLock` 合并入 `presentationSurface`（KD-5 暂不拆）；terminal/browser 活动会话（socket/iframe/local state）detach 迁移可行性。

## Acceptance Criteria

<!-- 立项愿景硬度自检：每条 AC ① trace 回 Why ② 非作者可复核。scope 已定（只浮文件/md，不含其他 mode）；仅「如何讲 show」OQ-4 待讨论，不影响 AC。 -->

### Phase A（Floating Presentation Surface Host）
- [x] AC-A1: 演示时可把文件/md tear-off 成浮窗，**右侧 docked 生态位腾出、可自由切 mode tab（记忆/定时/任务）展示**，文件浮窗与 docked 内容并存（trace Why「讲稿+活功能并排」；复核：手动 + 组件测试）
- [x] AC-A2: 浮窗在 ① workspace mode tab 切换（开发→定时/记忆/任务，主场景）② 切全屏路由（`/memory` 等）时都**不卸载、保持可见**（trace Why「切证据时讲稿不消失」；复核：mode 切换 + 路由切换测试断言 host 存活）
- [x] AC-A3: 浮窗可拖拽 / 缩放 / 最小化 / **回坞 dock back**，清晰退出（`Esc` + 按钮）。**回坞契约**：dock back 切 docked 回 dev + 恢复文件快照；close/minimize 不改当前 docked mode（trace Why「演示中 docked 停在定时任务，收回讲稿不该踢走该视图」；复核：组件测试覆盖 docked=schedule 时 dock back / close 两条路径）
- [x] AC-A4: **不破坏**现有 workspace navigation 和 F063 presentation lock（复核：thread-switch lock 回归测试行为不变）
- [x] AC-A5: 关键状态切换有前端测试覆盖：host 跨路由 survival / 单浮窗 / no double `WorkspacePanel` mount / dock back / z-index·bounds·Esc / responsive smoke

## Dependencies

- **Related**: F063（Hub Workspace Explorer + presentation lock 母题）、F195（floating transcript react-rnd+portal 技术先例）、F102（Memory Hub 一级页面约束）、F190（Console settings / Eval Hub 承载）、F139（Schedule mode）、F160（Tasks / 毛线球 mode）

## Risk

| 风险 | 缓解 |
|------|------|
| 浮窗内容快照与 docked 状态不同步 | tear-off 时单向快照，MVP 不做双向回写 |
| Memory/Mission Hub 被压窄 responsive 崩 | 浮窗方案天然规避——Hub 仍全屏，浮窗只叠加层（不分栏） |
| react-rnd z-index 与现有 Modal/Lightbox 冲突 | 统一 z-index 层级 token 管理 |
| host 误挂在 ChatContainer 下 → 跨路由仍卸载 | KD-1 硬约束：host 必须在 AppShell/root；补 e2e 路由切换 survival 测试 |
| terminal/browser 活动会话 detach 成本高 | MVP 只支持只读展示类，会话类 defer 到 Phase C |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 浮窗 host 必须 mount 在 AppShell/root 层，不在 ChatContainer 下 | `createPortal` 只改 DOM 插入点、不改 React owner 生命周期；跨路由存活由 host 层级决定（Maine Coon纠正Ragdoll误判） | 2026-06-06 |
| KD-2 | tear-off content snapshot，docked workspace 保留 | operator要「两份同框」（PPT 浮 + 右侧切证据）；搬走唯一 panel 会让右侧空掉 | 2026-06-06 |
| KD-3 | 开新 F 号，不挂 F063 Phase | 跨 AppShell / rightPanelMode / workspaceMode / F195 / F102 / F139 / F160 六域，挂 Phase 会模糊 F063 边界（operator signoff） | 2026-06-06 |
| KD-4 | 浮窗对象 = 文件/图片/md（PPT 本质是 md）；记忆/定时/任务用 workspace docked mode tab 展示，不浮、不需全屏路由 | operator精确化 + 截图：演示在 workspace panel 内切 mode tab，浮 md 腾生态位即满足。用的是 workspace recall mode 不是完整 Memory Hub，不违反 F102 | 2026-06-06 |
| KD-5 | F063 暂不拆，新增 `presentationSurface` 并存 | 不破坏已测的 thread-switch lock，MVP 稳后再评估合并 | 2026-06-06 |

## Review Gate

- Phase A: 前端实现 → Maine Coon跨族 review（工程 + 测试覆盖）+ Siamese/gemini25 UX 守护
