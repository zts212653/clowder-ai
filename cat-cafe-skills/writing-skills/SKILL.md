---
name: writing-skills
description: >
  创建或修改 Cat Café skill / MCP tool description 的元技能（含质量标准、范本、发布）。
  Use when: 写新 skill、修改现有 skill、写/改 MCP tool description、验证 skill 质量；
  或者功能实现中产出了 SKILL.md / cat-cafe-skills/ 新目录 / manifest.yaml skill 条目。
  Not for: 使用 skill（直接触发对应 skill）。
  Output: 新/更新的 SKILL.md + manifest 条目 + symlinks。
  GOTCHA: 软硬同重——skill/MCP 质量 = 代码质量；不要写模型已知的通用教程，先过价值门禁。
triggers:
  - "写 skill"
  - "新 skill"
  - "修改 skill"
  - "SKILL.md"
  - "cat-cafe-skills/"
  - "manifest.yaml skill"
  - "创建 hook"
  - "新增 hook"
  - "写 MCP"
  - "MCP description"
  - "tool description"
---

# Writing Skills — Skill & MCP 元技能

## 铁律：软硬同重

**Skill 和 MCP 的质量 = 代码的质量。** 写得烂的 skill/MCP description → 猫选错工具 → 用户体验差。
写 skill = 为未来的猫写路标；写 MCP description = 为模型写路由信号。两者都不是日记。

## 价值门禁：别教聪明猫写 for 循环

写 skill 前先判定：它是不是在给聪明 agent 复述训练集里已经很强的通用知识？

> 好 skill 不是教聪明猫写 for 循环；好 skill 是把领域 know-how、历史坑、证据标准、行为刹车放到猫会自然经过的位置。

必须至少命中一项，否则不要写成 skill：

| 价值来源 | 适合写什么 | 不要写什么 |
|----------|------------|------------|
| **领域 know-how** | 项目/行业/供应商特有规则、版本坑、真相源路径 | React/pytest/for-loop 这类通用教程 |
| **历史坑** | 家里真实踩过的错误、rationalization、反例库 | 作者想象的最佳实践 |
| **证据标准** | 要读哪些源、怎样证明完成、何时升级 | “要认真”“要高质量” |
| **行为刹车** | 模型会但压力下会跳过的动作，如 TDD、查证、review、球权 | 模型本来稳定会做的步骤 |
| **认知路径** | 让猫想到该用的工具/MCP/真相源 | 把现成 docs 复制进上下文 |

更完整判据见 `writing-skills/cat-cafe-skill-quality-principles.md`。

## 开工前：先看范本再动手

**不要凭空写。** 先读一个同类型的好例子，理解家里的风格和标准。

| 我要写... | 先看这个范本 | 为什么好 |
|-----------|-------------|---------|
| 流程型 skill | `cat-cafe-skills/tdd/SKILL.md` | 清晰的分步流程 + 红绿重构纪律 |
| 调试型 skill | `cat-cafe-skills/debugging/SKILL.md` | 根因定位方法论 + 假设验证 |
| 门禁型 skill | `cat-cafe-skills/quality-gate/SKILL.md` | 检查清单 + 硬门禁 + 下一步 |
| MCP tool | `refs/mcp-tool-description-standard.md` 的好/差对比 | 五要素全覆盖 |

> 写 MCP tool 前还要 **grep 家里现有同类 tool 的 description**，保持风格一致。

## 四份必读文档的 T0 精华

以下是核心原则。详细展开、案例拆解、模板见对应 ref 文件。

### T0-0：Skill 价值门禁（Cat Café）

Skill 不是知识垃圾桶。写之前先选择正确载体：

| 需求 | 载体 |
|------|------|
| 通用语法/API，模型已经知道 | 不写；按需查官方文档 |
| 时效性强的外部事实 | Reference + 明确“必须查官方源” |
| 项目特有流程/历史坑/证据标准 | Skill |
| 高风险且可机械检测的行为 | Hook / runtime guard，不靠 prompt |
| 工具可发现性问题 | Skill + MCP description + system prompt 路标 |

### T0-1：Description 是路由信号，不是摘要（Anthropic + 知识工程指南）

Description 决定猫"要不要触发"。三层加载机制：
1. **常驻层**：猫只看到 `name + description`（所有 skill/tool 的元数据常驻 system prompt）
2. **加载层**：被判定相关时，SKILL.md 正文才进入上下文
3. **按需层**：refs/scripts/assets 再按需读取

> **description 写不好 = 正文永远进不了上下文 = "抽屉里没人翻的菜谱"**

**三件套格式（必须）**: `Use when ... / Not for ... / Output: ...`
- 详见 `writing-skills/anthropic-best-practices.md`（Anthropic 原文）
- 详见 *(internal reference removed)* §1.4（进场门票机制）

### T0-2：Gotchas 是最高价值内容（Anthropic）

Skill/MCP 里最值钱的不是流程描述，是 **Common Mistakes / GOTCHA** 段落。这是猫犯过的错的沉淀。
- 每个 skill 必须有 `Common Mistakes` 段
- 每个 MCP tool description 必须有 `GOTCHA` 段（和相似工具的区别）
- **持续迭代**：猫踩了新坑就补进去，不是写完就不管

### T0-3：不惊吓原则（知识工程指南）

Skill 的行为不得超出 description 承诺的范围。副作用动作（发消息、写数据、提交代码）必须在 description 里显式声明。

### T0-4：反例至少出现两次（知识工程指南）

只写 "Use when" 不写 "Not for" = 边界模糊 → 误触发。反例要在 **description** 和 **正文** 都出现。
每个 skill 至少：2 条正例 + 2 条反例 + 1 条灰例。

### T0-5：Skill 是文件夹，不只是 markdown（Anthropic）

用文件系统做 progressive disclosure：模板放 `assets/`、脚本放 `scripts/`、参考放 `refs/`。
Claude 会按需读取这些文件。重材料移到子文件，SKILL.md 正文控制在 150 行内。

### T0-6：MCP Description 五要素（MCP 规范）

```
1. 做什么（一句话能力）
2. 什么时候用（触发关键词 / 用户常见表述）
3. 不做什么（排除错误路由 + 和相似 tool 的区别）
4. 产物（调用后会发生什么，含副作用）
5. GOTCHA（陷阱 + 易混工具区分）
```
> 缺一个就是不合格。详见 `refs/mcp-tool-description-standard.md`

## Skill 类型（Anthropic 9 分类 + 我们的 3 分类）

| Anthropic 分类 | 我们家的例子 | 我们的分类 |
|---------------|------------|-----------|
| Library & API Reference | refs/rich-blocks, refs/mcp-tool-description-standard | Reference |
| Product Verification | quality-gate, browser-preview | Technique |
| Business Process & Team Automation | feat-lifecycle, merge-gate | Pattern |
| Code Quality & Review | tdd, request-review, receive-review | Pattern |
| Code Scaffolding & Templates | worktree | Technique |
| Runbooks | debugging, incident-response | Technique |
| CI/CD & Deployment | merge-gate, opensource-ops | Technique |

## SKILL.md 结构模板

```markdown
---
name: skill-name-with-hyphens
description: >
  Use when [触发条件]. Not for [排除条件]. Output: [产出契约].
---
# Skill Name
## 价值门禁 / Why This Is a Skill（不是通用教程的理由）
## 核心知识 / Overview（1-2 句）
## 流程 / When to Use（触发 + 排除）
## Quick Reference（表格/bullet，供扫视）
## Common Mistakes（错误 → 后果 → 修复，持续迭代！）
## 验证 / Pressure Test（如何证明 skill 防住了真实失败）
## 和其他 skill 的区别（防误触发）
## 下一步（进入哪个 skill）
```

## 概念边界指南：易混概念必须在 description 里区分

| 容易混的 | 区别 | 在 description 里怎么写 |
|---------|------|----------------------|
| 毛线球（create_task） vs checklist（rich block） | 毛线球=thread 级持久任务面板；checklist=消息内嵌清单 | GOTCHA: 长期追踪用 create_task，不要用 checklist rich block |
| post_message vs cross_post_message | post=当前 thread；cross=跨 thread | NOT for: posting to other threads (use cross_post_message) |
| generate_document vs create_rich_block | generate=自动投递 IM；create=消息内嵌展示 | GOTCHA: Do NOT manually pandoc + create_rich_block |

> **写新 skill/MCP 时，问自己："有没有和现有工具/概念容易混的？"有就必须在 GOTCHA 里写清楚。**

## 发布检查清单

1. **源文件**：`cat-cafe-skills/{skill-name}/SKILL.md`（+ 支持文件）
2. **同步**：`pnpm sync:skills`（不要手动 ln -s）
3. **注册**：`manifest.yaml` 添加条目（triggers / not_for / output / next）
4. **验证**：`pnpm check:skills` 全绿
5. **Commit**：包含 `cat-cafe-skills/{skill-name}/`

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 凭空写，不看范本 | 风格不一致、质量参差 | **先看范本表里的好例子** |
| Description 含流程摘要 | 猫走捷径不读 SKILL.md | 只写触发条件（T0-1） |
| 没有 GOTCHA/Common Mistakes 段 | 猫反复踩同一个坑 | **必须有**，持续补（T0-2） |
| 写通用教程 | 浪费 token、锚定到平庸模板 | 只保留领域 know-how / 历史坑 / 证据标准 / 行为刹车 |
| 把 high-risk 行为只写进 prompt | 模型压力下仍会绕过 | 能机械检测就做 hook/runtime guard |
| 没有 RED 场景 | 不知道 skill 防住了什么 | 先看 agent 在无 skill 时怎么失败 |
| 设计 rigid debate 流程 | 限制模型思辨，讨论像演戏 | 只保护独立思考、证据、分歧保留和收敛 |
| 只写 Use when 不写 Not for | 误触发 | 反例写两次：description + 正文（T0-4） |
| 忘了问"和谁容易混" | 猫选错工具 | 看概念边界指南，写 GOTCHA（T0-6） |
| 文件 >150 行 | 超 token 预算 | 重材料移到 refs/（T0-5） |
| 功能实现时产出了 skill 但没加载 writing-skills | 漏 sync、漏 manifest | **动了 cat-cafe-skills/ 就必须加载本 skill** |
| MCP description 缺要素 | 猫路由失败 | 用五要素检查清单审查（T0-6） |

## 深入学习（按需阅读）

| 主题 | 文件 | 看什么 |
|------|------|--------|
| Cat Café skill 质量哲学 | `writing-skills/cat-cafe-skill-quality-principles.md` | 废话 skill 判定、载体选择、激发/刹车边界 |
| Anthropic 官方 skill 写法 | `writing-skills/anthropic-best-practices.md` | 9 类 skill、progressive disclosure、hooks |
| 知识工程完整方法论 | *(internal reference removed)* | 触发设计、正反灰例、8 个可复用模式 |
| MCP description 五要素+审查清单 | `refs/mcp-tool-description-standard.md` | 好/差对比、inputSchema 规范、错误返回 |
| Skill TDD 测试方法 | `writing-skills/testing-skills-with-subagents.md` | 红绿重构、压力测试、弹孔表 |

## 和其他 Skill 的区别

- `tdd`：写**代码**的测试驱动纪律 — writing-skills 是写 **skill/MCP** 的质量纪律
- `quality-gate`：**代码**完成后的自检 — writing-skills 是 **skill 文件**的质量检查
- `self-evolution`：从经验中**提炼**知识对象 — writing-skills 是把知识对象**写成合格的 skill**

## 下一步

完成 skill 后 → `pnpm check:skills` 全绿 → `pnpm sync:skills` → 如有新功能立项则 `feat-lifecycle`
