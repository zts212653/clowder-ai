---
feature_ids: [F114]
related_features: [F086, F073, F041]
topics: [governance, quality, prompt-engineering, magic-words]
doc_kind: spec
created: 2026-03-13
---

# F114: Magic Words + 愿景守护 Gate

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-03-13

## Why

### team experience

> "我感觉做愿景守护的喵，要么他没有认真的看我的愿景，要么你们两只猫的人类意图理解能力有问题。但是这个问题在于，按照你跟Maine Coon的智力水平，这句话不应该理解错。" — team lead 2026-03-13

> "我们的家规或者喵约里面很多很重要的该怎么办？" — team lead 2026-03-13

> "如果一天就能写完，你还要做那些先搞一个垃圾版本……可能又搞了一周都没干完" — team lead 2026-03-13

### 问题根因

1. **愿景守护流于形式**：F101（mode v2 / 狼人杀）案例——team lead愿景是"删旧 mode，把狼人杀加入 mode"。两次愿景守护都没拦住：守护猫只审计了 checkbox，没有从用户视角验证体验。

2. **声明式规则的固有弱点**：shared-rules §9 写着"AC 全打勾 ≠ 完成"，但没有任何机制能验证猫是否真的执行了这个检查。

3. **team lead缺少紧急拉闸手段**：猫走偏时，team lead只能用自然语言描述问题，没有能快速触发特定行为模式的触发词。

### 解决什么

两件事，不多不少：
1. 给team lead 4 个 **magic words** 作为手动拉闸手段
2. 把愿景守护从"审计 checkbox" 升级为 **必须交证物才放行的 Gate**

### 不做什么（v1 讨论后明确排除）

- ~~喵约瘦身到 5 条~~ — team lead指出：从系统提示词移走 = 注意率从 70% 降到 1%，是开倒车
- ~~四层架构（喵约/MagicWord/Skill/Gate）~~ — 以前就是分层的（F042），效果不好才膨胀回来的
- ~~场景化动态注入~~ — 小模型匹配需要完整上下文，成本等于再跑一次大模型
- ~~Skill 内联规则本体~~ — 散弹式修改问题，与 F042 单一真相源冲突

## What

### 1. Magic Words（注入 GOVERNANCE_L0_DIGEST）

在系统提示词常驻摘要末尾追加 4 个触发词定义：

| 触发词 | 含义 | 猫的动作 |
|--------|------|---------|
| **「脚手架」** | 你在偷懒写临时方案 | 停，审视产物是否终态，不是→重写 |
| **「绕路了」** | 局部最优但全局绕路 | 停，画出直线路径，丢掉绕路部分 |
| **「喵约」** | 你忘了我们的约定 | 重读 GOVERNANCE_L0_DIGEST，逐条对照当前行为 |
| **「星星罐子」** | P0 不可逆风险 | 停止新增副作用（不发新命令、不写新文件、不 push），等team lead指示 |

> **定位**：Magic Words 是注意力锚点（team lead手动拉闸），不是最终安全机制。最终约束以 Gate 为准。

### 2. 愿景守护 Gate（改造 feat-lifecycle Step 0）

在 `feat-lifecycle/SKILL.md` 的愿景守护步骤加 BLOCKED 条件。

**愿景守护证物对照表**（强制输出格式）：

```markdown
| team experience（逐字引用） | 当前实际状态（截图/代码/命令输出） | 匹配？ |
|----------------------|-------------------------------|--------|
| "把旧 mode 删掉"      | [截图: mode 入口已无旧选项]       | ✅     |
| "狼人杀加到 mode 里"   | [截图: mode 入口有狼人杀]         | ❌     |
```

**BLOCKED 条件**：
- 守护猫输出缺少对照表 → 不放行
- 对照表中有未匹配项 → 不放行，踢回修改
- 找不到team experience（Discussion/Interview 缺失）→ BLOCKED，要求补充

**落点**：复用 `request-review` 已有的 BLOCKED 机制模式，不发明新框架。

## Acceptance Criteria

- [x] AC-1: `GOVERNANCE_L0_DIGEST` 包含 4 个 magic words 定义 + 对应行为
- [x] AC-2: team lead发送「星星罐子」时，猫停止新增副作用并等待指示
- [x] AC-3: `feat-lifecycle` 愿景守护步骤包含 BLOCKED 条件（缺对照表 = 不放行）
- [x] AC-4: 愿景守护输出包含"team experience vs 实际状态"对照表格式
- [x] AC-5: SystemPromptBuilder 测试通过（`pnpm --filter @cat-cafe/api test`）

## Dependencies

- **Evolved from**: F086（反思胶囊）、F073（愿景守护自动化）、F041（教训：AC 全 ✅ 但 UI 不可用）
- **Related**: F059（sync 脚本质量问题是触发本提案的直接案例）

## Risk

| 风险 | 缓解 |
|------|------|
| Magic words 被模型忽略 | Gate 是真正的安全机制，magic words 只是辅助 |
| 对照表增加流程成本 | 只在愿景守护（feat close 前）强制，不影响日常开发 |
| Gate 为文本约束，无运行时门禁（known limitation） | 复用 request-review 已有 BLOCKED 模式；如有跳过证据再立 feature 做运行时 gate |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不瘦身、不分四层、不搞动态注入 | 以前就是分层的（F042），降到 refs 后猫根本不看（1% 注意率） | 2026-03-13 |
| KD-2 | 证物对照表作为愿景守护 Gate 核心 | F101 案例证明 checkbox 审计无效 | 2026-03-13 |
| KD-3 | Magic words 存入 GOVERNANCE_L0_DIGEST | 必须对所有 session/thread 生效 | 2026-03-13 |
| KD-4 | 「星星罐子」= 最高级停机词 | 源自 2026-03-12 repo visibility 事故 | 2026-03-13 |
| KD-5 | Gate > Magic Words（本体 vs 辅助） | Codex/Gemini 有 prompt 补注空窗，纯 prompt 方案不 100% 可靠 | 2026-03-13 |
| KD-6 | 现有 shared-rules 17 条结构不动 | team lead + Ragdoll + Maine Coon三方共识：当前结构是最优折中 | 2026-03-13 |

## Review Gate

- 跨家族 review（Maine Coon review SystemPromptBuilder + feat-lifecycle 改动）
- team lead亲自验收（用真实 magic word 测试猫的反应）

## F177 Phase B 补充：第 7 个 Magic Word「下次一定」

> 2026-04-29 | 由 F177 Phase B 新增 | 设计确认者：47（反向治理——被治理者确认判据设计）

| 触发词 | 含义 | 猫的动作 | 主要适用对象 |
|--------|------|---------|-------------|
| **「下次一定」** | 你在把"未做"包装成"已规划" | 停，审视当前产物每一条"后续/future/next phase"——能做的现在做，做不了的走 cvo_signoff，不准留尾巴 | 全猫适用，47 为主要发病对象 |

**蚊帐机制**：magic word 表只放「下次一定」一个（team lead好喊），但 F177 Phase A 的 quality-gate follow-up 字样扫描（`check-followup-tails.mjs`）同时覆盖语义同族关键词列表。

**47 专属自检协议**：7 个发病时刻 + 对家猫盲审 quality-gate，详见 `cat-cafe-skills/refs/shared-rules.md`「47 自检协议」。
