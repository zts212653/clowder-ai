---
feature_ids: [F227]
related_features: [F114, F102, F192, F095, F057, F187, F225]
topics: [memory, observability, harness, magic-words, navigation, cognitive-state]
doc_kind: spec
created: 2026-06-06
---

# F227: Event Memory — 事件级记忆索引（拉闸记录）

> **Status**: in-progress | **Owner**: Ragdoll Opus-4.8 | **Priority**: P1
>
> 家里话：**拉闸记录**（有味道，家族感）。对外 / 正式 UI / 社区化：**Event Memory** / 校准事件 / Alignment Events。
> 产品内核：**事件级记忆索引**——不是"魔法词面板"，Magic Word 只是第一条 lane。

## Why

记忆系统缺了一层——**猫的认知状态变化不是一等公民**。

现有记忆三层各有主体：Session/Invocation 的主体是**工具调用**，Thread Digest 的主体是**话题**，Raw Message 的主体是**消息**。但"48 在哪 aha 了 / operator在哪拉了闸 / 坐标系在哪被纠正"——这些 harness 运行轨迹中**信息密度最高的认知转折点**（cognitive-state-transition），在系统里根本不存在。普通消息流信息密度低，"48 发现坐标系错了"才是黄金信号，而它没有一等公民的位置。后果：**连当事猫自己都回溯不了自己的认知轨迹**——F225 起源时，是operator人肉记得"那只猫是 48"，不是系统记得。

对外，这不是 demo 道具，也不只是 operator 仪表盘——这是 **AutoHarness（longform-004 二阶 harness / 飞轮）的可观测性层，飞轮的黑匣子 + 仪表盘**。没它，飞轮在转但你看不见转了什么；有它，每次转动可回溯、可度量。传统 APM（Datadog/Sentry）监控技术指标（延迟、错误率、崩溃）；Event Memory 监控**认知质量**——别人监控 agent 有没有报错，我们监控 agent 有没有**想对**。**你不可能卖一个"会自己改但你看不见它改了什么"的系统给企业。**

operator experience场景（2026-06-06，PPT 演示编排讨论）：想在台上说"我说过脚手架"然后**瞬间跳转到那个 thread 那条 message**——正是这个动作暴露了记忆系统的真空层。

## Current State / 现状基线

| 维度 | 当前真实状态（实测） |
|------|---------------------|
| 认知转折维度 | **不存在**。magic word 拉闸事件散落在 raw message 流，无索引、无法 filter、无法精确 teleport |
| Magic Word 真相源 | 已在 L0 家规注册（10 个词），是 single source of truth，但只用于运行时拉闸，无历史事件视图 |
| 跳转能力 | generic `teleport(threadId, messageId)` MCP **缺失**；但 web 侧已有 message 级基座：`scrollToMessage(messageId)`（`scrollToMessage.ts:6`）+ cross-post scroll substrate `findCrossPostTargetMessageId`（`crosspost-scroll-target.ts:27`，F052/F194）。⚠️ `cat_cafe_workspace_navigate` 是 **repo file/dir reveal/open 工具**（schema 仅 `path/action/worktreeId/line`，`hub-action-tools.ts:26`），**不是** message navigation，不可当扩展点 |
| 认知轨迹回溯 | 当事猫无法回溯自己的认知轨迹。F225 活案例：起源靠operator人肉记忆"那只猫是 48" |
| 趋势/闭环度量 | 无。"拉了几次闸""骂完长出什么能力"无任何索引或度量 |

## What

> **5 条设计原则（贯穿全 Phase，KD 钉死）**：
> 1. 内核是 Event Memory（事件级记忆索引），不是 Magic Word 面板——Magic Word 只是第一条 lane
> 2. 核心 schema 字段是 **cognitive-state-transition**，不是 magic word
> 3. 两轨采集：人工拉闸（系统可检测）+ 猫自拉闸（**猫主动声明**，no-classifier 红线）
> 4. 系统是**小本本记录员**，不 push 猫；猫主动翻阅
> 5. v1 schema 面向 v5 终态——走在正确路上一层层叠，**不脚手架式叠**

### Phase A: Event schema（面向终态）+ 只读人工拉闸时间线 + teleport

- **Event schema（面向终态，一次定型）**：
  `{ type, trigger, cat, threadId, messageId, timestamp, summary, cognitiveTransition?, relatedHarness?, confidence }`
- 从已知 10 个 magic word **回扫历史消息**生成 event 索引（回扫范围/深度见 OQ-1）
- 轨道一检测策略（噪音过滤）：`magic word + @猫` = 高置信拉闸；`magic word + 自检指令` = 检查；magic word 出现在讨论家规/定义新词上下文 = 讨论非拉闸（低置信/不标记）；置信度高/中/低，低置信默认折叠
- 只读 timeline UI：倒序时间线 + filter by magic word / 事件类型；每条展示 日期 / 信号 icon / 当事猫 / 原话摘要 / thread / [跳转 →]；选中某 word 展示含义解释（从 L0 读）+ 使用次数 badge
- **`teleport(threadId, messageId)` 精确跳转**——**48 建议先独立做**：最小、独立有用、demo 全靠它。**复用** web 侧现成 message scroll 基座（`scrollToMessage` + cross-post `findCrossPostTargetMessageId`，含 thread 切换后 DOM 未渲染的 raf 重试语义），新增 generic teleport MCP + 路由把 `(threadId, messageId)` 接到该基座；**禁止扩展 `workspace_navigate`**（它是 repo file 工具，非 message nav）

### Phase B: 猫主动声明事件 + 跨 thread 聚合

- MCP tool `cat_cafe_mark_event(type, summary, evidence?)`：让猫**主动**标记转折点。系统只**索引**猫主动声明的事件，**不判断**哪条消息是 aha（no-classifier）。和 code-as-harness 哲学一致：与其训练分类器猜转折点，不如把转折点变成猫主动产生的 first-class 数据
- 跨 thread 重复诉求自动聚合（同一只猫多处说同一件事，如"到处喊要 clear session"）
- 面板展示两轨（人工拉闸 + 猫自拉闸），可 filter

### Phase C: Resolution 链 + 趋势度量

- 事件关联 harness 改动（commit / hook / skill / rule）——构成**闭环证据**：`拉闸多次 → 写入规则/hook/eval → 同类场景减少 → 猫自检出现`
- "骂完长出了什么能力"可视化——不仅记录"被骂了"，还记录"骂完长出了什么"
- 趋势视图，但**趋势不单独展示为"自进化有效"证据**，必须配 resolution 链（Maine Coon push back：频率下降可能是用户没说/任务少了/检测漏了）

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "想在台上说'我说过脚手架'然后瞬间跳转到那个 thread 那条 message"（operator experience）| AC-A4 | 15s 录屏端到端 teleport | [ ] |
| R2 | 内核是 Event Memory 事件级索引，不是 Magic Word 面板（Magic Word 只第一条 lane）| AC-A1 / A3 | schema + filter 截图 | [ ] |
| R3 | 认知状态转折是一等公民（cognitive-state-transition 为核心字段）| AC-A1 | schema 字段 + 测试 | [ ] |
| R4 | 两轨采集，猫自拉闸必须主动声明（no-classifier 红线）| AC-B1 | grep 无分类器路径 + 设计审查 | [ ] |
| R5 | 系统是小本本记录员不 push 猫，猫主动翻阅 | AC-B1 / B3 | 设计审查（无 push / 无分类器）| [ ] |
| R6 | v1 schema 面向终态，走正确路叠不脚手架 | AC-A1 | schema 承载 B/C 字段审查 | [ ] |
| R7 | teleport 先独立做（最小、独立有用、demo 全靠它）| AC-A4 | teleport 独立可演示 | [ ] |
| R8 | 趋势必须配 resolution 链，频率下降 ≠ 自进化有效（Maine Coon）| AC-C2 | UI 无孤立频率断言 | [ ] |

### 覆盖检查
- [x] 每个需求点映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求→证据映射表（Phase A 交付时补）

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。no-classifier / schema 类须可量化验证（无分类器代码路径、schema 测试），不是"提了就算"。 -->

### Phase A（schema + 只读时间线 + teleport）

> ✅ **Phase A merged** — PR-1（schema + EventMemoryStore + teleport substrate）+ PR-2（confidence backfill + 拉闸记录 timeline UI，#2132 / `34cbab09`，2026-06-07）。Maine Coon 跨族 review + 多轮remote review，4×P2 + 4×P1 全修（owner-scoping / dead-letter owner / system-message skip / race-confidence upgrade）。AC 已 code-complete + 单测覆盖；**operator alpha 批量验收（timeline 视觉 + teleport 录屏）为最终 acceptance，待跑**（先 `cat_cafe_backfill_events` 回扫出数据）。
- [x] AC-A1: Event schema 定型（**10 个语义字段**：`type/trigger/cat/threadId/messageId/timestamp/summary/cognitiveTransition/relatedHarness/confidence` **＋ owner scope 元数据 `ownerUserId`**——存储/权限边界，非第 11 个认知字段；PR-2 cloud-review P1 加固，事件按 owner 隔离、`UNIQUE(ownerUserId,threadId,messageId,type)`、读写都按 owner scope、无 unknown/default fallback，防跨用户泄漏），有类型定义 + 测试覆盖 + 文档；schema 设计可承载 Phase B/C 字段（面向终态，非脚手架）—— trace Why「认知转折成一等公民」
- [x] AC-A2: 从 L0 注册的 10 个 magic word 回扫历史消息生成 event 索引；回扫范围/深度按 OQ-1 决议执行；检测置信度（高/中/低）逻辑有测试 —— trace Why「散落无索引 → 可检索」
- [x] AC-A3: 只读 timeline UI 可 filter by magic word / 事件类型；每条含 日期/icon/当事猫/原话摘要/thread/[跳转]；低置信默认折叠 —— 可复核：截图 + filter 交互
- [x] AC-A4: `teleport(threadId, messageId)` 端到端可演示——"传送到那个脚手架 thread 的 msg" → 搜 Event Memory → 找坐标 → message 级精确跳转 —— trace Why「瞬间跳转到那条 message」，可复核：15s 录屏
- [x] AC-A5: magic word 含义解释从 L0 家规读取（single source of truth），Event Memory **不重复定义** magic word 列表 —— 可复核：代码无硬编码词表

### Phase B（猫主动声明 + 跨 thread 聚合）
- [ ] AC-B1: MCP tool `cat_cafe_mark_event(...)` 可用；系统只索引猫主动声明的事件，**无分类器/regex/小模型推断 aha 的代码路径**（no-classifier 红线）—— 可复核：grep 无分类器调用 + 设计审查
- [ ] AC-B2: 跨 thread 重复诉求聚合可用（同一只猫多处同诉求归并）—— 可复核：构造多 thread 同诉求 fixture
- [ ] AC-B3: 面板展示两轨（人工拉闸 + 猫自拉闸），可独立 filter —— 可复核：截图

### Phase C（resolution 链 + 趋势）
- [ ] AC-C1: 事件可关联 harness 改动（commit/hook/skill/rule），形成 resolution 链 —— trace Why「飞轮黑匣子可度量」
- [ ] AC-C2: 趋势视图存在，但趋势**不单独**作为"自进化有效"结论展示，必须并列 resolution 链证据 —— 可复核：UI 不存在"纯频率下降=有效"的孤立断言
- [ ] AC-C3: "骂完长出了什么能力"闭环证据可视化（事件 → 关联 harness 改动）—— 可复核：点开一条事件展示其关联 commit/skill

## Dependencies

- **Related**: F114（Governance Magic Words — Event Memory 索引这些拉闸事件，词表真相源在 F114/L0）
- **Related**: F102（记忆 Adapter / IEvidenceStore — Event 存储候选复用，OQ-4）
- **Related**: F192（Socio-Technical Harness Eval — Event Memory 是 harness 飞轮的可观测性层，Phase C resolution 链与 harness-feedback 闭环互补）
- **Related**: F095/F057/F187（Thread Navigation cell — teleport 扩展导航到 message 级，OQ-5）
- **Related**: F225（cross-post 跳转 dogfood 活案例 — 本 feature Why 的活案例素材；teleport 复用的 message scroll 基座见 Current State，源自 F052/F194）

## Architecture Cell（Design Gate 一问 — 立项初判，待 Design Gate 钉死）

| 子能力 | 候选 cell | Map delta 倾向 |
|--------|----------|---------------|
| Event 索引存储 | `memory`（F102 IEvidenceStore 模式） | update / new cell 待定（OQ-4） |
| Teleport message 级跳转 | `thread-navigation`（F057/F095/F187）— 复用 web `scrollToMessage` + `findCrossPostTargetMessageId` 基座 | **update required**（补 generic teleport MCP + 路由接基座，OQ-5）|
| mark_event MCP tool | collab MCP 工具面 | update required（新 tool） |

> 禁止私造 `Store`/`Router`/`Adapter` 绕开已有 cell；精确归属在 Design Gate 用 ownership map 钉死。

## Eval / Tracking Contract（F192 门禁 — 含新 MCP tool + 改变猫行为模式，必填）

1. **Primary Users + Activation Signal**：猫（主动 `mark_event` / 翻阅 event memory）+ operator（teleport 到拉闸 thread）。Activation = `mark_event` 调用次数 / teleport 使用次数 / timeline 翻阅次数
2. **Friction Metric**：猫想标记转折点但找不到入口 / 搜 event memory 搜不到目标事件 / teleport 跳错或跳不到 message 级
3. **Regression Fixture**（≥2）：(a) `magic word + @猫` 应被标高置信拉闸；(b) magic word 在讨论家规/定义新词上下文应标低置信或不标记；(c) 猫 `mark_event` 后该事件能在 timeline 检索到且不被分类器改写
4. **Sunset Signal（lane 级，两条独立触发，不 AND）**：(a) `mark_event` 长期零调用 → **猫主动声明 lane 证伪**，重设计该 lane；(b) timeline 长期无人翻阅 → **整体"小本本记录员"形态证伪**，重评是否该被动记录 / 换形态。任一触发即评估，不互相 AND（不设 reviewer 签字降级）

### Harness 三层（软+硬+eval）
- **Soft**：L0 / skill 提示"认知转折点主动 `mark_event`"；teleport 场景触发反射（operator说"传送到那个 X thread 的 msg"）
- **Hard**：schema 校验 + `mark_event` 入参校验 + 回扫置信度分级逻辑测试 + **no-classifier 验证**（CI 断言无分类器/regex 推断 aha 的代码路径）
- **Eval**：上述 Eval Contract fixtures + friction metric + sunset signal

## Risk

| 风险 | 缓解 |
|------|------|
| 回扫历史 magic word 噪音（讨论 vs 拉闸混淆）| 置信度分级（高/中/低）+ 低置信默认折叠（轨道一检测策略） |
| 趋势被误读为"自进化有效"（Maine Coon push back）| 强制配 resolution 链，趋势不单独展示为结论（AC-C2） |
| `mark_event` 无猫使用（小本本假设错误）| Sunset Signal 监控；不靠分类器补偿（守 no-classifier） |
| no-classifier 红线被破坏（有人加分类器猜 aha）| Hard gate CI 断言无分类器路径（AC-B1） |
| schema 脚手架化（v1 推翻重来）| schema 面向 v5 终态设计，Phase A 一次定型可承载 B/C（AC-A1） |
| teleport 重复造轮子 / 错挂扩展点 | 复用 web `scrollToMessage` + `findCrossPostTargetMessageId`（F052/F194）基座；禁止私造 Router；禁止扩 `workspace_navigate`（repo file 工具，非 message nav）|

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 内核是 Event Memory（事件级索引），不是 Magic Word 面板 | Magic Word 只是第一条 lane（Maine Coon收敛）| 2026-06-06 |
| KD-2 | 核心 schema 字段是 cognitive-state-transition，不是 magic word | 真空层是"认知状态不是一等公民"（48 reframe）| 2026-06-06 |
| KD-3 | 两轨采集，猫自拉闸必须主动声明 | no-classifier 红线：系统不判断哪条是 aha（48 批判 + operator裁定）| 2026-06-06 |
| KD-4 | 系统是小本本记录员，不 push 猫，猫主动翻阅 | operator裁定 | 2026-06-06 |
| KD-5 | v1 schema 面向 v5 终态，走正确路叠不脚手架叠 | operator裁定 | 2026-06-06 |
| KD-6 | teleport 先独立做 | 最小、独立有用、demo 全靠它（48 建议）| 2026-06-06 |
| KD-7 | 趋势必须配 resolution 链，频率下降 ≠ 自进化有效 | 频率下降可能是用户没说/任务少/检测漏（Maine Coon push back）| 2026-06-06 |
| KD-8 | 新开 F 号，不挂现有 feature | 内核独立于 F114 magic words（三猫共识 + operator）| 2026-06-06 |
| KD-9 | Magic word 事件真相源归一：Event Memory 是唯一源，F192 task-outcome 改引用不双写 | 实现核实发现 F192 已有 magic word 采集（`detectMagicWords` + `onMagicWordDetected`→episode signal，无 messageId）；operator 裁定架构归一/真相源归一，复用采集逻辑、Event 当源（语义主体侧）| 2026-06-06 |

## Review Gate

- Phase A: 跨族 review（teleport + schema 是基础，需 reviewer 守 no-classifier 与 schema 终态性）
- Phase B: 重点守 no-classifier 红线（AC-B1）
- Phase C: 重点守"趋势不单独当证据"（AC-C2，Maine Coon push back 落地）
