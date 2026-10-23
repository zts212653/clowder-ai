import {
  NEEDS_ME_PRODUCER_IDS,
  type NeedsMeProducerId,
  type ProducerAttentionCoverageV1,
  type ProducerAttentionReceiptV1,
} from '@cat-cafe/shared';
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
    this.assertUniqueReceipts(receipts);
    return receipts;
  }

  /** Isolated aggregate for owner reads: healthy producers remain readable while failures stay explicit. */
  async readCurrentReceipts(ownerUserId: string): Promise<{
    receipts: ProducerAttentionReceiptV1[];
    coverage: ProducerAttentionCoverageV1;
  }> {
    const entries = [...this.adapters.entries()];
    const settled = await Promise.allSettled(entries.map(([, adapter]) => adapter.listCurrentReceipts(ownerUserId)));
    const receipts: ProducerAttentionReceiptV1[] = [];
    const unavailableSources: Extract<ProducerAttentionCoverageV1, { state: 'partial' }>['unavailableSources'] = [];
    settled.forEach((result, index) => {
      const entry = entries[index];
      if (!entry) throw new Error('Needs Me producer settlement lost its source coordinate');
      const [producerId] = entry;
      if (result.status === 'fulfilled') {
        receipts.push(...result.value);
        return;
      }
      unavailableSources.push({
        producerId,
        status: 'unavailable',
        reason: classifyReadFailure(result.reason),
      });
    });
    this.assertUniqueReceipts(receipts);
    unavailableSources.sort((left, right) => left.producerId.localeCompare(right.producerId));
    return {
      receipts,
      coverage: unavailableSources.length > 0 ? { state: 'partial', unavailableSources } : { state: 'complete' },
    };
  }

  private assertUniqueReceipts(receipts: readonly ProducerAttentionReceiptV1[]): void {
    const seen = new Set<string>();
    for (const receipt of receipts) {
      const key = [receipt.producer.producerId, receipt.producer.subjectRef, receipt.taskRef.subjectRef].join('\u0000');
      if (seen.has(key)) throw new Error('Needs Me producer catalog returned a duplicate producer/Task receipt');
      seen.add(key);
    }
  }

  reEvaluate(
    producerId: NeedsMeProducerId,
    input: NeedsMeProducerReevaluateInput,
  ): Promise<NeedsMeProducerReevaluationResult> {
    return this.get(producerId).reEvaluate(input);
  }
}

function classifyReadFailure(
  error: unknown,
): Extract<ProducerAttentionCoverageV1, { state: 'partial' }>['unavailableSources'][number]['reason'] {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('incomplete')) return 'source_incomplete';
  if (message.includes('invalid')) return 'source_invalid';
  if (message.includes('unavailable')) return 'source_unavailable';
  return 'source_read_failed';
}
