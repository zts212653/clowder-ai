---
doc_kind: architecture
feature_ids: [F332]
topics: [memory, find, recall, mcp]
created: 2026-11-16
updated: 2026-11-16
owner: opus55
status: active
description: "找侧现行合同：search_evidence 一个找入口，按身份资格与收窄矩阵把同一线索交给文档、原消息、图谱、事情组（无 query 时看最近与事情目录），组级状态、续查参数与共用 24k 预算。"
description_source: model
description_author: opus55
description_generated_by: opus55@claude-opus-5-5
description_generated_at: 2026-11-16T09:18:27Z
description_confirmed_by: opus55
description_updated_at: 2026-11-16T11:23:00Z
tips_exempt: "Internal agent find contract; no new human-facing entry or Settings action."
---

# Memory find entry

`cat_cafe_search_evidence` is the one find entry. A cat hands over the clue as it would say it, an exact anchor,
or nothing (browse). The entry forwards that same input to every group the current identity could already query
and that can honour the whole input and its narrowing. No backend or mode has to be chosen first. This is the
implementation contract for packages F1 and F2 of the accepted
find unification plan.

Architecture cell: memory + mcp-surface-governance.
Map delta: the matter directory, the graph resolver and the recent index are reached through the find entry; owners,
storage and authority do not move.
Why: one clue finds candidates without picking an entry, and continuation carries complete arguments.

Canonical source: `packages/mcp-server/src/tools/memory-find.ts#runFind`, the group modules
`memory-find-{messages,graph,matters,recent}.ts` with `memory-find-group.ts`/`memory-find-context.ts`, and the
registered handler `packages/mcp-server/src/tools/evidence-tools.ts#handleSearchEvidence`. Reading a found source
stays with [the read entry](read-entry.md).

## Groups

| group | input it accepts | original owner and route | qualification |
|---|---|---|---|
| docs | query text (≤2,000 chars) and all original search parameters | `/api/evidence/search` | the tool's profiles, never a watcher |
| messages | the same query; thread and time narrowing; `messageSort`, `mode` | `/api/callbacks/search-evidence` (resultUnit=message) → MessageSearchService | read policy `message` kind + callback identity, never a watcher |
| graph | the same query: an exact anchor returns its subgraph (`graphDepth` 1–3, `graphRelations`), other text returns candidate anchors | `/api/library/graph/resolve` | the tool's profiles, never a watcher; visibility server-derived (KD-8) |
| matters | whole query, literal case-insensitive substring of title/description, ≤200 chars; or no query (directory) | `/api/callbacks/memory-matters` → `MatterMemoryService.catalog` | read policy `matter` kind + callback identity (full or watcher) |
| recent | no query: `since` (default 7d), `scope` ∩ `kinds`, `scope=trajectories`, `limit` ≤100 | `/api/library/recent` → RecentBrowseResolver | the tool's profiles, never a watcher; visibility server-derived (KD-8) |

With a query: docs, messages, graph and matters. Without a query: recent and the matter directory. The groups run in
parallel and are not cut when docs settle. They wait within one budget shared with the other groups, 16s (the watcher's
query too, which had 10s). It bounds how long the find waits for those groups, not the whole call: docs has no budget
of its own, and route deadlines are abort signals, not hard return bounds (the message route's 15s; graph resolve, the
matter directory and the recent index have none). Plan owner's ruling on the accepted plan
(`[thread-id]#private-source-id`): only a group that really outlasts the budget may report
`timeout` with its complete `next`, and that continuation still counts in the journey — a controlled 17s graph answer
takes the original tool one call and the usual find two. Within the budget nothing is cut early; a group that fails in
the parallel find but succeeds alone is a defect to find, not this boundary. 16s is a candidate budget. In one bounded
run on 2026-11-17 (six real message needs, three journeys at once, old explicit search / this find / the find with the
old 3s wait after docs, plus a light message search started 3s and 9s into each wave) this find took one call for
every need and every original opened, while the old wait needed a continuation for three; the light search took
1.2–3.0s beside this find, 1.1–2.8s beside the old search and 1.1–3.1s beside the old wait, and both foreground readers queued in every arm. One run, at that
concurrency, is not a bound for heavier load. The cost of waiting is latency: the usual find returns when docs and the
slowest group within the budget do.
A group still unanswered at the end of the budget reports `timeout` (not a no-results claim) with `cause` — `deadline`
(the 16s budget) or `cancelled` (the caller cancelled the call or its own time limit, such as the watcher's, ended). Each stop
source records its own cause and the first one wins; a cancellation is never reported as the budget. A projection or
route failure is that group's `failed` status, never another group's failure. A `timeout` or `failed` group carries
`next.arguments` in every rendering; passed unchanged they reopen that group alone. A group reopened alone has no
shared ceiling: like the original tool it waits until its route answers or the caller stops it. `continueGroup` is also
accepted on a first call: a caller that already knows only one group is needed reads it alone, with the same query and
that group's parameters, under the same rule (plan owner's ruling `[thread-id]#private-source-id`
item 3). The usual find needs no group choice, and the watcher's inputs stay `query`/`matterCursor`/`limit`. Route deadlines are not
hard return bounds (the message route's 15s signals an abort that its thread reads do not observe; graph resolve has
none); the caller's signal (for the watcher, its invocation deadline) is what ends a lone continuation (a later matter
page reopens with its own `matterCursor`; a first page with `continueGroup:"matters"`, or for the watcher, whose
contract accepts only `query`/`matterCursor`/`limit`, with `matterCursor:"first"`).

## Narrowing and group parameters

Omitting a narrowing leaves each group its own default range, which it reports. An explicit narrowing is kept by every
group or reported `not_covered` with a reason; it is never silently widened. A group whose range excludes the request
by definition does not run and leaves no status ("outside").

| narrowing | docs | messages | graph | matters | recent (no query) |
|---|---|---|---|---|---|
| none, `scope=all` | runs | runs | runs | runs | runs |
| `scope=docs` | runs | outside | runs | outside | runs (docs) |
| `scope=threads` | runs | runs | outside | outside | runs (threads) |
| `scope=memory` | runs | outside | outside | runs | runs (memory) |
| `scope=sessions` | runs (original response) | outside | outside | outside | not_covered |
| `scope=trajectories` | not_covered (browse scope) | outside | outside | outside | runs |
| `threadId` | kept | kept | not_covered | not_covered | not_covered |
| `dateFrom` / `since` (lower bound) | kept (exact ISO) | kept (exact ISO) | not_covered | not_covered | kept |
| `dateTo` | kept | kept | not_covered | not_covered | not_covered |
| `kinds` | not_covered | outside | not_covered | outside | kept (scope ∩ kinds) |
| explicit `dimension=project` | kept | kept | not_covered | runs | not_covered |
| explicit `dimension=library/collection/global/all` | kept | outside | not_covered | outside* | not_covered |

\* F2 corrects F1, which ran matters for `library` and `all`: matter pages are not a registered collection.
An explicit `resultUnit` (document or message) or a docs `coverage_offset` keeps that one original search and its
original response; where that search cannot run (no query, a continuation, or a range docs cannot keep) it is an
input error with no request, never another group. `since` takes the recent route's own syntax (shared
`isValidRecentSince`: a 1–5 digit `d`/`h` window or an anchored ISO 8601 date) and anything else is an input error.
With a query it is resolved to an exact ISO lower bound for docs and messages; giving both
`since` and `dateFrom` is an input error. A continuation repeats every input its group's request used, including the
caller's `agentKeyCatId` identity. A query longer than 200 characters leaves matters `not_covered`, never cut.

Group parameters affect only their group and never stop another: docs `depth`, `contextWindow`, `explain`, `intent`,
`include_expansion`; messages `messageSort`; graph `graphDepth`, `graphRelations`. An omitted `mode` keeps each
default (docs lexical, messages hybrid); an explicit `mode` reaches both retrieval groups. `limit` applies per group up
to 100; each group keeps its own maximum and says so (docs and messages 20, matters 30, recent 100). Beside docs,
messages and matters default to 5; alone, each group keeps its original default.

## Response shape and budget

The whole response stays within the family-wide 24,000-character memory reader budget, and the docs group keeps
the page the docs-only response returns: the same rows, values and read paths, with no extra page.
Other groups first take only the sum of their smallest honest renderings for their actual outcomes (about 40
characters each for no_results/failed/timeout), measured after they settle. If the docs page fits beside that, the docs block is
byte-identical to the docs-only response. If it does not, the same page switches representation instead of
losing rows: coverage keeps every row of the docs-only page as compact rows (field names once, each row's anchor
line, `[matchType:…]` tag and display values; a `sourcePath` equal to its anchor is written `=`), with the same
header, contract, continuation and recall sidecar; topk drops only its duplicate anchor reminder, and only if that
still does not fit, its existing bounded projection that keeps every ranked source reference. The recall candidate parser
(`derive-result-summary.ts`) reads compact rows too, restoring each row's sourcePath (`=` → its anchor), so the same
original Read still pairs with its candidate. The other groups then render in order — messages, graph, matters (without a query: recent, matters) — each taking
the richest rendering that fits while leaving room for the smallest forms of the groups after it. Blocks: an optional one-line group header (shown only when it fits), the docs body, one JSON object per other group,
and the docs recall sidecar as the final block, so existing recall telemetry keeps parsing it.

No page is cut by items, so original cursors stay exact. Each group uses the first rendering that fits: `full` (the
original item fields; matters without descriptions beside docs, plus the match basis), `compact`, or `minimal` (title or
anchor, match basis and `readRef`). If none fits, the group is `deferred`: page count, `hasMore` and
`next.arguments` with `continueGroup:"<group>"` and that group's own parameters, which reopen it alone without re-running
docs — the same single extra call the separate tool used to need. The F1 form `matterCursor:"first"` still opens the
first matters page. Every group finally keeps a short status without detail.

Matter pages carry `next:{tool:"cat_cafe_search_evidence", arguments:{query, matterCursor, limit}}`, passed unchanged,
continuing only the matters group. Beside docs, matter descriptions give way to `matchedIn` (and in `full`, a
`matchExcerpt` of where the whole query matched); not beside docs, whole descriptions are kept while they fit and one
that does not fit is omitted whole (`descriptionOmitted.chars`), never cut. Messages keep each result's match evidence
and `readRef` (highlights offsets are dropped); graph keeps relations, sensitivity and `readRef` only for unredacted
nodes, and states hub truncation; recent states its window, order (time, not relevance), timestamp semantics,
collection distribution and cross-post suggestions once. A group without a match adds only a short status. Listing
records no read; `readRef` opens the source through `cat_cafe_read_memory`.

Without docs (browse, continuation, watcher), the result carries `isError` when no group returned a page (all
`failed`, `timeout` or `not_covered`), so callers keep their error and retry semantics. Beside successful docs, a failed
group is reported in its block and the response is not an error.

## Watcher

The watcher keeps exactly its original route. Its ticket table maps `cat_cafe_search_evidence` to
`GET /api/callbacks/memory-matters`; in watcher context the docs group never runs. The watcher's
registration exposes only `query`, `matterCursor` and `limit` (about 950 characters of schema instead of
the full entry), so docs parameters fail validation and its 30k context is not spent on unusable fields.
Directory receipts, description compaction and per-wake reuse are unchanged; because a failed or timed-out
directory is an error result, it is never kept as this wake's reusable directory and the same arguments retry.

## Retirement and verification

F1 retired `cat_cafe_list_memory_matters` (original stage: `governance/cutovers/history/memory-entry-find-matters-f1.json`;
active cumulative read/matter-find evidence: `governance/cutovers/memory-entry-read-tools.json`); F2 retired
`cat_cafe_graph_resolve` and `cat_cafe_list_recent` (`governance/cutovers/memory-entry-find-graph-recent.json`). Their
HTTP routes and services stay for the groups. The L5 tool index (L0 §7), the session-start hook, CLAUDE/AGENTS/GEMINI/
OPENCODE, the concierge and live-companion prompts, the recall pointer, perspective drill hints and
`memory-routing-partial.md` teach one find entry plus the read entry; the `memory-navigation` skill retired and its
useful graph/time-window noise control moved into `memory-search-best-practices`. Telemetry and eval code keep
recognising the bare historical names so earlier events still classify. Rollback restores code, registration, ticket
mapping and pointers as one revision.

Behaviour tests: `packages/mcp-server/test/memory-find.test.js` (dispatch, the narrowing matrix, qualification,
watcher projection, timeout and failure isolation, the docs-only page at and around the budget boundary with decoded
compact rows, the topk boundary, deferral and continuation, single-group errors, limits) and
`packages/mcp-server/test/memory-find-groups.test.js` (messages, graph and recent groups, behaviour carried from the
retired tools, since resolution, input errors, all groups beside a near-full page);
`packages/mcp-server/test/memory-find-boundaries.test.js` (every row of the narrowing table with and without a query,
explicit single-search errors, the since syntax, each group's continuation reopening the same run, agent key
included, and unfinished groups keeping their cause and continuation down to the smallest rendering); `packages/api/test/watcher-directory-retry.test.js`
and `packages/api/test/derive-result-summary-compact-coverage.test.js`; plus the watcher, harness-consistency, L0,
hook and governance suites. Postmerge acceptance uses official Alpha and non-author natural work; no performance, cost
or noise improvement is claimed without comparable evidence.
