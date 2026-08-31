/** LI-005: bridge Claude user-turn MCP results into the shared message contract. */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

export function transformClaudeToolResultEvent(event: Record<string, unknown>, catId: CatId): AgentMessage[] | null {
  const blocks = (event.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(blocks)) return null;

  const messages: AgentMessage[] = [];
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== 'tool_result') continue;

    let content: string | undefined;
    if (typeof block.content === 'string') {
      content = block.content;
    } else if (Array.isArray(block.content)) {
      content = (block.content as Array<Record<string, unknown>>)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('');
    }

    const message: AgentMessage = {
      type: 'tool_result',
      catId,
      content,
      timestamp: Date.now(),
      toolResultStatus: block.is_error === true ? 'error' : 'ok',
    };
    if (typeof block.tool_use_id === 'string') message.toolUseId = block.tool_use_id;
    messages.push(message);
  }

  return messages.length > 0 ? messages : null;
}
