---
feature_ids: [F243]
related_features: [F236, F186, F038]
topics: [docs, discovery, profile, frontmatter, index, okf]
doc_kind: spec
created: 2026-06-17
tips_exempt: spec-only — docs index generation not yet implemented, no user-facing capability
---

# F243: Docs Discovery Profile — OKF-inspired metadata + generated index

> **Status**: spec (v2 redesigned 2026-06-29) | **Owner**: Ragdoll (Ragdoll Opus-4.7) | **Priority**: P1

> **Co-design**: Maine Coon (gpt-5.5) co-designed scope 4+1（命名 / 4-Phase 骨架 / F236 Related 不造 taxonomy / Eval primary=冷启动 / `> Summary:` 镜像 guardrail）+ R1 review sharpen（Owner/reviewer 红线 / F186 scope creep / parser 验证）。Maine Coon是 reviewer 不是 Owner（避免同体 review 红线），具体 contribution 标注在 KD-1/3/4/5/6/7/8/9/10 + Timeline 2026-06-17 entries。

## ⚠️ Current Operative Spec = v2 as of 2026-06-29

**v2 Operative Plan**（本 section 下方）**是当前生效真相源**。下方 v1 sections（What / Acceptance Criteria / 需求点 Checklist / Risk / Open Questions / Key Decisions）**保留为历史 record，不作为执行依据**——除非被 v2 Operative Plan 明确 re-state（如 KD-2 / KD-3 / KD-4 / KD-7 在 v2 仍引用）。

执行规则：
- Phase B/C/D 实施以本 v2 section 描述为准，v1 Phase 描述仅作为 reframe trace
- AC 编号 v1 (AC-A1~D3) 已 superseded by v2 AC 系列（在 v2 Operative Plan §AC 重新声明）
- Open Questions：v1 OQ-1/2/4 已 stale（标记 superseded），OQ-3/5 仍 open 但归入 v2 OQ 系列重新编号

## v2 Redesign (2026-06-29) — Reframe Drivers

Phase A spike 跑完 + 跑偏 + 10 天 stale + 平行 47 trilogy + dream coordinate + operator三个深问题 + Maine Coon R1 review v2 (4 finding 全接受) 后的 reframe。

**operator 2026-06-29 三个 reframe（这是 v2 真正 driver）**：

1. **童子军原则**（不全量回填）：Phase C 从 "marathon 全量回填 200+ docs/features/" 降级到 "convention + lint"——new doc / 大改 doc 强制有 description (CI fail), 旧 doc boy-scout rule (作者顺手补), index.md fallback 处理 partial coverage。
2. **Scope 扩到知识型文档**（Maine Coon R1 P1-2 sharpen，初版我写"全 .md"过宽）：F243 真正做的事是**统一现有 patchy 约定**——`cat-cafe-skills/*/SKILL.md` 已有 `description` frontmatter prior art。**Scope = frontmatter-bearing knowledge docs**（白名单 + 黑名单详见 v2 Operative Plan §Scope），不是每个 `.md`（README / CHANGELOG / generated index / archive 默认 out）。
3. **Drift 防腐 reframe**（v1 没真正答好的核心问题）：

   **治根**：description 写法本身改——
   | 错（易 drift）| 对（抗 drift）|
   |---|---|
   | "已上线的多域联邦检索 + RRF + sec scan" | "图书馆记忆架构" |
   | "Phase A/B/C/D done + 13 个 KD" | "把单域记忆系统归一扩展为跨域图书馆" |
   | current state snapshot | **stable identity statement** |

   description 写 "这文档讲什么 stable concept" 不是 "current implementation 进度"。后者一改就 stale，前者只在 feature **本质改变**时才需要 refresh（罕见）。

**平行 47 trilogy synthesis (2026-06-24) 桥接**：

trilogy ADR §3「Generated Content 必须保留 Source-Tier」与 F243 同源——**F243 现有 KD-3/KD-4 audit trail 流程约束升级为 schema-enforced epistemic provenance**。

**Maine Coon R1 P1-3 sharpen**：v1 epistemic schema 误把"谁写的"建模成"谁生成的"——童子军原则允许作者手写，手写 description 不是 generated content，强填 `generated_by` 制造假 provenance。**正确 schema**（通用 source-tagged 字段）：

```yaml
# 所有 description 强制必现:
description_source: human | model | imported    # mandatory
description_author: <cat_id | user_id>          # 谁写/确认的（真正作者）
description_updated_at: <ISO 8601 timestamp>    # description 最后修改时间（drift lint 时间源）

# 仅 description_source=model 时再强制:
description_generated_by: <model_id+prompt_version>
description_generated_at: <ISO 8601 timestamp>
description_confirmed_by: <author_cat_id>       # PR-time 大猫 confirm gate

# AC-B4 generated index.md 必现 trilogy ADR §3 字段（self-contained 不变）:
generated: true
generated_from: <input source path glob>
generated_at: <ISO 8601 timestamp>
generator_version: <script version + schema version>
```

**dream feat (auto dream, 平行 48 + Maine Coon)** 作为 F243 **第一个真实下游 consumer**——dream 每天读 feature 变化 = F243 description 的高频 production 消费者 + 自然成为 Phase D extend evaluation 的真实 sample（对抗 Phase A clean-pool bias）。dream 立项独立不阻塞 F243。

**自我反思（值得沉淀 LL 候选）**：

1. **v1 Phase A spike "卡 prompt-level microoptimization"**（11 维 rubric grading + prompt v4 sharpen）—— 没 elevate 到 design space (epistemic provenance schema)
2. **第一次 propose L0/L1/L2 是 design 倒退**——反手接纳了 cat-cafe 已批判过的 OV sidecar generated content without epistemic label pattern。根因：synthesis 文档"可借鉴" vs "反对例"两面**没明确写 first-principle 批判论证链**，同 catId 平行猫 10 天后读 synthesis 会反手接纳被批判设计
3. **Drift 6-15 第一次问 → 我 10 天没真正答好**——push 到 generation phase（小模型 + 大猫 confirm）但没治根。治根是 description 写法本身（stable identity vs current state snapshot）
4. **v2 spec push 后 fix concept finding 又只改 reviewer 指出的 line**（前车之鉴 R1 fix scope creep 同病）—— Maine Coon R1 review v2 抓 4 个 finding 我必须全文 grep verify 全部，不只 fix 4 个具体 line。这条已 sharpening 进 receive-review skill 候选

## v2 Operative Plan (Current Truth Source)

### Scope (v2 final, R2/R2-R2 Maine Coon sharpened — overlay model 2026-06-29)

**Maine Coon R2 P1-1 (Phase B co-design) sharpen**: 我前一版"动态由 F102 scanner config 决定"是**错的**——F102 真相源不是外部 config，是 `CatCafeScanner.ts` 代码逻辑。实测验证 (`packages/api/src/domains/memory/CatCafeScanner.ts`)：
- `KIND_DIRS` 白名单硬编码 (14 dirs)
- `internal-archive/<date>/<kind-dir>/` **显式扫描** (L154-170, 不是 excluded)
- `mailbox` 在 `FALLBACK_EXCLUDE` (L191, 不在 scanner scope)
- `isIndexableSourceFile` 接 `.md` + `.svg` (L219, 不只 markdown)
- scanner root = `docsRoot`, **`cat-cafe-skills/` 不在 F102 scope**

```
F243 scope output 4 集 (resolver 输出可复核 path list)：

  scanner_discovered_files   = F102 CatCafeScanner.discoverFiles() 纯函数 path list
                                (含 .svg + archive, 不含 discover() synthetic LL entries)

  profile_enforced           = (scanner_discovered_files
                                  ∩ markdown_only_filter      # 排除 .svg
                                  ∩ not_generated_artifact)   # 排除 docs/**/index.md
                              ∪ overlay_added                 # 加 cat-cafe-skills/*/SKILL.md

  profile_exempt             = scanner_discovered_files - profile_enforced
                              (标 reason: "asset_file" / "generated_artifact" / ...)

  overlay_added              = F243 overlay 加的，不在 scanner scope 但 F243 enforce
                              (当前: cat-cafe-skills/*/SKILL.md)
```

**Lint 实际 enforce = `profile_enforced`**（不是 `scanner_discovered_files`）。

**Trace example (示例数据，不作为 enumerative truth)** —— overlay model 输出后的真实归属：

| Path | 归属 | Reason |
|---|---|---|
| `docs/features/F*.md` | profile_enforced | scanner indexed + markdown + not generated |
| `docs/decisions/*.md` | profile_enforced | 同上 |
| `docs/**/index.md` | **profile_exempt** | reason: "generated_artifact" |
| `docs/**/*.svg` | **profile_exempt** | reason: "asset_file" (scanner 含 .svg 但 description rubric 不适用) |
| `cat-cafe-skills/*/SKILL.md` | **overlay_added → profile_enforced** | F243 overlay 加，已有 description prior art |
| `README.md` / `CHANGELOG.md` / `LICENSE.md` | 不在 scanner | repo 元文件，F102 不 index |
| `node_modules/**` / `.git/**` | 不在 scanner | F102 跨 dir 排除 |

**核心好处 (overlay model vs hard-coded 白名单)**：F102 scanner `KIND_DIRS` 改时 (e.g. 加 `tutorials`)，F243 `profile_enforced` 自动 follow 不需 spec 维护白名单；overlay 显式标 reason 避免 enforcement 隐式漂移。

**thread messages / sessions / transcripts 不在 F243 scope**（不是 markdown doc-level，是 message/session-level，F102 走 thread scope 不是 docs scope）。

### Lint 行为表 (v2 — 防误伤旧 doc, 童子军原则 enforcement spec)

operator R2 sharpen (2026-06-29) 直接 question："会不会把老的给拦截了？" 明确写表保证不误伤：

| 场景 | lint 反应 | 触发条件 |
|---|---|---|
| 新建 doc (frontmatter 无 description) | **CI hard fail** (block) | PR diff 含新 `.md` in scope + frontmatter 无 description 字段 |
| **旧 doc body_h1_changed** (`^# ` 标题行内容变化) | **drift warn** (不 block，提示 review description) | PR diff 含 file + first `^# ` markdown heading 内容变化 (markdown-heading-parser) |
| **旧 doc frontmatter_key_changed** (yaml 字段变化，白名单: status / topics / doc_kind / feature_ids / related_features) | **drift warn** (不 block) | PR diff 含 file + yaml frontmatter parse delta in 字段白名单 (yaml-frontmatter-parser) |
| 修改旧 doc 正文（typo / 小 refactor / 内容补充）| 静默不触发 | PR diff 只动正文不动 frontmatter description |
| 旧 doc 无 description 静置不动 | 静默不触发（index fallback "(待补)")| 不在 PR diff 内 |
| description 时间字段 `description_updated_at` > N months + doc 大改 | drift warn (不 block, AC-C4-v2) | scheduled CI scan |
| `description_source=model` 但缺 `description_confirmed_by` | CI hard fail | 大猫 confirm gate 强制 |

**核心保证**：日常 dev 改老 doc **不会突然被 lint hard block**，最多 warn。Hard block 只在新建 doc + 缺 epistemic source-conditional 字段两个场景。

### Phase B (v2)

- **AC-B1-v2**: profile contract 定稿——`description` (≤ 160 char, stable identity statement) + epistemic schema 三必现字段（`description_source` / `description_author` / `description_updated_at`）+ 条件必现（`source=model` 时加 `description_generated_by` / `description_generated_at` / `description_confirmed_by`）。CI lint 对 **`profile_enforced` 集合**内新增/修改 docs 通过率 = 100%
- **AC-B2-v2**: `cat-cafe-skills/refs/feature-doc-template.md` 更新含 description 字段 + **drift-resistant rubric (stable identity vs current state snapshot, 含正反例)**
- **AC-B3-v2**: profile lint 实现：缺 description / 超长 / placeholder / 缺 epistemic 三必现字段 / `source=model` 时缺 confirm 字段 → CI fail（fixture 各 1 + reverse fixture 验证不误报，**lint enforce target = `profile_enforced`**，不含 `profile_exempt` / scanner-out paths）
- **AC-B4-v2**: 多 `index.md` generator 骨架——**generator input = `profile_enforced` grouped by output directory** (如 `docs/features/index.md` / `docs/decisions/index.md` 等)；generated index 排除 `profile_exempt` 但**记录 fallback/missing for in-scope docs**（按 profile-contract.md §5 fallback schema：`description_missing: true` / `description_fallback_source: h1`）；输出 schema 必现 trilogy ADR §3 字段（`generated: true` + `generated_from: <input glob>` + `generated_at` + `generator_version`）+ self-contained 契约 + parser fixture 验证

### Phase C (v2 — 童子军 Rollout + Sync Gate)

- **AC-C1-v2 童子军 enforcement**：new doc 必有 description (CI hard fail)；大改触发 description refresh prompt（PR template + drift lint warn）；旧 doc 无 description 不阻塞（fallback "(待补)")；git log audit + epistemic schema 字段写进 frontmatter (不只 commit message)
- **AC-C2-v2 多 index.md generated + checked-in**：`profile_enforced` grouped per-directory `index.md` 生成 + checked-in，含 description + topics 索引 + epistemic provenance + fallback entries（in-scope but missing description 显式标 `description_missing: true`，不混伪装真 description）
- **AC-C3-v2 CI sync gate**：每个 generated `index.md` 与 source frontmatter 不同步 → PR block（fixture 验证：删 description / 改 status / source 改 description 但 index 没 regen）
- **AC-C4-v2 Drift detection lint**：`description_updated_at` 与 doc 大改时间（commit SHA-level）gap > N months 且 doc 大改 → CI warn（不 block，提示作者 review description 是否仍 align）。N 默认 6 months，可调

### Phase D (v2 — Eval + Extend Go/No-Go)

- **AC-D1-v2 Friction metric 实测**：dream feat 作为 first production consumer 自然产生数据（不需独立组织 3 猫盲测）—— dream 每天 read feature 变化 = 持续 friction signal source
- **AC-D2-v2 误点率 + 漏判率 vs baseline 不增加**（sunset signal ② 变瞎子防御）—— dream 在 production 中遇到 description-doc mismatch 时反馈
- **AC-D3-v2 扩展 Go/No-Go**：overlay/profile policy extension (如加 `docs/lessons-learned/main` 进 overlay_added, 或调整 profile_exempt 规则) 或 scope reframe (F102 scanner KIND_DIRS 改动跟随)，operator 决定

### OQ (v2)

| # | 问题 | 状态 |
|---|---|---|
| OQ-v2-1 | description i18n 支持？（v1 OQ-3 保留）目前文档中文为主+英文术语混合 | ⬜ 未定 |
| OQ-v2-2 | F236 anchor-first preview 是否覆盖 generated `index.md`？（v1 OQ-5 保留）| ⬜ 未定（与 F236 sync）|
| OQ-v2-3 | Drift detection lint N months 阈值是 6 还是 3？需 dream 上线后实测 | ⬜ 未定（Phase D 数据驱动）|
| OQ-v2-4 | enforce vs exempt opt-in：是否需要 frontmatter `lint_exempt: true` 字段让作者 explicit 把 in-`profile_enforced` doc 移到 `profile_exempt`？ | ⬜ 未定（Phase B contract 时定）|

### v1 OQ Stale Mark

| v1 OQ | 状态 | 原因 |
|---|---|---|
| OQ-1（Siamese quota 长期）| **superseded** | Phase A 已完成 + dream 作为 production consumer，generation 路径在 Phase B 重新定义 |
| OQ-2（index 分组维度）| **superseded** | v2 Operative Plan AC-C2 多 per-directory index 替代单 index 分组维度争论 |
| OQ-4（Phase C 回填优先顺序）| **superseded** | v2 童子军原则无大规模回填 marathon |

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

## What (v1 — superseded by v2 Operative Plan above)

> ⚠️ **v1 historical record only**——执行依据看上方 "## v2 Operative Plan (Current Truth Source)"。本 section 下方所有 Phase B/C/D 描述 + AC 编号 (AC-A1~D3) 仅保留作 brainstorm/spike 历史 trace；scope ("全 .md") + epistemic schema (mandatory `generated_by`) 均已被 v2 R1-fixed 版本取代。

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

### Phase C: Boy-Scout Rollout + Generated index.md + Sync Gate (v2 redesigned 2026-06-29)

**v1 全量回填 marathon → v2 童子军原则**（operator 2026-06-29 reframe）：

- **New doc 强制有 description**（CI lint hard fail）—— 起点强制
- **大改 doc（H1 改 / scope 真改 / status 转）强制 description refresh** —— 触发节流（KD-3）
- **旧 doc 无 description = OK**，作者 next-edit 时 boy-scout 顺手补 —— 不一次性 marathon
- **Index.md fallback 处理 partial coverage**：无 description 的 doc 显示 "(无简介，待补)" 或 fallback 到 H1
- 生成多个 index.md（按目录分组，progressive disclosure）
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
- [ ] AC-B1: profile contract 定稿（frontmatter schema 文档化 + **v2 epistemic schema 字段**：`description_generated_by` / `description_confirmed_by` / `description_generated_at` 三个 mandatory），CI lint 接入并对全仓库新增/修改 docs 通过率 = 100%
- [ ] AC-B2: `cat-cafe-skills/refs/feature-doc-template.md` 更新含 description 字段 + **drift-resistant rubric**（含示例 + 约束 + 反面例子 + **stable identity vs current state snapshot 区分原则**——v2 新增）
- [ ] AC-B3: profile lint 实现：缺 description / 超长 / placeholder / **缺 epistemic provenance 三字段（v2 新增）** 四类违规 → CI fail（fixture 各 1 + reverse fixture 验证不误报）
- [ ] AC-B4: `index.md` generator 骨架实现：从 **docs/\*\*/\*.md（v2 scope 扩，不只 features/）**生成对应目录 `index.md`，含 status/topic 分组 + description + topics 索引；**输出 schema 必现 trilogy ADR §3 必现字段**（`generated: true` + `generated_from: docs/**/*.md frontmatter` + `generated_at` + `generator_version`）+ self-contained 契约 + parser fixture 验证（供未来 consumer 使用——dream feat 是 first 候选 consumer，但实际消费由对应 owner 决定，不绑定）

### Phase C（Boy-Scout Rollout + Generated index.md + Sync Gate）

**v1 marathon 全量回填 → v2 童子军原则 (2026-06-29 reframe)**：

- [ ] AC-C1: **童子军原则 enforcement**——new doc 强制 description (CI lint hard fail) + 大改触发 refresh + 旧 doc 无 description 不阻塞（fallback "(无简介，待补)"），git log audit trail 显示每条 commit by 谁、被谁 confirmed + epistemic schema 字段
- [ ] AC-C3: CI sync gate 实现：index.md 与 source frontmatter 不同步则 PR block（fixture 验证两种漂移：删 description + 改 status）
- [ ] **AC-C4 (v2 新增) — Drift detection lint**：description 上次更新时间 + doc 大改时间 → 长 gap + 大改 → CI warn（不 block，提示作者 review description 是否仍 align）

### Phase D（Eval Report + 扩展 Go/No-Go）
- [ ] AC-D1: friction metric 实测：3+ 只非 author 猫冷启动盲测，找正确 feature 的 **tool calls vs baseline 下降 ≥30%** 或时间下降 ≥30%（任一即 trace Why）
- [ ] AC-D2: 误点率 + 漏判率 vs baseline **不增加**（Sunset signal ② 独立监测—— "变瞎子"防御）

## 需求点 Checklist

| ID | 需求点（operator experience/转述）| AC 编号 | 验证方式 | 状态 |
|----|---|---|---|---|
| R1 | "docs/features 从平铺文件堆变成可渐进探索的知识入口"（Maine Coon钉句）| AC-D1 | test: 冷启动 tool calls/时间 vs baseline ≥30% 下降 | [ ] |
| R2 | description 防漂移："这个 description 要如何保证不漂移？"（operator 06-15）| **AC-B2 (drift-resistant rubric: stable identity vs current state snapshot)** + AC-B3 (epistemic schema lint) + AC-C3 (sync gate) + **AC-C4 (drift detection v2 新增)** | test: **rubric example/反面例子 review** + profile lint + sync gate + drift detection + 触发节流 | [ ] |
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
| **软** | feat-lifecycle skill 教学：新建 feature doc 必填 description；**drift-resistant rubric (stable identity vs current state snapshot, v2 reframe)**；F243 ADR 立"docs discovery profile"原则 + 引用 trilogy ADR Phase 0 (epistemic provenance) ；CLAUDE.md/家规 §4 加入"docs 入口可发现性"反射；**童子军原则 (v2)：作者 next-edit 顺手补 description** |
| **硬** | profile lint（缺 description / 超长 / placeholder / **缺 epistemic provenance 三字段 (v2)** 四类违规 → CI fail）；index.md sync gate（CI 守 index.md vs frontmatter 同步）；**drift detection lint (v2 AC-C4)**：long gap + 大改 → CI warn；feature-doc-template 嵌字段+约束（作者起点强制）；PR-time 大猫 confirm gate（KD-4：抽查不可代 gate）|
| **eval** | F192 friction metric（冷启动 tool calls / 时间 / 误点率 / 漏判率）；regression fixture（3 类）；anchor tax + 变瞎子双类 sunset signal；**dream feat 作为 production sample (v2，对抗 Phase A clean-pool bias)** |

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
