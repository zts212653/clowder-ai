import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveContextContinuity } from '../../dist/domains/cats/services/agents/invocation/context-continuity.js';
import { artifact, intake } from './asr-person-memory-contract-fixture.js';

const CODEX_EXEC = {
  provider: 'openai',
  carrier: 'exec_json',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: true,
  nativeCompressionControl: true,
  observesCompression: true,
  reason: 'fixture',
};

/** The real handshake: a hand-rolled literal misses providerCarrier and silently fails the guard. */
const CONTINUITY = resolveContextContinuity({
  capability: CODEX_EXEC,
  invocationId: 'invocation-1',
  invocationOrigin: 'interactive',
  routeTopology: 'serial',
});

async function buildScene() {
  const { buildAsrPersonMemoryDynamicScenes } = await import(
    '../../dist/domains/signal-intake/AsrPersonMemorySceneBuilder.js'
  );
  const scene = buildAsrPersonMemoryDynamicScenes({
    intake,
    artifact,
    threadId: 'thread-1',
    consumerCatId: 'codex-sol',
    now: 1_200,
  })[0];
  const candidate = {
    scene,
    source: {
      kind: 'message',
      threadId: 'thread-1',
      sourceMessageId: 'message-owner-1',
      authorUserId: intake.ownerId,
      authorRole: 'owner',
      visibility: 'verified_live_owner_message',
    },
  };
  return { scene, candidate };
}

async function makeService(options = {}) {
  const { AsrPersonMemoryOpportunityPromptService } = await import(
    '../../dist/domains/memory/people/AsrPersonMemoryOpportunityPromptService.js'
  );
  return new AsrPersonMemoryOpportunityPromptService({ deliveryStore: fakeDeliveryStore(), ...options });
}

function fakeDeliveryStore() {
  return {
    async recordDelivered() {},
    async get() {
      return null;
    },
    async listInvocationOpportunityIds() {
      return [];
    },
    async purgeLineage() {
      return 0;
    },
  };
}

/** Minimal in-memory ledger: the Redis behaviour has its own isolated-Redis suite. */
function fakeLedger(states = new Map()) {
  const recorded = [];
  return {
    recorded,
    async readLineageStates(_ownerUserId, lineages) {
      const out = new Map();
      for (const lineage of lineages) {
        out.set(lineage, states.get(lineage) ?? { terminalGenerations: new Map() });
      }
      return out;
    },
    async recordTerminal(input) {
      recorded.push(input);
    },
    async recordInvalidated(input) {
      recorded.push(input);
    },
  };
}

const scopeOf = (scene) => ({
  ownerUserId: scene.opportunity.scope.ownerUserId,
  threadId: scene.opportunity.scope.threadId,
  consumerCatId: scene.opportunity.consumer.catId,
});

describe('ledger-aware opportunity admission', () => {
  it('presents an opportunity whose lineage is clean', async () => {
    const { scene, candidate } = await buildScene();
    const service = await makeService({ terminalLedger: fakeLedger() });
    const resolution = await service.resolveForInvocation({
      candidates: [candidate],
      serverScope: scopeOf(scene),
      continuity: CONTINUITY,
      now: scene.opportunity.eligibleAt,
    });
    assert.equal(resolution.admittedOpportunityIds.length, 1);
    assert.match(resolution.promptSegment, /person-memory-write-opportunity/);
  });

  it('suppresses a generation that a previous invocation already judged', async () => {
    const { scene, candidate } = await buildScene();
    const service = await makeService({
      terminalLedger: fakeLedger(
        new Map([
          [
            scene.opportunity.dedupeLineage,
            { terminalGenerations: new Map([[scene.opportunity.generation, 'propose']]) },
          ],
        ]),
      ),
    });
    const resolution = await service.resolveForInvocation({
      candidates: [candidate],
      serverScope: scopeOf(scene),
      continuity: CONTINUITY,
      now: scene.opportunity.eligibleAt,
    });
    assert.deepEqual(resolution.admittedOpportunityIds, []);
    assert.equal(resolution.promptSegment, '');
  });

  it('fails closed for a lineage killed by correct / forget / scope revoke', async () => {
    const { scene, candidate } = await buildScene();
    for (const reason of ['source_corrected', 'source_forgotten', 'scope_revoked']) {
      const service = await makeService({
        terminalLedger: fakeLedger(
          new Map([[scene.opportunity.dedupeLineage, { invalidatedReason: reason, terminalGenerations: new Map() }]]),
        ),
      });
      const resolution = await service.resolveForInvocation({
        candidates: [candidate],
        serverScope: scopeOf(scene),
        continuity: CONTINUITY,
        now: scene.opportunity.eligibleAt,
      });
      assert.deepEqual(resolution.admittedOpportunityIds, [], `lineage killed by ${reason} must not present`);
      assert.equal(resolution.promptSegment, '');
    }
  });

  it('still presents a later generation of a lineage whose earlier generation is terminal', async () => {
    // generation+1 is the post-defer re-arm: closing generation 1 must not close the lineage.
    const { scene, candidate } = await buildScene();
    const service = await makeService({
      terminalLedger: fakeLedger(
        new Map([[scene.opportunity.dedupeLineage, { terminalGenerations: new Map([[99, 'defer']]) }]]),
      ),
    });
    const resolution = await service.resolveForInvocation({
      candidates: [candidate],
      serverScope: scopeOf(scene),
      continuity: CONTINUITY,
      now: scene.opportunity.eligibleAt,
    });
    assert.equal(resolution.admittedOpportunityIds.length, 1);
  });

  it('omits an opportunity when durable disposition authority is not configured', async () => {
    const { scene, candidate } = await buildScene();
    for (const authority of [
      { terminalLedger: undefined, deliveryStore: fakeDeliveryStore() },
      { terminalLedger: fakeLedger(), deliveryStore: undefined },
    ]) {
      const events = [];
      const service = await makeService({ trace: { record: (event) => events.push(event) }, ...authority });
      const resolution = await service.resolveForInvocation({
        candidates: [candidate],
        serverScope: scopeOf(scene),
        continuity: CONTINUITY,
        now: scene.opportunity.eligibleAt,
      });
      assert.equal(resolution.admittedOpportunityIds.length, 1);
      assert.deepEqual(resolution.omittedOpportunityIds, resolution.admittedOpportunityIds);
      assert.deepEqual(resolution.deliveryReceipts, []);
      assert.equal(resolution.promptSegment, '');
      assert.ok(events.some((event) => event.outcome === 'disposition_authority_unavailable'));
    }
  });

  it('fails closed when configured cross-invocation invalidation truth is unavailable', async () => {
    const { scene, candidate } = await buildScene();
    const events = [];
    const service = await makeService({
      trace: { record: (event) => events.push(event) },
      terminalLedger: {
        async readLineageStates() {
          throw new Error('ledger unavailable');
        },
        async recordTerminal() {},
        async recordInvalidated() {},
      },
    });
    const resolution = await service.resolveForInvocation({
      candidates: [candidate],
      serverScope: scopeOf(scene),
      continuity: CONTINUITY,
      now: scene.opportunity.eligibleAt,
    });
    assert.deepEqual(resolution.admittedOpportunityIds, []);
    assert.equal(resolution.promptSegment, '');
    assert.equal(events.at(-1).outcome, 'terminal_ledger_unavailable');
  });

  it('persists delivery evidence only for delivered, never for omitted', async () => {
    const stored = [];
    const deliveryStore = {
      async recordDelivered(record) {
        stored.push(record);
      },
      async get() {
        return null;
      },
      async purgeLineage() {
        return 0;
      },
    };
    const { scene, candidate } = await buildScene();
    const service = await makeService({ terminalLedger: fakeLedger(), deliveryStore });
    const resolution = await service.resolveForInvocation({
      candidates: [candidate],
      serverScope: scopeOf(scene),
      continuity: CONTINUITY,
      now: scene.opportunity.eligibleAt,
    });

    const confirmation = {
      continuity: CONTINUITY,
      generationId: `sha256:${'e'.repeat(64)}`,
      evidenceRef: `context-delivery:invocation-1:sha256:${'e'.repeat(64)}`,
      occurredAt: scene.opportunity.eligibleAt + 10,
      invocationId: 'invocation-1',
    };

    await service.persistDeliveredRecords(resolution.presentationReceipts, {
      ...confirmation,
      outcome: 'omitted',
    });
    assert.equal(stored.length, 0, 'an omission is not a delivery and must not be dispositionable');

    await service.persistDeliveredRecords(resolution.presentationReceipts, {
      ...confirmation,
      outcome: 'delivered',
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].opportunityId, scene.opportunity.opportunityId);
    assert.equal(stored[0].invocationId, 'invocation-1');
    // content-free: no speaker label or transcript reaches the persisted evidence
    assert.doesNotMatch(JSON.stringify(stored[0]), /Alden|黄挺|speaker-/);
  });

  it('prints a ref triple the cat can actually construct a disposition from', async () => {
    // P1-1 regression: dedupeLineage keeps only its first 24 of 32 hex chars inside opportunityId,
    // so a prompt showing id= alone leaves the ref mathematically unconstructible and every defer
    // silently falls back to the unattributed path.
    const { scene, candidate } = await buildScene();
    const service = await makeService({ terminalLedger: fakeLedger() });
    const resolution = await service.resolveForInvocation({
      candidates: [candidate],
      serverScope: scopeOf(scene),
      continuity: CONTINUITY,
      now: scene.opportunity.eligibleAt,
    });

    const segment = resolution.promptSegment;
    assert.match(segment, new RegExp(`opportunityId=${scene.opportunity.opportunityId}`));
    assert.match(segment, new RegExp(`dedupeLineage=${scene.opportunity.dedupeLineage}`));
    assert.match(segment, new RegExp(`generation=${scene.opportunity.generation}`));

    // The printed lineage must be the full 32-hex value, not the truncated prefix embedded in the id.
    const printed = segment.match(/dedupeLineage=(write_lineage_[a-f0-9]+)/)[1];
    assert.equal(printed, scene.opportunity.dedupeLineage);
    assert.match(segment, /pass the writeOpportunityRef triple above verbatim to propose, defer, or abstain/i);
    assert.equal(printed.length, 'write_lineage_'.length + 32);

    // Still content-free: exposing the ref must not drag in speaker labels or transcript.
    assert.doesNotMatch(segment, /Alden|黄挺/);
  });
});
