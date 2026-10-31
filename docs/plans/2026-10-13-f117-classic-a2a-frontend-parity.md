---
feature_ids: [F117]
related_features: [F264, F269, F322]
topics: [a2a, frontend, classic, migration, receipt, queue]
doc_kind: implementation-plan
created: 2026-10-13
updated: 2026-10-13
---

# F117：develop_base 的 A2A 前端调整与 #1398 旧版补齐清单

本清单先解释已经存在的能力，再定义当前缺口。**当前只补齐 classic 旧前端；旧版体验确认后，再调整 v2 新前端。** develop_base 是旧版布局与视觉参照，不是把旧实现整文件覆盖回最新 main 的来源。

## 1. 比较坐标与证据范围

| 对象 | 精确提交 | 用途 |
|---|---|---|
| 原公开共同基线（#1577） | `3e70e1d6805be24672e8f841861f180d20b184c2` | 识别 develop_base 的后续改动；也是 develop_base 与 #1584 main 的 merge-base |
| 运行目录 develop_base，只读 | `7adb57dfa6cfa3465e3a009a67b48f0cc44d23c6` | 旧前端实际代码与已接受的 A2A 交互参照 |
| #1584 合入后的 main | `0fc7e37473395a080a0463fac11c22310391ec42` | 当前 #1398 重建基线 |
| 已审、已发布的 #1398 | `6bce64e77d04ac1a8224475439a6a7d039844dab` | 本清单审计对象，尚未包含本轮 UI 修复 |

实际 read-only 对照目录分别为 `cat-cafe-develop-base` 与 `cat-cafe-1398-merged-baseline`。两者属于不同 Git 仓库，比较前在候选仓库只读导入了 develop_base 的精确 commit 对象；没有更改运行目录、配置或进程。

develop_base 的相关历史包含 fork #217（原 F117 接入）、#218（目标引导能力与重启回流）、#219（跨 thread 与 Codex 已读）、#220（能力提示、错误呈现与终态交接）、#224（共同投递与 Redis／preparing-run 修正）。#222／#223 和对应 revert 不是另一套需要恢复的前端机制。

范围是输入／策略、Queue／Steer、source／response、追加输入／回执、执行状态与颜色等 A2A 用户路径及其定向测试。原共同基线到 develop_base 有 449 个 Web `src` 路径变更；这个数量包含混入的其他前端工作，**不等于 449 项 A2A 改动**。本清单不是全部 Web diff 的逐文件搬运清单。

原始需求位于 `thread_msr51149hym0i79f`：

- `0001789632701627-000557-7561512a`：发送策略只保留持久偏好，不再加“仅这一次／恢复继承／入队说明”。
- `0001789630806333-000545-adc349e0`：Steer 默认策略与目标引导能力的边界；当前运行状态不另造偏好。
- `0001791788596790-000350-bd2cd477`、`0001791790207880-000395-0d216bfe`：A/B 姓名语义不同，只统一状态与发生时间，B 侧保留正文。
- `0001791856574961-001444-f2da7ef0`：菜单、气泡标签、点击展开与来源圆点的实测问题。
- `0001791856653691-001448-2bb44573`：页头重复执行提示。
- `0001791856688634-001449-5ea6f740`、`0001791856707628-001450-7cee477b`、`0001791856981952-001457-5ace39c0`：以 develop_base 旧版为参照，先成文、先修旧版，再处理新版。

记忆检索仅用于定位旧决策；一次 hybrid thread 检索降级为 lexical，不能据其有限结果宣称完整历史。结论以精确 Git 版本、组件源码、已读原话和本轮截图为准。

## 2. 两种前端展示，共用一套 A2A 事实

两种展示位于同一个 `packages/web`，不是两套独立的 A2A 后端或状态账本。`AppShell.tsx`／`shell/shell-presentation.ts` 通过 classic／v2 选择展示；`ChatContainer`、`ChatInput`、`ChatMessage` 等有共享组件与展示分支。

classic 应对齐 develop_base 的旧版空间关系、菜单布局与既有操作。v2 保留 #1584 的导航、版式、主题 token 与阅读位置能力，本阶段不重新设计它。共享组件可以增加明确的 presentation 分支；数据消费、权限和投递事实仍只有一个契约。

数据契约以 [F117 主文档](../features/F117-message-delivery-lifecycle.md) 为准：Queue 是尚待投递工作，History 是已发生事实；投递、执行归属、原生已读证据互不代替。

### 后端能力合并边界（operator 再确认）

classic／v2 是展示分支；旧版保留 develop_base 的布局与既有操作，随后再补新版展示。共享组件应围绕 presentation 分支承载这两种布局，不让 main 的新版摆放规则覆盖旧版，也不建立两份业务状态。后端继续以 #1398 的共同 send、单一 Queue、History 和精确原生读取证据为准；同步 main 是迁入新增能力的消费者，不是换回旧 A2A 状态机。

| 已核对的业务能力族 | #1398 的承接边界 | 已有源码／验证锚点 |
|---|---|---|
| 用户、成员、外部入口与 SDK 输入 | 共同准入，冻结 target／intent／audience；相同 ID 重放保持原身份 | `InvocationQueue.send`、`PersistedQueueDelivery`；`a2a-1577-sdk-input-seam`、producer-category、message-scope |
| 修改请求、工作 producer、调度与部署通知 | 原业务 authority 保留，投递通过同一适配器；队列退休后消费持久事实 | modification-source、work-producer、deployment-publication、scheduler、refusal seams |
| Collective 与插件来源 | structured source 与精确 caller／owner／thread 边界；不以 transport 标签代替授权 | collective-reconsideration、hold-consumer、action-history seams |
| 私密媒体回流及追加 | 复用持久 TurnExecution 见证，public input／reply／causal 不挂私密 ID，内部读取与结算保留 | 私密 witness／callback／Append／store reopen／nonrecipient play 回归与独立复核 |
| 历史、上下文、全文 drill、搜索与 Live inbox | 从持久消息与独立读取回执投影；执行归属／完成不冒充已读 | document、message-drill、thread-context、live-inbox、observational-projection seams |

以上是对 main 消费者和 #1398 既有职责的接线核对，不是宣称整个 main 的所有功能均已真实体验，也不表示表中每项都是 main 新增。私密执行见证是媒体消费者迁入共同执行记录时的接线缺口；Append 公开引用过滤和 terminal settlement 本来就是 #1398 的职责，实际私密验收揭示了自身实现遗漏，已分别复用共同投影与现有内部精确绑定修正。这两项不是 main 特有的新能力，不新增投递机制、隐私账本或补偿层。#1587 只有 Web 变更，本次头部／工具栏修复也不改 API/shared/MCP。旧原生记录保持各自 SHA；Claude、真实媒体生成、最终组合运行、历史／混合版本、rollback／off-mode 与 operator／soak 继续按版本报告未验范围。

## 3. develop_base 已做的调整，以及 #1398 的保留情况

以下路径均相对仓库根目录。表中的“已保留”是代码对照结论，不是本轮完整 UI 体验通过结论。

| 用户路径／能力 | develop_base 的调整 | #1398 当前情况与处置 | 代码锚点 |
|---|---|---|---|
| 输入入口 | “+”菜单承载引用、附件、发送策略、悄悄话、游戏；策略作为普通菜单项 | 能力保留，classic 菜单布局和浮层样式有差异，需补齐 | `ChatInputAddMenu.tsx`、`ChatInput.tsx` |
| 持久发送偏好 | “排队等待／引导当前回复”；“本 Thread／全局默认”两层 | 已保留；不搬回“仅这一次／恢复继承”或重复说明 | `MessageDispositionSelector.tsx`、`useMessageDispositionPreference.ts` |
| 引导能力 | 输入框根据正在工作的成员及其 `guideReply` 能力提示可引导目标 | 已保留能力判断；仅调整 old shell 展示，不新增前端投递决策 | `ChatInput.tsx`、`message-disposition-presentation.ts` |
| Pending 与 History | 未投递用户／外部输入只在 Queue；实际投递后显示原消息与固定 response | 已保留新契约；不得恢复队列、inbox、乐观消息的第二份业务状态 | `QueuePanel.tsx`、`chatStore.ts`、`message-timeline.ts` |
| Queue 操作 | 撤回、排序、逐目标 Steer；等待原因不借用无关成员的活跃状态 | 已保留；由共同服务端投递／资格约束，刷新消费 canonical snapshot | `QueuePanel.tsx`、`QueueSteerDialog.tsx`、`SteerQueuedEntryModal.tsx` |
| source 身份 | 用户、成员、外部来源按结构化 `from` 显示姓名／头像；transport label 不充当作者授权 | 已保留；主题显示只改颜色角色，不改 actor 身份 | `resolve-sender.ts`、`SenderAvatar.tsx`、`ChatMessage.tsx` |
| source 下的成员头像 | 真实 `dispatchRefs` 导航到 exact response；pending 不制造 processing 头像 | 已保留；失败、终态、目标匹配仍从现有生命周期投影 | `MessageDispatchAvatars.tsx` |
| 首条／追加归属 | 收件成员的固定 response 接收首条和追加输入；空正文 processing 行后续原位升级 | 已保留；不增等待气泡、重复完成消息或“已接管即已读”状态 | `ChatMessage.tsx`、`PendingMemberBubble.tsx` |
| 追加输入列表 | response 下方显示来源、正文摘要、独立“跳到原文”；长文原位展开，较多条目可展开列表 | 已迁入，已有正文／列表展开逻辑；需复验实际测量和点击，修正来源主题圆点 | `AppendedInputReceipts.tsx`、`useMeasuredOverflow.ts` |
| 投递／读取提示 | 读取 exact source × target × response 的回执；读取时间来自 native receipt | #1398 已进一步统一双方状态与时间，首条 native read 和私密边界也已修复；不要覆盖成旧文案或旧已读推断 | `dispatch-receipt-display.ts`、`MessageDispatchAvatars.tsx`、`AppendedInputReceipts.tsx` |
| 引用来源标签 | 气泡顶部 ReplyPill 显示来源头像、姓名、摘要，点击跳回原消息 | 跳转仍保留；截断标签点击展开是本轮新补齐要求，不能误写成 develop_base 已有行为 | `ReplyPill.tsx`、`focusLineageMessage.ts` |
| 执行状态与 Stop | 输入框上方执行条显示成员、工作类型、计时及 exact 取消动作；ChatContainer 不再挂载页头 ThinkingIndicator | 执行条保留，但候选又挂回了页头提示，需恢复既有去重；不丢异常提示与取消动作 | `ThreadExecutionBar.tsx`、`thread-chat/ThreadExecutionLayer.tsx`、`ThinkingIndicator.tsx`、`ChatContainer.tsx` |
| 失败与终态 | partial body 与诊断属于原 response；空 Queue 不是另一个全局“调用失败”状态 | 保持 #1398 的统一错误／终态呈现；局部错误不搬成整条 thread 的兜底状态 | `ChatMessage.tsx`、`CliDiagnosticsPanel.tsx`、`QueuePanel.tsx` |
| 多 thread／刷新 | source／response 引用、Queue、活动执行按 thread 取权威快照；刷新不重派历史输入 | 保持共享 data path；classic 和 v2 可以有不同布局，不能各自重建运行事实 | `useThreadMessages`／`useThreadLiveness`、`activeExecutionStore.ts`、`thread-chat` |

### 双方 tooltip 的已定边界

| 状态 | A 侧（source 下的接收者） | B 侧（response 下的来源） |
|---|---|---|
| 已投递 | `已投递 B · 时间`，不加正文 | `已收到 A · 时间`，保留 A 的正文 |
| 已读 | `已读 B · 时间`，不加正文 | `已读 A · 时间`，保留 A 的正文 |

同一条 source×target dispatch 的两侧取同一份状态、同一投递／读取发生时间。姓名分别表示接收者与发送者；不能为了共用组件统一成同一个姓名。首条消息也仅在实际 native 读取事件发生后变成已读；启动、ready、ACK、接管和终态都不是读取证明。

## 4. 本轮旧前端缺口与补齐方式

### C1：输入框“+”菜单

**实际差异**：develop_base 使用旧版圆角纸面菜单，顺序为引用 → 附件 → 发送策略 → 悄悄话 → 游戏，策略标题为“发送策略”、副标题显示当前选择。候选把策略移到顶部、增加“添加”分区，并让 classic 也使用 `ComposerPopover` 的 v2 shell token。

`--shell-paper`／`--shell-hairline-strong` 的展示作用域是 v2。classic 不应引用尚未定义的 v2 颜色，造成透明／默认黑色边框等错误。

**改法**：保留 portal 定位、外点关闭、ESC 和焦点处理；给 classic 使用旧版 cafe surface、圆角、阴影与原顺序。v2 保留当前菜单结构和 token。策略仍消费同一个持久偏好 controller。

**验收**：classic 与 develop_base 对照；五个入口仍可用；策略切换作用域、保存失败、键盘返回／关闭正常；窄屏菜单不越界。v2 抽样确认布局没被旧版修复改写。

### C2：气泡顶部来源标签的样式与点击

**实际差异／边界**：`ReplyPill` 当前只点击跳回原文，没有截断内容的展开操作；这在两个比较版本中都是现状。故“点击展开”是新的体验要求，不是已经迁入或仅因 rebase 丢失的能力。下方 `AppendedInputReceipts` 则已经有长文原位展开，需要独立复验，不能把两处控件混为一个。

**改法**：classic 收起标签对齐来源的主题色和旧版大小；截断摘要可点击展开／收起，展开内容独占下一行、左对齐并使用正文预览字号，避免挤压作者和时间。跳原文保留为独立动作。沿用真实 overflow 规则，短内容不制造空展开。v2 的既有来源标签与阅读动作在本阶段不重新设计。

**验收**：长／短／已删除来源，展开后全文可读且能收起，“跳到原文”定位 exact source；键盘能操作，不嵌套 button，不改变原消息或回执。

服务端 `replyPreview.content` 是短摘要，不能因控件变大就称为全文。展开态只从当前已授权 timeline 的唯一 exact parent 取正文；删除、撤回、重复绑定或其他 thread 的全局 store 不提供正文。原文尚未加载时只保留现有摘要与跳转，不借 transport 或调用者 ID 获得额外读取权限。v2 继续使用原摘要与直接跳转。

### C2b：作者行与消息操作条的完整旧版布局

operator 后续的两张实际截图指出 C1–C4 之外的遗漏：来源应在“轨迹”前；右侧三角是朗读控件，应位于消息操作条内，不能误认成来源展开。真实 develop_base `7adb57df` 的常用操作顺序为朗读 → 复制 ID → 引用 → 多选 → 分支 → 删除。

**改法**：仅 classic 作者行将来源排在轨迹前，将朗读交回现有 MessageActions 与同一 TTS singleton；常用条恢复以上顺序和分支图标。保留 main 新增的“更多”能力与原生轨迹入口，classic 的重复轨迹操作放在“更多”菜单内。v2 的 action overlay、nameplate、轨迹入口与生命周期事实不改。展开来源继续独占下一行，不挤压作者时间；不是整文件回滚到旧版。

**验收**：使用完整 ChatMessage + MessageActions 的组合验证头部顺序、TTS 的准确消息 ID／正文／成员、复制、引用、多选、分支、删除的排列，以及窄屏操作 sheet、更多轨迹和 v2 overlay。实际旧版页面须包含用户反馈的普通短来源消息，不只用长摘要证明展开。窄屏 sheet 的标题与操作行必须在正常文档流中上下排列，不复用作者行的绝对定位；常用按钮在较窄宽度换行，朗读及每个命中区域均不得被标题覆盖。迁移分析／代码回归不替代 operator 的实际体验确认。

### C3：追加消息圆点的来源主题色

**已查事实**：追加行目前传递 `resolveMessageSender(...).color` 的原始配置色。经典消息导航和执行条已有 source/member 的 CSS theme token。主题调节后的颜色可能不同于原始 hex；用户截图中 co-creator 的追加圆点与其显示主题色不同。

**改法**：classic 的人类来源用 `--color-cocreator-primary`，已知成员用其 `--color-{catId}-primary`；未知／外部来源保留其可靠来源色。颜色只表达是谁，不表达执行 target、运行状态或权限。不要取 response 接收者的颜色，不修改全部 sender resolver 的身份含义。

**验收**：人类 A → 成员 B、成员 A → 成员 B、未知来源；圆点随 A 的主题变化，不随 B 变化；刷新、明暗色一致；投递／已读与 pulse 继续由 exact receipt 决定。

### C4：页头重复的执行提示

**已查事实**：develop_base 的 `ThinkingIndicator.tsx` 文件还在，但其 `ChatContainer` 已不再挂载它；输入框上方执行条由 `ThreadExecutionLayer` 承载。候选在合入 main 的展示路径后又挂回了 ThinkingIndicator，导致截图中的“成员回复中 · thread · 实时回合”重复出现。v2 的该组件当前直接返回 null。

**改法**：恢复 develop_base 的 ChatContainer 挂载关系，保留输入框上方统一执行条和 Stop。不要因去掉本处重复挂载而全局删除 ThinkingIndicator 或其他布局仍需要的 timeout、silent／stall、诊断。检查异常信息仍在现有入口可达，不另建一个前端 `isRunning` 推断源。

**验收**：空闲无执行提示；普通运行只有一个主要状态位置；Stop 仍准确；异常／状态快照读取失败仍能获知真实限制；跨 thread 切换不借用别的 thread 的状态。

## 5. 已由 #1398 覆盖、不得借样式迁移恢复的内容

- 共同 send、持久原子准入和单一 Queue 的约束保留；不恢复 provisional admission、custody、rollback 或第二套 inbox／receipt 账本。
- pending Queue row 退休不意味着消息结果丢失。刷新／同 ID 重试读取持久事实；不要求已读之后 Queue row 仍在。
- 公开 response 不挂私密 source／return ID；内部 TurnExecution 与授权 owner 实录保留。修颜色、标签和展开时不得顺手把私密内容补进公开 receipt 列表。
- 不为“启动／收到／完成”增加新的已读状态；不新增读后重启拒绝或替换证明。
- 不恢复已删除的“仅这一次／恢复继承／入队说明”，不把恢复 UI 样式误变成恢复旧选择链。
- `ThinkingIndicator` 的普通重复提示不能算必须恢复的旧版特性；它是本轮应继续删减的展示冗余。

## 6. 实施顺序与验证文件

1. 用本清单核旧版路径和定向断言；实现 C1–C4 的 classic 分支，不改变后端。
2. 完成真实旧版操作：开菜单 → 选择／保存策略 → 发送／排队 → Steer／追加 → 点击长摘要与跳原文 → 查看同一回执 → Stop → 刷新。至少覆盖窄屏、明暗色和一个错误状态。
3. 共享组件变更抽样 v2，证明本阶段没有把新版换成旧版布局；不要求在本阶段重新设计 v2。
4. 冻结同一 worktree 后继、定向测试与真实页面证据后一次性交独立复核，更新原 #1398；再交 operator 体验旧版。
5. operator 确认旧版基础体验后，按其后续授权同步最新 main、重建 develop_base 并创建纳入 #1398 全部改动的 fork PR；随后另行处理 v2 的 A2A 展示。

定向测试入口（按改动选，不为文档跑全仓）：

- `chat-input-add-menu.test.tsx`、`chat-input-message-disposition.test.ts`：菜单与偏好。
- `ReplyPill.test.tsx`、`appended-input-receipts-render.test.tsx`：来源标签／正文展开与独立跳转。
- `1398-sender-identity.test.tsx`、`message-dispatch-avatars.test.tsx`、`delivery-response-ownership.test.tsx`：来源、回执、exact 归属。
- `thinking-indicator-v2.test.tsx` 与执行条／Queue 的相关测试：只去重展示，保留真实状态与操作。

组件级浏览器证明入口为 `packages/web/test/browser/classic-a2a-parity.test.mjs`。测试要求显式提供 `CLASSIC_A2A_PLAYWRIGHT_MODULE`（已安装的 Playwright ESM 模块）；需要复用本机浏览器时可提供 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。它拦截传输并验证真实组件与 CSS，不等于真实 native／后端验收，不依赖已退役的 `ppt-forge` 路径。

本文件是迁移分析与待实施清单，不是上述修复已完成的验收报告。冻结 #1398 的后端／私密边界绿灯、旧版基础体验和长期验收是不同证据，不能互相替代。
