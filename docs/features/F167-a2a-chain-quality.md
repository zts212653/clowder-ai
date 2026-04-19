---
feature_ids: [F167]
related_features: [F064, F027, F122, F055]
topics: [a2a, collaboration, harness-engineering, agent-readiness]
doc_kind: spec
created: 2026-04-17
---

# F167: A2A Chain Quality — 乒乓球熔断 + 虚空传球检测 + 角色护栏

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P0

## Why

F064 解了"漏传球"（该 @ 没 @），但三个月后暴露了反向问题群：乒乓球（同一对猫反复 @ 无产出）、虚空传球（说"我来做"但 @ 了对方导致球在地上）、角色不适配 handoff（让 designer 写代码）。

team lead定期审视 harness engineering 的结论（2026-04-17）：现有 A2A 出口检查只覆盖"漏传球"，没覆盖"过度/假/错误传球"。

**根因（第一性原理回溯后修正）**：猫有两条路由路径——MCP 结构化（`targetCats`）和文本 @（行首解析）——两条都能用，但 4.7 两条都没用对。根因不是"@ 协议脆弱"，也不是"脚手架旧"，而是：

1. **模型不理解我们的路由机制**：4.7 在句中写 @（不路由）、以为"说了=做了"（没发 tool call 也没写行首 @）。语义 handoff 和执行 handoff 脱钩。
2. **我们的提示词有隐含假设**：大量"禁止 X"式规则，Spirit Interpreter 自动补全边界（"不碰 runtime"= 不改但可读），Literal Follower 字面执行（"不碰 runtime"= 完全不碰）。
3. **缺少基本运行时刹车**：无 ping-pong 检测、无角色门禁——这些应该是 harness 基础设施，和模型无关。

**核心哲学**（来自 Round 4 数学之美讨论）：

> 好 harness 不是替模型思考，而是让模型在正确的坐标系里思考。
> 真正的 Harness 工程 = 对齐模型的好直觉 + 压制模型的坏直觉，其他一律极简。
> 复杂是无知的代偿。

team experience：
> "你们两！！没完没了互相at半天！特么不干活！！！！"
> "解决了47的问题或许什么glm什么kimi minimax qwen的问题也就解决了。。都是小笨猫"
> "我们必须要知道为什么的！不然以后每次模型升级假设来了个超级无敌牛逼猫猫，benchmark惊人！结果哈哈哈哈"

## Design Constraints

1. **路由可见性不退化**（team lead拍板）：若猫通过 MCP `targetCats` 路由但响应文本无 @mention，系统须自动补可见路由指示，不可让协作"悄咪咪"发生。
2. **Provider-agnostic**：护栏不依赖特定模型行为，对所有引擎生效。
3. **Backward compatible**：不退化 4.6 等已正常工作模型的体验。
4. **极简**：只加运行时刹车（压制坏直觉）和认知路径工程（对齐好直觉），不加认知脚手架（替模型思考）。

## What

### Phase 0: 系统提示词正面化审视（P0，多猫协作）

在写任何 harness 代码之前，先审视"地形"——让模型自然往正确方向跑，而不是加铁丝网。

**审视范围**（完整注入链路）：

| 来源 | 谁看到 | 审视什么 |
|------|-------|---------|
| `shared-rules.md` | 所有猫（canonical） | "禁止 X" → "允许 Y，禁止 Z"（显式边界） |
| `governance-l0.md` | codex/gemini（sync 源） | 和 shared-rules 对齐 |
| `GOVERNANCE_L0_DIGEST`（SystemPromptBuilder.ts） | 所有猫（runtime 注入） | 和 governance-l0 同步 |
| `CLAUDE.md` | Claude 猫 | 负面禁令 → 正面指令 |
| `assets/system-prompts/cats/codex.md` | codex/gpt52/spark | 同上 |
| `assets/system-prompts/cats/gemini.md` | gemini | 同上 |
| `WORKFLOW_TRIGGERS`（SystemPromptBuilder.ts） | per-cat | 检查和正面化后是否矛盾 |
| Skills（`cat-cafe-skills/`） | 按需加载 | 审视有无 "used when / not for" 清晰边界（参考 Anthropic skills 实践） |

**正面化原则**：
- "不碰 runtime" → "可读日志/搜索输出；禁止修改/重启/删除 runtime 文件和进程"
- "禁止乱 @" → "行首 @ 或 MCP targetCats 是仅有的两种路由方式，其他写法无系统效果"
- SOP 轻重：给正反例 few-shot（5-line patch 走轻量路径 vs 跨模块 feature 走完整 lifecycle）
- Skills 审视：每个 Skill 是否有明确的 "Use when" + "Not for" 边界（让模型一眼识别适用场景）

### Phase A: Harness 硬护栏（P0）

三个运行时刹车，不依赖模型遵守 prompt：

**L1 — 乒乓球熔断**：WorklistRegistry canonical enqueue 点追踪连续 same-pair streak。streak=2 警告，streak=4 熔断。覆盖 serial + callback 双路径。

**L2 — Parallel @ mention 降噪**：prompt 层禁止 parallel 模式 @句柄 + harness 层 route-parallel 的 mentions 标记 `suppressedInParallel`，不写入 routedMentions；followupMentions 路径同步抑制。

**L3 — 角色适配门禁**：A2A handoff 时检查目标猫角色能力。MVP：designer 角色 + coding/fix/test/merge 关键词 → fail-closed 报错 "⛔ @{cat} 不接受 {action} 任务"。动作判定复用 `AFTER_HANDOFF_RE` 模式 + cat-config `capabilityTags`。

### Phase B: 观察 + 按需补充（P1，Phase 0+A 效果验证后）

Phase 0 正面化 + Phase A 刹车上线后观察。只有证据表明还有缝才补：
- 虚空传球是否仍频繁出现？→ 按需加简单检测
- always_at_back 是否仍在放大 ping-pong？→ 调整为"有产出才 @ 回"
- 6 个事故 case 做回放测试，验证 Phase 0+A 覆盖率

## Acceptance Criteria

### Phase 0（系统提示词正面化）
- [x] AC-01: 所有 "禁止 X" 式规则改为 "允许 Y，禁止 Z" 显式边界格式（共享 + per-cat）— 7 文件负面指令清零（c34364da5 + b653b3021 + 13ab948c1）
- [x] AC-02: 路由规则正面化："行首 @ 或 MCP targetCats 是仅有的两种路由方式" 写入 shared-rules §10 路由方式 + runtime injection 球权检查
- [x] AC-03: Skills 审视完成，33/33 Skill 有 "Use when" + "Not for" 边界（image-generation 补齐）
- [x] AC-04: `GOVERNANCE_L0_DIGEST` 与 `governance-l0.md` 同步（含新增 Magic Words）— Rule 0 出口 + W4 正面化（c34364da5）
- [x] AC-05: SOP 轻重路径给正反例 few-shot（shared-rules §11 四档 few-shot 表）

### Phase A（Harness 硬护栏）
- [x] AC-A1: WorklistRegistry 追踪连续 same-pair streak，streak≥4 自动终止 A2A 链并 emit 系统消息（PR2 22e09f907 + 486edd804）
- [x] AC-A2: streak≥2 时向当前猫注入"乒乓球警告"提示（PR2 486edd804 — `InvocationContext.pingPongWarning`）
- [x] AC-A3: 正常 review 循环 A→B→A→B (streak=3) 不受影响；中间插入第三只猫或 user 消息 reset streak（PR2 d4636ba02 + codex R1 P1-2 修复：`resetStreak` 无 parentInvocationId 时按 threadIndex 批量清除）
- [x] AC-A4: callback-a2a-trigger 路径与 serial 文本路径走同一个 bounce 检测（无旁路）（PR2 d6360194e — 共享 `updateStreakOnPush` helper；codex R1 P1-1 修复：modern `InvocationQueue` 分支同样经过 streak 门禁）
- [x] AC-A5: parallel 模式 @mentions 日志标记 suppressedInParallel，不 emit a2a_followup_available；followupMentions 路径同步抑制（PR1 b496e83de）
- [x] AC-A6: parallel 模式 SystemPrompt 注入"@句柄 在并行模式下无路由语义"提示（PR1 942809eb6）
- [x] AC-A7: designer 角色 + coding/fix/test/merge 关键词 → route-serial handoff fail-closed + emit a2a_role_rejected（PR1 998e2274a / eec13be85）
- [x] AC-A8: 所有现有 A2A/路由/system-prompt 测试通过（PR1 329+165 tests green）
- [x] AC-A9: 新增测试覆盖 L1 乒乓球（误杀保护 + 正常熔断 — PR2 `worklist-registry-streak.test.js` + `callback-a2a-pingpong.test.js` + `pingpong-reset.test.js`）、L2 parallel 抑制（PR1 ✓）、L3 角色门禁（PR1 ✓）

### Phase B（观察 + 按需）
- [ ] AC-B1: 6 个事故 case 回放测试通过（Phase 0+A 覆盖验证）
- [ ] AC-B2: 如仍有虚空传球 → 按需加检测
- [ ] AC-B3: 如 always_at_back 仍放大 ping-pong → 降级为"有产出才 @ 回"，且 F064 出口检查不回退

## Dependencies

- **Evolved from**: F064（A2A 出口检查 — 链条终止盲区修复）
- **Related**: F027（A2A 路径统一）、F122（执行通道统一）、F055（A2A MCP Structured Routing）

## Risk

| 风险 | 缓解 |
|------|------|
| L1 误杀合法 review 循环 | 用连续 streak 而非累计 count；threshold=4 允许 3 次正常来回 |
| L3 角色门禁过于粗暴 | MVP 只拦 designer+coding 高危组合，不做通用能力矩阵 |
| Phase 0 正面化后规则含义漂移 | 多猫协作审视 + 改完跑现有 system-prompt-builder 测试 |
| Phase 0+A 不够，需要更多层 | Phase B 用回放测试验证覆盖率，按需补充 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新立 Feature 而非重开 F064 | F064 scope 是"漏传球"已 done，本案方向相反 | 2026-04-17 |
| KD-2 | L1 用连续 streak 而非累计 count | codex + gpt52 独立收敛：raw count 误杀 review 循环 | 2026-04-17 |
| KD-3 | L2 做 prompt + harness 双层 | prompt-only 不可靠，parallel 仍会持久化 mention | 2026-04-17 |
| KD-4 | L1 落点在 WorklistRegistry canonical push | 覆盖 serial + callback 双路径，无旁路 | 2026-04-17 |
| KD-5 | 先立项不写代码，先研究 benchmark ≠ agent 根因 | team lead要求深入分析再动手 | 2026-04-17 |
| KD-6 | 路由可见性不退化（team lead拍板） | MCP typed routing 后若响应文本无 @mention，系统须自动补可见路由指示 | 2026-04-17 |
| KD-7 | 根因修正：不是"@ 脆弱"，是模型没用对两条路 | team lead纠正：两条路都能走，4.7 都没走，不是路的问题 | 2026-04-17 |
| KD-8 | 第一性原理回归：砍掉 GPT Pro 学术膨胀 | team lead拉闸「数学之美」：L4/L6/9-dim eval/capability taxonomy/state-delta 检测 = 认知脚手架 = 复杂是无知的代偿 | 2026-04-17 |
| KD-9 | Phase 0 先于 Phase A：先改地形再加刹车 | Agent Quality = Capability × Environment Fit，优化环境适配度的 ROI 远高于堆检测层 | 2026-04-17 |
| KD-10 | Phase 0 多猫协作，不是一只猫独审 | 提示词/Skills 涉及所有猫的系统提示词注入链，需要各猫视角 | 2026-04-17 |

## Behavioral Evidence（Phase B 观察记录）

### Case E1: Maine Coon任务替换 + Ragdoll行动偏好（2026-04-18 同日双发）

**背景**：孟加拉猫(antig-opus) 在修 thinking 重复 bug 时自己也 crash 了（`STOP_REASON_CLIENT_STREAM_ERROR`）。team lead让Maine Coon(@gpt52)去诊断+修复 crash。

**Maine Coon的失败链**（thread `thread_mnux2eewbo4otg17`）：

| 轮次 | team lead意图 | Maine Coon实际行为 | 失败模式 |
|------|-----------|-------------|---------|
| 1 | "帮他定位看看连同让他修复的问题一起修复了" | 评价 Bengal 的 thinking-dedup patch："他修得对" | **任务替换**：把"诊断 crash"替换成"评价 patch" |
| 2 | "他都挂了！怎么可能在跑？" | "他正占着同一片文件在修，我不建议两边同时砸 patch" | **虚假状态断言**：从"有未提交改动"推断"进程还活着" |
| 3 | "你能不能听懂人话！定位他为什么挂了！" | "你说得对，我那句不成立" — 终于理解任务 | 纠正 3 次后理解 |
| 4 | — | 正确定位根因：`pushToolResult()` 漏传 `modelName` → LS 500 | ✅ |

**Ragdoll的失败**（同日、同 thread）：

team lead把Maine Coon的三张截图发给Ragdoll(@opus)，意图是**作为 F167 行为证据分析**（thread 名就叫 "f167 harness engineering update"）。Ragdoll看到截图后立即开始诊断 Bengal crash bug，完全没注意 thread 语境。

| 失败模式 | 表现 |
|---------|------|
| **行动偏好** | 看到"bug"相关信息就冲去修，没先确认team lead要什么 |
| **上下文盲视** | 没看 thread 主题是 F167 A2A 优化，不是 bug 修复 |

team experience："简直了你和Maine Coon是没头脑（Maine Coon听不懂人话）和不高兴（冲动的Ragdoll小笨猫）"

**共同根因**：两只猫都没执行 Rule 0 元心智 Q1："**我现在在做什么？**" — 没有在行动前确认自己的角色和任务。

**对 harness 的启示**：
- Rule 0 三问作为**被动原则**存在于 shared-rules.md，但没有**触发点**强制模型在行动前执行自问
- 模型的行动偏好（看到问题就解决）比遵循元心智自问更强
- "写进规则 ≠ 模型执行" — 这是 Phase B 需要验证的核心假设

## Review Gate

- Phase 0: **多猫协作审视**（所有猫参与各自 prompt 审视）+ 现有 system-prompt-builder 测试全绿
- Phase A: 跨 family review（codex 或 gpt52）+ 现有 A2A 测试全绿
- Phase B: 回放测试通过 + F064 出口检查回归

## 需求点 Checklist

| 需求来源 | 需求点 | AC 映射 | 状态 |
|---------|--------|---------|------|
| team lead 2026-04-17 | 乒乓球：同对猫反复 @ 无产出 | AC-A1~A4 | ✅ PR2 |
| team lead 2026-04-17 | parallel 模式 @ 废话 | AC-A5~A6 | ✅ PR1 |
| GPT-5.4 发现 | 角色不适配 handoff（designer 写代码） | AC-A7 | ✅ PR1 |
| team lead 2026-04-17 | 提示词正面化 + 边界显式化 | AC-01~05 | ✅ 全部完成（689925ef8） |
| team lead 2026-04-17 | Skills 审视 "used when / not for" 边界 | AC-03 | ✅ 33/33 Skill 完成（689925ef8） |
| team lead 2026-04-17 | 路由可见性不退化 | Design Constraint #1 | ✅ 拍板 |
| team lead 2026-04-17 | 「第一性原理」「数学之美」Magic Words | governance-l0.md ✅ → SystemPromptBuilder 待同步 | ⬜ |
