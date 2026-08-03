import {
  APPROVAL_PRODUCER_CATALOG,
  APPROVAL_PRODUCER_IDS,
  type ApprovalProducerCatalogEntry,
  type ApprovalProducerId,
} from '@cat-cafe/shared';
import type { IApprovalAdapter } from './ports/IApprovalAdapter.js';

export interface ApprovalProducerRuntimeBinding {
  adapter: IApprovalAdapter;
}

export type ApprovalProducerRuntimeBindings = Record<ApprovalProducerId, ApprovalProducerRuntimeBinding>;

export type ApprovalProducerManifestEntry = ApprovalProducerCatalogEntry & { id: ApprovalProducerId };

export class ApprovalProducerRegistry {
  private readonly bindings: ApprovalProducerRuntimeBindings;

  constructor(bindings: ApprovalProducerRuntimeBindings) {
    const keys = Object.keys(bindings);
    const missing = APPROVAL_PRODUCER_IDS.filter((id) => !keys.includes(id));
    const extra = keys.filter((id) => !APPROVAL_PRODUCER_IDS.includes(id as ApprovalProducerId));
    if (missing.length > 0) throw new Error(`Approval producer bindings missing: ${missing.join(', ')}`);
    if (extra.length > 0) throw new Error(`Approval producer bindings contain extra keys: ${extra.join(', ')}`);

    for (const id of APPROVAL_PRODUCER_IDS) {
      const adapterId = bindings[id].adapter.featureId;
      if (adapterId !== id) {
        throw new Error(`Approval producer binding ${id} contains adapter ${adapterId}`);
      }
    }
    this.bindings = bindings;
  }

  get(id: ApprovalProducerId): ApprovalProducerRuntimeBinding {
    return this.bindings[id];
  }

  listAdapters(): IApprovalAdapter[] {
    return APPROVAL_PRODUCER_IDS.map((id) => this.bindings[id].adapter);
  }

  manifest(): ReadonlyArray<ApprovalProducerManifestEntry> {
    return APPROVAL_PRODUCER_IDS.map((id) => ({ id, ...APPROVAL_PRODUCER_CATALOG[id] }));
  }
}
