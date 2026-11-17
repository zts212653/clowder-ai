---
doc_kind: architecture
feature_ids: [F332]
topics: [memory, read-side, source-reading, mcp]
created: 2026-11-15
updated: 2026-11-16
owner: codex61-sol
status: active
tips_exempt: "Internal agent reading contract and coordinates; no new human-facing entry or Settings action."
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/memory/read-entry.md"
mcp_admission_claims:
  - {ref: "file:docs/architecture/memory/read-entry.md", toolName: cat_cafe_read_memory, resourceFamily: memory-read, boundaryKind: resource-entry, decision: accepted}
---

# Memory read entry

`cat_cafe_read_memory({ref})` opens existing coordinates. Search, graph, recent, perspective,
matter directories, entity pointers, cue/preparation and current-profile pointers provide a
shared `ReadRef`. Known coordinates work directly. This is the current implementation
contract for the accepted M1 plan;
runtime loading and natural adoption are verified separately from a code merge.

Architecture cell: memory + mcp-surface-governance.
Map delta: one typed MCP entry reuses original readers and lifecycle owners.
Why: remove reader selection and mechanical parameter transport after finding a source.

Canonical source: `packages/shared/src/types/memory-read.ts#memoryReadRefSchema` and
`packages/mcp-server/src/tools/read-memory-tools.ts#handleReadMemory`.
Consumer evidence: the existing Convention Graph `mcp-tool` queries plus `git grep` and
`tool-cutover-consumer-scan.ts`. Dynamic-factory omissions are gaps, not proof of absence.
Claim guard: production refs round-trip through the registered reader; profile × kind
refusals precede source access; original services retain visibility and receipt tests.

## Coordinates, original readers and authority

The schema is a strict, closed union. It never dynamically executes a caller's tool name.
There is no new ref store, content copy, owner, permanent handle or TTL.

| kind | Coordinates | Original reader |
|---|---|---|
| message | messageId; optional threadId, contextCount, expectedRevision, sourceSelection | handleGetMessage |
| matter | matterId, expectedRevision, cursor, limit, history | handleReadMemoryMatter / MatterMemoryService |
| profile | primer/corpus/capsule, expectedRevision, requestId | handleReadProfile |
| cue | signed handle, expectedRevision, clientRequestId, document window | handleDrillMemoryCue |
| file | path or existing collection/published URI, line/long-line range, expectedRevision | handleReadFileSlice |

`{kind:"profile",layer:"corpus"}` addresses this connection's authenticated owner only.
The fixed `cat-cafe-profile://` pointers teach the corresponding ref. A separate App does
not inherit the invocation's identity. Target user/cat/persona fields are not accepted.

A matter's selected-segment revision differs from whole-message `contentRevision`.
`sourceSelection` preserves segment, indices, UTF-16 range and its own expected revision.
The original matter algorithm checks that selection against the already authorized
message. Whole-message citation revision is independently retained, never substituted.

Lightweight matter entries return summary and its content author separately from the original
speaker. Source-only correction preserves that author or historical unknown; the separate write
receipt identifies the correcting operator. A message pointer uses the existing message kind without sourceSelection;
expectedRevision is the original reader's contentRevision. Thread-only pointers have no message
ref or message revision. The envelope preserves `sourceThreads:[{threadId}]`: open that thread
with existing get_thread_context, optionally using keyword. This is provenance, not a second reader
or proof the original was read. Summary receipts use entryRevision; the sourceRevision receipt
branch remains for actually returned verbatim excerpts.

| Runtime profile | Allowed kinds |
|---|---|
| full | all five |
| readonly | file |
| readonly + explicit usable agent-key union | file, message, profile |
| desktop fable/cloud-pro phase0 | message, profile |
| desktop live-companion | message, profile, file |
| watcher | message, profile, matter; original callback routes only |

The tool name's registration union grants no source union. The actual registered policy
and native bound desktop identity select qualifications before dispatch. Original owners
recheck identity, visibility, revision, invocation and filesystem/publication roots.
Watcher tickets bind the first claim to one of the three previously available read routes;
a claimed ticket cannot switch route or request hash. Redis and memory backends agree.
Cue and local-file branches remain unavailable to watchers.

Directories/hints do not record reads. Original matter/profile/cue services own successful
read receipts and retry idempotency. Failed, empty, changed and forgotten sources retain
their original dispositions. Reading never infers applied/dismissed or publishes a card.
The message handler's memory-read mode cannot adopt queued bodies or close wake coverage.
Unread/queue/freshness belong to `get_thread_context`; targeted history reads do not
advance a contiguous seen cursor.

## Envelope, sources, version and continuation

The envelope preserves domain `data` and adds status, contentKind, actual version,
structured sources, sourcesStatus, complete, nextRef and, on uncertain failure, retryRef.
File data identifies the following plain-text content block (`data.contentBlock=1`),
preserving the original line-numbered body without JSON-escaping it into extra read calls.
Version conflicts withhold the mismatched body; changed matter summaries remain explicitly
unverified. Original failure reasons and retryability remain visible. Stale versions do
not advise an infinite retry with the same stale coordinate.

Content kinds distinguish original messages, documents, cat summaries, approved current
views and mixed matter pages. Matter descriptions are interpretations; entries retain
attribution and source status. Profile/document revisions are not message citation
licenses. Original contentRevision/sourceParts plus an explicit quote and reason feed the
existing ordinary-reply publication path. Structured coordinates alone produce sources;
missing provenance is reported as sourcesStatus=not_provided, never guessed from prose.

Pass the complete nextRef unchanged: source, selectors, revision and original cursor/window
travel together. Every page rechecks its original owner. New cue document windows receive
a new original request key; uncertain retries retain the old key. File continuations retain
the observed stat or published version, original published hash and root allowlist.

Large domain JSON travels losslessly in text blocks in the same MCP response. Concatenate
the block indices named by `data.contentBlocks` before parsing the original JSON. Each
block is bounded, while the total preserves the original reader's full-range response;
the adapter does not add another pagination/call budget or reread sources to assemble it.
Original cursors and document/long-line windows alone produce `nextRef`.
Complete means no remaining continuation for the requested source/range; original range,
lookup and truncation flags remain visible and are not rewritten as a full-document claim.

Event-list MCP views relocate exact source coordinates into `readRef` and factor a shared
`ownerUserId` once at page level. Event records, canonical detail JSON/revisions and page
selection remain unchanged; the same original page does not require an extra call.

## Extension, cutover and verification

A new producer first reuses an existing kind/reader. A genuinely new resource may add an
adapter. A specialized entry needs an explicit choice carrying authority semantics, such
as one private person item/time window; automatic authorization alone is not a reason.
Person-item, diary, self-only raw session, outcome and maintenance entries retain scope.

The three replaced MCP names retire together through
`packages/mcp-server/governance/cutovers/memory-entry-read-tools.json` and the existing
governance checker. Original API/handlers remain; general message/file doors share them.
That active manifest also covers the later matter-directory retirement in the same
resource family, so the real public baseline can cross both phases in one sync. The
original M1 and F1 manifests remain byte-for-byte in `governance/cutovers/history/`;
the separate graph/recent manifest covers its two evidence-navigation retirements.
The public 190-tool name/family/profile projection is retained there as regression input.
Exact delta equality, all seven layers, fixed-root scans, profile checks and rollback
requirements remain enforced by the unchanged checker.
Rollback restores code, registration, producer pointers, prompts and watcher mapping as one
revision. No data migration or production-memory fabrication is required.

Characterization/contract tests: registered reader tests, production producer journey,
and original matter/profile/cue/file/message/source-reply suites. The existing retirement
scan covers code, prompts, skills, fixtures and scripts, with each layer listed in the
cutover manifest. Postmerge validation uses official Alpha, then normal authorized runtime
loading and non-author natural work. Equal-source/identity/range journeys add no MCP call;
elapsed-time or cost improvements are unclaimed without comparable evidence.
