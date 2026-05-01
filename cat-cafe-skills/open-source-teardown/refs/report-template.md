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

## 1. Claim Ledger

| Claim | Source wording | Evidence paths | Verdict | Caveat |
|-------|----------------|----------------|---------|--------|

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

## 6. Cat Café Comparison

| Dimension | Project | Cat Café | Learn / Gap / Do Not Follow | Agent User Fit (L1/L2/L3) | Reason |
|-----------|---------|----------|-----------------------------|---------------------------|--------|

> Agent User Fit 列填 ✅/⚠️/❌ × L1(可继续) / L2(可分辨 observation vs generation) / L3(可闭环)；详见 [user-mind-evaluation.md](user-mind-evaluation.md)。

## 7. Lessons / Next Steps

- Candidate lessons:
- Candidate ADRs:
- Candidate skill updates:
- Follow-up questions:
```
