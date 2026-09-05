import { type OwnerTruthRefV1, ownerTruthRefV1Schema } from '@cat-cafe/shared';

export const PROGRAM_ADAPTER_CAPABILITIES = [
  'observe',
  'permission',
  'mutate',
  'verify',
  'writeback',
  'fresh-outcome',
  'rollback',
] as const;

export type ProgramAdapterCapability = (typeof PROGRAM_ADAPTER_CAPABILITIES)[number];

export interface ProgramAdapterDescriptorV1 {
  schemaVersion: 1;
  adapterId: string;
  adapterOwnerRef: OwnerTruthRefV1;
  targetOwnerFeatureId: string;
  targetStateRefPrefix: string;
  capabilities: readonly ProgramAdapterCapability[];
}

/**
 * Registry membership only depends on the stable descriptor and the seven external-owner verbs.
 * Each owner adapter keeps its own typed payload contract; F311 never widens its Program schema to
 * accommodate an object's fields.
 */
export type ProgramAdapterOperation = (input: never) => unknown;

export type ProgramAdapter = {
  descriptor: ProgramAdapterDescriptorV1;
  observe: ProgramAdapterOperation;
  permission: ProgramAdapterOperation;
  mutate: ProgramAdapterOperation;
  verify: ProgramAdapterOperation;
  writeback: ProgramAdapterOperation;
  freshOutcome: ProgramAdapterOperation;
  rollback: ProgramAdapterOperation;
  manifest?: ProgramAdapterOperation;
  media?: ProgramAdapterOperation;
};

export type ProgramAdapterResolution =
  | { status: 'resolved'; adapter: ProgramAdapter }
  | { status: 'blocked'; code: 'owner_adapter_missing'; targetRef: OwnerTruthRefV1 };

function normalizedDescriptor(adapter: ProgramAdapter): ProgramAdapterDescriptorV1 {
  const descriptor = adapter.descriptor;
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.adapterId.trim().length === 0 ||
    descriptor.targetOwnerFeatureId.trim().length === 0 ||
    !/^[a-z][a-z0-9-]*:[^\s{}[\]"']*$/.test(descriptor.targetStateRefPrefix)
  ) {
    throw new Error('program adapter requires a complete v1 descriptor');
  }
  ownerTruthRefV1Schema.parse(descriptor.adapterOwnerRef);
  const capabilitySet = new Set(descriptor.capabilities);
  if (
    capabilitySet.size !== PROGRAM_ADAPTER_CAPABILITIES.length ||
    PROGRAM_ADAPTER_CAPABILITIES.some((capability) => !capabilitySet.has(capability))
  ) {
    throw new Error('program adapter must declare all required capabilities exactly once');
  }
  const operationFor: Record<ProgramAdapterCapability, keyof ProgramAdapter> = {
    observe: 'observe',
    permission: 'permission',
    mutate: 'mutate',
    verify: 'verify',
    writeback: 'writeback',
    'fresh-outcome': 'freshOutcome',
    rollback: 'rollback',
  };
  if (PROGRAM_ADAPTER_CAPABILITIES.some((capability) => typeof adapter[operationFor[capability]] !== 'function')) {
    throw new Error('program adapter must implement all required capabilities');
  }
  return descriptor;
}

function namespacesOverlap(left: ProgramAdapterDescriptorV1, right: ProgramAdapterDescriptorV1): boolean {
  if (left.targetOwnerFeatureId !== right.targetOwnerFeatureId) return false;
  return (
    left.targetStateRefPrefix.startsWith(right.targetStateRefPrefix) ||
    right.targetStateRefPrefix.startsWith(left.targetStateRefPrefix)
  );
}

export class ProgramAdapterRegistry {
  readonly #adapters: ProgramAdapter[] = [];

  register(adapter: ProgramAdapter): void {
    const descriptor = normalizedDescriptor(adapter);
    if (this.#adapters.some((registered) => registered.descriptor.adapterId === descriptor.adapterId)) {
      throw new Error(`program adapter ${descriptor.adapterId} is already registered`);
    }
    const conflicting = this.#adapters.find((registered) => namespacesOverlap(registered.descriptor, descriptor));
    if (conflicting) {
      throw new Error(
        `program adapter namespace ${descriptor.targetOwnerFeatureId}:${descriptor.targetStateRefPrefix} overlaps ${conflicting.descriptor.adapterId}`,
      );
    }
    Object.freeze(descriptor.adapterOwnerRef);
    Object.freeze(descriptor.capabilities);
    Object.freeze(descriptor);
    Object.freeze(adapter);
    this.#adapters.push(adapter);
  }

  resolve(targetRef: OwnerTruthRefV1): ProgramAdapterResolution {
    const adapter = this.#adapters.find(
      (candidate) =>
        candidate.descriptor.targetOwnerFeatureId === targetRef.ownerFeatureId &&
        targetRef.ownerStateRef.startsWith(candidate.descriptor.targetStateRefPrefix),
    );
    return adapter ? { status: 'resolved', adapter } : { status: 'blocked', code: 'owner_adapter_missing', targetRef };
  }
}
