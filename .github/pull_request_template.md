## PR Type

<!-- Check one -->
- [ ] 🐛 **Patch** — Bug fix, typo, test gap (no Feature Doc needed)
- [ ] ✨ **Feature** — New capability or behavior change (requires Feature Doc)
- [ ] 📋 **Protocol** — Rules, skills, workflow changes (the doc IS the contribution)

## Related Issue

<!-- Link the GitHub Issue. Use "Closes #XX" for auto-close, or "Refs #XX" for reference. -->

Closes #

## Feature Doc (Feature PRs only)

<!-- Link to the Feature Doc. Maintainers assign F-numbers — see CONTRIBUTING.md. -->
<!-- Example: docs/features/F115-multi-platform-deploy.md -->

## What

<!-- What did you change? List key files and modifications. -->

## Why

<!-- Why this change? Constraints, risks, goals. -->

## Tradeoff

<!-- What alternatives were considered? Why not those? -->

## Test Evidence

<!-- How was this tested? Paste relevant output. -->

```
pnpm check                                    # result
pnpm lint                                     # result
pnpm --filter @cat-cafe/api run test:public   # result
```

## AC Checklist (Feature PRs only)

<!-- Copy Acceptance Criteria from the Feature Doc and check off completed items. -->
<!-- - [x] AC 1: description (evidence: test / screenshot) -->
<!-- - [ ] AC 2: description (Phase 2 scope) -->
