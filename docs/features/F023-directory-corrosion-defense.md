---
feature_ids: [F023]
related_features: [F214, F219]
topics: [directory, corrosion, defense]
doc_kind: note
created: 2026-02-26
---

# F023: 目录结构防腐化 + 重构 + 代码检查工具链

> **Status**: done（Phase 1）/ phase-2-followup-open | **Owner**: 三猫
> **Created**: 2026-02-26
> **Phase 2 deadline**: 2026-06-30（5 个 dir-size exception 续期截止日，下一轮 sync 前必须真拆）

## Why
- operator 2026-02-13

## What
- **F23 Phase 1**: PR #21 (d366ad5) — 5 WT 全部合入 main。87 files → 7 子目录 + ~690 imports 迁移 + 5 大文件拆分。防腐化门禁 pnpm check:dir-size + pnpm check:deps。Biome v2.4 + LSP + JetBrains MCP 全部启用。routes 目录有 .dir-exceptions.json 例外到 2026-04-01。ADR: 010-directory-hygiene-anti-rot.md

## Phase 2 Follow-up（dir-size baseline carry-over）

5 个目录在 F23 Phase 1 之后超出 25 文件阈值，已经经历两轮"sync 前临时 unblock"续期（首轮 a4e81b8791 + 4136847b10 → 2026-06-01；本次 → 2026-06-30）。再续期 = 「下次一定」病。Phase 2 必须在 2026-06-30 前完成实拆，否则 dir-size guard 在下一次 outbound sync 上将硬阻塞，且 reviewer 应拒绝再续期。

**Timeline**：从今天 (2026-06-01) 到 2026-06-30 = **29 天**，分两段：

| 段 | 目录 | 周期 | 依赖 |
|----|------|------|------|
| **快线（无 F219 依赖）** | `utils` (31) / `config` (38) / `providers` (32) | **1 周内 3 个目录全做完** — 每个 0.5-1 天（grep+sed 改 import + 拆 sub-dir，scope 单一） | 无 |
| **慢线（与 F219 协调）** | `invocation` (25) / `routes` (147) | **等 F219 Phase A 核心引擎技术债盘点结果出来再细化拆分边界** | F219 Phase A — `invocation` 跟 InvocationQueue/QueueProcessor 是 dispatch cell 一坨；`routes/sessions/*`/`routes/invocations/*`/`routes/callbacks/*` 跟 routeSerial 同调用链。F219 owner = Ragdoll Opus 4.8。两个目录的子拆分方案可能在 F219 Phase A 后调整 |

**节奏修正（撤回上一版"每周一个目录"）**：上一版"每周一个" 是过于保守的稻草人 estimate / followup tail。grep + sed import path 改写实际是半天到 1 天工作（已经有明确 sub-dir map）。撤回 4 周节奏，采用"快线 1 周完成 3 个，慢线等 F219 Phase A 出结果"。

2026-06-15 中间 check-in：快线 3 个应该已完成；慢线 invocation/routes 跟 F219 owner 4.8 对齐后给具体起止 timeline。

### 第三轮 unblock 硬门禁（new gate, this PR commits）
如果 2026-06-30 后仍需要任何 `F23-followup` ticket 的续期，**禁止 cross-cat review-only 通过**，必须满足以下其一：
- (a) **operator 显式 signoff**：@co-creator 明确在 PR comment 同意第三轮 unblock
- (b) **同 PR 真拆 ≥1 个目录**：续期 PR 必须同时移除 ≥1 个 `.dir-exceptions.json` 条目并完成对应子目录拆分

这条 gate 落到 `docs/SOP.md` 「outbound sync 基线修复」段（this PR 不顺手改 SOP，由 Phase 2 第一个真拆 PR 一起落）。

### 5 目录 concrete split map

| 目录 | 文件数 | Owner | 子目录拆分方案 | Target |
|------|-------|-------|---------|--------|
| `packages/api/src/utils` | 31 | @codex | `cli/` (10): cli-diagnostics, cli-error-patterns, cli-format, cli-resolve, cli-spawn, cli-spawn-win, cli-supervisor, cli-timeout, cli-types, sanitize-cli-stderr `process/` (2): orphan-chrome-cleaner, ProcessLivenessProbe `media/` (2): image-storage, upload-paths `paths/` (5): active-project-root, is-same-repo, local-override, monorepo-root, project-path `network/` (2): loopback-request, tcp-probe `parsing/` (3): jsonl-tail-reader, ndjson-parser, normalize-error `skills/` (2): skill-mount, skill-parse 顶层 (5): cat-mention-handle, keyword-relevance, owner-gate, request-identity, token-counter | 2026-06-30 |
| `packages/api/src/domains/cats/services/agents/invocation` | 25 | @opus47 | `queue/` (3): InvocationQueue, QueueProcessor, SessionMutex `registry/` (2): InvocationRegistry, getThreadLiveInvocations `progress/` (5): createTaskProgressStore, MemoryTaskProgressStore, RedisTaskProgressStore, TaskProgressStore, TaskProgressCache `reconciliation/` (3): ensureTerminalStatus, reconcileZombies, StartupReconciler `delivery/` (4): MessageDeliveryService, RichBlockBuffer, stream-merge, visible-turn `auth/` (3): IAuthInvocationBackend, MemoryAuthInvocationBackend, RedisAuthInvocationBackend 顶层 (5): invoke-helpers, invoke-single-cat, InvocationTracker, CollaborationContinuityCapsule, McpPromptInjector | 2026-06-30 |
| `packages/api/src/domains/cats/services/agents/providers` | 32 | @opus47 | `agents/` (7): A2AAgentService, ClaudeAgentService, CodexAgentService, DareAgentService, GeminiAgentService, KimiAgentService, OpenCodeAgentService `event-transforms/` (8): a2a-event-transform, antigravity-cli-event-parser, claude-ndjson-parser, codex-event-transform, dare-event-transform, gemini-event-parser, kimi-event-parser, opencode-event-transform `carriers/` (6): ClaudeBgCarrierService, claude-carrier-factory, claude-agent-win, BgTranscriptEventConsumer, JobEventConsumer, TranscriptTailer `image/` (4): codex-image-scanner, generated-image-publication, image-cli-bridge, image-paths `configs/` (7): codex-audit-hooks, codex-session-context-snapshot, kimi-config, l0-compiler, opencode-config-template, transcript-path-hints, agy-profile-manager | 2026-06-30 |
| `packages/api/src/config` | 38 | @opus47 | `cats/` (12): breed-resolver, cat-account-binding, cat-budgets, cat-catalog-store, cat-catalog-subscriber, cat-config-loader, cat-git-identity, cat-models, cat-order-store, cat-voices, resolved-cats, runtime-cat-catalog `accounts/` (4): account-binding-subscriber, account-resolver, account-startup, catalog-accounts `sessions/` (4): session-strategy-keys, session-strategy-overrides, session-strategy, hierarchical-context-config `connectors/` (4): connector-secret-updater, connector-secret-write-guards, connector-secrets-allowlist, credentials `registry/` (5): config-event-bus, config-snapshot, ConfigRegistry, ConfigStore, env-registry `guards/` (3): shared-state-preflight, storage-guard, test-config-write-guard `cli/` (2): codex-cli, context-window-sizes 顶层 (4): frontend-origin, time-zone, parse-utils, project-template-path | 2026-06-30 |
| `packages/api/src/routes` | 147 | @opus47 | (Sum = 147，每子目录 ≤ 27) `callbacks/` (27): 26 个 callback-*.ts + callbacks `threads/` (13): thread-branch, thread-cats-core, thread-cats, thread-export, threads, user-mention, messages, messages.schema, message-actions, push, push-route-helpers, parse-multipart, labels `sessions/` (5): session-chain, session-hooks, session-strategy-config, session-transcript, queue `memory/` (10): memory, memory-publish, library, recall-metrics, evidence-helpers, evidence, distillation-routes, perspectives, reflux-routes, resolution-routes `accounts/` (4): accounts, authorization, cats, capabilities-mcp-write `workspace/` (7): workspace, workspace-edit, workspace-git, projects, projects-bootstrap, projects-mkdir, projects-setup `services/` (10): services, services-lifecycle-{audit,helpers,lock,port,routes}, plugin-routes, limb-node-routes, capabilities, disable-impact `media/` (8): tts, audio-proxy, image-upload, uploads, avatars, ref-audio-upload, preview, mcp-probe `signals/` (4): signal-{collection,podcast,study}-routes, signals `games/` (7): games, game-actions, game-command-interceptor, leaderboard-events, leaderboard, first-run-quest, brake `guides/` (4): guide-action-routes, bootcamp, intent-card-routes, knowledge-feed `docs/` (6): backlog-doc-import, backlog, feat-index-doc-import, feature-doc-detail, git-doc-reader, export `config/` (4): config, config-cat-order, config-secrets, rules `hub/` (5): eval-hub, governance-status, marketplace, packs, skills `telemetry/` (8): telemetry, usage, tool-usage, audit, f163-audit-routes, f163-admin, quota, prompt-captures `invocations/` (9): invocations, hold-ball-cancel, summaries, agent-hooks, execution-digests, commands, slice-routes, claude-rescue, tasks `community/` (3): community-issues, external-projects, external-runtime-sessions `proposals/` (4): proposal-{approve-dispatch,routes,stale-recovery}, votes `workflows/` (6): workflow-sop, schedule, schedule-governance, terminal, world, reflect `connectors/` (3): connector-hub, connector-media, connector-webhooks | 2026-06-30 |

**Phase 2 退出标准**：
- 5 个目录全部从 `.dir-exceptions.json` 删除
- `pnpm check:dir-size` 不依赖任何 F23 ticket
- `docs/decisions/010-directory-hygiene-anti-rot.md` 更新拆分后的子目录映射
- 第三轮 unblock 硬门禁（上述）落到 `docs/SOP.md`

### F219 协调协议（updated 2026-06-02 — 引用 F219 KD-4 裁决）

**F219 owner Opus 4.8 裁决（F219 doc KD-4，commit `09600e546` push main）**：F23 本周 5 目录全可拆，**不需等 F219 Phase A**。

**4.8 first-principles 拆解**（推翻我上一版"慢线等 06-22"）：
- F23 拆分 = 移文件 + 改 import（位置重组，改 `packages/api/src/routes/` 里的文件）
- F219 重构 = 改 service 内容 / 降 complexity（纵向，改 `domains/cats/services/agents/routing/` + `invocation/` 里的文件）
- 两者改的是**不同文件树** → git 层面**不冲突**
- `routes/`(147) 是 HTTP handler 层，与 F219 service 层（`routing/`+`invocation/`）**正交** — callback handler 运行时 import dispatch service（如 `callback-a2a-trigger.ts` import `InvocationQueue`/`WorklistRegistry`/`QueueProcessor`）属**调用耦合非文件冲突**，F219 不碰 `routes/` 目录
- 唯一真**文件级**重合：`invocation/`(25) 一个目录 — F23 移文件 vs F219 改 QueueProcessor 内容，同一批文件

**F219 owner (Opus 4.8) 三条承诺**：
1. **认可 `invocation/` split map** (queue/registry/progress/reconciliation/delivery/auth/顶层) — F219 纵向降复杂度，不重切 cell 边界。4.7 建的 `queue/` 反而给 F219 重构产生的新文件一个现成的家
2. **本周 F219 写操作以 `route-serial.ts` 为主 + Phase A 只读盘点**，不并发写 `invocation/`。4.7 先拆无冲突；万一快线必须碰 `invocation/` 某文件 4.8 提前同步错峰
3. **低概率兜底**：Phase A 若发现 `invocation/` 需**模块级重组**（当前证据不支持），F219 owner 担责届时协调，不让 4.7 劳动浪费

**修正后 Phase 2 节奏**（撤回上一版"快线 1 周 + 慢线 06-15~06-22"分段）：

**5 目录本周内全可拆**（utils / config / providers / invocation / routes 都可推进）。撤回理由：上一版"慢线等 F219 Phase A"和上上一版"每周一个目录"是同型过度保守 — F219 重构和 F23 拆分的"重合"是**运行时调用耦合**不是**文件级冲突**，证据不支持等。

`invocation/` 拆分按 F219 owner 三条承诺协调：4.7 拆文件 / 4.8 改内容 / 错峰同步 — 同步开销 ≤ 等 1-2 周的代价。

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: 无
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
