---
feature_ids: [F251]
related_features: [F059, F116, F168, F238]
topics: [open-source, outbound-sync, provenance, community, harness]
doc_kind: spec
created: 2026-06-25
tips_exempt: 内部 sync 管道硬门禁，对用户透明无可见动作面
---

# F251: Public Target Delta Preservation Gate

> **Status**: in-progress | **Owner**: Maine Coon(Maine Coon) + Ragdoll(Ragdoll) | **Priority**: P1

## Why

> operator experience（2026-06-25 14:29 UTC）："我们家经常 intake 回来 pr 然后全量同步出去之后改坏别人的功能 不下十次了。这个其实很难知道是因为 intake 回家出现的问题把人家丢了还是后续哪里演进的时候出现的问题。"

clowder-ai 不是 cat-cafe 的 git fork，也不是简单镜像；它是有 1.8k stars、社区 PR、独立用户的公开发布仓。当前 `sync-to-opensource.sh` 用 `rsync -a --delete`（line 521）做 outbound sync，工具层是无脑覆盖——一旦 clowder-ai 在上次同步后产生 delta（社区 PR、maintainer quickfix、bot），rsync 会静默抹回去。SOP 层的 Community Diff Guard（`refs/opensource-ops-outbound-sync.md` Step 1.5）是 V1 手动 + 依赖 ledger 真实性 + 视野只覆盖 social-PR-centric 类，盲区一大堆。

教科书证据：clowder-ai#723（mindfn / 吴浪审计）→ 2026-05-19 zts212653 说 "All 17 visual normalization items shipped via sync PR #726" → 2026-05-20 mindfn 复查发现 "#726 同步后核心视觉问题全部仍在"——sync 把家里 17 项修复又抹回去了。

## What

### Scope Boundary

Phase A 只挡 **C1/C2 类 public target delta preservation**：clowder-ai 在上次 sync 后已经有目标侧 delta，而本次 export 会把它删掉、回退或冲突。它不挡 **C3 家里演进回归**：cat-cafe 自己把共享行为改坏后同步出去、且 clowder-ai 目标侧没有独立 delta 的情况。C3 需要 **Phase B Public Behavior Change Reporter**（diff scan + 强制 human Migration Notes；2026-06-28 KD-11 修订替代了原 Community Contract Registry 方案）、dogfood、社区反馈和 hotfix 兜底。Task 1 的 synthetic fixtures 只证明 classifier 边界；在 AC-A5 历史事故 replay fixture BLOCK 住真实 #720/#726 类事故前，V1 不能宣称 anti-placebo 成立。

> **Ledger enum legacy alias**：`docs/ops/community-sync-incident-ledger.json` 现有条目里的 `gateCoverage: "requires_contract_registry"` 是 **legacy alias for `requires_public_behavior_awareness`**（KD-11 改名），新条目和 Task 5/6 实施时同步迁移；旧条目保留 alias 不强制 backfill。

**C4 sibling — sync exclude rule misses runtime asset**（2026-06-25 Ragdoll发现并修复）：另一类 outbound sync 漏水不属于 Phase A scope 但症状相邻——`sync-to-opensource.sh` 用 `--exclude='docs/'` 一刀切再用一组 include 通道（decisions allowlist / features 结构化导出 / SOP / BACKLOG 等）放行。如果 `packages/api/src` 在运行时 readFileSync 一个 docs/* 文件，但**没有任何通道覆盖**，target 永远撞 404；三方树（base/theirs/ours）都没有这个文件，Phase A gate 检测不到 delta（无可保护的差异）。事故来源：`clowder-ai#1025` —— `docs/services-offline-install.html` 被 cat-cafe `packages/api/src/routes/services.ts:98` readFile + `InstallPreviewModal.tsx:486` 链接，但 sync 通道一直没覆盖它。修复 = reverse-check guard `scripts/check-sync-docs-runtime-assets.mjs`（扫 runtime references → 对照 sync coverage → 报告孤儿，进 `pnpm check`）+ 新 manifest key `docs_runtime_assets_allowlist` + sync 脚本对应 copy loop（mirror `docs_decisions_allowlist` 模式）。这是 F251 sibling sub-task（同主题 outbound sync harness 治理），不占 Phase 编号、不抢 Phase A/B 注意力。

### Phase A: Public Target Delta Preservation Gate (V1)

在 public byte-space 做三方树对比：`base` = 上次成功 sync 落到 clowder-ai 的 commit（来自 `sync/*` tag 或 first-parent 解析），`theirs` = clowder-ai 当前 HEAD，`ours` = cat-cafe 本次 export 后的 public tree。逐 path 判定，target-only delta 在 ours 里消失/回退 = BLOCK；双边冲突 = BLOCK；binary/delete/rename = BLOCK；override 需写 reason 入 provenance，单次 sync override > 3 触发 operator approval alarm。

### Phase B: Public Behavior Change Reporter (v0 修订版)

> **2026-06-28 spec 修订（operator push back + 三猫收敛 KD-11）**：原方案 Community Contract Registry（contract = byte 锁住公开行为，sync 前 replay test 不过 BLOCK）经审视会长成"为了不破 contract 写 adapter / fallback / compat layer"的胶水温床。3 猫独立思辨（Bengal路径 C+ / Maine Coon B-/C+ / 47 路径 B）收敛到同一判据：**锁行为 = 胶水温床；问题是"行为变了但没人知道"，解药是 awareness 不是 lock。** 锁是关，灯是亮——我们要灯不要锁。

3-way gate 看不见 "家里改家里回归"（clowder-ai 那边没动）。补一层 **Public Behavior Change Reporter** + 可选 **Behavior Watchlist 聚光灯**。

**核心：Behavior Impact Reporter**
- Sync 时自动 scan diff 的 5 个维度：API endpoint（增删 + response shape）、`.env.example` config key、CLI flag、`@cat-cafe/shared` public type/interface、Next.js page route
- 自动生成结构化 report 塞进 sync PR body（脚本不靠猫记忆）
- **Sync 执行者必须在 report 下面写一段 human summary**：哪些是 breaking、迁移指南
- **唯一 hard gate**：缺 human summary → BLOCK sync
- 没有 contract test runner，没有 schema 维护，没有 byte 锁

**补丁：Public Behavior Watchlist（聚光灯，非 contract）**
- 纯文档 list，**V0 seed ≤ 3 条，absolute cap ≤ 5 条**，记 "猫认为值得长期守望的公开行为"（比如某高频 API 的 response shape）
- Reporter 扫到 watchlist 触及的 path → report 里高亮 emphasis，提醒 author 多写一句迁移
- **不跑测试，不锁 byte，只 highlight** — 跟 contract 本质区别
- 新增条目需 operator 签字（防 watchlist 无限增长重新长成 contract）

**铁律（KD-12）**
- ✅ 改公开行为 OK — 必须显式声明 breaking + 给迁移
- ❌ 禁止为了 "不破 watchlist 行为" 写 adapter / fallback / compat layer — 破就破，明说
- ❌ Reporter scan 维度 / Watchlist 条目都需要 operator 签字加，防退化成 contract

**Reporter 不是银弹**——只挡"diff 能 detect 出的公开行为变化"。盲区（语义变化但签名不变的 silent breaking）靠 dogfood + 社区反馈 + hotfix 兜底。

### Phase C: V1.5+ 演进（不强制 V1 完成）

V1.5 path ownership（sync-managed / target-owned / mixed） → V2 hunk-level conflict → V3 半自动 resolve queue。non-blocking。

## User Journey

**Scope unit**: outbound sync operator (cat-cafe maintainer猫 running `bash scripts/sync-to-opensource.sh`).

**Flow** (Phase A + B integrated, post Task 5b):

1. **Operator runs sync**: `pnpm sync:opensource` (or the underlying bash script directly).
2. **Pre-sync gates fire automatically** (no operator action needed):
   - Layer 1 — Public Delta Preservation Gate (byte-space, F251 Phase A) checks for target-only deltas about to be overwritten. BLOCK → operator picks an escape (`--override <path>:<reason>` or `--skip-delta-gate` with operator signoff) or fixes the source delta and retries.
   - Layer 2 — Public Behavior Change Reporter (semantic, F251 Phase B) scans diff against V0 dimensions + Public Behavior Watchlist. Generates JSON + Markdown reports under `docs/ops/`.
3. **Operator-facing prompt** if Layer 2 finds changes:
   - Reporter exits non-zero with explicit instructions: provide `--migration-notes-file <path>` or `--migration-notes <text>` (mutually exclusive).
   - Operator writes a 2–10 line human-readable notes block explaining breaking changes + migration steps.
   - Retry: `bash scripts/sync-to-opensource.sh --migration-notes-file migration-notes.md`.
4. **Operator-facing escape hatch**: when migration is intentionally undocumented (operator-approved rollback / experimental sync), `--skip-public-behavior-gate` opts out, but the operator MUST paste a operator signoff line into the sync PR body (KD-12 fence — bans growing adapter / fallback / compat layer around either escape hatch).
5. **Reporter Markdown** doubles as a PR-body snippet: operator pastes it into the sync PR description, which surfaces the change set + Migration Notes to clowder-ai community maintainers reviewing the sync.
6. **Audit trail**: synced `.sync-provenance.json` gains `publicBehaviorReporter` + `publicDeltaGate` blocks (eval loop ingests these to track C1/C2/C3 incident class trends over time).

**Vision link**: stops the silent-overwrite class of community-breaking incidents (10+ recorded in `docs/ops/community-sync-incident-ledger.json`) without growing a contract registry / glue-code temptation surface.

## Acceptance Criteria

### Phase A（Public Delta Gate V1）

- [x] AC-A1: Full sync fails before touching the real `clowder-ai` target when any sync-managed path has an unpreserved target delta. — wired in Task 4a (PR #2591 squash `c8b99a708`); production gate runs after Step 5b validation, before Step 5c `sync_filtered_into_target`, fail-closes with `exit 1`.
- [x] AC-A2: Gate runs in public byte-space after export/sanitization, before `sync_filtered_into_target`. — Task 4a uses pristine `$FILTERED_DIR` (post-export, pre-rsync) so target byte-space matches what would land on clowder-ai.
- [x] AC-A3: Gate emits machine-readable JSON + human-readable Markdown reports with per-path classification. — Task 3 report writer + Task 4a writes both artifacts to `$SOURCE_DIR/docs/ops/` (dry-run uses `mktemp -d` to avoid pollution).
- [x] AC-A4: Override requires explicit reason, written to provenance; > 3 overrides per sync triggers operator approval alarm. — Task 4c wires per-path `--override <path>:<reason>` (repeatable, empty reason → exit 2 usage error). Classifier converts BLOCK at matched paths to `override-pass` mode with reason recorded in `report.items[].overrideReason`; `report.summary.overrideCount` is the audit metric. > 3 overrides flips `cvoApprovalRequired=true` and CLI exits 1 unless `--cvo-approved-public-delta-overwrite` is set (report still records the alarm for audit). Bash forwards both flags to all 3 gate sites (validate / dry-run / production).
- [x] AC-A5: 至少一个高置信历史事故（clowder-ai#723 audit of #720 sync 覆盖 F190 17 项视觉）reconstructed 成 dry-run fixture，V1 gate 必须 BLOCK 才算通过（anti-placebo）。 — Task 4b (PR #2601 squash `d865b4472`) frozen 3-way byte-state fixture from real `89cc0f220` squash commit at `scripts/_fixtures/f251-replay-clowder-ai-720/`. Replay test asserts `result.status === 1` + `blockCount >= 20` + 3 P1 paths (AppShell/ChatContainer/HubListModal) match `mode=/block$/`. Wired into `pnpm check` via `check:sync-public-delta-gate` (KD-10). **Anti-placebo gate sealed.**
- [ ] AC-A6: V1 部署 1 个月后跑 retroactive dry-run eval；C1a/C1b 历史事故必须 BLOCK，漏挡则重开 gate design。 — pending: helper `scripts/check-f251-v1-eval.mjs` ready (mechanical counter + replay-candidate surface anchored to 2026-06-28 Phase B merge; lists `c1aReplayPending` / `c1bReplayPending` ids that still need dry-run verification against V1 gate, NOT a binary "post-window count = 0 → success" metric — that's the over-claimMaine Coon caught at PR #2642 R0). Scheduled task to wake 猫 doing the eval is **pending registration after merge** (operator preview pending). 猫 doing eval must: (1) dry-run replay every `c1aReplayPending` / `c1bReplayPending` against the V1 gate via `scripts/check-sync-public-delta-gate-cli.mjs`, confirm exit 1; (2) sample 30-day sync PR body Migration Notes sections + `.sync-provenance.json.publicBehaviorReporter.migrationNotesLength` distribution for C3 awareness signal. **C3 verdict semantics**: per opus-48 愿景守护 retract — C3 is "managed not eliminated" (Phase B awareness only); counter is not verdict.

### Phase B（Public Behavior Change Reporter v0）

- [x] AC-B1: `scripts/check-public-behavior-impact.mjs` 实施 — V0 3 维度 (env-config-key / nextjs-route / api-endpoint) + watchlist-direct as 4th detector dimension. Files: scanner CLI (282) / detectors module (102) / output (101) / fixtures (76). JSON + Markdown report. Both refs (--source-dir/--base-ref/--head-ref) and sync (--target-dir/--filtered-dir) modes. V0.1 dims (cli-flag / public-type) deferred — non-blocking. Merged via PR #2591 (Task 5a, squash `81e1a2680`) + PR #2636 (Task 5b, squash `120092878`).
- [x] AC-B2: **Pre-sync 前置输入机制** — `sync-to-opensource.sh` 实施 `--migration-notes-file <path>` / `--migration-notes <text>` (mutually exclusive, both equals + split forms with §16e guards + trailing-drop guards) + `--allow-empty-notes <reason>` operator escape + `--skip-public-behavior-gate` total-skip escape. Gate site sits BETWEEN byte-space delta gate AND production `sync_filtered_into_target $TARGET_DIR` rsync. BLOCK if `changeCount > 0 && migrationNotes empty && !allowEmptyNotes`. Empty-reason rejected (`fail(2) --allow-empty-notes requires a non-empty <reason>`). Telemetry helper `scripts/append-sync-provenance-telemetry.mjs` writes `publicBehaviorReporter` + `publicDeltaGate` blocks into `.sync-provenance.json` (basename-only paths to avoid leaking operator-machine paths to public clowder-ai; `allowEmptyNotesReason` propagated for public audit accountability). Merged via PR #2636 (squash `120092878`).
- [x] AC-B3: `docs/ops/public-behavior-watchlist.md` V0 seed 3/5 entries (api-startup-not-blocked-by-embedding-backlog / broadcast-message-delivery / provider-capability-dispatch). Hard cap `WATCHLIST_HARD_CAP = 5` enforced in `loadWatchlist()` — > 5 entries throws with explicit `hard cap of 5 (KD-12 fence)` error. Reporter emits `dimension: 'watchlist'` for watchlist-only paths (not just emphasis annotation) so changeCount counts watchlist touches → Migration Notes BLOCK gate covers them. Dedup precedence: existing detector dimensions (env/nextjs/api) win, watchlist annotation rides as `watchlistMatch` on the more specific change. KD-12 铁律 — entries 4-5 need operator PR-body signoff, 6th = refused. Merged via PR #2636 (squash `120092878`).

## Tips Contribution（F244）

- [ ] Tips 暂无（F251 是 sync 管道内部 harness，对最终用户透明）；tips_exempt 见下方。
- tips_exempt: 内部 sync 管道硬门禁，对用户透明无可见动作面。

## Dependencies

- **Related**: F059（Cat Café 开源计划 umbrella，done）、F116（开源运营 skill）、F168（社区运营看板）、F238（双向边界对称 / brand-dictionary）

## Risk

| 风险 | 缓解 |
|------|------|
| Override 变成绕过 gate 的逃生门 | override count > 3 触发 operator approval alarm（INV-3）+ override 全部写入 provenance 可审计 |
| Baseline 解析失败导致 fail-open | INV: missing baseline → fail-closed（不允许 fall back 到无 base 模式） |
| Task 1 unit fixtures 被误读成历史 replay fixture | Scope Boundary 明确区分 synthetic classifier fixtures 与 AC-A5 历史事故 replay；AC-A5 未通过前不宣称真实事故可挡 |
| Task 2 baseline resolver 选错 base，导致 classifier 正确但 gate 语义错 | KD-2/INV-1 钉死 baseline 来源；Task 2 必须验证 `sync/*` tag / landed sync commit 优先，不用 `target_head_sha` |
| 历史回归 fixture 不能 catch 真实事故 = 安慰剂 gate | AC-A5 强制至少一个历史 dry-run replay 通过；云端Maine Coon Pro failure-mode audit 双保险 |
| ~~Contract Registry 被当银弹用~~ (legacy risk — 原方案已被 KD-11 否决，留 audit) | ~~spec 明示边界~~ — 见 KD-11 全废；现 Phase B 是 Reporter，无 Registry 银弹问题 |
| **Phase B Reporter 退化成 contract（维度/watchlist 无限增长 = 重新长锁）** | Scan 维度 / watchlist 条目都需 operator 签字加；KD-12 禁止 adapter/fallback 胶水从源头掐死锁的实现路径 |
| **Phase B Watchlist 长成软 contract（猫为了"不触发高亮"开始绕开真改动）** | 高亮 ≠ block；watchlist 触及只是多写一句迁移说明，不影响 sync 通过；定期 review 删低频条目 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | V1 不替换 `rsync --delete`，只在 sync 前加 preservation gate | 减小爆炸面；rsync 已有验证路径不破坏 | 2026-06-25 |
| KD-2 | base 用 `sync/*` tag / landed sync commit，不用 `.sync-provenance.json.target_head_sha` | target_head_sha 是 pre-sync parent，下次 gate 用它会把上次 sync 本身误判成 target delta | 2026-06-25 |
| KD-3 | Override count > 3 触发 operator approval alarm | 防 override 变绕过逃生门（同样命运 SOP V1 手动 Guard） | 2026-06-25（Ragdoll边界补充） |
| KD-4 | gateCoverage 多选标签，C1 拆 C1a/C1b | 一个事故可同时 covered_by_v1 + needs_contract_registry；maintainer self-quickfix 严重程度不同于社区被改坏等家修 | 2026-06-25（Ragdoll边界补充） |
| KD-5 | AC-A5 Historical Regression Replay 必须通过才算 V1 验收 | 不能在 dry-run 标出真实事故 = 安慰剂 gate | 2026-06-25（云端Maine Coon Pro review）✓ satisfied by Task 4b (2026-06-27) |
| KD-6 | AC-A6 one-month anti-placebo eval | V1 不能只在 forward fixtures 里绿；retroactive C1a/C1b 漏挡必须回头改 gate | 2026-06-25（云端Maine Coon Pro review） |
| KD-7 | Report contract uses `version: 1` plus `reportKind`, repo constants, `syncModule`, nested resolver `baseline`, and `exportedHead` | Task 4 needs one report schema truth source; nested baseline preserves Task 2 resolver diagnostics, and exportedHead records the actual candidate public byte-space tree | 2026-06-26（Task 3 review） |
| KD-8 | Task 4b uses frozen 3-way byte-state fixture committed to `scripts/_fixtures/`, NOT live clowder-ai fetch | CI must be hermetic + deterministic; live fetch would couple test pass to clowder-ai branch state; frozen fixture documented with provenance + extraction script for re-generation | 2026-06-26（Task 4b spec） |
| KD-9 | Task 4b targets `clowder-ai#723` evidence (squash commit `89cc0f220`), not `#720` directly | `#720` is the bad sync PR; `#723` is mindfn's audit that *documents* the regression. The byte evidence lives in `#723.evidence.affectedPaths` + extracted from `89cc0f220^1` (theirs = clowder-ai main pre-sync) vs `89cc0f220` itself (ours = post-bad-sync state — the squash commit IS the synced bytes; no `^2` exists because squash is single-parent) | 2026-06-26（Task 4b spec, corrected by Task 4b R0 cross-review Maine Coon P1） |
| KD-10 | AC-A5 replay test is wired into `pnpm check` via `check:sync-public-delta-gate` script that runs all 4 delta-gate test files (classifier + cli + wire + replay) | Without persistent harness wiring, AC-A5 silently rots after merge — replay test only protects until next commit. Plan Step 3 "wired as required test" demands this | 2026-06-26（Task 4b R0 cross-review Maine Coon P1） |
| KD-11 | Phase B 否决原 Community Contract Registry 方案；改成 Public Behavior Change Reporter + Watchlist（聚光灯非锁）| operator push back："锁行为 = 胶水温床"。三猫独立思辨（Bengal C+ Reporter / Maine Coon B- minus / 47 路径 B）收敛同一判据：问题是"行为变了但没人知道"，解药是 awareness 不是 lock；锁导致 adapter/fallback 胶水堆积。Contract test runner / byte 锁全删，换成 diff scan + human summary BLOCK + ≤5 条 watchlist 高亮 | 2026-06-28（operator + 三猫收敛） |
| KD-12 | 铁律：禁止为了 "不破公开行为" 写 adapter / fallback / compat layer | 破公开行为 OK，必须 explicit breaking + 迁移说明；写胶水 = 把"我们家变烂"换"客人不痛"，长期债务。Reporter 维度增加 + Watchlist 新增条目都需 operator 签字，防退化成 contract | 2026-06-28（operator experience："这玩意你们要是做的过度了我就担心为了兼容搞出一堆烂代码 胶水"）|
| KD-13 | Task 5b（Phase B 收尾）必须 SINGLE PR — 不再拆 5b/5c | operator push back: "我在想宝贝你是不是把pr 拆的太碎了？总觉得你这个干了好多天还没完成？...有的其实可以一把做完的没必要这么碎"。Task 5a/5b 拆开是反例：scanner library 单 ship 之后用不上（要 bash wire 才能触发），review chain 反复 cycle 反而总成本更高。原 Task 6 (SOP soft layer + eval loop telemetry) 合并进 Task 5b PR 范围。任何"先 ship bash wire, 再 ship watchlist + SOP"的提议直接 ignore | 2026-06-28（operator experience）|

## Review Gate

- Phase A: Maine Coon (gpt-5.5) 写实施 + Ragdoll (Opus 4.7) cross review + 云端Maine Coon Pro failure-mode audit
- Phase B: Public Behavior Change Reporter + Watchlist 需独立 design review（不与 Phase A 同行；KD-11 已替代原 Contract Registry 设计）
