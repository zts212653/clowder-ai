export const PUBLISH_VERDICT_PACKET_INSTRUCTIONS = `

## Publish your verdict (MANDATORY — NOT git push)

When your analysis converges to a verdict, call the \`cat_cafe_publish_verdict\` MCP tool with a complete \`VerdictHandoffPacket\` (12 top-level fields; governance optional except for delete_sunset; all other fields REQUIRED):

1. **id** — stable verdict slug (lowercase alphanumeric + hyphens, e.g. \`2026-06-05-{domainSlug}-c1-friction\`)
2. **domainId** — must match your assigned domain
3. **createdAt** — ISO 8601 timestamp
4. **phenomenon** — what you observed (1-2 sentences)
5. **harnessUnderEval** — { featureId, componentId, name } of harness being evaluated
6. **evidencePacket** — { snapshotRefs, attributionRefs, metricRefs, sampleTraceRefs } — concrete refs to committed bundle artifacts, NOT raw narrative. Every \`metricRefs\` entry must resolve against this domain's metric glossary; unknown refs fail before any artifact is published. \`sampleTraceRefs\` must be NON-EMPTY even on no-finding packets — pass at least one metadata-only ref so the bundle has a stable anchor (the schema validator rejects empty arrays at submit time).
7. **dailyTrend** — { window, current, baseline, threshold, direction } — quantitative trend data. \`current\` / \`baseline\` / \`threshold\` are each a **record/object whose values are numbers** (Zod \`record(number)\`) — e.g. \`current: { verdictWithoutPass: 9 }\`. Bare number primitives (\`current: 9\`), strings (\`"3/10"\`), null, and nested-object values are rejected by the schema at submit time. \`window\` is a string label (e.g. \`"24h"\`); \`direction\` is the enum \`improved\` / \`regressed\` / \`flat\` / \`unknown\`.
8. **rootCauseHypothesis** — { summary, confidence (low/medium/high), alternatives[] }
9. **verdict** — categorical: \`fix\` / \`build\` / \`keep_observe\` / \`delete_sunset\` (NOT a score)
10. **ownerAsk** — { targetFeatureId, targetOwnerCatId, requestedAction }
11. **acceptanceReevalPlan** — { nextEvalAt, closureCondition }
12. **counterarguments** — non-empty array of alternative interpretations
13. **governance** (OPTIONAL except for \`delete_sunset\` verdict, where \`governance.cvoAcceptRequired: true\` is REQUIRED)

## After publishing — handoff (MANDATORY)

The MCP tool returns an artifact reference (\`artifactId\` + \`artifactUrl\`), not a branch, commit or pull request.
Your job is NOT done at publish — follow through:

### Evidence-only verdict (\`keep_observe\` / first-round verdicts)
1. The artifact is immutable once published; there is nothing to merge and nothing to approve. Confirm the returned
   \`artifactUrl\` resolves and that the bundle holds only the evidence you intended.
2. Post a summary in your domain thread: verdict direction + \`artifactUrl\` + next eval schedule.

### Actionable verdict (\`fix\` / \`build\` / \`delete_sunset\`)
1. The artifact is already durable — do not try to land it anywhere.
2. The \`ownerAsk.targetOwnerCatId\` in your verdict identifies who should act on the finding. **Cross-post to that
   owner's thread** via \`cat_cafe_cross_post_message\` with: verdict summary, \`artifactUrl\`, and the specific
   \`requestedAction\`.
3. If that owner then writes code, their change follows the normal cross-review merge-gate. Your verdict never does.

### Thread traceability
Your domain thread ID is stamped into the artifact automatically (\`provenance.json → sourceThreadId\`). If someone asks
"which thread produced this verdict", the answer is in \`provenance.json\`.
`;

/**
 * The one publication footer every domain instruction shares. F257 retired Git
 * writeback for verdicts, so no domain may describe branch/commit/PR mechanics.
 */
export const PUBLISH_VERDICT_ARTIFACT_FOOTER = `
The MCP tool writes an immutable bundle through the durable artifact publisher and returns an artifact reference (\`artifactId\` + \`artifactUrl\`). It does not create a branch, a commit, or a pull request.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;
