import type { ProviderNativeFreshnessToolSurface } from '../../freshness/FreshnessAttentionEventLog.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function classifyToolName(name: string): ProviderNativeFreshnessToolSurface {
  if (/^(?:Bash|Shell|Terminal)$/i.test(name)) return 'command_execution';
  if (/^(?:Edit|Write|NotebookEdit|ApplyPatch)$/i.test(name)) return 'file_change';
  if (/^(?:mcp__|mcp:)/i.test(name)) return 'mcp_tool_call';
  return 'dynamic_tool_call';
}

/**
 * Claude stream output identifies tool completion by tool_use_id, so retain the
 * earlier assistant tool_use name until the matching user tool_result arrives.
 */
export class ClaudeNativeToolBoundaryClassifier {
  private readonly toolNames = new Map<string, string>();

  observe(event: unknown): ProviderNativeFreshnessToolSurface[] {
    const envelope = asRecord(event);
    const message = asRecord(envelope?.message);
    const content = message?.content;
    if (!Array.isArray(content)) return [];

    if (envelope?.type === 'assistant') {
      for (const value of content) {
        const block = asRecord(value);
        if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          this.toolNames.set(block.id, block.name);
        }
      }
      return [];
    }

    if (envelope?.type !== 'user') return [];
    const completed: ProviderNativeFreshnessToolSurface[] = [];
    for (const value of content) {
      const block = asRecord(value);
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const name = this.toolNames.get(block.tool_use_id);
      if (!name) continue;
      this.toolNames.delete(block.tool_use_id);
      completed.push(classifyToolName(name));
    }
    return completed;
  }
}
