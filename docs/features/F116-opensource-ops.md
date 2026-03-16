---
feature_ids: [F116]
related_features: [F059, F113]
topics: [open-source, community, governance, skill, intake, sync]
doc_kind: spec
created: 2026-03-14
---

# F116: Open-Source Ops — 开源社区运营 Skill

> **Status**: done | **Completed**: 2026-03-14 | **Owner**: Ragdoll + Maine Coon | **Priority**: P1

## Why

team experience（2026-03-14 00:15~00:25）：

> "以后社区管理能交给你们，PR 和 issue 来了你们知道如何分类，你们知道如何归档，怎么打规范的 tag。知道如何把猫猫咖啡的同步到那边，如何把开源的吸收回家。最重要的还有你们要知道我们说 clowder 是开源说猫猫咖啡是自己家，别搞混乱。"

> "不是 community 管理，而是一个 skills 里有各个场景的 if 和 ref 到具体的 md，和其他那些 feat 生命周期管理等管理类的 skills 一样。"

F059 建好了技术基础设施（sync 脚本、intake 脚本、ledger 门禁），但猫猫缺一个统一的操作规范——现在知识散落在 F059 spec、SOP 段落、讨论稿、脚本注释里，每次操作要自己拼。需要一个 `opensource-ops` skill 把所有场景收敛到一处，加载即可用。

## What

### Phase A: Skill 框架 + 核心场景

建立 `cat-cafe-skills/opensource-ops/SKILL.md`，覆盖以下场景分支：

**场景路由（加载 skill 后按触发条件进入）**：

```
opensource-ops
├── 场景 A: Issue Triage
│   触发：社区 issue 来了
│   流程：分类(bug/feature/enhancement) → 关联检测(ref feat-lifecycle Step 0)
│         → 打标签 → 互链 → 收敛(duplicate 合并)
│   ref: feat-lifecycle Step 0, F059 CEP 编号决策
│
├── 场景 B: Inbound PR（社区 PR 评估 + 合入 + 吸收）
│   触发：社区 PR 提交到 clowder-ai
│   流程：B1 Merge Gate（质量 + 方向 + intake 预判）
│         → B2 Merge 执行
│         → B3 Intake（跑脚本 + ledger 登记）
│   ref: scripts/intake-from-opensource.sh, ledger gate
│
├── 场景 C: Outbound PR（我们往开源仓提 PR）
│   触发：cat-cafe 代码要发布到 clowder-ai
│   流程：原 community-pr skill 已完全吸收为 ref 文档
│   ref: refs/opensource-ops-outbound-pr.md
│
├── 场景 D: Outbound Sync（定期同步）
│   触发：cat-cafe 有新代码要 sync 到 clowder-ai
│   流程：pre-sync gate → diff preview → sync → post-sync validation
│         → PR 记录（必须列清同步了哪些 feat/bugfix/改动）
│   ref: scripts/sync-to-opensource.sh, sync-manifest.yaml
│
├── 场景 E: Label & 归档管理
│   触发：需要整理标签体系、归档 issue
│   流程：标签规范 → 打标签 → 互链 → 收口关单
│   ref: F059 CEP 讨论中的 label 语义
│
├── 场景 F: Hotfix Lane（Bug 快修通道）
│   触发：社区报 bug，需要精准修复而非全量 sync
│   流程：worktree(sync tag) → 修 bug → sync-hotfix.sh → clowder-ai PR
│         → cherry-pick 回 main → intake record + advance-ledger
│   ref: scripts/sync-hotfix.sh, SOP Hotfix Lane 段落
│
└── 贯穿规则：双仓边界
    cat-cafe = 家 | clowder-ai = 开源仓
    哪些操作在哪个仓做，标签在哪里打，PR 在哪里 review
```

**关键设计原则**：

1. **双仓不混淆**：每个操作步骤明确标注在哪个仓执行。feature 标签(`feature:Fxxx`)在开源仓打；BACKLOG 索引在 cat-cafe 更新。
2. **Merge ≠ Intake**：merge 是接受贡献进开源仓，intake 是决定是否回流到家里，两个独立决策。
3. **Merge 前预判 Intake 类型**：在决定合 PR 之前，先回答"这个 PR 未来是 `absorbed`、`public-only` 还是 `manual-port`"。
4. **一条线不断裂**：`Issue accept → Merge decision → Merge → Intake decision → Ledger record`，每个环节有 checklist。
5. **签名归属**：所有开源仓的评论/操作带猫猫签名（如 `Maine Coon-gpt5.4`），可追溯。
6. **Issue accept 是 Merge 前提**：没有 accepted issue 的 PR 不得 merge。Bug 需确认可复现；Feature 需完成 F 号分配 + 关联检测。
7. **Skill 本身不同步到开源仓**：`opensource-ops` 是内部运营 playbook，必须排除出 outbound sync（`sync-manifest.yaml` excluded 列表）。

### Phase B: community-pr 完全吸收（已完成）

原 `community-pr` skill 的 outbound PR 流程已完全吸收为 `refs/opensource-ops-outbound-pr.md`：
- `community-pr/` 目录已删除（非 deprecated，而是完全移除）
- `manifest.yaml` 已移除 community-pr 条目，opensource-ops 标注 `merged_from: ["community-pr"]`

## Acceptance Criteria

### Phase A（Skill 框架 + 核心场景）

- [x] AC-A1: `cat-cafe-skills/opensource-ops/SKILL.md` 存在，包含场景 A~F 的完整操作步骤
- [x] AC-A2: 场景 A（Issue Triage）包含：分类标准、标签规范、关联检测 ref、互链模板、收敛（duplicate）规则
- [x] AC-A3: 场景 B（Inbound PR）Merge Gate checklist 必须包含：① 有 accepted issue（硬门禁：无 accepted issue 不得 merge）② 质量（CI/测试/代码规范）③ 方向（F 编号 + 关联检测）④ intake 预判（absorbed/public-only/manual-port）；后续含 intake 脚本用法 + ledger 登记步骤
- [x] AC-A4: 场景 D（Outbound Sync）包含：sync 脚本用法、pre-sync gate、diff preview、post-sync validation、PR 记录规范（必须列清同步了哪些 feat/bugfix/改动，team lead要求）
- [x] AC-A5: 场景 E（Label & 归档）包含：标签真相源表（区分"概念语义"和"GitHub 上实际存在的 label"）、缺失标签的创建指引、双仓标签归属规则、互链评论模板
- [x] AC-A6: 贯穿规则"双仓边界"明确：每个操作步骤标注在哪个仓执行
- [x] AC-A7: Skill 加载后，猫猫能按场景路由找到对应操作步骤，不需要去翻 F059 spec 或 SOP
- [x] AC-A8: 场景 F（Hotfix Lane）包含：worktree 基于 sync tag 创建、sync-hotfix.sh 用法、clowder-ai PR 流程、cherry-pick 回 main、intake 登记全链路
- [x] AC-A9: `sync-manifest.yaml` excluded 列表包含 `cat-cafe-skills/opensource-ops/`，确保 skill 不同步到开源仓
- [x] AC-A10: 场景 D Post-Sync Community Reconciliation：全量同步后按 Feature 分包搜社区 issue → 两猫对齐 → 逐包推team lead核验 → 核验全过后执行关单/打标签/评论。全量同步完成 ≠ 技术发布完成，社区收敛做完才算闭环

### Phase B（完全吸收 — 已完成）

- [x] AC-B1: 场景 C 包含原 `community-pr` 的全部 outbound PR 流程（→ `refs/opensource-ops-outbound-pr.md`）
- [x] AC-B2: `community-pr/` 目录已完全删除（team lead拍板：不保留独立 skill，完全吸收为 ref）
- [x] AC-B3: `manifest.yaml` 已移除 community-pr，opensource-ops 标注 `merged_from`

## Dependencies

- **Evolved from**: F059（开源计划——技术基础设施已就绪，现在需要操作规范 skill）
- **Related**: F113（多平台一键部署——首个社区 feature，Issue Triage 实践来源）
- **Absorbed**: community-pr skill（已完全吸收为 `refs/opensource-ops-outbound-pr.md`，目录已删除）

## Risk

| 风险 | 缓解 |
|------|------|
| Skill 写得太长，猫猫加载后找不到需要的场景 | 场景路由表置顶，每个场景独立 section，按触发条件快速定位 |
| 双仓操作步骤写错仓库 | 每个步骤强制标注 `[cat-cafe]` 或 `[clowder-ai]`，review 时逐条检查 |
| community-pr 迁移遗漏 | 迁移前 diff 对照，Phase B 独立 review |
| 社区 bug fix 误走全量 sync 而非 hotfix lane | 场景 F 单列 Hotfix Lane，触发条件明确区分 |
| 内部运营 playbook 泄露到开源仓 | KD-5 + AC-A9：sync-manifest.yaml excluded 硬卡 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Skill 命名 `opensource-ops`，不叫 `community-governance` | 覆盖运营全链路（sync/intake/triage/PR），不局限于治理 | 2026-03-14 |
| KD-2 | Merge 和 Intake 是两个独立 Gate | merge = 接受进开源仓，intake = 决定是否回流家里（Maine Coon-gpt5.4 提议，Ragdoll同意） | 2026-03-14 |
| KD-3 | 所有开源仓操作必须带猫猫签名 | 可追溯，防止混淆是谁干的（team lead要求） | 2026-03-14 |
| KD-4 | Patch 类社区 PR 猫猫可自主 merge，需同时满足 4 条件 | 条件：① 有 accepted issue ② 只改 safe-cherry-pick 或 public-only 路径 ③ 公开仓 CI/测试过 ④ 不涉及 sync 脚本/ledger/边界规则/安全。碰到 manual-port/Feature/工具链 → 升级team lead（Maine Coon-gpt5.4 提议，Ragdoll同意） | 2026-03-14 |
| KD-5 | `opensource-ops` skill 不同步到开源仓 | 内部运营 playbook，排除出 sync-manifest.yaml excluded 列表（team lead要求 2026-03-14 00:27） | 2026-03-14 |
| KD-6 | Outbound Sync PR 必须列清同步内容（feat/bugfix/改动） | team lead要求 2026-03-14 00:41 | 2026-03-14 |
| KD-7 | Skill 写完Maine Coon放行后，@ team lead亲自审核，不直接提 PR | team lead要求 2026-03-14 00:41 | 2026-03-14 |

## Review Gate

- Phase A: Maine Coon review skill 初稿（操作步骤完整性 + 双仓边界正确性）→ 放行后 **@ team lead亲自审核**（不直接提 PR）
- Phase B: Ragdoll review 迁移完整性（diff 对照 community-pr 原文）
