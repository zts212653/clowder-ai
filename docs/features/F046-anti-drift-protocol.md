---
feature_ids: [F046]
related_features: [F041]
topics: [vision-drift, anti-drift, sop, review, process, multi-agent]
doc_kind: spec
created: 2026-02-27
updated: 2026-03-06
---

# F046: 愿景守护协议 — Anti-Drift Protocol

> **Status**: done | **Owner**: 三猫
> **Completed**: 2026-03-06
> **Created**: 2026-02-27
> **Priority**: P0

---

## Why

F041 能力看板暴露致命问题：AC 12 项全绿、76 测试全过、14 轮 review 全通过——**但operator打开就发现交付物完全不是想要的**。根因：整条 review 链路没有任何角色回去读用户的原始需求。

这不是个案，是系统性缺陷：三猫协作流程中**缺少愿景层守护**，只守了代码质量层。

## What

建立多层愿景守护机制，确保从开发到交付全链路不偏离operator原始意图。

### 已完成（Phase A — 立即做）

| ID | 内容 | 状态 | Commit |
|----|------|------|--------|
| A1 | 三猫指引（CLAUDE/AGENTS/GEMINI.md）新增「愿景守护」铁律 | ✅ Done | `642c31b` |
| A2 | `feat-completion` Skill 新增 Step 0d 跨猫签收记录 | ✅ Done | `642c31b` |
| A3 | 截图证据链——限定前端 UI/UX（operator决策：后端免截图） | ✅ Done | `642c31b` |
| A4 | Review Skills 新增「≤5 行原始需求摘录」强制规则 | ✅ Done | `642c31b` |

### 待开发（Phase B — 计划做）

| ID | 内容 | 状态 | 说明 |
|----|------|------|------|
| B1 | 截图/录屏证据流程——利用现有 MCP（Claude in Chrome / Codex 浏览器） | ✅ Merged（Done） | refs 流程文档化，无需新依赖 |
| B2 | Cold-start Verifier——独立 agent 只看需求+交付物 | ➡️ Evolved into [F067](F067-cold-start-verifier.md) | 独立立项，scope 超出 F046 主线 |
| B3 | 需求点 checklist 格式——结构化需求追踪 | ✅ Merged（Done） | 已嵌入 feat-kickoff 模板 |
| B4 | skill-lint CI gate（`pnpm check:skills` manifest 一致性校验） | ✅ Merged（Done） | ← F042 Wave 2 毕业：Lint = 漂移防护 |
| B5 | ≥10 条对话场景回归测试 | ✅ Done（10 条，10/10 pass） | ← F042 Wave 3 毕业：回归测试 = 愿景守护运行时验证 |
| B6 | 同族 reviewer identity check gate | ✅ Historical（已在 D4 移除） | ← F042 Wave 3 毕业：流程执行守护门禁。根因是 resume bug 非模型混淆，格式校验≠身份验证，且 `(@catId)` 模板加剧 @ 惯性污染（见 D4） |

### 待开发（Phase D — @ 路由卫生 Mention Routing Hygiene）

#### D.0 问题现象

2026-03-02 operator观察到Maine Coon的 **"@ 二极管"现象**：

- **不干预时**：Maine Coon（Codex 和 GPT-5.2）疯狂互相 @，包括"收到，我也在等remote review"这种**零行动**消息也会 @，导致无意义的 agent 调用浪费算力。两只Maine Coon提了 PR 在等remote review，却不停 @ 对方确认"对，我们在等"。
- **加了 prompt 规则后**：矫枉过正，该 @ 的时候反而不 @，review 结果出来了不通知对方，导致流程卡住。
- **Ragdoll（Opus）不受影响**：能正确判断何时该 @、何时不该。

**operator experience**：
> "要么往死里at 要么不at 去找不着其他猫"
> "他可能以为Ragdoll的名字叫 at xxxx 你懂吧？"

#### D.1 调查过程

**第一步：Prompt 层治疗（PR #159，已合入，效果失败）**

给Maine Coon SystemPromptBuilder 的 WORKFLOW_TRIGGERS 加了"@ 自检三问"规则（发 @ 前问自己：需要行动？会错过？能做什么？三否则不 @），同时在 shared-rules.md 加了 §10 "@ 卫生"。

结果：runtime 更新后Maine Coon**仍然疯狂 @**。Prompt 软约束打不过上下文里大量 `@xxx` 模式的补全惯性。

**第二步：Maine Coon自述采访（Thread `[thread-id]` 08:13-08:15）**

Ragdoll设计了 4 个采访问题，两只Maine Coon独立回答，结论高度一致：

| 问题 | Codex 回答 | GPT-5.2 回答 |
|------|-----------|-------------|
| @ 前脑内决策？ | "不是触发路由，而是在对谁说话" | "更像对话对齐/点名，不是触发路由" |
| @ vs 写名字区别？ | "路由层只看行首 @ 能不能匹配，不看是否有行动" | "理性上知道是路由，但长上下文退化成称呼前缀" |
| 看到 § 10 规则了吗？ | "路由层不看有没有行动请求，所以废话也路由" | "看过，但软约束被高密度 @ 模式压过去" |
| 互 @ 说"在等"期望对方做什么？ | "系统行为不是个体偶发" | "期望动作基本是无，本质是状态焦虑" |

**关键发现（两只Maine Coon都指出）**：
1. 上下文里 `@xxx` 模式密度太高（元信息 `最近活跃：@opus`、`Direct message from @xxx` 等），模型补全惯性把 @ 当成"名字格式"
2. 路由层 `a2a-mentions.ts` 只检测"行首有没有 @handle"，不检测"有没有行动请求"，所以废话也被路由
3. Prompt 规则是软约束，在高密度 @ 上下文里被模式补全覆盖

**第三步：方案讨论（operator + 三猫）**

| 方案 | 提出者 | operator决策 | 理由 |
|------|--------|-----------|------|
| 强制 MCP 工具调用才能 @ | operator | 暂不采用 | 可能矫枉过正，Ragdoll不需要这约束 |
| 强制冷却期（3 分钟内不能 @ 同目标 2 次以上） | Ragdoll | **否决** | "Maine Coon思考三分钟说一句废话你怎么办？" |
| 可路由门禁（@ + 动作词才路由） | Codex + GPT-5.2 | **认可方向** | 软硬结合，不矫枉过正 |
| 输入去惯性（元信息去 @ 前缀） | GPT-5.2 | **认可方向** | 治根——减少上下文里 @ 模式密度 |
| 无动作 @ 反馈（不路由但给提示） | Codex | **认可方向** | 避免二极管另一端——猫不敢 @ |

#### D.2 根因（四层）

| 层次 | 问题 | 影响 |
|------|------|------|
| **语义理解** | GPT 系模型把 `@opus` 当成"名字"而不是"路由指令" | 每句话都 @，像人说"嘿 John" |
| **任务判断** | 不会判断"这件事需不需要别人" | 小破事也 @ 人 review |
| **上下文惯性** | 元信息里大量 `@xxx` 污染补全模式 | prompt 规则被惯性覆盖 |
| **机制缺失** | 路由层不检查 actionability，只检查格式匹配 | 废话也被路由成 agent 调用 |

#### D.3 实施方案（四个 item）

**D1: Actionability Gate（可路由门禁）**

- **改什么**：`packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts`
- **现在**：行首 `@handle` 匹配成功 → 直接路由
- **改后**：行首 `@handle` 匹配成功 → 检查同段/同句是否含动作词 → 有动作词才路由，无动作词不路由
- **运行模式**：
  - `strict`（默认）：`@handle` 与动作词必须同段
  - `relaxed`（线程级热开关）：允许 `@handle` 段后空一行，在下一段出现动作词
  - 入口：`PATCH /api/threads/:id { mentionActionabilityMode: 'strict' | 'relaxed' }`
- **动作词初始集**（硬编码，后续可配置化）：`review`、`确认`、`处理`、`修复`、`请`、`帮`、`决策`、`看一下`、`check`、`fix`、`merge`
- **注意**：operator的 @ 不受此门禁影响（operator消息走不同路径），只影响猫→猫的 A2A mention

**D2: Input De-inertia（输入去惯性）**

- **改什么**：`packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts`
- **改哪些元信息**：
  - `最近活跃：@opus` → `最近活跃：Ragdoll(opus)`
  - `Direct message from @xxx; reply to @xxx` → `Direct message from Ragdoll(opus); reply to Ragdoll(opus)`
  - B6 identity check 模板中的 `(@${context.catId})` — 由 D4 整体移除，此处不需单独处理
  - 其他注入到上下文的 `@handle` 模式
- **目标**：把上下文里的 @ 模式密度从每条消息 2-3 个降到接近 0，让模型不再把 @ 当成"名字格式"的补全模式
- **不改什么**：WORKFLOW_TRIGGERS 里的 `@Ragdoll` 保留（那是教猫"什么时候该 @"的教学内容，不是补全污染源）

**D3: No-action @ Feedback（无动作 @ 反馈）**

- **改什么**：`packages/api/src/domains/cats/services/agents/routing/route-serial.ts`（或 D1 检测逻辑的下游）
- **行为**：当 D1 判定"无动作词，不路由"时，不是静默丢弃，而是在当前猫的下一次调用中注入一条系统提示：
  > "你上一条消息里的 @xxx 未被路由（未检测到行动请求）。如需联系对方，请明确说明需要对方做什么，例如：'请 review 这个改动\n@opus'"
- **目的**：避免矫枉过正。猫收到反馈后知道自己的 @ 没生效，可以修正写法——而不是"怎么 @ 了没人理我"然后再 @ 十遍
- **不要做**：不要弹窗式阻断，不要强制改写。只是提示性反馈

**D4: Remove B6 Identity Check Gate（移除同族身份校验）**

- **删什么**：
  - `packages/api/src/domains/cats/services/collaboration/review-identity-gate.ts` — 整个文件删除
  - `packages/api/test/review-identity-gate.test.js` — 对应测试删除
  - `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` — 删除 `reviewIdentityCheckFrom` 相关逻辑（L46-50 类型声明 + L346-351 prompt 注入）
  - `packages/api/src/domains/cats/services/agents/routing/route-serial.ts` — 删除 `reviewIdentityCheckFrom` 读写逻辑（L122-125, L375-380, L471-486）
  - `packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts` — 删除 `reviewIdentityCheckFrom` 字段（L39, L61）
  - `packages/api/test/system-prompt-builder.test.js` — 删除 identity check 相关测试用例
  - `packages/api/test/route-serial-review-identity-propagation.test.js` — 整个测试文件删除
- **为什么删**：
  1. **根因已修**：gpt52/codex 身份混淆的根因是 resume 给错了 session，不是模型自己搞不清。resume bug 修复后再未复现
  2. **格式校验 ≠ 身份验证**：如果模型真混淆了身份，它照样能"自信地"输出错误的 Identity Check 行。验格式无法验身份
  3. **@ 污染源**：模板 `(@${context.catId}, model=...)` 在上下文中注入 `@xxx` 模式，加剧 D2 要治的补全惯性
  4. **浪费 token**：每次同族 review 多一行输出 + prompt 注入，零防御价值
- **不留降级方案**：不需要。如果未来真出现身份混淆，应在 resume/session 层做校验（确保 resume 的 session 和 catId 匹配），而不是靠模型自证

#### D.4 不做什么

| 方案 | 不做原因 |
|------|---------|
| 强制 MCP 工具调用 @ | 改动太大（重写整个 A2A 路由）+ Ragdoll不需要 + 工程量不匹配收益 |
| 冷却期（时间窗口内限频） | operator否决："猫思考慢了怎么办？" + 误伤正常交互 |
| 只改 prompt 不改机制 | **已证实无效**（PR #159 实验） |
| 按猫种区分规则（只限Maine Coon） | 增加复杂度，统一规则更简单可维护 |

#### D.5 验收标准（已按 PR #206 更新）

1. ~~Maine Coon发"@opus 收到，我在等"→ 不路由，猫收到提示~~ → **已回退**：行首 @ 即路由（operator决策）
2. Maine Coon发"请 review 这个 PR\n@opus"→ **正常路由** ✅
3. Ragdoll的正常 @ 行为不受影响 ✅
4. operator的 @ 不受门禁影响 ✅
5. SystemPromptBuilder 输出中不含 `@handle` 格式的元信息（WORKFLOW_TRIGGERS 教学内容除外） ✅
6. B6 identity check 相关代码和测试全部移除，同族 review 不再要求首行 Identity Check ✅
7. 有对应的单元测试覆盖 D2/D4（D1/D3 keyword gate 测试随 PR #206 简化后移除） ✅

#### D.6 关键代码文件

| 文件 | 改动 |
|------|------|
| `packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts` | D1: actionability 检测逻辑 |
| `packages/api/src/domains/cats/services/agents/routing/route-serial.ts` | D3: 无动作 @ 反馈注入 |
| `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` | D2: 元信息去 @ 前缀 + D4: 删 reviewIdentityCheckFrom |
| `packages/api/src/domains/cats/services/collaboration/review-identity-gate.ts` | D4: 整个文件删除 |
| `packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts` | D4: 删 reviewIdentityCheckFrom 字段 |
| `packages/api/test/a2a-mentions.test.js` | D1 测试 |
| `packages/api/test/system-prompt-builder.test.js` | D2 测试（size guard + 内容校验）+ D4 删 identity check 用例 |
| `packages/api/test/review-identity-gate.test.js` | D4: 整个文件删除 |
| `packages/api/test/route-serial-review-identity-propagation.test.js` | D4: 整个文件删除 |

#### D.7 参考资料

| 资源 | 路径 |
|------|------|
| 原始讨论 | Thread `[thread-id]`，2026-03-02 04:26 起 |
| Maine Coon采访 | 同 thread 08:13-08:15（Codex + GPT-5.2 独立回答） |
| Prompt 治疗实验 | PR #159（已合入，效果失败） |
| SOP 歧义修复 | PR #162（已合入，附带发现） |
| F042 三层架构决策 | `docs/features/F042-prompt-engineering-audit.md` §2 |

| ID | 内容 | 状态 | 说明 |
|----|------|------|------|
| D1 | **Actionability Gate**——原为 `@ + 动作词` 门禁，经operator否决后简化为「行首 @ 即路由」 | ✅ Done（简化） | PR #192 实现 → PR #206 回退简化（operator："强匹配太挫了"） |
| D2 | **Input De-inertia**——SystemPromptBuilder 元信息中去除 `@` 前缀 | ✅ Done | PR #192（`27e5e70b`） |
| D3 | **No-action @ Feedback**——随 D1 简化一并移除（无 keyword gate 则无 suppression feedback） | ✅ Done（移除） | PR #194 实现 → PR #206 随 D1 一并移除 |
| D4 | **Remove B6 Identity Check**——删除同族 reviewer 身份校验（根因是 resume bug，非模型混淆） | ✅ Done | PR #195（`3825aaea`） |

### 明确不做（Phase C）

| ID | 内容 | 理由 |
|----|------|------|
| C1 | 需求嵌入 system prompt（上下文嵌入） | 成本过高，压缩后会丢 |
| C2 | 向量化语义偏离检测 | 过度工程，小团队不需要 |
| C3 | 覆盖度 KPI | operator明确拒绝："别变成填表" |
| C4 | 跨猫 thinking 实时广播（属 F045） | 范围不同，F045 负责 |

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

- [x] 三猫指引文件包含「愿景守护」铁律段落
- [x] `feat-completion` 有跨猫签收步骤（Step 0d）
- [x] `requesting-review` + `requesting-cloud-review` 强制附原始需求摘录
- [x] 截图证据仅限前端 UI/UX 功能
- [x] 截图/录屏证据流程文档化，利用现有 MCP 工具（B1）
- [x] Cold-start Verifier 概念设计完成，已毕业为独立 Feature [F067](F067-cold-start-verifier.md)（B2）
- [x] 需求点 checklist 格式嵌入开发模板（B3）
- [x] skill-lint CI gate 可运行 + 检测 manifest 一致性（B4）
- [x] ≥10 条对话场景回归测试就位（B5，10 条，10/10 pass）
- [x] 同族 reviewer identity check gate 曾落地（B6 历史项，已在 D4 移除）
- [x] @ 路由卫生落地：行首 @ 即路由（经operator否决动作词门禁后简化，PR #206）（D1）
- [x] SystemPromptBuilder 元信息不含 `@` 前缀（D2）
- [x] 无动作 @ 反馈机制已实现后随 D1 简化一并移除（D3，PR #206）
- [x] B6 identity check 代码和测试全部移除（D4）

## Key Decisions

| 决策 | 选择 | 放弃的方案 | 理由 |
|------|------|-----------|------|
| 守护层级 | 流程嵌入（Skills/指引） | 上下文嵌入（system prompt） | 成本可控，上下文嵌入压缩后会丢 |
| 截图范围 | 仅前端 UI/UX | 所有 Feature 强制截图 | operator："后端功能硬截图是折腾" |
| 覆盖度衡量 | 不设 KPI | 愿景覆盖度量化指标 | operator："别变成填表" |
| 验证方式 | Cold-start Verifier（独立 agent） | 向量化语义偏离检测 | 简单有效 vs 过度工程 |
| 调研方法 | Deep Research Pipeline（三路+Pro） | 单猫调研 | 6 份报告交叉验证，避免单一偏见 |

## Risk / Blast Radius

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| 流程过重导致开发效率降低 | 中 | A 项都是轻量嵌入（≤5 行摘录），不是新流程 |
| 猫猫表面合规但实质应付 | 中 | B2 Cold-start Verifier 做独立校验 |
| MCP 截图工具局限性 | 低 | Claude in Chrome 覆盖主流场景，特殊情况手动补 |
| operator审美疲劳（截图太多） | 低 | 已限定 ≤3 张 + 1 段 15s 录屏 |

## Dependencies
- **Related**: 无

| Feature | 关系 | 说明 |
|---------|------|------|
| **F041** | 🔗 触发源 | F041 愿景对照失败触发本 Feature |
| **F042** | 🔗 毕业来源 | F042 Wave 2/3 剩余项 (B4-B6) 毕业到本 Feature |
| **F045** | 🟢 互补 | F045 做可观测性，F046 做愿景守护，互不阻塞 |

## Review Gate

| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| R1 | @gpt52 | done | 2026-03-03 |

## Test Evidence

Phase A 为流程/文档变更，无代码测试。

Phase B（B4/B6）代码证据（2026-03-02）：
- `node --test scripts/check-skills-manifest.test.mjs` → 4/4 pass
- `pnpm check:skills` → 15 skills 挂载/注册/manifest 全绿
- `pnpm --filter @cat-cafe/api run build` → success
- `node --test packages/api/test/review-identity-gate.test.js packages/api/test/system-prompt-builder.test.js` → 60/60 pass
- `node --test packages/api/test/agent-router.test.js`（在 `packages/api/` 目录）→ 50/50 pass

Phase B（B1/B3）文档证据（2026-03-02）：
- `cat-cafe-skills/refs/vision-evidence-workflow.md`（B1 流程）
- `cat-cafe-skills/refs/requirements-checklist-template.md`（B3 模板）
- `cat-cafe-skills/quality-gate/SKILL.md` 已引用 B1 流程
- `cat-cafe-skills/feat-lifecycle/SKILL.md` kickoff 已要求嵌入 B3 checklist

Phase B（B5 扩展）运行时回归证据（2026-03-03）：
- `pnpm --filter @cat-cafe/api run build` → success
- `node --test packages/api/test/f046-b5-runtime-regression-seed.test.js` → 10/10 pass
- 说明：B5 已从 seed 3 条扩展到 10 条（覆盖 D2 去惯性 + debug/play 核心路径；D1/D3 keyword gate 测试随 PR #206 简化后合并）

Phase D（D4）移除 identity gate 证据（2026-03-03）：
- `packages/api/src/domains/cats/services/collaboration/review-identity-gate.ts` → deleted
- `packages/api/test/review-identity-gate.test.js` → deleted
- `packages/api/test/route-serial-review-identity-propagation.test.js` → deleted
- `node --test packages/api/test/f046-b5-runtime-regression-seed.test.js` → 第 3 条期望更新为“无 identity 无效标记”

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
## Completion Sign-off（愿景守护跨猫签收）

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|---------|------|
| Ragdoll Opus 4.6 | F046 spec, F041 spec, vision-drift synthesis, 17 commits, PR #206, a2a-mentions.ts 代码验证, B5 测试运行 | 核心问题（流程层愿景守护）已解决；D1/D3 经operator产品决策回退，属正常迭代；B2 转 F067 | ✅ 可 close |
| Maine Coon Codex | F046 spec, F041 spec, vision-drift synthesis, BACKLOG, features README, a2a-mentions.ts/route-serial.ts/SystemPromptBuilder.ts 代码验证, 96 tests 全绿 | 3 个 P1（B2 未完成 + D1/D3 spec 漂移 + completion 闭环未执行）；建议先同步 spec 再 close | ✅ 同意 close（条件：先修 3 个 P1） |
| Maine Coon GPT-5.2 | F046 spec, F041 spec, 关联 commit/PR 证据, a2a-mentions.ts/route-serial.ts 代码验证, B4/B5 测试运行 | 同 Codex：3 个 P1 + 1 个 P2（B5 数量）；B2 转新 feature 而非 TD | ✅ 同意 close（条件：先修 P1+P2） |

**operator决策**（2026-03-06）：B2 转新 Feature（F067），执行 spec 同步 + completion 闭环。
