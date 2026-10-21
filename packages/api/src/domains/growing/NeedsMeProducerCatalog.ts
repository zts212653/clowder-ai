import { NEEDS_ME_PRODUCER_IDS, type NeedsMeProducerId, type ProducerAttentionReceiptV1 } from '@cat-cafe/shared';
import type {
  NeedsMeProducerAdapter,
  NeedsMeProducerReevaluateInput,
  NeedsMeProducerReevaluationResult,
} from './NeedsMeProducerAdapter.js';

/** Closed runtime composition; known wire IDs may outlive their installed producer. */
export class NeedsMeProducerCatalog {
  private readonly adapters: ReadonlyMap<NeedsMeProducerId, NeedsMeProducerAdapter>;

  constructor(
    adapters: readonly NeedsMeProducerAdapter[],
    expectedProducerIds: readonly NeedsMeProducerId[] = NEEDS_ME_PRODUCER_IDS,
  ) {
    const expected = new Set(expectedProducerIds);
    if (
      expected.size !== expectedProducerIds.length ||
      expectedProducerIds.some((id) => !NEEDS_ME_PRODUCER_IDS.includes(id))
    ) {
      throw new Error('Needs Me composition contains a duplicate or unsupported producer');
    }
    const byId = new Map(adapters.map((adapter) => [adapter.producerId, adapter]));
    const missing = expectedProducerIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`Needs Me producer bindings missing: ${missing.join(', ')}`);
    if (adapters.length !== byId.size || adapters.some((adapter) => !expected.has(adapter.producerId))) {
      throw new Error('Needs Me producer bindings contain a duplicate or unsupported producer');
    }
    this.adapters = byId;
  }

  /** Historical reconciliation can observe absence without manufacturing an owner. */
  find(producerId: NeedsMeProducerId): NeedsMeProducerAdapter | null {
    return this.adapters.get(producerId) ?? null;
  }

  get(producerId: NeedsMeProducerId): NeedsMeProducerAdapter {
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
    producerId: NeedsMeProducerId,
    input: NeedsMeProducerReevaluateInput,
  ): Promise<NeedsMeProducerReevaluationResult> {
    return this.get(producerId).reEvaluate(input);
  }
}
