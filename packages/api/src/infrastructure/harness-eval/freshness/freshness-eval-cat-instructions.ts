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
- \`threadIds\` — OPTIONAL live-closure narrowing; omit for all threads in the window
- all eight AC-E9 fixtures are server-owned and replayed automatically; callers cannot select a subset

The tool resolves durable closure aggregates and the named first-party fixtures on the server, normalizes each sample, derives invariant metrics, and writes raw replay events plus snapshot/attribution/provenance artifacts. You cannot supply counts or verdict metrics. Zero eligible samples is explicit \`no_data\` with \`healthy=false\`; never describe an empty window as healthy.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;
