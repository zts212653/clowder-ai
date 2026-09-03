import {
  PHASE_B_NEEDS_ME_PRODUCER_IDS,
  type PhaseBNeedsMeProducerId,
  type ProducerAttentionReceiptV1,
} from '@cat-cafe/shared';
import type {
  NeedsMeProducerAdapter,
  NeedsMeProducerReevaluateInput,
  NeedsMeProducerReevaluationResult,
} from './NeedsMeProducerAdapter.js';

/** Closed Phase B catalog. Adding a producer requires a shared ID, owner adapter, and contract coverage together. */
export class NeedsMeProducerCatalog {
  private readonly adapters: ReadonlyMap<PhaseBNeedsMeProducerId, NeedsMeProducerAdapter>;

  constructor(adapters: readonly NeedsMeProducerAdapter[]) {
    const byId = new Map(adapters.map((adapter) => [adapter.producerId, adapter]));
    const missing = PHASE_B_NEEDS_ME_PRODUCER_IDS.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`Needs Me producer bindings missing: ${missing.join(', ')}`);
    if (byId.size !== PHASE_B_NEEDS_ME_PRODUCER_IDS.length || adapters.length !== byId.size) {
      throw new Error('Needs Me producer bindings contain a duplicate or unsupported producer');
    }
    this.adapters = byId;
  }

  get(producerId: PhaseBNeedsMeProducerId): NeedsMeProducerAdapter {
    const adapter = this.adapters.get(producerId);
    if (!adapter) throw new Error(`Needs Me producer is not registered: ${producerId}`);
    return adapter;
  }

  async listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]> {
    const receipts = (
      await Promise.all([...this.adapters.values()].map((adapter) => adapter.listCurrentReceipts(ownerUserId)))
    ).flat();
    const seen = new Set<string>();
    for (const receipt of receipts) {
      const key = [receipt.producer.producerId, receipt.producer.subjectRef, receipt.taskRef.subjectRef].join('\u0000');
      if (seen.has(key)) throw new Error('Needs Me producer catalog returned a duplicate producer/Task receipt');
      seen.add(key);
    }
    return receipts;
  }

  reEvaluate(
    producerId: PhaseBNeedsMeProducerId,
    input: NeedsMeProducerReevaluateInput,
  ): Promise<NeedsMeProducerReevaluationResult> {
    return this.get(producerId).reEvaluate(input);
  }
}
