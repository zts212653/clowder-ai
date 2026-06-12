---
feature_ids: [F228]
related_features: [F038, F041, F070, F202]
topics: [skills, capability-dashboard, multi-project, mount, symlink, community-pr]
doc_kind: spec
created: 2026-06-09
community_pr: clowder-ai#760
---

# F228: Multi-Project Skill Mount Management — 多项目 Skills 挂载管理

> **Status**: implementation | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

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

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
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

## 数据模型

### 单一真相源：capabilities.json v2

所有 skill 挂载状态在 `.cat-cafe/capabilities.json`（v2）一个文件中管理。没有独立的 state 或 rules 文件。

```
capabilities.json v2
├─ capabilities[]          # skill 列表
│   ├─ enabled             # skill 级开关（用户/级联操作）
│   ├─ mountPaths          # 目标挂载策略（声明该 skill 应挂载到哪些挂载点）
│   ├─ source              # "cat-cafe" | "external"
│   └─ type, id, ...
├─ skillsSync              # 源同步追踪
│   ├─ sourceManifestHash  # 源 skill 集合的 hash
│   └─ lastSyncedAt        # 上次同步时间
└─ mountRules              # 挂载点配置（哪些挂载点启用）
    └─ MountRuleEntry[]    # 标准 + 自定义挂载点
```

文件系统 symlinks（`.claude/skills/xxx`、`.codex/skills/xxx` 等）是 capabilities.json 的**派生状态**，每次操作后同步。

## mountPaths 状态模型

### 核心原则

`capabilities.json` 中每个 skill 的 `mountPaths` 字段记录该 skill **目标挂载策略**——声明该 skill 应挂载到哪些 mount point（挂载点）。文件系统 symlinks 是 mountPaths 的**活跃子集**：只有同时在 mountPaths 和 mount rules 中启用的 mount point 才有对应 symlink。当 mount point 被临时禁用时，mountPaths 保留该 mount point 以便 `restoreNewlyEnabledMountPoints()` 在重新启用时自动恢复挂载。

**术语约定**：claude / codex / gemini / kimi 等目录称为"挂载点（mount point）"，不称 provider（避免与模型供应商混淆）。

### mountPaths 值语义

| 值 | 含义 | enabled |
|---|------|---------|
| `['claude','codex','gemini','kimi']` | skill 挂载到了这 4 个挂载点 | true |
| `['claude','kimi']` | skill 只挂载到 claude 和 kimi | true |
| `[]` + `enabled: false` | skill 被用户/级联禁用，无挂载 | false |
| `[]` + `enabled: true` | 所有挂载点均被禁用，skill 本身未禁用 | true |

**不再使用 `mountPaths: undefined`**——每个 managed skill 必须有明确的挂载点列表。

**`enabled: true` + `mountPaths: []` 的读路径行为**：当所有挂载点均被禁用时，读路径（`resolveCapabilityMountPolicy`、drift 检测、skills 列表）将此状态视为"实际不可用"（等效 disabled）。这是合理的预期行为——skill 本身未被用户禁用，但因无可用挂载点而无法生效。当挂载点重新启用时，`restoreNewlyEnabledMountPoints()` 自动恢复挂载，skill 恢复为可用状态。

### 完整操作场景

#### Skill 级操作（单项目）

| # | 操作 | mountPaths 变化 | enabled |
|---|------|----------------|---------|
| 1 | 新项目 sync，skill 首次挂载 | → 当前项目所有可用挂载点 | true |
| 2 | 用户禁用 skill 在某个挂载点 | 移除该挂载点 | true |
| 3 | 用户启用 skill 在某个挂载点 | 加上该挂载点 | true |
| 4 | 项目下禁用 skill | → `[]` | false |
| 5 | 项目下启用 skill | → 当前项目所有可用挂载点 | true |

#### 全局 Skill 级联

| # | 操作 | 效果 |
|---|------|------|
| 6 | 全局禁用 skill | 逐项目执行场景 4 |
| 7 | 全局启用 skill | 逐项目执行场景 5 |

#### 挂载点级联

| # | 操作 | 效果 |
|---|------|------|
| 8 | 项目下禁用某个挂载点 | 该项目下所有 skill 执行场景 2（移除该挂载点） |
| 9 | 项目下启用某个挂载点 | 该项目下所有 enabled skill 执行场景 3（加上该挂载点） |
| 10 | 全局禁用某个挂载点 | 逐项目执行场景 8 |
| 11 | 全局启用某个挂载点 | 逐项目执行场景 9 |

#### Skill 源变更

| # | 操作 | mountPaths 变化 |
|---|------|----------------|
| 12 | Skill 源内容更新（hash 变化） | 不变（只更新 symlink 内容） |
| 13 | Skill 从全局源删除 | 清理 mountPaths + 移除 capability entry |
| 14 | 全局新增 skill（首次发现） | 等同场景 1 |

### Drift 异常检测与修复

三层数据，每层只对比相邻层：

```
cat-cafe-skills/ 源目录
        ↕ 全局级对比
全局 capabilities.json
        ↕ 项目级对比
项目 capabilities.json（mountPaths）↔ 各 mountpoint 下的 symlinks
```

#### 全局级异常（"全部 Skill" tab）

对比：**cat-cafe-skills/ 源目录** vs **全局 capabilities.json**

| 场景 | 方向 | 同步动作 |
|------|------|---------|
| **未注册** | 源有 → 全局 config 无 | 注册到全局 config + 级联同步各项目 |
| **幽灵注册** | 全局 config 有 → 源无 | 清理全局 config + 级联清理各项目 |
| **源有更新** | hash 不一致 | 更新全局 config + 级联 |
| **项目同步汇总** | — | 各项目异常的汇总视图 |

#### 项目级异常（"项目 Skill" tab）

**配置同步**：**全局 config** vs **项目 config**

| 场景 | 方向 | 同步动作 |
|------|------|---------|
| **新增 skill 待同步** | 全局有 → 项目无 | 同步 skill 配置到项目 |
| **项目残留** | 项目有 → 全局无 | 清理项目中全局已不存在的 skill |

**挂载同步**：**项目 config 的 mountPaths** vs **各 mountpoint 下的 symlinks**（per mountpoint 粒度）

| 场景 | 方向 | 同步动作 |
|------|------|---------|
| **挂载缺失** | mountPaths 有某 mountpoint → 该 mountpoint 下没 symlink（非冲突） | 建 symlink |
| **残留 symlink** | mountPaths 没有某 mountpoint → 该 mountpoint 下有 symlink | 删 symlink |
| **挂载冲突** | mountPaths 有某 mountpoint → 该路径被同名目录/文件/链接占了 | 覆盖（提示备份） |

#### 状态一致性校验

| 异常状态 | 预期处理 |
|---------|---------|
| enabled + mountPaths: [] + 所有挂载点均启用 | 异常：应有挂载点或应为 disabled（场景 8 级联导致的合法空列表除外） |
| disabled 但有 mountPaths 内容 | 异常：disabled 应配合 mountPaths: [] |

#### 操作

统一"立即同步"按钮（调用现有 syncProject / syncAll 接口），不再提供逐条跳过/覆盖选项。

### 挂载冲突处理

当 managed skill 名称与挂载点目录下已存在的同名目录/文件/链接冲突时：

- **不自动覆写**，不修改 mountPaths（config 保留用户意图）
- 通过 drift banner 展示冲突详情：skill 名 + mountpoint + 冲突类型
- 冲突提示信息：**存在同名目录/文件/链接占用（立即同步会覆盖和清理已有内容，请先确认是否需要进行备份）**
- 用户点"立即同步"后统一覆盖处理
- Per-provider toggle 显示 config 意图（ON），冲突的 mountpoint 旁标注"挂载异常"badge

### 实现差距修复记录（已修复 — commit 4bef1b2de）

1. **场景 1/5/7：新 skill / re-enable 写 `mountPaths: undefined` → 已改为写明确列表** ✅
   - 修复：`skill-sync-config.ts` 始终写 `mountPaths: [...providerNames]`；`skill-sync-engine.ts` 传 `activeTargetIds` 替代 `[]`
   - 测试：`skills-state.test.js`、`skill-sync.test.js`、`skill-sync-rules.test.js`

2. **场景 9/11：挂载点 re-enable 后未更新 mountPaths → 已加 restore 逻辑** ✅
   - 修复：`mount-rules-reconciliation.ts` 新增 `restoreNewlyEnabledMountPoints()`，仅恢复标准挂载点
   - 测试：`mount-rules-reconciliation.test.js`（scenario 9 + custom path edge case）

3. **场景 8/10：prune 不允许裁剪为空 → 已移除 guard** ✅
   - 修复：`mount-rules-reconciliation.ts` 移除 `nextMountPaths.length === 0` guard
   - 测试：`mount-rules-reconciliation.test.js`（prune-to-empty）

4. **drift-resolver 同 Gap 1 → 已修复** ✅
   - 修复：`drift-resolver.ts` noPolicySkills 写 `activeMountProviderIds()` 替代 `[]`
   - 测试：`drift-resolver.test.js`

## 模块架构（最终布局）

原 main 分支的 skill 管理代码分散在 5 个独立函数文件中，存在冗余重复和职责混乱。重构后按职责边界拆分为清晰模块：

### API 核心模块 (`packages/api/src/skills/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `skill-manage.ts` | 272 | CRUD API：addSkill / removeSkill / listSkills / querySkill |
| `skill-meta.ts` | 167 | 元数据读取：SKILL.md frontmatter + manifest.yaml + MCP 依赖解析 |
| `skill-sync-engine.ts` | 327 | syncProject 编排：detect → resolve → write config → write symlinks |
| `skill-sync-config.ts` | 188 | config 写入：readSkillsSyncState / writeSkillsSyncState / updateSkillMountPaths |
| `skill-sync-all.ts` | 107 | syncAll 级联：遍历所有已注册项目调用 syncProject |
| `drift-detector.ts` | 309 | 漂移检测：文件系统 vs capabilities.json 对比 |
| `drift-resolver.ts` | 146 | 漂移修复：事务性 snapshot/rollback |

### 工具模块 (`packages/api/src/utils/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `skill-source.ts` | 105 | 源目录扫描 + staleness 检测 |
| `skill-mount.ts` | 232 | 挂载目标解析 + symlink 状态检查 |
| `skill-mount-policy.ts` | 38 | 挂载路径策略归一化 |

### 治理模块 (`packages/api/src/config/governance/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `skill-sync.ts` | 34 | validateSkillName + resolveEffectiveSkillMountPaths |

### 已删除模块

| 文件 | 原行数 | 删除原因 |
|------|--------|----------|
| `skills-state.ts` | 210 | 职责混杂（扫描+配置读写+staleness），拆入 skill-source.ts + skill-sync-config.ts |
| `skill-parse.ts` | 112 | 与 skill-meta.ts 重复（parseManifestSkillMeta + SkillMeta），合入 skill-meta.ts |
| `skill-conflict.ts` | — | 被 drift-detector 取代 |
| `managed-skill-writeback.ts` | — | 被 skill-sync-engine 取代 |
| `HubSkillsTab.tsx` | 315 | 死代码，已被 SkillsContent 取代 |
| `McpInstallForm.tsx` | 276 | 仅 HubSkillsTab 引用，随之删除 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Assign F228 as the feature anchor for #760 broader multi-project skill management. | #760 is broader than #876 and not a child task of F041/F070/F202; it productizes ADR-025 for project/provider skill management. | 2026-06-09 |
| KD-2 | Do not use the issue #719-derived pseudo feature id as an anchor. | `719` is the GitHub issue number, not a cat-cafe feature ID; pseudo feature anchors pollute the knowledge graph. | 2026-06-09 |
| KD-3 | 将 5 个独立函数文件统一为 skill-manage / skill-sync-engine / skill-sync-all 三层 API + 通用 addSkill/removeSkill 接口。 | 原 5 函数冲突处理不一致，暴露了文件操作和同步细节。通用接口屏蔽实现，降耦合。| 2026-06-12 |
| KD-4 | skills-state.ts 拆分到 skill-source.ts + skill-sync-config.ts；skill-parse.ts 合入 skill-meta.ts。 | skills-state 混杂扫描+配置+staleness 三种职责；skill-parse 与 skill-meta 存在 SkillMeta 接口和 parseManifestSkillMeta 函数重复。 | 2026-06-12 |
| KD-5 | 删除 HubSkillsTab + McpInstallForm + 3 前端测试 + skill-conflict.test（共 1175 行死代码）。 | HubSkillsTab 已被 SkillsContent 取代零引用；McpInstallForm 仅被 HubSkillsTab 消费；skill-conflict.test 导入已删除模块。 | 2026-06-12 |

## Review Gate

- Phase A: two-cat maintainer review on #760 current head before merge.
- Phase B: full inbound intake review guard with at least one cross-family reviewer.
- Phase C: vision guardian closeout against ADR-025 and Console user workflow.
