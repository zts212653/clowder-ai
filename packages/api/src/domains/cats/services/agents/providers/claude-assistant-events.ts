import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';
import { type ClaudeStreamState, claudeToolUse } from './claude-tool-events.js';

export function claudeAssistantEvents(
  event: Record<string, unknown>,
  catId: CatId,
  state: ClaudeStreamState,
): AgentMessage | AgentMessage[] | null {
  const message = event.message as Record<string, unknown> | undefined;
  const messageId = typeof message?.id === 'string' ? message.id : undefined;
  const skipFinalText = Boolean(messageId && state.partialTextMessageIds.has(messageId));
  if (!Array.isArray(message?.content)) return null;
  const content = message.content as unknown[];
  const hasTextBlock = content.some((block) => {
    if (typeof block !== 'object' || block === null) return false;
    const value = block as Record<string, unknown>;
    return value.type === 'text' && typeof value.text === 'string' && value.text.length > 0;
  });
  if (message?.model === '<synthetic>') {
    const syntheticText = content.find((block) => {
      if (typeof block !== 'object' || block === null) return false;
      const value = block as Record<string, unknown>;
      return value.type === 'text' && typeof value.text === 'string';
    }) as { text: string } | undefined;
    const text = syntheticText?.text ?? '';
    if (text.startsWith('API Error:') || text.startsWith('Error:')) {
      return { type: 'error', catId, error: text, errorDisposition: 'transient', timestamp: Date.now() };
    }
    return null;
  }
  const messages: AgentMessage[] = [];
  for (const value of content) {
    if (typeof value !== 'object' || value === null) continue;
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      if (!skipFinalText) messages.push({ type: 'text', catId, content: block.text, timestamp: Date.now() });
    } else if (block.type === 'tool_use') {
      const tool = claudeToolUse(block, event, catId, state);
      if (tool) messages.push(tool);
    }
  }
  // Only a text-bearing final snapshot closes partial-text dedup state (#1272).
  if (messageId && skipFinalText && hasTextBlock) state.partialTextMessageIds.delete(messageId);
  if (messages.length === 0) {
    const thinking = content.find(
      (block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'thinking',
    ) as { thinking?: string; text?: string } | undefined;
    if (thinking) {
      return {
        type: 'system_info',
        catId,
        timestamp: Date.now(),
        content: JSON.stringify({ type: 'thinking', catId, text: thinking.thinking ?? thinking.text ?? '' }),
      };
    }
  }
  return messages.length ? messages : null;
}
