import { randomUUID } from 'node:crypto';
import { type ProducerAttentionReceiptV1, producerAttentionReceiptV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';
import { withOwnerOperationRequest } from '../carrier/plugin-owner-operation-context.js';
import type {
  InstalledPluginOperationResult,
  InstalledPluginOperations,
} from '../operations/plugin-operation-routes.js';

const sourceSchema = z
  .object({
    items: z.array(producerAttentionReceiptV1Schema).max(1_000),
    reasons: z.array(z.string()),
    state: z
      .object({
        coverage: z.literal('current_f290_collective_work_results'),
        startedAt: z.number().int().nonnegative(),
        observedAt: z.number().int().nonnegative(),
        status: z.enum(['available', 'unavailable']),
        exhaustiveness: z.enum(['complete', 'partial', 'unknown']),
      })
      .strict(),
  })
  .strict();

export type CollectiveWorkResultAttentionSource = (userId: string) => Promise<InstalledPluginOperationResult>;

/** Host supplies only its already-authenticated owner principal; the installed Work feature owns source discovery. */
export function createCollectiveWorkResultAttentionSource(
  operations: Pick<InstalledPluginOperations, 'runAction'>,
  ownerUserId: string,
): CollectiveWorkResultAttentionSource {
  return async (userId) => {
    if (userId !== ownerUserId) return { matched: true, status: 403, body: { error: 'Host owner required' } };
    const controller = new AbortController();
    const pluginId = 'official.collective-connector';
    const operationKey = 'work';
    const actionId = 'result-attention';
    try {
      return await withOwnerOperationRequest(
        {
          pluginId,
          operationKey,
          actionId,
          userId,
          requestId: randomUUID(),
          signal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
        },
        () => operations.runAction(pluginId, operationKey, actionId, {}),
      );
    } finally {
      controller.abort();
    }
  };
}

/** A genuinely absent plugin contributes no source. Installed older or unhealthy sources fail closed instead of becoming empty. */
export async function readCollectiveWorkResultAttention(
  source: CollectiveWorkResultAttentionSource | undefined,
  ownerUserId: string,
): Promise<ProducerAttentionReceiptV1[]> {
  if (!source) return [];
  const response = await source(ownerUserId);
  if (!response.matched) return [];
  if (response.status !== 200) throw new Error('Collective result attention source is unavailable');
  const parsed = sourceSchema.parse(response.body.data);
  if (parsed.state.status !== 'available' || parsed.state.exhaustiveness !== 'complete' || parsed.reasons.length > 0)
    throw new Error('Collective result attention source is incomplete');
  const seen = new Set<string>();
  for (const receipt of parsed.items) {
    if (
      !receipt.eligible ||
      receipt.producer.producerId !== 'f290.collective_work_result' ||
      !/^collective-result:con_[A-Za-z0-9_-]+:work_[A-Za-z0-9_-]+$/u.test(receipt.producer.subjectRef) ||
      receipt.producer.ownerRef !== receipt.producer.subjectRef ||
      seen.has(receipt.producer.subjectRef)
    )
      throw new Error('Collective result attention source returned an invalid identity');
    seen.add(receipt.producer.subjectRef);
  }
  return parsed.items;
}
