/**
 * normalizeMcpToolName — F188 Phase F (砚砚 四审 P1-1)
 *
 * Reduces all known MCP toolName forms to the bare child tool name so the
 * event log aggregator can compare consistently with `search_evidence` /
 * `graph_resolve` / `list_recent` etc.
 *
 * Forms handled:
 * - `mcp__{server}__{tool}`      → Claude Code format
 * - `mcp:{server}/{tool}`        → Codex format
 * - `cat_cafe_{tool}`            → server prefix on flat-named tools
 * - `{tool}` (no prefix)         → passthrough
 *
 * After stripping the transport prefix, also strips `cat_cafe_` so MCP
 * server-side prefix `cat_cafe_search_evidence` reduces to `search_evidence`.
 */

export function normalizeMcpToolName(rawToolName: string | undefined | null): string {
  if (!rawToolName) return 'unknown';
  let name = rawToolName;

  // Claude Code: mcp__{server}__{tool}
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.slice(5);
    const sepIdx = withoutPrefix.indexOf('__');
    name = sepIdx > 0 ? withoutPrefix.slice(sepIdx + 2) : withoutPrefix;
  }
  // Codex: mcp:{server}/{tool}
  else if (name.startsWith('mcp:')) {
    const withoutPrefix = name.slice(4);
    const slashIdx = withoutPrefix.indexOf('/');
    name = slashIdx > 0 ? withoutPrefix.slice(slashIdx + 1) : withoutPrefix;
  }

  // Server prefix on tool name itself (e.g. cat_cafe_search_evidence)
  if (name.startsWith('cat_cafe_')) {
    name = name.slice('cat_cafe_'.length);
  }

  return name;
}
