import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectPawFeelMessage } from '../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';
import { PawFeelDispositionReadModel } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model.js';
import {
  derivePawFeelBundles,
  derivePawFeelResponsibility,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model-bundles.js';

const HOUR = 3_600_000;
const NOW_MS = Date.parse('2026-07-26T12:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

function message(content = '[爪感差: rg+read model truth]', extra = undefined) {
  return {
    id: 'message-responsibility',
    threadId: 'thread-source',
    userId: 'user-1',
    catId: 'codex-sol',
    content,
    mentions: [],
    timestamp: NOW_MS - 80 * HOUR,
    ...(extra ? { extra } : {}),
  };
}

function fixture(source, transitions = []) {
  const inspected = inspectPawFeelMessage(source);
  assert.equal(inspected.kind, 'canonical');
  const candidate = inspected.candidates[0];
  const events = [
    {
      eventId: `discovered:${candidate.signalId}`,
      signalId: candidate.signalId,
      type: 'discovered',
      actor: { kind: 'automation', id: 'paw-feel-reconciler' },
      occurredAt: candidate.occurredAt,
      source: {
        sourceMessageId: candidate.sourceMessageId,
        sourceThreadId: candidate.sourceThreadId,
        sourceCatId: candidate.sourceCatId,
        markerDigest: candidate.markerDigest,
        sameDigestOrdinal: candidate.sameDigestOrdinal,
        markerIndex: candidate.markerIndex,
      },
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
    },
    ...transitions.map((event, index) => ({
      eventId: `transition-${index}`,
      signalId: candidate.signalId,
      actor: { kind: 'cat', id: 'opus' },
      occurredAt: new Date(source.timestamp + (index + 1) * 1_000).toISOString(),
      ...event,
    })),
  ];
  const byId = new Map([[source.id, source]]);
  return {
    signalId: candidate.signalId,
    messageStore: {
      byId,
      async getById(id) {
        return byId.get(id) ?? null;
      },
    },
    eventLog: {
      async listSignalIds() {
        return [candidate.signalId];
      },
      async read() {
        return events;
      },
      async readMany() {
        return new Map([[candidate.signalId, events]]);
      },
    },
  };
}

function baseProjection(state) {
  return {
    signalId: 'signal-1',
    sourceMessageId: 'message-1',
    sourceThreadId: 'thread-1',
    sourceCatId: 'codex-sol',
    markerDigest: 'a'.repeat(64),
    sameDigestOrdinal: 0,
    markerIndex: 0,
    state,
    sequence: 2,
    discoveredAt: NOW,
    lastTransitionAt: NOW,
    backfilled: false,
    captureMethod: 'typed',
    captureAssessment: 'confirmed',
  };
}

describe('F278 responsibility read model', () => {
  it('projects transport, repair, proposal, signature, and mixed-bundle truth independently', () => {
    const routed = derivePawFeelResponsibility({ ...baseProjection('routed'), outcomeRef: 'message:receipt' });
    assert.deepEqual(routed, { state: 'unreviewed', validExit: false, exitKind: 'none', evidenceRefs: [] });

    const repair = {
      ...baseProjection('fix'),
      ownerCatId: 'codex-sol',
      taskId: 'task-1',
      actionLeaseRef: { leaseId: 'lease-1', generation: 4 },
      custodyEvidenceRef: 'task:task-1:lease:lease-1:4',
    };
    assert.deepEqual(derivePawFeelResponsibility(repair, { repairBindingIsActive: true }), {
      state: 'bound_in_repair',
      validExit: true,
      exitKind: 'repair_binding',
      evidenceRefs: ['task-1', 'lease-1', 'task:task-1:lease:lease-1:4'],
      ownerCatId: 'codex-sol',
      taskId: 'task-1',
      leaseId: 'lease-1',
    });
    assert.deepEqual(derivePawFeelResponsibility(repair), {
      state: 'unreviewed',
      validExit: false,
      exitKind: 'repair_binding',
      evidenceRefs: ['task-1', 'lease-1', 'task:task-1:lease:lease-1:4'],
      ownerCatId: 'codex-sol',
      taskId: 'task-1',
      leaseId: 'lease-1',
    });

    const proposed = { ...baseProjection('route_pending'), proposalId: 'proposal-1' };
    assert.equal(derivePawFeelResponsibility(proposed, { proposalIsPending: true }).state, 'blocked');
    assert.equal(derivePawFeelResponsibility(proposed).validExit, false);

    const signature = derivePawFeelResponsibility({
      ...baseProjection('signature_waiting'),
      signatureRequest: {
        requestId: 'signature-request-1',
        requestedByCatId: 'codex-sol',
        excludedSignerCatId: 'codex-sol',
        preferredSignerCatId: 'opus5',
        action: { type: 'no_action', reasonCode: 'not_actionable' },
      },
    });
    assert.equal(signature.validExit, false);
    assert.equal(signature.signerExclusionCatId, 'codex-sol');

    const common = {
      source: { availability: 'available', preview: 'preview', sourceHref: '/source', digestVerified: true },
      ageMs: 1,
      overdue: false,
      reviewContext: { sourceMarkerCount: 2 },
    };
    const [mixed] = derivePawFeelBundles([
      {
        ...common,
        disposition: { ...baseProjection('blocked'), blocker: { code: 'wait', ref: 'blocker-1' } },
        responsibility: {
          state: 'blocked',
          validExit: true,
          exitKind: 'explicit_blocker',
          evidenceRefs: ['blocker-1'],
        },
      },
      {
        ...common,
        disposition: { ...baseProjection('signature_waiting'), signalId: 'signal-2', markerDigest: 'b'.repeat(64) },
        responsibility: signature,
      },
    ]).bundles;
    assert.equal(mixed.responsibility.state, 'signature_waiting');
    assert.equal(mixed.responsibility.validExit, false);
    assert.deepEqual(mixed.responsibility.evidenceRefs, ['signature-request-1']);
  });

  it('revalidates F128 pending status before accepting a proposal as a duty exit', async () => {
    const source = message();
    const seed = fixture(source);
    const transitions = [{ type: 'seen' }, { type: 'route_pending', proposalId: 'proposal-1' }];
    const live = fixture(source, transitions);
    const options = { eventLog: live.eventLog, messageStore: live.messageStore, now: () => NOW };
    const pendingModel = new PawFeelDispositionReadModel({
      ...options,
      proposalStatusResolver: { isPending: async () => true },
    });
    const staleModel = new PawFeelDispositionReadModel({
      ...options,
      proposalStatusResolver: { isPending: async () => false },
    });

    const pending = await pendingModel.list();
    const stale = await staleModel.list();
    assert.equal(seed.signalId, live.signalId);
    assert.equal(pending.items[0].responsibility.validExit, true);
    assert.equal(pending.items[0].overdue, false);
    assert.equal(stale.items[0].responsibility.state, 'unreviewed');
    assert.equal(stale.items[0].overdue, true);
    assert.equal((await pendingModel.listUndispositioned()).length, 0);
    assert.equal((await staleModel.listUndispositioned()).length, 1);
  });

  it('revalidates the exact task lease before accepting a repair binding as a duty exit', async () => {
    const source = message();
    const repair = {
      ownerCatId: 'opus',
      taskId: 'task-1',
      leaseId: 'lease-1',
      leaseGeneration: 4,
      custodyEvidenceRef: 'action-lease:lease-1:generation:4',
    };
    const data = fixture(source, [{ type: 'fix', ...repair }]);
    const options = { eventLog: data.eventLog, messageStore: data.messageStore, now: () => NOW };
    const activeModel = new PawFeelDispositionReadModel({
      ...options,
      repairBindingResolver: { resolve: async () => repair },
    });
    const staleModel = new PawFeelDispositionReadModel({
      ...options,
      repairBindingResolver: {
        resolve: async () => {
          throw new Error('lease expired');
        },
      },
    });

    const active = await activeModel.list();
    const stale = await staleModel.list();
    assert.equal(active.items[0].responsibility.validExit, true);
    assert.equal(active.counts.overdue, 0);
    assert.equal(stale.items[0].responsibility.state, 'unreviewed');
    assert.equal(stale.items[0].responsibility.validExit, false);
    assert.equal(stale.responsibilityCounts.unreviewed, 1);
    assert.equal(stale.responsibilityCounts.bound_in_repair, 0);
    assert.equal(stale.counts.overdue, 1);
    assert.equal((await activeModel.listUndispositioned()).length, 0);
    assert.equal((await staleModel.listUndispositioned()).length, 1);
  });

  it('binds confirm membership and counts to the exact listed snapshot', async () => {
    const source = message('[爪感差: rg+snapshot truth]', { stream: { turnInvocationId: 'turn-snapshot' } });
    const data = fixture(source);
    const readModel = new PawFeelDispositionReadModel({
      eventLog: data.eventLog,
      messageStore: data.messageStore,
      now: () => NOW,
    });
    const page = await readModel.list({ states: ['new'] });
    const bundle = page.bundles[0];
    const members = bundle.members.map((item) => ({
      signalId: item.disposition.signalId,
      expectedSequence: item.disposition.sequence,
    }));
    assert.deepEqual(page.responsibilityCounts, {
      unreviewed: 1,
      bound_in_repair: 0,
      signature_waiting: 0,
      blocked: 0,
      terminal: 0,
    });
    assert.equal(typeof bundle.membershipToken, 'string');

    data.messageStore.byId.delete(source.id);
    await readModel.assertBundleSnapshot(bundle.bundleKey, members, bundle.membershipToken);
    await assert.rejects(
      readModel.assertBundleSnapshot(
        bundle.bundleKey,
        [{ ...members[0], expectedSequence: 99 }],
        bundle.membershipToken,
      ),
      /snapshot/i,
    );
  });
});
