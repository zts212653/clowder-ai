---
feature_ids: [F040]
topics: [metadata, frontmatter, documentation]
doc_kind: decision
created: 2026-02-27
---

# ADR-011: 文档元数据契约（Frontmatter Contract）

> 日期：2026-02-27
> 状态：**已批准** — 三猫收敛 (4.5 + 4.6 + GPT-5.2) + 铲屎官确认
> 参与者：Ragdoll（方案设计）、Opus 4.6（审查）、Maine Coon/GPT-5.2（审查）、铲屎官（确认）

## 背景

2026-02-26 铲屎官发现 BACKLOG 蜘蛛网问题：
- Feature (F1-F39) 和 Tech Debt (#1-#103) 混编
- 一个 Feature 的文档散落在 feature-specs/feature-discussions/review-notes/bug-reports
- 问"F21 什么情况"要搜 85 个文件

根因：缺乏统一的元数据契约，文档之间的关联靠人记忆，无法机器索引。

## 决策

### A. Frontmatter Schema

所有 `docs/` 下的 `.md` 文件都应该有 YAML frontmatter：

```yaml
---
feature_ids: [F040]           # 关联的 Feature，可为空 []
debt_ids: [TD086]             # 关联的 Tech Debt，可为空 []
topics: [memory, backlog]     # 松散标签
doc_kind: discussion          # 文档类型（必填）
created: 2026-02-26           # 创建日期
---
```

### B. `doc_kind` 枚举值

| 值 | 用途 |
|----|------|
| `plan` | 设计/实现计划 |
| `discussion` | 讨论记录 |
| `research` | 技术调研 |
| `bug-report` | Bug 报告 |
| `mailbox` | 交接/review 信 |
| `decision` | 架构决策（ADR） |
| `note` | 其他笔记 |

### C. `feature_ids` + `debt_ids` 双字段

- Bug report 通常关联到 Tech Debt（修复某个债务），而非 Feature
- 一个文档可以同时有 `feature_ids` 和 `debt_ids`
- 判断标准：修复的是 Feature 的 bug → `feature_ids`；修复的是独立登记的 Tech Debt → `debt_ids`

### D. `stage` 不下沉到普通文档

**关键决策**：`stage` 只保留在 `features/Fxxx.md` 的 Status 字段，**不放入普通文档 frontmatter**。

理由（4.6 提出）：
- `stage` 是 Feature 的状态，不是文档的状态
- 如果 661 个文件都有 `stage`，Feature 状态变了就要到处改——又是蜘蛛网
- 单点真相源原则：Feature 状态只在聚合文件记录

### E. 编号规范

| 类型 | 格式 | 示例 |
|------|------|------|
| Feature | `F001` | F001, F021, F040 |
| Tech Debt | `TD001` | TD001, TD089 |

- 三位固定宽度（Maine Coon建议：一次到位，避免 F100+ 再改名）
- 不再用 `#`（避免和 PR/issue 冲突）
- 不再用后缀（F21++ → F021，演进用 `Evolved from` 字段）

## 否决方案

### 1. `stage` 全仓下沉（否决）

方案：每个文档都有 `stage: idea|spec|in-progress|review|done`

否决理由：
- 661 个文件每次状态变化都要同步 → 蜘蛛网 2.0
- 单点真相源原则违背
- 4.6 原话："状态字段多点写入会复发蜘蛛网"

### 2. 用 tag 代替 feature_ids（否决）

方案：`tags: [F040, memory, backlog]` 不区分 ID 和松散标签

否决理由：
- 语义模糊：`F040` 是强引用还是松散标签？
- 机器解析困难
- 无法区分"关于这个 Feature"和"提到了这个 Feature"

### 3. 单一 `related_ids` 字段（否决）

方案：`related_ids: [F040, TD086]` 不区分 Feature 和 Tech Debt

否决理由：
- Bug report 绑定 Tech Debt 的场景很常见
- 分开字段语义更清晰
- 查询时可以分别过滤

## 实现

### 已完成

- [x] Frontmatter contract 定义（本 ADR）
- [x] `feat-kickoff` skill 强制新文档加 frontmatter
- [x] `feat-completion` skill 检查关联文档 frontmatter
- [x] 迁移脚本 `scripts/migrate-frontmatter.mjs`（Maine Coon）
- [x] 历史文档补录（50+ 文件，Maine Coon）
- [x] SOP 更新"完成后真相源同步"章节

### 待完成

- [ ] 机器索引 `docs/features/index.json`（可选，P3）
- [ ] frontmatter lint 集成到 CI（可选，P3）

## 追溯

本决策来自 F040 讨论，详见：
- `docs/features/F040-backlog-reorganization.md`
- 2026-02-26 三猫 + 铲屎官讨论 thread

---

*教训来源：2026-02-26 BACKLOG 蜘蛛网问题诊断。`stage` 多点写入是 2.0 版蜘蛛网的根因。*
