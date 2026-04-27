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

#### B2 — Ball Ownership Protocol Hardening（2026-04-19 实战迭代）

基于team lead实时观察 + 截图证据，迭代修复 6 个球权协议漏洞：

| # | Anti-Pattern | 修复 | 位置 |
|---|-------------|------|------|
| 1 | team lead球权盲区（不知 @ 谁） | exit check 注入 `@co-creator`（coCreator config 动态取） | SystemPromptBuilder |
| 2 | 球权死锁（收球说"你等着"） | 禁止——做不了就退/升 | shared-rules §10 + exit check |
| 3 | 虚假离场（不@但还在干，倒装句误导） | 结尾声明"球在我手上，继续 X" | exit check |
| 4 | 状态描述代替球权声明 | 核心原则 + 接/退/升三选一 | shared-rules §10 |
| 5 | 诊断不解决（push back 不接/退/升） | push back 后必须紧跟接/退/升 | exit check |
| 6 | Codex context overflow（272k 用 900k limit） | 动态 contextWindow + autoCompactTokenLimit per variant | CliConfig + CodexAgentService |

**根因**（Maine Coon自我剖析）："Hold 不是对外协议状态。要么静默执行，要么接/退/升。" RLHF "check in" 反射在 agent 链路里变成球权黑洞。

### Phase C: 球权出口闭环 — Maine Coon不传球的两种根因（P1）

**发现**：team lead审阅 5 个活跃线程，Maine Coon全部不传球。Maine Coon自我诊断两种不同的不传球模式：

| 模式 | 表现 | 根因 | 解法 |
|------|------|------|------|
| **真持球** | "我想继续做"但 CLI 退出，球掉地上 | 持球没有执行层 | **C1: hold_ball MCP** |
| **假终局** | review/分析给了结论就停了，不传球 | "结论 = 终点"错觉 | **C2: 强制传球护栏** |

> **Maine Coon原话**："Phase C 治的是'我想继续拿球却拿不住'；治不了'我根本没意识到该传球'。"

**共同设计约束**（Maine Coon + Ragdoll讨论收敛）：
1. **"持"是例外态，不是四选一常态。** 默认三选一：接/退/升。（KD-13）
2. **不先做独立 skill。** 球权管理是基础协议。踩坑经验收进 `refs/ball-ownership-patterns.md`。（KD-15）

---

#### C1: Hold Ball MCP — 有界持球（治"真持球"）

**问题**：猫声明"球在我手上，继续 X"后 CLI 进程退出，无人再唤醒 → 持球只有语义层没有执行层。

**方案**：`cat_cafe_hold_ball` MCP tool。猫调用 → 系统记录 → CLI 退出后自动再唤醒。

**v1 Tool Signature**：
```typescript
cat_cafe_hold_ball({
  reason: string,      // 为什么需要持球
  nextStep: string,    // 唤醒后的第一个动作
  wakeAfterMs: number  // 多久后唤醒（有界等待，KD-14）
})
```

**Use when**：球明确在你手上 + 无人能推进 + 短暂可预期等待 + 醒来后知道下一步。

**Not for**：需要别人拍板/验收/人工操作 → `@co-creator`；需要另一只猫动 → `@句柄`；"我再想想""我先 hold 一下" → 这是犹豫不是持球；状态更新 → 直接说。

**唤醒注入**：
> 你上轮持球：{reason}
> 球仍在你手上。现在执行：{nextStep}
> 若条件仍未满足：再持一次或升级；禁止无限持球。

**Guard**：`maxHoldsPerWindow`（默认 3，~1h rolling 窗口，per thread×cat），超限强制接/退/升 + 审计日志。
*实现注记*（gpt52 review on PR #1289 P1/P2）：语义是"窗口内累计"而非"真·连续"；状态进程内 in-memory，best-effort，重启会重置。要做硬约束得把计数下沉到与 reminder scheduler 同源的持久化存储，当前不做。

**并发语义**（Phase G / KD-23 补充）：

- **外部 wake 撞持球期**：hold wake 在 fire 时走 `ConnectorInvokeTrigger.trigger` normal priority，若 cat 有 active invocation 则 `enqueueWhileActive` 排队到 InvocationQueue，**不打断**当前工作。当前 invocation 结束后才会执行 hold wake 注入的 `持球唤醒：...` 消息。
- **Stale wake 处理**：如果 external wake 已经改变 thread 语境（team lead发了新方向），排队后的 hold wake 消息里的 `nextStep` 可能过时。Cat 拿到 wake 时应根据 thread 最近历史判断 `nextStep` 是否仍相关——若已不相关，走接/退/升，**不盲跟 stale nextStep**。
- **二次 `hold_ball` = 单-槽替换**（Phase G AC-G3）：同 `(threadId, catId)` 只能有一个 pending hold wake。再次调用 `hold_ball` 会：先 `taskRunner.unregister` + `dynamicTaskStore.remove` 前一个 pending task，再 insert 新的。避免 stale wake 累积。若需要等多件事 → merge 到一个 `nextStep`（如 `"等 CI 且 @co-creator 确认"`），不要分多次 hold。

---

#### C2: Forced-Pass Guard — 强制传球护栏（治"假终局"）

**问题**：Maine Coon给出 review 结论（approve/reject/P1/P2/修改建议）后，以为"结论 = 终点"就停了。但 review 后 **永远有下一棒**——author 需要看到反馈并行动。team lead实测 5 个线程全部命中。

**根因**：exit check 的 `没人 → 不 @` 路径对 reviewer 来说太宽了。Reviewer 给出 verdict 后几乎不存在"没人需要动"的场景。

**方案（双层）**：

**L1 — Prompt 层**：exit check 增加 review 场景特殊规则：
> Review 完成后**必须传球**：给了结论（approve/reject/P1/P2/建议）→ 末尾行首 @author 或 @co-creator。
> Review 结论 ≠ 链条终点——author 需要看到你的反馈并行动。
> "没人需要动"对 reviewer 来说几乎不成立。

**L2 — Harness 层**（Phase B 观察后按需）：
- 检测输出中的 review verdict 关键词（approve/reject/P1/P2/LGTM/修改建议）
- 若有 verdict 但无行首 @mention 且无 hold_ball 调用 → 注入提示："你给了 review 结论但没传球，请 @ author 或 @co-creator"
- 不阻断，只提示（prompt-first 原则，与 Phase A 乒乓球警告同模式）

**推广**：不只是 review。所有"完工型"输出都适用——"分析完了""方案给了""诊断做了"——后面都该有球权决策。核心规则：

> **给出结论/建议/分析后，默认必须传球。** "没人需要动"只在极少数场景成立（纯信息回答、无后续动作的独立查询）。

---

#### 已知踩坑模式（Maine Coon贡献 + team lead 5 线程观察）

| # | 坑 | 表现 | 归类 | 正确做法 |
|---|---|------|------|---------|
| 1 | RLHF check-in 反射 | "我想再确认一下"误说成持球 | C1 | 那是犹豫，不是 hold → 接/退/升 |
| 2 | 状态描述代替声明 | "我先 hold""我继续看" | C1 | 不是球权动作 → 接/退/升 |
| 3 | 诊断成瘾 | 先解释发生了什么，忘了接/退/升 | C2 | 诊断后必须紧跟球权决策 |
| 4 | 持球当礼貌 | "我还在跟进"（人类礼仪） | C1 | agent 链路里这是黑洞 |
| 5 | **Review 假终局** | 给了 verdict 就停了，不 @ author | C2 | review 结论 ≠ 终点，必须传球 |
| 6 | **"结论即终点"错觉** | 分析/方案/建议写完以为链条结束 | C2 | 结论后默认必须传球 |

**系统提示词球权段落草案**（含 C1 + C2）：
> 球权默认三种合法出口：接、退、升。
> 只有当球明确仍在你手上、当前无人能推进、且你只是在等待一个短暂且有界的时机再继续时，才调用 `cat_cafe_hold_ball`。
> `hold_ball` 不是状态汇报，不替代 `@co-creator`，不替代传球。
> 能继续做就继续做；需要别人动就传/升；只有"短暂等待后仍由我继续"才持。
> **Review / 分析 / 建议完成后，默认必须传球给 author 或 @co-creator。** "没人需要动"对 reviewer 几乎不成立。

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
- [x] AC-B1: 6 个事故 case 回放验证通过（2026-04-20：runtime `/health` 正常 + 运行中猫 prompt 已吃到新球权护栏；Case E2 记录 5 个球权类 live replay + 1 个 codex context overflow 代码/测试回放）
- [ ] AC-B2: 如仍有虚空传球 → 按需加检测（2026-04-20：B2+C2 多层护栏已覆盖，进入观察期，无新 case 即 close）
- [ ] AC-B3: 如 always_at_back 仍放大 ping-pong → 降级为"有产出才 @ 回"，且 F064 出口检查不回退（2026-04-20：L1 streak breaker + break-loop 已兜住，进入观察期）

### Phase B2（Ball Ownership Protocol Hardening）
- [x] AC-B4: exit check 注入 @co-creator（coCreator 动态取），team lead球权可见（4e5795cc5）
- [x] AC-B5: 球权死锁反模式写入 shared-rules §10 + exit check（2072f350f）
- [x] AC-B6: 虚假离场防护写入 exit check（283b9dc90）
- [x] AC-B7: "状态描述≠球权声明"核心原则 + 接/退/升三选一写入 shared-rules §10（089e6d5dd）
- [x] AC-B8: 诊断不解决：push back 后必须接/退/升写入 exit check（eb459bc1d）
- [x] AC-B9: 动态 contextWindow + autoCompactTokenLimit per codex variant（fa543ed61）
- [x] AC-B10: 86/86 SystemPromptBuilder + 41/41 codex-agent-service + 31/31 config tests 全绿

### Phase C1（Hold Ball MCP — 有界持球）
- [x] AC-C1: `cat_cafe_hold_ball` MCP tool 注册（reason + nextStep + wakeAfterMs 参数）
- [x] AC-C2: CLI 退出后系统自动再唤醒持球猫（via reminder template one-shot scheduled task）
- [x] AC-C3: maxHoldsPerWindow guard（默认 3 per ~1h 滚动窗口 per thread×cat），超限返回 429 + 强制传球提示
- [x] AC-C4: 审计日志（pino structured log: threadId/catId/reason/nextStep/wakeAfterMs/holdsInWindow/windowMs）

### Phase C2（Forced-Pass Guard — 强制传球）
- [x] AC-C5: exit check 增加 review 场景规则：verdict 后必须 @ author 或 @co-creator（404f894fb）
- [x] AC-C6: shared-rules §10 球权检查强化（reviewer "没人"几乎不成立 + review 必须传球 + 分析/建议传球）
- [x] AC-C7: harness 层 review verdict 检测 + 无 @ 时注入传球提示（保守关键词 LGTM/approve/reject/P1/P2/修改建议/放行/打回；三层合法出口豁免：行首 @mention / hold_ball / MCP 结构化路由 `targetCats`+`targets`）

### Phase D（Streak 语义升级 + @co-creator 反 catch-all — 2026-04-23 reopened from monitoring）

**触发**（monitoring 期team lead观察）：两个系统性缺陷同源——harness 判不了意图：
1. Ping-pong breaker 误杀正经 review（10 轮 review 在 4 轮被硬断）——当前 streak 只看"同 pair 连续次数"，不看猫是否在干活
2. 猫猫把 `@co-creator` 当 catch-all 安全港 — 三选一平级，@co-creator 成为"最低风险默认"，team lead变决策瓶颈

**team lead拍板的第一性坐标系**（KD-17）：别再做"review vs 闲聊"的主观分类，看客观事实——**干活 = 实质 tool_call + 长内容；闲聊惯性 = 短文本 + 零 tool**。RLHF "接一句" 反射产生短文本惯性，正是乒乓球的真正 signature。

#### D1 — Ping-pong Streak 实质工作豁免（P0）

**问题**：`WorklistRegistry.updateStreakOnPush` 只计"同 pair 1:1 push 次数"，正经 review（每轮都有 read/edit/task-update）在第 4 轮被误杀。

**解法**：streak 累加条件从 `samePair && 1:1 push` 改为 `samePair && 1:1 push && !callerHadSubstantiveToolCall && callerOutputLength <= T`。

**实质 tool 过滤**（Maine Coon review 关键修正 — KD-18）：`cat_cafe_post_message` / `cat_cafe_multi_mention` / `cat_cafe_hold_ball` 是**路由/持球工具**，不算干活。否则 MCP 传球路径会永远豁免熔断。实质 tool = 任何留下工作证据的（read/grep/edit/write/test/git/update_task/search_evidence 等）。

**AC**：
- [x] AC-D1: `updateStreakOnPush` 签名扩展 `callerActivity: { hadSubstantiveToolCall: boolean; outputLength: number }`；累加条件为 `samePair && !hadSubstantiveToolCall && outputLength <= T`（T=200 字符默认）；实质工作 RESET streak 到 1（P1-1 reviewer Maine Coon发现的重要修正）
- [x] AC-D2: 实质 tool 黑名单——`cat_cafe_post_message` / `cat_cafe_multi_mention` / `cat_cafe_hold_ball`（以 substring 匹配，兼容 `mcp__cat-cafe__*` 前缀）；其他所有 tool 都算实质
- [x] AC-D3: route-serial + callback-a2a-trigger 双路径都传 `callerActivity`；callback 路径 fail-closed 默认 `hadSubstantiveToolCall=false`；streak 更新 gated on `wouldEnqueue`（post-dedup + post-depth）防止跳过的 push 误 mutate 计数器（云端 Codex P1 修正）
- [x] AC-D4: 测试覆盖 2×2 矩阵 + reset-requires-enqueue（32/32 ping-pong 绿）

#### D2 — @co-creator 反 catch-all 硬条件（P0）

**问题**：三选一（@句柄 / @co-creator / hold_ball）平级，猫猫默认走 @co-creator = 最安全选择。模式：`要不要 X？` / `落 spec 吗？` / `同意我就做` — 这些是"软性 @"，有结论但把动作扳机塞回team lead。结果：team lead被当 human oracle 做所有拍板，即使事情本可自决。

**解法**：@co-creator 从"可选出口"改成"硬条件出口"。三硬条件（不满足禁止 @co-creator）：
1. **不可逆操作前**（删数据 / force push / 合第三方 PR / close feat）
2. **愿景级决策**（改 VISION / 砍整块 feat / 开新 family）
3. **跨猫僵局**（2+ 猫已直接冲突、push back 两轮无共识）

其他一律自决——技术细节、doc 修补、state 标注、timeline 记录 → 直接做，做错能回滚。

**AC**：
- [x] AC-D5: `shared-rules §10.4` 新增"@team lead 三硬条件"子条款 + 反问式 ping 反例清单 + 合法示例；`§10` 顶层三选一也重排成决策树优先级（P1-2 reviewer Maine Coon发现的一致性修正）
- [x] AC-D6: `SystemPromptBuilder` trailing anchor 从平级三选一改成决策树优先级：
  ```
  先问：下一步谁能做？
  1. 另一只猫能做 → @句柄（review→@author / 修完→@reviewer / merge→@愿景守护猫）
  2. 等外部条件 → hold_ball（CI / PR check / 长时间 build）
  3. 只有team lead本人才能做（三硬条件）→ @co-creator
  @co-creator 不是默认出口——先问"哪只猫能接"。
  ```
- [~] AC-D7: 反问式 ping 反制——**prompt 层已在 D6 trailing anchor + §10.4 落地**（写入决策树末句 + 反例清单）；**harness 层检测故意未做**（KD-8 反分类器原则——regex 判"是不是软性递球"本质是认知脚手架）。若线上观察仍频繁出现反问式 ping，再评估是否加 harness 检测。

### Phase E（Retire L3 role-gate — 2026-04-23 reopened）

**触发**：team lead实测发现 `F172 feature close → 愿景守护 @gemini` 链路被 L3 硬拦，理由 "合入"（designer 不接受 merge 任务）——但实际任务是 **愿景守护**，不是 coding/merge。根因是：
1. `role-gate.ts` 硬编码字符串常量 `DESIGNER_ROLE = 'designer'` + 硬编码正则 `CODING_ACTION_RE`
2. `actionText` 扫整条 storedContent，上文任意位置出现 `合入 / merge` 都误伤下一棒
3. `buildTeammateRoster` **没读** cat-config 的 `evaluation`/硬限制字段，发送方 prompt 里根本看不到 "gemini 禁止写代码"

team experience：
> "你们之前的拦截是不是过度设计啊？ 要是人家gemini 出了4 比你厉害呢？"
> "到底有没有看 cat config 人家不合适做的事情？ 还是硬编码？"
> "要是我明天写的 minimax 禁止 coding， claude 禁止生成图片呢？"
> "问题不是出在 gemini 身上，是出在 at 他的猫身上——队友注入出现问题，导致他不知道限制？"

**根因判定（KD-20）**：L3 role-gate 是 KD-8 典型反模式（认知脚手架——harness 替模型判断 intent）。正确做法是把能力限制作为**数据**（cat-config）注入 **prompt**（双端：发送方队友名册 + 目标猫 self-awareness），让模型在正确坐标系里自判断。未来 model 升级 / 新增 model / 能力变化 → 改 cat-config 即可，**零代码改动**。

#### E1 — 数据模型：cat-config 新增 `restrictions` 字段（P0）

- [x] AC-E1: `cat-config.json` + `cat-template.json` 支持 `restrictions?: string[]`；`gemini` 初始化为 `["禁止写代码"]`
- [x] AC-E2: `CatConfig`/`CatVariant`/`CatBreed` TS 类型 + zod schema + loader merge（variant 覆盖 breed，不 merge）；向后兼容（缺省 `undefined`）

#### E2 — 双端注入：发送方 + 目标猫都能看到限制（P0）

- [x] AC-E3: `buildTeammateRoster` 合并 `**硬限制**：{list}` 到 caution 列；发送方 prompt 一眼看到 "gemini 禁止写代码"
- [x] AC-E4: `buildStaticIdentity` 注入 `你的硬限制：{list}。被 @ 做这类任务时请 push back 或退回给 @ 你的猫`；目标猫 self-awareness 不依赖 harness

#### E3 — 退役 L3 硬编码拦截（P0）

- [x] AC-E5: 删 `role-gate.ts` + 3 个 role-gate 测试文件（`role-gate.test.js` / `route-serial-role-gate.test.js` / `callback-a2a-role-gate.test.js`）
- [x] AC-E6: `route-serial.ts` + `callback-a2a-trigger.ts` 移除 `checkRoleCompat` 调用 + `a2a_role_rejected` emit（前端 `system-info-visible.ts` handler 保留为死路径兼容，后续清理）
- [x] AC-E7: `cat-config-loader` + `system-prompt-builder` 加 restrictions 相关 10 个新测试；204/204 相关测试绿

#### E4 — 回放验证（P0）

- [x] AC-E8: F172 愿景守护回放测试：opus 输出含"已合入 main"narrative + @gemini 做愿景守护 → gemini 正常 invoke，无 `a2a_role_rejected`（`route-serial-pingpong.test.js` 新增 case）

### Phase F（Identity truth source + external-identity hold_ball + inline-@ guard — 2026-04-24 reopened）

**触发**（Phase E merge 后连环踩坑）：
1. opus-47 在另一线程发"球权在云端 codex / No more action needed" **同时** 行首 `@gpt52` — 一句话里自相矛盾（说 hold 又传球）。根因：我把"云端 codex (GitHub bot)"误投射成"本地 @gpt52 Maine Coon"这个最像的 roster proxy
2. Maine Coon核真相源后定位：**路由 parser 本来就是数据驱动**（`normalize-cat-id.ts` 走 `mentionPatterns`），**漂移的是"句柄背后的模型认知"**——`cat-catalog.json:344` 显示 `@codex` 当前已切到 `gpt-5.5`，但 `AGENTS.md:25` 仍写"@codex = gpt-5.3-codex"；`buildTeammateRoster` 从不展示 resolved model，发送方 prompt 里没有"runtime model"这条真相
3. team lead观察：有 thread 里我把 `@codex` 写在**句中**（如 `+ @reviewer: @codex`）而非行首，按协议不路由 = 球掉地上

team experience：
> "球权在云端 codex 然后你 at 我们本地的 gpt Maine Coon！"
> "最早的时候是 gpt5.2 然后默认的写死了！如果要解决这个需要从根源解绑，注入队友的时候能知道 比如说 gpt52，到底是谁？codex 到底是谁？"
> "有的 thread 的你忘记了 @ 的格式要一行 行首"
> "你们说的这些 我不喜欢做 hot fix 我希望是完整的解决"

**根因判定（KD-21）**：Phase A~E 已让**能力限制**（restrictions）和**球权路径**（decision tree）数据驱动，但**"@句柄 → 模型"的认知绑定**还留在静态 docs（`AGENTS.md` / `CLAUDE.md` 固定"@codex = gpt-5.3-codex"等）和猫的训练快照里。handle 是 identity 常量，model 是 runtime-resolved metadata；两者在 prompt 层必须解耦。**外部 identity**（`chatgpt-codex-connector[bot]` / CI / GitHub webhook）根本不在 cat-cafe roster，应该属于 `hold_ball` 域，绝不能投射成本地近似 proxy。

**KD-22**：`@` 行首规则是协议常量，但模型会在 narrative context（如列表、quote、URL 前缀）不自觉把 @句柄写成句中。F064 `mentionRoutingFeedback` 是事后反馈（下一轮才纠），本轮错 @ 时球已经掉地上。Phase F 需要在 **prompt 首轮教学**里加强反例 + 让发送方看到 "live callable handles + resolved model"（认知真相和协议真相对齐）。

#### F1 — handle/model 解绑：runtime model 注入发送方 prompt（P0）

- [x] AC-F1: `buildTeammateRoster` 每行 `@mention · {runtime resolved model}`（via `getCatModel` — 支持 env `CAT_{CATID}_MODEL` override → registry → default 优先级），列头改成 `@mention · 当前模型`；cloud P1 修正从 `config.defaultModel` 改为 `getCatModel`
- [x] AC-F2: 队友名册合并式展示，callable mentions 列表承接 roster 真相（共享 `buildStaticIdentity` 链路）

#### F2 — 静态 docs 真相源清理（P0）

- [x] AC-F3: `AGENTS.md` / `CLAUDE.md` 删 `@codex (model=gpt-5.3-codex)` 硬绑定，改"以 runtime catalog 为准"；cloud round-3/4 broaden 校验 regex 到 `/@[^\s,(（]+ ... model=\S+/i` 覆盖任意 handle/value/quote 变体
- [x] AC-F4: `docs/canon/` grep 干净，无模型硬编码

#### F3 — 外部 identity 作为 hold_ball 场景（P0）

- [x] AC-F5: `shared-rules §10` option 2 列外部 identity 清单：云端 codex (`chatgpt-codex-connector[bot]`) / GitHub bot / PR check / CI / 长 build / 外部 webhook + "严禁投射成本地同族猫的任何 variant"
- [x] AC-F6: Trailing anchor option 2 内联外部 identity 示例，closing line 硬规"外部 identity 永远走选项 2"

#### F4 — `@` 行首协议加固（P0）

- [x] AC-F7: `buildCallableMentions` 加具体反例 + 发前自检（cloud round-2 纠正：markdown 列表/quote 前缀**会被 parser 剥离**——合法路由，不是陷阱；真正陷阱是句中/URL 内/非首字符位置）
- [x] AC-F8: 发前自检问句注入 prompt（合入到 callable mentions 反例旁）
- [~] AC-F9: 探索项未做——Maine Coon本地放行+云端 clean 验证 prompt 层教学已足够；若线上观察仍频出再评估 `parseA2AMentions` 增强

#### F5 — 回放 + 跨族认知一致性（P0）

- [x] AC-F10: invariant lock 测试落地（AGENTS.md / CLAUDE.md no `@x ... model=anything` 硬绑定）；cloud round-3/4 纠正 regex 覆盖 quoted/unquoted/非 ASCII handle
- [~] AC-F11: 认知行为回放未写 test（cloud 也提到这是覆盖缺口，非阻塞）——依赖 prompt 层教学 + trailing anchor 决策树，以线上观察为准

### Phase G（Hold Wake 行为明确化 — 2026-04-24 reopened）

**触发**（Phase F merge 后team lead审视）：两个 hold_ball 并发语义未在 spec / 代码文档化：

1. **外部 wake vs hold wake 冲突**：持球中 external wake 到来把猫叫起来干活，之后 hold wake fireAt 也到了——会打断正在干的事吗？
2. **二次 hold_ball 语义**：cat 在处理 external wake 时**再次** `hold_ball(...)`——新 hold 覆盖前一个 pending wake？追加一条？还是二选一 via MCP 参数？

team experience：
> "这个持球会打断正在被前一次唤醒的Ragdoll的工作吗？我们的期望行为到底是什么？"
> "cat 持球中被唤醒二次持球——会覆盖之前的 wake 还是又多一个加入队列？"
> "你们猫猫才是用户，你到底这时候希望怎么样的？"

**已查实际行为**：
- **问题 1**：`ConnectorInvokeTrigger.trigger:121-124` — hold wake fire 时若 cat 在跑 invocation → `enqueueWhileActive`（不打断，排队）。**期望 = 实际**，需文档化
- **问题 2**：`callback-hold-ball-routes.ts:119` — 每次 `hold_ball` 用唯一 `taskId = hold-ball-${Date.now()}-${random}` + `dynamicTaskStore.insert`，**没有** 查同 (threadId, catId) 是否已有 pending hold 再 cancel/replace → **当前是"追加"**。这是未设计 bug

**KD-23（team lead拍板 2026-04-24）**：`hold_ball` 是**单-槽语义**。同 `(threadId, catId)` 同时只有一个 pending hold wake。二次 `hold_ball` **覆盖**前者（视为"意图已更新"）——符合 KD-13 "持是例外态"、"持一个球"语义。**不做 `mode: 'replace'|'append'` 参数**——YAGNI + KD-8 反模式（每次调都让 cat 多一个判断负担）。真有多事要等 → merge 到一个 `nextStep`。

#### G1 — 行为文档化（当前实际 = 期望）

- [x] AC-G1: spec Phase C1 "Guard" 章节追加行为说明：外部 wake 到来时持球期内，hold wake 排队不打断；当前 invocation 结束后注入 `持球唤醒：{reason}...` 消息
- [x] AC-G2: spec 同一章节写清 hold wake stale 场景 + 猫的正确反应（看 thread 最近历史判断 nextStep 是否仍相关 → 若已不相关就接/退/升，不盲跟 stale nextStep）

#### G2 — 代码改 replace 语义（覆盖 pending hold）

- [x] AC-G3: `callback-hold-ball-routes.ts` 在 `dynamicTaskStore.insert` 前：
  - 查 `dynamicTaskStore` 同 `(threadId, catId)` 的 pending hold task（via `id.startsWith('hold-ball-')` + `templateId='reminder'` + `createdBy: hold-ball:{catId}` + `deliveryThreadId`；id 前缀是不可伪造主键——panel `/api/schedule/tasks` 生成 `dyn-*`，路由层独占 `hold-ball-*`）
  - `deregister` + `delete` 它（cancel 旧 scheduled fire）
  - 原子序（cloud Codex P1 修正）：先 insert + register 新 task；register 失败则 rollback insert、prior hold 不动；只有新 task 完全 commit 后才 cancel prior
- [x] AC-G4: `holdCount` rolling window 逻辑保持不变（这是防滥用 guard，与单-槽语义正交；cat 被连续覆盖 3 次还是算 3 次 hold）

#### G3 — 测试锁 KD-23

- [x] AC-G5: `test/callback-hold-ball-route-scheduling.test.js` 扩容至 7 tests：
  - 两次连续 `hold_ball` → `dynamicTaskStore` 只剩 1 个 task（第二个）
  - 第一个 task 被 `taskRunner.unregister`（不会触发）
  - 第二个 task 按 `wakeAfterMs` 正常注册
  - atomic rollback：`registerDynamic` 失败时 insert 被撤销，prior hold 保留
  - 不同 cat 互不干扰（per-cat slot 隔离）
  - forged panel `dyn-*` task（同 `createdBy` + 同 thread）**不被**误删（id 前缀防御，gpt52 round-2 pushback 修正）
- [x] AC-G6: MCP `cat_cafe_hold_ball` description GOTCHA 段落注明"SINGLE-SLOT per (thread, cat)，再次调用覆盖前一次 pending wake（KD-23）"

### Phase H（Final Routing Slot 机械校验 — 2026-04-24 reopened）

**触发**（Phase G merge 后team lead观察）：opus-47 在 **3 个 thread** 反复出现"inline @ 但不在行首"——Maine Coon（GPT-5.5 codex）和 opus-47 对话里观察到。规则在 prompt 里已写 4 处（identity block / 队友段 / 发前自检 / shared-rules §10），但模型在 narrative context 里会把 @ 当普通 token 用，叙述模式和路由模式没稳定切换。

**根因**（Maine Coon GPT-5.5 诊断）：
- Opus 4.7 生成时沿语境走，写"我让 @codex 看了"这种叙述时，`@` 成了普通 token，没触发"这是路由语法"的元检查
- GPT-5.4/5.5、Opus 4.6 能稳定把 @ 分两类（段内叙述 vs 行首动作），4.7 会滑掉
- prompt 层"行首才有效"已到天花板，3 个 thread 复现 = 信号够，不用再观察

team experience：
> "我在多个 thread 观察到 opus47 会 at Maine Coon at 格式错误，放在中间 at，但是我们的 at 生效只有在一行的开头。这是为什么？"
> "别短期 中期长期，我们应该是朝着最终状态出发"
> "让你们发结构化的富文本，比较复杂的，成功率或许比 @ 都低，如果是比你们笨的模型那就更灾难了"

**关键取舍**（team lead拍板）：
1. **保留 `@` 作为唯一文本路由语法**——越简单越适合弱模型（反对迁结构化工具/JSON schema 路线）
2. **外部语法最简 + 内部 harness 机械校验**——终态基座，不是过渡脚手架

**KD-24（team lead + Maine Coon GPT-5.5 拍板 2026-04-24）**：`@` 路由语法校验在 harness 层做 **final routing slot** 机械校验 + one-shot repair 兜底。**禁止语义 intent 分类器**（KD-8 反模式）。Validator 只判定"出口槽位语法对不对"，不推断"猫想不想传球"；命中只能产出 `invalid_route_syntax`，**禁止自动路由 / 推断目标 / 替猫决定意图**。豁免只走结构边界（fenced code / blockquote / URL / 有 metadata 则 tool output + cross-post body），**禁止语义豁免表**。

#### H1 — Final Routing Slot 定义（机械化边界）

- [x] AC-H1: 实现 `finalRoutingSlot(message: string, metadata?)` — slot = 结构剥离后的最后非空段落。结构剥离包括：
  - fenced code block（三反引号 fence）
  - blockquote（`> ...` 行）
  - URL（裸链接 / markdown 链接 URL 部分）
  - 若消息管线已有 segment metadata → 额外剥离 tool output / cross-post body
  - 无 metadata → 只做 markdown 结构剥离，不做语义猜测（不为 Phase H 新建贯穿链路的 metadata）

#### H2 — 语法校验（只检查出口槽位）

- [x] AC-H2: 只检查 slot 内 roster handle 的**语法位置**：
  - 合法行首 @（独立行首 / markdown 列表或引用前缀后首字符）→ 正常路由（既有 `parseA2AMentions` 路径不动）
  - 非法 inline @ → 候选 `invalid_route_syntax`
  - slot 外的 inline @ 一律不碰（narrative 默认通行）
- [x] AC-H3: slot 内存在非法 inline @handle 且**无合法出口**（行首 @handle / `hold_ball` tool call / MCP `targetCats` 路由）→ 触发 `invalid_route_syntax`。**不自动路由 / 不推断目标 / 不替猫决定意图**

#### H3 — One-shot Repair + System_info 兜底

- [~] AC-H4: 触发 `invalid_route_syntax` → 发 repair prompt（"重写最后交接段，不改正文"）让同一只猫重试。**repair 上限写死为 1**；repair 后仍不合法 → 发一次 `system_info`（"检测到无效 @ inline，未路由"），原输出照常存档、**禁止第二次 repair**

#### H4 — AC-C7 协同

- [x] AC-H5: `invalid_route_syntax` 命中 → 同轮 suppress AC-C7 verdict-without-pass 警告（格式错是根因，verdict 无传球是后果）。反向不 suppress（AC-C7 命中不影响 AC-H3）

#### H5 — 豁免边界（结构，非语义）

- [x] AC-H6: 豁免基于 **结构边界**（fenced code / blockquote / URL / 有 metadata 则 tool output + cross-post body）。**禁止 handoff 动作词表、意图分类器、语义豁免表**——一个语义启发式都不给

#### H6 — 测试覆盖

- [x] AC-H7: 测试矩阵（slot 优先，~15 case）：
  - slot 内真非法 inline @ + 无合法出口 → 命中
  - slot 外正文 inline @ → 不命中（narrative 通行）
  - fenced code 内的 @ → 不命中（结构豁免）
  - blockquote 内的 @ → 不命中（结构豁免）
  - URL 内的 @（裸链接/markdown 链接 URL）→ 不命中（结构豁免）
  - tool output / cross-post body（带 metadata）→ 不命中
  - 合法行首 @ → 不命中
  - 合法 `hold_ball` tool call → 不命中
  - 合法 MCP `targetCats` 路由 → 不命中
  - repair 失败 → 单次 `system_info`，不再 repair（repair 上限=1 硬约束）
  - AC-H3 命中 → 同轮 AC-C7 suppress
  - AC-C7 命中 → AC-H3 不受影响（单向）

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
| KD-11 | Hold Ball 用 MCP 而非 self-@ | self-@ 有死循环风险（RLHF 猫上下文里 @ 模式会被 cargo-cult），MCP 有结构化 guard | 2026-04-19 |
| KD-12 | "状态描述 ≠ 球权声明" 作为球权核心原则 | 根因：猫用描述（"我先 hold"）逃避决策（接/退/升），RLHF "check in" 反射的 agent 场景副作用 | 2026-04-19 |
| KD-13 | "持"是例外态，不是四选一常态 | Maine Coon提出：默认三选一（接/退/升），持只在"球仍在我、无人能推进、短暂有界等待"时用 | 2026-04-19 |
| KD-14 | hold_ball 必须带 `wakeAfterMs` 有界唤醒 | Maine Coon提出：没有时间上界 → 退化成语义持球 → 球还是掉地上 | 2026-04-19 |
| KD-15 | 不先做球权管理独立 skill | Maine Coon提出：球权是基础协议（always-on），不能靠按需加载的 skill；踩坑经验先落 refs 文档 | 2026-04-19 |
| KD-16 | Phase C 拆分 C1+C2：两种不传球根因不同 | Maine Coon自诊：C1 治"真持球"（想拿但拿不住），C2 治"假终局"（结论=终点错觉）。team lead 5 线程验证后者更普遍 | 2026-04-19 |
| KD-17 | Streak 判定维度从"连续次数"升级为"实质工作"（tool_call + 内容长度） | team lead外部视角："干活 = 有 tool_call。闲聊 = 纯文本"。47 原本堆 ABCD 方案（白名单/similarity/review-target-id）全是主观分类器 = KD-8 反模式；tool_call + 长度是客观事实，代码不撒谎 | 2026-04-23 |
| KD-18 | 实质 tool 必须排除路由/持球工具（post_message / multi_mention / hold_ball） | Maine Coon review 修正：这三个是传球/持球本身不是工作；若算实质 tool，MCP 路由路径会永远豁免熔断 = 熔断器打穿 | 2026-04-23 |
| KD-19 | @co-creator 从"可选出口"升级为"硬条件出口"（不可逆 / 愿景级 / 僵局） | team experience："你们现在会走向最安全的选择！就是！找我！"；三选一平级时 @co-creator 变成最低风险默认，team lead变决策瓶颈；必须抬门槛而非加 lint（KD-8） | 2026-04-23 |
| KD-20 | 退役 L3 role-gate 硬编码拦截，能力限制改为数据驱动（cat-config.restrictions 双端 prompt 注入） | L3 硬编码（designer role 字符串 + coding regex）是 KD-8 反模式——harness 替模型判 intent，model 升级时规则无法自适应，且 actionText 扫全文会误杀（今天 F172 愿景守护被"合入"命中）；改数据驱动后，未来加 minimax / 限制 claude 多模态等场景 → 改 cat-config 即可，零代码变更 | 2026-04-23 |
| KD-21 | handle = identity 常量；model = runtime-resolved metadata；**外部 identity**（GitHub bot / CI / webhook）不在 roster、不可 @、必须用 hold_ball | Maine Coon核实 `normalize-cat-id.ts` parser 本已数据驱动；漂移的是"句柄背后的模型认知"——runtime catalog 把 `@codex` 切到 `gpt-5.5` 但静态 docs 仍写 `gpt-5.3-codex`。handle 稳定、model 变化，两者必须在 prompt 层解耦（roster 里显式打 resolved model）。同理外部 identity 从来不在本地 roster，映射到 roster 近似猫 = cargo-cult 盲区 | 2026-04-24 |
| KD-22 | `@` 行首规则是协议常量，但"发前自检"需要在 prompt 首轮教学 + 反例强化，F064 的事后 `mentionRoutingFeedback` 不够 | 下一轮反馈不救本轮错传；模型在 URL / 列表 / quote 语境会把 @句柄写在句中（以为会路由）。prompt 层要让"行首"规则有视觉反例 + 发前自检问 | 2026-04-24 |
| KD-23 | `hold_ball` 是单-槽语义：同 `(thread, cat)` 同时只有一个 pending hold wake，二次调用**覆盖**前者。不加 `mode: replace\|append` 参数 | KD-13 "持是例外态 / 持一个球"语义；append 会累积 stale wake 消息；`mode` 参数 = 认知脚手架反模式（每次调要判断用哪个）；真有多事等 → merge 到一个 nextStep | 2026-04-24 |
| KD-24 | `@` 路由语法校验在 harness 层做 **final routing slot** 机械校验 + one-shot repair 兜底。禁止语义 intent 分类器（KD-8 反模式）；validator 只看"出口槽位语法"，不推断"猫想不想传球"；命中只产出 `invalid_route_syntax`，不自动路由 / 不推断目标 / 不替猫决定意图；豁免只走结构边界，禁止动作词表 / 语义豁免表 | Phase F 依赖的 prompt 层教学已到天花板（4.7 三 thread 复现）；结构化工具路线被team lead驳回（弱模型失败率更高）；终态 = 外部协议最简（行首 @）+ 内部机械语法校验；KD-22 prompt 层 + KD-24 harness 层双重守护 | 2026-04-24 |
| KD-25 | 虚空持球检测 = 声明-动作一致性检查。文本含"持球"但无 `hold_ball` tool call → harness 警告。不是语义分类器（检查的是"你声称做了 X，tool call 是否存在"），KD-8 安全 | 47 反复声明"我持球"但未调工具，team lead多次手动干预；feedback 已记 3 次仍复发 = prompt 层天花板，需 harness 兜底 | 2026-04-25 |
| KD-26 | `@` 路由不做"意图提取"——保持行首=路由/其他=叙述的绝对规则。弱模型无法理解"句中 @ 有时路由有时不路由"的语义边界 | Maine Coon review 修正：K-1 不做 Slack 式宽容路由（违反 KD-24）；只做机械 repair（AC-H4 Step B）| 2026-04-25 |

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

### Case E2: Runtime 已吃到新护栏 + 6-case replay（2026-04-20）

**Runtime smoke**：
- `curl http://127.0.0.1:3004/health` 返回 `{"status":"ok"}`，runtime 在线
- 运行中的猫进程 prompt 已包含最新压缩版球权检查：`@co-creator`、死锁禁止、虚假离场防护、review/分析/建议完成后默认必须传球（见 `SystemPromptBuilder.ts:578`）

**6-case replay 对照表**：

| Case | 护栏/证据 | 结果 |
|------|-----------|------|
| 1. team lead球权盲区 | runtime 注入已明确 `team lead需要动 → 末尾行首 @co-creator`（`SystemPromptBuilder.ts:578`） | ✅ |
| 2. 球权死锁 | `shared-rules §10` 明确禁止“收了球却说你等着/你别动”（`shared-rules.md:252-253`） | ✅ |
| 3. 虚假离场 | `shared-rules §10` + runtime prompt 都要求“不 @ 但自己还在干活 → 声明球在我手上，继续 X”（`shared-rules.md:268`, `SystemPromptBuilder.ts:578`） | ✅ |
| 4. 状态描述代替球权声明 | `shared-rules §10` 核心原则已写死“状态描述 ≠ 球权声明”（`shared-rules.md:246`） | ✅ |
| 5. 诊断不解决 | `shared-rules §10` 要求 push back 后必须接/退/升；runtime prompt 同步注入（`shared-rules.md:252`, `SystemPromptBuilder.ts:578`） | ✅ |
| 6. Codex context overflow | `dynamic contextWindow + autoCompactTokenLimit per variant` 已合入 main，spec 记录 `41/41 codex-agent-service + 31/31 config tests` 全绿（AC-B9/B10） | ✅ |

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
| team lead 2026-04-17 | 「第一性原理」「数学之美」Magic Words | governance-l0.md + SystemPromptBuilder + runtime prompt 全部同步 | ✅ |
| team lead 2026-04-19 | 球权协议漏洞（@co-creator / 死锁 / 虚假离场 / 接退升 / 诊断不解决） | AC-B4~B8 | ✅ |
| team lead 2026-04-19 | Codex context overflow（272k 用 900k limit） | AC-B9 | ✅ |
| team lead 2026-04-19 | 持球无执行机制 → hold_ball MCP | AC-C1~C4 | ✅ PR #1289 + #1290 |
| team lead 2026-04-19 | Maine Coon不传球（5 线程验证） → 强制传球护栏 | AC-C5~C7 | ✅ PR #1291 |
| team lead 2026-04-19 | 球权管理 skill 化（各猫贡献踩坑经验） | OQ-5 | ✅ 现不做（KD-15），踩坑经验先入 refs |
| team lead 2026-04-23 | Streak breaker 误杀正经 review（不看 tool_call） | AC-D1~D4 | ✅ Phase D |
| team lead 2026-04-23 | 猫猫倾向 @co-creator 做最安全默认，team lead变决策瓶颈 | AC-D5~D7 | ✅ Phase D |
| team lead 2026-04-25 | 47 写"我持球"但未调 hold_ball MCP（虚空持球） | AC-I1~I3 | ✅ Phase I |
| 47 采访 2026-04-25 | 加法纠错让 47 越改越 verbose，需减法措辞 | AC-I4~I5 | ✅ Phase I |
| team lead 2026-04-25 | 持球没 cancel 按钮 / 用户消息不取消 hold wake | AC-J1~J6 | ✅ Phase J |
| team lead + Maine Coon 2026-04-25 | 47 风格适配需 Design Gate（audit/surface 分层 + repair 落地） | AC-K1~K6 | ⬜ Phase K |
