---
feature_ids: []
topics: [cat, cafe, skills]
doc_kind: decision
created: 2026-02-26
status: drifted
drifted_by: [F070]
last_reviewed: 2026-04-07
drift_note: >
  F070 (2026-03-08) introduced project-level governance skill mounts
  (.claude/.codex/.gemini/skills), creating a dual-layer mount model
  that ADR-009 did not anticipate. Runtime mount policy, health checks,
  and capabilities board now operate on inconsistent assumptions.
  See clowder-ai#386 for community report.
---

# ADR-009: Cat Café Skills 分发策略

> **⚠️ DRIFTED** — 本决策的"仅用户级分发"假设已被 [F070](../features/F070-portable-governance.md) 的项目级 governance bootstrap 事实性推翻。当前系统同时存在用户级和项目级两层挂载，且无一致性校验。新的 canonical mount policy 待定（successor ADR 待立）。
>
> 原始决策内容保留如下，作为历史记录。

> 状态：~~已决策~~ → drifted（2026-04-07 标注）
> 日期：2026-02-10
> 决策者：铲屎官 + Ragdoll

## 背景

Cat Café Skills 是从 Superpowers 改进而来的协作规则 skills，需要让三只猫都能加载。

### 问题

1. 三只猫读取 skills 的位置不同
2. 当前 `.claude/skills/` 被 gitignored，无法提交到 repo
3. 需要让 skills 在任何项目中都能加载（用户级）

## 调研结果

### 三猫 Skills 目录

| 猫 | 用户级（全局） | 项目级 | 当前状态 |
|----|----------------|--------|----------|
| Claude | `~/.claude/skills/` | `.claude/skills/` | 用户级不存在 |
| Codex | `~/.codex/skills/` | `.codex/skills/`? | 用户级存在，有 20+ skills |
| Gemini | `~/.gemini/skills/` | `.gemini/skills/` | 用户级不存在 |

### 来源

- Claude: [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- Codex: `~/.codex/skills/` 和 `~/.codex/superpowers/` 实际存在
- Gemini: [Agent Skills | Gemini CLI](https://geminicli.com/docs/cli/skills/)

## 决策

### 1. 源目录（Git 追踪）

创建 `cat-cafe-skills/` 作为源目录：

```
cat-cafe/
└── cat-cafe-skills/           # ← Git 追踪的源目录
    ├── merge-approval-gate/
    │   └── SKILL.md
    ├── spec-compliance-check/
    │   └── SKILL.md
    ├── cross-cat-handoff/
    │   └── SKILL.md
    ├── cat-cafe-requesting-review/
    │   └── SKILL.md
    ├── cat-cafe-receiving-review/
    │   └── SKILL.md
    └── feat-discussion/
        └── SKILL.md
```

### 2. Symlink 到用户级 Skills 目录

让三只猫在**任何项目**都能加载这些 skills：

```bash
# 源目录绝对路径
SOURCE=/path/to/project-skills

# Claude 用户级（每个 skill 单独 symlink）
mkdir -p ~/.claude/skills
for skill in "$SOURCE"/*/; do
  ln -sf "$skill" ~/.claude/skills/$(basename "$skill")
done

# Codex 用户级
for skill in "$SOURCE"/*/; do
  ln -sf "$skill" ~/.codex/skills/$(basename "$skill")
done

# Gemini 用户级
mkdir -p ~/.gemini/skills
for skill in "$SOURCE"/*/; do
  ln -sf "$skill" ~/.gemini/skills/$(basename "$skill")
done
```

**重要**：必须为每个 skill 创建单独的 symlink，不能用目录级 symlink（Claude Code 不会递归扫描子目录）。

### 3. 为什么选择用户级而非项目级

1. **任何项目都能用**：Cat Café 的协作规则应该对三只猫在任何项目都生效
2. **单一来源**：源文件在 `cat-cafe-skills/`，symlink 到三个用户级目录
3. **易于更新**：更新源文件，三只猫自动同步
4. **可开源分享**：`cat-cafe-skills/` 在 git 里，别人可以 clone 后自己 symlink

## 实施步骤

```bash
# 1. 创建源目录
mkdir -p cat-cafe-skills

# 2. 移动现有 skills（从 .claude/skills/）
mv .claude/skills/merge-approval-gate cat-cafe-skills/
mv .claude/skills/spec-compliance-check cat-cafe-skills/
mv .claude/skills/cross-cat-handoff cat-cafe-skills/
mv .claude/skills/cat-cafe-requesting-review cat-cafe-skills/
mv .claude/skills/cat-cafe-receiving-review cat-cafe-skills/
mv .claude/skills/feat-discussion cat-cafe-skills/

# 3. 创建用户级 symlinks
mkdir -p ~/.claude/skills ~/.gemini/skills
ln -s $(pwd)/cat-cafe-skills ~/.claude/skills/cat-cafe-skills
ln -s $(pwd)/cat-cafe-skills ~/.codex/skills/cat-cafe-skills
ln -s $(pwd)/cat-cafe-skills ~/.gemini/skills/cat-cafe-skills
```

## Tradeoff

### 选择了
- 用户级 symlink（全局生效）
- 单一源目录（易于维护）

### 放弃了
- 项目级 skills（需要每个项目都配置）
- 复制而非 symlink（多份维护困难）

## 否决理由（P0.5 回填）

- **备选方案 A**：仅保留项目级 skills（不做用户级分发）
  - 不选原因：每个项目都要重复配置，三猫跨项目协作规则无法稳定复用。
- **备选方案 B**：把 skill 文件复制到三套用户目录（不使用 symlink）
  - 不选原因：会形成多份副本并导致版本漂移，后续维护成本高且容易失配。
- **备选方案 C**：目录级单个 symlink（不按 skill 粒度链接）
  - 不选原因：部分客户端不会递归扫描子目录，可能出现“已链接但不可加载”的隐性故障。

**不做边界**：本轮不引入自动安装器和跨机器同步脚本，先以单一源目录 + 用户级链接为基线。

## 相关文档

