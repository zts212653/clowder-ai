---
feature_ids: [F152]
related_features: [F070, F102, F076]
topics: [memory, cross-project, bootstrap, knowledge-engineering, onboarding]
doc_kind: spec
created: 2026-04-08
---

# F152: Expedition Memory — 外部项目记忆冷启动 + 经验回流

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

猫猫团队不只做 cat-cafe 自己的项目。社区用户用猫猫去做他们自己的项目——鸿蒙 app 迁移、昇腾算子迁移、已有 codebase 改造。这些项目不是从零开始的，有自己的代码、文档、历史。

F102 已经做完了记忆引擎（6 接口 + SQLite 基座 + 全局/项目层 + 联邦检索），F070 做完了治理/方法论随猫走。但猫去到一个**已有的外部项目**时：

1. **没有记忆**：项目没有 `evidence.sqlite`，IndexBuilder 只认 cat-cafe 的 `docs/` 结构，无法吃进 README / CHANGELOG / 散落 .md / package metadata
2. **无法快速理解**：项目已有大量代码和文档，猫每次从零开始读
3. **经验不回流**：猫在外部项目踩的坑（如"鸿蒙某 API 兼容性问题"）沉淀在那个项目里，下次去别的鸿蒙项目时用不上

> team experience（2026-04-08）："社区小伙伴使用你们，大概率不是开发你们，而是用你们开发其他项目。别人是让你们去做他们自己的项目，甚至别人的项目未必从零开始。这才是他们的痛点。"

## What

### Phase A: GenericRepoScanner — 让 IndexBuilder 能吃非 cat-cafe 结构的项目

当前 `IIndexBuilder` 只扫描 `docs/` 下有 YAML frontmatter 的 .md 文件。外部项目的知识源完全不同。

**核心改动**：给 IndexBuilder 加 **pluggable scanner** 策略：
- `CatCafeScanner`（现有的，不动）
- `GenericRepoScanner`（新增，面向任意仓库）

**GenericRepoScanner 扫描源（按优先级）**：

| 层级 | 来源 | 置信度 |
|------|------|--------|
| authoritative | README.md, docs/*.md, ADR, ARCHITECTURE.md, CONTRIBUTING.md | 高 |
| derived | package.json / Cargo.toml / go.mod / pyproject.toml / repo structure | 中 |
| soft clues | CHANGELOG, code comments, commit message patterns | 低 |

**关键设计约束**（Maine Coon护栏）：
- Scanner 输出必须带 **provenance**（来源类型 + 原始路径），不能只吐 `EvidenceItem`
- 三层置信度不能混成一个平面搜索结果
- 输出格式化为 `EvidenceItem` 后直接入现有 `IEvidenceStore`，不改存储层

### Phase B: Expedition Bootstrap Orchestrator — 猫进新项目时自动冷启动记忆

猫进入外部项目后的自动化编排流程：

```
检测 evidence.sqlite 是否存在
  ├─ 存在 → 检查新鲜度 → 需要更新？→ incremental rebuild
  └─ 不存在 → 触发 bootstrap:
       1. 选择 scanner（检测项目结构 → CatCafe or Generic）
       2. 运行 scanner → 建索引
       3. 生成"项目概况摘要"（技术栈、目录结构、核心模块、已有文档）
       4. 摘要写入 evidence.sqlite 作为第一条 evidence
```

**挂载点**：复用 F070 的出征 hook（`project-init`），不发明新流程。

**非空项目特殊处理**：
- 大仓库（>10k 文件）：只扫描 authoritative + derived 层，跳过 soft clues
- 已有 cat-cafe 结构的项目：直接用 `CatCafeScanner`，不走 Generic

### Phase C: Global Lesson Distillation — 可泛化经验回流全局层

猫在外部项目产生的 lesson / decision，如果具有跨项目泛化价值，应该回流到 `global_knowledge.sqlite`。

**流程**：
```
外部项目的 lesson/decision
  → 标记 generalizable: true/false（默认 false — fail-closed）
  → generalizable: true → 进入 candidate queue
  → 审核（team lead或猫猫 review）
  → approved → 写入全局层
```

**泛化判定规则**：
- 领域通用模式（如"鸿蒙某类 API 迁移坑"）→ `generalizable: true`
- 项目私有上下文（如"张三项目的数据库 schema"）→ `generalizable: false`
- 不确定 → 默认 `false`，宁可漏回流不可污染全局

**隐私护栏**：
- 回流内容必须脱敏（移除项目名、人名、URL 等私有标识）
- 全局层只存方法论/模式，不存具体项目的实现细节

## Acceptance Criteria

### Phase A（GenericRepoScanner）
- [ ] AC-A1: `GenericRepoScanner` 能扫描一个没有 cat-cafe `docs/` 结构的普通 Git 仓库，产出 `EvidenceItem[]`
- [ ] AC-A2: 每个 `EvidenceItem` 带 `provenance` 字段（`source_type: authoritative|derived|soft_clue` + `source_path`）
- [ ] AC-A3: `IIndexBuilder` 根据项目结构自动选择 `CatCafeScanner` 或 `GenericRepoScanner`
- [ ] AC-A4: 扫描结果可被 `IEvidenceStore.search()` 正常检索（FTS5 + 向量）
- [ ] AC-A5: 大仓库（>10k 文件）扫描完成时间 < 60 秒（只扫 authoritative + derived）

### Phase B（Expedition Bootstrap Orchestrator）
- [ ] AC-B1: 猫进入一个没有 `evidence.sqlite` 的外部项目时，自动触发 bootstrap
- [ ] AC-B2: Bootstrap 产出"项目概况摘要"（技术栈、目录结构、核心模块、已有文档列表）
- [ ] AC-B3: 已有 `evidence.sqlite` 的项目不重复 bootstrap（幂等性）
- [ ] AC-B4: Bootstrap 挂载到 F070 的 `project-init` hook

### Phase C（Global Lesson Distillation）
- [ ] AC-C1: 外部项目的 lesson/decision 可以被标记 `generalizable: true/false`
- [ ] AC-C2: 默认 `generalizable: false`（fail-closed）
- [ ] AC-C3: `generalizable: true` 的 candidate 走审核流程后才能写入 `global_knowledge.sqlite`
- [ ] AC-C4: 回流内容自动脱敏（移除项目私有标识）
- [ ] AC-C5: team lead亲手体验一轮完整的"出征→冷启动→干活→经验回流"链路

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "别人的项目未必从零开始" — 能吃已有项目 | AC-A1, AC-A3 | test: 对一个普通 Git 仓库运行 scanner | [ ] |
| R2 | 猫去外部项目能快速理解项目现状 | AC-B1, AC-B2 | manual: bootstrap 后猫能回答项目基本问题 | [ ] |
| R3 | "用你们开发其他项目" — 不要求先搭 cat-cafe 标准目录 | AC-A1, AC-A3 | test: 无 docs/ 结构的仓库能正常扫描 | [ ] |
| R4 | 猫踩的坑能带回来下次用 | AC-C1~C4 | manual: 一条经验从外部项目回流到全局层 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F102（记忆引擎 6 接口 + SQLite 基座 + 联邦检索）
- **Evolved from**: F070（Portable Governance — 治理/方法论随猫走 + `project-init` hook）
- **Related**: F076（Mission Hub 跨项目面板 — 未来可在 Hub 展示出征项目记忆状态）

## Risk

| 风险 | 缓解 |
|------|------|
| GenericRepoScanner 对大仓库扫描太慢 | 分层扫描：先 authoritative，按需加载 derived/soft_clues |
| 全局层被外部项目私有知识污染 | fail-closed 默认 + 脱敏 + 审核 |
| Scanner 对不同语言/框架的项目支持不全 | Phase A 先支持 Node.js/Python/Rust/Go，按社区反馈扩展 |
| 外部项目的文档质量参差不齐 | provenance 分层 + 置信度区分，低质量来源降权 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 三 Phase 精简方案（不是五 Phase） | F102 底座已覆盖 80%，Task-Time Growth 和 Product Surface 不需要单独拆 Phase | 2026-04-08 |
| KD-2 | Scanner 输出带 provenance + 三层置信度 | Maine Coon护栏：不带来源信息后面无法区分置信度、无法决定回流策略 | 2026-04-08 |
| KD-3 | Global distillation fail-closed（默认不回流） | Maine Coon护栏：防止甲方私有语境污染全局层 | 2026-04-08 |
| KD-4 | 复用 F070 `project-init` hook 而不是发明新流程 | 已有出征基础设施，减少概念负担 | 2026-04-08 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon优先）
- Phase B: 跨家族 review + team lead短验收（在一个真实外部项目上 bootstrap）
- Phase C: 跨家族 review + team lead全链路验收（出征→冷启动→干活→回流）
