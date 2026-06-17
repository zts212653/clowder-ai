---
feature_ids: [F228]
related_features: [F038, F041, F070, F202]
topics: [skills, capability-dashboard, multi-project, mount, symlink, community-pr]
doc_kind: spec
created: 2026-06-09
community_pr: clowder-ai#760
---

# F228: Multi-Project Skill Mount Management — 多项目 Skills 挂载管理

> **Status**: spec | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

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
- [ ] AC-A1: `clowder-ai#760` title/body/diff no longer uses the issue #719-derived pseudo feature anchor; all feature references point to F228 or plain GitHub issue/PR numbers.
- [ ] AC-A2: #760 has an accepted maintainer Direction Card/comment stating that the broader multi-project skill management scope belongs to F228.
- [ ] AC-A3: #760 is out of draft and has green CI on the reviewed head.
- [ ] AC-A4: Code review blockers are resolved or explicitly accepted in writing: read-path migration side effects, global-disable propagation failure semantics, and operation-specific warning copy.

### Phase B（Absorb Multi-Project Skill Mounting）
- [ ] AC-B1: Intake Intent Issue lists every absorbed/manual-port file from #760 with Source Behavior, Must Preserve Home Behavior, and Proof.
- [ ] AC-B2: High-risk files are manual-ported or explicitly proven safe: capability routes, capability schema/migration, mount-rule routes, drift routes, symlink writer, propagation utilities, and plugin resource activation.
- [ ] AC-B3: Validation includes API build plus targeted tests for capability routes, mount-rule store/routes, drift detector/resolver, symlink writer, and cross-project propagation.
- [ ] AC-B4: Intake Review Guard verifies home invariants: plugin-owned capabilities, owner/local write gates, F070 governance bootstrap, F193 topology heal, audit ordering, and Cat Cafe branding.

### Phase C（Product Hardening + ADR-025 Alignment）
- [ ] AC-C1: Console can select a registered project and manage Cat Cafe skills per provider without hand-editing provider directories.
- [ ] AC-C2: Drift visibility distinguishes managed symlink drift, user-owned conflicts, and source/new-skill changes without deleting user-owned skills silently.
- [ ] AC-C3: ADR-025 is updated from draft status or given a successor note that reflects the final F228 data model and migration semantics.
- [ ] AC-C4: Public-facing docs or release notes explain the migration/sync behavior for existing users.

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "每个 project 都可以管理 skills 的能力" | AC-A2, AC-B2, AC-C1 | PR review + API/UI validation | [ ] |
| R2 | 不再把 #760 错挂到 issue #719 派生的伪 feature 号 | AC-A1, AC-A2 | GitHub diff/body scan | [ ] |
| R3 | 接受 #760 要按完整 inbound/intake SOP，不混同 #876 bugfix | AC-B1, AC-B4 | Intake issue + review proof | [ ] |
| R4 | Skill filesystem state must not drift silently from Console policy | AC-A4, AC-B3, AC-C2 | targeted tests | [ ] |
| R5 | ADR-025 的 canonical mount policy 要和实现收敛 | AC-C3, AC-C4 | doc diff + maintainer review | [ ] |

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
| Filesystem writes corrupt user-owned skills or third-party skill installs | Preserve ADR-025 managed-vs-user-owned distinction; block conflicts instead of overwriting; test rollback/failure paths. |
| Large inbound PR loses home invariants during intake | Use Intake Intent Issue, manual-port high-risk files, and cross-family Intake Review Guard. |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Assign F228 as the feature anchor for #760 broader multi-project skill management. | #760 is broader than #876 and not a child task of F041/F070/F202; it productizes ADR-025 for project/provider skill management. | 2026-06-09 |
| KD-2 | Do not use the issue #719-derived pseudo feature id as an anchor. | `719` is the GitHub issue number, not a cat-cafe feature ID; pseudo feature anchors pollute the knowledge graph. | 2026-06-09 |

## Review Gate

- Phase A: two-cat maintainer review on #760 current head before merge.
- Phase B: full inbound intake review guard with at least one cross-family reviewer.
- Phase C: vision guardian closeout against ADR-025 and Console user workflow.
