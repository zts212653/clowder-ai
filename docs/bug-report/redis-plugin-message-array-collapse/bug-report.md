# Redis plugin message array collapse

## Bug diagnosis capsule

| Field | Evidence |
| --- | --- |
| Reporter | K-1 fresh-context review, reproduced by 砚砚 on 2026-07-15. |
| Symptom | A Redis `updateExtra` that merges a plugin payload with another top-level field returns a message with `extra.pluginMessage === undefined`. The payload should survive byte-for-byte, including empty arrays. |
| Evidence | `plugin-messaging-redis-stores.test.js` fails at `concurrent partial updates preserve disjoint top-level extra fields`: expected `appendOps: []`, actual plugin payload `undefined`. The isolated Redis runner reproduces it consistently. |
| Root cause | The branch-local `EXTRA_MERGE_LUA` decodes and re-encodes the whole `extra` JSON object with Redis Lua `cjson`. An empty JSON array becomes an empty Lua table and is encoded as `{}`. The fail-closed parser then rejects `appendOps`, so it drops the complete plugin payload. |
| Diagnostic strategy | Trace `appendOps` from `serializeExtra` through the Lua merge and `safeParseExtra`; compare with the pre-branch client-side merge and with independent Redis hash fields used by the same message record. |
| Timeout strategy | If an independent field does not make the existing RED green in one implementation pass, stop and inspect the raw hash plus parser output instead of stacking fallbacks. |
| Warning strategy | Any second representation that can overwrite a newer plugin revision, or any hard-delete path that leaves the independent payload behind, invalidates the design. Three failed fixes require an architecture review. |
| User-visible correction | Plugin messages keep their canonical payload and remain appendable after Redis round-trips; host metadata updates no longer rewrite plugin payload JSON. |
| Acceptance | Existing isolated Redis RED turns green; parser compatibility, append service, hard-delete, build, targeted non-Redis tests, and full Redis failing-set comparison pass. |

## R2 hydration hardening

Terra's R2 review found a second failure mode at the same Redis hydration boundary: the independent field preserved arrays, but `parsePluginMessageExtra()` still accepted shapes wider than the C-1 closed schema, including unknown nested fields, 33 elements, and duplicate IDs. The canonical fix is one shared parser used by both memory projection and Redis hydration; Redis has no permissive fallback. It now enforces exact keys for closed objects, the safe 32-element bound, ID/reference/append-history relationships, string and payload-byte bounds, and paired output watermarks. `media_ref` and `rich_block` payload objects remain open as required by C-1.

### Append-history bijection diagnosis capsule

| Field | Evidence |
| --- | --- |
| 1. Symptom | A revision-2 payload with `elements: [el-1, el-2]` and `appendOps: [{ elementIds: ['el-1'] }]` passes strict hydration even though `el-2` is the only appended suffix element. Output repair can then emit the initial element as revision 2 and omit the actual append. |
| 2. Evidence | Terra reproduced the counterexample against candidate `bcb64159e`; the same payload returns non-null from `packages/api/dist/domains/messaging/envelope.js`. Source inspection shows `hasValidAppendHistory()` checks only known-ID membership and cross-record uniqueness, not ordered equality with the appended suffix. |
| 3. Root cause | `appendOps` is both the revision-indexed outbox and the reconstruction index, but hydration does not prove a bijection between flattened `appendOps[].elementIds` and the post-send `elements` suffix. The same weak invariant also accepts a present `baseRevision` older than `producedRevision - 1`, although `AppendService` can persist it only when it equals the immediately preceding revision. |
| 4. Diagnostic strategy | Reverse-trace `AppendOutputCoordinator.emitRecord()` to the persisted writer in `AppendService`, compare the writer's canonical order/base-revision rules with hydration, and exercise wrong-member, wrong-order, missing-element, and stale-base-revision shapes against the shared parser. |
| 5. Timeout strategy | If one ordered-suffix invariant does not make the focused RED table green, stop and inspect the writer/parser state model instead of adding per-case fallbacks. |
| 6. Warning strategy | Any valid writer-produced state rejected by the parser, any malformed history still able to reconstruct a different element sequence, or any Memory/Redis parsing divergence invalidates the fix. Three review rounds on the same state object require plan/spec escalation rather than another local patch. |
| 8. Acceptance | The envelope regression must move from 10/11 RED to 11/11 GREEN for Terra's counterexample plus wrong order, missing suffix IDs, stale present `baseRevision`, missing append stamp, and same-operation derivation. Shared Redis-parser consumers, the full non-Redis messaging suite, and isolated Redis suite must remain green. |

Truth-source and blast-radius model:

| Boundary | Writer / reader | Required invariant | Affected behavior |
| --- | --- | --- | --- |
| Initial element prefix | `SendService` / shared hydration parser | Revision 1 owns a non-empty prefix and no append records. | Memory projection, Redis hydration, snapshots. |
| Appended element suffix | `AppendService` / `AppendOutputCoordinator` | Each operation records the stamped element IDs in persistence order; flattened records exactly equal the remaining suffix. | Crash replay, predecessor repair, append event content and receipts. |
| Revision precondition | `AppendService` / shared hydration parser | A present record `baseRevision` equals its `producedRevision - 1`; omission remains valid. | Deterministic replayed event content and optimistic-concurrency audit. |
| Shared hydration | Message store / memory and Redis consumers | One fail-closed parser accepts every canonical writer state and rejects every non-reconstructible history. | Projection parity across both stores; no permissive fallback. |

The repair validates the history as one ordered traversal rather than a list of independent membership checks. It derives the initial-prefix boundary from the total recorded append IDs, consumes every record against the canonical element suffix, requires writer-stamped appended elements and pre-operation derivation sources, and accepts a present `baseRevision` only when it names the immediately preceding revision. This preserves omitted `baseRevision` and valid open media/rich payloads without adding a fallback representation.

## Fix choice

Store the canonical plugin payload in its own message-hash field and update it through a dedicated store method. Keep ordinary host `extra` metadata in its existing JSON field. This removes the cross-domain read-modify-write collision and avoids all Lua JSON re-encoding for plugin arrays while retaining legacy embedded-payload reads.

Rejected alternatives:

- Configure Redis Lua `cjson` globally: capability and behavior vary by Redis build, and nested empty-array intent is already lost after decode.
- String-patch top-level JSON in Lua: reimplementing a JSON parser is unsafe and harder to verify than using a separate hash field.
- Keep client-side read/merge/write for both domains: concurrent host metadata and plugin appends can still overwrite each other.

## Verification record

The strict append-history regression reproduced Terra's counterexample at 10/11 RED and moved to 11/11 GREEN. The focused append/envelope/Redis-parser consumer set passes 21/21; the non-Redis messaging set passes 149/149; Redis independent-field parity, concurrent host/plugin updates, hard delete, and lease fencing pass 18/18 in the official isolated runner. Final gate commands are recorded in the F288 quality-gate report.
