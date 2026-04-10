---
feature_ids: [F100]
topics: [knowledge, frontmatter, governance]
doc_kind: decision
created: 2026-03-12
---

# ADR-015: Knowledge Object Contract

## Status: accepted

## Context

F100 Phase 2 needs structured knowledge objects (episodes, methods, proposals, eval results).
ADR-011 defines the base frontmatter schema. We need an optional `knowledge` extension block
that coexists with ADR-011 without polluting general docs.

## Decision

### 1. Optional `knowledge` block (6+2 core fields)

Any doc in `docs/episodes/`, `docs/methods/`, `docs/evolution-proposals/`, or `evals/` MUST include:

```yaml
knowledge:
  artifact_type: episode | method | skill | proposal | eval | lesson | log
  domain: development | medical | legal | product | ops | general
  scope: agent-local | team-shared
  trust_level: experimental | tested | validated | production
  lifecycle: draft | active | deprecated
  knowledge_type: declarative | procedural | analytical | metacognitive
  provenance:
    author_type: agent | human | collaborative
  source_refs: []
```

### 2. Static vs dynamic separation

- **Static (in frontmatter):** artifact_type, domain, scope, trust_level, lifecycle, knowledge_type, provenance, source_refs
- **Dynamic (NOT in frontmatter, tracked in body Use Log or future event stream):** use_count, success_count, last_used_at, human_rating_avg, distinct_agents

### 3. Five-level maturity (tracked in `level` field)

| Level | Name | Promotion criteria |
|-------|------|--------------------|
| L0 | Episode | Template complete, transferable/non-transferable separated |
| L1 | Pattern | ≥2 similar episodes (180d) or human request; 5Q ≥ 7/10 |
| L2 | Draft | smoke gate ≥3 cases (≥2/3 pass); promotion gate ≥5 cases (≥3/5 pass, covering 3 types) |
| L3 | Validated | ≥6 uses, ≥2 agents, ≥80%, no critical breach |
| L4 | Standard | ≥12 uses, last 10 ≥90%, CVO approved |

Dual lane: `long_tail: true` allows parking at L2/L3 for high-risk domains.

### 4. Knowledge layer separation

| Layer | Role | Prohibition |
|-------|------|-------------|
| Episode | Per-case evidence (raw material) | — |
| Method / Skill | Distilled reusable asset (product) | — |
| memory | Lightweight index/pointer | No copying Method body |
| lessons-learned | Failure-oriented lessons | No success cases |

## Consequences

- All knowledge objects get consistent metadata for future discovery (F038-B)
- Git history stays clean (no dynamic state in frontmatter)
- Five-level ladder provides governance without a database
