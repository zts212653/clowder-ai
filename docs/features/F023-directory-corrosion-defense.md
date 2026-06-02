---
feature_ids: [F023]
related_features: [F214]
topics: [directory, corrosion, defense]
doc_kind: note
created: 2026-02-26
---

# F023: 目录结构防腐化 + 重构 + 代码检查工具链

> **Status**: done（Phase 1）/ phase-2-followup-open | **Owner**: 三猫
> **Created**: 2026-02-26
> **Phase 2 deadline**: 2026-06-30（5 个 dir-size exception 续期截止日，下一轮 sync 前必须真拆）

## Why
- team lead 2026-02-13

## What
- **F23 Phase 1**: PR #21 (d366ad5) — 5 WT 全部合入 main。87 files → 7 子目录 + ~690 imports 迁移 + 5 大文件拆分。防腐化门禁 pnpm check:dir-size + pnpm check:deps。Biome v2.4 + LSP + JetBrains MCP 全部启用。routes 目录有 .dir-exceptions.json 例外到 2026-04-01。ADR: 010-directory-hygiene-anti-rot.md

## Phase 2 Follow-up（dir-size baseline carry-over）

5 个目录在 F23 Phase 1 之后超出 25 文件阈值，已经经历两轮"sync 前临时 unblock"续期（首轮 a4e81b8791 + 4136847b10 → 2026-06-01；本次 → 2026-06-30）。再续期 = 「下次一定」病。Phase 2 必须在 2026-06-30 前完成实拆，否则 dir-size guard 在下一次 outbound sync 上将硬阻塞，且 reviewer 应拒绝再续期。

**Timeline**：从今天 (2026-06-01) 到 2026-06-30 = **29 天**，tight 但 deliberate — 强制每周一个目录的节奏，避免再次拖延。如果 29 天不够，必须在 2026-06-15 中间 check-in 升级 @co-creator 评估是否需要顺延（默认拒绝）。

### 第三轮 unblock 硬门禁（new gate, this PR commits）
如果 2026-06-30 后仍需要任何 `F23-followup` ticket 的续期，**禁止 cross-cat review-only 通过**，必须满足以下其一：
- (a) **CVO 显式 signoff**：@co-creator 明确在 PR comment 同意第三轮 unblock
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
