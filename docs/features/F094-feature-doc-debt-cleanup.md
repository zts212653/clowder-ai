---
feature_ids: [F094]
related_features: [F042, F058, F076, F086, F088]
topics: [documentation, debt-cleanup, template, feature-docs, governance]
doc_kind: spec
created: 2026-03-10
---

# F094: Feature 文档债务清理 — 全量迁移到黄金模板标准

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-03-11

## Why

### 核心痛点

F094 立项时，家里共有 97 个 Feature 文档，质量参差不齐。F086/F088 等近期文档结构完善，但大量早期文档（F001-F038）只有 2-3 个 section，缺 AC、缺 Risk、缺 Dependencies，frontmatter 字段不统一。随着 F095/F096 在执行期间立项，当前最新审计范围已扩到 99 份文档。

**量化债务**（审计脚本实测，2026-03-11 最新）：
- **总文档数**：99 份
- **当前分档**：Green 99 / Yellow 0 / Red 0（当前全量审计已 99/99 全绿）
- **基线分档**（第一轮，立项时 97 份文档）：Green 20 / Yellow 70 / Red 7
- **平均合规度**：100%
- **最高频缺失项（当前）**：无（13 项检查全部清零）
- **重复 Feature ID**：F055、F061、F081 各有 2 份文档（待team lead拍板去留）
- **TEMPLATE.md 过时**：不反映实际最佳实践（已有 `feature-doc-template.md` 取代）
- **ROADMAP.md 脱节**：已清零（`PASS check-feature-truth`）

**Mission Hub Dashboard parser（F058）依赖统一格式**：Phase 标题、AC 编号、Status 行、Dependencies 段——格式不统一就无法自动提取进度。

team experience（2026-03-10）：
> "历史遗留债务必须清理！甚至 mission hub 那个 feat 做了的模板 大家按照那个模板迁移优化重构！"
> "如果模板里有的模块 md 没有就要补齐！如果自己的 feat 有多的文本也要保留 方便我们未来有记忆有回顾！"

### 为什么现在做

1. F058 Mission Hub Dashboard parser 需要统一格式才能可靠解析
2. 文档越积越多，债务只会越来越大
3. 新猫 onboarding 时看到参差不齐的文档会困惑

## What

### 黄金模板标准

以 `cat-cafe-skills/refs/feature-doc-template.md` 为唯一权威模板。黄金范本：F086、F088。

**硬性格式（Parser 依赖）**：
1. YAML Frontmatter（feature_ids / related_features / topics / doc_kind / created）
2. Status 行：`> **Status**: {status} | **Owner**: {owner}`
3. Phase 标题：`### Phase {X}: {名称}`
4. AC 格式：`- [ ] AC-{Phase}{N}: {描述}`
5. Dependencies 段：`**Evolved from** / **Blocked by** / **Related**`

**内容完整性（每个 feat 必须有）**：
- Why（保留team experience/原始动机）
- What（设计说明）
- Acceptance Criteria（done 的 feat 全部 `[x]`）
- Dependencies

**保留原则**：
- 已有的文本内容**全部保留**，只做格式迁移和结构补齐
- team experience、讨论记录、设计决策等历史文本是宝贵记忆，不删不改
- done 的 feat 如果有 Phase 表格/Timeline 等，保留并补齐

### Phase A: 审计 + 模板升级

1. **全量审计**：Phase A 启动时扫描 97 个 feat 文档，按模板完整度分三档；后续随着 F095/F096 立项，最新审计范围扩展到 99 个文档
   - 🟢 Green（≥80% 符合模板）：微调格式即可
   - 🟡 Yellow（50-80%）：需要补 section + 格式化
   - 🔴 Red（<50%）：需要大幅重构
2. **升级 TEMPLATE.md**：用 `feature-doc-template.md` 替换旧 TEMPLATE.md
3. **产出审计报告**：哪些 feat 需要什么级别的修复

### Phase B: 迁移执行（批量）

按优先级迁移：
1. **in-progress / spec 的活跃 feat 优先**（影响当前开发）
2. **done 但近期的（F060+）**其次（记忆新鲜，补齐容易）
3. **done 且早期的（F001-F059）**最后（需要翻 git log 考古）

每个文档迁移：
- Frontmatter 补齐/统一
- Status 行格式化
- 补缺失 section（AC / Dependencies / Risk）
- Phase 标题/AC 编号格式化
- **不改动原有内容文本**，只做结构包装

### Phase C: BACKLOG 对齐 + 验证

1. **ROADMAP.md 清理**：done 的移除、status 对齐实际
2. **自动化验证脚本**：lint 检查所有 feat 文档的模板合规度
3. **CI 集成**（可选）：新 feat 文档不符合模板 → 告警

## Acceptance Criteria

### Phase A（审计 + 模板升级）
- [x] AC-A1: 全量审计报告产出（97 个 feat 的 Green/Yellow/Red 分档）— Maine CoonMaine Coon已交付
- [x] AC-A2: `docs/features/TEMPLATE.md` 更新为最新标准模板 — Maine CoonMaine Coon已完成
- [x] AC-A3: 审计报告含每个 feat 的具体缺失项清单 — 机器读(JSON) + 人读(Markdown)

### Phase B（迁移执行）
- [x] AC-B1: 所有 in-progress/spec feat 文档符合模板标准
- [x] AC-B2: 所有 done feat 文档至少有 Frontmatter + Status 行 + Why + What + AC + Dependencies
- [x] AC-B3: 原有内容文本零丢失（只增不删）
- [x] AC-B4: Phase 标题和 AC 编号符合 parser 格式

### Phase C（BACKLOG 对齐 + 验证）
- [x] AC-C1: ROADMAP.md 与 feat 文档状态一致
- [x] AC-C2: lint 脚本可检查 feat 文档模板合规度
- [x] AC-C3: 全量通过 lint（0 error）

## 需求点 Checklist

| # | 需求点 | AC 映射 | 状态 |
|---|--------|---------|------|
| R1 | 全量 feat 文档审计 | AC-A1, AC-A3 | ✅ Phase A 完成 |
| R2 | 模板标准升级 | AC-A2 | ✅ Phase A 完成 |
| R3 | 活跃 feat 文档迁移（Red 7 + Yellow 批量） | AC-B1, AC-B3, AC-B4 | ✅ Phase B 完成（97/97 全绿） |
| R4 | 已完成 feat 文档迁移 | AC-B2, AC-B3 | ✅ Phase B 完成 |
| R5 | BACKLOG 状态对齐 | AC-C1 | ✅ Phase C 完成 |
| R6 | 自动化验证 | AC-C2, AC-C3 | ✅ Phase C 完成 |

## Dependencies

- **Related**: F042（三层信息架构——定义了文档结构）
- **Related**: F058（Mission Hub Dashboard——parser 依赖统一格式）
- **Related**: F076（Mission Hub——黄金模板范本之一）
- **Related**: F086（Cat Orchestration——黄金模板范本之一）
- **Related**: F088（Chat Gateway——黄金模板范本之一）

## Risk

| 风险 | 缓解 |
|------|------|
| 早期 feat 信息太少，补 AC 需要考古 | done 的 feat AC 可简化（事后追认，标 `[x]`） |
| 批量修改可能误改内容 | "只增不删"原则 + 每批 PR 单独 review |
| 工作量大（97 个文档） | 分 Phase 执行，活跃 feat 优先 |

## Phase A 执行总结（2026-03-10）

### 审计脚本成果
- **脚本位置**：`scripts/audit-feature-doc-template.mjs`（由Maine CoonMaine Coon实现）
- **脚本命令**：`pnpm audit:feature-docs`
- **检查项**：13 项模板合规性检查
  - YAML Frontmatter 完整性
  - Status 行格式标准化
  - Phase 标题和 AC 编号格式
  - Dependencies/Risk 等必填 section
  - Frontmatter 字段规范化
- **输出格式**：
  - 机器读：`docs/features/assets/F094/phase-a-audit.json`（Green/Yellow/Red 分档和每个 feat 的缺失项清单）
  - 人读：`docs/features/assets/F094/phase-a-audit.md`（详细分析报告）

### Phase B 优先级建议
1. **Red 7 份优先修复**（作为第一批验证流程）
   - 风险最低（数量少）
   - 债务最重（<50% 合规）
   - 包括：F064（Risk Management）、F051（猫粮看板）等
2. **Yellow 70 份批量迁移**（按缺失项分组处理）
   - Status 行格式化：一轮脚本半自动化（94 份需要）
   - AC 格式补齐：逐个手写（90 份需要）
   - Dependencies/Risk 补齐：语义层面手写（71+48 份）
3. **Green 20 份微调**（最后）

### Phase B 第一批执行结果（2026-03-10）
- Red 7 份文档已全部迁移完成：`F032/F042/F053/F061/F064/F071/F081`
- 最新审计：`97 份 = Green 27 / Yellow 70 / Red 0`
- 迁移策略保持“只增不删”，仅补结构壳（Status/Why/What/AC/Dependencies/Risk）

### Phase B 第二批执行结果（2026-03-10）
- Yellow 第一批 15 份已完成：`F001~F015`
- 本批策略：优先修复高频项（Status 行标准化 + AC 编号格式 + Dependencies 标签 + Risk）
- 最新审计：`97 份 = Green 42 / Yellow 55 / Red 0`

### Phase B 第三批执行结果（2026-03-10）
- Yellow 第二批 15 份已完成：`F016~F030`
- 本批策略：延续高频项修复（Status 行 + AC 格式 + Dependencies 标签 + Risk）
- 最新审计：`97 份 = Green 57 / Yellow 40 / Red 0`

### Phase B 第四批执行结果（2026-03-10）
- Yellow 第三批 14 份已完成：`F031 + F033~F046`（含 `F040-backlog-reorganization.md`）
- 本批策略：延续高频项修复（Status 行 + AC 格式 + Dependencies 标签 + Risk）
- 最新审计：`97 份 = Green 71 / Yellow 26 / Red 0`

### Phase B 第五批执行结果（2026-03-10）
- Yellow 第四批 14 份已完成：`F047~F059`（含 F055 双文档）
- 本批策略：延续高频项修复（Status 行 + AC 格式 + Dependencies 标签 + Risk）
- 最新审计：`97 份 = Green 77 / Yellow 20 / Red 0`

### Phase B 第六批执行结果（2026-03-10）
- Yellow 第五批 17 份已完成：`F060~F075`（含 F061 双文档）
- 本批策略：延续高频项修复（Status 行 + AC 格式 + Dependencies 标签 + Risk）
- 最新审计：`97 份 = Green 86 / Yellow 11 / Red 0`

### Phase B 第七批执行结果（2026-03-11）
- Yellow 收官批 11 份已完成：`F076/F077/F078/F079/F080/F082/F083/F086/F088/F089/F091`
- 本批策略：补齐模板硬项（Status 行 + AC 格式 + Dependencies 标签 + 缺失章节）
- 最新审计：`97 份 = Green 97 / Yellow 0 / Red 0`

### Phase B 收口加固（2026-03-11）
- 为 6 份已 green 但非满分文档补齐严格模板项：`F081/F084/F085/F087/F090/F092`
- 审计结果升级为：`averageScore=100`、`missingFrequency={}`

### 技术决策
- **不解决的问题**：F055/F081 重复 ID 暂时只标注，等team lead拍板后单独处理（不污染主迁移批次）
- **检查失败处理**：Phase C 已完成 BACKLOG 对齐，`check:features` 已全量通过

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 以 `feature-doc-template.md` 为唯一模板标准 | 已有 parser 依赖此格式 | 2026-03-10 |
| KD-2 | "只增不删"——原有文本全部保留 | 历史记忆比格式统一更重要 | 2026-03-10 |

## Review Gate

- Phase A: 审计报告 → team lead确认分档合理
- Phase B: 每批迁移 → 跨猫 review（确认没丢内容）
- Phase C: lint 脚本 → 跨猫 review
