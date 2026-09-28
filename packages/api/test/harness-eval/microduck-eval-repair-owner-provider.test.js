import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMicroduckEvalRepairOwnerBindingProvider } from '../../dist/infrastructure/capability-evolution/change/microduck-eval-repair-owner-provider.js';

const PROGRAM_ID = 'evolution-program:5073988075254b6eac9a0de0e3a27125';
const BASELINE_REVISION = '183f99a40bd7308da3e848de961ed32bb02624a5';
const PROGRAM_REF = { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID };
const CYCLE_REF = { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${PROGRAM_ID}:1` };
const OBJECT_REF = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: 'simulator:walking',
  version: BASELINE_REVISION,
};
const TARGET_VERSION_REF = {
  ...OBJECT_REF,
  assetKind: 'simulator-control-package-slot',
  assetId: 'walking',
};
const OWNER_USER_ID = 'default-user';
const PRINCIPAL = {
  invocationId: 'inv-microduck-owner-source-1',
  userId: OWNER_USER_ID,
  catId: 'codex-sol',
  threadId: 'thread-microduck-owner-source',
  originMessageId: 'message-microduck-owner-source',
};

function fixture(overrides = {}) {
  const calls = { observe: 0, lineage: 0, owner: 0, dispatch: 0 };
  const record = {
    ...PRINCIPAL,
    ownerAuthProvenance: 'strict',
    originTriggerMessageId: PRINCIPAL.originMessageId,
  };
  const provider = createMicroduckEvalRepairOwnerBindingProvider({
    ownerUserId: OWNER_USER_ID,
    programReader: {
      async get(programId) {
        assert.equal(programId, PROGRAM_ID);
        return {
          program: {
            programId: PROGRAM_ID,
            objectRef: OBJECT_REF,
            cycle: 1,
            valueOwnerRef: { ownerFeatureId: 'F311', ownerStateRef: `user:${OWNER_USER_ID}` },
          },
        };
      },
    },
    invocationRegistry: {
      async peekRecord(invocationId) {
        return invocationId === record.invocationId ? record : null;
      },
    },
    adapter: {
      async observe(input) {
        calls.observe += 1;
        assert.deepEqual(input, { programRef: PROGRAM_REF, cycleRef: CYCLE_REF, objectRef: OBJECT_REF });
        return {
          status: 'observed',
          targetVersionRef: TARGET_VERSION_REF,
          baselineVersionRef: {
            ownerFeatureId: 'microduck-owner',
            ownerStateRef:
              'hf-space:pollen-robotics/microduck-simulator@183f99a40bd7308da3e848de961ed32bb02624a5#app/public/policies/BEST_alpha_walking.onnx',
            version: BASELINE_REVISION,
            assetKind: 'policy',
            assetId: 'walking',
          },
          observationRefs: [],
        };
      },
    },
    ...overrides,
  });
  return { provider, calls };
}

describe('F311 Microduck canonical eval-repair owner provider', () => {
  it('declares one exact Program/target namespace without registering lifecycle truth', () => {
    const { provider } = fixture();
    assert.deepEqual(provider.route, {
      schemaVersion: 1,
      providerId: 'microduck-eval-repair-owner-v1',
      programRefs: [PROGRAM_REF],
      repairTargetRefs: [{ ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', match: 'exact' }],
      assetVersionRefs: [{ ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', match: 'exact' }],
      interventionReceiptRefs: [
        { ownerFeatureId: 'microduck-owner', ownerStateRef: 'deploy:sha256:', match: 'prefix' },
      ],
      freshOutcomeReceiptRefs: [
        { ownerFeatureId: 'microduck-owner', ownerStateRef: 'fresh-outcome:sha256:', match: 'prefix' },
      ],
    });
  });

  it('verifies the exact Program but creates no F266 case mapping when canonical lineage is absent', async () => {
    const { provider, calls } = fixture();
    const bindings = await provider.resolve();
    assert.ok(bindings);

    const verified = await bindings.requestAuthorityVerifier.verify(PRINCIPAL, {
      programRef: PROGRAM_REF,
      cycleRef: CYCLE_REF,
      interventionRef: OBJECT_REF,
    });
    assert.equal(verified.status, 'verified');

    const lineage = await bindings.lineageResolver.resolve({
      programRef: PROGRAM_REF,
      cycleRef: CYCLE_REF,
      interventionRef: OBJECT_REF,
    });
    assert.deepEqual(lineage, { status: 'blocked', reason: 'lineage_missing' });
    assert.deepEqual(calls, { observe: 0, lineage: 0, owner: 0, dispatch: 0 });
  });

  it('resolves only an injected exact Program/cycle/object mapping and rejects borrowed lineage', async () => {
    const { provider, calls } = fixture({
      lineageBindingResolver: {
        async resolve(lineage) {
          calls.lineage += 1;
          assert.deepEqual(lineage, {
            programRef: PROGRAM_REF,
            cycleRef: CYCLE_REF,
            interventionRef: OBJECT_REF,
          });
          return { status: 'resolved', caseActionRef: 'case-action:f266:microduck-control-config-v1' };
        },
      },
    });
    const bindings = await provider.resolve();
    const exact = await bindings.lineageResolver.resolve({
      programRef: PROGRAM_REF,
      cycleRef: CYCLE_REF,
      interventionRef: OBJECT_REF,
    });
    assert.deepEqual(exact, {
      status: 'resolved',
      caseActionRef: 'case-action:f266:microduck-control-config-v1',
    });

    const borrowed = await bindings.lineageResolver.resolve({
      programRef: PROGRAM_REF,
      cycleRef: CYCLE_REF,
      interventionRef: { ...OBJECT_REF, version: '0'.repeat(40) },
    });
    assert.deepEqual(borrowed, { status: 'blocked', reason: 'lineage_mismatch' });
    assert.equal(calls.lineage, 1);
  });

  it('observes the exact owner target but remains side-effect free without owner authorization', async () => {
    const { provider, calls } = fixture();
    const bindings = await provider.resolve();
    const resolution = await bindings.resolveOwnerChangeContract({
      caseId: 'case-microduck',
      verdictId: 'verdict-microduck',
      featureId: 'microduck-owner',
      componentId: 'simulator:walking',
      expectedTargetVersion: BASELINE_REVISION,
    });
    assert.equal(resolution.status, 'blocked');
    assert.equal(resolution.reason, 'owner_authorization_missing');
    assert.deepEqual(resolution.blockerRef, {
      ownerFeatureId: 'microduck-owner',
      ownerStateRef: 'permission:simulator:walking:missing',
    });

    const dispatched = await bindings.canonicalRepairDispatcher.materialize({
      dispatchId: 'dispatch-microduck',
      caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-case:case-microduck' },
      proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:proposal-microduck' },
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:proposal-microduck:approved' },
      ownerRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'owner:simulator:walking' },
      ownerAuthorizationRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: 'permission:simulator:walking:missing',
      },
      targetVersionRef: TARGET_VERSION_REF,
      dispatchRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'dispatch:simulator:walking' },
    });
    assert.equal(dispatched.status, 'blocked');
    assert.equal(dispatched.reason, 'owner_authorization_missing');
    assert.deepEqual(calls, { observe: 1, lineage: 0, owner: 0, dispatch: 0 });
  });

  it('rejects target drift before consulting an injected authorization resolver', async () => {
    const { provider, calls } = fixture({
      ownerChangeContractResolver: {
        async resolve() {
          calls.owner += 1;
          throw new Error('drifted target must not reach owner authorization');
        },
      },
    });
    const bindings = await provider.resolve();
    const resolution = await bindings.resolveOwnerChangeContract({
      caseId: 'case-microduck',
      verdictId: 'verdict-microduck',
      featureId: 'microduck-owner',
      componentId: 'simulator:walking',
      expectedTargetVersion: '0'.repeat(40),
    });
    assert.equal(resolution.status, 'blocked');
    assert.equal(resolution.reason, 'target_version_mismatch');
    assert.deepEqual(calls, { observe: 1, lineage: 0, owner: 0, dispatch: 0 });
  });
});
