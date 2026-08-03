---
feature_ids: [F286]
related_features: [F043, F128, F150, F223, F242, F249]
topics: [mcp, tool-surface, resource-lifecycle, governance, prompt-footprint]
doc_kind: spec
created: 2026-08-01
description: "Govern the Clowder AI MCP surface as typed resource lifecycles with explicit safety, exposure, atomic cutover, and sunset boundaries."
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-01T10:03:45Z
---

# F286: MCP Surface Lifecycle Governance

> **Status**: spec | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **Gate**: Architecture Design Gate accepted by operator (`0001785600399637-001062-9b03f289`). Phase B planning and one separately tested/reviewed reversible pilot are authorized; no candidate migration is authorized without its own plan and gates.

## Why

When a resource gains a new lifecycle transition, Clowder AI currently tends to add another top-level MCP verb. The result is not only more names: every invocation pays cognitive-selection and description cost, while callers must reconstruct state machines from tools. operator named the desired value directly: “每次发现对某个功能的更多需求的时候不是新建更多工具，而是想办法变成一个工具有完整的生命周期……对全部的 mcp 给盘点一下” (source message `0001785577191931-000034-b7ee3bf9`).

The goal is therefore **the fewest top-level decisions inside each real authority and safety boundary**, not “one resource must always have one universal tool.”

## Current State / 现状基线

At `origin/main` `0883b4001f9ebfc07adfedd680a4d1b3ce357733`:

- The registration contract contains 124 semantic tools: collab 77, memory 21, signals 12, limb 5, audio 8, finance 1.
- Their descriptions total 69,670 characters / about 14,713 `cl100k_base` tokens across the full definition set; only runtimes/profiles that eagerly expose every schema carry that full footprint.
- Existing annotations classify 46 read, 68 write, and 10 destructive tools.
- This invocation exposes 134 Clowder AI entries, but normalization yields the same 124 semantics; ten are duplicate local-MCP/connector projections.
- F150 records 59,891 MCP calls from 2026-04-04 through the census snapshot, but its API exposes only top-20 views. The union gives lower-bound evidence for 33 semantic names and cannot prove the other 91 have zero use.
- The 124-row census covers Clowder AI-owned MCP server semantics. Clowder AI-managed external GitHub MCP catalog/runtime provisioning is outside that count and has a later explicit operator disposition: sunset it, use `gh` as the canonical local GitHub execution path, and do not preserve or re-seed it as an alias or lazy surface (source message `0001785582326176-000162-c2769c73`).
- ADR-037 governs cognitive entry points, F043 owns server split, F223 owns capability discoverability/execution/verification, and F242 owns the convention-graph extractor. None defines a top-level tool admission gate or resource-lifecycle migration policy.

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “对全部的 MCP 盘点一下” | AC-A1 | registration parity + 124-row census | [x] |
| R2 | 新需求默认进入已有资源生命周期，不再一动作一工具 | AC-A2, AC-B1 | ADR clauses + manifest/guard RED→GREEN | [ ] |
| R3 | 分类真实语义、runtime alias、drill-down chain 与安全边界 | AC-A1, AC-A3 | census + reviewer spot-check | [x] |
| R4 | 给出 keep / consolidate / lazy-discover / sunset 候选 | AC-A2 | candidate roll-up + usage provenance | [x] |
| R5 | 一个完整 resource family 原子切换，禁止 legacy/canonical MCP 双暴露 | AC-B3, AC-C1, AC-C3 | cutover manifest + no-overlap/stale-reference guard + exact rollback | [ ] |
| R6 | 架构级 Design Gate 先于代码 | AC-A4, AC-A5 | operator source message + signed gate | [x] |
| R7 | External GitHub MCP 从家里 sunset，canonical GitHub 路径为 `gh` | AC-A6 | direct operator source + scoped census/ADR exception | [x] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有非作者可复核证据。
- [x] No direct frontend requirement; no screenshot mapping required.

## What

### Phase A: Census + Architecture Design Gate

- Freeze runtime/schema changes while enumerating all 124 semantics and runtime projections.
- Classify by server family, resource family, lifecycle operation, risk, exposure profile, description footprint, static integration, and rank-censored runtime usage.
- Publish ADR-044 and a operator Decision Packet, then record the signed decision and constraints.
- Obtain one non-author governance/content review before asking operator to sign.

### Phase B: Declarative Admission Contract

- Define one canonical machine-readable registry derived from tool definitions, not a second hand-maintained list.
- Every top-level tool declares resource family, lifecycle operation, authority, risk class, exposure tier, standalone reason, cutover state, and owner.
- Add a mechanical guard: a new top-level name for an existing resource fails unless the registry records an accepted standalone boundary.
- Report per-resource action-count deltas even when the top-level tool count is unchanged, so action unions cannot grow invisibly around the admission guard.
- Keep ADR-037 cognitive-entry validation as an orthogonal check.

### Phase C: Atomic Resource-Family Pilot

- Pilot one complete resource family or tightly coupled group selected after fresh consumer analysis proves it can cut over atomically.
- Introduce typed resource actions without `any` payloads or a global catch-all manager.
- Require canonical responses to expose server-derived current state/version and allowed next actions where relevant; name-count reduction without this affordance does not pass the pilot.
- Build and validate the new surface off-registry; do not advertise it beside the legacy tools.
- Cut over MCP registration/schema/descriptions, runtime catalogs/profiles/provisioning, L0 prompts, skills/conventions, deterministic fixtures, and any relevant eval/observability consumer in one reviewed release.
- Remove the replaced tool names and every stale hard/soft reference in that same release; rollback means reverting or redeploying the previous exact release, not retaining two surfaces.
- If all named consumers and layers cannot move together, defer that family instead of introducing a second surface.
- Clowder AI-managed external GitHub MCP must not survive as a second tool, lazy-discovery entry, or provisioning fallback.
- Preserve explicit destructive, authority, cross-thread, wait/custody, and progressive-disclosure boundaries.

### Phase D: Exposure Budget + Evidence-Gated Sunset

- Make optional families lazy-discoverable by runtime/profile instead of eagerly injecting every schema.
- Remove duplicate connector/local projections atomically once transport parity is proven; do not leave both projections exposed.
- Use F150 call evidence plus task-outcome/selection fixtures to keep, tune, revert, or sunset each migration.
- Treat the 57 consolidation candidates as hypotheses rather than a delivery queue; if the bounded pilot does not prove material utility, stopping after admission control and proven projection deduplication is a valid F286 outcome.
- No semantic deletion occurs from top-20 absence alone.
- Treat `gh` as the canonical local GitHub execution path and the Clowder AI-managed external GitHub MCP catalog/runtime surface as an explicit sunset outside the 124 semantic rows; its code/config removal remains owned by the source thread.

## User Journey

`user_journey_exempt: F286 is internal agent-surface governance. Phase A changes documentation and admission policy only; it adds no direct end-user UI or workflow.`

## Architecture Ownership

Architecture cell: `mcp-surface-governance`

Map delta: `new cell recorded by this Design Gate`

Why: existing cells own capability execution (`hub-action-surface`), plugin resource activation (`plugin`), and convention extraction (`code-intelligence`), but none owns top-level MCP identity, exposure tiers, cross-layer atomic cutover, or surface admission.

## Mechanism Selection

| Claim | Selected mechanism | Evidence / consumer |
|---|---|---|
| A new top-level verb must justify an independent boundary | test/guard | manifest diff + admission checker; merge gate consumes failure |
| Tool descriptions and profiles remain within declared budgets | test/guard | deterministic token/profile census |
| Runtime registration and lazy loading remain healthy | observability | F153 logs/metrics for list-tools latency, registration failures, and schema load |
| Consolidation/lazy discovery improves selection and does not hurt task success | eval | F286 owner + operator consume pilot verdict to keep/tune/sunset |
| Cats remember resource-first design when proposing tools | convention/ADR | ADR-044 + relevant development skill/reference |

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal

- **Users**: cats selecting MCP tools; maintainers adding or changing a tool; operator receiving the Design Gate verdict.
- **Activation**: an implementation pilot atomically replaces or lazy-loads one complete lifecycle family, with no runtime/profile exposing both the old and canonical MCP surfaces.

### 2. Friction Metric

- Wrong-tool / invalid-transition rate on named lifecycle fixtures.
- Task success and repair-turn count versus the pre-cutover baseline.
- Eager schema count and estimated description tokens by runtime profile.
- Post-cutover unknown-tool/stale-name attempts by caller/runtime, used as rollback evidence rather than justification for dual exposure.

### 3. Regression Fixture

- A task lifecycle: list/create/update select the correct typed action and preserve owner checks.
- A proposal lifecycle: requester withdraw stays separate from human approve/reject authority.
- A destructive resource action: read/list never inherits destructive classification from internal-archive/forget/delete.
- A drill-down flow: evidence entry points and limb list→inspect→invoke remain independently discoverable.
- A connector/local caller receives schema-, auth-, output-, and error-parity through one semantic identity, and no runtime/profile exposes the retired projection.
- The cutover manifest proves MCP code/schema/descriptions, provisioning/catalogs, L0/skills, deterministic fixtures, and relevant eval/observability assets move together.

### 4. Sunset Signal

- Revert the exact cutover release if task success regresses, wrong-transition repairs rise materially, stale-name attempts reveal a missed named consumer, or a required runtime cannot discover the capability.
- A family cuts over only after the pre-cutover consumer inventory, cross-layer manifest, parity fixtures, rollback proof, and owning gate accept the exact old/new set.
- A direct per-surface operator removal decision still requires exact removal-scope verification, but it must not be diluted into “keep a second surface.”
- Keep independent boundaries if consolidation makes a read surface inherit destructive/open-world authority or creates a schema mode matrix.

## Acceptance Criteria

### Phase A（Census + Design Gate）

- [x] AC-A1: The census contains exactly the 124 registered semantics, family counts match the registration test, all risk annotations are classified, and the ten runtime projection aliases are named.
- [x] AC-A2: Every semantic row has resource family, lifecycle, risk, current profiles, description tokens, usage evidence, semantic candidate, and exposure candidate.
- [x] AC-A3: Opus 4.7 independently verified the 124-row parity, candidate boundaries, token method, and “top20-unseen ≠ zero” provenance at PR #3348 HEAD `f68e63081c6f390c303dcd808f0ecb67b56bd71e` (verdict message `0001785580054679-000088-354c1a04`).
- [x] AC-A4: Accepted ADR-044 defines admission, resource lifecycle, exceptions, atomic cutover, exposure, and mechanical guard principles without changing runtime code.
- [x] AC-A5: operator accepts the Architecture Design Gate and authorizes separately planned/tested/reviewed work on one exit-bounded pilot, with no dual exposed MCP surface (`0001785600399637-001062-9b03f289`).
- [x] AC-A6: The census and ADR classify Clowder AI-managed external GitHub MCP as a operator-directed sunset outside the 124 Clowder AI-owned semantics, name `gh` as canonical, and forbid second-surface/lazy re-seeding; implementation stays in its owning thread. GPT-5.4 independently approved this scoped governance delta at PR #3348 HEAD `4c030bf3907e67fa5d80814afedad82582cf39f2` (verdict message `0001785583285282-000297-97aeadd1`; no P1/P2 findings).

### Phase B（Admission Contract）

- [ ] AC-B1: A canonical derived registry requires `resourceFamily`, `operation`, `authority`, `risk`, `exposureTier`, `standaloneReason`, `cutoverState`, and owner for every semantic tool.
- [ ] AC-B2: RED→GREEN guard proves an unjustified verb for an existing resource fails and a documented independent boundary passes.
- [ ] AC-B3: Registration, profile filtering, description budget, per-resource action-count deltas, exact cutover sets, no-overlap, and stale-reference absence are machine-checked from one source.

### Phase C（Pilot Migration）

- [ ] AC-C1: One approved complete resource family or tightly coupled group cuts over atomically with schema/auth/output/error parity; no runtime/profile exposes both old and canonical MCP surfaces.
- [ ] AC-C2: Destructive, authority, wait/custody, cross-thread, and progressive-disclosure fixtures remain explicit and pass.
- [ ] AC-C3: Pre-cutover F150/consumer evidence and post-cutover task-outcome/stale-name evidence produce a keep/revert verdict; rollback restores the previous exact release rather than a concurrent legacy surface.
- [ ] AC-C4: Canonical pilot responses expose server-derived current state/version and allowed next actions where relevant; reducing top-level names without that affordance fails the pilot.

### Phase D（Exposure + Sunset）

- [ ] AC-D1: Optional families can be lazy-discovered without breaking the required `ro`, `agent-key`, and `desktop` profiles.
- [ ] AC-D2: Connector/local duplicate projections cut over atomically to one semantic identity with parity and no-overlap evidence.
- [ ] AC-D3: Any semantic or projection retirement records exact consumers, cross-layer cutover scope, rollback, stale-reference absence, and required sign-off.

## Dependencies

- **Evolved from**: F043 (server split exposed prompt-footprint pressure without lifecycle governance).
- **Related**: F128 (requester-withdraw is the motivating resource-lifecycle example).
- **Related**: F150 (usage evidence; current API is top-20 rank-censored).
- **Related**: F223 (capability surface and execution/discovery decision ladder).
- **Related**: F242 (mechanical convention graph can locate consumers; it does not own policy).
- **Related**: F249 (external MCP configuration/provisioning is an affected implementation boundary; its owner thread performs removal).
- **Related decision**: ADR-029 (when MCP is the right exposure surface), ADR-037 (cognitive entry point), ADR-044 (this governance contract).

## Risk

| 风险 | 缓解 |
|------|------|
| One giant manager hides types and authority behind modes | Per-resource typed action unions; no global manager or `any` payload |
| Read actions inherit destructive classification | Keep destructive transitions separate or behind an equally explicit confirmation boundary |
| Lazy discovery makes capabilities disappear | Stable family catalog, runtime/profile parity fixtures, and revertable pilot |
| Migration recreates full/split dual surfaces | Guard requires one atomic family cutover and rejects old/new overlap across runtime profiles, catalogs, prompts, skills, and fixtures |
| Top-level growth moves invisibly into oversized action unions | Report per-resource action-count deltas and re-apply the mode-matrix/standalone-boundary gate |
| Low-ranked usage is mistaken for zero | F150 top-20 caveat is a hard provenance field; absence alone cannot authorize deletion |
| Registry becomes a second stale list | Derive it from canonical tool definitions and fail registration drift mechanically |
| A removed surface is resurrected by another layer | Cross-layer absence guard covers registration, lazy discovery, catalogs/provisioning, L0/skills, deterministic fixtures, and declared eval consumers |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Allocate F286 instead of reopening F043/F223 | Server split and capability discovery are adjacent but distinct ownership problems | 2026-08-01 |
| KD-2 | Optimize top-level decisions inside safety boundaries, not raw tool count | A single destructive/open-world mode matrix can be worse than several explicit tools | 2026-08-01 |
| KD-3 | Census usage is rank-censored and non-deleting | F150 returns top 20 per view; unseen is not zero | 2026-08-01 |
| KD-4 | Phase A is docs/census only | operator asked for census + architecture gate before code | 2026-08-01 |
| KD-5 | External GitHub MCP is a directed sunset outside the 124-row census; `gh` is canonical | Later direct operator removal decision overrides generic retention for that surface | 2026-08-01 |
| KD-6 | The 57 consolidation candidates are hypotheses, not a migration queue | Admission control has definite forward value; each existing-family migration must prove utility, and admission-only is a valid terminal state | 2026-08-01 |
| KD-7 | Migration unit is one complete resource family or tightly coupled group, with no dual exposed surface | F043/F195 full-versus-split drift proved that parallel topologies duplicate schema/prompt cost and allow registry coverage to diverge | 2026-08-01 |

## Review Gate

- Phase A: census/reviews complete and operator Architecture Design Gate accepted; the post-review atomic-cutover amendment requires exact-HEAD governance review before merge.
- Later phases: risk is MCP contract + auth/destructive boundary; implementation review depth is selected from the actual pilot diff.

## Tips Contribution（F244）

`tips_exempt: F286 changes internal tool-governance policy; it does not add a user-discoverable capability or workflow.`
