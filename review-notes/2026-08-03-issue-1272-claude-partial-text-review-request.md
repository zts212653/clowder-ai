# Review Request: #1272 Claude partial-text lifecycle

Review-Target-ID: `fix-1272-claude-partial-text-lifecycle`
Branch: `fix/1272-claude-partial-text-lifecycle`
Base: `origin/main@041190ca7aec0500ff84160db54bb78ce719661b`
Reviewer: `@砚砚`

## What

- Retain a streamed message ID through thinking-only, tool-only, and empty-text assistant envelopes.
- Clear the ID only after a non-empty text-bearing snapshot has been deliberately skipped, or at terminal `result`.
- Add parser lifecycle and route/persistence regressions for thinking/text/tool envelope orderings and terminal cleanup.

## Why

The parser emitted `text_delta` immediately, then treated any same-ID assistant envelope as the final text boundary. A thinking-only envelope deleted the ID without carrying text; a later text snapshot was therefore emitted again and persisted as a duplicate full body.

## Original Requirements

> “按回复拆分PR来修复问题，用adaptive_development sop来修复”

- Source: current collaboration thread; accepted bug contract and maintainer disposition: <https://github.com/zts212653/clowder-ai/issues/1272>.
- Please judge the delivery against #1272's Claude lifecycle tests and its prohibition on frontend/full-text deduplication.

## Tradeoff

- The state machine uses structural proof (`non-empty text block` or terminal `result`), not timeout/heuristic cleanup.
- Thinking/tool events remain visible. The change does not suppress legitimate final text when no partial delta exists.
- No independent fresh-context pre-scan was claimed: this author session participated in implementation. The named peer review below remains the sole approval source.

## Architecture Ownership

Architecture cell: `bubble-pipeline`
Map delta: `none`
Why: this corrects an existing provider lifecycle state transition and persisted-text invariant; it adds no Store, Queue, Router, Adapter, Dispatcher, Binding, bubble identity, or write entrance.

## Open Questions

### Technical OQ

1. Is a non-empty text block the right proof boundary, including `text + tool`, `empty text + tool`, and later tool-only envelopes?
2. Does terminal `result` cleanup cover success/error without hiding error output or leaking IDs across invocations?
3. Are the new ordering tests sufficient to prevent a future unconditional delete regression?

### Value OQ

None.

## Next Action

Please review the exact branch HEAD supplied in the current-thread handoff. Give every finding P1/P2/P3 and a clear disposition; if no P1/P2 remains, state `APPROVE` with the full SHA.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-1272-claude-partial-text-lifecycle/codex`
- Checkout: detached exact SHA from handoff
- Start Command: not needed; backend provider/parser tests only
- Ports: none

Bootstrap:

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## Quality Gate Evidence

- Spec: accepted #1272 maintainer comment at `main@041190ca7aec0500ff84160db54bb78ce719661b`; split delivery explicitly authorized.
- Requirements: delta→thinking→text emits once; tool-only/empty-text envelopes retain the ID; text→tool keeps tool output; no-delta control remains; terminal cleanup prevents leakage; route persistence equals refreshed read.
- Dogfood path: real built `transformClaudeEvent` → `routeSerial` → one `messageStore.append` → `getById`; live, stored, and refreshed text all contain one body.
- Design: no UI changes; no matching `.pen` file.
- Artifact hygiene: no root media/design artifacts.
- Architecture scan: `Map delta: none`; no new architecture nouns or parallel ownership surface.
- Public checkout does not export `check-hotfix-pattern`, `check-fallback-layers`, or `check:architecture-ownership`; these were reported unavailable, not claimed green. Manual diff scan found no fallback stack.

Validation:

```bash
# focused provider/service/route chain
node --import ./packages/api/test/helpers/setup-cat-registry.js --test \
  packages/api/test/claude-ndjson-parser.test.js \
  packages/api/test/claude-agent-service.test.js \
  packages/api/test/f215-malformed-toolcall.test.js \
  packages/api/test/bg-transcript-parity.test.js \
  packages/api/test/issue-1272-claude-route-persistence.test.js
# 120 passed, 0 failed

pnpm --filter @cat-cafe/api run test:public
# 16,762 tests; 16,731 pass; 0 fail; 31 skipped

pnpm lint                    # exit 0; baseline web warnings only
pnpm check                   # exit 0; terminal suite 75/75
pnpm -r --if-present run build  # exit 0
git diff --check             # exit 0
```

Generic `pnpm test` is not the canonical gate for this public sync shape: it ran 18,760 source tests and hit 77 failures from intentionally omitted source-only governance docs/scripts. `scripts/pre-merge-check.sh` explicitly resolves this checkout to `test:public`.

[宪宪/gpt-5.6-sol🐾]
