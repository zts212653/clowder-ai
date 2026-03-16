# Feature Doc 标准模板

> **用途**：新 Feature 立项时复制此模板到 `docs/features/F{NNN}-{slug}.md`
> **为什么规范化**：Mission Hub 的 Feature Progress Dashboard 需要从 feature docs 自动提取 Phase 进度、AC 完成度、依赖关系、风险等。格式统一 = parser 可靠。
> **决策来源**：F058 Phase I — KD-6（2026-03-10）

---

## 模板正文（复制以下内容）

```markdown
---
feature_ids: [F{NNN}]
related_features: []
topics: []
doc_kind: spec
created: {YYYY-MM-DD}
---

# F{NNN}: {Feature Name}

> **Status**: spec | **Owner**: {猫猫名} | **Priority**: {P0/P1/P2}

## Why

{一段话说清楚为什么要做。铲屎官原话如有请引用。}

## What

### Phase A: {Phase 名称}

{Phase A 的设计说明}

### Phase B: {Phase 名称}

{Phase B 的设计说明。按需增减 Phase。}

## Acceptance Criteria

### Phase A（{Phase 名称}）
- [ ] AC-A1: {验收条件}
- [ ] AC-A2: {验收条件}

### Phase B（{Phase 名称}）
- [ ] AC-B1: {验收条件}

## Dependencies

- **Evolved from**: {F0xx}（{说明}）
- **Blocked by**: {F0xx}（{说明}）
- **Related**: {F0xx}（{说明}）

## Risk

| 风险 | 缓解 |
|------|------|
| {风险描述} | {缓解方案} |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | {问题} | ⬜ 未定 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | {决策} | {理由} | {YYYY-MM-DD} |

## Timeline

| 日期 | 事件 |
|------|------|
| {YYYY-MM-DD} | 立项 |

## Review Gate

- Phase A: {review 策略}

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F0xx-xxx.md` | {关联说明} |
```

---

## 格式要求（Parser 依赖）

以下格式约定是 **硬性的**，Progress Dashboard parser 依赖这些结构：

### 1. YAML Frontmatter（必须）
| 字段 | 必须 | 说明 |
|------|------|------|
| `feature_ids` | ✅ | `[F058]`，单元素数组 |
| `related_features` | ✅ | `[F049, F037]`，可为空数组 `[]` |
| `topics` | ✅ | 分类标签，可为空 |
| `doc_kind` | ✅ | `spec`（活跃）/ `note`（回顾/关闭） |
| `created` | ✅ | `YYYY-MM-DD` |

### 2. Status 行（必须）
```
> **Status**: {status} | **Owner**: {owner}
```
有效 status 值：`spec` → `in-progress` → `done`

### 3. Phase 标题（必须，如果有多 Phase）
```
### Phase {X}: {名称}
```
- Phase 标记用大写字母 A/B/C/...
- parser 通过 `### Phase {X}` 正则提取

### 4. AC 格式（必须）
```
- [ ] AC-{Phase}{N}: {描述}      ← 未完成
- [x] AC-{Phase}{N}: {描述}      ← 已完成
```
- AC 编号格式：`AC-A1`、`AC-B2`（Phase 字母 + 序号）
- parser 通过 `- \[([ x])\] AC-` 提取完成度

### 5. Dependencies 段（推荐）
```
- **Evolved from**: F0xx
- **Blocked by**: F0xx
- **Related**: F0xx
```
- parser 通过 `**Evolved from**`/`**Blocked by**`/`**Related**` 正则提取
- YAML frontmatter 的 `related_features` 也会被读取

### 6. Risk 表格（推荐）
保持 `| 风险 | 缓解 |` 两列表格格式。

---

## 轻量 vs 完整

- **小 Feature**（≤1 Phase，几天完成）：可以省略 Timeline、Review Gate、Links、Key Decisions
- **大 Feature**（多 Phase，跨周）：建议所有段落都填
- **最低要求**：Frontmatter + Status 行 + Why + What + AC + Dependencies
