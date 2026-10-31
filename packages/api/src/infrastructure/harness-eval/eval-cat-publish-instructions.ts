export const PUBLISH_VERDICT_PACKET_INSTRUCTIONS = `

## Publish your verdict (MANDATORY — NOT git push)

When your analysis converges to a verdict, call the \`cat_cafe_publish_verdict\` MCP tool with a complete \`VerdictHandoffPacket\` (12 top-level fields; governance optional except for delete_sunset; all other fields REQUIRED):

1. **id** — stable verdict slug (lowercase alphanumeric + hyphens, e.g. \`2026-06-05-{domainSlug}-c1-friction\`)
2. **domainId** — must match your assigned domain
3. **createdAt** — ISO 8601 timestamp
4. **phenomenon** — what you observed (1-2 sentences)
5. **harnessUnderEval** — { featureId, componentId, name } of harness being evaluated
6. **evidencePacket** — { snapshotRefs, attributionRefs, metricRefs, sampleTraceRefs } — concrete refs to committed bundle artifacts, NOT raw narrative. Every \`metricRefs\` entry must resolve against this domain's metric glossary; unknown refs fail before any evidence branch or PR is created. \`sampleTraceRefs\` must be NON-EMPTY even on no-finding packets — pass at least one metadata-only ref so the bundle has a stable anchor (the schema validator rejects empty arrays at submit time).
7. **dailyTrend** — { window, current, baseline, threshold, direction } — quantitative trend data. \`current\` / \`baseline\` / \`threshold\` are each a **record/object whose values are numbers** (Zod \`record(number)\`) — e.g. \`current: { verdictWithoutPass: 9 }\`. Bare number primitives (\`current: 9\`), strings (\`"3/10"\`), null, and nested-object values are rejected by the schema at submit time. \`window\` is a string label (e.g. \`"24h"\`); \`direction\` is the enum \`improved\` / \`regressed\` / \`flat\` / \`unknown\`.
8. **rootCauseHypothesis** — { summary, confidence (low/medium/high), alternatives[] }
9. **verdict** — categorical: \`fix\` / \`build\` / \`keep_observe\` / \`delete_sunset\` (NOT a score)
10. **ownerAsk** — { targetFeatureId, targetOwnerCatId, requestedAction }
11. **acceptanceReevalPlan** — { nextEvalAt, closureCondition }
12. **counterarguments** — non-empty array of alternative interpretations
13. **governance** (OPTIONAL except for \`delete_sunset\` verdict, where \`governance.cvoAcceptRequired: true\` is REQUIRED)

## After publishing — PR lifecycle (MANDATORY)

The MCP tool returns a PR URL. Your job is NOT done at publish — follow through:

### Evidence-only verdict PR (\`keep_observe\` / first-round verdicts)
1. The PR contains only docs/evidence files (no code). You are the domain owner — **self-merge via \`gh pr merge <number> --squash --delete-branch\`** after confirming the PR is clean (no unintended files).
2. Post a summary in your domain thread: verdict direction + PR URL + next eval schedule.

### Actionable verdict PR (\`fix\` / \`build\` / \`delete_sunset\`)
1. Merge the evidence PR yourself (same as above — evidence is evidence regardless of verdict direction).
2. The \`ownerAsk.targetOwnerCatId\` in your verdict identifies who should act on the finding. **Cross-post to that owner's thread** via \`cat_cafe_cross_post_message\` with: verdict summary, PR URL, and the specific \`requestedAction\`.
3. If the owner creates a fix/build PR with code changes, that PR follows normal cross-review merge-gate (NOT self-merge).

### Thread traceability
Include your domain thread ID in the verdict PR body (the MCP tool does this automatically via provenance.json). If someone asks "which thread produced this PR", the answer is in \`provenance.json → sourceThreadId\`.
`;
