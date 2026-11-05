/**
 * Private briefing wake-up via the durable invocation queue.
 *
 * Flow: wakeCat(catId, briefing) → InvocationQueue → CLI session
 * Briefing is delivered via InvocationQueue.content (not messageStore) to prevent
 * leaking private operational context into the thread chat flow.
 */

import { createHash } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { InvocationQueue } from './InvocationQueue.js';
export type WakeCatFn = (params: {
  threadId: string;
  catId: CatId;
  briefing: string;
  timeoutMs: number;
}) => Promise<void>;

export interface QueueProcessorLike {
  requestDrain(threadId: string): Promise<void>;
}

export interface WakeCatDeps {
  threadStore: IThreadStore;
  invocationQueue: InvocationQueue;
  queueProcessor: QueueProcessorLike;
  log: FastifyBaseLogger;
}

export function createWakeCatFn(deps: WakeCatDeps): WakeCatFn {
  const { threadStore, invocationQueue, queueProcessor, log } = deps;

  return async (params: { threadId: string; catId: CatId; briefing: string; timeoutMs: number }): Promise<void> => {
    const { threadId, catId, briefing, timeoutMs } = params;

    const thread = await threadStore.get(threadId);
    const userId = thread?.createdBy ?? 'default-user';

    const result = await invocationQueue.enqueueDurable({
      // Historical namespace is stable for durable queue provenance and deduplication.
      from: { kind: 'system', service: 'game-orchestrator' },
      threadId,
      userId,
      kind: 'private_input',
      ownerAuthProvenance: 'unknown',
      content: briefing,
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
      sourceId: `game:${threadId}:${catId}:${createHash('sha256').update(briefing).digest('hex')}`,
    });

    if (result.outcome === 'full') {
      log.warn({ threadId, catId, privateWake: true }, 'wakeCat: queue full');
      return;
    }

    await queueProcessor.requestDrain(threadId);

    log.info(
      {
        threadId,
        catId,
        outcome: result.outcome,
        entryId: result.entry?.id,
        timeoutMs,
        briefingLen: briefing.length,
        privateWake: true,
      },
      'wakeCat: cat enqueued for private briefing',
    );
  };
}
