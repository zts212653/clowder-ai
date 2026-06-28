---
cell_id: code-intelligence
title: Code Intelligence / Convention Graph
summary: Worktree-local code convention graph engine, domain extractor plugins, provenance/freshness metadata, and repo-specific convention discovery skills.
canonical_features: [F242]
code_anchors:
  - packages/convention-graph/src/engine.ts
  - packages/convention-graph/src/plugin.ts
  - packages/convention-graph/src/queries.ts
  - packages/convention-graph/src/extractors/mcp-tool.ts
  - packages/convention-graph/src/extractors/skill-manifest.ts
  - packages/convention-graph/src/extractors/fastapi-route.ts
  - cat-cafe-skills/convention-graph-discovery/SKILL.md
doc_anchors:
  - docs/features/F242-code-graph-layer-spike.md
  - feature-discussions/2026-06-17-codegraph-vs-gitnexus/README.md
  - feature-discussions/2026-06-17-f242-design/README.md
static_scan_hints: [convention-graph, ConventionGraphEngine, ConventionDomainPlugin, codeConsumers, mcp-tool, skill-manifest, fastapi-route, code-intelligence]
cited_by:
  - {feature: F242, date: 2026-06-17, delta: new cell}
---

# Code Intelligence / Convention Graph

## Canonical Owner

F242 owns the code-level convention graph layer: local graph artifacts derived
from repository source files, domain extractor plugin contracts, query
freshness/provenance semantics, and the method for discovering repo-specific
conventions.

## Use This When

- Adding or changing `packages/convention-graph` engine, schema, query, or
  extractor plugin contracts.
- Adding a convention domain such as MCP tools, skill manifests, workflow
  callbacks, routes, or repo-specific contract bridges.
- Changing freshness semantics for code convention queries, including indexed
  file hashes and pending-change reporting.
- Creating or updating skills that guide cats to build repo-local convention
  graphs before editing unfamiliar code.

## Extend By

- Keep the engine domain-agnostic; new convention knowledge belongs in a domain
  plugin with declared node kinds, edge kinds, inputs, invalidation scope, and
  negative fixtures.
- Require every authoritative edge to carry provenance: extractor name/version,
  source file, source line, and confidence.
- Prefer deterministic extractors for authoritative graph edges. Clustering or
  heuristic discovery may suggest domains, but must not silently become truth.
- Keep artifacts worktree-local and rebuildable from code. Team memory may
  record design decisions and dogfood evidence, not the live convention graph.

## Do NOT Unify With

- Do not merge this cell into `memory`: convention graph artifacts are
  rebuildable code evidence, not team/historical memory.
- Do not replace TypeScript LSP or grep; this cell covers convention-layer
  associations those tools cannot represent directly.
- Do not treat third-party tools such as codegraph or GitNexus as trusted
  runtime dependencies for Cat Café without a separate integration decision.

## Static Scan Hints

Watch for new `ConventionGraphEngine`, `ConventionDomainPlugin`,
`codeConsumers`, `convention-graph`, `mcp-tool`, `skill-manifest`,
`fastapi-route`, route extractor, callback extractor, and graph freshness
changes.
