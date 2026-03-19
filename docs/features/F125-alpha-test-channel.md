---
feature_ids: [F125]
related_features: []
topics: [infra, testing, sop]
doc_kind: spec
created: 2026-03-15
---

# F125: Alpha 验收通道 — main-test 升级为正式 alpha 测试基础设施

> **Status**: done | **Owner**: Maine Coon(gpt52) + Ragdoll(opus) | **Priority**: P1 | **Completed**: 2026-03-16

## Why

team lead希望有一套长期可用的、和 runtime 完全隔离的测试环境，用于验收已合入 `main` 的改动，避免在 runtime（3003/3004/6399）上测试导致不稳定。F125 将临时 `main-test` 工具升级为正式 alpha 通道，并把 alpha 的使用边界同步到 SOP / quality-gate / 三份提示词。

1. 从 `main-test` 改名为 `alpha`，成为正式基础设施
2. 更新 SOP / quality-gate / 提示词，让所有猫知道 `alpha = origin/main` 镜像，只用于已合入 `main` 的验收
3. 明确 runtime 不能冒充 alpha；未合入改动仍在 feature worktree 上自测

team experience：
> "我要！给他搞个一键启动脚本！然后和 runtime 那样每次启动自动同步 main！"
> "我希望这个变成一个 alpha 测试的分支"
> "不止 claude md 还有 agents 和 gemini md 你别只顾你自己"

## What

### Phase A: 基础设施改名 + 脚本落入 main ✅

- `main-test-worktree.sh` → `alpha-worktree.sh`
- `main-test-worktree.test.sh` → `alpha-worktree.test.sh`
- package.json: `main-test:*` → `alpha:*`
- 环境变量前缀: `CAT_CAFE_MAIN_TEST_*` → `CAT_CAFE_ALPHA_*`
- worktree 目录: `../cat-cafe-main-test` → `../cat-cafe-alpha`
- 分支: `main-test/main-sync` → `alpha/main-sync`
- 日志前缀: `[main-test-worktree]` → `[alpha-worktree]`
- 脚本 commit 进 main

### Phase B: SOP + Skill + 提示词更新 ✅

- SOP.md: 加 alpha 通道说明（命令表 + 使用场景 + 铁律）
- quality-gate skill: 验证已合入 `main` 的改动时，验收证据优先取自 alpha
- CLAUDE.md: 加 alpha 验收通道铁律
- AGENTS.md: 同步 alpha 规则
- GEMINI.md: 同步 alpha 规则（Siamese不写代码，但需要知道验收流程）

## Acceptance Criteria

### Phase A（基础设施改名）
- [x] AC-A1: `pnpm alpha:start` 能拉起 3011/3012/4111/6398 隔离环境
- [x] AC-A2: `pnpm alpha:sync` 能 ff-only 同步 origin/main
- [x] AC-A3: `pnpm alpha:status` 显示环境状态含 api_running
- [x] AC-A4: `pnpm alpha:test` 测试全绿
- [x] AC-A5: 旧 `main-test` worktree 能被自动迁移到 `alpha/main-sync`

### Phase B（SOP + 提示词）
- [x] AC-B1: CLAUDE.md 含 alpha 通道规则
- [x] AC-B2: AGENTS.md 含 alpha 通道规则
- [x] AC-B3: GEMINI.md 含 alpha 通道规则
- [x] AC-B4: SOP.md 含 alpha 通道使用说明
- [x] AC-B5: quality-gate skill 提及 alpha 验收证据

## Dependencies

- **Evolved from**: Maine Coon的 `feat/main-test-worktree-launcher` 分支（已 review 通过）
- **Related**: runtime-worktree.sh（模式对齐）

## Risk

| 风险 | 缓解 |
|------|------|
| 改名后旧 worktree 路径残留 | 脚本已有 detached HEAD 自动修复逻辑，扩展到支持旧 main-test 目录迁移 |
| 提示词改动影响多猫 | Phase B 改动最小化，只加一条短规则 |
