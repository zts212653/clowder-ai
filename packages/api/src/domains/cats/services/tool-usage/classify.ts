/**
 * Tool Classification — F142
 * Classifies tool_use events into native / mcp / skill categories.
 */

export type ToolCategory = 'native' | 'mcp' | 'skill';

export interface ToolClassification {
  category: ToolCategory;
  /** For skills: the extracted skill name. For others: the raw toolName. */
  toolName: string;
  /** For MCP tools: the server name extracted from `mcp__{server}__...` */
  mcpServer?: string;
}

/**
 * Classify a tool_use event by its toolName and optional toolInput.
 *
 * Rules:
 * - toolName === 'Skill'  → skill; real name from toolInput.skill
 * - toolName starts with 'mcp__' → mcp; server from second segment
 * - everything else → native
 */
export function classifyTool(toolName: string, toolInput: Record<string, unknown> | undefined): ToolClassification {
  // Skill invocations
  if (toolName === 'Skill') {
    const skillName = toolInput && typeof toolInput.skill === 'string' ? toolInput.skill : 'unknown';
    return { category: 'skill', toolName: skillName };
  }

  // MCP tools: mcp__{serverName}__{toolName}
  if (toolName.startsWith('mcp__')) {
    const withoutPrefix = toolName.slice(5); // strip 'mcp__'
    const sepIdx = withoutPrefix.indexOf('__');
    const mcpServer = sepIdx > 0 ? withoutPrefix.slice(0, sepIdx) : withoutPrefix;
    return { category: 'mcp', toolName, mcpServer };
  }

  // Everything else is a native tool
  return { category: 'native', toolName };
}
