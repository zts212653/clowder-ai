export const FRESHNESS_PUBLISH_SELECTOR_INSTRUCTIONS = `
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable, server-resolved selector:
\`\`\`json
{
  "kind": "freshness-closure-replay",
  "windowStartMs": 1759276800000,
  "windowEndMs": 1759363200000,
  "threadIds": ["thread_optional_narrowing"]
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"freshness-closure-replay"\`
- \`windowStartMs\` / \`windowEndMs\` — REQUIRED finite epoch ms, ordered, maximum 31 days
- \`threadIds\` — OPTIONAL narrowing applied consistently to legacy closure, Queue, Supplement, and attention/provider planes; omit for all owner threads in the window
- all eight AC-E9 fixtures are server-owned and replayed automatically; callers cannot select a subset

The tool resolves the authenticated owner's TTL-0 Queue custody and FreshnessSupplement lifecycles, the owner-scoped windowed attention/provider event index, legacy closure compatibility records, and the named first-party fixtures. It derives every count on the server and writes raw replay events plus snapshot/attribution/provenance artifacts; you cannot supply counts or verdict metrics. Publication is refused before any verdict commit when a required source cannot prove complete coverage for the selected half-open window. Process-cumulative OTel counters are diagnostic only and are never a weekly denominator. Zero live legacy closure samples keeps the structural verdict at explicit \`no_data\` with \`healthy=false\`, but windowed activity must still be reported and must never be paraphrased as "no live activity."

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;
