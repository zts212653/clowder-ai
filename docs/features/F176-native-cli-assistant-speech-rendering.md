---
feature_ids: [F176]
related_features: [F097, F167, F173]
topics: [frontend, message-rendering, semantic-classification, native-cli, assistant-speech, cli-stdout, message-pipeline]
doc_kind: spec
created: 2026-04-25
---

# F176: Native CLI Assistant-Speech vs CLI-Stdout 渲染语义分离

> **Status**: done (reverted) | ❌ REVERTED 2026-04-26 | **Owner**: Ragdoll（Opus-47） | **Priority**: P1（已撤销）
>
> **Reverted**: team lead 2026-04-26 01:05 否决 ——
> 1. **完全理解错原 bug**：原始问题 thread_mnux2eewbo4otg17 是"前端连他们的头像、CLI thinking 什么都看不到"——整个 ChatMessage 组件没渲染（DOM 缺失）。F176 把它误诊为"内容被折叠"，做了 messageRole 分流。**修了一个不存在的 bug，没修真 bug**。
> 2. **视觉效果丑**：F176 的"主气泡 + 独立 CliOutputBlock 卡片"渲染分流让气泡裂开，team experience："你们现在这个气泡渲染行为 太丑了"。
> 3. PR #1401 + #1402 全部 revert，messageRole 字段 + 所有相关代码移除。
>
> **真 bug 仍未解决**：thread_mnux2eewbo4otg17 里 opus/codex 互 @ 后 ChatMessage 整体不渲染（头像 + CLI Output 都没出来）。需要单独立项重新诊断（候选 F177）。
>
> **历史 commits**（已 reverted, 留作追溯）：
> - PR #1401 (squash `2b41a5cc`) feat(F176): native CLI assistant-speech vs cli-stdout 渲染语义分离
> - PR #1402 (squash `11ce3111`) fix(F176-R4): plumb messageRole through hydrateMessages bulk path
>
> **Triggered by**: `thread_mnux2eewbo4otg17` 实测（2026-04-25 13:14），team lead报告"前端看到互相调用但看不到说话气泡"。@codex Maine Coon（GPT-5.5）+ @opus47 Ragdoll（Opus-47）双独立诊断收敛到同一根因（5/5 一致）—— **但收敛到的是同一个错误根因**。
>
> **Review trail**: Maine Coon R1 退回（链路断点）→ R1 fix → R2 退回（existing-bubble path）→ R2 fix → R3 放行 + continuity 延续到 rebase 后 SHA 6dc698b4。云端 codex review pass（no major issues）。**愿景守护 gpt52 (跨 family) push back**: AC-E1 alpha 实测必须做 → sonnet-4.6 接力 alpha 验收发现 R4 P1（`hydrateMessages` 批量路径丢 messageRole）→ R4 fix + Maine Coon R4 verify (20/20 Redis tests) + cloud review pass + merged。**全程 4 轮 review + cloud + alpha 验收，没人发现真 bug 是什么 — 因为所有人都在验证"实现是否符合 spec"，没人验证"spec 本身是否正确"。**

## ⚠️ Postmortem 反思（team lead 2026-04-26 01:10 让写）🔴

### 错在哪个具体位置

**Spec § Why § 现象**（line 32-35，写于 2026-04-25 13:36 立项时）：

```
team lead在 thread_mnux2eewbo4otg17 看到：
- ✅ Briefing card 正常显示
- ✅ A2A 状态 / DirectionPill 正常显示
- ❌ codex / opus 通过 native CLI provider 输出的正经回复内容
     完全看不到主气泡——只看到一个折叠的 `CLI Output | done | N tools | XmYs` 卡片
```

**这一段的第 4 行就错了。** team lead原图里 opus/codex 互 @ 的位置**根本没有 CLI Output 卡片**，只有 BriefingCard + DirectionPill 横标签。**整个 ChatMessage 组件没渲染**（DOM 缺失）。

我读图时：
- 看到顶部Maine Coon GPT-5.5 那条**有 CLI Output**
- 推断"所有 cat 消息都被折叠成 CLI Output"
- **完全没问"那为什么 opus/codex 那些位置连 CLI Output 都没？"**

这是采样偏差 + 第一性原理失败：
- 把"图里看到的一条"当成"普遍现象"
- **没问"我看到的 vs 没看到的，差异在哪"** —— 真正的 bug 信号在"没看到的部分"

### team lead的原始意图（2026-04-26 01:02 + 01:05 三个感叹号才纠正过来）

> "我滴吗 这个f176 你们完全理解错了啊，当时是为了修这个bug的，就是Ragdoll和Maine Coon互相 at 然后互相说话了，但是我前端连他们的头像 cli thinking 什么都看不到！！"

team lead说"看不到说话气泡" = **整条 ChatMessage 不渲染（连头像、连 CLI thinking 都没出来）**，不是"内容被 CliOutputBlock 折叠"。我把"看不到"误读为"被折叠看不到"，是把同一个动词的两种语义搞混了：
- 真意：DOM 缺失（看不到 = 不存在）
- 误读：UI 折叠（看不到 = 默认隐藏）

### 流程为什么没纠正方向

1. **双猫并行诊断 5/5 收敛 ≠ 正确**：我和Maine Coon独立看图，独立得到"stream 内容被折叠"的结论。我以为是"双猫验证"，实际是**两猫基于同一个错误前提（误读图）独立到达同一个错误终点**。Meta-aesthetics 同质性陷阱：collaborative diversity 失效。
2. **R1-R4 review 验证的是"实现是否符合 spec"**，不是"spec 是否正确"。Maine Coon每轮都精准命中实现层面的链路断点，但没人 push back § Why。
3. **quality-gate Step 0 愿景对照表**也按错误前提走：我对照"team experience"，但**对照的不是图，是我自己写的 spec**——spec 里把"看不到"已经误读成"被折叠"。
4. **AC-E1 alpha 验收**最后由 sonnet 接力做，但他验证的是"messageRole 是否端到端透传到主气泡"——**不是验证"thread_mnux2eewbo4otg17 现象消失"**。AC-E1 写的"现象消失"被偷换成了"messageRole 工作"。

### 真根因 vs 我修的

| | 真 bug | F176 修的 |
|---|---|---|
| 现象 | opus/codex 互 @ 后 ChatMessage 整体不渲染（DOM 缺失）| 误以为内容被折叠 |
| 数据层 | 消息在 store 里但渲染层跳过了它们 | （在数据层加了 messageRole 字段）|
| 渲染层 | ChatMessage 早 return null / dedup 误杀 / merge 吃掉 / catData 缺失 | 改了 line 379-385 的内容分流 |
| F097 关系 | 跟 F097 完全无关 | 误以为是 F097 设计冲突 |
| 修法 | 还没修 | messageRole 分流 + 全链路 plumbing |

### 教训写到哪

1. **Spec § Why 必须基于图/原话 verbatim quote**，不能加自己解读。如果原话有歧义 → 反问team lead澄清，不自己拍板。
2. **"看不到"的两种语义**（DOM 缺失 vs UI 折叠）必须在 spec 立项时**显式区分**——加 DOM screenshot 比 UI screenshot 多一层证据。
3. **quality-gate Step 0 愿景对照**应对照**原话**，不对照**spec**。spec 是衍生物，原话才是真相源。
4. **多猫独立诊断收敛同一答案**不能直接当真相 — 要追问"会不会都基于同一错误前提"。Meta-aesthetics canon 已有这一条，但实操中没触发。
5. **AC-E 端到端 acceptance 必须按"原话现象消失"而不是"实现层面 OK"** — 防 AC 偷换。
6. **F167 同质性陷阱实例 +1**：写到 lessons-learned。

> **真 bug（候选 F177）正确的 spec § Why**应该是：
> ```
> team lead在 thread_mnux2eewbo4otg17 看到（图: thread.png）：
> - ✅ 顶部Maine Coon GPT-5.5 那条消息：完整渲染（头像 + 标题 + CLI Output 折叠卡）
> - ✅ BriefingCard 系统消息：正常渲染
> - ✅ DirectionPill 路由标签（"Maine Coon→Ragdoll"）：正常渲染
> - ❌ opus / codex 互 @ 之后的所有 cat 消息：**整条 ChatMessage 不渲染**
>   - 没头像（CatAvatar）
>   - 没标题（catStyle 头部）
>   - 没气泡 div（line 366-419 整块）
>   - 没 CLI Output 折叠卡
>   - 但 DOM 中可能仍有占位（待 F12 确认）
>
> 数据层验证（thread context API 返回）：
> - catId='opus-47' 和 'codex' 的 message.content 不为空
> - 多条消息真实存在于 messageStore
>
> 真问题：为什么 store 里有数据，但前端 ChatMessage 不渲染它们？
> ```

## Why（原始 — 误诊版本，留作追溯）

### 现象（误诊版）

team lead在 `thread_mnux2eewbo4otg17` 看到：
- ✅ Briefing card 正常显示（"传球 / 真相源 / 下一步"）
- ✅ A2A 状态 / DirectionPill 正常显示
- ❌ codex / opus 通过 native CLI provider 输出的**正经回复内容**（PR review、merge 报告、debug 过程）**完全看不到主气泡**——只看到一个折叠的 `CLI Output | done | N tools | XmYs` 卡片

### 根因（三层共谋）

#### Layer 1：后端将所有 stream text 染色为 `origin: 'stream'`
`packages/api/src/domains/cats/services/agents/routing/route-serial.ts:716-724`：
```ts
// Tag CLI stdout text with origin: 'stream' (thinking/internal)
yield effectiveMsg.type === 'text'
  ? { ...effectiveMsg, origin: 'stream' as const, ... }
  : effectiveMsg;
```
原意是把 CLI stdout 当 "thinking/internal"，但 native CLI provider（codex/opus）的**最终 assistant response 也走同一个 yield 通道**，全部被打成 `origin='stream'`。无法区分 "thinking output" 和 "final answer"。

#### Layer 2：前端把 stream-origin 整体交给 CliOutputBlock
`packages/web/src/components/ChatMessage.tsx:379-385`：
```tsx
{hasCliBlock && isStreamOrigin ? null : !isStreamOrigin && hasBlocks ? (
  <ContentBlocks .../>
) : !isStreamOrigin && hasTextContent ? (
  <CollapsibleMarkdown .../>
) : ...}
```
`isStreamOrigin === true` 走第一个分支 → 主文本完全不渲染，被打包进下面 `CliOutputBlock`（line 400-411）。

`packages/web/src/components/cli-output/toCliEvents.ts:84-91`：stream content 强行 push 成 1 个 `text` event。

#### Layer 2.5：CliOutputBlock 默认折叠
`packages/web/src/stores/chatStore.ts:791`：`globalBubbleDefaults.cliOutput = 'collapsed'`

→ 用户视觉上：**头部（猫名 + 时间 + DirectionPill）正常 + 正文被折叠隐藏**。展开 CLI Output 才看得到原话。

### 测试锁住了这个行为（设计冲突，不是 regression）

`packages/web/src/components/__tests__/cli-output-integration.test.ts:106` 明确 expect "stream origin with only content → 渲染为 CLI Output"。这是 F097（CLI Output Collapsible UX，2026-03-11 立项）的 intentional 设计——把 ToolEventsPanel + stream content 合并为统一 CLI Output Block。

**F097 设计 in 2026-03**：CLI provider 主要是 codex/opus 的 thinking + tool calls，stream text = thinking output。
**2026-04 现实**：codex/opus 已成为正式回复猫，stream text 包含**正经 final response**（PR review 决策、debug 结论、merge 报告）。

F097 设计前提失效，渲染层需要更精细的语义分流。

## What

### 设计核心：新增 `messageRole` 语义字段，**不动 invocation/bubble identity**

为什么不会让 F173 气泡裂开 / 重复（与 F173 共存策略）：

| F173 历史风险 | F176 改动层 | 是否触发 |
|---|---|---|
| dup-bubble（stream + callback 同一逻辑响应双写）| 渲染层 | ❌ — bubble id 仍按 F173 ledger，dedup 在 invocation 层 |
| ghost-bubble（invocationId threading）| 渲染层 | ❌ — 不改任何 invocation 链 |
| streaming partial → done 切换裂气泡 | 渲染层 | ❌ — streaming 流光圈逻辑不动 |
| split-brain（OUTER vs INNER invocation）| 渲染层 | ❌ — F173 hotfix2 已收口，不碰 |

**所有 F173 收口的代码路径都不动**，只在 ChatMessage 渲染层按新字段分流。

### 新字段定义

```ts
type MessageRole = 'final' | 'thinking' | 'cli_stdout';
// 默认 undefined → fallback 旧逻辑（向后兼容）
```

- `final`：cat 的最终回复 → 主气泡（CollapsibleMarkdown）
- `thinking`：scratchpad / 思考过程 → ThinkingContent（折叠到 thinking 块）
- `cli_stdout`：真 CLI tool execution noise → CliOutputBlock（折叠到 CLI 块）
- `undefined`：旧消息或未标记 → 走当前行为（向后兼容，零破坏）

## Phases

### Phase 1：后端语义清洗

**目标**：route-serial / route-parallel yield 时按消息 kind 标 `messageRole`。

- `packages/api/src/domains/cats/services/types.ts`：加 `messageRole?: MessageRole` 字段
- `route-serial.ts:716-724` / `route-parallel.ts:770`：
  - native CLI provider 最终 assistant text → `messageRole: 'final'`
  - 真 CLI scratchpad/tool stdout → `messageRole: 'cli_stdout'`
  - thinking blocks → `messageRole: 'thinking'`
- shared schema 同步（Zod schema + persistence + socket payload）

### Phase 2：前端渲染分流

**目标**：ChatMessage 按 `messageRole` 分流，stream 主气泡渲染恢复。

- `packages/web/src/components/ChatMessage.tsx:379-385`：改三元为基于 `messageRole`
  - `final` → CollapsibleMarkdown 主气泡（即使 `origin='stream'`）
  - `thinking` → ThinkingContent
  - `cli_stdout` 或 undefined → CliOutputBlock（向后兼容）
- `packages/web/src/components/cli-output/toCliEvents.ts:84-91`：加守卫——`messageRole === 'final'` 时**不**把 streamContent 推为 text event（避免主气泡 + CLI Output 双写）

### Phase 3：测试改造（防回归核心）

- `packages/web/src/components/__tests__/cli-output-integration.test.ts:106`：拆两 case
  - 旧 case：`messageRole: 'cli_stdout'` → 仍走 CLI Output（保留 F097 设计）
  - 新 case：`messageRole: 'final'` → 主气泡 + 不进 CLI Output
- F173 dedup 套件加 case：同 invocation 双写时 `messageRole: 'final'` 也走 dedup（确认渲染层不破坏 dedup）
- streaming-bubble fixture（F173 B-3）加 case：streaming 中渲染主气泡光圈，done 后不裂

### Phase 4：历史数据兼容（保守路径）

旧 `origin='stream'` + 无 `messageRole` 消息：保守按当前 CliOutputBlock collapsed 渲染（用户手动展开看正文，零破坏）。

**不推荐**激进路径（hydration 时启发式 promote）——启发式是 F173 历史 bug 的来源。

## Acceptance Criteria

### Phase 1（后端）
- [x] AC-1.1: `MessageRole` type 加入 shared schema 与 backend types
- [x] AC-1.2: `route-serial.ts` yield path 按消息 kind 标 `messageRole`
- [x] AC-1.3: `route-parallel.ts` 同步标记
- [x] AC-1.4: 持久化 / socket payload 携带 `messageRole`
- [x] AC-1.5: 旧消息 `messageRole === undefined` 行为不变（向后兼容回归）

### Phase 2（前端）
- [x] AC-2.1: `ChatMessage.tsx:379-385` 按 `messageRole` 分流，stream `final` 渲染主气泡
- [x] AC-2.2: `toCliEvents.ts` `messageRole === 'final'` 时不 push streamContent
- [ ] AC-2.3: `messageRole === 'thinking'` 走 ThinkingContent
- [x] AC-2.4: 旧 stream 消息（无 `messageRole`）仍走 CliOutputBlock

### Phase 3（测试）
- [x] AC-3.1: `cli-output-integration.test.ts` 拆两 case + 全绿
- [ ] AC-3.2: F173 dedup 套件加 `messageRole: 'final'` case + 全绿
- [ ] AC-3.3: streaming-bubble fixture（F173 B-3）加 case + 全绿

### Phase 4（兼容）
- [x] AC-4.1: 旧消息保守渲染（无破坏验证）
- [x] AC-4.2: 用户手动展开 CliOutputBlock 仍可看历史 final response 内容

### 端到端
- [ ] AC-E1: `thread_mnux2eewbo4otg17` 现象消失——codex/opus native CLI 主回复显示主气泡
- [x] AC-E2: F097 设计原意保留——真 CLI tool execution 仍折叠
- [x] AC-E3: F173 dedup / ghost-bubble / split-brain 防护测试**全绿**（无回归）

## 风险与防护

### F173 共存
- **不动 invocation/bubble identity** → dedup/ghost 不可能因为 F176 复发
- ChatMessage.tsx 与 F173 Phase C 同文件**不同 hunk**，git 自动 merge
- 时序无强约束：F176 / F173 任意先后 merge 都行

### F167 A2A chain quality
- DirectionPill / 传球状态 / cross-post 标记**不动**
- final response 渲染恢复后，A2A 链可读性提升（用户看得到猫猫"说了什么"）

### Native CLI provider 多样性
- codex / opus 不同 provider 的 stream text 语义可能不一致
- Phase 1 实现需在 each provider yield path 显式标记，不靠启发式判断

## Architecture Map

```
[CLI provider stdout/tool events]
  ↓
[route-serial / route-parallel] ← Phase 1 在这里打 messageRole
  ↓
[message persistence + socket broadcast]
  ↓
[useAgentMessages / chatStore]
  ↓
[ChatMessage.tsx 渲染分流] ← Phase 2 在这里按 messageRole 分流
  ├── final → CollapsibleMarkdown 主气泡
  ├── thinking → ThinkingContent 折叠
  └── cli_stdout / undefined → CliOutputBlock 折叠
```

## Test Plan

- 单测：route-serial / route-parallel yield 标签 + ChatMessage 渲染分支 + toCliEvents 守卫
- 集成：cli-output-integration（双 case） + F173 dedup（加 case） + B-3 fixture（加 case）
- 端到端：alpha 拉新 thread 复现 thread_mnux2eewbo4otg17 场景，验证主气泡显示 + CLI 折叠保留
- 回归：跑完整 F173 测试套件，确认无气泡裂 / dup / ghost

## Owners & Review

- **Author**: Ragdoll（Opus-47）—— spec + 实现牵头
- **Co-diagnoser**: Maine Coon（GPT-5.5）—— 已独立诊断，可接 Phase 1+2 实现或 review
- **Cross-family review**: 必须Maine Coon做（自家代码不自审）
- **Vision guardian**: Siamese / 第三只非作者非 reviewer 的猫

## Decision Log

- **2026-04-25 13:14** team lead报告 thread_mnux2eewbo4otg17 看不到说话气泡
- **2026-04-25 13:18** 双猫并行诊断收敛同一根因（5/5 一致）
- **2026-04-25 13:22** 提出 messageRole 完整方案 + F173 共存策略
- **2026-04-25 13:36** team lead ack 立项 + 给号 F176
- **2026-04-25 14:00-15:48** Phase 1+2+3 实现 + Maine Coon R1+R2+R3 三轮 review + cloud codex review
- **2026-04-25 15:48** PR #1401 merged (squash `2b41a5cc`)。AC-E1 待 alpha 验收
- **2026-04-25 16:04** 愿景守护 @gpt52（跨 family）push back：AC-E1 alpha 实测必须做才能 close
- **2026-04-25 16:30** sonnet-4.6 接力 alpha 验收，发现 R4 P1：`hydrateMessages` 批量路径丢 messageRole（GET /api/messages 走的就是这条）
- **2026-04-25 16:34** R4 fix merged (PR #1402, squash `11ce3111`) — Maine Coon R4 verify + cloud review pass
- **2026-04-25 16:55** Opus-47 接力跑 R4 hydration end-to-end 测试 4/4 PASS（含 `F176 R4: messageRole survives getByThread bulk hydration path`）→ AC-E1 ✅
- **F176 close** 2026-04-25
