---
feature_ids: [F082]
related_features: [F063]
topics: [workspace, git, devops, ux]
doc_kind: spec
created: 2026-03-07
---

# F082 Git Health Panel — Repo 状态可视化

> **Status**: done | **Owner**: Ragdoll
> **Evolved from**: F063 (Hub Workspace Explorer) | **Completed**: 2026-03-08

## Why

operator和朋友们使用 Hub 协作时，经常需要了解 repo 的 git 状态：main 是否干净、有没有遗留分支/worktree 没清理、runtime 和 main 差了多少。目前只能开终端手动 `git status` / `git branch`，体验断裂。

## What

在 Hub Workspace Panel 中增加 Git Health 可视化，分两个 Phase：

### Phase 1: Git Log + Status Viewer（通用层）
- 基础 commit 历史浏览：hash、作者、时间、message
- 支持选择分支 / worktree 查看
- 点击 commit 可查看 changed files 摘要（`git show --stat`）
- Git Status 展示：当前工作区状态（staged / unstaged / untracked 文件列表）

### Phase 2: Git Health Dashboard（定制层）
- **Dirty Files**: `git status --porcelain` 分类展示（staged / unstaged / untracked）
- **Stale Branches**: 已合入 main 但未删除的本地/remote 分支，标注关联猫猫
- **Orphan Worktrees**: 活跃 worktree 列表，标注哪些对应已合入分支（坏猫警报）
- **Runtime Drift**: runtime 与 main 的 commit 差距（落后/领先几个 commit、差了哪些功能）

## Acceptance Criteria

- [x] AC-A1: Git Health Panel 核心能力（Phase 1 + Phase 2）已交付并通过愿景守护验收

### Phase 1 ✅ (PR #290, 2026-03-07)
- [x] `GET /api/workspace/git-log` 返回 commit 列表（hash/author/date/subject）
- [x] 支持 `?worktreeId=xxx&limit=50` 参数
- [x] `GET /api/workspace/git-status` 返回工作区状态（staged/unstaged/untracked 分类）
- [x] 前端 WorkspacePanel 新增 "Git" tab，包含 Log + Status 两个区块
- [x] 点击 commit 展开 changed files 摘要（`GET /api/workspace/git-show`）

### Phase 2
- [x] `GET /api/workspace/git-health` 返回综合健康数据
- [x] Dirty Files 区块：Phase 1 git-status 已覆盖（staged/unstaged/untracked）
- [x] Stale Branches 区块：列出已合入未删的分支 + 猫猫归属（author）
- [x] Orphan Worktrees 区块：标注应清理的 worktree（branch 已 merged = orphan）
- [x] Runtime Drift 区块：显示 runtime 与 main 的 commit 差异（需设 RUNTIME_REPO_PATH）

## 需求点 Checklist

| # | 需求点 | 来源 | AC 映射 |
|---|--------|------|---------|
| R1 | 用户能在 Hub 里看 git commit 历史 | operator朋友反馈 | P1-AC1~2,5 |
| R1b | 用户能在 Hub 里看 git status（工作区状态） | operator朋友反馈 | P1-AC3~4 |
| R2 | operator能看到"main 脏了什么"（进阶分析） | operator experience | P2-AC2 |
| R3 | 能发现谁没清理 branch/worktree | operator experience | P2-AC3~4 |
| R4 | 能看 runtime 和 main 的差距 | operator experience | P2-AC5 |

## Key Decisions

- Phase 1 通用优先，Phase 2 定制层后做
- 后端直接 `execFile('git', ...)` 调用，不引入 isomorphic-git / simple-git 等额外依赖
- 复用现有 workspace API 的 security 层（路径校验、linked roots 权限）

## Dependencies

- **Evolved from**: F063 Hub Workspace Explorer（复用 worktree 选择器、workspace API 基础设施）

## Risk

- `git log` 对大仓库可能慢 → limit 参数 + 分页
- Runtime drift 需要 runtime 目录路径配置化

## 愿景守护发现 (GPT-5.4 + Opus 共识, 2026-03-07)

| # | 级别 | 描述 | 状态 |
|---|------|------|------|
| VG-1a | **P1** | Runtime Drift 只有 ahead/behind 计数，缺差异 commit 列表 | ✅ PR #297 merged |
| VG-1b | **P1** | Runtime Drift baseline 用 HEAD 而非 main（切 worktree 时语义错误） | ✅ PR #298 merged |
| VG-2 | P2 | Status 文件行不能点击跳转到 diff/file 视图 | 待排期 |
| VG-3 | P2 | Stale branch 归属靠 commit author（squash/接力场景会误归） | 待排期 |

## Review Gate

- Phase 完成后跑 quality-gate + 跨猫 review
