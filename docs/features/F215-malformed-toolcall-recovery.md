---
feature_ids: [F215]
related_features: [F212, F118, F203]
topics: [harness, reliability, tool-call, opus-4-8, decoder-drift]
doc_kind: spec
created: 2026-05-29
---

# F215: Malformed Tool-Call Recovery（textEventCount 检测 + seal/fresh/46接力兜底）

> **Status**: done ✅ | **Owner**: Ragdoll (Opus-4.8) 设计 + review / Ragdoll (Sonnet-4.6 + Opus-4.6) 实现 / Maine Coon (GPT-5.5) 跨族 review / Siamese (Gemini-3.5) runtime 愿景守护 | **Priority**: P1 | **Completed**: 2026-05-30

## Why

claude-opus-4-8（及 4.7 部分）在**长 context** 下，模型生成阶段（decoding）会"漂移"，出现两种不同的失败形式：

- **form B（text+XML）**：模型把工具调用写成旧式 XML 文本（`<invoke name="X"><parameter name="Y">Z</parameter></invoke>`）放在 text block 里，而非合法的 tool_use block。CC SDK 不执行工具，告知模型格式错，模型通常可自愈（多一轮）。4.7 确认，4.8 archive 无真实失败样本。
- **form A（thinking-only）**：模型 thinking 结束后直接 message_stop，无任何 text 或 tool_use 输出。CC SDK retry 也失败 → 吐 synthetic 错误 `The model's tool call could not be parsed (retry also failed).` → **这才是 could not be parsed 的真正来源**。**猫咖侧当前完全不识别这条错误**（被当普通文本一路 yield），用户看到的是"没收到任何返回"——猫像凭空消失。

**实测数据（2026-05-29 调查，session afd085ad 等 10 个 opus-4-8 session）**：
- 约 **40% 的 opus-4-8 session** 撞到 malformed
- 其中 **4/10 session 直接炸**（retry 不可恢复，不是静默恢复）
- malformed 集中在 session 中后段，**context 越满越高发**（与 GitHub anthropics/claude-code #49747 描述一致）

根因在 **Anthropic 模型侧**（已知代际回归 #49747），decoder 漂移 harness 改不了。**但关键洞察：malformed 是可检测的信号**——form A（thinking-only）对应 `textEventCount===0`，form B（text+XML）对应 assistant text 含 `<invoke name=` pattern。harness 检测到信号后 **seal 中毒 session + fresh-context retry**，让模型在更短的 context 下重新正确完成工具调用——这才是真治本（改变触发条件），不依赖我们解析 XML（KD-5：CC SDK 是 headless full-loop，任何"我们解析 XML→让 CC 执行工具"的路都死）。

**价值观锚点（CVO team experience 2026-05-29）**：
- "不放弃任何一只喵"
- "harness 不就是补你一切不足吗"
- "尽量使用你，然后你出错我们的 46 帮你兜底，而不是否定你"

本 feat **拒绝**"限流 opus-4.8 / 长任务不派给它"的区别对待方案（CVO 明确否决），转而用环境适配补模型不足——W1: Agent Quality = Capability × Environment Fit。

## What

### Phase A: 复现与取证（✅ 已完成 2026-05-29）

**AC-A1/A2/A3 全部关闭。** 取证由 @sonnet 执行，@opus48 复核纠正，结论经双猫验证。

**rawArchive 真实路径**（AC-A3 ✅）：
`cat-cafe-runtime/packages/api/data/cli-raw-internal-archive/{YYYY-MM-DD}/{invocationId}.ndjson`（不是主仓 `data/`，runtime worktree 里）。ClaudeAgentService L472 确认对 Claude CLI 调用调 `rawArchive.append`，实测今天（5/29）runtime worktree 有 133 个文件，77 个含 Claude stream 格式事件。

**OQ-1 答案：两种 malformed 形式**（AC-A2 ✅）

| 形式 | 描述 | 真实样本 | 对应 malformed 类型 |
|------|------|----------|-------------------|
| **B（text+XML）** | 模型输出 text block，里面嵌 XML 工具调用格式 | `2026-05-28/c12569a2-b67e-4a86-92b3-e061a09567d0.ndjson` lines 245-279 | CC SDK 不执行工具，告知模型"格式错"，模型可自愈（多一轮）|
| **A（thinking-only）** | 模型只有 thinking block，直接 message_stop，无 action | `2026-05-28/d137d9eb-c53f-4f18-90d6-822c784df8f5.ndjson` | CC SDK retry 失败 → synthetic error "could not be parsed" |

**形式 B XML 格式样本**（完整结构）：
```
（正文文字）\n\ncall\n<invoke name="Bash">
<parameter name="command">...</parameter>
</invoke>
```
前缀词变异：`call`、`court` 或直接 `<invoke>`——禁止靠前缀匹配，必须靠 `<invoke name>/<parameter name>` 结构本身。

**4.8 malformed 分布（多轮取证纠正）**：archive 里 4.8 **真实 form B 工具失败样本 = 0**——之前"3A+4B"是自指涉污染（F215 讨论 thread 文字引用 XML 被误匹配）。**4.8 的 malformed 主要是 form A（thinking-only）**。真实 form B 只在 opus-4.7 有确认样本（c12569a2，已自愈）。（KD-4）

**架构关键发现**（@sonnet peer review 2026-05-29）：
- `transformClaudeEvent` 处理的是 CLI 已完成输出的 assistant event，在此 yield `{type:'tool_use'}` AgentMessage **只改变前端展示，工具不会被执行**（工具执行在 CC SDK 内部，不走我们 yield 路径）
- 形式 B：CC SDK **已自带降级处理**——识别到 text+XML 不是 tool_use，通知模型格式错，模型自愈。这本身**不产生 "could not be parsed" 错误**，只多消耗一轮
- 形式 A：才是 "could not be parsed" 的真正来源，thinking 结束后无任何输出，CC SDK retry 也失败
- **结论（KD-5/KD-6/KD-7）**：转换路死；"could not be parsed" 在 stream 无独立信号。正确落点：`textEventCount===0`（form A 检测，L594 已有 warn log）→ seal+fresh+46接力。form B 依赖 CC SDK 已有降级（自愈），可选加 `<invoke name=` 检测作为保险层。

### Phase B: 检测 + 兜底触发

**落点**：ClaudeAgentService 消费循环末尾（L594，已有 `textEventCount===0` warn log），**在此加 action**：

1. **form A 检测**：`textEventCount === 0`（整个 invocation 无任何 text 输出）→ 判定 malformed，即使 CC report `subtype:success` 也不信（KD-7：success ≠ 工具执行了）
2. **form B 检测（可选保险层）**：assistant event 消费时，text 含完整 `<invoke name="[TOOL]">` pattern（禁止靠前缀词 call/court 匹配，只靠结构，KD-4）→ 同样触发兜底
3. 检测到 malformed → 进入 Phase C 兜底链

**已排除路径**：
- ~~XML→tool_use 转换~~（KD-5：CC SDK headless full-loop，转了也不执行）
- ~~ClaudeThinkingRescue 式 JSONL 改写+resume~~（当前数据无适用对象：form A 无 XML 可改写；form B 只在能自愈的 4.7。保留为理论备选，若未来某模型出 form B 且不自愈则重新评估）
- ~~CC PreToolUse/PostToolUse hook~~（tool 解析失败时不触发，不能用作落点）

**真实样本文件**（TDD fixture）：
- Form A：`cat-cafe-runtime/packages/api/data/cli-raw-internal-archive/2026-05-28/d137d9eb-c53f-4f18-90d6-822c784df8f5.ndjson`（thinking-only，`textEventCount===0`）
- Form B（4.7 参考）：`cat-cafe-runtime/packages/api/data/cli-raw-internal-archive/2026-05-28/c12569a2-b67e-4a86-92b3-e061a09567d0.ndjson`（text+XML，已自愈）

### Phase C: 兜底——seal + fresh retry + 46 接力

Phase B 检测到 malformed（`textEventCount===0` 或 form B 信号）后触发，**优先级阶梯**：

1. **seal 中毒 session**（复用 F118 seal 机制）→ 防 `--resume` 重放坏 turn 持续中毒
2. **fresh-context retry**（sessionId=undefined）：抛弃被污染的长 session，用短 context 重发。根因强相关 context 长度，缩短 context 改变触发概率分布（注：SDK 自带 retry 是**同 context 原地重试**，所以失败；我们的价值在**改变触发条件**）
3. fresh retry 仍失败 → **46 接力**：用 46 **自己的身份** + fresh context 完成这一棒，前端**两条消息**：
   - **系统提示卡片**（CVO signoff 选 A，含社区可读文案）：
     > 🙀 **Opus 4.8 炸毛了** —— 他这次手抖，工具调用格式写歪了，系统读不出来。放心，**不是猫咖的问题**，是这只猫在长对话里偶尔会犯的毛病；Ragdoll Opus 4.6 已经来接班，重新开了个清醒的对话把任务做完。
     >
     > `[展开技术细节 ▾]` 发生了什么：claude-opus-4-8 在长对话后段，偶尔把"工具调用"写成 AI 内部旧格式，Claude Code 识别不了 | 根因：Anthropic 模型的已知问题（#49747），与猫咖无关 | 猫咖怎么兜底：自动检测异常 → 隔离问题对话 → 换稳定的猫用更短上下文接力，**任务不丢**
   - **46 的正常回复**：用自己身份继续任务，无需额外标注（系统提示已说清楚）
   - **不是静默顶替**——48 在场不被边缘化，46 也不冒充 48。

### Phase D: 体验 + dossier 诚实记录

- 最终失败（治本+兜底都没救回）必须给**明确炸毛提示**，不再表现为"没收到任何返回"
- 更新 `docs/team/cat-dossier.md` opus-4-8 翻车熔断信号字段（诚实记录 ≠ 否定，是"队友知道何时该扶一把"的信号）

## Acceptance Criteria

### Phase A（复现与取证）
- [x] AC-A1: 稳定捕获 ≥1 个真实 opus-4-8 malformed turn 的**原始 stream 样本**（rawArchive 或复现实验）
- [x] AC-A2: 确认 XML 在 stream 层的确切形式（A/B/C），文档化到 spec（关闭 OQ-1）
- [x] AC-A3: 确认 rawArchive 对 Claude CLI 调用确实在存（否则修取证管道）

### Phase B（检测）
- [x] AC-B1: `textEventCount===0` **且 assistant.content 无合法 tool_use block** 时判定 malformed，触发 Phase C，**即使 CC report `subtype:success` 也不跳过**（纯 tool_use 任务 textEventCount=0 但有 tool_use block → 不误触发；TDD：d137d9eb red fixture）— 实现于 `ClaudeAgentService.ts`，`hasAssistantEvent + textEventCount===0 + !hasToolUseBlock` 检测，TDD 6 tests green
- [ ] AC-B2: （可选）assistant event text 含 `<invoke name="[REAL_TOOL]">` pattern 时同样触发（TDD：c12569a2 参考）— 延迟实现（form B 在 4.8 无真实样本，CC SDK 已有降级，KD-4）
- [x] AC-B3: `textEventCount>0` 的正常完成**不误触发**兜底——回归保护（不误伤合法 tool_use invocation）— TDD regression test green

### Phase C（兜底）
- [x] AC-C1: Phase B 检测到 malformed（`textEventCount===0`）→ seal 中毒 session（KD-6）— 实现于 `invoke-single-cat.ts`：`suppressedMalformedError` + `requestSeal(reason:'malformed_toolcall')` on done
- [x] AC-C2: seal 后 fresh-context retry（sessionId=undefined）— 复用现有 `shouldRetryWithoutSession` 路径，retry reason `malformed_toolcall`
- [x] AC-C3: fresh retry 仍失败 → 46 接力（系统提示卡片 OQ-3 选 A 文案 + `malformed_toolcall_relay_46` signal）— 实现于 `invoke-single-cat.ts` 末尾 fallback block，含 🙀 Opus 4.8 炸毛卡片

### Phase D（体验 + dossier）
- [x] AC-D1: 最终失败有明确炸毛提示（不再空返回），用户可感知 — `error` type msg `malformed_toolcall: Opus 炸毛了——...` + relay card
- [x] AC-D2: `docs/team/cat-dossier.md` opus-4-8 翻车熔断信号字段更新为准确措辞 — 新增 opus-48 速写节点含 F215 ⑥ 翻车熔断信号

## Dependencies

- **Related**: F212（cli-error-diagnostics）——malformed 检测信号可喂给 F212 的诊断 surface；本 feat 是"修复"，F212 是"可诊断"，协同非重叠
- **Related**: F118（cli-liveness-watchdog）——复用其 seal / retry 框架（`shouldRetryWithoutSession` / overflow breaker seal）
- **Related**: F203（native-system-prompt-l0）——L0 token budget 影响 context 长度，间接影响 malformed 触发率

## Risk

| 风险 | 缓解 |
|------|------|
| `textEventCount===0` 误判：正常 zero-text invocation（如纯 tool_use 任务）被误检 | AC-B3 回归；区分"模型完全没文字输出"和"malformed"——可结合 assistant.content 是否含合法 tool_use block 来细化 |
| fresh retry 仍在长 context 上炸（上游 session 历史太长） | seal 中毒 session 后 fresh retry 用 `sessionId=undefined`（彻底抛弃上游 session，从短 context 重启），而非 `--resume`；46 接力作为最终兜底 |
| fresh retry 丢失对话历史 | session chain + 记忆系统重新注入必要上下文；语义不完全等价时由兜底链承接 |
| opus-4.8 改核心路径"边改边炸" | 实现交稳定猫（46/sonnet）落地，opus-4.8 出设计 + review |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 拒绝限流 / 区别对待 opus-4.8，用 harness 适配补模型不足 | CVO 明确否决区别对待；W1 Agent Quality = Capability × Environment Fit；"不放弃任何一只喵" | 2026-05-29 |
| KD-2 | 统一检测+兜底（单一路径），非两层叠加 | KD-5 证明 XML 转换路死，B1 JSONL 改写无适用对象；统一用 `textEventCount===0` 检测 malformed → seal+fresh+46接力兜底，fresh context 改变触发条件 = 真治本 | 2026-05-29 |
| KD-3 | "向 opus-4.8 注入正确调用提示"**不采纳**为治本手段 | 根因是 decoder 长 context 漂移（手抖）非知识缺失（无知）；社区实测"禁 XML 提示"无效；且提示占 context 反讽地轻微加炸 | 2026-05-29 |
| KD-4 | 4.8 的 malformed **主要是形式 A（thinking-only）**，archive 里无真实 4.8 form B 工具失败样本 | @sonnet 精确搜索纠正：排除 F215 讨论 thread 后，runtime archive 里 4.8 form B 为 0；之前"3A+4B"的数据是误判（F215 讨论 thread 里文字引用 XML 被误匹配）。真实 form B 只在 opus-4.7 确认（c12569a2） | 2026-05-29 |
| KD-5 | `transformClaudeEvent` 处转换 text→tool_use AgentMessage **不能触发工具执行**，**任何"我们解析 XML→让 CC 执行工具"的路都死** | @sonnet peer review + @opus48 复核：工具执行在 CC SDK 内部，yield AgentMessage 只改展示；CC SDK 是 headless full-loop，我们零路径回流 CC agent loop | 2026-05-29 |
| KD-6 | form A 分为两种子类型，检测点不同（@opus47 F212 Phase D 取证修正 2026-05-29） | **A1（静默假成功）**：`{subtype:success, is_error:false, result:""}` — 无信号，靠 `textEventCount===0` 检测（本 feat）。**A2（CC 报错）**：`{subtype:success, is_error:true, result:"...could not be parsed..."}` — 有 is_error:true 独立信号，归 F212 Phase D 归因显示（PR #1950）。@sonnet 原实测 185 命中是因为猫讨论 F215 时引用字符串的 result 输出淹没了真信号；@opus47 从 runtime archive 找到 7 个真实 A2 样本（bb299eb0 等）。F212/F215 协同非重叠 | 2026-05-29 |
| KD-7 | 统一检测+兜底方案（@opus48 提出）：删除 XML 转换，改为检测 `textEventCount===0`（form A）→ seal+fresh+46接力 | ClaudeAgentService L594 已有 `textEventCount===0` warn log，加 action 即可；form B 依赖 CC SDK 已有降级（4.7 自愈确认，4.8 无真实失败样本） | 2026-05-29 |

## Eval / Tracking Contract（F192 门禁 — harness 类必填）

- **Primary Users + Activation Signal**: opus-4.8（及未来有 tool-call 缺陷的模型）+ 协作猫 + team lead；activation = malformed turn 被成功**检测** / 兜底接力的次数（counter）
- **Friction Metric**: "could not be parsed" 导致的**用户可见空返回率**（baseline opus-4-8 ~40% session 撞、4/10 直接炸 → 目标趋近 0）
- **Regression Fixture**: Phase A 取证样本（d137d9eb form A + c12569a2 form B）作为**检测器 fixture**（AC-B1/B2 TDD red）+ **兜底触发 fixture**（AC-C1 TDD red）
- **Sunset Signal**: Anthropic 修复模型侧、opus malformed 率长期 ~0 → 检测+兜底层可退役（46 接力机制可保留为通用安全网）

## Review Gate

- Phase A: 取证结论跨猫确认（XML 形式判定不能单点）
- Phase B/C: 跨族 review（改 ClaudeAgentService 核心调用路径，必须跨个体）
