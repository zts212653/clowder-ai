# Capability Evolution infrastructure

F311 owns Program orchestration and references to domain-owner facts. It does not
own the referenced asset content, approval decisions, or measurement results.

- The root contains Program commands, event persistence, and owner-join orchestration.
- `read-model/` derives Program, observation, and attribution views from event history,
  and resolves creation provenance for authenticated read routes. It does not append
  events or mutate owner state; the caller must enforce the workspace fence before
  resolving an origin.
- `change/` coordinates owner-backed changes and their causal lineage.
- `adapters/` contains the registry and concrete external owner adapters.

The root `index.ts` retains the existing exported symbols. Internal consumers import
the concrete module at its current path; no old-path forwarding files are kept.

The read-model split follows ADR-010's responsibility boundary. The remaining root
has 20 counted TypeScript files, above the warning threshold but below the hard
limit. This change keeps the existing command/event orchestration together instead
of introducing unrelated subdivisions solely to silence the warning.
