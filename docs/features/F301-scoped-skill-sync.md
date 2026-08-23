---
feature_ids: [F301]
related_features: [F239, F228, F038]
topics: [skills, governance, cli, worktree, contributor-dx, symlink]
doc_kind: spec
created: 2026-08-21
description: "Contributor-centered skill sync limits daily link repair to the invoking worktree while retaining explicit fleet repair and external-skill safety."
description_source: model
description_author: codex-terra
description_updated_at: 2026-08-21T08:22:00Z
tips_exempt: "CLI-only contributor mount maintenance; it adds no Hub-discoverable capability or guide surface."
---

# F301: Scoped Skill Sync — 当前 Worktree 快路径与显式 Fleet Repair

> **Status**: done | **Owner**: 小团团·Maine Coon (@codex-terra, GPT-5.6 Terra) | **Priority**: P2

## Why

贡献者只是在一个 feature worktree 增加或修订一个 skill 时，现有 pnpm sync:skills 默认仍扫描全仓 worktree 和全部 provider。F239 的完成后摩擦记录已在 2026-07-11、2026-07-16 两次复现；当前实测又为 124 个已登记 worktree，其中 122 个进入循环，形成 488 个 provider 目标。日常本地修订不应支付 fleet repair 成本，也不能因 source 固定在 main 而看不到当前 worktree 未提交的新 skill；同时维护者仍须能显式修复全体受管 mount，且不碰外部 skill。

## Current State / 现状基线

当前 scripts/sync-skills.sh 在启动时把第一个 git worktree 作为 MAIN_REPO，并以 MAIN_REPO/cat-cafe-skills 收集 skill 名称。随后 Part 1 无条件遍历 git worktree list 的每个可用、非 main-sync worktree，再遍历 claude、codex、gemini、kimi 四个 provider；每个 target 逐一 readlink/分类，即使现有 link 已正确也会计入扫描劳动。

- 2026-08-21 实测：registered=124，existing=124，main-sync skipped=2，eligible worktrees=122，provider targets=488。
- F239 累积复现：55 worktrees × 4 providers 导致 334 修复；五天后 66 worktrees × 4 providers 导致 770 修复。
- 现有 source label 显示 main 的 source；未提交 skill 不在该名单，不能被当前 worktree 的常规 sync mount。
- F239 已 closed；本 feature 只承接其 Post-completion friction log，不重开或改写任何 F239 Phase。

## What

### Phase A: 当前 Worktree 快路径与真实 Source

把无 flag 的 pnpm sync:skills 定义为 contributor 日常路径：

- 只选调用命令所在 git worktree，校正其四个 provider 的受管 mount。
- 从该 worktree 自己的 cat-cafe-skills 收集 skill 清单，允许未提交的新 skill 在本地被 mount。
- 继续使用 ADR-025 的 per-skill symlink、directory-level mount guard、parent escape guard 和非 symlink fail-loud 语义。
- 不删除、覆盖或纳入外部 skill；HOME-level 仍只由既有 --user opt-in 触发。

### Phase B: 显式全量与可诊断输出

提供经过调查后命名的 --all flag，作为 fleet repair 的明确请求：

- --all 扫描每个 eligible worktree 的四个 provider，保留当前全量 repair 能力；每个 target 使用自己的可用 skill source，绝不把 link 写入另一只猫的 worktree 之外。
- 默认输出只给 scope、target 计数、created/repaired、already-correct、directory mounts、skip/error 的可读摘要。
- --verbose 才输出逐 worktree/provider/link 的诊断明细；错误与安全拒绝始终可见。

## User Journey

### Primary Journey: 在 feature worktree 修订一个 skill

- **Scope unit**: workspace
- **Actor**: contributor
- **Entry**: contributor 在当前 git worktree 修改或新增一个 skill 后运行 pnpm sync:skills。
- **Flow**:
  1. 命令确认当前 worktree 和该 worktree 的 skill source。
  2. 命令只检查四个 provider mount，并为缺失或过期的受管 link 修复。
  3. contributor 看到简短摘要，未提交的新 skill 已可在当前 worktree 使用；其他 worktree 与外部 skill 未被触碰。
  4. 只有维护者明确运行 pnpm sync:skills --all 时，才进行 fleet-wide repair；需要逐项诊断时追加 --verbose。
- **Success evidence**: tmp fixture 的 target-count、link-target、外部 skill 保留和 stdout assertions。
- **Non-goals**: 不修改 ADR-025 的 HOME policy、不自动删除外部 skill、不在默认路径同步其他 worktree、不创建新的 Hub surface。

## Acceptance Criteria

### Phase A（当前 Worktree 快路径）

- [x] AC-A1: 无 flag 命令仅扫描 invoking worktree 的 4 个 provider target；多 worktree tmp fixture 证明其他 worktree 不读写，默认 target count=4。
- [x] AC-A2: 当前 worktree 未提交的有效 skill 会进入 source list，并在四个 provider surface 按 canonical 相对路径 mount。
- [x] AC-A3: 已有正确 link、缺失 link、过期 link、directory-level mount、parent escape 和非 symlink collision 的既有安全语义均保持可验证。

### Phase B（显式全量与输出）

- [x] AC-B1: pnpm sync:skills --all 在多 worktree × 多 provider fixture 上执行 full repair，缺失/过期受管 link 被修复，结果可由 target count 和 link assertions 复核。
- [x] AC-B2: 外部 skill real directory/file 与不属于受管 source 的 symlink 在 current 和 --all 模式均保留不动。
- [x] AC-B3: 默认输出为单一可读摘要，不含逐 link 的成功日志；--verbose 展开逐 target/action 诊断，错误和拒绝不被静默。
- [x] AC-B4: targeted test 以 tmp fixture 覆盖 multi-worktree、4 providers、already-correct、missing、stale、external preservation、current source 和 --all/--verbose CLI contract。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 单个 skill / 当前 worktree 的日常修订不默认支付全仓扫描与日志成本 | AC-A1, AC-A2, AC-B3 | tmp fixture count + stdout test | [x] |
| R2 | 仍保留显式全量同步能力 | AC-B1 | multi-worktree fixture | [x] |
| R3 | 不误伤外部或其他猫 worktree | AC-A1, AC-A3, AC-B2 | fixture isolation + preservation assertions | [x] |
| R4 | 需要诊断时能展开详细日志 | AC-B3 | stdout test | [x] |
| R5 | 兼容 canonical mount policy | AC-A2, AC-A3, AC-B1, AC-B2 | link-target and guard tests | [x] |

### 覆盖检查

- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（不适用：CLI-only）

## Dependencies

- **Evolved from**: F239（已关闭的 Post-completion friction log；ADR-025 Phase 5 CLI 收尾）
- **Blocked by**: 无
- **Related**: F228（multi-project skill mount management）/ F038（skills discovery）

## Risk

| 风险 | 缓解 |
|------|------|
| 默认缩窄让维护者误以为已 fleet-wide repair | 明确 --all 语义、默认摘要显示 exact scope/target count、测试覆盖 full mode |
| 当前 source 接纳未提交或分支局部 skill 后破坏 canonical mount | 只将 link 写到相同 worktree；保留 source classification、relative target 和 all-mode fixture |
| 外部 skill 或 provider directory-level mount 被改写 | 保留 ADR-025 guards；fixture 把 real directory/file 与 foreign symlink 作为不可变 sentinel |
| 静默输出掩盖失败 | 仅压缩成功噪音；错误、拒绝和最终 error exit 一律可见 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新开 F301，不重开 F239 | F239 已完成，且其 friction log 明确要求独立 feature 承接 | 2026-08-21 |
| KD-2 | 默认 scope=current，显式 full mode 命名为 --all | 根因确认 default 的 fleet scan 是日常 DX 税；--all 直接表达维护意图 | 2026-08-21 |
| KD-3 | 默认 source=current worktree | 现有 MAIN_REPO source 漏掉未提交新 skill；per-worktree relative mount 应读取同一 worktree source | 2026-08-21 |
| KD-4 | 不增加 eval | AC 是确定性 CLI 契约，最匹配的机制是 tmp fixture tests/guards；没有需 keep/tune/sunset 的不确定效用 consumer | 2026-08-21 |

## Review Gate

- Phase A/B: @glm52 以 exact final HEAD `792b74b4` 做独立 local review and approved with no P1/P2；行为面为 CLI scope/source/output contract，选择家里语境 review，不叠加 cloud。

## Architecture cell

Architecture cell: governance-skill-sync (unmapped historical boundary)
Map delta: none
Why: F239 OQ-1 已记录 scripts/sync-skills.sh 无现有 ownership cell；本 feature 不创建服务、变更 owner 或扩展点，只修正该既有 CLI 的 scope/source/output contract。cell map maintenance 保持独立，避免为当前 DX 修复扩大范围。
