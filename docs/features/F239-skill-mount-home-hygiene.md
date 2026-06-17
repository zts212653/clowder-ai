---
feature_ids: [F239]
related_features: [F228, F038, F070]
topics: [skills, governance, mount, symlink, cli, hygiene, adr025, phase5]
doc_kind: spec
created: 2026-06-16
---

# F239: Skill Mount HOME Hygiene — `sync:skills` 默认改 project-level + 老 symlinks 清理（ADR-025 Phase 5 收尾）

> **Status**: closed (Phase A + B both merged 2026-06-16) | **Owner**: Ragdoll/Ragdoll (Opus 4.7) | **Priority**: P2

## Why

ADR-025（2026-04-15）签字的 canonical skill mount policy 设计明确：

- **第 3 条**："`~/.claude/skills/` 等用户级目录不再默认承载官方 skills" + "`pnpm sync:skills --user` 可 opt-in 写入"
- **第 8 条**："`setup.sh` / `install.sh` 停止将官方 skills 写入用户级目录" + "旧用户级 symlinks → 清理提示（不自动删除）"
- **实施路线 Phase 5**: "安装脚本迁移 + 旧用户级 symlinks 清理提示 + 猫主动提醒"

clowder-ai#931 → cat-cafe#2323（2026-06-16）完成了 Phase 5 part 1（install/setup 脚本不再默认写 HOME-level skill symlinks）。但**当前 `scripts/sync-skills.sh` 默认行为仍写 HOME-level**，**老用户机器上残留的 HOME-level symlinks 无清理路径**，导致 ADR-025 自相矛盾：spec 说"用户级目录不默认承载官方 skills"，但家里 `pnpm sync:skills` 默认行为正好相反。

operator 2026-06-16 16:17 UTC 拍板："两个都得做"（operator signoff）——拒绝"留 backlog"糖衣，要求实做完成 ADR-025 设计闭环。

## Current State / 现状基线

**实测证据（2026-06-16，main HEAD `74b5eb0fa`）**：

```bash
# scripts/sync-skills.sh line 22-24: HOME paths hardcoded as default targets
HOME_CLAUDE="$HOME/.claude/skills"
HOME_CODEX="$HOME/.codex/skills"
HOME_GEMINI="$HOME/.gemini/skills"

# scripts/sync-skills.sh 仅支持 --dry-run 一个 flag (line 30)
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

# 无 --user opt-in 路径，默认行为永远写 HOME
```

**老 symlinks 残留范围估算**：
- cat-cafe-skills/ 当前有 ~40 个 skill（`ls cat-cafe-skills/ | wc -l`）
- 4 个 provider HOME 目录（claude/codex/gemini/kimi）
- 老用户机器上残留 stale symlinks 上限 = 40 × 4 = 160 个 stale entries 可能（实际取决于装机时机）

**cells map gap**：当前 `docs/architecture/ownership/cells/` 没有 `governance-skill-sync` 或类似 cell 承载 scripts/sync-skills.sh + GovernanceBootstrapService 路径。F228 spec 同样未填 Architecture cell（历史 gap，非 F239 引入）。

## What

### Phase A: `sync-skills.sh` 默认改 project-level + `--user` opt-in

按 ADR-025 第 3 条设计：

- **新默认行为**：`pnpm sync:skills` 只写当前 repo 内的 `.{claude,codex,gemini,kimi}/skills/`（项目级 symlinks，对齐 ADR-025 第 1 条"项目级 = 真实目录，per-skill symlink"）+ 写所有 worktree（已有行为）
- **opt-in 行为**：`pnpm sync:skills --user` 才写 HOME-level (`~/.{provider}/skills/`)
- **CONTRIBUTING.md** 同步更新：clarify dev contributor 想全局共享 skill 需要显式 `pnpm sync:skills --user`

### Phase B: 老 HOME-level symlinks cleanup 提示

按 ADR-025 第 8 条："旧用户级 symlinks → 清理提示（不自动删除）"：

- **新命令**：`pnpm clean:stale-skill-links`（或 `scripts/clean-stale-skill-links.sh`）
- **扫描逻辑**：遍历 `~/.{claude,codex,gemini,kimi}/skills/` 下所有 entry，判定：
  - 是 symlink + target resolve 到当前机器某个 cat-cafe-skills/ 目录 → 候选清理（managed skill, HOME-level）
  - 非 symlink / target 是别处 → 保留（用户自己的 skill）
- **交互**：默认 `--dry-run` 列出候选；`--apply` 才删除（不自动删，per ADR-025 第 8 条）
- **可选 setup.sh 集成**：setup.sh 末尾检测 HOME-level stale symlinks 数量，>0 时打印 "Found N stale HOME-level skill symlinks. Run `pnpm clean:stale-skill-links` to review and clean." 提示（不自动跑）

## User Visibility Disclosure (Step 0.3.5, F190 教训)

把"技术决策"翻译成"用户可见性"语言。审视每个用户可见 surface 是否有缺失/退化，operator 是否签字接受。

| Surface | 用户能做什么（达成态 = ADR-025 设计意图） | 用户实际能做什么（F239 close 时） | 缺失/退化 | 处置 |
|---------|--------------------------------------|----------------------------|----------|------|
| **contributor: `pnpm sync:skills`（默认无 flag）** | 默认只 mount 项目级，不污染家目录 | 默认只 mount 项目级 4 providers (`.{claude,codex,gemini,kimi}/skills/`) + 所有 worktree，不写 HOME | 无 | ✅ shipped |
| **contributor: `pnpm sync:skills --user`** | opt-in 写 HOME-level（与改前默认等价） | opt-in 写 HOME-level，dev 仍可全局共享 | 无 | ✅ shipped |
| **contributor: `CONTRIBUTING.md` Getting Started** | 文档明确告知 `--user` 是 opt-in 路径 | CONTRIBUTING.md line 35-45 已 clarify `pnpm sync:skills --user` 是 contributor 想全局共享时的显式动作 | 无 | ✅ shipped |
| **contributor: `pnpm clean:stale-skill-links`（默认无 flag）** | 默认 dry-run 列出候选不删 | 默认 dry-run，多 source 候选匹配 (main + worktree-local) | 无 | ✅ shipped |
| **contributor: `pnpm clean:stale-skill-links --apply`** | 删 managed stale 只删，user-owned + 非 symlink 严格保留 | `--apply` 显式删；188 stale 测试中 user-owned 30 + 非 symlink 22 全部保留 | 无 | ✅ shipped |
| **end-user: `bash scripts/setup.sh`** | 装机时不静默污染家目录，老 symlinks 检测但不自动删 | setup.sh 不写 HOME-level（Phase 5 part 1 + 本 feat 合力），末尾检测 stale links 仅打 hint 不自动跑 | 无 | ✅ shipped |
| **end-user: 既有用户家目录 stale symlinks** | 主动提供清理路径（不强制自动）| `pnpm clean:stale-skill-links` 自助清理；setup.sh hint 引导；不主动跑、不静默删 | 无 | ✅ shipped per ADR-025 第 8 条"清理提示（不自动删除）" |
| **end-user: 装机后 fresh 状态** | Skills 通过 runtime governance 在项目级 mount，不污染全局 | 完全实现（ADR-025 第 1+3+8 条 fully shipped） | 无 | ✅ shipped |

**无 deferred surface，无 operator sign-off 接受降级项目**——所有用户可见 surface 全部达成。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。重构/降复杂度类须实测可量（数字下降），不是"提了可测性就算"。详见 feat-lifecycle SKILL.md。 -->

### Phase A（`sync-skills.sh` --user opt-in）— ✅ 2026-06-16 (PR #2325 squash `6228ee96e`)

- [x] AC-A1: `pnpm sync:skills`（不带 flag）跑完后 `~/.{claude,codex,gemini,kimi}/skills/` 不新增 / 不更新任何指向 cat-cafe-skills/ 的 symlink；项目级 `.{provider}/skills/` 正常更新（per-skill symlinks 全部就位）— 复核命令：`ls -la ~/.claude/skills/ .claude/skills/ | grep cat-cafe-skills` 前后对比
- [x] AC-A2: `pnpm sync:skills --user` 跑完后 `~/.{claude,codex,gemini,kimi}/skills/` 出现指向当前 cat-cafe-skills/ 的 symlinks（与改造前同等行为）— 复核命令：同 AC-A1 + `--user` flag
- [x] AC-A3: 新增 targeted test `packages/api/test/governance/sync-skills-cli.test.js`（或扩 setup-skills-sync.test.js）验证：(a) 默认参数下脚本输出不包含 HOME paths (b) `--user` flag 时输出包含 HOME paths — 复核命令：`node --test packages/api/test/governance/sync-skills-cli.test.js`
- [x] AC-A4: `CONTRIBUTING.md` 已存在的 `pnpm sync:skills` step 更新为 `pnpm sync:skills --user`（contributor 想全局 = opt-in）— 复核：`git diff CONTRIBUTING.md`

### Phase B（老 symlinks cleanup）— ✅ 2026-06-16 (PR #2328 squash `3570d311b`)

- [x] AC-B1: 新增 `scripts/clean-stale-skill-links.sh` + `package.json` 注册 `clean:stale-skill-links` script — 复核：`pnpm clean:stale-skill-links --help` 输出 usage
- [x] AC-B2: 默认 `--dry-run` 模式：扫描 4 个 provider HOME skills 目录，列出"target 是 cat-cafe-skills/"的候选清理项，不删除任何文件 — 复核：在 staging 环境 `pnpm clean:stale-skill-links` 后 `ls -la ~/.claude/skills/` 未变
- [x] AC-B3: `--apply` 模式：删除候选 stale symlinks；非 symlink / target 是用户自有路径的 entry 必须保留不动 — 复核：staging tmp dir 模拟 mix of stale + user-owned symlinks，运行 `--apply` 后只 stale 被删
- [x] AC-B4: targeted test 验证扫描 + 删除逻辑用 tmp 目录隔离（不动真实 ~/.claude/）— 复核：`node --test packages/api/test/governance/clean-stale-skill-links.test.js`
- [x] AC-B5: `setup.sh` 末尾追加检测：扫描 HOME-level skill 目录是否有 cat-cafe-skills/ 指向的 stale link，count > 0 时打印 hint，**不自动跑** cleanup — 复核：staging 模拟 stale state，跑 setup.sh，验证 hint 出现且 symlinks 未被自动删

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "那我觉得这两个都得做？"（operator 2026-06-16 16:17 UTC，ack 两个都做） | AC-A1, AC-A2, AC-B1, AC-B2, AC-B3 | command verify + targeted tests | [x] |
| R2 | ADR-025 第 3 条：personal/external skills only on user-level | AC-A1, AC-A2 | `~/.claude/skills/` snapshot before/after | [x] |
| R3 | ADR-025 第 8 条：旧用户级 symlinks → 清理提示（不自动删除） | AC-B2, AC-B3, AC-B5 | dry-run default + setup.sh hint | [x] |
| R4 | dev workflow 不 broken（contributor 仍可 opt-in 全局） | AC-A2, AC-A4 | `pnpm sync:skills --user` + CONTRIBUTING update | [x] |
| R5 | 不误删 user-owned skills | AC-B3 | tmp dir mock + targeted test | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式

## Dependencies

- **Evolved from**: ADR-025（canonical skill mount policy，2026-04-15 签字）+ clowder-ai#931 / cat-cafe#2323（Phase 5 part 1，2026-06-16）
- **Blocked by**: 无
- **Related**: F228（multi-project skill mount management，Console UI 层，本 feat 是 CLI 工具层）/ F038（Skills 梳理 + 按需发现机制，parked）/ F070（portable governance bootstrap，runtime project-level path 由它接管）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase A 改 `sync:skills` 默认行为破坏三猫 dev 习惯（之前依赖默认全局共享） | (1) CONTRIBUTING.md 同步更新明确 `--user` 是 contributor opt-in 路径 (2) 第一次跑新版默认行为时脚本输出 "Note: HOME-level skills no longer updated by default. Use --user to mount globally." 提示（一次性 awareness）(3) Maine Coon reviewer 评估 contributor 习惯影响 |
| Phase B cleanup script 误删 user 自己 ln -s 到家目录的 cat-cafe-skills/（user 主动建的，不该删） | 严格 link target match：只清"target 是 cat-cafe-skills/ 源目录"的 symlinks；用户自建 link 走任意 target 路径不动；`--dry-run` 默认 + 显式 `--apply` 双重 confirm |
| Phase B 跨平台兼容（macOS / Linux readlink 行为差异，Windows junction） | 限定 POSIX 路径（macOS / Linux），Windows skip（per ADR-025 第 7 条 Windows 用 junction, 不在本 feat scope）；测试用 tmp dir Mock + readlink GNU/BSD 兼容 |
| Phase A targeted test 在 CI 中跑（CI 没有 cat-cafe-skills/ 真实 path）| 用 mock cat-cafe-skills tmp dir + 验证 sync-skills.sh **输出**包含正确 path，不实际跑 ln |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F239 独立立项，不归并 F228 | F228 scope = Console UI + API multi-project mount management；F239 scope = CLI 工具层（sync-skills.sh + cleanup script）。两个层次不同所有者意图，独立 lifecycle | 2026-06-16 |
| KD-2 | 拒绝"留 backlog" 路径 | operator 16:10 UTC "我们家不放 follow-up 只放 feat"——close 二选一：实做或签字降级。operator 16:17 UTC 选实做 | 2026-06-16 |
| KD-3 | Phase B 默认 `--dry-run`，不自动删 | ADR-025 第 8 条明确"清理提示（不自动删除）"。用户可见性优先 + 不可逆操作 fail-closed | 2026-06-16 |

## Review Gate

- Phase A: 跨族 reviewer（Maine Coon @codex 或 @gpt52），改 sync-skills.sh 默认行为属用户可感知 CLI 行为变化，需 reviewer 形式 GitHub evidence
- Phase B: 跨族 reviewer，cleanup script 涉及 ~/.{provider}/ delete 操作，必须严格 dry-run + symlink target match 验证

## Architecture cell

```
Architecture cell: TBD (governance-skill-sync; cells map gap noted in OQ-1)
Map delta: pending cells map maintenance (deferred — not introduced by this feat)
Why: scripts/sync-skills.sh + GovernanceBootstrapService 路径无对应 cell；F228 同样未填，gap 非本 feat 引入
```

## Eval / Tracking Contract

- **Primary Users**: cat-cafe contributors (三猫 + future external contributors) running `pnpm sync:skills` for dev workflow
- **Activation Signal**: `pnpm sync:skills` 命令执行次数 + `--user` flag 使用比例（telemetry from CONTRIBUTING.md awareness）
- **Friction Metric**: contributor 第一次跑新版默认看到 "no HOME mount" 后多久反应过来要 `--user`（若需要全局）；零 friction 目标 = CONTRIBUTING.md 双步说明 + 脚本输出 hint
- **Regression Fixture**:
  - F239-A: `pnpm sync:skills`（默认）→ `~/.claude/skills/` 不出现 cat-cafe-skills/ link
  - F239-B: `pnpm sync:skills --user` → `~/.claude/skills/` 出现 link
  - F239-C: `pnpm clean:stale-skill-links --dry-run` → 列出但不删
  - F239-D: 用户自建 `~/.claude/skills/my-skill -> /some/other/path` → cleanup 不动
- **Sunset Signal**: ADR-025 整体被 supersede（如未来出新 ADR 修改 canonical mount policy），或 cat-cafe 完全弃用 HOME-level skill 概念（极不可能）
