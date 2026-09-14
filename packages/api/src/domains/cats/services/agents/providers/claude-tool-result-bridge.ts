import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

function readToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter(
      (candidate): candidate is { type: 'text'; text: string } =>
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as Record<string, unknown>).type === 'text' &&
        typeof (candidate as Record<string, unknown>).text === 'string',
    )
    .map((candidate) => candidate.text)
    .join('');
}

/**
 * LI-005: Claude records MCP execution results as user-turn content blocks.
 * Convert only those blocks into the provider-neutral tool_result contract.
 */
export function bridgeClaudeToolResults(event: Record<string, unknown>, catId: CatId): AgentMessage[] | null {
  if (event.type !== 'user') return null;
  const blocks = (event.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(blocks)) return null;

  const messages: AgentMessage[] = [];
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== 'tool_result') continue;

    const message: AgentMessage = {
      type: 'tool_result',
      catId,
      content: readToolResultContent(block.content),
      timestamp: Date.now(),
      toolResultStatus: block.is_error === true ? 'error' : 'ok',
    };
    if (typeof block.tool_use_id === 'string') message.toolUseId = block.tool_use_id;
    messages.push(message);
  }
  return messages.length > 0 ? messages : null;
}
