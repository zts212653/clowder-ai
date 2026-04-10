---
feature_ids: [F040]
related_features: []
topics: [backlog, reorganization]
doc_kind: note
created: 2026-02-26
---

# F040: BACKLOG 整理与 Feature 聚合体系

> **Status**: done | **Owner**: Ragdoll
> **Created**: 2026-02-26
> **Completed**: 2026-02-27
> **Priority**: P1（基建，影响后续所有 feat 的管理方式）

---

## Why（为什么要做）

### 痛点来源

team lead 2026-02-26 提出：
> "我们这套机制有大问题了，现在这个我们最重要的真相源头发散出不同 feat md 的蜘蛛网乱七八糟的。"

### 核心问题

1. **编号混乱**：BACKLOG 混编 Feature (#F1-F39) + Tech Debt (#1-#103)，F 都编到 101 了
2. **蜘蛛网引用**：一个 Feature 的文档散落在 feature-specs/feature-discussions/review-notes/bug-reports，没有统一入口
3. **无法顺藤摸瓜**：问"F21 什么情况"要搜 85 个文件
4. **1000 feat 怎么办**：现有结构不可扩展

### 设计灵感

team lead的记忆系统设计 proposal（三层记忆）：
- **热层**：直接在 context（BACKLOG 索引表）
- **温层**：轻量索引，快速召回（feat 聚合文件）
- **冷层**：需要搜索（散落的 feature-specs/discussions）

---

## What（目标）

1. **拆分 BACKLOG**：Feature Roadmap + Tech Debt 分离
2. **建立 feat 聚合文件**：`docs/features/FXX-name.md` 收归每个 feat 的散落链接
3. **定义归档规则**：done 的 feat 从 BACKLOG 活跃区移除
4. **变成 Skill**：让猫完成 feat 时主动维护网状体系

---

## Design（设计思路）

### 编号规范（三猫收敛 2026-02-26）

| 类型 | 格式 | 示例 | 说明 |
|------|------|------|------|
| Feature | `F001` | F001, F021, F040 | 三位固定宽度，不再用 F20b/F21++ |
| Tech Debt | `TD001` | TD001, TD089 | 不再用 `#`，避免和 PR/issue 冲突 |

> **为什么三位数**：一次到位，避免未来 F100+ 再整体改名。（Maine Coon建议）

### 目录结构

```
docs/
├── ROADMAP.md              # 简化为活跃 Feature 索引（热层）
├── TECH-DEBT.md            # 技术债务单独文件
├── features/               # Feature 聚合目录（温层）
│   ├── F040-backlog-reorganization.md   # 本文件，第一个示范
│   ├── F021-signal-hunter.md
│   ├── index.json          # 机器索引（脚本生成，不手写）
│   └── ...
└── (feature-specs/feature-discussions/...)  # 冷层，被 frontmatter 挂接
```

### BACKLOG 新结构设计（Ragdoll 2026-02-26）

**当前问题**：
1. Feature (F1-F39) 和 Tech Debt (#1-#103) 混编在一个文件
2. 有两个"P1 — 必须做"段落（第 17 行和第 127 行）
3. done 的项目仍占据大量篇幅（折叠也很长）
4. 编号不规范（F21++ / F20b / #52）

**新结构**：

#### `docs/ROADMAP.md`（热层 - 活跃 Feature 索引）

```markdown
# Cat Cafe Feature Roadmap

> 维护者：三猫 | 最后更新：YYYY-MM-DD
>
> **规则**：只放活跃 Feature（idea/spec/in-progress/review），done 后移除。
> 详细信息见 `docs/features/Fxxx.md`。

| ID | 名称 | Status | Owner | Link |
|----|------|--------|-------|------|
| F010 | 手机端猫猫 | in-progress | Ragdoll | [F010](F010-mobile-cat.md) |
| F032 | Agent Plugin Architecture | review | Ragdoll | [F032](F032-agent-plugin-architecture.md) |
| F037 | Agent Swarm 协同模式 | in-progress | 三猫 | [F037](F037-agent-swarm.md) |
| F039 | 消息排队投递 | spec | Ragdoll | [F039](F039-message-queue-delivery.md) |
| F040 | BACKLOG 整理 | in-progress | Ragdoll | [F040](F040-backlog-reorganization.md) |
```

> **超级简洁！** 只有 ~10 行活跃项，不是 200+ 行历史。

#### `docs/TECH-DEBT.md`（技术债务独立文件）

```markdown
# Cat Cafe 技术债务

> 维护者：三猫 | 最后更新：YYYY-MM-DD
>
> **规则**：`[ ]` 待做 / `[~]` 进行中 / `[x]` 已完成
> 完成后不删除，保留追溯。

## TD-P0 — 阻塞后续 Phase

| ID | 项目 | 状态 | 来源 | 备注 |
|----|------|------|------|------|
| TD038 | Session 按 Thread 隔离 | [x] | ... | ... |

## TD-P1 — 必须做
...

## TD-P2 — 建议做
...

## TD-P3 — 可选优化
...
```

**迁移映射**：
- `#1` → `TD001`
- `#103` → `TD103`
- `F1` → `F001`
- `F39` → `F039`
- `F21++` → `F021` (演进关系用 `Evolved from` 字段)
- `F20b` → `F020` (variant 用 Phase 或 聚合文件内区分)

**迁移执行**：由Maine Coon批量执行（见 Progress 章节任务分工）。

### Frontmatter Contract（三猫收敛 2026-02-26）

**所有 docs/ 下的 .md 文件**都应该有 YAML frontmatter：

```yaml
---
feature_ids: [F040]           # 关联的 Feature，可为空 []
debt_ids: [TD086]             # 关联的 Tech Debt，可为空 []（2026-02-26 新增）
topics: [memory, backlog]     # 松散标签，feature_ids/debt_ids 空时靠这个搜索
doc_kind: discussion          # 文档类型（必填）
created: 2026-02-26           # 创建日期
---
```

**`debt_ids` 字段说明**（2026-02-26 扩展）：
- Bug report 通常关联到 Tech Debt（修复某个债务），而非 Feature
- 例如：`86-puppeteer-process-leak` → `debt_ids: [TD086]`
- 一个文档可以同时有 `feature_ids` 和 `debt_ids`（如果同时关联）
- 判断标准：修复的是 Feature 的 bug → `feature_ids`；修复的是独立登记的 Tech Debt → `debt_ids`

**`doc_kind` 枚举值**：
- `plan` — 设计/实现计划
- `discussion` — 讨论记录
- `research` — 技术调研
- `bug-report` — Bug 报告
- `mailbox` — 交接/review 信
- `decision` — 架构决策（ADR）
- `note` — 其他笔记

**关键设计决策**：
- **`stage` 不进普通文档 frontmatter**，只保留在 `features/Fxxx.md` 的 Status 字段
- 理由：`stage` 是 Feature 的状态，不是文档的状态。如果 661 个文件都有 `stage`，Feature 状态变了就要到处改——又是蜘蛛网（4.6 提出）

**迁移策略**：
1. **新文档**：`feat-kickoff` skill 强制加 frontmatter
2. **历史文档**：脚本批量加，能推断的推断（文件名带 fXX），不能的留 `feature_ids: []`
3. 不追求 100% 覆盖——80% 自动 + 20% 按需手补

### feat 聚合文件模板

```markdown
# Fxxx: 名称

> **Status**: idea | spec | in-progress | review | done
> **Owner**: Ragdoll | Maine Coon | Siamese
> **Created**: YYYY-MM-DD
> **Completed**: YYYY-MM-DD（如果 done）

## Why
一句话：为什么要做

## What
一句话：做什么

## Acceptance Criteria（验收标准）
- [ ] 条件 1
- [ ] 条件 2

## Key Decisions（关键决策）
为什么这样设计？放弃了什么？（压缩后不用读冷层就能理解设计意图）

## Risk / Blast Radius（风险评估）
- 影响范围：...
- 回滚方案：...

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Dependencies
- **Blocked by**: Fxxx
- **Blocks**: Fxxx
- **Evolved from**: Fxxx（如果是演进）

## Review Gate（审查记录）
| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| R1 | Maine Coon | Pass | YYYY-MM-DD |
| Cloud | Codex | Pass | YYYY-MM-DD |

## Test Evidence（测试证据）
- 单元测试：`pnpm test` 通过
- 集成测试：...

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |

## Dependencies

- **Evolved from**: F025 (Session Chain) — F40 是记忆栈的延续，从 Session Chain 的上下文管理需求演化出文档追溯链需求
- **Blocks**: 无
- **Blocked by**: 无

---

## Related Docs（冷层链接）

| 类型 | 路径 | 说明 |
|------|------|------|
| **Discussion** | 本 thread（2026-02-26 team lead + Ragdoll）| BACKLOG 问题诊断 |
| **BACKLOG 条目** | 待登记 | - |

---

## Feature 演化图（team lead梳理 2026-02-26）

team lead用 Mermaid 可视化了 Cat Café 的 Feature 演化关系，分为 5 个逻辑栈：

### 1. 语音栈（Voice Stack）
```
F020 → F022 → F010
        ↓
       F034
```
- F020: TTS 文本转语音
- F022: Voice Input 语音输入
- F034: Voice Pipeline 完整语音流
- F010: Mobile Cat 手机端猫猫（依赖语音栈）

### 2. 记忆栈（Memory Stack）
```
F024 → F025 → F040
```
- F024: Session Blindness 修复（上下文感知）
- F025: Session Chain 会话链
- F040: BACKLOG 整理（本 Feature）

### 3. Agent 架构栈（Agent Architecture Stack）
```
F032 → F033 → F037 → F038
              ↓
             F041
```
- F032: Agent Plugin Architecture（CatId 松绑 + AgentRegistry）
- F033: Session Chain 策略可配置化
- F037: Agent Swarm 协同模式
- F038: Skills 梳理 + 按需发现机制
- F041: 能力看板（Hub MCP/Skills 统一管理）

### 4. 信息源栈（Information Source Stack）
```
F021 → F039
```
- F021: Signal Hunter 集成（信息源）
- F039: 消息排队投递（用户操作三模式）

### 5. 会话基建栈（Session Infrastructure Stack）
```
F014 → F015 → F036
```
- F014: SVG 猫猫状态动画
- F015: Backlog 管理（基础）
- F036: Logo 一笔画动画

> **演化关系记录规则**：每个 Feature 聚合文件的 `Dependencies.Evolved from` 字段记录上游，由 `feat-completion` skill 在完成时自动提示。

---

## Progress（进度）

### Phase 1: 设计收敛（2026-02-26，已完成）

- [x] 问题诊断完成
- [x] 探索现有 feat 关系图（haiku）
- [x] 创建本文件（第一个示范）
- [x] 与 Opus 4.6 讨论，纳入三点改进（Key Decisions 字段、取消 6 月归档、kickoff 而非 completion）
- [x] 三猫收敛 frontmatter contract（4.5 + 4.6 + GPT-5.2）
  - 最终 schema：`feature_ids` + `debt_ids` + `topics` + `doc_kind` + `created`
  - `stage` 不下沉到普通文档
  - 编号 `F001` / `TD001`（三位固定宽度）
  - 机器索引 `index.json`（脚本生成）
- [x] 设计 BACKLOG 新结构（拆分 Feature Roadmap + Tech Debt）— **Ragdoll**
- [x] 设计 feat-kickoff skill — **Ragdoll**

### Phase 2: 迁移执行（2026-02-26~27，已完成）

- [x] 写 frontmatter 迁移脚本 — **Maine Coon**（`scripts/migrate-frontmatter.mjs`）
- [x] 执行迁移脚本，拆分 BACKLOG + TECH-DEBT — **Maine Coon**
- [x] 恢复 F001-F041 聚合文件内容（从 git history `be27a44^` 恢复）— **Maine Coon**
- [x] 创建 `docs/features/README.md` 统一索引 — **Maine Coon**
- [x] 历史文档补 frontmatter（research/discussion/bug-report 共 50+ 文件）— **Maine Coon**
- [x] TECH-DEBT commit 标注（52/83 条，剩余 31 条无对应 commit）— **Maine Coon**
- [x] 创建维护脚本 `scripts/tech-debt-maintain.mjs` — **Maine Coon**
- [x] 验收 F021 重新开放（F21++ 未完成，不能标 done）— **Ragdoll+team lead**
- [x] 扩展 frontmatter contract 加入 `debt_ids` 字段 — **Ragdoll**（commit `3fb8aa9`）
- [x] 更新 SOP.md "完成后真相源同步" 章节 — **Ragdoll**（commit `3fb8aa9`）

### Phase 3: Skill 实现（2026-02-27，已完成）

- [x] 创建 `feat-kickoff` skill — **Ragdoll**（`cat-cafe-skills/feat-kickoff/SKILL.md`）
- [x] 创建 `feat-completion` skill — **Ragdoll**（`cat-cafe-skills/feat-completion/SKILL.md`，commit `d55d3b6`）

### Phase 4: 沉淀同步（2026-02-27，已完成）

- [x] 写 ADR: Metadata Contract — **Ragdoll**（`docs/decisions/011-metadata-contract.md`，commit `14a8b53`）
- [x] 更新 public-lessons.md（LL-024: 状态字段多点写入会复发蜘蛛网）— **Ragdoll**
- [x] 同步 CLAUDE.md/AGENTS.md/GEMINI.md（frontmatter 规范 + feat-kickoff/completion 触发）— **Ragdoll**

### Phase 5: 验收与优化（2026-02-27，已完成）

- [x] 生成 `docs/features/index.json` 机器索引 — **Maine Coon**（`scripts/generate-feature-index.mjs`，commit `6f69452`）
- [x] 全量扫描验证 frontmatter 覆盖率 — **Maine Coon**（`scripts/check-frontmatter.mjs`，703/707 = 99.4%）
- [x] 用 F032 验证"分阶段交付"记录模式 — **跳过**（F032 尚未完成，后续顺便验证）

---

## Gap 分析（2026-02-27 更新）

### 已完成 ✅

| 项目 | 说明 | 负责猫 |
|------|------|--------|
| BACKLOG 拆分 | Feature Roadmap + Tech Debt 分离 | Maine Coon |
| F001-F041 聚合文件 | 全部从 git history 恢复 | Maine Coon |
| `docs/features/README.md` | 统一索引（done + active） | Maine Coon |
| Frontmatter 补录 | 50+ 文件（research/discussion/bug-report） | Maine Coon |
| `feat-kickoff` skill | 已创建并注册 | Ragdoll |
| `debt_ids` 字段 | 加入 frontmatter contract | Ragdoll |
| SOP 更新 | "完成后真相源同步" 章节 | Ragdoll |
| 维护脚本 | `scripts/tech-debt-maintain.mjs` | Maine Coon |

### 未完成 Gap（2026-02-27 更新）

| Gap | 原因 | 优先级 | 状态 |
|-----|------|--------|------|
| ~~`feat-completion` skill~~ | ~~设计时决定先做 kickoff，completion 延后~~ | ~~P1~~ | ✅ 已完成 `d55d3b6` |
| ~~ADR: Metadata Contract~~ | ~~讨论收敛但沉淀未写~~ | ~~P2~~ | ✅ 已完成 `14a8b53` |
| ~~lessons-learned 更新~~ | ~~同上~~ | ~~P2~~ | ✅ 已完成 LL-024 |
| ~~三猫指引同步~~ | ~~CLAUDE.md/AGENTS.md/GEMINI.md 未同步 F40 规则~~ | ~~P2~~ | ✅ 已完成 `14a8b53` |
| ~~`index.json` 机器索引~~ | ~~脚本未写~~ | ~~P3~~ | ✅ 已完成 `6f69452` |
| ~~Feature 演化图 ADR~~ | ~~演化关系在哪里记录、怎么维护~~ | ~~P3~~ | ✅ 已在 F40 文档中记录 |

### `feat-completion` skill 设计草案

**触发条件**（任一）：
- team lead说"这个 Feature 完成了"、"F0xx done"
- 所有 Acceptance Criteria 都打勾
- PR 合入且云端 review 通过

**详细步骤**：

1. **检查 Acceptance Criteria**
   - 读取 `docs/features/Fxxx.md`
   - 所有 `- [ ]` 都变成 `- [x]` 了吗？
   - 如果有未完成项 → 提示"还有 N 项未完成，确认要标记 done？"

2. **更新聚合文件**
   - `Status: in-progress` → `Status: done`
   - 添加 `Completed: YYYY-MM-DD`
   - 确认 Links 章节链接完整

3. **提示演化关系**
   - 提问："这个 Feature 是从哪个 Feature 演化来的？"
   - 选项：从 Feature 演化图里列出候选（同一栈的 Feature）
   - 如果有 → 更新 `Dependencies.Evolved from`
   - 提问："这个 Feature 完成后，会演化出下一个 Feature 吗？"
   - 如果有 → 记录待开的下一个 Feature

4. **更新 BACKLOG**
   - 从 `docs/ROADMAP.md` 移除该行
   - （聚合文件保留，不删除）

5. **真相源同步检查**
   - 检查关联的 feature-specs/discussions 是否都有正确的 frontmatter
   - 检查关联的 Tech Debt 是否标记完成

**检查清单**：
- [ ] Acceptance Criteria 全部完成
- [ ] 聚合文件 Status=done, Completed 日期
- [ ] Dependencies.Evolved from 已填写（如适用）
- [ ] BACKLOG 已移除该行
- [ ] 关联文档 frontmatter 正确

---

## 收敛计划（Ragdoll 2026-02-27）

### Step 1: 创建 `feat-completion` skill（P1，~30min）

1. 创建 `cat-cafe-skills/feat-completion/SKILL.md`
2. 使用上方设计草案
3. 注册 symlinks 给三猫

### Step 2: 沉淀 ADR（P2，~20min）

1. 创建 `docs/decisions/011-metadata-contract.md`
2. 记录关键决策：
   - 为什么 `stage` 不下沉到普通文档
   - 为什么用 `feature_ids` + `debt_ids` 双字段
   - 机器索引 vs 人工维护的 tradeoff

### Step 3: 更新 lessons-learned（P2，~10min）

1. 编辑 `docs/public-lessons.md`
2. 添加："状态字段多点写入会复发蜘蛛网"
3. 关联 F040

### Step 4: 同步三猫指引（P2，~15min）

1. CLAUDE.md/AGENTS.md/GEMINI.md 添加：
   - "新文档必须加 frontmatter"
   - "创建 Feature 时触发 feat-kickoff"
   - "完成 Feature 时触发 feat-completion"

### Step 5: 验收（P3，可延后）

1. 用 F032 验证"分阶段交付"记录模式
2. 全量扫描验证 frontmatter 覆盖率
3. 可选：生成 `index.json`

---

## 收敛后沉淀检查清单（2026-02-27 完成）

| 沉淀类型 | 内容 | 状态 |
|----------|------|------|
| **ADR** | ADR-011: Metadata Contract | ✅ `14a8b53` |
| **lessons-learned** | LL-024: 状态字段多点写入会复发蜘蛛网 | ✅ `14a8b53` |
| **指引文件** | CLAUDE.md/AGENTS.md/GEMINI.md 同步 frontmatter + skill 规则 | ✅ `14a8b53` |
| **Skill** | `feat-completion` skill | ✅ `d55d3b6` |

---
