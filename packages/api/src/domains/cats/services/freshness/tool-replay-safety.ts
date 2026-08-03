import { isReadOnlyMcpTool } from '../agents/providers/antigravity/antigravity-step-effects.js';
import { normalizeMcpToolName } from '../tool-usage/normalize-mcp-tool-name.js';

const READ_ONLY_NATIVE_TOOLS = new Set([
  'glob',
  'grep',
  'lsp',
  'ls',
  'read',
  'skill',
  'toolsearch',
  'webfetch',
  'websearch',
]);

const MAX_REPLAY_UNSAFE_TOOL_NAMES = 16;

/**
 * Blind replay is allowed only when every observed tool is reviewed read-only.
 * Unknown names fail closed because a provider may report success after a partial
 * external effect; the closure can still continue through explicit retry.
 */
export function findReplayUnsafeToolNames(toolNames: readonly string[]): string[] {
  const unsafe = new Set<string>();
  for (const rawName of toolNames) {
    const name = rawName.trim();
    if (!name) continue;
    if (isReadOnlyMcpTool(name) || isReadOnlyMcpTool(normalizeMcpToolName(name))) continue;
    if (READ_ONLY_NATIVE_TOOLS.has(name.toLowerCase())) continue;
    unsafe.add(name);
  }
  return [...unsafe].sort().slice(0, MAX_REPLAY_UNSAFE_TOOL_NAMES);
}
