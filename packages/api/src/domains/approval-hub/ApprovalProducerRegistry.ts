import {
  APPROVAL_PRODUCER_CATALOG,
  APPROVAL_PRODUCER_IDS,
  type ApprovalHubItem,
  type ApprovalProducerCatalogEntry,
  type ApprovalProducerId,
  type ApprovalWriterGeneration,
  normalizeApprovalLifecycleProjection,
  type SettledApprovalHubItem,
} from '@cat-cafe/shared';
import type { IApprovalAdapter } from './ports/IApprovalAdapter.js';

export interface ApprovalProducerRuntimeBinding {
  adapter: IApprovalAdapter;
  lifecycle: {
    contractVersion: 1;
    writerGeneration: ApprovalWriterGeneration;
  };
}

export type ApprovalProducerRuntimeBindings = Record<ApprovalProducerId, ApprovalProducerRuntimeBinding>;

export function bindLegacyApprovalProducer(adapter: IApprovalAdapter): ApprovalProducerRuntimeBinding {
  return { adapter, lifecycle: { contractVersion: 1, writerGeneration: 'legacy' } };
}

export function bindV1ApprovalProducer(adapter: IApprovalAdapter): ApprovalProducerRuntimeBinding {
  return { adapter, lifecycle: { contractVersion: 1, writerGeneration: 'v1' } };
}

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
      const adapter = bindings[id].adapter;
      const adapterId = adapter.featureId;
      if (adapterId !== id) {
        throw new Error(`Approval producer binding ${id} contains adapter ${adapterId}`);
      }
      if (APPROVAL_PRODUCER_CATALOG[id].history && typeof adapter.listSettled !== 'function') {
        throw new Error(`Approval producer ${id} declares history but its adapter omits listSettled`);
      }
      if (!bindings[id].lifecycle) {
        throw new Error(`Approval producer ${id} lifecycle binding is missing`);
      }
      if (bindings[id].lifecycle.contractVersion !== APPROVAL_PRODUCER_CATALOG[id].lifecycleVersion) {
        throw new Error(`Approval producer ${id} lifecycle contract version mismatch`);
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

  async listPending(userId: string): Promise<ApprovalHubItem[]> {
    const items = await Promise.all(APPROVAL_PRODUCER_IDS.map((id) => this.listPendingFor(id, userId)));
    return items.flat();
  }

  async listPendingFor(id: ApprovalProducerId, userId: string): Promise<ApprovalHubItem[]> {
    return (await this.bindings[id].adapter.listPending(userId)).map((item) => normalizePendingItem(id, item));
  }

  async listSettled(userId: string, limit: number): Promise<SettledApprovalHubItem[]> {
    const items = await Promise.all(APPROVAL_PRODUCER_IDS.map((id) => this.listSettledFor(id, userId, limit)));
    return items.flat();
  }

  async listSettledFor(id: ApprovalProducerId, userId: string, limit: number): Promise<SettledApprovalHubItem[]> {
    const adapter = this.bindings[id].adapter;
    if (!adapter.listSettled) return [];
    return (await adapter.listSettled(userId, { limit })).map((item) => normalizeSettledItem(id, item));
  }

  manifest(): ReadonlyArray<ApprovalProducerManifestEntry> {
    return APPROVAL_PRODUCER_IDS.map((id) => ({ id, ...APPROVAL_PRODUCER_CATALOG[id] }));
  }
}

function canonicalEffectProofRef(detail: Record<string, unknown>): string | undefined {
  const value = detail.canonicalEffectProofRef;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizePendingItem(
  producerId: ApprovalProducerId,
  item: Awaited<ReturnType<IApprovalAdapter['listPending']>>[number],
): ApprovalHubItem {
  if (item.sourceFeatureId !== producerId) {
    throw new Error(`Approval producer ${producerId} returned item for ${item.sourceFeatureId}`);
  }
  const lifecycle = normalizeApprovalLifecycleProjection({
    status: item.status,
    ...(canonicalEffectProofRef(item.detail) ? { canonicalEffectProofRef: canonicalEffectProofRef(item.detail) } : {}),
  });
  const { status: _legacyStatus, decisionMode: legacyDecisionMode, ...rest } = item;
  const decisionMode = legacyDecisionMode === 'resume-only' ? undefined : legacyDecisionMode;
  return {
    ...rest,
    inlineApprovable: lifecycle.resolution === 'open' ? rest.inlineApprovable : false,
    ...(decisionMode ? { decisionMode } : {}),
    ...lifecycle,
  };
}

function normalizeSettledItem(
  producerId: ApprovalProducerId,
  item: Awaited<ReturnType<NonNullable<IApprovalAdapter['listSettled']>>>[number],
): SettledApprovalHubItem {
  if (item.sourceFeatureId !== producerId) {
    throw new Error(`Approval producer ${producerId} returned settled item for ${item.sourceFeatureId}`);
  }
  const lifecycle = normalizeApprovalLifecycleProjection({
    status: item.status,
    ...(canonicalEffectProofRef(item.detail) ? { canonicalEffectProofRef: canonicalEffectProofRef(item.detail) } : {}),
  });
  const { status: _legacyStatus, decisionMode: legacyDecisionMode, ...rest } = item;
  const decisionMode = legacyDecisionMode === 'resume-only' ? undefined : legacyDecisionMode;
  return { ...rest, ...(decisionMode ? { decisionMode } : {}), ...lifecycle };
}
