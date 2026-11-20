import { createCatId } from '@cat-cafe/shared';
import type { AgentAccessClaudeMessage } from '@clowder-ai/agent-contract/claude';
import { agentAccessClaudeBatchSchema } from '@clowder-ai/agent-contract/claude';
import { transformClaudeEvent } from './claude-ndjson-parser.js';

export function projectClaudeBatch(raw: unknown) {
  const { catId: role, mode, entries, lastTextMessageId } = agentAccessClaudeBatchSchema.parse(raw);
  const catId = createCatId(role);
  const state = {
    currentMessageId: undefined as string | undefined,
    partialTextMessageIds: new Set<string>(),
    lastTurnInputTokens: undefined as number | undefined,
    thinkingBuffer: '',
    textBoundaryState: { lastTextMessageId },
  };
  const frames = entries.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const entry = value as Record<string, unknown>;
    let projected: AgentAccessClaudeMessage | AgentAccessClaudeMessage[] | null = null;
    if (mode === 'transcript' && entry.type === 'assistant') {
      projected = transformClaudeEvent(entry, catId, state);
    } else if (
      mode === 'hook' &&
      entry.hook_event_name === 'Stop' &&
      typeof entry.last_assistant_message === 'string'
    ) {
      projected = { type: 'text', catId, content: entry.last_assistant_message, timestamp: Date.now() };
    } else if (mode === 'hook' && entry.hook_event_name === 'PostToolUse' && typeof entry.tool_name === 'string') {
      const input = entry.tool_input;
      projected = {
        type: 'tool_use',
        catId,
        toolName: entry.tool_name,
        toolInput:
          input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
        toolUseId: typeof entry.tool_use_id === 'string' ? entry.tool_use_id : undefined,
        timestamp: Date.now(),
      };
    }
    if (!projected) return [];
    return (Array.isArray(projected) ? projected : [projected]).map((message) => ({ index, message }));
  });
  return { frames, lastTextMessageId: state.textBoundaryState.lastTextMessageId };
}
