import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contractTrialFixture } from './asr-person-memory-contract-fixture.js';

describe('F276 deferred re-entry terminal fencing', () => {
  async function fixture(terminalGenerations, now = 2_000, options = {}) {
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const { scene } = await contractTrialFixture();
    const opportunity = scene.opportunity;
    const lineage = {
      reflexId: opportunity.reflexId,
      reflexVersion: opportunity.reflexVersion,
      opportunityId: opportunity.opportunityId,
      dedupeLineage: opportunity.dedupeLineage,
      generation: opportunity.generation,
    };
    const receipt = {
      receiptId: `deferred_person_${'e'.repeat(32)}`,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-1',
      originMessageRef: { kind: 'message', threadId: 'thread-1', messageId: 'message-origin' },
      subject: 'Alden',
      normalizedSubject: 'alden',
      registryBinding: { kind: 'registered_person', ref: 'person-alden' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: { kind: 'message', threadId: 'thread-1', messageId: 'message-origin' },
          resolvedDigest: 'b'.repeat(64),
        },
      ],
      sourceBundleDigest: 'c'.repeat(64),
      dedupeHash: 'd'.repeat(64),
      state: 'deferred',
      retention: 'owner_controlled_no_ttl',
      writeOpportunityLineage: lineage,
      writeOpportunityReceipt: {
        v: 1,
        receiptId: `deferred_person_${'e'.repeat(32)}`,
        ...lineage,
        sourceRefs: opportunity.sourceCoordinates.map((coordinate) => ({
          artifactId: coordinate.artifactId,
          sourceRevision: coordinate.sourceRevision,
          attributionRevision: coordinate.speaker.attributionRevision,
          segmentStart: coordinate.segment.start,
          segmentEnd: coordinate.segment.end,
        })),
        eligibleAt: 1_301,
        expiresAt: opportunity.expiresAt,
        rearmPredicate: opportunity.rearmPredicate,
        destinationProposalContract: opportunity.destination.proposalContract,
        state: 'deferred',
      },
      createdAt: 1_300,
      updatedAt: 1_300,
    };
    const calls = { released: [], forgotten: [], purged: [], terminals: [] };
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [receipt];
        },
        async claim(input) {
          return {
            outcome: 'claimed',
            receipt: { ...receipt, state: 'claimed', claimId: input.claimId, claimUntil: input.now + input.leaseMs },
          };
        },
        async release(...args) {
          calls.released.push(args);
          return true;
        },
        async hardForget(...args) {
          calls.forgotten.push(args);
          return { outcome: 'purged' };
        },
      },
      messageStore: {
        async getById() {
          return {
            id: 'message-origin',
            userId: 'owner-1',
            catId: null,
            threadId: 'thread-1',
            content: 'meeting attachment',
            mentions: [],
            timestamp: 1_200,
            extra: { dynamicSceneEntries: [scene] },
          };
        },
      },
      writeOpportunityTerminalLedger: {
        async readLineageStates() {
          if (options.readError) throw options.readError;
          return new Map([[opportunity.dedupeLineage, { terminalGenerations }]]);
        },
        async recordTerminal(input) {
          calls.terminals.push(input);
        },
        async recordInvalidated() {},
      },
      writeOpportunityDeliveryStore: {
        async purgeLineage(...args) {
          calls.purged.push(args);
          return 1;
        },
      },
      ownerUserId: 'owner-1',
      now: () => now,
      randomId: () => 'claim-terminal-fence',
    });
    return {
      ...(options.deferAdmission ? {} : { admission: await spec.admission.gate({}) }),
      spec,
      calls,
      opportunity,
      receipt,
    };
  }

  it('does not re-present when the next generation is already terminal', async () => {
    const { admission, calls, opportunity, receipt } = await fixture(
      new Map([
        [1, 'defer'],
        [2, 'abstain'],
      ]),
    );
    assert.equal(admission.run, false);
    assert.deepEqual(calls.forgotten, [['owner-1', receipt.receiptId]]);
    assert.deepEqual(calls.purged, [['owner-1', opportunity.dedupeLineage]]);
    assert.deepEqual(calls.released, []);
  });

  it('waits for durable defer truth and records expiry instead of silently dropping the receipt', async () => {
    const missing = await fixture(new Map());
    assert.equal(missing.admission.run, false);
    assert.equal(missing.calls.released.length, 1);
    assert.deepEqual(missing.calls.forgotten, []);

    const expired = await fixture(new Map([[1, 'defer']]), 9_000_000_000_000);
    assert.equal(expired.admission.run, false);
    assert.equal(expired.calls.terminals[0].outcome, 'expired');
    assert.equal(expired.calls.terminals[0].generation, 2);
    assert.deepEqual(expired.calls.forgotten, [['owner-1', expired.receipt.receiptId]]);
  });

  it('releases the claim when durable re-entry authority fails', async () => {
    const setup = await fixture(new Map([[1, 'defer']]), 2_000, {
      deferAdmission: true,
      readError: new Error('terminal ledger unavailable'),
    });

    await assert.rejects(setup.spec.admission.gate({}), /terminal ledger unavailable/);
    assert.deepEqual(setup.calls.released, [['owner-1', setup.receipt.receiptId, 'claim-terminal-fence', 2_000]]);
  });
});
