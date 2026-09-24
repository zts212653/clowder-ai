import { type CatConfig, catRegistry, formatCatDisplayName } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { HOLD_BALL_SOURCE } from './hold-ball-source.js';

export interface HoldTerminalVisibilityInput {
  readonly taskId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly outcome: string;
  readonly content: string;
  readonly idempotencySuffix?: string;
}

/**
 * Hold notifications are part of the human timeline, so internal cat ids must
 * stay in structured metadata instead of leaking into prose. Variant labels
 * distinguish parallel members that share a family display name.
 */
type HoldOwnerDisplayConfig = Pick<CatConfig, 'displayName' | 'variantLabel'>;

export function formatHoldOwnerName(
  catId: string,
  config: HoldOwnerDisplayConfig | undefined = catRegistry.tryGet(catId)?.config,
): string {
  if (!config) return '该成员';
  return formatCatDisplayName(config);
}

/**
 * Persist one owner-visible hold terminal fact and recover a commit whose append
 * acknowledgement was lost. Socket delivery is only a live projection; History
 * remains the durable truth and therefore succeeds independently of broadcast.
 */
export async function persistHoldTerminalVisibility(
  deps: { messageStore: IMessageStore; socketManager: SocketManager },
  input: HoldTerminalVisibilityInput,
): Promise<StoredMessage> {
  const idempotencyKey = `hold-ball-terminal:${input.taskId}:${input.idempotencySuffix ?? input.outcome}`;
  const source = {
    ...HOLD_BALL_SOURCE,
    meta: {
      managedHold: true,
      phase: 'terminal',
      cancelable: false,
      taskId: input.taskId,
      threadId: input.threadId,
      catId: input.catId,
      outcome: input.outcome,
    },
  } as const;

  let stored: StoredMessage;
  try {
    stored = await deps.messageStore.append({
      from: { kind: 'system', service: 'hold-ball' },
      userId: input.userId,
      content: input.content,
      mentions: [],
      timestamp: Date.now(),
      threadId: input.threadId,
      idempotencyKey,
      source,
    });
  } catch (appendError) {
    try {
      const committed = await deps.messageStore.getByIdempotencyKey(input.userId, input.threadId, idempotencyKey);
      if (!committed) throw appendError;
      stored = committed;
    } catch (lookupError) {
      if (lookupError === appendError) throw appendError;
      throw new AggregateError([appendError, lookupError], 'hold terminal History outcome is unknown');
    }
  }

  try {
    deps.socketManager.broadcastToRoom(`thread:${input.threadId}`, 'connector_message', {
      threadId: input.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: stored.content,
        source: stored.source,
        timestamp: stored.timestamp,
      },
    });
  } catch {
    // Durable History already owns the fact. A later history read repairs live UI.
  }
  return stored;
}
