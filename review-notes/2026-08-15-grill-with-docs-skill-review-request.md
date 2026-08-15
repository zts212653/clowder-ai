# Review Request: Install grill-with-docs skill family into Clowder

Review-Target-ID: grill-with-docs-skill
Branch: feat/grill-with-docs-skill

## What

Import and adapt the upstream `grill-with-docs` skill and its required dependencies:

- `cat-cafe-skills/grill-with-docs/`
- `cat-cafe-skills/grilling/`
- `cat-cafe-skills/domain-modeling/`

The change registers all three skills in `manifest.yaml` and `BOOTSTRAP.md`, preserves the upstream methodology, replaces unsupported slash-command wording with explicit Clowder skill loading, and records the pinned upstream revision plus MIT license in each skill directory.

## Why

Operator request: “帮我把这个skill安装到CAFF上 skills/engineering/grill-with-docs”，随后明确要求“给clowder也装一个”。 The Clowder copy must be discoverable through the shared skill registry and must not instruct agents to invoke unsupported `/grilling` or `/domain-modeling` commands.

## Original Requirements

> 给clowder也装一个·

- 来源：co-creator dispatch `0001786778913372-000356-8cca2674` (2026-08-15)
- 上游来源：`mattpocock/skills` at revision `8b78b531ab965735c5dc74f6f7a219e1e37326df`
- 请对照上述要求判断 Clowder 是否能发现并加载入口及其依赖。

## Tradeoff

Kept the upstream design-tree, frontier-round, glossary, and selective-ADR methodology. Adapted only runtime integration and Clowder routing metadata, adding examples and common-mistake guardrails required by the shared skill quality standard. Installed the dependency closure of three skills rather than copying only the entrypoint, so the entrypoint cannot resolve to missing dependencies.

## Architecture Ownership

Architecture cell: shared skill registry / agent guidance surface
Map delta: none
Why: this adds three discoverable guidance skills and their registry entries, but creates no runtime Store, Queue, Router, Adapter, Dispatcher, Binding, API, or data boundary.

Please check:

- the three skill directories are complete and independently discoverable;
- `grill-with-docs` explicitly composes `grilling` and `domain-modeling` under Clowder loading semantics;
- the manifest `next` links resolve and the bootstrap registry matches the source directories;
- provenance, license, and adaptation scope are accurate;
- no hidden runtime or external-network side effects were introduced.

## Open Questions

### Technical OQ

1. Is the minimal slash-command adaptation correct for Clowder's skill loading semantics?
2. Are the routing boundaries and `tips_exempt` declarations sufficiently precise to avoid accidental invocation?
3. Are the imported support templates (`ADR-FORMAT.md`, `CONTEXT-FORMAT.md`) appropriately scoped and licensed?

### Value OQ

无。 This is a reversible shared-skill registry addition; no product behavior, user data, permission boundary, or external contract changes.

## Fresh-Context Findings

Skipped by the `fresh-context-review` trigger table: this is a SKILL.md/metadata-only change with no runtime code, and the formal cross-cat reviewer will inspect the complete diff.

## Next Action

Please perform an independent cross-cat review on the exact pushed HEAD. Return a clear APPROVE or REQUEST-CHANGES verdict with P1/P2/P3 findings. Do not self-approve through the shared GitHub account; record the logical verdict in the PR conversation or thread.

## Review Sandbox

- Path: `/tmp/cat-cafe-review/grill-with-docs-skill/opus`
- Start Command: no runtime server required; inspect the detached review checkout and run the validation commands below
- Ports: not applicable (docs/skill-only change; do not start a server)

### Sandbox Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
```

## Self-check Evidence

### Quality Gate Summary

- `check-skills:manifest`: PASS — 57 skills validated; five pre-existing advisory MCP capability warnings.
- `check-skill-reference-integrity.mjs`: PASS on the real repository graph.
- `check:skills:surfaces`: PASS — 12 passed, 1 skipped, 0 failed.
- `check:capability-tips`: PASS — 11 tests passed and the changed skills are explicitly exempt as opt-in facilitation skills.
- YAML parse probe for manifest and all three `agents/openai.yaml`: PASS.
- `git diff --check`: PASS.
- Root artifact check: no media/design artifacts.

### Known Environment Limitations

- Full `pnpm check` was run and failed before any changed-file semantic check because this Windows checkout presents the repository baseline as CRLF: Biome reported 6,351 pre-existing formatting errors across 6,354 files. No formatter or bulk line-ending rewrite was applied.
- The reference-integrity test fixture could not create temporary Windows symlinks (`EPERM`); its real repository checker passed. This is an environment limitation, not a finding in the imported skill content.
- `pnpm sync:skills --dry-run` could not run because the Windows checkout exposes `scripts/sync-skills.sh` with CRLF (`$'\r': command not found`). The sync script also intentionally resolves the canonical first worktree, so project-level mounts will be refreshed after this branch lands in canonical main.

## Related Source

- Upstream: `https://github.com/mattpocock/skills/tree/8b78b531ab965735c5dc74f6f7a219e1e37326df/skills/engineering/grill-with-docs`
- Dependency: `skills/productivity/grilling`
- Dependency: `skills/engineering/domain-modeling`
- Adaptation: `cat-cafe-skills/grill-with-docs/PROVENANCE.md`
- Adaptation: `cat-cafe-skills/grilling/PROVENANCE.md`
- Adaptation: `cat-cafe-skills/domain-modeling/PROVENANCE.md`

[砚砚/gpt-5.6-sol🐾]
