---
name: writing-skills
description: >
  创建或修改 Cat Café skill 的元技能（含 CSO、测试、发布）。
  Use when: 写新 skill、修改现有 skill、验证 skill 质量；
  或者功能实现中产出了 SKILL.md / cat-cafe-skills/ 新目录 / manifest.yaml skill 条目。
  Not for: 使用 skill（直接触发对应 skill）。
  Output: 新/更新的 SKILL.md + manifest 条目 + symlinks。
triggers:
  - "写 skill"
  - "新 skill"
  - "修改 skill"
  - "SKILL.md"
  - "cat-cafe-skills/"
  - "manifest.yaml skill"
  - "创建 hook"
  - "新增 hook"
---

# Writing Skills — Skill 元技能

## 核心原则

Skill 是可复用的技术参考，不是一次性解法叙述。
**写 skill = 为未来的猫写路标，不是写日记。**

## Skill 类型

| 类型 | 是什么 | 例子 |
|------|--------|------|
| Technique | 具体方法（有步骤） | debugging |
| Pattern | 思维模型（有原则） | tdd |
| Reference | 查阅文档（API/工具） | refs/pr-template |

## SKILL.md 结构模板

```markdown
---
name: skill-name-with-hyphens
description: Use when [具体触发条件]. Not for [排除条件]. Output: [产出契约].
---

# Skill Name

## 核心知识 / Overview
一两句话说明是什么、核心原则。

## 流程 / When to Use
触发条件（bullet list）+ 排除条件。

## Quick Reference
表格或 bullet，供扫视。

## Common Mistakes
错误 → 修复。

## 和其他 skill 的区别
防止误触发。

## 下一步
完成本 skill 后进入哪个 skill。
```

## CSO：Description 是分类器，不是摘要

**铁律：description 只描述触发条件，绝不总结流程内容。**

原因：description 进入 system prompt，若含流程摘要，猫猫会按摘要行动而跳过读 SKILL.md。

```yaml
# ❌ 错：含流程摘要 — 猫猫会走捷径
description: Use when creating skills — run baseline, write SKILL.md, test, deploy

# ✅ 对：只有触发条件 + 排除 + 产出
description: Use when creating new skills, editing existing skills, or verifying skill quality. Not for using skills.
```

**三件套格式（必须）**: `Use when ... / Not for ... / Output: ...`

## Cat Café 发布检查清单

新 skill 或修改 skill 后，必须完成以下步骤（否则部分猫看不到）：

1. **源文件**：`cat-cafe-skills/{skill-name}/SKILL.md`（+ 支持文件）
2. **Symlink 三猫**（OpenCode 读 `~/.claude/`，无需单独挂）：
   ```bash
   SKILLS_SRC=/path/to/cat-cafe/cat-cafe-skills
   ln -s $SKILLS_SRC/{skill-name} ~/.claude/skills/{skill-name}
   ln -s $SKILLS_SRC/{skill-name} ~/.codex/skills/{skill-name}
   ln -s $SKILLS_SRC/{skill-name} ~/.gemini/skills/{skill-name}
   ```
3. **注册**：在 `manifest.yaml` 添加条目（含 triggers / not_for / output / next）
4. **验证**：`pnpm check:skills` — 全绿 + 0 警告
5. **Commit**：包含 `cat-cafe-skills/{skill-name}/`

> 详细创建流程（TDD 红绿重构、压力测试、弹孔表）见 `writing-skills/testing-skills-with-subagents.md`
> Anthropic 官方 skill 写作最佳实践见 `writing-skills/anthropic-best-practices.md`
> **MCP tool description 规范见 `refs/mcp-tool-description-standard.md`**（写/改 MCP tool 必读）

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| Description 含流程摘要 | 猫猫走捷径不读 SKILL.md | 只写触发条件 |
| 忘记 symlink | 某只猫找不到 skill | 补 symlink（claude/codex/gemini）+ check:skills |
| 功能实现时产出了 skill 但没加载 writing-skills | 漏 symlink、漏 manifest、漏 BOOTSTRAP | **动了 cat-cafe-skills/ 就必须加载本 skill** |
| 忘记 manifest 注册 | check:skills 报警告 | 添加 manifest 条目 |
| 文件 >150 行 | 超出 token 预算 | 重材料移到 refs/ |
| Name 含特殊字符 | YAML 解析失败 | 只用字母、数字、连字符 |

## 和其他 Skill 的区别

- `tdd`：写代码的测试驱动纪律 — writing-skills 是写 **文档** 的质量纪律
- `quality-gate`：开发完成后的代码自检 — writing-skills 是 **skill 文件** 的质量检查

## 下一步

完成 skill 后 → 运行 `pnpm check:skills` → 如有新功能立项则 `feat-lifecycle`
