import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evolutionProgramV1Schema } from '@cat-cafe/shared';
import {
  PROGRAM_ADAPTER_CAPABILITIES,
  ProgramAdapterRegistry,
} from '../dist/infrastructure/capability-evolution/adapters/program-adapter-registry.js';

const target = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: 'simulator:pollen-robotics/microduck-simulator',
  version: 'space-revision-1',
};

function adapter(overrides = {}) {
  const blocked = async () => ({ status: 'blocked', code: 'owner_route_unavailable' });
  const { descriptor: descriptorOverrides = {}, ...operationOverrides } = overrides;
  return {
    descriptor: {
      schemaVersion: 1,
      adapterId: 'microduck-owner-v1',
      adapterOwnerRef: {
        ownerFeatureId: 'F202',
        ownerStateRef: 'adapter:microduck-owner-v1',
        version: '1',
      },
      targetOwnerFeatureId: 'microduck-owner',
      targetStateRefPrefix: 'simulator:',
      capabilities: PROGRAM_ADAPTER_CAPABILITIES,
      ...descriptorOverrides,
    },
    observe: blocked,
    permission: blocked,
    mutate: blocked,
    verify: blocked,
    writeback: blocked,
    freshOutcome: blocked,
    rollback: blocked,
    manifest: blocked,
    ...operationOverrides,
  };
}

describe('F311 Phase 5 program adapter registry', () => {
  it('resolves an external owner by exact owner identity and state-ref namespace', () => {
    const registry = new ProgramAdapterRegistry();
    const microduck = adapter();
    const secondOwner = adapter({
      descriptor: {
        adapterId: 'external-project-owner-v1',
        targetOwnerFeatureId: 'external-project-owner',
        targetStateRefPrefix: 'project:',
      },
    });
    registry.register(microduck);
    registry.register(secondOwner);

    assert.deepEqual(registry.resolve(target), { status: 'resolved', adapter: microduck });
    assert.deepEqual(
      registry.resolve({ ownerFeatureId: 'external-project-owner', ownerStateRef: 'project:canonical-repo' }),
      { status: 'resolved', adapter: secondOwner },
    );
    assert.deepEqual(registry.resolve({ ...target, ownerFeatureId: 'another-owner' }), {
      status: 'blocked',
      code: 'owner_adapter_missing',
      targetRef: { ...target, ownerFeatureId: 'another-owner' },
    });
  });

  it('rejects incomplete capability declarations and overlapping owner namespaces', () => {
    const registry = new ProgramAdapterRegistry();
    registry.register(adapter());

    assert.throws(
      () =>
        registry.register(
          adapter({
            descriptor: {
              adapterId: 'partial-v1',
              capabilities: PROGRAM_ADAPTER_CAPABILITIES.filter((capability) => capability !== 'rollback'),
            },
          }),
        ),
      /all required capabilities/,
    );
    assert.throws(
      () =>
        registry.register(
          adapter({
            descriptor: {
              adapterId: 'ambiguous-v1',
              targetStateRefPrefix: 'simulator:pollen-robotics/',
            },
          }),
        ),
      /overlaps/,
    );
  });

  it('keeps object-specific fields out of the canonical Program schema', () => {
    const parsed = evolutionProgramV1Schema.safeParse({
      schemaVersion: 1,
      programId: 'evolution-program:00000000000000000000000000000001',
      workspaceId: 'workspace-a',
      objectRef: target,
      claimRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'claim:walking-robustness-v1' },
      certificates: {},
      measurementRoleRefs: {},
      lifecycle: 'active',
      stage: 'constituting',
      cycle: 1,
      sequence: 0,
      currentAssetVersionRefs: [],
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      duckPolicyHash: 'forbidden-object-specific-payload',
    });

    assert.equal(parsed.success, false);
  });
});
