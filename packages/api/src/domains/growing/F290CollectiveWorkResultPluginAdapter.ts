import { isDeepStrictEqual } from 'node:util';
import type { ProducerAttentionReceiptV1 } from '@cat-cafe/shared';
import {
  type CollectiveWorkResultAttentionSource,
  readCollectiveWorkResultAttention,
} from '../plugin/host-surface/collective-work-result-attention.js';
import type {
  NeedsMeProducerAdapter,
  NeedsMeProducerReadInput,
  NeedsMeProducerReevaluateInput,
  NeedsMeProducerReevaluationResult,
} from './NeedsMeProducerAdapter.js';

/** Generic Host adapter only; F290 Work/Connector/Task decisions stay in the installed plugin. */
export class F290CollectiveWorkResultPluginAdapter implements NeedsMeProducerAdapter {
  readonly producerId = 'f290.collective_work_result' as const;

  constructor(private readonly source: CollectiveWorkResultAttentionSource | undefined) {}

  listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]> {
    return readCollectiveWorkResultAttention(this.source, ownerUserId);
  }

  async readCurrentReceipt(input: NeedsMeProducerReadInput): Promise<ProducerAttentionReceiptV1 | null> {
    if (!/^collective-result:con_[A-Za-z0-9_-]+:work_[A-Za-z0-9_-]+$/u.test(input.producerSubjectRef)) return null;
    return (
      (await this.listCurrentReceipts(input.ownerUserId)).find(
        (receipt) => receipt.producer.subjectRef === input.producerSubjectRef,
      ) ?? null
    );
  }

  async reEvaluate(input: NeedsMeProducerReevaluateInput): Promise<NeedsMeProducerReevaluationResult> {
    const current = await this.readCurrentReceipt(input);
    if (!current) return { state: 'retired', producerRevision: null };
    const exact =
      current.producer.subjectRef === input.producerSubjectRef &&
      current.producer.revision === input.expectedProducerRevision &&
      isDeepStrictEqual(current.taskRef, input.taskRef) &&
      current.reEvaluateActionRef === input.reEvaluateActionRef;
    if (!exact) return { state: 'stale', producerRevision: current.producer.revision };
    return { state: current.eligible ? 'unchanged' : 'retired', producerRevision: current.producer.revision };
  }
}
