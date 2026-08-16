# Open Source Teardown Report Template

```markdown
---
doc_kind: research-note
topics: [{project}, open-source-teardown]
created: YYYY-MM-DD
status: draft
source_repo: {url-or-local-path}
source_commit: {sha}
authored_by: {cat-id}
covers: [architecture, star-features, algorithms, comparison]
---

# {Project} Deep Dive

## 0. Scope

- User question:
- Project:
- Source repo:
- Local path:
- Commit:
- Claims to verify:

## 1. Claim + Decision Ledger

| Claim | Measured construct / comparator | Population / denominator / exclusions | Evidence paths | Source verdict | Decision fit | Unknowns |
|-------|---------------------------------|---------------------------------------|----------------|----------------|--------------|----------|

### Performance / Cost Boundary

- Target workload / user:
- Provider + model + version:
- Time horizon:
- Lifecycle boundary: ingest/extract / query/retrieval / generation / cache / maintenance/human
- Coupled outcomes: quality / coverage / latency / reliability / privacy-risk
- Adaptive eval reuse: benchmark/holdout visibility + query count
- Unknown or unreported items:

## 1.5 Input Provenance & Output Audit

### Input Provenance / Reproduction Matrix

| Layer / artifact | Version / SHA | Model + data/split | Prompt/config/seed | Availability | Mismatch / claim impact |
|------------------|---------------|--------------------|--------------------|--------------|-------------------------|
| Paper + appendix + limitations | | | | | |
| Released code/config/data/checkpoint | | | | | |
| This reproduction | | | | | |

- Exact command / environment:
- Reproduction status: not attempted / exact / partial / failed
- Delta from reported result:
- Input unknowns or unavailable artifacts:

### Raw Output / Failure-Tail Audit

| Run / sample | Success / failure / tail | Raw artifact path | Observation | Agrees with aggregate? | Provenance / unknowns |
|--------------|--------------------------|-------------------|-------------|------------------------|-----------------------|

- Per-run / per-seed / per-task stability:
- Aborted or missing runs:
- Selection rule and reported checkpoint/run relationship:
- Output evidence unavailable or uninspected:
- Claim ceiling after input/output audit:

## 2. Architecture Map

```text
entrypoint -> core loop -> tools/providers/plugins -> state stores
```

- Entrypoints:
- State stores:
- Extension points:
- Empty / placeholder dirs:
- High-risk monoliths:

## 3. Star Feature Deep Dives

### {Feature}

- Public API / command:
- Core modules:
- State mutation:
- Future behavior:
- Tests:
- Verdict:

## 4. Algorithm Peel Table

| Mechanism | Input | Output | Type | Code path | Mutates future behavior? |
|-----------|-------|--------|------|-----------|---------------------------|

## 5. Feedback Loops

| Claimed loop | signal | decision | state mutation | future behavior | verdict |
|--------------|--------|----------|----------------|-----------------|---------|

## 6. Clowder AI Comparison

| Decision dimension | Project evidence | Clowder AI requirement | Constraint / frontier | Learn / Gap / Do Not Follow | Agent User Fit (L1/L2/L3) | Reason / unknowns |
|--------------------|------------------|----------------------|-----------------------|-----------------------------|---------------------------|-------------------|

> Agent User Fit 列填 ✅/⚠️/❌ × L1(可继续) / L2(可分辨 observation vs generation) / L3(可闭环)；详见 [user-mind-evaluation.md](user-mind-evaluation.md)。

## 7. Lessons / Next Steps

- Candidate lessons:
- Candidate ADRs:
- Candidate skill updates:
- Follow-up questions:
```
