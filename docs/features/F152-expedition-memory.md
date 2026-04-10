---
feature_ids: [F152]
related_features: [F070, F102, F076]
topics: [memory, cross-project, bootstrap, knowledge-engineering, onboarding]
doc_kind: spec
created: 2026-04-08
---

# F152: Expedition Memory — 外部项目记忆冷启动 + 经验回流

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

### 产品愿景：AI FDE（Forward Deployed Engineer）

Palantir 的核心模式是 FDE——派真人工程师驻场到客户公司，深入理解业务，定制解决方案。本质是 **平台能力 + 驻场人员的业务理解 = 交付价值**。

Cat Café 的猫猫就是 AI 版 FDE：带着知识工程方法论，"部署"到用户的业务系统中，指导和完成开发。AI FDE 比人类 FDE 有一个关键优势——**跨客户知识迁移**：猫在项目 A 学到的领域模式，回流全局层后，去项目 B 的猫直接就能用。人类 FDE 很难做到这种规模化经验复用。

大量企业已经完成信息化（有系统、有代码、有文档、有流程），但信息化如何与 AI 结合还缺少探索。F152 就是让猫能当 AI FDE 的底层能力——**冷启动理解业务 + 经验跨项目回流**。

### 具体痛点

社区用户用猫猫去做他们自己的项目——鸿蒙 app 迁移、昇腾算子迁移、已有 codebase 改造。这些项目不是从零开始的，有自己的代码、文档、历史。

F102 已经做完了记忆引擎（6 接口 + SQLite 基座 + 全局/项目层 + 联邦检索），F070 做完了治理/方法论随猫走。但猫去到一个**已有的外部项目**时：

1. **没有记忆**：项目没有 `evidence.sqlite`，IndexBuilder 只认 cat-cafe 的 `docs/` 结构，无法吃进 README / CHANGELOG / 散落 .md / package metadata
2. **无法快速理解**：项目已有大量代码和文档，猫每次从零开始读
3. **经验不回流**：猫在外部项目踩的坑（如"鸿蒙某 API 兼容性问题"）沉淀在那个项目里，下次去别的鸿蒙项目时用不上

> team experience（2026-04-08）："社区小伙伴使用你们，大概率不是开发你们，而是用你们开发其他项目。别人是让你们去做他们自己的项目，甚至别人的项目未必从零开始。这才是他们的痛点。"
>
> team lead补充（2026-04-09）："很多企业都完成信息化，但是信息化如何和 AI 结合？未必有探索。"
>
> 社区洞察（2026-04-09）："这些小猫可以变为 Palantir 概念里面的 FDE，指导和完成业务系统的开发。"

## What

### Phase 0: Knowledge Engineering Skill — 猫猫指导外部项目文档重构

Scanner 再强也只能吃已有的文档。如果项目连结构化文档都没有（IdeaHub 的真实场景：有 AW 接口文档和脚本，但业务知识全在人脑里），扫出来的东西价值极低。

**两条路径**：

```
猫进入外部项目
  ├─ 路径 1（Guided）：用户想学最佳实践
  │   → 猫用 knowledge-engineering skill 指导文档重构
  │   → 三层知识注入（领域手册 → 模式库 → 检索管道）
  │   → 重构后 CatCafeScanner 直接吃
  │
  └─ 路径 2（Autonomous）：用户不需要帮助
      → GenericRepoScanner 扫描现有结构
      → 尽力而为（provenance 置信度会偏低）
```

**Knowledge Engineering Skill 核心内容**（从 IdeaHub 咨询提炼的可复用方法论）：

1. **P0 领域手册**（1-2 天）：业务概念词典 + 业务规则表 + 操作路径映射
2. **P1 模式库**（2-3 天）：从已有代码/脚本中抽取可复用模式（AI 抄 example 是 1:1，学 pattern 是 1:N）
3. **P2 执行反馈循环**：生成→运行→报错→修复（TDD 思路）
4. **P3 检索管道**：文档索引 + 语义搜索（这就是 F102 已经做好的）

**Skill 还要能处理的特殊场景**：
- 代码仓和文档仓分离 → 猫要能识别并提醒用户"文档放什么、怎么放"
- 文档散落在 wiki/Confluence/飞书 → 猫要能指导迁移策略
- 项目只有代码没有文档 → 猫从代码结构推导出文档骨架建议

### Phase A: GenericRepoScanner — 让 IndexBuilder 能吃非 cat-cafe 结构的项目

当前 `IIndexBuilder` 只扫描 `docs/` 下有 YAML frontmatter 的 .md 文件。外部项目的知识源完全不同。

**核心改动**：从 IndexBuilder 抽出 **pluggable scanner 策略**（Design Gate 决策）：

```typescript
interface RepoScanner {
  discover(root: string): ScannedEvidence[];
}

interface ScannedEvidence {
  item: Omit<EvidenceItem, 'sourceHash'>;
  provenance: { tier: 'authoritative' | 'derived' | 'soft_clue'; source: string };
  rawContent: string;
}
```

- `CatCafeScanner implements RepoScanner`：从现有 `IndexBuilder.discoverFiles()` 抽出
- `GenericRepoScanner implements RepoScanner`：新增，面向任意仓库
- `IndexBuilder`：持有 `scanner: RepoScanner`，只负责 dedupe/hash/upsert/edges

**GenericRepoScanner v1 扫描源**：

| 层级 | 来源 | 置信度 | 映射 EvidenceKind |
|------|------|--------|------------------|
| authoritative | README*, docs/**/*.md, ARCHITECTURE*, CONTRIBUTING*, ADR*.md | 高 | `plan` |
| derived | package.json / Cargo.toml / go.mod / pyproject.toml / workspace manifests | 中 | `research` |
| soft_clues | CHANGELOG.md, .github/ISSUE_TEMPLATE/** | 低 | `lesson` |

**v1 不扫**（Maine Coon否决，噪音高+性能贵）：commit message patterns、code comments。

**关键设计约束**（Design Gate 收敛）：
- Scanner 输出 `ScannedEvidence`（不是裸 `EvidenceItem`），带 provenance + tier
- **存储层最小增量改动**：`EvidenceItem` 加可选 `provenance` 字段，SQLite schema 加 `provenance_tier TEXT` + `provenance_source TEXT` 列
- `projectRoot` 和 `docsRoot` 必须分开建模，`sourcePath` 统一为 **repo-relative**（不是 docs-relative）
- `EvidenceKind` 枚举不扩展，差异通过 provenance 表达
- 三层置信度不能混成一个平面搜索结果

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

**实现**：新建 `ExpeditionBootstrapService`（不挂在现有 `project-init.ts` CLI 上——那只是 scaffold 脚手架）。

**挂载点**：接入 F070 的治理 bootstrap 链路（`projects-setup.ts` capability orchestrator），不发明新流程。

**幂等条件**：不是单纯"db 存在就跳过"，而是检查 fingerprint + freshness（repo HEAD hash + 上次扫描时间）。

**非空项目特殊处理**：
- 大仓库（>10k 文件）：只扫描 authoritative + derived 层，跳过 soft_clues
- 已有 cat-cafe 结构的项目：直接用 `CatCafeScanner`，不走 Generic
- monorepo：Phase B 先做 detection + overview，不做 per-package 深扫

**Bootstrap 摘要**：先走结构化提取（tech stack / dir tree / module list），LLM 只做可选润色，不把冷启动绑死在模型额度上。

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

### Phase 0（Knowledge Engineering Skill）✅
- [x] AC-01: `knowledge-engineering` skill 存在且可被猫猫加载
- [x] AC-02: Skill 能识别外部项目的文档现状（有结构化文档 / 只有代码 / 文档散落 / 代码文档分仓）
- [x] AC-03: Skill 输出三层知识注入建议（领域手册 → 模式库 → 检索管道），内容基于 IdeaHub 咨询方法论
- [x] AC-04: Skill 能生成文档骨架模板（概念词典、规则表、操作映射），用户填充后可被 CatCafeScanner 索引
- [x] AC-05: Bootstrap 流程中，猫在路径选择点（Guided vs Autonomous）向用户说明两条路径的差异

### Phase A（GenericRepoScanner）✅
- [x] AC-A1: `GenericRepoScanner` 能扫描一个没有 cat-cafe `docs/` 结构的普通 Git 仓库，产出 `ScannedEvidence[]`
- [x] AC-A2: 每个 `ScannedEvidence` 带 `provenance: { tier: 'authoritative'|'derived'|'soft_clue', source: string }`（canonical naming，统一全 spec）
- [x] AC-A3: `IIndexBuilder` 根据项目结构自动选择 `CatCafeScanner` 或 `GenericRepoScanner`
- [x] AC-A4: 扫描结果可被 `IEvidenceStore.search()` 正常检索（FTS5 + 向量）
- [x] AC-A5: 大仓库（>10k 文件）扫描完成时间 < 60 秒（只扫 authoritative + derived）
- [x] AC-A6: 检索契约：`IEvidenceStore.search()` 支持 `provenance_tier` filter；authoritative 结果默认 boost 排序权重（三层不混成平面）

### Phase B（Expedition Bootstrap Orchestrator）
- [ ] AC-B1: 猫进入一个没有 `evidence.sqlite` 的外部项目时，自动触发 bootstrap
- [ ] AC-B2: Bootstrap 产出"项目概况摘要"（技术栈、目录结构、核心模块、已有文档列表）
- [ ] AC-B3: 已有 `evidence.sqlite` 的项目不重复 bootstrap（幂等性）
- [ ] AC-B4: Bootstrap 挂载到 F070 的治理 bootstrap 链路（`projects-setup` capability orchestrator）
- [ ] AC-B5: 幂等条件基于 repo HEAD hash + 上次扫描时间（fingerprint/freshness），不是单纯 db 存在检测
- [ ] AC-B6: Bootstrap 摘要先走结构化提取，不强依赖 LLM 额度

### Phase C（Global Lesson Distillation）
- [ ] AC-C1: 外部项目的 lesson/decision 可以被标记 `generalizable: true/false`
- [ ] AC-C2: 默认 `generalizable: false`（fail-closed）
- [ ] AC-C3: `generalizable: true` 的 candidate 走审核流程后才能写入 `global_knowledge.sqlite`
- [ ] AC-C4: 回流内容自动脱敏（移除项目私有标识）
- [ ] AC-C5: team lead亲手体验一轮完整的"出征→冷启动→干活→经验回流"链路

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R0 | "如果对方希望学习最佳实践，先帮人家做一次文档重构" | AC-01~05 | manual: skill 指导用户完成文档骨架 | [ ] |
| R1 | "别人的项目未必从零开始" — 能吃已有项目 | AC-A1, AC-A3 | test: 对一个普通 Git 仓库运行 scanner | [ ] |
| R2 | 猫去外部项目能快速理解项目现状 | AC-B1, AC-B2 | manual: bootstrap 后猫能回答项目基本问题 | [ ] |
| R3 | "用你们开发其他项目" — 不要求先搭 cat-cafe 标准目录 | AC-A1, AC-A3 | test: 无 docs/ 结构的仓库能正常扫描 | [ ] |
| R4 | 猫踩的坑能带回来下次用 | AC-C1~C4 | manual: 一条经验从外部项目回流到全局层 | [ ] |
| R5 | "代码仓可能和文档分开" — 猫要能识别并提醒 | AC-02 | manual: 猫检测到文档分仓场景时给出建议 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F102（记忆引擎 6 接口 + SQLite 基座 + 联邦检索）
- **Evolved from**: F070（Portable Governance — 治理/方法论随猫走 + 治理 bootstrap 链路 `projects-setup`）
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
| KD-0 | 加 Phase 0: Knowledge Engineering Skill（两条路径：Guided vs Autonomous） | team lead纠偏：Scanner 再强也只能吃已有文档，真正帮到用户的是指导文档重构（IdeaHub 咨询实证） | 2026-04-09 |
| KD-1 | 三 Phase 精简方案（不是五 Phase）→ 调整为 Phase 0+A+B+C | Phase 0 是 skill 层（不涉及引擎改动），不改原有三 Phase 的工程边界 | 2026-04-08 |
| KD-2 | Scanner 输出带 provenance + 三层置信度 | Maine Coon护栏：不带来源信息后面无法区分置信度、无法决定回流策略 | 2026-04-08 |
| KD-3 | Global distillation fail-closed（默认不回流） | Maine Coon护栏：防止甲方私有语境污染全局层 | 2026-04-08 |
| KD-4 | 复用 F070 治理 bootstrap 链路（不是 `project-init.ts` CLI） | `project-init.ts` 只是 scaffold，真正的 hook 在 `projects-setup.ts` capability orchestrator | 2026-04-08 |
| KD-5 | Scanner 独立成策略类，不在 IndexBuilder 里加分支 | `docsRoot` 写死在 IndexBuilder 4+ 处（L149/L331/L356/L962），直接扫 repo root 会导致 `sourcePath` 错语义 | 2026-04-08 |
| KD-6 | provenance 持久化到存储层（`provenance_tier` + `provenance_source` 列） | 否决 keywords hack（编码到 keywords 数组），Maine Coon判定为 hack | 2026-04-08 |
| KD-7 | `projectRoot` 和 `docsRoot` 分开建模，`sourcePath` 统一 repo-relative | 避免 `../README.md` 错语义 | 2026-04-08 |
| KD-8 | Bootstrap 摘要先结构化提取，LLM 可选润色 | 不把冷启动绑死在模型额度上 | 2026-04-08 |
| KD-9 | monorepo 先 detection + overview，不做 per-package 深扫 | 控制 Phase B 复杂度 | 2026-04-08 |
| KD-10 | Phase A v1 不扫 commit messages 和 code comments | 噪音高、语言相关、性能贵，Maine Coon否决 | 2026-04-08 |
| KD-11 | 经验回流双层路由：猫猫审核通道（四条件同时满足：provenance≥derived + 可验证 + 事实型 + 已脱敏）+ team lead审核通道（命中任一敏感条件即上升）；Phase C 初期先全量人审校准再逐步放权 | Ragdoll×Maine Coon(GPT-5.4) 讨论收敛 + team lead授权分层 | 2026-04-09 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon优先）
- Phase 0: Skill 层，writing-skills 流程验收
- Phase A: 跨家族 review（Maine Coon优先）
- Phase B: 跨家族 review + team lead短验收（在一个真实外部项目上 bootstrap）
- Phase C: 跨家族 review + team lead全链路验收（出征→冷启动→干活→回流）
