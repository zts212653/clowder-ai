---
name: domain-modeling
tips_exempt: documentation discipline routed by explicit modeling requests and the skill manifest
description: >
  主动建立和校准项目领域模型，并把已确认的语言与少量关键决策写回仓库。
  Use when: 讨论代码库术语、统一 bounded-context 语言、创建或修改 CONTEXT.md、或记录真正必要的 ADR。
  Not for: 只读取 glossary、实现细节文档、普通代码修改、容易逆转或没有真实取舍的决定。
  Output: 按仓库约定更新的 CONTEXT.md / CONTEXT-MAP.md + 仅在三条件同时成立时创建的 ADR。
  GOTCHA: CONTEXT.md 只能是领域 glossary；写文件前先服从目标仓库既有路径、frontmatter 和文档约定。
triggers:
  - "领域建模"
  - "统一术语"
  - "CONTEXT.md"
  - "写 ADR"
---

# Domain Modeling

Actively sharpen the project's domain model while designing: challenge conflicting terms, invent edge-case scenarios, compare claims with code, and record language or decisions when they crystallize.

Merely reading `CONTEXT.md` for vocabulary is not this skill. Use it when the model itself is changing.

## Resolve the Repository Convention First

Before writing, read the repository governance and existing documentation structure. Existing canonical glossary/ADR locations, naming, numbering, frontmatter, or feature-truth rules override the defaults below.

Default for a single-context repository:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

If `CONTEXT-MAP.md` exists, use it to locate multiple contexts and place context-specific glossaries or ADRs accordingly. Create files lazily: only when the first resolved term or qualifying decision exists.

## During the Session

### Challenge the glossary

When the user's language conflicts with the canonical glossary, surface the conflict immediately and ask which meaning is intended.

### Sharpen fuzzy language

When a term is vague or overloaded, propose one precise canonical term and explicitly list the meanings it replaces or excludes.

### Test concrete scenarios

Probe relationships with concrete edge cases. Scenarios should force clarity about concept boundaries, ownership, identity, lifecycle, and failure behavior.

### Cross-check with code

When a claim describes current behavior, inspect the relevant code. If code and proposed model disagree, report the contradiction rather than silently choosing one.

### Update the glossary inline

Once a term is resolved, update the canonical `CONTEXT.md` immediately using [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md), adapted to repository conventions.

`CONTEXT.md` is a glossary only. It must not become a spec, scratchpad, implementation guide, or decision log.

### Offer ADRs sparingly

Create or offer an ADR only when all three conditions hold:

1. **Hard to reverse** — changing the decision later has meaningful cost.
2. **Surprising without context** — a future reader is likely to question why it was chosen.
3. **A real tradeoff** — credible alternatives existed and were rejected for specific reasons.

If any condition is absent, skip the ADR. Use [ADR-FORMAT.md](./ADR-FORMAT.md), adapted to repository conventions.

## 正反灰例

- 正例：同一个“account”在需求和代码里分别代表 Customer 与 User，需要选定语言和边界。
- 正例：跨 context 的集成方式难以逆转、违反直觉且有真实替代方案，需要记录原因。
- 反例：只需查 `CONTEXT.md` 理解一个已有术语；直接读取即可。
- 反例：记录函数参数、表结构或重试算法；这些属于 spec/implementation docs。
- 灰例：一个重要但容易回滚的命名选择可以写入 glossary，但不应写 ADR。

## Common Mistakes

| 错误 | 后果 | 修正 |
|---|---|---|
| 强行创建根目录 `CONTEXT.md` | 破坏多 context 或仓库真相源 | 先查 `CONTEXT-MAP.md` 与项目约定 |
| glossary 记录实现细节 | 领域语言被版本细节污染 | 只定义领域概念与禁用同义词 |
| 用户描述与代码冲突时默认信一边 | 旧实现或新认知被悄悄覆盖 | 展示证据，让冲突成为显式决策 |
| 为所有决定写 ADR | ADR 失去信噪比 | 三个门槛缺一不可 |
| 自创文档格式 | 触发项目治理或索引漂移 | 既有规范优先，模板仅为默认值 |

## 下一步

需要系统追问时与 `grilling` 组合为 `grill-with-docs`；模型确认后再进入 `writing-plans`。
