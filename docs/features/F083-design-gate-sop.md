---
feature_ids: [F083]
related_features: [F042, F191, F242, F303, F305]
topics: [sop, design-gate, ux-confirmation, reviewer-fallback]
doc_kind: spec
created: 2026-03-07
completed: 2026-03-07
updated: 2026-08-23
status: done
tips_exempt: "F303 Phase B internal Design Gate governance; no user-invokable capability or product surface."
---

# F083 — Design Gate + Cloud Reviewer Quota Fallback

> **Status**: done | **Owner**: Ragdoll

## Why

operator发现猫猫有时 UX 没确认就直接开写代码，写完才发现不是他想要的。F076 Mission Hub 那次Ragdoll做对了（采访→画图→讨论），但不是每次都这么做。需要把"先确认设计再动手"固化到 SOP 里。

同时云端 Codex 的"代码审查"额度独立于总额度，可能单独耗尽，需要降级策略。

## What

### Design Gate（feat-lifecycle 新 section）

在 Discussion → writing-plans 之间插入设计确认关卡。先按主要功能类型分流，再判断是否叠加了
**用户可见表面**；这两个判断不是互斥分类：
- 前端 UI/UX → 放进真实产品壳，呈现主旅程、默认状态和窄屏状态给operator确认
- 纯后端 API/数据模型 → collaborative-thinking 猫猫讨论
- 架构级变更 → 猫猫讨论 + operator拍板
- Trivial → 跳过，按 SOP 例外路径判断

任何主要类型只要新增或实质改变用户可见布局/交互，就**叠加**前端确认路径；同时命中后端或
架构路径不能豁免。≤5 行且不改变任务、布局或交互的小型文字/间距/颜色修正仍按 Trivial
处理。体验稿可以在隔离预览 worktree 中实现，正式产品实现必须等真实产品壳方向确认。

operator说“先看真页面”时，恢复的就是本 Design Gate，不创建第二个 stage 或 skill：停止用
schema、文档和抽象布局证明体验成立，把主旅程、默认状态与窄屏状态放回真实 Clowder AI 页面，
并使用唯一的 `design-in-context-checklist.md`。

### F303 architecture / contract integrity admission（维护加固）

F083 仍是同一道 Design Gate，不增加 lifecycle stage。先照 F191 回答
`Architecture cell / Map delta / Why`；只有以下三个客观事实任一命中，才把对应 claim
纳入 architecture / contract 风险核验。

F303 trigger set (three-item OR; no fourth trigger):

- `consumer_delta`: 新增或搬动 route、surface、后台 job 或 caller，并复用既有 auth、policy、resolver、cursor 或 lifecycle 语义。
- `authority_delta`: 重构、迁移或 single-writer 收敛改变 canonical owner、writer 或 read path。
- `preservation_boundary_delta`: 出现“保持既有行为”“不改变鉴权”“Map delta: none”“只做 projection”等 preservation claim，且 diff 触及对应 consumer 或 authority boundary。

重复事故 family 与 route-local 分叉只作为 admission 后的证据深度 prior，不是第四个
trigger。普通增量仍只写 `Architecture cell / Map delta / Why`，不要求永久 consumer Matrix。

命中后，在 F191 三行之后追加本次变更的短期 evidence packet：

```markdown
Canonical source: {repo-relative path#symbol | doc path#anchor}
Consumer evidence: {rerunnable LSP/rg command + relevant output | explicit references + why automatic scan cannot express the boundary}
Claim guard: {claim} → {test/lint/guard/self-check command or test name} → red when {input or condition}
```

代码符号必须给可重跑的 LSP find-references 或 `rg` census；只有 MCP tool、skill、workflow
callback 等约定面适用 F242 convention graph。自动扫描无法表达语义边界时，必须列出显式
references，并解释为什么不能自动扫描。缺少 `Canonical source`、`Consumer evidence` 或
`Claim guard` 任一项，eligible change 不通过 Design Gate。

重构、迁移或 single-writer eligible change 还必须追加：

```markdown
Characterization/contract test: {command or test name}
Code-derived consumer census: {rerunnable command + relevant output}
Migration/restart/rollback evidence: {only when persistence or runtime semantics migrate}
```

前两项缺一即不通过；只有持久化或运行语义迁移时才要求第三项，不为普通重构制造空证据。
这些字段是一次性 plan/review evidence，不形成 registry、dashboard 或永久 Matrix。

### Cloud Reviewer Quota Fallback（merge-gate Q4）

remote reviewer 没猫粮时的降级策略：同族换个体 / 跨族降级，禁止Siamese（Bengal Opus 除外），降级后仍须校验 reviewer ≠ 作者。

## Acceptance Criteria

- [x] AC-A1: feat-lifecycle SKILL.md 含 Design Gate section
- [x] AC-A2: SOP.md 流程从 4 步变 5 步（⓪ Design Gate）
- [x] AC-A3: CLAUDE.md / AGENTS.md / GEMINI.md 流程链 + 表格同步
- [x] AC-A4: manifest.yaml / BOOTSTRAP.md 流程链同步
- [x] AC-A5: merge-gate Q4 FAQ：降级策略 + self-review 护栏
- [x] AC-A6: Trivial 路径无路由冲突（R2 修复）
- [x] AC-A7: `pnpm check:skills` 全绿
- [x] AC-A8: 用户可见表面按叠加条件触发；“先看真页面”恢复同一道真实产品壳 Design Gate

## Key Decisions

1. Design Gate 不是独立 skill，是 feat-lifecycle 的一个 section——避免 skill 膨胀
2. 分流判断标准："用户能看到的改动 → 找operator；看不到的 → 猫猫自己搞定；动了骨架 → 两边都过"
3. Trivial 跳过 Design Gate 后按 SOP 例外路径判断（不强导向 worktree 或 writing-plans）

## Dependencies

- **Evolved from**: F042（三层信息架构 + Skills 优化）

## Risk

- 低风险：文档与流程规则调整，已通过 `pnpm check:skills` 验证。

## Review Gate

- 本地 codex R1→R2→R3（3 轮，4P1+1P2→0）
- operator批准跳过remote review（纯文档改动）
