import type { CatId } from '@cat-cafe/shared';
import { messageFrom } from '../../stores/message-from.js';
import type { AppendMessageInput, IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { CallerActivity } from './WorklistRegistry.js';
import { isSubstantiveTool } from './WorklistRegistry.js';

export interface DurableA2ALineage {
  /** Number of already-completed A2A edges before the receiving turn. */
  depth: number;
  /** Last unordered pair streak, replayed from persisted response ancestry. */
  streakPair?: { from: CatId; to: CatId; count: number };
}

const MAX_CAUSAL_SCAN = 256;
const SUBSTANTIVE_OUTPUT_LENGTH = 200;

function samePair(a: { from: CatId; to: CatId }, from: CatId, to: CatId): boolean {
  return (a.from === from && a.to === to) || (a.from === to && a.to === from);
}

export function callerActivityFromMessage(
  message: Pick<StoredMessage | AppendMessageInput, 'content' | 'toolEvents'>,
): CallerActivity {
  return {
    hadSubstantiveToolCall:
      message.toolEvents?.some(
        (event) => event.type === 'tool_use' && isSubstantiveTool(event.toolName ?? event.label),
      ) ?? false,
    outputLength: message.content.length,
  };
}

function isSubstantiveActivity(activity: CallerActivity): boolean {
  return activity.hadSubstantiveToolCall || activity.outputLength > SUBSTANTIVE_OUTPUT_LENGTH;
}

/**
 * Rebuild A2A depth and ping-pong state from the canonical response causal chain.
 * Each persisted response points at the message that woke it, so the guard survives
 * Queue drains, process restarts, and the removal of the old mutable inline worklist.
 */
export async function readDurableA2ALineage(
  store: Pick<IMessageStore, 'getById'>,
  triggerMessageId: string,
  receivingCatId: CatId,
): Promise<DurableA2ALineage> {
  const newestFirst: Array<{
    from: CatId;
    to: CatId;
    activity: CallerActivity;
  }> = [];
  const visited = new Set<string>();
  let cursorId: string | undefined = triggerMessageId;
  let recipient = receivingCatId;

  while (cursorId && newestFirst.length < MAX_CAUSAL_SCAN && !visited.has(cursorId)) {
    visited.add(cursorId);
    const message = await store.getById(cursorId);
    const from = message ? messageFrom(message) : null;
    const authorCatId = from?.kind === 'agent' ? from.catId : null;
    if (!message || message.lifecycle?.kind !== 'response' || !authorCatId) break;
    newestFirst.push({
      from: authorCatId as CatId,
      to: recipient,
      activity: callerActivityFromMessage(message),
    });
    recipient = authorCatId as CatId;
    cursorId = message.extra?.causal?.triggerMessageId;
  }

  let streakPair: DurableA2ALineage['streakPair'];
  for (const edge of newestFirst.reverse()) {
    const count =
      streakPair && samePair(streakPair, edge.from, edge.to) && !isSubstantiveActivity(edge.activity)
        ? streakPair.count + 1
        : 1;
    streakPair = { from: edge.from, to: edge.to, count };
  }

  return {
    depth: newestFirst.length,
    ...(streakPair ? { streakPair } : {}),
  };
}
