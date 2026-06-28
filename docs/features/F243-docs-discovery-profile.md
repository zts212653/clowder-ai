---
feature_ids: [F243]
related_features: [F236, F186, F038]
topics: [docs, discovery, profile, frontmatter, index, okf]
doc_kind: spec
created: 2026-06-17
tips_exempt: spec-only — docs index generation not yet implemented, no user-facing capability
---

# F243: Docs Discovery Profile — OKF-inspired metadata + generated index

> **Status**: spec | **Owner**: Ragdoll (Ragdoll Opus-4.7) | **Priority**: P1

> **Co-design**: Maine Coon (gpt-5.5) co-designed scope 4+1（命名 / 4-Phase 骨架 / F236 Related 不造 taxonomy / Eval primary=冷启动 / `> Summary:` 镜像 guardrail）+ R1 review sharpen（Owner/reviewer 红线 / F186 scope creep / parser 验证）。Maine Coon是 reviewer 不是 Owner（避免同体 review 红线），具体 contribution 标注在 KD-1/3/4/5/6/7/8/9/10 + Timeline 2026-06-17 entries。

## Why

**Maine Coon钉死的一句话（vision 锚）**：不是为了符合 OKF，也不是为了自动生成 description，**而是让 `docs/features` 从平铺文件堆变成可渐进探索的知识入口**。

operator 2026-06-15 启动："来吧你来综合一下三只喵喵的想法的"（OKF 学习路径）→ "这个 description 要如何保证不漂移？" → "小心 这可能会变成我们提防的 小猫代替大猫做决策" → 2026-06-17 operator signoff："a 吧先 feat 立项 然后！ 然后Maine Coon喵回来了！你可以喊他讨论了"。

**真实痛点（实证 ≠ 感觉乱）**：
- `docs/features/` 有 200+ 个 F 号文档，**无入口索引**。任何猫初次进入要么 `ls` 200 行眼花、要么 `grep -i` 多轮碰运气、要么 `search_evidence` 但 snippet 不一定够判断
- **凭记忆引路必错**：本 brainstorm thread 内Bengal Opus 引用 F186 时把文件名记成 `F186-library-stewardship.md`，实际是 `F186-library-memory-architecture.md`（`F188` 才是 `library-stewardship`）。**两只猫凭记忆引路都会错认文档名**
- **F242 立项时（5 小时前）我自己也要靠 `grep -E "^\| F[0-9]+" docs/ROADMAP.md | tail`** 才知道最大 F 号——`ROADMAP.md` 是任务跟踪不是知识地图
- 业界共振：Google Cloud 2026-06-12 发布 OKF v0.1，专门标准化"LLM-wiki pattern"（`AGENTS.md` / `CLAUDE.md` family of convention files），证明这是普遍痛点

**价值一句话**：让"猫初次找 feature" 从 "ls + grep + search_evidence 多轮碰运气" 变成 "看 index 一眼就知道有什么、点哪篇、为什么相关"。OKF 是 lineage（lingua franca 兼容性），不是目标。

## Current State / 现状基线

实测证据（2026-06-17）：

| 维度 | 现状 | 证据 |
|---|---|---|
| feature docs 数量 | 200+ | `ls docs/features/*.md \| wc -l`（200+）|
| 入口形态 | 平铺文件 + ROADMAP.md（任务跟踪）| 无 `docs/features/index.md`，无统一 profile |
| frontmatter 萌芽 | F186/F086 已有 `doc_kind/feature_ids/topics/related_features/created` | grep frontmatter 显示**字段一致约 90%**，但**无 `description` 字段** |
| description 字段 | ❌ 全仓库无（frontmatter 字段层）| 按 YAML frontmatter parser 验证 `description` 字段 = 0；注：纯 `grep "^description:"` 会命中正文 code block 内的 `description:` 文本（如本 spec AC 描述、template 示例），需排除非 frontmatter 命中 |
| 冷启动 friction | 凭记忆引路错认（Bengal Opus F186-stewardship 事件，本 thread 2026-06-16）| 单 thread 内**两只猫** 凭记忆引路失败 |
| 找最大 F 号 | 必须 grep ROADMAP.md tail | F242 立项时（5 小时前）就用此路径 |
| OKF 兼容性 | ❌ 不兼容 | 外部 agent / 多租户开源（F168）无法 0 接入消费 |

**Eval baseline 待 Phase A 量化**（冷启动找正确 feature 的 tool calls / 时间 / 误点率 / 漏判率）。

## What

四阶段实施（Maine Coon co-design 4-Phase 框架）。**description generation 形态在 Phase A 判定后才进入 B/C 固化**——不预设小模型/大猫/模板。

### Phase A: Stratified Spike + Profile Draft + Eval Rubric

**子能力 1 — Stratified description generation spike**：
- 10 篇 stratified sampling：**6 篇硬骨头**（reopened feature / 历史旧文档 / ADR-like feature / 标题虚 / scope 漂移文档 + 1 篇 spec-very-large）+ **4 篇 easy mode**（F186-类，主题清晰 + 隐喻强 + 术语集中）
- 三猫盲评（@codex / @antig-opus / Ragdoll），盲评协议在独立 spike thread 执行避免互看
- 评分维度参考 mini-spike v3 prompt 9 条 + 新增**对照评估**（与作者原写对比 + 与 baseline `H1 + 第一段` 对比）
- **输出**：description generation 形态判定（小模型生产 / 大猫手写 / 模板任一），含数据支撑

**子能力 2 — Cat Café doc profile 草案**：
- frontmatter 字段映射 OKF：`doc_kind → type`、`topics → tags`、`created → timestamp`、+新增 `description`
- description 字段约束（位置 = frontmatter；长度 = ≤ 160 char；范围 = "回答这是什么" 不答 "讲了什么细节"；视角 = 读者；隐喻保留；触发节流 = H1/scope/status 改才重新生成）
- **Non-goal**：`> Summary:` blockquote 正文镜像 v1 不进（Maine Coon guardrail，多一个漂移面）

**子能力 3 — Eval rubric**：
- Baseline 定义：`ROADMAP.md + rg/search_evidence + ls docs/features/`
- Friction metric（多元，Maine Coon KD）：找正确 feature 的 tool calls / 时间 / 误点率 / 漏判率 / description-in-index 让读者愿意点开转化率
- Sunset signal（双类，学 F236）：① anchor tax（cold-start tool calls 比 baseline 多）② **变瞎子**（误点率/漏判率比 baseline 高 → description 抹掉 nuance）

### Phase B: Profile Contract + Template/Lint/Generator Skeleton（硬层）

- profile contract 定稿（frontmatter schema + description 约束 + 文档）
- `cat-cafe-skills/refs/feature-doc-template.md` 加 description 字段（含示例 + 约束 + 反面例子）
- **profile lint**：新建/修改 feature doc 缺 description / description 超长 / description 是 placeholder → CI fail
- **index.md generator skeleton**：从 `docs/features/*.md` frontmatter 抽 `description + status + topics → docs/features/index.md`
- **Generated-index schema**：self-contained 契约 + parser fixture 验证，schema 演化用版本号（供未来 consumer candidates 使用——F186 等是否扩 LibraryResolver 消费由对应 owner 决定，不作为 F243 close blocker）

### Phase C: `docs/features/` Rollout + Generated index.md + Sync Gate

- 全量回填 description（按 Phase A 判定形态，含 git log 证据每条 commit by 谁、被谁 confirmed）
  - 优先级：`status=spec/in-progress` 优先回填 → `done` 批量回填
- 生成 `docs/features/index.md` 并 checked-in（按 status 分组 + 含 description + 含 topics 索引）
- **CI sync gate**：`index.md` 与 source frontmatter 不同步 → block PR（永不手写 index）

### Phase D: Eval Report + decisions/ research/ 扩展 Go/No-Go

- Friction metric 实测对比 baseline（≥3 只非 author 猫做冷启动盲测）
- 误点率 + 漏判率 vs baseline（**Sunset signal ② 独立监测**）

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。本 feat AC↔Why 同源在 KD-1（命名）/ KD-7（primary user）/ Why 钉句"平铺→可渐进探索"。-->

### Phase A（Stratified Spike + Profile Draft + Eval Rubric）
- [ ] AC-A1: 10 篇 stratified sample 选定（6 硬骨头 + 4 easy mode）并三猫盲评完成，盲评报告含每篇评分明细 + 跨猫一致性
- [ ] AC-A2: profile draft v1：frontmatter 字段映射 OKF + description 字段四约束（位置/长度/范围/视角）+ 触发节流规则
- [ ] AC-A3: eval rubric 定稿：baseline 命令清单 + friction metric 公式 + sunset signal 两类阈值

### Phase B（Profile Contract + Template/Lint/Generator Skeleton）
- [ ] AC-B1: profile contract 定稿（frontmatter schema 文档化），CI lint 接入并对全仓库新增/修改 docs 通过率 = 100%
- [ ] AC-B2: `cat-cafe-skills/refs/feature-doc-template.md` 更新含 description 字段（含示例 + 约束 + 反面例子）
- [ ] AC-B3: profile lint 实现：缺 description / 超长 / placeholder 三类违规 → CI fail（fixture 三类各 1 + reverse fixture 验证不误报）
- [ ] AC-B4: `index.md` generator 骨架实现：从 docs/features/*.md 生成 `docs/features/index.md`，含 status 分组 + description + topics 索引；**输出 schema 文档化为 self-contained 契约 + parser fixture 验证**（供未来 consumer 使用，不绑定特定下游 feature——F186 等实际是否消费由对应 owner 决定）

### Phase C（docs/features/ Rollout + Generated index.md + Sync Gate）
- [ ] AC-C1: docs/features/ 全量回填 description（按 Phase A 判定形态执行），git log 显示每条 commit by 谁、被谁 confirmed
- [ ] AC-C2: docs/features/index.md 生成并 checked-in，含 200+ feature 入口（按 status 分组 + topics 索引 + description）
- [ ] AC-C3: CI sync gate 实现：index.md 与 source frontmatter 不同步则 PR block（fixture 验证两种漂移：删 description + 改 status）

### Phase D（Eval Report + 扩展 Go/No-Go）
- [ ] AC-D1: friction metric 实测：3+ 只非 author 猫冷启动盲测，找正确 feature 的 **tool calls vs baseline 下降 ≥30%** 或时间下降 ≥30%（任一即 trace Why）
- [ ] AC-D2: 误点率 + 漏判率 vs baseline **不增加**（Sunset signal ② 独立监测—— "变瞎子"防御）

## 需求点 Checklist

| ID | 需求点（operator experience/转述）| AC 编号 | 验证方式 | 状态 |
|----|---|---|---|---|
| R1 | "docs/features 从平铺文件堆变成可渐进探索的知识入口"（Maine Coon钉句）| AC-D1 | test: 冷启动 tool calls/时间 vs baseline ≥30% 下降 | [ ] |
| R2 | description 防漂移："这个 description 要如何保证不漂移？"（operator 06-15）| AC-B1, AC-B3, AC-C3 | test: profile lint + sync gate + 触发节流 | [ ] |
| R3 | 防"小猫代偿决策"："小心 这可能会变成我们提防的 小猫代替大猫做决策"（operator 06-15）| AC-A4, KD-4 | test: PR-time 大猫 confirm gate；抽查不可代替 gate | [ ] |
| R4 | "可发现性"读者视角不是作者视角（Maine Coon push back R2）| AC-A2, KD-6 | test: 三猫盲读 description-in-index 判断准确率 | [ ] |
| R5 | OKF 是 lingua franca 不是 OS（三猫共识）| KD-2 | test: 内核 search_evidence/graph_resolve 不动；export profile 兼容 OKF | [ ] |
| R6 | "变瞎子"防御：description 抹掉 nuance 导致猫漏判（operator迁移自 F236 教训）| AC-D2, KD-9 | test: sunset signal ② 独立监测误点率/漏判率 | [ ] |
| R7 | generated index schema 稳定可供未来 consumer 集成（不绑定特定下游 feature）| AC-B4 | test: schema 文档化 + parser fixture 验证；F186 等实际消费由对应 owner 决定，不作为 F243 close blocker | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求映射 N/A（无前端 UI）

## Eval / Tracking Contract（F192 / ADR-031）

**Primary User + Activation**：
- Primary：**猫冷启动探索 `docs/features/`**（不知道具体 F 号时）
- Activation = 进入 docs/features/ 的第一个动作（`cat docs/features/index.md` / `ls` / `search_evidence` / 查 ROADMAP.md）
- Secondary（不在 primary scope）：`search_evidence` 命中后看 snippet 渲染（那是 F236 surface）

**Friction Metric（多元，Maine Coon KD）**：
- 找正确 feature 的 tool calls 数
- 找正确 feature 的耗时
- 误点率（点开的 feature 中无关比例）
- 漏判率（应该找到但没找到的相关 feature 比例）
- description-in-index 让读者愿意点开转化率

**Regression Fixture（≥3）**：
1. **Fixture A — 主题词查询**：给定 "图书馆 memory" 关键词，baseline（BACKLOG + search_evidence）vs generated index，找到 F186 所需 tool calls
2. **Fixture B — 模糊问题**：给定 "之前有讨论过 docs 怎么组织吗"，baseline vs generated index，命中 F243 所需 tool calls
3. **Fixture C — description-in-context 盲读**：三猫盲读 F186 description-in-index，是否能正确判断"这是讲什么"（accuracy ≥ 80%）

**Sunset Signal（双类，缺一不可，学 F236）**：
- ① **Anchor tax 类**：generated index 让猫的"冷启动 tool calls" 比 baseline 多 → 净亏，立即回退
- ② **变瞎子类**（更隐蔽，token 账看不到）：generated index 让猫**误判**（点错 feature）或**漏判**（应找到的没找到）比 baseline **更高** → preview/description 抹掉了关键 nuance，立即回退

> **只测 token / sync rate 测不出变瞎子，必须同时测找到正确 feature 的准确率。**

## 软 + 硬 + eval 三层（ADR-031）

| 层 | 计划 |
|----|------|
| **软** | feat-lifecycle skill 教学：新建 feature doc 必填 description；写作规则 9 条（v3 prompt）成为文档规范；F243 ADR 立"docs discovery profile"原则；CLAUDE.md/家规 §4 加入"docs 入口可发现性"反射 |
| **硬** | profile lint（缺 description / 超长 / placeholder 三类违规 → CI fail）；index.md sync gate（CI 守 index.md vs frontmatter 同步）；feature-doc-template 嵌字段+约束（作者起点强制）；PR-time 大猫 confirm gate（如选小模型生产路径）|
| **eval** | F192 friction metric（冷启动 tool calls / 时间 / 误点率 / 漏判率）；regression fixture（3 类）；anchor tax + 变瞎子双类 sunset signal |

## Architecture cell

- **Architecture cell**: 候选 `docs-governance`（待 cell 创建）
- **Map delta**: **new cell required** —— Design Gate 2026-06-17 自检确认（Read `docs/architecture/ownership/README.md` 全量 15 cells，全部是 typescript runtime cells，`packages/*/src/...` anchors。F243 的 carrier 是 docs/ + cat-cafe-skills/refs/ + scripts/ + .github/，**不动 runtime code**，没有匹配 cell）
- **Why**: F243 是 **docs governance surface**（markdown / YAML frontmatter / lint script / generator script / CI sync gate），属于 monorepo 的元数据生产线，不在现有 typescript runtime cells 范围。
- **Cell 创建是 ownership map 自身 lifecycle，不是 F243 close blocker**（按 feat-lifecycle SOP "Phase 0 架构发现未完成"判定）。建议候选 cell 名 `docs-governance`，canonical features = F243（本 feat），code anchors = `docs/features/*.md` / `cat-cafe-skills/refs/feature-doc-template.md` / `scripts/docs-discovery/*` / `.github/workflows/docs-sync.yml` 等

## Dependencies

- **Evolved from**: 无（新独立 feature）
- **Blocked by**: 无
- **Related**:
  - **F236**（Anchor-First Context — 返回侧 token 减负）：**姊妹哲学**——F236 是 return-side anchor-first, F243 是 source-side discovery/profile. Both share anchor-and-drill philosophy. 元数据上 Related（不造 sister taxonomy，Maine Coon sharpen）
  - **F186**（Library Memory Architecture — 多域联邦检索）：**相关（已 done）**——是 F243 generated index 的**潜在 consumer 候选**。F243 仅承诺 self-contained schema（AC-B4），F186 实际是否扩 LibraryResolver 消费由 F186 owner + Phase D 扩展评审决定，**不作为 F243 close blocker**（Maine Coon R1 review P1-2 sharpen 2026-06-17）
  - **F038**（Skills Discovery — 历史参考）：早期 skills 按需发现探索（doc_kind=note，parked），作为 lineage reference 不重叠

## Risk

| 风险 | 缓解 |
|------|------|
| description 漂移（文档迭代但 description 化石化）| 触发节流（H1/scope/status 改才重新生成）+ PR-time 强制 confirm + 每月 eval 扫漂移 top 10 |
| 小猫代偿决策（小模型悄悄塑造认知锚定）| Phase A spike 判定形态前不固化 pipeline；若选小模型则强 prompt 规则（v3 9 条）+ PR-time 大猫 confirm（**抽查不可代 gate**）+ decision provenance 审计 trail（`Description by: [@gemini35-draft → @author-confirmed]`）|
| index.md 漂移成第二个 BACKLOG（手写化石）| Phase B 起 index.md **必须是 checked-in generated artifact + CI sync gate**（永不手写）|
| generated index schema 不稳定 → 未来 consumer 集成困难 | Phase B AC-B4 定义 self-contained schema + parser fixture；schema 演化用版本号；**不绑定 F186 等特定下游 feature**（避免 F243 close 被跨 feature 改造 block） |
| Phase A cherry-pick 风险（spike sample 偏 easy）| 6 篇硬骨头 + 4 篇 easy mode stratified sampling 强约束；@codex review sample 选择 |
| **变瞎子**（description 抹掉 nuance 导致猫漏判/误判）| eval sunset signal ② 独立监测误点率 / 漏判率 vs baseline；**不只测 token 同步率** |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F 号主名 `Docs Discovery Profile`，OKF 仅在 H1 副标（不入 BACKLOG 主名）| OKF 是 lineage 不是依赖/目标，避免外部规格绑架 feature 中心（Maine Coon sharpen）| 2026-06-17 |
| KD-2 | 内核保留：`search_evidence` / `graph_resolve` / `list_recent` / 消费加权 ranking (F200) 不动；只对外补 OKF-compliant export profile | OKF 是 lingua franca 不是 OS（Ragdoll/Maine Coon/Bengal opus 三猫共识 2026-06-15）| 2026-06-17 |
| KD-3 | description 走"小模型生产 + 大猫 confirm + 强 prompt 规则"模式，**但 Phase A 验证后才固化** | mini-spike R1/R2/R3 三轮证明 prompt v3 9 条能矫正Siamese默认偏差（formal pass），但 1 sample (F186 easy mode) 不能 generalize → stratified sample 验证是 Phase A 前置 | 2026-06-17 |
| KD-4 | "抽查"不能代 gate，**PR-time 强制 confirm 才是 gate**；抽查只在 eval 层做 | feedback_intake_visual_parity_required / feedback_reviewer_no_middle_state：质量门禁不能"部分放过"（operator P0）| 2026-06-17 |
| KD-5 | `index.md` 是 **checked-in generated artifact**，永不手写 + CI sync gate 守门 | 手写 index = 第二个 ROADMAP.md 漂移源（Maine Coon sharpen）| 2026-06-17 |
| KD-6 | 评估单元是 **description-in-context**，不是 description 单看 | "好"description 涉及与 H1/status/相邻文档对比的 contextual readability（Maine Coon sharpen）| 2026-06-17 |
| KD-7 | Primary user = **冷启动探索**（不知道 F 号），不是 search_evidence post-snippet | 后者是 F236 surface；冷启动是真正的 discovery 痛点（Maine Coon sharpen）| 2026-06-17 |
| KD-8 | `> Summary:` blockquote 正文镜像 v1 **不进** | 多一个漂移面；除非 Phase A 证明"frontmatter 藏起来导致作者不维护"才作为 Phase B 备选（Maine Coon guardrail）| 2026-06-17 |
| KD-9 | Sunset signal **必含"变瞎子"**（误点率/漏判率），不只测 token | 变瞎子比 anchor tax 更隐蔽，token 账看不到；学 F236 双边 sunset 设计 | 2026-06-17 |
| KD-10 | Phase A stratified sample = **6 硬骨头 + 4 easy mode** | F186-类 easy mode 不能 generalize；6:4 比例（Maine Coon sharpen）| 2026-06-17 |

## Review Gate

- **Phase A**: 跨族 review（架构级，影响 docs 入口契约）—— @codex (GPT-5.5) 主 reviewer + Bengal opus 愿景守护
- **Phase B**: 跨族 review @codex review profile contract + lint rules + generator schema（self-contained 契约，供未来 consumer candidates）
- **Phase C**: 跨族 review @codex review generator + sync gate + rollout 批次审计
- **Phase D**: 愿景守护猫（非作者非 reviewer 的第三只猫）做愿景对照 + 扩展 go/no-go
