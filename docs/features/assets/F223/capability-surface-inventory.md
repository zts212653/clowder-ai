---
feature_ids: [F223]
related_features: [F022, F038, F041, F120, F131, F150, F192, F203, F211, F212]
topics: [capability-surface, inventory, mcp, skills, hub-action-surface]
doc_kind: reference
created: 2026-06-03
---

# F223 Phase A: Capability Surface Inventory

> Status: Phase A source of truth.
> Owner: Maine Coon/Maine Coon.
> Scope: current Cat Cafe first-party capability surfaces that cats should discover, execute, verify, and feed into F192 eval.

## Phase A Decisions

| OQ | Decision | Reason |
|---|---|---|
| OQ-1 | Workspace typed surface name is `cat_cafe_workspace_navigate`; Phase B defines the action union. | `workspace-navigator` already covers `reveal` / `open`; `open_file` would split an existing panel navigation capability too narrowly. |
| OQ-2 | Registry truth source starts as this Markdown inventory; Phase D may generate JSON for checks from this file or a future YAML split. | Phase A needs human-readable architecture review first; machine-readable check can be added when `check:skills` scope is accepted. |
| OQ-3 | Create a new `hub-action-surface` architecture cell. Do not extend `action-plane`. | `action-plane` owns external/vendor resource mutation. First-party Hub UI actions are socket/UI/probe side effects, not Lark/WeCom-style ActionService operations. |

## Decision Ladder

| Surface | Use when | Required proof |
|---|---|---|
| Skill only | Pure cognition/process, no side effect, no stable execution target | Trigger and boundary are documented. |
| Typed helper | Local shell sequence is enough and not worth MCP yet | Helper has tests or a deterministic probe; skill calls helper, not raw ad-hoc commands. |
| Hub callback/API wrapper | Needs Hub runtime state, socket, thread/worktree scoping, audit, or user-visible side effect | Route has schema, audit/probe, and a stable caller contract. |
| First-party Hub MCP | Cats across runtimes need to invoke a first-party Hub side effect and should not handwrite HTTP/JSON | Tool schema, scoping fields, audit/probe, and availability in the relevant MCP toolset. |
| ActionService | External/vendor resource mutation needs permissions, dry-run, idempotency, or resource handles | ADR-029 service boundary, callback/import/MCP exposure decision, audit and permission proof. |
| Hook/JIT/eval | Behavior remains bad after reachability and execution surface are fixed | F192 verdict supports forcing function; Design Gate / operator accept for new hard checks. |

## Ownership Split

| Area | Owner | F223 relationship |
|---|---|---|
| Capability registry, execution-surface decision ladder, no-raw-curl guardrail | F223 | Direct owner |
| First-party Hub visible side effects | `hub-action-surface` | New architecture cell created by Phase A |
| Capability miss-rate, verdict, re-eval closure | F192 / `harness-eval` | F223 feeds signals; F192 owns verdicts |
| L0 §8 trigger text | F203 | F223 can recommend trigger changes; F203 owns L0 |
| Existing single capability implementation | Owning feature such as F120/F131/F022 | F223 coordinates typed-surface normalization |
| External enterprise actions | `action-plane` / ADR-029 / F162 | Out of F223 Hub action scope; still classified in inventory |

## Inventory

| # | Capability | Trigger surface | Current execution surface | Verification probe | Eval signal | Owner | Recommended action |
|---|---|---|---|---|---|---|---|
| 1 | `rich-messaging` | L0 §8, `rich-messaging` skill, `rich-blocks.md` ref | Existing MCP `cat_cafe_create_rich_block` + `cat_cafe_get_rich_block_rules` | Rich block rendered inline / RichBlockBuffer callback event | F192 `rich-messaging` predicate | `hub-action-surface` + F022/F096 | Phase B2: align trigger, tool description, and predicate; no new MCP. |
| 2 | `browser-preview` | L0 §8, `browser-preview` skill | MCP `cat_cafe_preview_open` → `/api/preview/auto-open` | `BROWSER_PREVIEW_OPEN` audit + `preview:auto-open` socket + visible Browser panel | F192 `browser-preview` predicate | `hub-action-surface` + F120 | Phase B1 done: raw HTTP removed from skill main path; keep probe/eval. |
| 3 | `image-generation` | L0 §8, `image-generation` skill | Native image tool or provider-specific automation | Generated image file / rich block / visual inspection | F192 future predicate if miss-rate justifies | skill owner | Keep registry entry; no Hub MCP. |
| 4 | `workspace-navigator` | L0 §8, `workspace-navigator` skill | MCP `cat_cafe_workspace_navigate` → `/api/workspace/navigate` | `WORKSPACE_NAVIGATE` audit + `workspace:navigate` socket + opened file/reveal probe | F192 `workspace-navigator` predicate | `hub-action-surface` + F131 | Phase B1 done: typed MCP + worktreeId canonicalization + Files view switch. |
| 5 | `pencil-design` | L0 §8, `pencil-design` skill | Pencil MCP tools | `.pen` frame / screenshot / export proof | F192 future predicate if needed | Pencil design surface | Keep as skill+MCP; registry records boundary. |
| 6 | `guide-interaction` | L0 §8, `guide-interaction` skill | Guide MCP tools + rich block cards | Guide state readback + interactive card | F192 future predicate if needed | Guide engine | Keep existing tools; strengthen triggers only if eval misses. |
| 7 | `expert-panel` / `collaborative-thinking` | L0 §8, skills | Skill workflow + optional `cat_cafe_multi_mention` / `cat_cafe_start_vote` | Multi-cat responses / vote result / synthesis doc | F192 future predicate if needed | Collaboration tools | Phase C done: keep registry only; `multi_mention` / `start_vote` trigger descriptions now lock structured variants. |
| 8 | `cat_cafe_propose_thread` | L0 §8, `thread-orchestration` skill | Existing MCP `cat_cafe_propose_thread` | Proposal card created; thread only after user approval | Capability-wakeup predicate possible | Collaboration/thread orchestration (renders via `hub-action-surface`) | Keep; no new surface. |
| 9 | F211 external runtime sessions | L0 §8, F211 docs | MCP `cat_cafe_list_external_runtime_sessions`, `cat_cafe_read_external_runtime_session`, `cat_cafe_register_external_runtime_session` | Runtime session metadata and session digest/events | Capability-wakeup predicate possible | `identity-session` | Phase C done: read/list MCP descriptions now include lost/detached external runtime drilldown triggers. |
| 10 | F212 CLI diagnostics | L0 §8, F212 docs | Message metadata `cliDiagnostics`, `debugRef`, backend logs | CLI diagnostics panel / safe excerpt / log grep by invocationId | Capability-wakeup predicate possible | provider runtime / diagnostics | Registry entry; no MCP unless a stable reader is needed later. |
| 11 | F192 Eval Hub / Verdict Handoff | L0 §8, F192 docs | Eval domain registry + verdict bundles | Eval Hub read model / verdict handoff packet | Native F192 domain metrics | `harness-eval` | Out of Hub action surface; F223 consumes verdicts. |
| 12 | `search_evidence` + drilldown | L0 §8, memory skills | MCP `cat_cafe_search_evidence`, `cat_cafe_graph_resolve`, `cat_cafe_list_recent`, session readers | Evidence anchor + drilldown content | F200 consumption + F192 memory eval | `memory` | Keep; registry records drilldown chain. |
| 13 | `cat_cafe_update_workflow` | L0 §8, workflow/SOP docs | Existing MCP `cat_cafe_update_workflow` | Mission Hub workflow board readback | Workflow/eval handoff signals | workflow/SOP + `harness-eval` (renders via `hub-action-surface`) | Phase C done: trigger retained; MCP description locks stage/resumeCapsule usage. |
| 14 | F201 Antigravity recovery | Tier 2 ref | Recovery card / supervisor / side-effect journal | Recovery card and journal proof | F192/F201 reliability signals | Antigravity reliability | Keep Tier 2; no generic MCP. |
| 15 | F186/F188 library federation | Tier 2 ref | Library MCP family | Collection health / search result / verify output | F188 health + F192 memory eval | `memory` | Keep; no Hub wrapper. |
| 16 | `video-forge` / `ppt-forge` / `tech-writing` | Tier 2 skills | Skill pipelines + document/image/video tools | Generated artifact and review proof | Task-outcome/eval if adopted | content pipeline owners | Keep as skill pipelines; registry can link artifact proof. |
| 17 | `hyperfocus-brake` | Tier 2 skill + hook | Hook + `cat_cafe_create_rich_block` | Check-in card rendered | Health/reminder metrics | hyperfocus-brake | Existing forcing function; no F223 change. |
| 18 | `deep-research` | Tier 2 skill | Web research + synthesis pipeline | Source ledger / research doc | Source-audit/F218 signals | research harness | Keep as skill; no MCP. |
| 19 | Global lesson nomination | Tier 2 ref | MCP `cat_cafe_mark_generalizable`, `cat_cafe_nominate_for_global`, `cat_cafe_review_distillation` | Distillation candidate / review result | Knowledge-evolution metrics | `memory` | Improve trigger; no new surface. |
| 20 | F210 AGY sticky behavior | Tier 2 ref | Docs/probes/runtime config checks | Sticky behavior proof logs | F210 reliability signals | `identity-session` / carrier owner | Keep Tier 2. |
| 21 | `enterprise-workflow` | Tier 2 skill family | Lark/WeCom skills + ActionService / CLI | External resource handle / permission/audit proof | Task outcome + action metrics | `action-plane` | Stays in action-plane; not a Hub action surface. |

## Underused MCP Capability Addendum

| Capability MCP | Trigger surface | Verification probe | Owner | Recommended action |
|---|---|---|---|---|
| `cat_cafe_start_vote` | Capability index MCP quick scan, collaborative-thinking | Vote record and result message | collaboration | Phase C done: MCP description includes Use when + Output; no new wrapper. |
| `cat_cafe_multi_mention` | collaborative-thinking, L0 quick index | Routed responses and callback aggregation | collaboration | Phase C done: trigger retained; MCP description locks `searchEvidenceRefs` hard check. |
| `cat_cafe_generate_document` | writing-skills, document generation requests | Uploaded document + file rich block + IM delivery | document generation | Phase C done: trigger retained; MCP description locks no-manual-pandoc path. |
| `cat_cafe_run_perspective` | memory/navigation advanced route | Candidate anchors + typed reader route hints | `memory` | Keep advanced/niche; not Tier 1 unless eval shows miss. |
| `cat_cafe_review_distillation` | knowledge-evolution / review close-out | Distillation review result | `memory` | Pair with global nomination triggers. |

## Phase D Action Tracking

Every inventory row has an explicit follow-up state. States are intentionally coarse so F192 verdicts and manual probes can route work without inventing one-off labels:

- `fix`: execution/trigger/probe gap was closed in F223 or an owning feature.
- `build`: new surface or substantial follow-up remains to be built by the owning feature.
- `keep_observe`: current surface is acceptable; monitor via listed eval/probe.
- `delete_sunset`: remove or demote if usage/probe signals stay low.

| Capability | Action state | Tracking route | Next action |
|---|---|---|---|
| `rich-messaging` | fix | F192 `rich-messaging` predicate + rich block render probe | Phase B2 aligned trigger/MCP/predicate; keep observing miss rate. |
| `browser-preview` | fix | F192 `browser-preview` predicate + `BROWSER_PREVIEW_OPEN` audit | Phase B1 typed MCP and probe path done; keep observing. |
| `image-generation` | keep_observe | Manual artifact/rich-block probe; future F192 predicate only if miss-rate justifies | No Hub MCP; keep as provider/native surface. |
| `workspace-navigator` | fix | F192 `workspace-navigator` predicate + `WORKSPACE_NAVIGATE` audit + alpha CG-1 probe | Phase B1/B2 fixed typed surface, canonicalization, Files view, and fallback observability. |
| `pencil-design` | keep_observe | Manual `.pen` frame/screenshot/export proof | Existing Pencil MCP sufficient. |
| `guide-interaction` | keep_observe | Guide state readback + interactive card probe | Existing guide tools sufficient unless eval misses recur. |
| `expert-panel` / `collaborative-thinking` | fix | Multi-cat response/vote result + F192 future predicate if needed | Phase C normalized `multi_mention` / `start_vote` trigger descriptions. |
| `cat_cafe_propose_thread` | keep_observe | Proposal card and user-approval thread creation proof | Keep existing surface. |
| F211 external runtime sessions | fix | External runtime session list/read metadata probe | Phase C made lost/detached drilldown trigger explicit. |
| F212 CLI diagnostics | keep_observe | Message `cliDiagnostics` / `debugRef` proof | Keep metadata path; build reader only if repeated miss appears. |
| F192 Eval Hub / Verdict Handoff | keep_observe | Native F192 domain metrics and verdict bundle | F223 consumes; F192 owns. |
| `search_evidence` + drilldown | keep_observe | Evidence anchor + session drilldown proof | Keep existing memory MCP chain. |
| `cat_cafe_update_workflow` | fix | Mission Hub workflow board readback | Phase C locked stage/resumeCapsule description. |
| F201 Antigravity recovery | keep_observe | Recovery card + side-effect journal | Tier 2 only. |
| F186/F188 library federation | keep_observe | Collection health/search verification | Tier 2 only. |
| `video-forge` / `ppt-forge` / `tech-writing` | keep_observe | Generated artifact and review proof | Keep as skill pipelines. |
| `hyperfocus-brake` | keep_observe | Check-in rich block + reminder metrics | Existing forcing function; no F223 build. |
| `deep-research` | keep_observe | Source ledger + synthesis artifact | Keep as skill pipeline. |
| Global lesson nomination | keep_observe | Distillation candidate/review result | Improve trigger only if nomination misses recur. |
| F210 AGY sticky behavior | keep_observe | Sticky behavior logs/probes | Tier 2 only. |
| `enterprise-workflow` | keep_observe | External resource handle + permission/audit proof | Action-plane owner; outside Hub action surface. |
| `cat_cafe_start_vote` | fix | Vote record and result message | Phase C normalized Use when + Output. |
| `cat_cafe_multi_mention` | keep_observe | Routed responses and callback aggregation | Existing description already has `searchEvidenceRefs` hard check. |
| `cat_cafe_generate_document` | keep_observe | Uploaded document + file rich block + IM delivery | Existing description already blocks manual pandoc path. |
| `cat_cafe_run_perspective` | keep_observe | Candidate anchors + typed reader route hints | Keep advanced/niche. |
| `cat_cafe_review_distillation` | keep_observe | Distillation review result | Pair with global nomination trigger improvements if needed. |

## ADR-029 Compatibility

- `action-plane` remains the owner for external/vendor operations with permission, dry-run, idempotency, and resource handles.
- `hub-action-surface` owns first-party Hub display side effects. A Hub MCP wrapper is valid only when it replaces fragile manual first-party calls and adds schema, scoping, audit, or verification.
- F223 does not create MCP wrappers for discovery alone. Discovery is trigger/ref/skill work; execution wrappers need a side-effect/probe contract.
- New hard checks against raw first-party calls require Design Gate / operator accept per F192 Phase F AC-F9.

## Phase B Entry Conditions

Phase B may start only after:

- `hub-action-surface` cell exists and `docs/architecture/ownership/README.md` is regenerated.
- F223 spec references `hub-action-surface + harness-eval`, not TBD ownership.
- This inventory exists and covers all Tier 1 capabilities plus underused MCP capabilities.
- AC-A5 is marked complete in F223.
