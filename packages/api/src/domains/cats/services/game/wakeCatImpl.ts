/**
 * WakeCatFn production implementation — bridges GameNarratorDriver → A2A dispatch.
 *
 * Flow: wakeCat(catId, briefing) → InvocationQueue → CLI session
 * Briefing is delivered via InvocationQueue.content (not messageStore) to prevent
 * leaking game secrets (e.g. "你是狼人") into the thread chat flow.
 */

import type { CatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { InvocationQueue } from '../agents/invocation/InvocationQueue.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { WakeCatFn } from './GameNarratorDriver.js';

export interface QueueProcessorLike {
  tryAutoExecute(threadId: string): Promise<void>;
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
    const { threadId, catId, briefing } = params;

    const thread = await threadStore.get(threadId);
    const userId = thread?.createdBy ?? 'default-user';

    const result = invocationQueue.enqueue({
      threadId,
      userId,
      content: briefing,
      source: 'agent',
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
    });

    if (result.outcome === 'full') {
      log.warn({ threadId, catId, gameWake: true }, '[F101] wakeCat: queue full');
      return;
    }

    await queueProcessor.tryAutoExecute(threadId);

    log.info(
      { threadId, catId, outcome: result.outcome, entryId: result.entry?.id, gameWake: true },
      '[F101] wakeCat: cat enqueued for game action',
    );
  };
}
