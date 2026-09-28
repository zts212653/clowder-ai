import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createRequestReviewEvalRepairOwnerBindingProvider } from '../dist/infrastructure/capability-evolution/change/request-review-eval-repair-owner-provider.js';
import { composeEvalRepairOwnerBindings } from '../dist/infrastructure/harness-eval/eval-repair-owner-runtime-federation.js';

const programId = 'evolution-program:ba0f4524e49cc879279164d5b272cf8c';
const programRef = { ownerFeatureId: 'F311', ownerStateRef: programId };
const objectRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability:development-process-harness-effectiveness',
};
const assetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const principal = {
  invocationId: 'inv-owner',
  userId: 'owner-user',
  catId: 'codex-sol',
  threadId: 'thread-f100',
  originMessageId: 'message-origin',
};

function providerFixture(overrides = {}) {
  const calls = { dispatch: 0 };
  const provider = createRequestReviewEvalRepairOwnerBindingProvider({
    ownerUserId: 'owner-user',
    programReader: {
      async get(requestedProgramId) {
        if (requestedProgramId !== programId) throw new Error('wrong program');
        return {
          program: {
            programId,
            objectRef,
            cycle: 1,
            valueOwnerRef: { ownerFeatureId: 'F311', ownerStateRef: 'user:owner-user' },
          },
        };
      },
    },
    invocationRegistry: {
      async peekRecord(invocationId) {
        return invocationId === principal.invocationId
          ? {
              ...principal,
              ownerAuthProvenance: 'strict',
              originTriggerMessageId: principal.originMessageId,
            }
          : null;
      },
    },
    versionReader: {
      async currentVersionRef() {
        return assetVersionRef;
      },
    },
    lineageBindingResolver: {
      async resolve() {
        return { status: 'resolved', caseActionRef: 'case-action:f266:f100-1' };
      },
    },
    canonicalRepairDispatcher: {
      async materialize() {
        calls.dispatch += 1;
        return {
          status: 'materialized',
          receipt: {
            taskRef: { ownerFeatureId: 'F049', ownerStateRef: 'task:f100' },
            leaseRef: { ownerFeatureId: 'F167', ownerStateRef: 'lease:f100' },
            custodyReceiptRef: { ownerFeatureId: 'F167', ownerStateRef: 'custody:f100' },
          },
        };
      },
    },
    interventionReceiptOwner: {
      async resolve() {
        return null;
      },
    },
    freshOutcomeOwner: {
      async resolve() {
        return null;
      },
    },
    decisionOwner: {
      async execute() {
        return { status: 'blocked', reason: 'outcome_missing' };
      },
    },
    ...overrides,
  });
  return { provider, calls };
}

describe('F100 request-review eval repair owner provider', () => {
  it('is wired into the production API with durable ledger, F266 dispatcher, use receipts, and owner callbacks', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    for (const token of [
      'new RedisRequestReviewOwnerLedger(redis)',
      'new RequestReviewCanonicalRepairDispatcher({',
      'new RequestReviewOwnerFactAuthority({',
      'createRequestReviewVersionAttestor({',
      'requestReviewMountPointForClient(clientId)',
      'loadRequestReviewEvalRepairOwnerBinding(repoRoot)',
      'createRequestReviewEvalRepairOwnerBindingProvider({',
      'createRequestReviewOwnerActions({',
      'requestReviewReceipts: requestReviewUseReceipts',
      'requestReviewOwnerDeps:',
      'resolveOutcomeService: () => evalRepairOutcomeService',
    ]) {
      assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('declares one exact non-overlapping Program/target/asset route', async () => {
    const { provider } = providerFixture();
    assert.deepEqual(provider.route.programRefs, [programRef]);
    assert.deepEqual(provider.route.repairTargetRefs, [{ ...objectRef, match: 'exact' }]);
    assert.deepEqual(provider.route.assetVersionRefs, [
      {
        ownerFeatureId: 'F100',
        ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
        match: 'exact',
      },
    ]);

    const bindings = await provider.resolve();
    const otherBindings = await providerFixture().provider.resolve();
    const composed = composeEvalRepairOwnerBindings([
      { route: provider.route, bindings },
      {
        route: {
          schemaVersion: 1,
          providerId: 'microduck-test',
          programRefs: [{ ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:microduck' }],
          repairTargetRefs: [{ ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', match: 'exact' }],
          assetVersionRefs: [{ ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', match: 'exact' }],
          interventionReceiptRefs: [],
          freshOutcomeReceiptRefs: [],
        },
        bindings: otherBindings,
      },
    ]);
    assert.equal(composed.status, 'active');
  });

  it('resolves only the exact current F100 target version and delegates materialization', async () => {
    const { provider, calls } = providerFixture();
    const bindings = await provider.resolve();
    const resolved = await bindings.resolveOwnerChangeContract({
      caseId: 'case-1',
      verdictId: 'verdict-1',
      featureId: 'F100',
      componentId: objectRef.ownerStateRef,
      expectedTargetVersion: assetVersionRef.version,
    });
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(resolved.targetVersionRef, assetVersionRef);

    const stale = await bindings.resolveOwnerChangeContract({
      caseId: 'case-1',
      verdictId: 'verdict-1',
      featureId: 'F100',
      componentId: objectRef.ownerStateRef,
      expectedTargetVersion: 'b'.repeat(64),
    });
    assert.equal(stale.status, 'blocked');
    assert.equal(stale.reason, 'target_version_mismatch');

    const wrongObject = await bindings.resolveOwnerChangeContract({
      caseId: 'case-1',
      verdictId: 'verdict-1',
      featureId: 'F100',
      componentId: `${objectRef.ownerStateRef}-shadow`,
      expectedTargetVersion: assetVersionRef.version,
    });
    assert.equal(wrongObject.status, 'blocked');
    await bindings.canonicalRepairDispatcher.materialize({});
    assert.equal(calls.dispatch, 1);
  });

  it('binds authority and case action to the exact Program cycle and strict invocation origin', async () => {
    const { provider } = providerFixture();
    const bindings = await provider.resolve();
    const lineage = {
      programRef,
      cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${programId}:1` },
      interventionRef: objectRef,
    };
    const verified = await bindings.requestAuthorityVerifier.verify(principal, lineage);
    assert.equal(verified.status, 'verified');
    assert.deepEqual(await bindings.lineageResolver.resolve(lineage), {
      status: 'resolved',
      caseActionRef: 'case-action:f266:f100-1',
    });

    const wrongCycle = {
      ...lineage,
      cycleRef: { ...lineage.cycleRef, ownerStateRef: `${lineage.cycleRef.ownerStateRef}:2` },
    };
    assert.equal((await bindings.lineageResolver.resolve(wrongCycle)).status, 'blocked');
    assert.equal(
      (await bindings.requestAuthorityVerifier.verify({ ...principal, originMessageId: 'forged' }, lineage)).status,
      'blocked',
    );
  });
});
