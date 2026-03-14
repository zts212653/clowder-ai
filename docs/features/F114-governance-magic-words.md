---
feature_ids: [F114]
related_features: [F086, F073, F041]
topics: [governance, quality, prompt-engineering, magic-words]
doc_kind: spec
created: 2026-03-13
---

# F114: 喵约治理升级 — 四层架构 + Magic Words + Evidence Gate

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

### team experience

> "我感觉做愿景守护的喵，要么他没有认真的看我的愿景，要么你们两只猫的人类意图理解能力有问题。但是这个问题在于，按照你跟Maine Coon的智力水平，这句话不应该理解错。" — team lead 2026-03-13

> "我们的家规或者喵约里面很多很重要的该怎么办？" — team lead 2026-03-13

> "我觉得这种脚本需要加一个 log 写进度条，不然都不知道他是不是死了" — team lead 2026-03-13（评价平行 session 跑 sync 脚本）

> "如果一天就能写完，你还要做那些先搞一个垃圾版本……可能又搞了一周都没干完" — team lead 2026-03-13（评价 Claude Code 系统提示词的"avoid over-engineering"倾向）

### 问题根因

1. **重要规则写了但不遵守**：喵约已在系统提示词级别注入（`SystemPromptBuilder.ts` L220-L371），与 Anthropic 原生指令同一强度。但猫仍然违反"P1 终态基座不是脚手架"等关键原则。证明"注入了 ≠ 会遵守"。

2. **愿景守护流于形式**：F101（mode v2 / 狼人杀）案例——team lead愿景是"删旧 mode，把狼人杀加入 mode"。第一次：狼人杀做了但没加入 mode。第二次：旧 mode 删了但狼人杀还是没入口。两次愿景守护都没拦住。规则 `shared-rules.md §9` 写着"AC 全打勾 ≠ 完成"，但守护猫只审计了 checkbox，没有从用户视角验证体验。

3. **Anthropic 系统提示词的对冲效应**：Claude Code 系统提示词包含 "Avoid over-engineering... three similar lines of code is better than a premature abstraction... Don't design for hypothetical future requirements"。这与喵约的"方向正确 > 速度"、"每步产物是终态基座"直接冲突。当两组指令同时存在时，更具体、更省力的那组倾向于赢。

4. **声明式规则的固有弱点**：写"问自己team lead体验如何"就像在公路上立"注意安全"牌子——没有任何机制能验证猫是否真的执行了这个思考过程。

### 解决什么

让关键治理规则从"写在那里靠自觉"变成"必须产出证物才能通过的硬门禁"，同时给team lead一组 magic words 作为紧急注意力锚点。

## What

### Phase A: Magic Words + 喵约瘦身

在 `GOVERNANCE_L0_DIGEST` 中注入 magic words 定义，精简现有规则层级。

**Magic Words 定义**：

| 触发词 | 含义 | 猫的动作 |
|--------|------|---------|
| **「脚手架」** | 你在偷懒写临时方案 | 立刻停，重新审视产物是否终态，不是→重写 |
| **「绕路了」** | 局部最优但全局绕路 | 停，画出从当前到终点的直线路径，丢掉绕路部分 |
| **「喵约」** | 你忘了我们的约定 | 重读 GOVERNANCE_L0_DIGEST 全部原则，逐条对照当前行为，输出对照表 |
| **「星星罐子」** | P0 不可逆风险 | 立刻停止新增副作用（不发新命令、不写新文件、不 push），进入等待指示状态 |

> **定位**：Magic Words 是注意力锚点，不是最终安全机制。最终约束以 Gate 为准。Magic Words 解决"猫走神了拉一下"，Gate 解决"就算走神也过不去"。

**喵约瘦身**：将 `GOVERNANCE_L0_DIGEST` 压缩到以下 5 条宪法级原则，其余降级到 Skill 层：

1. **终态基座不是脚手架**（P1）— 每步产物可直接叠加，不需要推倒重来
2. **方向正确 > 速度**（P3）— 方向错误的加速 = 浪费
3. **可验证才算完成**（P5）— 没有证据（测试/截图/日志）= 没完成
4. **实事求是，多源证据**（纪律）— 结论基于代码+commit+PR+文档，不够就说"还没查完"
5. **出口检查 / 路由纪律**（纪律）— 发 @ 前问"到我这里结束了吗？"

### Phase B: Evidence Gate（证物门禁）— F114 核心

> **这是 F114 的真正护城河。** Magic Words 可能被忽略（跟现有规则一样），但 Gate 是外部机制，猫不产出证物就物理上无法进入下一步。

改造愿景守护和完成声明流程，要求必须产出结构化证物。

**首批 Gate 落点（2 个，不多不少）**：

1. **`request-review` Gate**：发 review 请求时，缺少team experience摘录或证据 → BLOCKED（复用现有 request-review skill 的 BLOCKED 机制）
2. **愿景守护 Gate**：守护猫输出缺少"原话 vs 证物对照表" → 不放行，踢回修改

**愿景守护证物对照表**（强制格式）：

```markdown
| team experience（逐字引用） | 当前实际状态（截图/代码/命令输出） | 匹配？ |
|----------------------|-------------------------------|--------|
| "把旧 mode 删掉"      | [截图: mode 入口已无旧选项]       | ✅     |
| "狼人杀加到 mode 里"   | [截图: mode 入口有狼人杀]         | ❌     |

未匹配项 > 0 → 不放行，踢回修改
```

**完成声明门禁**：声称"完成"必须附：
- team experience摘录（≥1 条）
- 证据（测试输出 / 截图 / 命令输出）
- 对照结论（一句话："team lead说 X，现在的状态是 Y，匹配/不匹配"）

### Phase C: 四层架构落地 + 升级管道

将治理体系正式分为四层，并建立规则升级机制：

| 层 | 职责 | 内容量 | 变更频率 |
|----|------|--------|---------|
| **喵约层** | 宪法级原则，"我们是谁" | ≤5 条 | 极低 |
| **Magic Word 层** | 注意力锚点，紧急拉闸 | ≤5 个词 | 低 |
| **Skill 层** | 操作步骤，场景化方法 | 不限 | 中 |
| **Gate 层** | 硬门禁，必须产出证物 | 按需升级 | 中 |

**升级管道**：
```
规则写入 Skill 层 → 同类错误复发 2 次 → 提案升级为 Gate
```

升级标准三条件（全满足才升）：
1. 违背代价高（返工 / team lead崩溃 / 不可逆）
2. 能客观检查（有明确的"有证物 / 没证物"判断）
3. 已经重复犯过（≥2 次同类违反记录）

## Acceptance Criteria

### Phase A（Magic Words + 喵约瘦身）
- [ ] AC-A1: `GOVERNANCE_L0_DIGEST` 包含 magic words 定义（4 个触发词 + 对应动作）
- [ ] AC-A2: team lead发送「脚手架」时，猫输出"当前产物 vs 终态"对比分析
- [ ] AC-A3: team lead发送「星星罐子」时，猫停止新增副作用并进入等待指示状态
- [ ] AC-A4: 喵约层精简到 ≤5 条宪法级原则
- [ ] AC-A5: `pnpm --filter @cat-cafe/api test` 通过（SystemPromptBuilder 测试）

### Phase B（Evidence Gate）
- [ ] AC-B1: 愿景守护输出包含"team experience vs 实际状态"对照表
- [ ] AC-B2: 对照表中有未匹配项时，守护猫明确拒绝放行
- [ ] AC-B3: 完成声明必须附team experience摘录 + 证据
- [ ] AC-B4: `request-review` skill 缺少team experience摘录/证据时输出 BLOCKED
- [ ] AC-B5: 愿景守护缺"原话 vs 证物对照表"时守护猫明确不放行

### Phase C（四层架构 + 升级管道）
- [ ] AC-C1: `shared-rules.md` 重构为四层结构
- [ ] AC-C2: 文档化升级管道流程（何时从 Skill → Gate）
- [ ] AC-C3: 至少 2 条现有规则按升级标准完成 Gate 化

## Dependencies

- **Evolved from**: F086（反思胶囊 + 元思考触发器）、F073（愿景守护自动化）、F041（教训：AC 全 ✅ 但 UI 不可用）
- **Related**: F059（开源同步——sync 脚本质量问题是触发本提案的直接案例）

## Risk

| 风险 | 缓解 |
|------|------|
| Magic words 被模型忽略（跟现有规则一样不起作用） | 设计为具体行为指令而非抽象原则；Phase B 的 evidence gate 是硬机制不靠自觉 |
| 喵约瘦身后遗漏重要原则 | 降级不是删除，只是从喵约层移到 Skill 层 |
| Evidence gate 增加流程成本 | 只对 Gate 层规则强制，Skill 层仍靠自觉；gate 条目按升级管道逐步增加 |
| Anthropic 系统提示词更新后冲突变化 | Magic words 不依赖对抗 Anthropic 指令，而是提供更具体的行为指令 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 四层架构（喵约/Magic Word/Skill/Gate） | Ragdoll + Maine Coon独立思考后合并的共识方案 | 2026-03-13 |
| KD-2 | 证物对照表作为 evidence gate 核心机制 | F101 狼人杀案例证明：checkbox 审计无效，只有逐条对照team experience才能防漂移 | 2026-03-13 |
| KD-3 | Magic words 存入 SystemPromptBuilder（不是 memory） | 必须对所有 session/thread 生效，不能只存个人记忆 | 2026-03-13 |
| KD-4 | 「星星罐子」作为最高级停机词 | 源自 2026-03-12 repo visibility 事故（597 星仓库误操作），team lead命名 | 2026-03-13 |
| KD-5 | F114 与社区 F113-F116 编号治理分开处理 | 社区编号是 F059 的 intake/triage 问题，F114 专注内部治理 | 2026-03-13 |
| KD-6 | Gate 是核心护城河，Magic Words 是辅助 | Codex/Gemini 有 system prompt 压缩补注空窗，纯 prompt 方案不可靠 | 2026-03-13 |
| KD-7 | 喵约层锁定 5 条：终态基座/方向>速度/可验证/实事求是/出口检查 | Maine Coon提议直接锁候选避免空转，Ragdoll同意 | 2026-03-13 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon review SystemPromptBuilder 改动）
- Phase B: team lead亲自验收（用真实 magic word 测试猫的反应）

## 需求点 Checklist

> 来源：team lead 2026-03-13 对话

- [ ] RC-1: team lead说「脚手架」→ 猫停下来检查产物是否终态
- [ ] RC-2: team lead说「星星罐子」→ 猫立刻停手
- [ ] RC-3: 愿景守护必须对照team experience，不能只看 AC checkbox
- [ ] RC-4: 同一条规则被违反 2 次 → 升级为硬门禁
- [ ] RC-5: 喵约不再膨胀，保持 ≤5 条宪法级原则
- [ ] RC-6: 所有 session/thread 的猫都能读到 magic words（系统提示词级注入）
