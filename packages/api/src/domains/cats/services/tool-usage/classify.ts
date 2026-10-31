/**
 * Tool Classification — F150 (#339)
 * Classifies tool_use events into native / mcp / skill categories.
 *
 * Handles multiple MCP naming conventions across providers:
 * - Claude Code: `mcp__{server}__{tool}`  (e.g. mcp__cat-cafe__cat_cafe_post_message)
 * - Codex:       `mcp:{server}/{tool}`    (e.g. mcp:cat-cafe/post_message)
 */

export type ToolCategory = 'native' | 'mcp' | 'skill';

export interface ToolClassification {
  category: ToolCategory;
  /** For skills: the extracted skill name. For others: the raw toolName. */
  toolName: string;
  /** For MCP tools: the server name (normalized across providers). */
  mcpServer?: string;
}

/**
 * Classify a tool_use event by its toolName and optional toolInput.
 *
 * Rules:
 * - toolName === 'Skill'          → skill; real name from toolInput.skill
 * - toolName starts with 'mcp__'  → mcp (Claude Code format)
 * - toolName starts with 'mcp:'   → mcp (Codex format)
 * - everything else               → native
 */
export function classifyTool(toolName: string, toolInput: Record<string, unknown> | undefined): ToolClassification {
  // Skill invocations
  if (toolName === 'Skill') {
    const skillName = toolInput && typeof toolInput.skill === 'string' ? toolInput.skill : 'unknown';
    return { category: 'skill', toolName: skillName };
  }

  // MCP tools — Claude Code format: mcp__{serverName}__{toolName}
  if (toolName.startsWith('mcp__')) {
    const withoutPrefix = toolName.slice(5); // strip 'mcp__'
    const sepIdx = withoutPrefix.indexOf('__');
    const mcpServer = sepIdx > 0 ? withoutPrefix.slice(0, sepIdx) : withoutPrefix;
    return { category: 'mcp', toolName, mcpServer };
  }

  // MCP tools — Codex format: mcp:{serverName}/{toolName}
  if (toolName.startsWith('mcp:')) {
    const withoutPrefix = toolName.slice(4); // strip 'mcp:'
    const slashIdx = withoutPrefix.indexOf('/');
    const mcpServer = slashIdx > 0 ? withoutPrefix.slice(0, slashIdx) : withoutPrefix;
    return { category: 'mcp', toolName, mcpServer };
  }

  // Everything else is a native tool
  return { category: 'native', toolName };
}

/**
 * F153 Phase J (KD-40): single source of truth for "is this an MCP tool name?".
 *
 * Recognizes 4 patterns:
 * - `mcp__{server}__{tool}` — Claude Code wrapping
 * - `mcp:{server}/{tool}`   — Codex wrapping
 * - `cat_cafe_*`            — bare cat-cafe MCP tool (emitted by some providers without wrapping)
 * - `signal_*`              — bare signal MCP tool
 *
 * Used by `span-helpers.ts` to decide whether to create a child `cat_cafe.tool_use` span.
 *
 * NOTE: This is intentionally wider than `classifyTool()` for span-emission purposes.
 * `classifyTool()` returns `native` for bare prefixes, which is a F150 design choice;
 * this helper does not change F150 behavior.
 */
export function isMcpToolName(toolName: string): boolean {
  return (
    toolName.startsWith('mcp__') ||
    toolName.startsWith('mcp:') ||
    toolName.startsWith('cat_cafe_') ||
    toolName.startsWith('signal_')
  );
}
