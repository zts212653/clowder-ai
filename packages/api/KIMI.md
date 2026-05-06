<!-- CAT-CAFE-GOVERNANCE-START -->
> Pack version: 1.3.0 | Provider: kimi

## Cat Cafe Governance Rules (Auto-managed)

### Hard Constraints (immutable)
- **Public local defaults**: use frontend 3003 and API 3004 to avoid colliding with another local runtime.
- **Redis port 6399** is Cat Cafe's production Redis. Never connect to it from external projects. Use 6398 for dev/test.
- **No self-review**: The same individual cannot review their own code. Cross-family review preferred.
- **Identity is constant**: Never impersonate another cat. Identity is a hard constraint.

### Collaboration Standards
- A2A handoff uses five-tuple: What / Why / Tradeoff / Open Questions / Next Action
- Vision Guardian: Read original requirements before starting. AC completion ≠ feature complete.
- Review flow: quality-gate → request-review → receive-review → merge-gate
- Skills are available via symlinked cat-cafe-skills/ — load the relevant skill before each workflow step
- Shared rules: See cat-cafe-skills/refs/shared-rules.md for full collaboration contract

### Quality Discipline (overrides "try simplest approach first")
- **Bug: find root cause before fixing**. No guess-and-patch. Steps: reproduce → logs → call chain → confirm root cause → fix
- **Uncertain direction: stop → search → ask → confirm → then act**. Never "just try it first"
- **"Done" requires evidence** (tests pass / screenshot / logs). Bug fix = red test first, then green

### Knowledge Engineering
- Documents use YAML frontmatter (feature_ids, topics, doc_kind, created)
- Three-layer info architecture: CLAUDE.md (≤100 lines) → Skills (on-demand) → refs/
- Backlog: BACKLOG.md (hot) → Feature files (warm) → raw docs (cold)
- Feature lifecycle: kickoff → discussion → implementation → review → completion
- SOP: See docs/SOP.md for the 6-step workflow
<!-- CAT-CAFE-GOVERNANCE-END -->
