---
title: F287 Memory Cue Source Map
doc_kind: architecture
feature_ids: [F287]
related_features: [F102, F152, F186, F188, F200, F209, F221, F231, F256, F260, F263, F271, F276, F281, F282]
topics: [memory, recall, cue-plane, ownership, source-map, lifecycle]
created: 2026-08-01
description: "F287 对既有记忆源、消费者、cue 路径、drill、纠正遗忘以及 main/live/UAT 真相的逐 lane 边界普查。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-02T06:20:00Z
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
- v1 zero-only：resolver family 有明确边界和零结果语义，但 closed catalog v1 没有 producer
  能到达它；启用必须提升 catalog version。

## Source census

| Feature | Exact main truth anchor | Canonical truth / owner | Existing consumer | F287 cue path | Drill | Correction / forget | main / live / UAT | Verifiable anchors |
|---|---|---|---|---|---|---|---|---|
| F102 | 36af7fd0271cd8bf03e0976cc74ae3ccc77e41e0 | IEvidenceStore、IIndexBuilder 与本地 SQLite evidence；owner=memory cell | search_evidence、graph/query resolvers | project knowledge resolver；v1 zero-only | EvidenceStore anchor/passage reader | Git source status、supersession 与 rebuild；F287 不改 evidence | main=landed；live=unknown；UAT=feature doc runtime history，Phase A 未复跑 | docs/features/F102-memory-adapter-refactor.md；packages/api/src/domains/memory/interfaces.ts；SqliteEvidenceStore.ts |
| F152 | bdcf7824434445d1eb59a2b9a03d0c8ccd23086c | RepoScanner 选择、CatCafeScanner 与 bootstrap；owner=memory cell | IndexBuilder rebuild/incremental update | readiness materialization only，不是 opportunity producer | scanned sourcePath → evidence anchor | source file deletion/rebuild | main=landed；live=unknown；UAT=feature doc source-owned，Phase A 未复跑 | docs/features/F152-expedition-memory.md；packages/api/src/domains/memory/CatCafeScanner.ts；IndexBuilder.ts |
| F186 | 8ec53796eac7a059b5c74bb476c8515b31306e5e | library catalog / collection lifecycle 与安全边界；owner=memory cell | library collection readers | project knowledge resolver；v1 zero-only | collection/evidence typed readers | collection lifecycle policy；F287 不复制 collection state | main=landed；live=unknown；UAT=feature close truth，Phase A 未复跑 | docs/features/F186-library-memory-architecture.md；packages/api/src/domains/memory/LibraryCatalog.ts；collection routes/tests |
| F188 | cbc10f8e2c83dc6459082e719686d671825bd4a2 | library stewardship、verification 与 search health；owner=memory cell | operator health/repair surfaces | no cue truth；只提供 health evidence | verification/read-model routes | verification workflow；不是 user-memory forget | main=landed；live=unknown；UAT=feature dogfood/screenshot anchors，Phase A 未复跑 | docs/features/F188-library-stewardship.md；packages/api/test/memory/f188-library-health.test.js |
| F200 | dfe4ef0a33fb0a358fc0fb8d1663c420edad182a | recall_events、utility/consumption eval 与 trajectory aggregation；owner=memory cell | RecallLedger、memory utility consumer | downstream eval consumer only；不能生产 opportunity | recall/trajectory read models | append-only measurement policy | main=landed；alpha=loaded；UAT=F287 三 family frozen vector 两次 byte-identical，`keep/keep/keep`；无 total score，运行健康仍归 F153 | docs/features/F200-memory-recall-eval.md；docs/eval/memory-cue-person-v1.md；docs/eval/memory-cue-operational-precedent-v1.md；docs/eval/memory-cue-taste-v1.md |
| F209 | b9e9f3c57745e560dc7a0bff4bce954883209536 | passage、entity anchor、typed evidence drill 与 Perspective query plan；owner=memory cell | search_evidence、graph_resolve、Perspective | operational precedent and project knowledge retrieval substrate；catalog 决定能否调用 | exact evidence anchor/passage/graph drill | evidence source status/supersession | main=landed；alpha=loaded；UAT=trusted connector source message `0001785651570822-000000-fafbd96c` → LL-098 cue `presented/drilled/applied` | docs/features/F209-evidence-recall-optimization.md；docs/features/evidence/F287/README.md；packages/api/src/domains/memory/cue/sources/OperationalPrecedentCueSource.ts |
| F221 | 0c3cbade662ea1f74fb197e14596ebadc9110e4a | approved public vignette in docs/taste、owner-private sensitive vignette in private/taste；owner=Taste lane | Taste proposal approval and manual index | judgment_surface_entered → Taste dimension map；不自动挑结论 | owner-auth TasteMemoryReader，public/private 同 contract | proposal/lane owns approval, replacement and deletion；F287 revalidates revision | main=landed；alpha=loaded；UAT=cue `cue_17bc49867b6895220876ba70a728a0cd` `presented/drilled/applied`；private/cross-scope replay `scope_mismatch` | docs/features/F221-taste-lane.md；docs/features/evidence/F287/README.md；TasteMemoryReader.ts；TasteMemoryCueSource.ts |
| F231 | 6282ef5a3b4f237eea2f5b9248a90c5faad2f46c | user profile capsule / persona primer；owner=identity-session profile subcell | startup profile/context | Profile resolver；v1 zero-only | authenticated profile reader | profile proposal/correction lifecycle | main=landed；live=unknown；UAT=feature source-owned，v1 zero-only 不冒充 cue UAT | docs/features/F231-user-profile-capsule.md；packages/api/src/domains/cats/services/profile/ProfileRepository.ts |
| F256 | dfe4ef0a33fb0a358fc0fb8d1663c420edad182a | memory search strategy convention and skill behavior；owner=memory search strategy | cats doing pull recall | no canonical source and no automatic cue producer | existing search tools | skill/convention revision, not user-memory forget | main=landed；live=unknown；UAT=feature dogfood truth，非 F287 cue UAT | docs/features/F256-memory-search-strategy-evolution.md；cat-cafe-skills/memory-search-best-practices/SKILL.md |
| F260 | 452a826ebff3554731c8e2430b0ff70eb35fd477 | entity_registry、entity_aliases、entity_mentions and append-only revisions；owner=memory cell | EntityNudgeService and exact entity lookup | subject_seen producer via typed EntityNudge result | entity anchor/alias provenance | registry correction/transfer/retire; unknown/deleted zero cue | main=landed；alpha=loaded；UAT=exact subject producer produced owner cue once；serial/parallel consume-once 与 legacy de-dup executable fixtures PASS | docs/features/F260-write-side-autopsy-entity-deref.md；docs/features/evidence/F287/README.md；EntityNudgeService.ts；f287-alden-journey.test.js |
| F263 | 0551d82b9460cad0b5c522670bfd95f735254f3f | recall lifecycle traces and three-axis observation；owner=memory cell | RecallLedger/health analysis | no cue truth；Phase C events remain a separate content-free F287 ledger | trace/ledger read model | append-only trace policy | main=landed；alpha=loaded；UAT=F287 Phase B transport fixtures + Phase E SQLite readback confirms four cues use enum/coordinate-only rows and zero content columns | docs/features/F263-memory-lifecycle-repair-and-metrics.md；docs/features/evidence/F287/README.md；MemoryCueEpisodeStore.ts；f148-context-transport.test.js |
| F271 | 0551d82b9460cad0b5c522670bfd95f735254f3f | reflection_outputs supply/dedupe/projection ledger；owner=memory cell for supply only | public evidence adapter and F255 private cue sink | no catalog v1 producer; downstream approved truth stays in destination lane | source_ref and destination-owned readers | source/destination lane policy; no F271 hidden truth promotion | main=landed；live=unknown；UAT=feature source-owned，非 catalog v1 producer | docs/features/F271-pragmatic-memory-reflection.md；DailyContextReflectionProducer.ts；schema V34 |
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

The first catalog version has three producer families:

1. subject_seen from the server-owned Entity nudge result;
2. delivery_decision from typed GitHub CI / gate evidence;
3. judgment_surface_entered from explicit workflow selection.

Profile and project knowledge remain registered zero-only families in v1. F152, F188, F200, F256,
F263 and F271 are substrates, health/eval consumers or conventions, not new implicit opportunity
producers.

## Phase A truth exceptions

- F281 and F282 canonical docs/code are complete. F281 was still projected as active/spec and both
  features retained stale todo tasks owned by fable-5.
- Task callback authorization allows only the assigned cat to mutate those two tasks. The execution
  contract forbids waking a Ragdoll owner, so the task rows require one operator Hub settlement; F287
  must not add an auto-close heuristic or bypass Redis ownership.
- Production runtime was not restarted or probed in this Phase. Every live cell above therefore
  remains explicit rather than inferred from current main.
