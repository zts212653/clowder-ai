import { memoryReadRefSchema } from '@cat-cafe/shared';
import type { ToolResult } from './file-tools.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
/** Coordinate projection only. Event records/revisions, selection and source reads stay with the owner. */
export function withEventReadRefs(result: ToolResult): ToolResult {
  if (result.isError) return result;
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(result.content[0]?.text ?? ''));
  } catch {
    return result;
  }
  if (!Array.isArray(data.events)) return result;
  const originalEvents = data.events;
  const events = originalEvents.map(record);
  const owner = events[0]?.ownerUserId;
  const sharedOwner = typeof owner === 'string' && events.every((event) => event.ownerUserId === owner);
  const projected = events.map((event, index) => {
    const parsed = memoryReadRefSchema.safeParse({
      kind: 'message',
      threadId: event.threadId,
      messageId: event.messageId,
    });
    if (!parsed.success) return originalEvents[index];
    const { threadId: _thread, messageId: _message, ownerUserId, ...rest } = event;
    return { ...rest, ...(!sharedOwner ? { ownerUserId } : {}), readRef: parsed.data };
  });
  return {
    ...result,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ...data, ...(sharedOwner ? { ownerUserId: owner } : {}), events: projected }),
      },
      ...result.content.slice(1),
    ],
  };
}
