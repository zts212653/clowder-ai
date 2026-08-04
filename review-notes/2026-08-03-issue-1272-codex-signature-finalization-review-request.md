# Review Request: #1272 Codex persisted-message signature finalization

Review-Target-ID: `fix-1272-codex-signature-finalization`
Branch: `fix/1272-codex-signature-finalization`
Base: `origin/main@041190ca7aec0500ff84160db54bb78ce719661b`
Reviewer: `@砚砚`

## What

- Preserve every Codex `agent_message` body while stripping only this cat's terminal paw signature from each provider turn.
- Emit one runtime-derived canonical `[nickname/effectiveModel🐾]` signature at `turn.completed`.
- Tighten Codex developer instructions so commentary/progress turns do not sign themselves.
- Add provider, service-wiring, prompt-carrier, and 16-turn route/persistence regressions.

## Why

Codex emits multiple complete progress/final text turns, while `route-serial` appends them into one persisted message. L0 made each provider turn independently sign itself, so one refreshed bubble could contain 3–16 signatures even though no event was replayed.

## Original Requirements

> “按回复拆分PR来修复问题，用adaptive_development sop来修复”

- Source: current collaboration thread; accepted bug contract and maintainer disposition: <https://github.com/zts212653/clowder-ai/issues/1272>.
- Please judge the delivery against #1272's Codex acceptance tests and its prohibition on general prose/full-text deduplication.

## Tradeoff

- Finalization is append-only at the provider turn boundary; it does not switch live text aggregation to replace mode or scan/deduplicate arbitrary prose.
- Only the current cat's terminal paw signature is stripped. Quoted/fenced examples, teammate signatures, and legacy un-pawed shapes remain content; one canonical current-cat signature is then appended.
- No independent fresh-context pre-scan was claimed: this author session participated in implementation. The named peer review below remains the sole approval source.

## Architecture Ownership

Architecture cell: `bubble-pipeline`
Map delta: `none`
Why: this narrows an existing provider finalization boundary and persisted-text invariant; it adds no Store, Queue, Router, Adapter, Dispatcher, Binding, bubble identity, or write entrance.

## Open Questions

### Technical OQ

1. Is terminal-signature recognition narrow enough for inline/backtick progress tails while preserving quoted, fenced, teammate, and legacy content?
2. Is `turn.completed` the correct one-shot boundary for a canonical signature across success, usage capture, and signature-only provider output?
3. Does deriving identity from runtime `catRegistry` and model from `effectiveModel` preserve per-cat/model override correctness?

### Value OQ

None.

## Next Action

Please review the exact branch HEAD supplied in the current-thread handoff. Give every finding P1/P2/P3 and a clear disposition; if no P1/P2 remains, state `APPROVE` with the full SHA.

## Review Round 1 Repair

- P2 fixed: terminal own-signature samples inside four-space/Tab indented code and bare unordered, ordered, or task-list items are now preserved as content. The finalizer still strips a signature after actual prose, so the 16-turn progress path remains unchanged.
- Red→Green: the new structure-preservation test failed on the indented-code sample (`42 pass / 1 fail`) before the fix and passes after it in the 114-test focused chain.
- P3 disposition: no abnormal-termination fallback was added. Without a proven `turn.completed` boundary, appending a signature would also alter timeout/error/cancel reply semantics; #1272 does not define that failure-state contract. This remains a disclosed non-blocking risk rather than an unverified fallback layer.

## Review Round 2 Repair

- P2 fixed: CommonMark indented-code prefixes containing one to three spaces followed by a Tab are preserved, as are signature samples inside list-contained blockquotes such as `- >` and `1. >`.
- Forced same-type sweep: plain/list-contained blockquotes, fenced code, four-space/pure-Tab/mixed-space-Tab indented code, and bare unordered/ordered/task-list samples all remain content. A signature after actual list prose remains decorative and is still stripped.
- Red→Green: the expanded structure-preservation test failed before the fix (`43 pass / 1 fail`), while its list-prose negative control already passed. After the fix, the complete focused provider/service/route chain passes `115 / 115`.
- P3 disposition is unchanged from Round 1; no abnormal-termination semantics were added.

## Cloud Review P1 Repair

- Verified against exact reviewed SHA `3a028e8b18cb9ce7bbd71b16d9bd6bb159836636`: a fence line with trailing text, a shorter same-character run, and a nested bare-list signature sample all lost user-visible content.
- Red→Green: the cloud reproductions plus the same-family legal-close negative control failed before the fix (`44 pass / 2 fail`). The final focused provider/service/route chain passes `117 / 117`.
- Failure-mode audit invariant: an open fence closes only on the same marker character, with a run at least as long as the opener and a whitespace-only suffix. The sweep covers backtick/tilde markers, shorter/different/invalid closers, longer legal closers, nested-list continuation indentation, invalid backtick info strings, nested bare lists, and the existing prose/list decoration negatives.
- Coordinate correction: the prior `startsWith` toggling and separate one-marker list regexes were replaced by one explicit fence-state scanner plus one container-only prefix invariant. No Markdown dependency or fallback stack was added. The public checkout does not export `check-fallback-layers`; manual analysis found one fence state and zero fallback layers.
- P3 disposition is unchanged from Round 1; no abnormal-termination semantics were added.

## Review Round 4 Repair

- Reviewed-state grounding: the outstanding P1 was verified against reviewed SHA
  `6b536631ccecae51c7b49f32782dbdb90680b810`. The branch was then fast-forwarded to
  GitHub's signed merge SHA `050b52d0d989567b1b61584e012946c0bdf8591c` (base
  `f30e20c289313649b657ae80b7847b34d73edaa3`); none of the six #1272 implementation
  or regression paths changed in that merge.
- P1 fixed: terminal same-cat signatures are transport decoration only when both the
  identity and normalized model match the runtime canonical signature. A sample for
  another model is user content even when it shares the current cat's nickname.
- State invariant:

  | Terminal shape | Finalizer result |
  | --- | --- |
  | Another cat's signature | Preserve |
  | Current identity, non-canonical model | Preserve |
  | Runtime-canonical signature in quote/list/fence/indented code | Preserve |
  | Runtime-canonical signature after ordinary prose/list progress | Strip |
  | `turn.completed` after retained body content | Append one runtime canonical signature |

- Red→Green: the exact quoted and list samples from the P1 plus a plain-body companion
  failed before the fix (`49 / 50` pass). The provider transform file now passes
  `50 / 50`, and the provider/service/L0/route-persistence chain passes `133 / 133`.
- Failure-mode audit: this is a coordinate correction from nickname-only matching to
  runtime canonical identity+model matching. It adds no prose keyword detector and no
  additional Markdown/context fallback. `check-fallback-layers` still reports the
  historical whole-PR `+9` count in this file; Round 4 adds no fallback branch beyond
  fail-closed canonical availability/parsing.
- Gate evidence on this rebased checkout: API build, `pnpm check`, Biome (zero errors;
  two pre-existing complexity warnings), and `git diff --check` pass. The public suite
  ran 19,410 tests with 19,368 pass, 0 fail, 9 cancelled, and 33 skipped; cancellation
  came from the test sandbox lacking Git author identity before its setup commit. The
  sole affected file was rerun with process-local author/committer variables and passes
  `9 / 9` with 0 cancelled.

## Review Round 5 Repair

- Reviewed-state grounding: P1 review `4857388252` is bound to exact SHA
  `110d3bfa39639274946e551bab33ec8e7c7b107e`. Both reported inputs reproduced locally:
  the canonical sample was removed from `> 引用签名：…` and `- > 引用签名：…`.
- Three gates: the accepted #1272 contract explicitly preserves quoted signature-like
  content; the failure is isolated to the container-only prefix test; and ordinary
  prose/list progress remains the feature-path negative control.
- P1 fixed: signature context now parses the structural container sequence at the start
  of the candidate line. A canonical terminal sample is preserved when that sequence
  enters a blockquote, even when prose follows the `>` marker. An arbitrary `>` later in
  ordinary prose or list progress does not establish blockquote context.
- R2+ failure-mode audit: repeated findings in this classifier made a same-family sweep
  mandatory. The contract edge is now explicit:

  | Candidate line | Result |
  | --- | --- |
  | Plain, list-contained, nested, or list-inside blockquote with prose | Preserve |
  | Ordinary prose/list progress containing an inline `>` | Strip runtime-canonical tail |
  | Same-cat non-canonical model or another cat | Preserve |
  | Runtime-canonical tail outside protected Markdown context | Strip, then append one canonical at completion |

  The regression sweep covers plain, unordered/ordered/nested list-contained, nested
  blockquotes, and blockquote-contained lists, plus two inline-`>` negative controls.
  This repairs the structural coordinate; it adds no prose keyword detector, Markdown
  runtime dependency, or fallback stack.
- Red→Green: exact reproductions failed before the fix (`50 / 51` transform tests) and
  pass after rebuilding (`51 / 51`). The provider/service/L0/route-persistence chain
  passes `134 / 134`.
- Gates: API build, root `pnpm check`, Biome (zero errors; two pre-existing complexity
  warnings), and `git diff --check` pass. Canonical `test:public` passes 19,411 tests:
  19,378 pass, 0 fail, 0 cancelled, 33 skipped. `check-fallback-layers` still reports
  the historical whole-PR `+9` count in the transform file; Round 5 adds one structural
  context branch and no layered fallback.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-1272-codex-signature-finalization/codex`
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
- Requirements: all 16 distinct bodies retained; one canonical final signature; single-turn byte stability; quoted/fenced/teammate/legacy preservation; route persistence equals refreshed read.
- Dogfood path: real built `transformCodexEvent` → `routeSerial` → one `messageStore.append` → `getById`, using 16 distinct signed provider turns; live, stored, and refreshed text are identical.
- Design: no UI changes; no matching `.pen` file.
- Artifact hygiene: no root media/design artifacts.
- Architecture scan: `Map delta: none`; no new architecture nouns or parallel ownership surface.
- Public checkout does not export `check-hotfix-pattern`, `check-fallback-layers`, or `check:architecture-ownership`; these were reported unavailable, not claimed green. Manual diff scan found no fallback stack.

Validation:

```bash
# focused provider/service/route chain
node --import ./packages/api/test/helpers/setup-cat-registry.js --test \
  packages/api/test/codex-event-transform.test.js \
  packages/api/test/codex-agent-service.test.js \
  packages/api/test/codex-agent-service-l0.test.js \
  packages/api/test/issue-1272-codex-route-persistence.test.js
# 117 passed, 0 failed

pnpm --filter @cat-cafe/api run test:public
# 16,763 tests; 16,732 pass; 0 fail; 31 skipped

pnpm lint                    # exit 0; baseline web warnings only
pnpm check                   # exit 0; terminal suite 75/75
pnpm -r --if-present run build  # exit 0
git diff --check             # exit 0
```

Generic `pnpm test` is not the canonical gate for this public sync shape: it ran 18,761 source tests and hit 82 failures from intentionally omitted source-only governance docs/scripts. `scripts/pre-merge-check.sh` explicitly resolves this checkout to `test:public`.

[宪宪/gpt-5.6-sol🐾]
