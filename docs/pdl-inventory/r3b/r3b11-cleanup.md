# r3b11：删除与函数迁移清单（删除前记录）

基线：lang 已提交的 r3b10（97726a1a7e / dd892f6df9 / 7cdd25f700）。按本轮新决定，删除已由 PDL 替代且未挂载的旧画法；v2 样式和可复用组件保留。没有修改 .env、启动／停止正在运行的服务。

表中的 `src/` 路径均相对于 `packages/web/`。

## 1. 核查依据

用项目现有 TypeScript resolver 解析 src / worker / scripts 的静态、动态和 type import，按全部非测试 app / worker / scripts 入口追踪依赖；另用 rg 核对源码读取与测试 mock。它是一次盘点证据，不是新增 lint／约束层。

删除前找到 108 个不在这些入口可达范围的 JSX 文件；“不可达”本身不代表能力已迁移，未迁移、v2 共用、独立 frame、开发预览或混合测试关系不清楚的均保留。完整候选与直接宿主引用见 [cleanup-before.json](r3b11-cleanup-before.json)。

## 2. 本轮先删的清单

| 文件／用例 | 未挂载／未被宿主引用的依据 | 已替代的位置 |
| --- | --- | --- |
| src/components/audit/AuditExplorerPanel.tsx | 非测试入边只有未被入口使用的 audit/index.ts；PDL 没有引用。只作旧 AuditExplorer UI | PDL exec／Runtime 的真实会话详情；保留 SessionEventsViewer／SessionSearchTab 与原 owner 函数 |
| src/components/audit/AuditEventsTab.tsx | 入边只有上述旧面板和同一未使用 barrel；宿主不引用 | PDL 的通用记录行；原审计接口不删 |
| src/components/workspace/WorkspacePreviewOnly.tsx | 没有非测试入边；只有 workspace-focus-mode 的两个旧 JSX 用例 | PDL preview frame 与引擎投影；保留 BrowserPanel 的 v2 组件和预览业务函数 |
| src/components/audit/__tests__/AuditExplorerPanel.test.ts | 全部测试旧面板的 React 挂载／点击 | 删除对应组件时一同删除 |
| src/components/audit/__tests__/AuditEventsTab.test.ts | 全部测试旧审计页的 React 挂载／筛选 | 删除对应组件时一同删除 |
| routing-context-ownership.test.ts 首个 canonical Team renderer 用例 | 只读旧 WorkspacePanel / F307 的 JSX 拓扑；lang 本轮明确删除 | 现有 PDL runtime / Team owner 测试；同文件其余四个用例保留 |
| workspace-focus-mode.test.ts 的 WorkspacePreviewOnly describe | 只测试已删除 wrapper；同文件 FocusModeButton / WorkspaceFocusShell 用例保留 | 原 PDL preview / frame 测试 |
| f190-visual-contract.test.ts 的 AuditExplorerPanel 单独样式用例与该文件名条目 | 仅检查已删组件；其余 v2 样式检查保留 | 复制的组件库样式不变；相似度快照留到最后 |
| thinking-mode-toggle.test.ts 的 AuditExplorerPanel mock | 旧面板的空 mock，生产引用已无 | 删除无用 mock，不改 thinking 行为断言 |

删除 audit/index.ts 里对应两条 export，其它 export 保留。这里只删除列明的界面／专属测试，不删除 API、store 或 owner 校验。

## 3. 宿主复用函数／类型的迁移

每个符号只保留一份；所有使用者改 import，不在旧 UI 做兼容 re-export。仍使用这些符号的旧 v2 组件也读同一份非界面模块。

| 原 UI 位置 | 非界面位置／内容 |
| --- | --- |
| GovernanceInstaller / HubGovernanceTab | components/governance-operations.ts：真实发现、预览／确认 writer 和依赖 |
| EvolutionChangePanel | capability-evolution/evolution-change-commands.ts：sequence 命令、响应校验、canDecideChange |
| ProjectReviewPanel | video-project/screening-ui/project-review-read.ts：意见重新打开／operation receipt、未修改判定 |
| ExternalRuntimeSessionsPanel | runtime-sessions/external-runtime-session-format.ts：sessionMatchesFilter 与筛选类型 |
| InteractiveBlock / InteractiveBlockGroup | rich/interactive-message.ts：选项与分组消息格式化 |
| AppendedInputReceipts | components/message-dispatch-projection.ts：精确追加输入／已读投影 |
| HubQuotaBoardTab / quota-cards | hub-quota-refresh.ts 与 quota-data.ts：真实平台判定、DTO／额度归并／utilization |
| VoiceCompanionButton | components/voice-autoplay.ts：原 autoplay unlock |
| FeatureBirdEyePanel | mission-control/feature-id.ts：真实 feature tag 解析 |
| SessionEventRows / SessionChainPanel | audit/session-event-types.ts 与 session-chain-types.ts：原 owner DTO |
| rich/use-original-approval-read.tsx | lib/use-original-approval-read.ts：controller 间接复用的 canonical 读取 hook；旧 retained 卡片留在原 UI 文件 |
| HubAgentSessionsTab | components/agent-session-types.ts：同一真实 daemon DTO |
| InvocationTrajectoryDetail | trajectory/invocation-trajectory-model.ts：InvocationDetailResponse |
| ConsolePanel | workspace/usePreviewBridge.ts：ConsoleEntry 类型，和现有通道同处 |
| EvolutionAttributionPanel / EvolutionObservationPanel | 原 attribution validation / program projection 非界面模块：owner 投影类型 |

ThreadChatRuntimeProvider 与 ProjectDataBinding 是宿主数据 provider／无界面 owner 挂载点，保留；它们不画旧界面。

## 4. 本轮保留、还需后续核对

- 开发入口可达的旧组件、独立 frame 和 v2 的组件／CSS保留，不仅凭主区没有挂载就整树删除。
- 未完成绑定的成员设置、背景／主题、Mailbox、桌面升级、引导等旧界面先保留；它们不作为 PDL 的兼容兜底。
- TheaterReplayHost、旧导航壳及其混合 source／mock 测试，本轮先保留；需要逐项拆清业务入口与 v2 组件关系，不能仅凭 import graph 批量删除。
- 原候选中其余 105 个不可达 JSX 先保留，不认定都应删除。函数移出后，旧 VoiceCompanionButton 新增为不可达候选，因此结束时为 106 项；它仍有 v2 样式检查和旧 mock，先保留并列明。

## 5. 扩大检查后补充的删除前清单

- `f190-visual-contract.test.ts` 的旧 Chat page / AppShell 用例中的两条 `label=左侧对话栏`、`showLine=false` JSX 断言：AppShell 已是纯 PDL 宿主，HEAD 亦如此；这些布局元素已由原样 PDL 接管，不再适用。删除这两条和 AppShell 源码读取，保留同一用例对 v2 ThreadSidebar 背景的检查，标题随保留的内容改写。其它 v2 样式检查不删除。
- `routing-context-ownership.test.ts` 的 `COMPONENTS_ROOT` / `sourceFiles` 及相应 fs import：唯一使用者就是已获授权删除的 Team 拓扑用例，删除剩余无用辅助代码；其余四个 owner 用例不动。

这两项先记录，随后删除；不是按失败结果删掉其它检查。

## 6. 完成后的复核

- 删除清单中的 3 个 JSX / 2 个专属测试文件，以及列明的旧 JSX 断言／辅助代码均已删除；没有删除其它测试来规避失败。
- 20 组、48 个声明已移至非界面模块。原 UI 中对应声明为 0，目标中均只有 1 份；23 个函数体去格式／注释比较与 HEAD 完全相同。见 [cleanup-check](r3b11-cleanup-check.txt)。
- 生产宿主直接引用的含 JSX 文件只余 ThreadChatRuntimeProvider 与 ProjectDataBinding，均是数据 provider／无界面 binding。测试容器单列，不作为生产 UI。
- 结束时保留的 106 个静态不可达 JSX 与引用关系见 [cleanup-after](r3b11-cleanup-after.json)。v2 CSS／组件、开发入口、未绑定能力及独立 frame 的混合关系没有批量删除。
- 当前扩大检查仍有三项原有 v2 样式、四项旧 Inbox 结果文案失败，HEAD 复核亦失败，原文见本轮 README 第 4 节；这些检查保留。

运行时复核另剔除编译后会消失的 type import；入口可达的含 JSX 模块仅有宿主和 4 个数据 context／provider，没有旧界面卡片。详见 [runtime-dependencies](r3b11-runtime-dependencies.json)。这次复核发现的 canonical 读取 hook 已移出混有旧卡片的模块，旧卡片保留给 v2。
