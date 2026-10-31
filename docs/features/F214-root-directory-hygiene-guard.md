---
feature_ids: [F214]
related_features: [F023]
topics: [hygiene, root-directory, governance, pre-commit, runtime-artifacts]
doc_kind: spec
created: 2026-05-28
---

# F214: 根目录卫生守护 (Root Directory Hygiene Guard)

> **Status**: done | **Owner**: Ragdoll/Opus-4.8（Ragdoll） | **Priority**: P2

## Why

根目录长期堆积**无状态运行时残留**——调试日志（`f190-service-manifest-console.log`、`playwright-console-f155-pr504.log`、`spinach-api-discovery.log`）、browser 自动化残留（`forzadata-*.txt`、`cookies.json`）。这些是猫调试时随手 `> foo.log` 或自动化脚本一次性产生的产物，污染 `ls` 根目录的视觉、增加猫扫根目录时的认知噪声。

ADR-010 / F023 的防腐化机制只管**代码子目录**（文件数阈值 + dependency-cruiser）和 **docs/ 归档**，**明确不管根目录运行时残留**——这是治理盲区。

**关键现状（立项前实测，纠正初版提案两处误判）**：
- `.gitignore` 已覆盖几乎所有这些产物（`*.log` / `forzadata-*.txt` / `cookies.json` / `dump.rdb*` / `*.sqlite*`）。`git status` 干净，**零垃圾被 git 追踪**。
- 所以问题**不是** "猫 commit 垃圾进 git"（.gitignore 已挡住），**而是** "无状态残留物理堆在根目录文件系统，污染视觉"。
- `requirements.txt` / `cat-template.json` 是 git 追踪的**合法文件**，初版提案误判为"归属不明垃圾"。
- 初版提案（EP-002，从未落地成文件，源自 thread `[thread-id]` 对话）把核心 frame 成 "pre-commit hook 拦 commit 垃圾"——但 git 根本不会 commit 已 ignore 的文件。pre-commit 在这里只是**兜底**（防未来新增、未被 ignore 的垃圾），不是主要矛盾。

operator experience（2026-05-28）：
- "不准动 redis相关的那些！！"
- "Redis/SQLite/World Engine 的 CWD→专用目录根因修复...我觉得甚至不应该列，因为这都是不兼容修改"

## Scope 边界（🔴 立项第一约束）

### ✅ 本 feature 管：无状态临时残留
可随时删除、可重新生成、无数据迁移风险：
- `*.log`（调试日志残留）
- `forzadata-*.txt`（browser 自动化抓取残留）
- `cookies.json`（browser 自动化）
- 未来新增的同类一次性产物

### ❌ 本 feature 完全不碰：有状态核心数据存储
`dump.rdb` / `dump.rdb.backup-*`（Redis 持久化，**production Redis (sacred)**）、`evidence.sqlite*`（Hindsight 记忆证据库）、`world.sqlite*`（World Engine 世界状态）。

**理由**：
1. 它们不是"垃圾"，是有状态核心数据存储。"在根目录"是**架构布局**事实，不是卫生问题。
2. 改它们的位置 = 改配置 + **迁移现有数据**，不迁就等于核心数据/记忆凭空消失 = **不兼容修改**。
3. `evidence.sqlite` 是记忆系统命脉，敏感度与 production data boundary同级。
4. 重新规划数据存储布局若有必要，应是**独立架构立项**（带数据迁移方案），不是本 hygiene feature 的尾巴 / 后续 Phase。

> **不留尾巴铁律**（`feedback_no_followup_tails` + 「下次一定」）：有状态存储迁移**不列为后续 Phase**。要做就独立立项，不在本 feature 画饼。

## What

> 三层全部**只碰治理规则 + 工具脚本 + git hook，不碰任何运行时服务配置/代码**。

### Phase A: 清理脚本（三重保险）

`scripts/clean-root-debris.sh`，一个文件被删除必须**同时**满足三条，否则保留：
1. **未被 git 追踪**（`git ls-files` 不含它）——自动保护所有 tracked 合法文件（`cat-config.json` / `cat-template.json` / `requirements.txt`，含 OQ-2 operator要保留的）
2. **匹配无状态残留白名单**（`*.log` / `forzadata-*.txt` / `cookies.json`）——白名单制，不靠黑名单兜底
3. **不在硬保护清单**（额外 defense-in-depth）：`dump.rdb*`（含 `dump.rdb.backup-*` 时间戳后缀，OQ-3 operator要保留）/ `*.sqlite*` / `world.sqlite*` 等有状态存储

- **dry-run 优先**：默认只列出将删除的文件；`--execute` 才实际删除。
- 设计来源教训：`feedback_lsof_port_range_kills_sanctuary`（清理过滤宁可白名单不要黑名单 + 圣域显式排除）。

> ⚠️ **glob 陷阱**（OQ-3 暴露）：`dump.rdb.backup-20260209-180218` 不以 `.rdb` 结尾，`*.rdb` glob **匹配不到**它——硬保护必须用 `dump.rdb*` / `dump.*` 覆盖 backup 后缀，否则漏保护 = 圣域事故。

### Phase B: shared-rules 根目录卫生公约

在 `cat-cafe-skills/refs/shared-rules.md` 新增一节（编号取下一个可用 §N）：
- 意识层行为约束：临时 / 调试 / 可重生成产物**不许写在根目录**，应写到专用目录（`tmp/` / `data/` 等已 ignore 的目录）。
- 明确划界：**核心数据存储位置是架构决策，不归 hygiene 管**；hygiene 只管临时产物。
- 引用 ADR-010 为上游决策（本节是 ADR-010 在根目录维度的补丁）。

### Phase C: pre-commit 兜底白名单

在 `.githooks/pre-commit` 追加 Root Hygiene Guard（现有已有 Shared State Guard + Brand Guard，这是第三个）：
- 拦截**根目录新增的、非白名单的**文件被 commit（兜底防御未来未预料的垃圾类型）。
- 白名单足够宽松，覆盖所有现有合法根文件（`*.md`、`package.json`、`*.json` config、dotfiles 等）。
- 定位明确：这是**兜底**层，不是主防御（主防御是 .gitignore + 不写根目录的行为约束）。

## Acceptance Criteria

### Phase A（清理脚本）
- [x] AC-A1: `scripts/clean-root-debris.sh --dry-run` 列出根目录无状态残留（log/forzadata/cookies），不删任何文件
- [x] AC-A2: `--execute` 只删同时满足三条保险的文件；tracked 文件（cat-config.json 等）+ `dump.rdb*`/`*.sqlite*` 即使在根目录也**绝不触碰**
- [x] AC-A3: 三重保险有自动化测试（先红后绿）：含 `dump.rdb.backup-时间戳` 不被误删、tracked `cat-config.json` 不被删、`evidence.sqlite` 不被删

### Phase B（§N 公约）
- [x] AC-B1: shared-rules.md 新增根目录卫生公约节，含"临时产物不留根目录" + "核心存储不归 hygiene 管"双向划界
- [x] AC-B2: 引用 ADR-010 为上游

### Phase C（pre-commit 兜底）
- [x] AC-C1: pre-commit hook 拦截根目录新增非白名单文件（测试：模拟新增垃圾文件被拒）
- [x] AC-C2: 白名单覆盖所有现有合法根文件，hook 不误伤正常 commit（测试：现有根文件能正常 commit）

## Dependencies

- **Related**: F023（目录腐化防御——管子目录代码 + docs 归档，本 feature 互补管根目录运行时残留）
- **Related**: ADR-010（目录结构防腐化机制——本 feature 是其根目录维度的补丁）

## Risk

| 风险 | 缓解 |
|------|------|
| 清理脚本误删有状态存储（圣域事故） | 白名单制 + `*.rdb`/`*.sqlite*` 硬拒绝 + dry-run 默认 + 自动化测试 |
| pre-commit 白名单太严误伤正常 commit | 白名单从现有根文件全集生成 + AC-C2 回归测试 |
| §N 公约沦为无人读的死规则 | Eval Contract 跟踪 activation/friction；pre-commit 是机器强制兜底 |
| 与 ADR-010/F023 scope 重叠混淆 | 明确划界：F023 管子目录代码，F214 管根目录运行时残留 |

## Eval / Tracking Contract（F192 门禁）

> 触发：新增 shared-rules section（§N）+ 新增 pre-commit guard（改变猫 commit 行为）

1. **Primary Users + Activation Signal**：所有写代码的猫。Activation = pre-commit hook 拦截到根目录新增非白名单文件时给出明确提示，猫看到提示并把文件放对位置。
2. **Friction Metric**：pre-commit hook 误伤正常 commit 的次数（false positive）；猫因 hook 被拦后用 `--no-verify` 绕过的次数。
3. **Regression Fixture**：
   - Fixture 1: 根目录新增 `foo.log` → 被 .gitignore 挡（不进 staging）；若强制 add 则被 pre-commit 拒
   - Fixture 2: 根目录新增 `random-debris.xyz`（未 ignore）→ pre-commit 拒
   - Fixture 3: 正常修改 `package.json` / 新增 `docs/xxx.md` → pre-commit 放行
   - Fixture 4: 清理脚本对 `dump.rdb.backup-20260209-180218`（backup 后缀）/ `evidence.sqlite` / tracked `cat-config.json` 全部拒绝删除
4. **Sunset Signal**：若连续 N 个月 pre-commit 零拦截 + 根目录零新增残留，说明"不写根目录"行为约束已内化，本兜底 guard 可考虑退役。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | `cat-config.json`（OQ-2）+ `dump.rdb.backup-*`（OQ-3）保留，不删不 untrack | operator拍板"可能比较重要" | 2026-05-28 |
| KD-2 | 清理脚本三重保险：untracked ∧ 白名单匹配 ∧ 不在硬保护清单 | OQ-3 暴露 `*.rdb` glob 漏 `dump.rdb.backup-*`；多层防圣域误删 | 2026-05-28 |

## Architecture Ownership (F191)

- **Architecture cell**: governance / repo-hygiene（待对照 `docs/architecture/ownership/README.md` 确认 cell id）
- **Map delta**: none（不新增代码模块，只加治理规则 + 脚本 + hook，扩展 ADR-010 既有边界）
- **Why**: 纯治理/工具层改动，不碰运行时数据流或服务模块

## Review Gate

- Phase A/B/C: 跨族 review（脚本/hook 涉及安全边界与圣域保护逻辑，需严格 review）

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "从根源解决猫们乱扔垃圾问题"（提案总结） | AC-A1/A2, AC-C1 | test + manual | [x] |
| R2 | "不准动 redis相关的那些！！"（operator 2026-05-28） | AC-A2/A3, Fixture 4 | test（硬拒绝 .rdb/.sqlite） | [x] |
| R3 | 有状态存储迁移"甚至不应该列"为后续 Phase（operator 2026-05-28） | Scope 边界节 | manual（spec 审查无尾巴） | [x] |
| R4 | §N 根目录卫生公约（提案三件事之一） | AC-B1/B2 | manual | [x] |
| R5 | pre-commit hook 白名单（提案三件事之一） | AC-C1/C2 | test | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（不适用，无前端）
