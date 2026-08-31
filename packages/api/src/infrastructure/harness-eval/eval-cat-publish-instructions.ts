export const PUBLISH_VERDICT_PACKET_INSTRUCTIONS = `

## Publish your verdict (MANDATORY — NOT git push)

When your analysis converges to a verdict, call the \`cat_cafe_publish_verdict\` MCP tool with a complete \`VerdictHandoffPacket\` (12 top-level fields; governance optional except for delete_sunset; all other fields REQUIRED):

1. **id** — stable verdict slug (lowercase alphanumeric + hyphens, e.g. \`2026-06-05-{domainSlug}-c1-friction\`)
2. **domainId** — must match your assigned domain
3. **createdAt** — ISO 8601 timestamp
4. **phenomenon** — what you observed (1-2 sentences)
5. **harnessUnderEval** — { featureId, componentId, name } of harness being evaluated
6. **evidencePacket** — { snapshotRefs, attributionRefs, metricRefs, sampleTraceRefs } — concrete refs to the replay bundle, NOT raw narrative. Every \`metricRefs\` entry must resolve against this domain's metric glossary; unknown refs fail before artifact publication. \`sampleTraceRefs\` must be NON-EMPTY even on no-finding packets — pass at least one metadata-only ref so the bundle has a stable anchor (the schema validator rejects empty arrays at submit time).
7. **dailyTrend** — { window, current, baseline, threshold, direction } — quantitative trend data. \`current\` / \`baseline\` / \`threshold\` are each a **record/object whose values are numbers** (Zod \`record(number)\`) — e.g. \`current: { verdictWithoutPass: 9 }\`. Bare number primitives (\`current: 9\`), strings (\`"3/10"\`), null, and nested-object values are rejected by the schema at submit time. \`window\` is a string label (e.g. \`"24h"\`); \`direction\` is the enum \`improved\` / \`regressed\` / \`flat\` / \`unknown\`.
8. **rootCauseHypothesis** — { summary, confidence (low/medium/high), alternatives[] }
9. **verdict** — categorical: \`fix\` / \`build\` / \`keep_observe\` / \`delete_sunset\` (NOT a score)
10. **ownerAsk** — { targetFeatureId, targetOwnerCatId, requestedAction }
11. **acceptanceReevalPlan** — { nextEvalAt, closureCondition }
12. **counterarguments** — non-empty array of alternative interpretations
13. **governance** (OPTIONAL except for \`delete_sunset\` verdict, where \`governance.cvoAcceptRequired: true\` is REQUIRED)

## After publishing — artifact lifecycle (MANDATORY)

The MCP tool returns an artifact ID and \`artifact://\` URL. Runtime verdict evidence belongs in this durable artifact store, not in the product Git repository.

- Post a summary in your domain thread: verdict direction + artifact URL + next eval schedule.
- For \`fix\` / \`build\` / \`delete_sunset\`, cross-post the owner named by \`ownerAsk.targetOwnerCatId\` with the verdict summary, artifact URL, and exact \`requestedAction\`.
- \`provenance.json → sourceThreadId\` preserves which domain thread produced the artifact.
- **Do not** run \`git add\`, \`git commit\`, \`git push\`, create an evidence PR, or merge an evidence PR for runtime verdict data. A later code/documentation fix is a separate normal PR with cross-review.
`;

export const PUBLISH_VERDICT_ARTIFACT_RESULT_INSTRUCTIONS = `
The MCP tool atomically publishes the verdict and replay bundle outside the product Git checkout. It returns \`{ artifactId, artifactUrl, verdictPath, bundleDir }\`. Use the artifact URL for traceability and handoff.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, create a verdict PR, or write verdict files into the product checkout. Use the MCP tool.
`;
