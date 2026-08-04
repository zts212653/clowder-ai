# ChatGPT Multi-Cat Review Round

```yaml
changeId: <PR-number-or-branch-slug>
round: <NN>
reviewedCodeHead: <full-commit-sha>
reviewers:
  - <catId>
  - <catId>
recorder: <co-creator-designated-catId>
independentReviewCompleted: true
crossReviewCompleted: true
openFindings: <integer>
verdict: fix_required | approved_for_merge
```

## Input evidence

- Requirements / Feature Doc: `<path-or-anchor>`
- PR / branch: `<reference>`
- ChatGPT test evidence: `<commands-and-results>`

## Previous-round closure

| Finding | Status (`fixed` / `reopened` / `not_a_defect`) | Evidence |
|---|---|---|
| `<ID>` | `<status>` | `<commit/test/path>` |

## Consensus findings

| ID | Severity | Location / reproduction | Expected vs actual | Required closure |
|---|---|---|---|---|
| `R<NN>-P<N>-<N>` | `P1/P2/P3` | `<evidence>` | `<behavior>` | `<test/outcome>` |

## Disposition

- New findings: `<count>`
- Open historical findings: `<count>`
- `openFindings`: `<total>`
- Verdict rationale: `<why fix_required or approved_for_merge>`

## Provenance

- Independent notes stayed private until every reviewer completed: `yes`
- Cross-review consensus completed: `yes`
- Git writer for this round was the operator-designated recorder: `yes`
- `ledgerOnlyContinuity`: `yes` — `reviewedCodeHead..ledger commit` changes only this round ledger file
- Recorder signature: `[nickname/model🐾]`
