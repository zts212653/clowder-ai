---
title: F287 Memory Cue Source Map
doc_kind: architecture
feature_ids: [F287]
related_features: [F102, F152, F186, F188, F200, F209, F221, F227, F231, F256, F260, F263, F271, F276, F281, F282, F312]
topics: [memory, recall, cue-plane, ownership, source-map, lifecycle]
created: 2026-08-01
description: "F287 对既有记忆源、消费者、cue 路径、drill、纠正遗忘以及 main/live/UAT 真相的逐 lane 边界普查。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-09-03T00:00:00Z
---

# F287 Memory Cue Source Map

Architecture cell: memory

这张图回答一个窄问题：F287 在执行现场可以从哪里产生线索，又绝不能从原 lane
搬走什么。Phase A 审计基线是 origin/main@30db246a82ad8b0f7feb3d80854775e0e53305b1；
Design Gate 真相是 2b24ebd7485bb1bfcb35cb1d562bd6122cdc07ed；Phase E close
snapshot 是 origin/main / Alpha@cf9980b595168dbb5b64250c2e48022ba3ad27cd。

## Status vocabulary

- main=landed：下表列出的 source/spec/code 已存在于本次审计的 origin/main。
- live=unknown：本 Phase 没有重启或探测 production，不能从 main 推断 live。
- alpha=loaded：隔离 Alpha 3011/3012/4111 + Redis 6398 加载了 exact main ancestry；不等于
  production 3002/Redis 6399 已激活。
- UAT=source-owned：证据只由原 feature 自己的 feature/evidence 文档声明；F287 不把旧
  unit test 或旧卡片重标成自己的 UAT。
- v2 zero-only：resolver family 有明确边界和零结果语义，但 closed catalog v2 没有 producer
  能到达它；启用必须提升 catalog version。
- v5 active：F312 Phase E 在 catalog v5 加入 Cat-owned Seed 的 bounded predicate；Diary、Episode、Reflection
  经 E0 判为 exempt，未加入 resolver/catalog。v1/v2/v3/v4 段落保留为历史快照，不是 current catalog truth。
- v6 closure：F312 Phase F 不新增 producer/kind pair。Library 维持 F186 显式 pull，Provider-local 维持
  provider/account authority；两者 E0 exempt，current resolver catalog 仍是 v5 的九个 closed pair。

## Source census

| Feature | Exact main truth anchor | Canonical truth / owner | Existing consumer | F287 cue path | Drill | Correction / forget | main / live / UAT | Verifiable anchors |
|---|---|---|---|---|---|---|---|---|
| F102 | 36af7fd0271cd8bf03e0976cc74ae3ccc77e41e0 | IEvidenceStore、IIndexBuilder 与本地 SQLite evidence；owner=memory cell | search_evidence、graph/query resolvers | catalog v4 的 project_source_required 只借 F209/F102 index 定位当前 task 的 exact feature source；index 不取得 authority | canonical feature document reader + Evidence drill carrier | canonical feature bytes/status/path 失效；index refresh 只更新定位，不改原 owner truth | main=Phase D candidate；live=unknown；UAT=须 merged-main Alpha | docs/features/F102-memory-adapter-refactor.md；ProjectKnowledgeMemoryCueSource.ts；f312-project-knowledge-cue.test.js |
| F152 | bdcf7824434445d1eb59a2b9a03d0c8ccd23086c | RepoScanner 选择、CatCafeScanner 与 bootstrap；owner=memory cell | IndexBuilder rebuild/incremental update | readiness materialization only，不是 opportunity producer | scanned sourcePath → evidence anchor | source file deletion/rebuild | main=landed；live=unknown；UAT=feature doc source-owned，Phase A 未复跑 | docs/features/F152-expedition-memory.md；packages/api/src/domains/memory/CatCafeScanner.ts；IndexBuilder.ts |
| F186 | 8ec53796eac7a059b5c74bb476c8515b31306e5e | library catalog / collection lifecycle 与安全边界；owner=memory cell | library collection readers | project knowledge resolver；v2 zero-only | collection/evidence typed readers | collection lifecycle policy；F287 不复制 collection state | main=landed；live=unknown；UAT=feature close truth，Phase A 未复跑 | docs/features/F186-library-memory-architecture.md；packages/api/src/domains/memory/LibraryCatalog.ts；collection routes/tests |
| F188 | cbc10f8e2c83dc6459082e719686d671825bd4a2 | library stewardship、verification 与 search health；owner=memory cell | operator health/repair surfaces | no cue truth；只提供 health evidence | verification/read-model routes | verification workflow；不是 user-memory forget | main=landed；live=unknown；UAT=feature dogfood/screenshot anchors，Phase A 未复跑 | docs/features/F188-library-stewardship.md；packages/api/test/memory/f188-library-health.test.js |
| F200 | dfe4ef0a33fb0a358fc0fb8d1663c420edad182a | recall_events、utility/consumption eval 与 trajectory aggregation；owner=memory cell | RecallLedger、memory utility consumer | downstream eval consumer only；不能生产 opportunity | recall/trajectory read models | append-only measurement policy | main=landed；alpha=loaded；UAT=F287 三 family frozen vector 两次 byte-identical，`keep/keep/keep`；无 total score，运行健康仍归 F153 | docs/features/F200-memory-recall-eval.md；docs/eval/memory-cue-person-v1.md；docs/eval/memory-cue-operational-precedent-v1.md；docs/eval/memory-cue-taste-v1.md |
| F209 | b9e9f3c57745e560dc7a0bff4bce954883209536 | passage、entity anchor、typed evidence drill 与 Perspective query plan；owner=memory cell | search_evidence、graph_resolve、Perspective | operational precedent and project knowledge retrieval substrate；catalog 决定能否调用 | exact evidence anchor/passage/graph drill | evidence source status/supersession | main=landed；alpha=loaded；UAT=trusted connector source message `0001785651570822-000000-fafbd96c` → LL-098 cue `presented/drilled/applied` | docs/features/F209-evidence-recall-optimization.md；docs/features/evidence/F287/README.md；packages/api/src/domains/memory/cue/sources/OperationalPrecedentCueSource.ts |
| F221 | 0c3cbade662ea1f74fb197e14596ebadc9110e4a | approved public vignette in docs/taste、owner-private sensitive vignette in private/taste；owner=Taste lane | Taste proposal approval and manual index | judgment_surface_entered → Taste dimension map；owner_message / approved_taste_invoked (`ELI5`) → exact approved vignette + typed `html_widget` contract | owner-auth TasteMemoryReader，public/private 同 contract | proposal/lane owns approval, replacement and deletion；F287 revalidates revision/tags and records applied only after drill + same-invocation rich block | existing Phase E map main/alpha=landed/loaded；post-close explicit path branch journey=PASS，main/live/UAT require merge + fresh Alpha readback | docs/features/F221-taste-lane.md；docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md；f287-explicit-taste-consumption.test.js；TasteMemoryCueSource.ts |
| F227 | 6f0d6b5f3ade12544aa67482bcbef34788c1275c | owner-scoped EventMemoryStore + source message coordinate；owner=Event memory lane | Event timeline、filter、teleport、F192 ref consumer | recent_event_available → newest exact-owner/current-thread high-confidence Event inside 15m | owner-auth bounded Event record via event-memory anchor | revision change、source delete/visibility/scope change、event-window expiry；handle expiry remains Cue Plane-owned | main=landed；Alpha=loaded@`c72b89139c`；UAT=`5a54ab2f…` / `cue_4156e2b…` recorded presented→drilled→applied, then synthetic source soft-delete produced immutable `source_forgotten` invalidation | docs/features/F227-event-memory.md；EventMemoryStore.ts；EventMemoryCueSource.ts；f312-event-cue.test.js |
| F231 | 21196f0c734c4b4e1f9bfc2af1de948106d95bc3 | user profile capsule / persona primer；owner=identity-session profile subcell | startup profile/context | profile_revision_available → current canonical capsule revision without terminal receipt | authenticated bounded capsule reader | profile proposal/correction/revision lifecycle；cross-owner/missing fail closed | main=landed；Alpha=loaded@`c72b89139c`；UAT=owner capsule candidate absent，ceiling=loaded/no-candidate，不伪造 receipt | docs/features/F231-user-profile-capsule.md；ProfileRepository.ts；ProfileMemoryCueSource.ts；f312-profile-cue.test.js |
| F255 | Phase E main candidate | private diary plus cue/seed/intent/visit/echo；owner=producing cat + owner scope | Present Loop, `/starry`, F272 | owned_seed_available → exact producing-cat/current-revision seed during scheduled Present Loop | content-free prompt coordinate → owner/cat-bound opaque drill → current private claim | missing/source correction/scope mismatch/dormant/retired fail closed | main-candidate；live=unknown；UAT=requires merged-main Alpha | docs/features/F255-auto-dream.md；CatOwnedSeedCueResolver.ts；CatOwnedSeedMemoryCueSource.ts；cat-owned-seed-memory-cue.test.js |
| F256 | dfe4ef0a33fb0a358fc0fb8d1663c420edad182a | memory search strategy convention and skill behavior；owner=memory search strategy | cats doing pull recall | no canonical source and no automatic cue producer | existing search tools | skill/convention revision, not user-memory forget | main=landed；live=unknown；UAT=feature dogfood truth，非 F287 cue UAT | docs/features/F256-memory-search-strategy-evolution.md；cat-cafe-skills/memory-search-best-practices/SKILL.md |
| F260 | 452a826ebff3554731c8e2430b0ff70eb35fd477 | entity_registry、entity_aliases、entity_mentions and append-only revisions；owner=memory cell | EntityNudgeService and exact entity lookup | subject_seen producer via typed EntityNudge result | entity anchor/alias provenance | registry correction/transfer/retire; unknown/deleted zero cue | main=landed；alpha=loaded；UAT=exact subject producer produced owner cue once；serial/parallel consume-once 与 legacy de-dup executable fixtures PASS | docs/features/F260-write-side-autopsy-entity-deref.md；docs/features/evidence/F287/README.md；EntityNudgeService.ts；f287-alden-journey.test.js |
| F263 | 0551d82b9460cad0b5c522670bfd95f735254f3f | recall lifecycle traces and three-axis observation；owner=memory cell | RecallLedger/health analysis | no cue truth；Phase C events remain a separate content-free F287 ledger | trace/ledger read model | append-only trace policy | main=landed；alpha=loaded；UAT=F287 Phase B transport fixtures + Phase E SQLite readback confirms four cues use enum/coordinate-only rows and zero content columns | docs/features/F263-memory-lifecycle-repair-and-metrics.md；docs/features/evidence/F287/README.md；MemoryCueEpisodeStore.ts；f148-context-transport.test.js |
| F271 | 0551d82b9460cad0b5c522670bfd95f735254f3f | reflection_outputs supply/dedupe/projection ledger；owner=memory cell for supply only | public evidence adapter and F255 private cue sink | no catalog v2 producer; downstream approved truth stays in destination lane | source_ref and destination-owned readers | source/destination lane policy; no F271 hidden truth promotion | main=landed；live=unknown；UAT=feature source-owned，非 catalog v2 producer | docs/features/F271-pragmatic-memory-reflection.md；DailyContextReflectionProducer.ts；schema V34 |
| F276 | aad4fd6c639d0810222e1eed679da7282c2d33a7 | owner-private person claims, relationship identity, interactions and bounded RelationshipCard；owner=private-person subcell | person proposal/recall/drill/correct/forget tools | subject_seen → exact Person/Entity resolver | cat_cafe_drill_person_memory / exact source window | correct/retire/redact/forget in F276; every cue/drill revalidates owner and revision | main=landed；alpha=loaded@`cf9980b5`；UAT=initial cue `cue_430bd8e7cdf0620681e57323cf9426a1` invalidated `source_corrected`；new revision cue `cue_98261e6bff104a09fc6eaece5dc3005d` invalidated `source_forgotten`；fresh recall zero | docs/features/F276-people-relationship-memory.md；docs/features/evidence/F287/README.md；PersonMemoryRecallService.ts；PersonMemoryCueSource.ts |
| F281 | b49862d1537a277c42a44a036f4744a58e956250 | structured human disposition receipt/envelope and exact-subject reflow；owner=human-disposition-feedback cell | direct-owner correction context | correction input can invalidate old cue source; it is not an opportunity classifier | authenticated exact-subject episode hydration | producer lane changes canonical truth; F281 carries bounded why only | main=landed；alpha=loaded；UAT=owner correction produced exact `source_corrected` invalidation without changing consumption outcome axis | docs/features/F281-feedback-channel-first-class.md；docs/features/evidence/F287/README.md；HumanDispositionLedger.ts；HumanDispositionFeedbackContextService.ts |
| F282 | a34efbe86b03874227f85dbedda7709dffc0d0c4 | lane-neutral cross-thread candidate detector, registry suppression, source bundle/preflight and cold-start opportunity projection；owner=memory cell | ProactiveMemoryNudgeService / in-context cat judgment | Phase B readiness input only; frequency never becomes lane/importance or Cue Plane catalog entry | candidate sourceCoordinates and F276 bundle drill | candidate receipt/suppression lifecycle; canonical truth remains destination lane | main=landed；live=dormant per source；UAT=frozen replay + F287 Phase B vector relevant `4/5`, single-important `2/3`, irrelevant `0/4` | docs/features/F282-proactive-memory-pipeline.md；ProactiveMemoryCandidateDetector.ts；f282-proactive-memory-replay.ts |

## Phase E Catalog v1 Close Snapshot

| Catalog pair | Main | Alpha loaded | Real UAT | Utility verdict |
|---|---|---|---|---|
| `entity_nudge / subject_seen` | PR #3372 + #3376 | `cf9980b5` | two person revisions, owner drill/use, `source_corrected`, `source_forgotten`, fresh zero | `keep` |
| `github_ci / delivery_decision` | PR #3372 + #3381 + #3383 | `cf9980b5` | strict Redis carrier, LL-098 prompt admission, authenticated drill/outcome `200`, three ledger rows | `keep` |
| `workflow_sop / judgment_surface_entered` | PR #3372 + #3376 | `cf9980b5` | explicit human surface Taste map, owner drill/use, no automatic conclusion | `keep` |

Profile and project knowledge remain v1 zero-only. Production 3002/Redis 6399 was never restarted,
mutated or used as Phase E evidence.

## Post-close Catalog v2 hardening

| Catalog pair | Trigger boundary | Exact source / drill | Applied evidence |
|---|---|---|---|
| `owner_message / approved_taste_invoked` | current direct-owner semantic message contains closed key `ELI5`; history-only/connector/A2A/unknown zero | `taste-vignette:docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md`; owner-auth current-revision drill | prior presented + drilled + same callback-auth invocation buffered `html_widget`; Markdown-only returns 409 |

Catalog v2 does not promote F221 Index/search results into conclusions. The closed trigger registry owns
only execution-time coordinates and delivery-form proof; F221 still owns approval, content, correction,
replacement and deletion. Profile and project knowledge remain zero-only.

## F312 Phase C Catalog v3

Catalog v3 adds exactly two source-owned pairs; no generic classifier, global scorer, new truth store or unified
approval authority is introduced:

| Catalog pair | Lane-owned predicate | Exact source / drill | Terminal + invalidation ceiling |
|---|---|---|---|
| `profile_repository / profile_revision_available` | current F231 capsule revision has no prior `applied|dismissed` receipt; strict owner-auth interactive only | `profile:cat-cafe-profile://relationship/current` → current bounded approved capsule | terminal suppresses that revision; missing/correction/revision/cross-owner fail closed |
| `event_memory / recent_event_available` | newest `high` confidence F227 Event for exact owner + current subject thread in 15m window | `event-memory:<eventId>` → bounded Event record + source coordinate | terminal suppresses exact revision; correction/source visibility/scope/15m expiry fail closed |

Both paths reuse F287 delivery/drill handles and content-free episode receipts. `applied` has a bounded response-level
meaning defined by the owning lane; neither path claims single-memory utility causality or gets a utility eval merely
for becoming active. Generated closure delta is exact: Profile B1/B2/B3 + Event B1/B2/B3/invalidation leave RED,
43→36, while project knowledge remains the only v3 zero-only resolver family. Runtime/UAT is now terminal for the
Event lane on Alpha `c72b89139c`: one exact-owner/current-thread cue recorded `presented → drilled → applied`, and
source soft-delete caused same-handle `404 not_available` plus immutable `source_forgotten` invalidation. Profile is
loaded but had no owner capsule candidate, so its runtime ceiling remains honest `loaded/no-candidate`.

## F312 Phase D Catalog v4

Catalog v4 adds two bounded source-owned pairs after per-lane E0. It reuses the Cue Plane transport and terminal
episode receipts, but does not add a central registry, global cue engine, authority, or utility score:

| Catalog pair | E0 consumer + predicate | Canonical source / drill | Applied + invalidation ceiling |
|---|---|---|---|
| `owner_message / accepted_decision_required` | current `agent_route`; exactly one `ADR-NNN` in the current direct-owner task message; ambiguous/history-only/non-owner zero | F209 locates `docs/decisions/NNN-*.md`; drill returns a ≤4,000-character window from the physical-contained canonical accepted ADR bytes, which own the revision; F209 metadata stays navigation-only | applied only if the drilled ADR constrains this response/action; content-free terminal receipt suppresses the exact revision; correction/non-accepted/removal/path escape fail closed |
| `task_context / project_source_required` | current feature-task `agent_route`; workflow-bound feature ID, otherwise exactly one current direct-owner `FNNN`; ambiguous/history-only/non-owner zero | F209 locates `docs/features/FNNN-*.md`; drill returns a ≤4,000-character window from the physical-contained canonical feature bytes, which own the revision; F209 metadata stays navigation-only | applied only if that exact feature source grounds this task response/action; content-free terminal receipt suppresses the exact revision; correction/inactive/superseded/removal/path escape fail closed |

Method is not a third pair. Its canonical directory currently contains only `TEMPLATE.md`, generated `index.md`, and
`.gitkeep`; E0 found neither a published Method Card nor a named consumer. Its closure is therefore `exempt`, with no
detector, receipt, outcome claim, or eval. Publishing a real Method Card must re-run E0 before any proactive path exists.

The shared append-only ledger admits both active resolver families but persists only source coordinates and enum outcomes;
canonical content remains ephemeral. The generated closure universe stays 21=21. Phase D removes exactly nine RED keys—Decision, Method, and Project
Knowledge `typedCuePredicate / consumptionReceipt / outcome`—so exact RED moves 36→27 and missing surfaces 9→6.
This is main-candidate truth until exact-head review, merge, and merged-main Alpha acceptance complete.

## F312 Phase E Catalog v5

Catalog v5 adds exactly one source-owned pair after four independent E0 packets. Diary, Episode and Reflection remain
real durable surfaces but are Standing Reflex `exempt`: none has both a typed candidate and a named invocation consumer,
so Phase E creates no detector, receipt, outcome or eval for them.

| Catalog pair | E0 consumer + predicate | Canonical source / drill | Applied + invalidation ceiling |
|---|---|---|---|
| `present_loop / owned_seed_available` | server scheduler after F255 `beginScheduledRun`; at most one `status=owned` seed for exact owner, producing cat and current source revision | `owned-seed:<catId>:<seedId>`; prompt carries no claim, exact-cat opaque drill reads current private seed | applied only with prior drill plus exact same-invocation/cat/seed F255 intent; receipts bind consumer cat; missing→`source_forgotten`, revision drift→`source_corrected`, scope mismatch→`scope_revoked`, dormant/retired→`superseded` |

The pair reuses the append-only Cue Plane ledger. V43 adds `consumer_cat_id` to receipt coordinates and admits the
owned-seed resolver family without adding a content column, central store, mutable registry, Hub or authority. The
bounded outcome is intent application with optional existing visit/echo lineage; it is not a long-term utility verdict.
The generated closure universe remains 21=21. Regeneration mechanically removes the four Seed RED keys and the twelve
exempt Diary/Episode/Reflection RED keys: missing surfaces 6→2 and exact RED 27→11. The generated catalog owns these
counts; this paragraph records its output rather than an independently maintained target.

## F312 Phase F Catalog v6 Closure

Catalog v6 changes no runtime producer/kind pair. It closes the last eleven RED keys by declaring the E0 result instead
of constructing unused runtime machinery:

| Surface | E0 result | Preserved authority | Why no pair is born |
|---|---|---|---|
| Library Knowledge | `exempt` | F186 Collection/catalog/source revision/ACL and explicit pull search | no named task-class invocation consumer；private collections cannot enter a prompt from ranking or generic search |
| Provider-local Memory | `exempt` | each runtime provider + account owner, inventoried per carrier | no carrier exposes a Clowder AI-verifiable item revision plus authorized drill and named consumer |

The provider census is metadata only: no provider content, central mutable registry, shared adapter, unified cue engine,
Hub authority or eval is added. Generated universe stays 21=21; disposition becomes active 10 / exempt 10 / sunset 1,
with missing surfaces 2→0, exact RED 11→0 and carriers empty. Because no Phase F pair is active, runtime evidence is
honestly bounded to catalog/gate truth; there can be no valid Phase F `applied` episode.

## Operational evidence migration

The billing-only precedent is operational evidence, not a Taste claim. Its canonical source is
`docs/public-lessons.md#ll-098-zero-step-billingspending-limit-是外部基础设施不是新的代码裁决`.
The former public Taste vignette and its index entry are removed while LL-098 preserves the operator
quote, proposal ID and PR provenance. CatCafeScanner must resolve the phrase through the lesson
source and return no `docs/taste/` hit; Phase D may project it only after a typed delivery-decision
opportunity proves exact PR/head, completed independent evidence and the zero-step external state.

## F287 ownership boundary

F287 owns only execution-time opportunity admission, resolver routing, bounded cue projection,
budget/dedupe, content-free consumption episodes and canonical-source invalidation checks. It does
not own any row above called canonical truth. A source that is unknown, deleted, unauthorized,
superseded, forgotten or not admitted by the closed catalog produces zero cue.

The current catalog version has nine closed producer/kind pairs:

1. subject_seen from the server-owned Entity nudge result;
2. delivery_decision from typed GitHub CI / gate evidence;
3. judgment_surface_entered from explicit workflow selection;
4. approved_taste_invoked from a current direct-owner `ELI5` trigger, bound to one approved F221 source;
5. profile_revision_available from an unconsumed current F231 capsule revision;
6. recent_event_available from an exact-owner/current-thread high-confidence F227 Event inside its temporal window.
7. accepted_decision_required from exactly one accepted ADR anchor in the current direct-owner task message;
8. project_source_required from the workflow-bound feature ID, or one explicit current-owner feature reference.
9. owned_seed_available from an exact producing-cat scheduled Present Loop carrier.

All eight registered resolver families are reachable only through their admitted v5 pair; catalog v6 adds no runtime
resolver and there is no generic project search fallback. Method, Diary, Episode, Reflection, Library Knowledge and
Provider-local Memory remain E0-exempt outside the resolver catalog. F152, F188, F200, F256, F263 and F271 are
substrates, health/eval consumers or conventions, not new implicit opportunity producers.

## Phase A truth exceptions

- F281 and F282 canonical docs/code are complete. F281 was still projected as active/spec and both
  features retained stale todo tasks owned by fable-5.
- Task callback authorization allows only the assigned cat to mutate those two tasks. The execution
  contract forbids waking a Ragdoll owner, so the task rows require one operator Hub settlement; F287
  must not add an auto-close heuristic or bypass Redis ownership.
- Production runtime was not restarted or probed in this Phase. Every live cell above therefore
  remains explicit rather than inferred from current main.
