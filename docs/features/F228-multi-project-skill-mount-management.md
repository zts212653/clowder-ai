---
feature_ids: [F228]
related_features: [F038, F041, F070, F202]
topics: [skills, capability-dashboard, multi-project, mount, symlink, community-pr]
doc_kind: spec
created: 2026-06-09
community_pr: clowder-ai#760
---

# F228: Multi-Project Skill Mount Management — 多项目 Skills 挂载管理

> **Status**: Phase A + B done (2026-06-17) | Phase C planning | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

## Source

- Community PR: [clowder-ai#760](https://github.com/zts212653/clowder-ai/pull/760)
- Contributor: `mindfn`
- Upstream context: [clowder-ai#719](https://github.com/zts212653/clowder-ai/issues/719) surfaced the original skill symlink writeback bug; narrow bugfix subset already landed through `clowder-ai#876` and was absorbed into cat-cafe.

## Why

Cat Cafe already has a capability dashboard and project governance bootstrap, but skill mounting still has a gap in real multi-project usage: a skill may be globally available, project-specific, or provider-specific, while the filesystem symlinks that actual CLIs load can drift away from the intended policy. Users should be able to manage skills per project and per provider from the Console without hand-editing `.claude/skills`, `.codex/skills`, `.gemini/skills`, or repairing stale symlinks manually.

## Current State / 现状基线

- F041 established `.cat-cafe/capabilities.json` as the capability truth source and shipped the capability dashboard, including multi-project management at the capability-config level.
- F070 bootstraps project-level governance and managed skill symlinks into external projects, but it is primarily about carrying Cat Cafe methodology into projects.
- ADR-025 defines the canonical skill mount policy direction: managed per-skill symlinks, coexistence with external skills, conflict visibility, and Hub-operated sync.
- `clowder-ai#876` fixed the narrow single-project bug where disabling a managed skill failed to remove provider symlinks.
- `clowder-ai#760` proposes the broader feature: multi-project skill mount policy, per-provider mount toggles, drift visibility, and cross-project propagation. Current review state on 2026-06-09: technically promising, but not merge-ready until the feature anchor is corrected and review blockers are resolved.

## What

### Phase A: Source Truth + Merge Gate

Accept #760 under F228 rather than the issue #719-derived pseudo feature anchor, then finish inbound review against the current implementation.

### Phase B: Absorb Multi-Project Skill Mounting

Bring the accepted implementation back into cat-cafe through the normal inbound intake lane, preserving home-specific invariants around capability config, plugin-owned resources, owner gates, brand guard, and existing governance bootstrap behavior.

### Phase C: Product Hardening + ADR-025 Alignment

Close the loop between the shipped UI/API behavior and ADR-025: document the final data model, migration behavior, drift/sync semantics, and what counts as managed vs user-owned skill state.

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC 必须 ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。重构/降复杂度类须实测可量（数字下降），不是"提了可测性就算"。详见 feat-lifecycle SKILL.md。 -->

### Phase A（Source Truth + Merge Gate）
- [x] AC-A1: `clowder-ai#917` (broader implementation, replaces #760) title/body/diff uses F228 anchor only; no #719-derived pseudo feature references.
- [x] AC-A2: #917 has an accepted maintainer Direction Card stating that the broader multi-project skill management scope belongs to F228.
- [x] AC-A3: #917 has green CI on `410f76f4e` (rebased onto sync base `f3d530cea`), merged squash `9ac16836b6`.
- [x] AC-A4: Code review blockers resolved — Maine Coon GPT-5.5 deep review pre-rebase + Spark Maine 5.3-codex Phase 5 continuity ack post-rebase.

### Phase B（Absorb Multi-Project Skill Mounting）
- [x] AC-B1: Intake Intent Issue #2346 lists every absorbed/manual-port file from #917 with cluster-level decision table (83 files: 8 high-risk manual-port + 67 cherry-pick + cluster mapping).
- [x] AC-B2: High-risk files manual-ported: capability routes (auth → localCapabilityWrite → ownerGate triple-gate verified), governance bootstrap, mount-rules CRUD, skills-drift / skills-write routes, plugin resource activation.
- [x] AC-B3: Validation chain pass: shared/api build green, 16-file F228 scope tests (432/433, 1 pre-existing env-fail), web settings vitest 38/38, `pnpm check` and `pnpm lint` no new errors.
- [x] AC-B4: Intake Review Guard verified by Ragdoll/Sonnet 4-audit pass (PR #2347 issue comment 4729249518) — D path exclusion / reverse-sanitize / regression baseline / brand-dictionary boundary all clear. Vision Guardian (Ragdoll/Opus 4.6) confirmed three-route owner-gate preservation + F070 governance bootstrap + F193 topology heal + audit ordering + brand parity.

### Phase C（Product Hardening + ADR-025 Alignment）
- [ ] AC-C1: Console can select a registered project and manage Cat Cafe skills per provider without hand-editing provider directories.
- [ ] AC-C2: Drift visibility distinguishes managed symlink drift vs source/new-skill changes. Filesystem-level conflicts (managed skill name vs pre-existing dir/file/link in mount point) still block instead of overwriting. **`cascadeDisabledSkills` project-local disable preservation during global toggle scope is removed per KD-6** (over-design vs simplicity trade-off; low-frequency intersection).
- [ ] AC-C3: ADR-025 is updated from draft status or given a successor note that reflects the final F228 data model and migration semantics.
- [ ] AC-C4: Public-facing docs or release notes explain the migration/sync behavior for existing users.
- [x] AC-C5: Remove `cascadeDisabledSkills` state tracking from cat-cafe main code (9 files in `packages/api/` + `packages/shared/`) per KD-6. Align home runtime with `clowder-ai@698fb675c` unconditional cascade. **Completed via intake PR #2391 (squash `7aac0abbacab5`, merged 2026-06-18T12:36 UTC). Reviewer**: @gpt52 Maine Coon (cross-family) — initial P1 blocking on plain-reconciliation re-enable behavior, withdrew after KD-6 design context provided; APPROVED at HEAD `38741a99`. Hygiene follow-ups tracked as cat-cafe#2393 (affirmative Path A test + skill-sync-engine.ts:178 comment tighten).

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "每个 project 都可以管理 skills 的能力" | AC-A2, AC-B2, AC-C1 | PR review + API/UI validation | [x] API ✅ + UI surfaces shipped; Console UX flow → Phase C |
| R2 | 不再把 #760 错挂到 issue #719 派生的伪 feature 号 | AC-A1, AC-A2 | GitHub diff/body scan | [x] |
| R3 | 接受 #917 (broader replacement for #760) 要按完整 inbound/intake SOP，不混同 #876 bugfix | AC-B1, AC-B4 | Intake issue + review proof | [x] PR #2347 + Issue #2346 + Sonnet audit + Opus 4.6 vision guard |
| R4 | Skill filesystem state must not drift silently from Console policy | AC-A4, AC-B3, AC-C2 | targeted tests | [x] drift-detector/drift-resolver tests pass + SkillsDriftBanner UI |
| R5 | ADR-025 的 canonical mount policy 要和实现收敛 | AC-C3, AC-C4 | doc diff + maintainer review | [ ] Phase C — ADR-025 from draft → ratified |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F041（Capability Dashboard provided the management surface and `capabilities.json` truth-source contract）
- **Evolved from**: ADR-025（canonical skill mount policy decision）
- **Related**: F038（skills discovery and routing）
- **Related**: F070（portable governance bootstrap into external projects）
- **Related**: F202（plugin resource activation and plugin-owned skill lifecycle)

## Risk

| 风险 | 缓解 |
|------|------|
| Feature scope re-expands into a parallel lifecycle system | Keep F228 scoped to multi-project/per-provider skill mount management; evolution/self-modification ideas stay out of this feature. |
| Schema migration changes truth source through surprising read paths | Require explicit migration semantics and targeted tests before merge/intake. |
| Filesystem writes corrupt user-owned skills or third-party skill installs | Preserve ADR-025 managed-vs-user-owned distinction at filesystem layer; block filesystem conflicts (pre-existing dir/file/link in mount point) instead of overwriting; test rollback/failure paths. In-config project-local disable preservation across global cascade removed per KD-6 (low-frequency intersection — simplicity over edge-case preservation). |
| Large inbound PR loses home invariants during intake | Use Intake Intent Issue, manual-port high-risk files, and cross-family Intake Review Guard. |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Assign F228 as the feature anchor for #760 broader multi-project skill management. | #760 is broader than #876 and not a child task of F041/F070/F202; it productizes ADR-025 for project/provider skill management. | 2026-06-09 |
| KD-2 | Do not use the issue #719-derived pseudo feature id as an anchor. | `719` is the GitHub issue number, not a cat-cafe feature ID; pseudo feature anchors pollute the knowledge graph. | 2026-06-09 |
| KD-3 | D Path absorb strategy: outbound sync first → upstream rebase #917 onto sync base → intake back. | Avoids manual port for 83-file +16k/-3.7k diff. Eliminates merge conflicts; preserves community contribution attribution. | 2026-06-17 |
| KD-4 | Skip mindfn's `ff85ee7` docs commit during intake; cat-cafe maintainer rewrites F228 spec separately. | Avoid foreign authorship in cat-cafe knowledge graph root; mindfn content serves as blueprint reference, not author. | 2026-06-17 |
| KD-5 | Delete `HubSkillsTab.tsx` + `McpInstallForm.tsx` (replaced by `SkillsContent` + `MountRulesPanel` + `SkillsDriftBanner`) | Vision guardian confirmed zero dangling consumers; replacement is functionally complete. | 2026-06-17 |
| KD-6 | Accept operator over-design verdict: remove `cascadeDisabledSkills` mechanism. Global toggle / mount-rule reconciliation cascade is unconditional; project-local disable (`mountPaths: []`) is **not** preserved across global ops. | operator IM sync 2026-06-17 with `mindfn`: the "preserve project-local disable during global cascade" intersection is low-frequency operation; protecting it adds reasoning cost for users ("I toggled global X, why is project Y skill Z still disabled?") and implementation complexity. Original `cascadeDisabledSkills` was added during #917 inbound review for a user-intent-preservation concern that, on reflection, optimizes for an edge case at the expense of mental-model clarity. Aligns home behavior with `clowder-ai/docs/F228` scenarios 6/7 unconditional cascade spec written by community contributor `mindfn`. Filesystem-level conflicts (managed skill vs pre-existing user-owned dir/file) remain protected per ADR-025 — KD-6 only removes the in-config project-local disable preservation. Follow-up tracked as **AC-C5** below (home main code alignment, 9 files). | 2026-06-18 |

## Review Gate

- Phase A: two-cat maintainer review on #760 current head before merge.
- Phase B: full inbound intake review guard with at least one cross-family reviewer.
- Phase C: vision guardian closeout against ADR-025 and Console user workflow.
