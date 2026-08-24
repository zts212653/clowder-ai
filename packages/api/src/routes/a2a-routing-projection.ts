/**
 * F086/F216: the single place that turns an A2A dispatch decision into the user-visible
 * routing pill ("A → B").
 *
 * Both dispatch families write through here so the projection can never disagree with the
 * scheduling mode that actually ran:
 *  - serial   — route-serial.ts yields `a2a_handoff` events for an ordered worklist; the
 *               SSE/message routes persist them via `persistA2ARoutingMessage`.
 *  - parallel — the multi-mention callback route fans out N independent Queue entries and
 *               calls `emitParallelRoutingPills` for the same projection surface.
 *
 * Before this module existed the parallel path emitted no pill at all and the serial path
 * emitted N identical "→" pills at the same millisecond — so a sequential worklist and a real
 * fan-out were indistinguishable to the reader (#1291).
 */

import type { A2ARoutingProjection, CatId } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { formatA2AHandoffContent } from '../domains/cats/services/agents/routing/a2a-handoff-label.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface A2ARoutingPillInput {
  catId?: string;
  content?: string;
  invocationId?: string;
  targetCatId?: string;
  /** Structured serial-vs-parallel scheduling mode for this leg. */
  routing?: A2ARoutingProjection;
  timestamp: number;
}

/**
 * Persist one routing pill as a system message so a page reload projects the same scheduling
 * truth the live socket stream showed.
 */
export async function persistA2ARoutingMessage(
  messageStore: IMessageStore,
  msg: A2ARoutingPillInput,
  threadId: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<string | undefined> {
  if (!msg.content) return undefined;
  try {
    const stored = await messageStore.append({
      userId: 'system',
      catId: null,
      content: msg.content,
      mentions: [],
      timestamp: msg.timestamp,
      threadId,
      extra: {
        systemKind: 'a2a_routing',
        a2aRouting: {
          fromCatId: msg.catId,
          targetCatId: msg.targetCatId,
          invocationId: msg.invocationId,
          ...(msg.routing ? { routing: msg.routing } : {}),
        },
      },
    });
    return stored.id;
  } catch (err) {
    log.warn({ err, threadId }, 'Failed to persist a2a_handoff');
    return undefined;
  }
}

/**
 * Emit one `parallel` routing pill per fanned-out target.
 *
 * Fire-and-forget by contract, and the CALLER must honour that by not awaiting this before
 * starting work: persistence is awaited per target inside here, so any caller that awaits the
 * whole thing in front of `tryAutoExecute` converts a slow store into a scheduling stall
 * (砚砚 R2 P1). The pill is a projection, not custody — losing one costs a UI line, nothing more.
 *
 * `targetCatIds` MUST be the targets that actually obtained custody, never the requested list.
 */
export async function emitParallelRoutingPills(input: {
  messageStore?: IMessageStore;
  socketManager: Pick<SocketManager, 'broadcastAgentMessage'>;
  threadId: string;
  fromCatId: CatId;
  targetCatIds: readonly CatId[];
  log: FastifyBaseLogger;
}): Promise<void> {
  const { messageStore, socketManager, threadId, fromCatId, targetCatIds, log } = input;
  if (targetCatIds.length === 0) return;
  const fromConfig = catRegistry.tryGet(fromCatId as string)?.config;
  const total = targetCatIds.length;

  // 砚砚 R3 P1 — SNAPSHOT THE WHOLE BATCH SYNCHRONOUSLY, BEFORE ANY AWAIT.
  // Building each leg inside the persistence loop meant leg N's `Date.now()` was taken only after
  // leg N-1's write settled. With a 25ms-slow first write the probe observed
  // `pill1.ts < firstStream.ts < pill2.ts`, so the frontend's timestamp-aware insert could rescue
  // the first pill but not the second — the fan-out rendered AFTER the output it announces. A
  // never-settling first write starved every later sibling's pill entirely.
  // One shared timestamp is also the honest value here: a real fan-out genuinely starts together
  // (same-ms handoffs are already de-duplicated by a monotonic seq on the client).
  const startedAt = Date.now();
  const legs = targetCatIds.map((targetCatId, i) => {
    const routing: A2ARoutingProjection = { mode: 'parallel', index: i + 1, total };
    const toConfig = catRegistry.tryGet(targetCatId as string)?.config;
    return {
      targetCatId,
      routing,
      content: formatA2AHandoffContent(fromCatId, targetCatId, fromConfig, toConfig, routing),
      timestamp: startedAt,
    };
  });

  // Each leg persists + broadcasts independently: one slow or failing sibling must not delay,
  // reorder, or suppress the others.
  await Promise.all(
    legs.map(async ({ targetCatId, routing, content, timestamp }) => {
      const pill: A2ARoutingPillInput = { catId: fromCatId, content, targetCatId, routing, timestamp };
      const messageId = messageStore ? await persistA2ARoutingMessage(messageStore, pill, threadId, log) : undefined;
      socketManager.broadcastAgentMessage(
        {
          type: 'a2a_handoff',
          catId: fromCatId,
          content,
          targetCatId,
          routing,
          timestamp,
          ...(messageId ? { messageId } : {}),
        },
        threadId,
      );
    }),
  );
}
