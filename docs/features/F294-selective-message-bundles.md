---
feature_ids: [F294]
related_features: [F017, F052, F063, F193, F264, F290]
topics: [message-selection, quote-selection, context-attachments, message-bundle, export, rich-message, cross-thread, lineage]
doc_kind: spec
created: 2026-08-11
updated: 2026-08-13
description: "让用户从一条 Thread 任意选择整条消息或消息片段，以同一份有来源的 Message Bundle 导出文本或图片、跨 Thread 富文本转发，并安全衔接 Collective 发布。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-12T01:28:05Z
---

# F294: Selective Message Bundles — 消息多选、选择性导出与跨 Thread 富文本转发

> **Status**: in-progress / Phase A merged (PR #3599); Phase B implementation merged (PR #3603), Redis hydration repaired (PR #3628), and Alpha UX follow-up verified (PR #3650); Phase B cold-load auth UAT and Phase C pending | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cell: `hub-action-surface` + `bubble-pipeline` + `transport`

Map delta: `update required`

Why: `hub-action-surface` 继续拥有 F063 已落地的文字选区、Comment 与 `QuoteContextAttachment`；
`bubble-pipeline` 拥有 Message Bundle 的人类可见富卡、hydration 与消息身份投影；`transport` 继续
拥有目标 Thread、目标猫、跨线程来源与唤醒语义。F294 只新增统一选择 resolver、持久 Bundle 与
选择性导出/转发出口，不复制 Quote schema，也不私造第二套消息管线。

## Why

用户现在只能导出整条 Thread；想把一次讨论中真正有用的几条消息留下、发给另一个 Thread 的人或
猫，仍要手工复制、裁图、补作者与上下文。这样既打断对话，也容易把原作者、顺序和来源抹掉；
目标猫即使看见一张卡，也可能拿不到真正被选中的上下文。

F294 要让一次“选择”成为可复用的 Message Bundle：同一组选中消息或消息片段可以导出文本、导出图片，
也可以作为保留来源的富文本卡片进入同一 Café 的另一个 Thread。进入 F290 Collective 时则跨过
了信任边界，必须把 Bundle 交给明确的公开预览与确认流程，不能把私人 Thread 原文直接复制出去。

operator的原始诉求：

> “我选择哪几条导出……有可能是文本的，也有可能是需要截图的……以及我选的那几条能够转发给
> 其他线程的猫。”

对默认呈现的确认：

> “肯定是卡片富文本合适，给人看肯定是这样的。”

对消息片段与 Add to Chat 统一边界的补充：

> “甚至不是几条消息而是一条消息的某段话……Add to Chat 类型的转发……好像得统一？”

## Current State / 现状基线

截至 2026-08-11，代码实查显示：

| 现有能力 | 证据 | 缺口 |
|---|---|---|
| 整 Thread 导出 PNG / Markdown / TXT | `ExportButton.tsx` 只接收 `threadId`；`thread-export.ts` 捕获完整 Thread 页面；`export.ts` 读取最多 10,000 条 Thread 消息 | API 与 UI 都没有 `messageIds` 选择契约 |
| 单消息动作与局部文字引用 | F063 AC-25~31 已让消息/CLI/Workspace 选区生成统一 `QuoteContextAttachment`；消息 Quote 保存 `threadId`、`messageId`、选文、可选 Comment 与字符范围，并完整经过草稿、发送、持久化、模型投影和 UI | 现有 `Add to chat` 只能进入当前 Composer；没有把同一 Quote 送往另一 Thread 的出口 |
| 跨 Thread 文本投递与来源标记 | F052/F193 的 `cross_post_message` 接收一段 `content`，支持 `targetCats` 与 `extra.crossPost.sourceThreadId` | 不能持久表达多条原消息、逐条作者/顺序、展开卡与 exact refs |
| F290 公私边界 | `feat/collective-experience-gate` commit `3dad0bbe0` 已定义同 Café 原始 Bundle 与 Collective Living Projection 的分界 | F294 仍需提供通用 Bundle 与未来 public handoff 接口 |

因此本 Feature 不是重做 F017/F063/F193，而是把“整条消息 ref”与 F063 已有“消息 Quote”归一为
同一种可解析选择项，再补上 Message Bundle 产品对象及其导出/转发出口。

## What

### Phase A: 消息多选 + 选择性文本/图片导出

- 从稳定消息的动作区进入多选模式，支持同一 Thread 内连续或离散选择；选择结果按原时间线顺序
  归一化，不按点击先后重排。
- 底部选择工具栏提供“导出文本”“导出图片”“转发”，并清楚显示已选数量和退出动作。
- 文本导出生成 Markdown / TXT，只包含所选消息的作者、时间、正文及可读的富内容降级表达。
- 图片导出使用专用选择态渲染，只呈现所选消息及必要来源标题，不截入导航、Composer 或未选消息。
- 服务端逐个校验 messageId 属于源 Thread 且当前用户可见；streaming、内部 tool-only、已撤回或
  不可见消息不允许进入 Bundle。
- 统一选择 resolver 接受两种 source item，但不定义第二份 Quote：

  ```ts
  type BundleSelectionItem =
    | { kind: 'message'; messageId: string }
    | {
        kind: 'quote';
        attachment: QuoteContextAttachment & {
          source: MessageQuoteSource;
        };
      };
  ```

  `quote` 必须直接复用 F063 的共享 schema；F294 服务端重新校验 source Thread/message/visibility，
  并确认选文属于该消息的 canonical 可见文字投影，禁止仅凭客户端 text 冒充原作者引用。
- 第一版提供两条入口但共用 resolver：消息动作区进入整消息多选；消息内框选文字沿用 F063 的
  选区/Comment 编辑器。两条入口可以分别产出 Bundle，但第一版不要求在一个选择篮里混选整条消息
  与多个片段，避免为了“统一”引入复杂选择状态。
- Quote 转发只适用于 `source.kind === 'message'`；F063 同一浮层承载的 `cli_output`、Workspace file
  等非消息 source 不渲染“转发…”出口，避免把用户送进 resolver 必然拒绝的死端。

### Phase B: 同 Café 跨 Thread 富文本合并转发

- 将所选消息创建为 TTL=0 的 `Message Bundle`；目标 Thread 中的单条 target message 即 Bundle identity，
  只保存源 Thread 与按序 exact message/Quote refs，作者、时间与正文均在读取时由统一 resolver 投影，
  不复制 source body，也不把多条消息伪装成目标 Thread 的逐条新发言。
- 用户选择目标 Thread 与接收猫；只有明确选择的猫被唤醒，不默认打扰 Thread 全部参与者。
- 目标 Thread 显示一张可折叠富文本卡：标题、来源 Thread、消息数和参与者是轻量预览，展开后
  逐条显示原消息、作者、时间与来源跳转。
- 给猫的上下文必须包含被选消息的可读内容与 exact refs；不能只给模型一句“收到一张转发卡”。
- 原消息 hard delete、recall（redact-in-place）、权限变化或来源不可见时，Bundle 的 card/export/prompt
  统一停止泄露对应正文并投影 tombstone；不存在保留旧正文的 snapshot fallback。
- 文字选区编辑器保留 `Add to this chat` 的当前 Composer 语义，并新增并列的“转发…”出口；转发后
  打开与整消息多选相同的目标 Thread / 接收猫选择器，不把 `Add to chat` 悄悄改成跨 Thread 动作。
- 只有一个 Quote 时仍出生 Message Bundle identity，但 UI 使用紧凑 Quote 卡而不是“1 条聊天记录”
  的笨重折叠卡；多条消息使用合并聊天记录卡。Quote 原文、原作者与转发者 Comment 分区显示，
  Comment 明确标成“你的点评”或转发者身份，不能伪装成原作者正文。

### Phase C: F290 Collective 公开投影衔接

- “发布到 Collective”不复用同 Café普通转发按钮的直接发送语义，而进入 F290 的公开预览：
  选中范围、作者/来源、目标受众、脱敏/排除项与 lineage 均可见。
- 只有具备 authority 的人确认后才创建具有独立 public identity 的 Living Projection；取消、越权
  或校验失败时不出生公共对象。
- Collective 只能读取获准公开的投影，不能打开私人 Thread 或反向修改私人原消息；公共对象保留
  到 Bundle 与 source messages 的 exact lineage。

## User Journey

### Primary Journey: 把整条消息或消息片段转发给另一个 Thread 的人和猫

- **Scope unit**: selected content item (`message` or message `quote`)
- **Actor**: operator
- **Entry**: 任意稳定消息动作条上的“多选消息”图标，或消息正文内的有效文字选区；系统右键与长按
  保持复制图片、文字等原生能力，不承担 F294 入口
- **Flow**:
  1. 整消息路径：operator进入多选 → 每条可选消息出现安静的选择标记，底部显示已选数量与三个出口。
     片段路径：operator框选文字 → F063 现有 Comment 编辑器保留选文，并展示 `Add to this chat` 与
     “转发…”两个清楚分开的出口。
  2. operator选择“转发…” → 两条路径都进入同一个目标 Thread / 接收猫选择器。
  3. operator选择目标 Thread 和接收猫并确认 → 目标 Thread 出现一张合并聊天记录富卡，而不是
     多条冒充原作者的新消息；单 Quote 使用紧凑 Quote 卡。
  4. 人展开合并卡或直接查看 Quote 卡 → 看见原作者、时间、选文/正文、来源与独立标识的转发者
     Comment；猫被唤醒时同步读到同一组结构化内容与 refs。
- **Success evidence**: 整消息多选态、片段 Comment/双出口、目标选择器、单 Quote 卡、多消息折叠/
  展开卡截图；15 秒录屏；Playwright 分别覆盖 message→转发→展开与 quote→转发→查看；prompt
  fixture 证明目标猫读到相同原文/Comment/refs 且作者身份不混淆。
- **Non-goals**: 第一版不跨多个源 Thread 混选；不逐条克隆消息；不把私人原文直接公开到 Collective；
  不把内部推理、tool-only 事件或 streaming 半成品包装成人类聊天记录；不要求在同一个选择篮中
  混选整条消息和多个片段。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | message | operator | 选择消息 → 导出 Markdown/TXT → 文件只含所选内容且顺序、作者正确 | API contract test + 文件快照 |
| S2 | message | operator | 选择消息 → 导出图片 → PNG 只呈现所选气泡与必要来源信息 | screenshot diff |
| S3 | message | operator | 选择消息 → 发布到 Collective → 预览/脱敏/确认 → Living Projection | F290 Gate fixture + authority test |
| S4 | quote | operator | 框选一段话 + 可选 Comment → 转发到另一个 Thread/猫 → 紧凑 Quote 卡区分原文与点评 | Playwright + screenshot + prompt fixture |

## Frontend Design in Context

F294 不新造一套“选中文字”浮层，也不把转发塞进 Composer 再让用户二次搬运。它在三个现有表面上
做有边界的延伸：

| 现有表面 | 代码证据 | F294 设计决定 |
|---|---|---|
| 消息动作条 | `MessageActions.tsx` 已承载回复、删除、分支、编辑等 bubble action | 在动作条提供带 tooltip/可访问名称的“多选消息”图标；低频且图标含义不清的“从这里分支”收进 overflow。系统右键与移动端长按保持浏览器原生复制/图片菜单，不再作为 F294 入口；未进入多选前不在每个 bubble 常驻 checkbox |
| 文字选区 Comment | `SelectionAnnotationAction.tsx` 已提供 `Add to chat` trigger、Selected text、User comment、Cancel/Save | 保留同一浮层与 Comment 草稿，只把含糊的 Save 收敛成两个明确出口；不出现第二个 quote toolbar |
| Thread / 猫数据与视觉原语 | `ChatContextPicker.tsx` 已有 Thread 搜索/行样式；`CatSelector.tsx` 已有猫名、家族与 chip 视觉 | F294 提供一个共享 `TransferTargetPicker`（桌面 modal、窄屏 bottom sheet），复用数据源与视觉原语；不直接复用 `ChatContextPicker` 的“添加当前 Composer 上下文”语义，也不复用 `CatSelector` 的“默认猫猫（可选）”文案 |

### 片段入口：在原选区浮层内分流

```text
┌──────────────────────────────────────┐
│ Selected text                        │
│ “被选中的原文……”                    │
├──────────────────────────────────────┤
│ User comment（可选，仅用于转发）     │
│ [写下你对这段内容的点评…          ] │
├──────────────────────────────────────┤
│ [取消]       [加入当前聊天] [转发…] │
└──────────────────────────────────────┘
```

- “加入当前聊天”保持 F063 现有契约：Comment 仍按当前规则必填，动作只写入当前 Composer，不自动发送；
  现有 Enter 快捷键仍走这个动作。
- “转发…”只要求选文有效，Comment 可以为空；点击后保留选文与 Comment 草稿并打开目标选择器。
- 两个动作同层但不双主按钮争抢：既有高频动作 `加入当前聊天` 保持 accent primary 并对应 Enter，
  `转发…`为 bordered secondary，`取消`为 quiet action。已有 annotation 的编辑态仍只显示
  Cancel / Save / Delete，不出现“转发”，避免
  把“修改已加入当前草稿的批注”误成新建跨 Thread 对象。
- 只有 message-source 选区出现“转发…”；`cli_output`、Workspace file 等仍维持 F063 原有单出口。

### 共享目标选择器：先 Thread，后接收猫，再明确确认

```text
┌──────────────────── 转发到 ────────────────────┐
│ 1 段引用 · 来自「F294 讨论」                    │
│ [搜索 Thread…                                ] │
│ ○ F294 实现                                   │
│ ● 设计讨论                                    │
│                                                │
│ 接收猫（至少 1）                               │
│ [● 小太阳] [○ Kimi] [○ Opus 4.7]              │
│                                                │
│ [取消]                         [转发 1 段引用] │
└────────────────────────────────────────────────┘
```

- 整消息多选与文字片段都进入这一个 selector；标题摘要分别显示“`N 条消息`”或“`1 段引用`”。
- Thread 列表顶部始终提供按标题或 Thread ID 过滤的搜索框；无匹配时显示明确空态，不要求用户在长列表
  中滚动寻找目标。
- 选中一个可见目标 Thread 后才展示/启用接收猫区域；必须显式选择至少一只猫，confirm 才可用。
- 桌面端使用 modal；窄屏使用单列 bottom sheet，Thread 结果区和猫 chip 区独立滚动，confirm 固定在
  safe-area 上方。键盘焦点、Escape/返回、screen-reader label 与 focus return 均纳入组件测试。
- 成功后留在源 Thread，退出选择态并显示“已转发到〈Thread〉”toast + “查看”动作；失败则 selector
  保持打开、选择与 Comment 不丢失，不创建半成品 Bundle。

### 目标 Thread 中的两种 projection

- **单 Quote 卡**：卡头先显示原作者、源 Thread、原消息时间与来源跳转；正文只呈现引用片段；有
  Comment 时在分隔线下显示“`转发者名的点评`”，无 Comment 不渲染空区。转发者不能占据原作者位。
- **多消息合并卡**：折叠态显示来源 Thread、`N 条聊天记录`、参与者与转发者；展开后按原时间线逐条
  显示作者、时间和内容。卡片自身只占目标 Thread 一条 timeline item。
- 两种 projection 复用现有 café surface/border/accent tokens 和 bubble typography，不新增独立 z-index
  family；tombstone、无权限、超限和 loading/error 状态在卡片原位呈现，不用 toast 代替持久状态。

被拒绝的替代方案：为 Quote 单独增加第二个浮动“转发”按钮；先 Add to Chat 再从 Composer 转发；把
每条选中消息逐条投进目标 Thread。它们分别会造成动作竞争、额外搬运和作者身份伪造。

## Acceptance Criteria

<!-- 每条 AC 均 trace 回“少搬运、来源不丢、人猫看到同一内容、私人内容不越界”的 Why，并要求非作者可复核。 -->

### Phase A（消息多选 + 选择性导出）

- [x] AC-A1: 同一 Thread 的连续与离散稳定消息均可多选；选择结果按时间线顺序归一化，退出/切换
  Thread 会安全清空；streaming、tool-only、已撤回与不可见消息不可选。证据为组件测试 + 截图。
- [x] AC-A2: Markdown 与 TXT 导出只包含所选消息，并保留作者、时间、正文与富内容的可读降级；
  API contract tests 覆盖空选择、外 Thread ID、重复 ID、越权 ID 与超限输入。
- [x] AC-A3: PNG 导出只呈现所选消息及必要来源标题，不包含未选消息、导航或 Composer；短/长选择
  各有 screenshot evidence，长图无重复拼接。
- [x] AC-A4: 文本、图片与转发共用同一 server-side selection resolver；每个 messageId 都重新经过
  Thread 归属、owner 与 visibility 校验；resolver 同时接受整消息 ref 与 F063 `QuoteContextAttachment`
  的 message-source 子集，不复制 Quote schema。fail-closed tests 覆盖伪造 source、越权 message、
  不属于 canonical 可见文字的 Quote text、失效字符范围与 canonical projection hash 漂移。

### Phase B（同 Café 富文本合并转发）

- [ ] AC-B1: TTL=0 Message Bundle 持久化源 Thread、按序 exact refs、创建者与创建时间；重启后卡片
  仍可展开，重复提交由 idempotency key 去重。
- [ ] AC-B2: 目标 Thread 只新增一张 Message Bundle 富卡；折叠态显示来源/数量/参与者，展开态逐条
  显示作者、时间、内容与来源跳转，并有 hydration + socket convergence 测试。
- [ ] AC-B3: 用户可选择一个目标 Thread 和一到多只目标猫；只有显式选择的猫被唤醒，来源 Thread
  与 Bundle identity 保留，错误目标或越权目标 fail closed。
- [ ] AC-B4: 被唤醒猫的 prompt/context 包含所选消息的可读内容、Bundle ID、源 Thread 与 exact refs；
  回归 fixture 证明不是只有卡片标题或无来源拼接文本。
- [ ] AC-B5: hard delete、recall（记录仍存在但 `_tombstone=true` / `deliveryStatus='canceled'`）、权限撤销
  及来源消息变得不可见后，所有 Bundle read/export/context 路径均不再泄露对应正文，并以一致
  tombstone 呈现；三类失效闭环有端到端测试。
- [ ] AC-B6: 消息文字选区复用 F063 Comment 编辑器；`Add to this chat` 继续进入当前 Composer，
  “转发…”进入 F294 目标选择器。component + browser tests 证明两条动作不会互相改写、自动发送或
  丢失已有草稿；非 message-source 选区不显示“转发…”，没有点击后必然 fail-closed 的死端。
- [ ] AC-B7: 单 Quote Bundle 渲染为紧凑 Quote 卡，多消息 Bundle 渲染为折叠合并卡；原作者正文、
  转发者 Comment 与来源各自有明确视觉/语义标签。UI screenshot 与 prompt fixture 证明人和猫都不会
  把 Comment 归到原作者名下。
- [ ] AC-B8: 整消息与 Quote 共用一个 `TransferTargetPicker`；桌面 modal、移动端 bottom sheet 均按
  “搜索并选一个 Thread → 选至少一只猫 → 明确确认”推进。成功留在源 Thread 并提供目标跳转；失败
  保留 selection/Comment 且不出生 Bundle。keyboard/a11y component tests + desktop/mobile screenshots 覆盖。

### Phase C（F290 public projection handoff）

- [ ] AC-C1: F294 只提供 handoff entry，preview surface 与 authority 校验归 F290 owner；Collective
  handoff 必须先展示选中范围、作者/来源、目标受众、脱敏/排除项与 lineage，cancel、越权或校验
  失败不创建任何 public object。
- [ ] AC-C2: Living Projection 的生成与生命周期归 F290 owner；authority 确认后只把获准内容创建为
  独立 Living Projection，Collective 无法读取私人 Thread 原文，公共编辑不能反向修改私人消息，
  且 public object 保留 exact lineage。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “我选择哪几条导出”——支持连续或离散消息多选 | AC-A1 | component test + screenshot | [x] |
| R2 | “有可能是文本的”——只导出所选消息文本 | AC-A2, AC-A4 | API test + export snapshot | [x] |
| R3 | “有可能是需要截图的”——只导出所选消息图片 | AC-A3, AC-A4 | screenshot diff | [x] |
| R4 | “转发给其他线程的猫”——选 Thread、选猫并让猫读到内容 | AC-B3, AC-B4, AC-B8 | integration test + prompt fixture + browser | [ ] |
| R5 | “肯定是卡片富文本合适”——目标 Thread 显示合并卡而非逐条克隆 | AC-B1, AC-B2 | screenshot + hydration test | [ ] |
| R6 | 作者、顺序和来源不能在转发中丢失 | AC-B1, AC-B2, AC-B4 | store/renderer/context tests | [ ] |
| R7 | 未来送入 F290 多人多 Agent 协同，但私人原文不直接外流 | AC-C1, AC-C2 | F290 Gate fixture + auth test | [ ] |
| R8 | “一条消息的某段话 Add to Chat 类型的转发”——复用选区/Comment 并转发到其他 Thread | AC-A4, AC-B6, AC-B7 | browser + API + prompt fixture | [ ] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已定义需求→截图/录屏/测试证据映射

## Dependencies

- **Evolved from**: F017（整 Thread 图片/文本导出底座）
- **Evolved from**: F193（跨 Thread 投递、targetCats 与来源语义）
- **Related**: F063（`ContextAttachment`、文字选区、Comment 编辑器与 Quote 全链真相源）
- **Related**: F052（跨线程消息溯源）
- **Related**: F264（原消息 lineage、receipt 与 bubble projection 边界）
- **Related**: F290（Phase C 的 Collective public projection 与 authority 边界）
- **Blocked by**: F290 Experience Design Gate 的 public projection surface（仅 Phase C；Phase A/B 独立推进）

## Risk

| 风险 | 缓解 |
|------|------|
| 客户端伪造 messageIds 越权读取别的 Thread | 服务端逐 ID 校验 source Thread、owner 与 visibility，任何不匹配 fail closed |
| 客户端伪造 Quote text 并借原作者身份跨 Thread 传播 | 直接复用 F063 Quote schema，但 F294 服务端仍以 source message 可见文字投影校验选文；无法验证时拒绝带来源转发，不降级成“看起来像原文”的卡 |
| canonical readable projection 演化后旧 offsets 静默指向另一段原文 | Quote ref 持久化 projection version + 完整 canonical projection 的 domain-separated SHA-256；读取时不匹配投影“原文已变更”，不按旧 offsets 猜测 |
| F063 与 F294 各长一套选区/Comment schema | F063 独占捕获与 `QuoteContextAttachment`；F294 只消费 message-source Quote 子集，schema import + contract test 防结构漂移 |
| Quote Comment 被误认为原作者正文 | 人类卡片和猫 context 都把 source author 与 forwarding commenter 分字段/分区投影，禁止字符串拼接后丢身份 |
| 富卡和猫 prompt 形成两套内容真相 | 同一 Bundle resolver 同时产出 human projection 与 agent context；契约测试对齐 refs/顺序 |
| snapshot 保留已删除、已撤回或失权内容 | hard-delete/recall/visibility closure 作为 Phase B 阻塞 AC，不允许只在 UI 隐藏 |
| 大 Bundle 挤爆导出或模型上下文 | Design Gate 冻结可解释上限与超限 UX；禁止静默截断或只给猫摘要 |
| 复用 cross_post_message 时误触 action/custody 语义 | 用户分享与猫猫责任交接分开建模；只有显式 targetCats 负责唤醒，不推断 assign_work |
| F290 依赖拖住同 Café价值 | Phase A/B 无 F290 依赖；Phase C 只在 public surface ready 后接入，但 F294 不在缺 C 时 close |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F294 独立立项，Evolved from F017 + F193，Related F290 | 选择、导出、同 Café 转发形成独立用户旅程，不应塞回已完成导出或跨线程协议 Feature | 2026-08-11 |
| KD-2 | 一个 Message Bundle selection resolver 驱动三个出口 | 让文本、图片、转发共享顺序、权限和来源真相，不长出三套选择逻辑 | 2026-08-11 |
| KD-3 | 默认呈现为折叠富文本合并卡，不逐条克隆 | operator 明确确认“给人看肯定是卡片富文本”；逐条克隆会伪造作者和目标时间线 | 2026-08-11 |
| KD-4 | 同 Café 可转发原始 Bundle；Collective 只能接收经确认的 Living Projection | 私人 Thread 与 Collective 是不同信任域，F290 commit `3dad0bbe0` 已冻结边界 | 2026-08-11 |
| KD-5 | 目标猫必须显式选择，不默认唤醒目标 Thread 全员 | 分享信息不自动等于派活或要求所有猫响应 | 2026-08-11 |
| KD-6 | F063 拥有片段捕获与 Comment；F294 拥有导出、目标选择与跨 Thread Bundle | 复用一个 `QuoteContextAttachment` 真相源，同时让当前 Composer 与跨 Thread 分发保持清楚的产品边界 | 2026-08-11 |
| KD-7 | 单 Quote 与多消息共用 Bundle identity，但采用紧凑 Quote 卡 / 合并聊天记录卡两种投影 | 数据与权限逻辑统一，不强迫一段话支付“1 条聊天记录”的笨重视觉成本 | 2026-08-11 |
| KD-8 | 整消息与 Quote 共用 `TransferTargetPicker`；目标 UI 复用目录/roster 原语但不借用 Add-to-Composer 语义 | 一条用户旅程只该有一个目标选择器；相似数据源不等于相同动作语义 | 2026-08-11 |
| KD-9 | Quote ref 保存 `sourceProjectionVersion` 与完整 canonical projection 的 domain-separated `sourceProjectionSha256` | 源 body 当前不可原地编辑，但 projector 会演化；完整投影 digest 能检测 offset 坐标漂移，又不复制正文或为短选文单独建立猜测确认锚 | 2026-08-11 |
| KD-10 | “多选消息”使用动作条可见图标；“从这里分支”收进 overflow；F294 不劫持系统右键/长按 | Alpha UAT 证明右键入口既隐蔽又会破坏图片/文字复制；分支图标缺乏自解释，而多选是本旅程的主入口 | 2026-08-13 |

## Tips Contribution（F244）

- 新增一条上下文 tip：从消息动作条的“多选消息”图标进入多选，可将所选内容导出文本/图片或作为合并卡转发；
  框选消息文字后可从现有 Comment 编辑器选择加入当前聊天或转发到其他 Thread。
- tip 的 `sourceRef` 指向本 spec 的 Primary Journey，只有多选入口可用时才展示。

## Review Gate

- Kickoff docs: operator 原话与 F290 已验证边界作为 content continuity；普通 docs-only direct push。
- Experience Design: Kimi 对在地入口、目标选择器、单 Quote/多消息 projection、移动端与反馈闭环终审
  APPROVE；finding 吸收后的 staged tree `41f61888ebe641ccff1242c36f5264f0f111dc53` delta 复查 APPROVE。
- Phase A: 非作者 reviewer 覆盖 selection UX、auth/visibility、文本与图片一致性。
- Phase B: 非作者跨个体 reviewer 覆盖 TTL=0、删除闭环、bubble hydration 与 targetCats 唤醒。
- Phase C: F290 Design Gate continuity + 非作者 reviewer；F294 作者不能审自己的 public boundary 实现。
