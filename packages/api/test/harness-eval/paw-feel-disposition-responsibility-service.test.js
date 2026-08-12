import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  pawFeelCandidate as candidate,
  pawFeelCommand as command,
  createPawFeelServiceHarness as createHarness,
  T0,
} from './helpers/paw-feel-disposition-service-fixture.js';

describe('F278 responsibility transitions', () => {
  it('keeps independent signing when the reporting cat is also the verified repair owner', async () => {
    const { service } = createHarness({
      resolveFix: async (leaseId) => ({
        ownerCatId: 'codex-sol',
        taskId: 'task-source-owner',
        leaseId,
        leaseGeneration: 7,
        custodyEvidenceRef: `action-lease:${leaseId}:generation:7`,
      }),
    });
    const source = candidate({ sourceCatId: 'codex-sol' });
    await service.discover(source, { backfilled: false });

    const result = await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_fix', source.signalId, 1, { leaseId: 'lease-source-owner' }),
    );

    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.ownerCatId, 'codex-sol');
    assert.equal(result.projection.lastActorCatId, 'opus');
    assert.equal(result.projection.taskId, 'task-source-owner');
  });

  it('rebinds or explicitly blocks a repair after its previous lease becomes stale', async () => {
    const { service } = createHarness({
      resolveFix: async (leaseId) => {
        if (leaseId === 'lease-old') {
          return {
            ownerCatId: 'opus',
            taskId: 'task-old',
            leaseId,
            leaseGeneration: 1,
            custodyEvidenceRef: 'action-lease:lease-old:generation:1',
          };
        }
        if (leaseId === 'lease-new') {
          return {
            ownerCatId: 'fable-5',
            taskId: 'task-new',
            leaseId,
            leaseGeneration: 2,
            custodyEvidenceRef: 'action-lease:lease-new:generation:2',
          };
        }
        throw new Error('lease not active');
      },
    });
    const reboundSource = candidate({ messageId: 'message-rebind' });
    await service.discover(reboundSource, { backfilled: false });
    await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_fix', reboundSource.signalId, 1, { eventId: 'repair-old', leaseId: 'lease-old' }),
    );
    const rebound = await service.execute(
      { kind: 'cat', id: 'fable-5' },
      command('mark_fix', reboundSource.signalId, 2, { eventId: 'repair-new', leaseId: 'lease-new' }),
    );
    assert.equal(rebound.projection.ownerCatId, 'fable-5');
    assert.equal(rebound.projection.taskId, 'task-new');

    const blockedSource = candidate({ messageId: 'message-repair-blocked', digest: 'b'.repeat(64) });
    await service.discover(blockedSource, { backfilled: false });
    await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_fix', blockedSource.signalId, 1, { eventId: 'repair-before-block', leaseId: 'lease-old' }),
    );
    const blocked = await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_blocked', blockedSource.signalId, 2, {
        eventId: 'repair-expired-blocker',
        blockerCode: 'lease_expired',
        blockerRef: 'lease:lease-old:expired',
      }),
    );
    assert.equal(blocked.projection.state, 'blocked');
    assert.equal(blocked.projection.ownerCatId, undefined);
    assert.equal(blocked.projection.taskId, undefined);
    assert.equal(blocked.projection.actionLeaseRef, undefined);
  });

  it('lets a legacy routed receipt advance to a current business exit', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate();
    await service.discover(source, { backfilled: false });
    const actor = { kind: 'cat', id: 'opus' };
    await eventLog.append(
      {
        eventId: 'legacy-seen',
        signalId: source.signalId,
        type: 'seen',
        actor,
        occurredAt: new Date(T0).toISOString(),
      },
      1,
    );
    await eventLog.append(
      {
        eventId: 'legacy-route-pending',
        signalId: source.signalId,
        type: 'route_pending',
        actor,
        occurredAt: new Date(T0).toISOString(),
        targetThreadId: 'thread-owner',
        ownerEvidenceRef: 'message:owner-evidence',
      },
      2,
    );
    await eventLog.append(
      {
        eventId: 'legacy-routed',
        signalId: source.signalId,
        type: 'routed',
        actor,
        occurredAt: new Date(T0).toISOString(),
        targetThreadId: 'thread-owner',
        receiptRef: 'message:transport-receipt',
      },
      3,
    );

    const resolved = await service.execute(
      { kind: 'cat', id: 'fable-5' },
      command('mark_no_action', source.signalId, 4, {
        eventId: 'legacy-routed-business-exit',
        reasonCode: 'not_actionable',
      }),
    );
    assert.equal(resolved.projection.state, 'no_action');
    assert.equal(resolved.projection.targetThreadId, undefined);
    assert.equal(resolved.projection.outcomeRef, undefined);
  });

  it('persists an exact request that any legal independent signer can recover', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate({ sourceCatId: 'codex-sol' });
    await service.discover(source, { backfilled: false });

    const requested = await service.executeBundle(
      { kind: 'cat', id: 'codex-sol' },
      {
        bundleKey: 'signal:source-owned',
        membershipToken: 'signed-list-snapshot',
        members: [{ signalId: source.signalId, expectedSequence: 1 }],
        action: {
          type: 'request_signature',
          action: { type: 'no_action', reasonCode: 'not_actionable' },
          preferredSignerCatId: 'opus',
        },
        eventIdPrefix: 'signature-request',
      },
    );
    assert.equal(requested.results[0].projection.state, 'signature_waiting');
    assert.equal(requested.results[0].projection.signatureRequest.preferredSignerCatId, 'opus');

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('mark_no_action', source.signalId, 2, {
          eventId: 'signature-self-sign',
          reasonCode: 'not_actionable',
        }),
      ),
      /source cat/i,
    );
    const signed = await service.execute(
      { kind: 'cat', id: 'fable-5' },
      command('mark_no_action', source.signalId, 2, {
        eventId: 'signature-recovered-signer',
        reasonCode: 'not_actionable',
      }),
    );
    assert.equal(signed.projection.state, 'no_action');
    assert.equal(signed.projection.lastActorCatId, 'fable-5');
    assert.equal((await eventLog.read(source.signalId)).length, 3);
  });

  it('turns an interrupted signature request into an explicit evidenced blocker', async () => {
    const { service } = createHarness();
    const source = candidate({ sourceCatId: 'codex-sol' });
    await service.discover(source, { backfilled: false });
    await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('request_signature', source.signalId, 1, {
        eventId: 'signature-request-before-blocker',
        action: { type: 'no_action', reasonCode: 'not_actionable' },
        preferredSignerCatId: 'opus5',
      }),
    );

    const blocked = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('mark_blocked', source.signalId, 2, {
        eventId: 'signature-blocked',
        blockerCode: 'independent_signer_unavailable',
        blockerRef: 'thread:thread_eval_friction:signature-request-before-blocker',
      }),
    );
    assert.equal(blocked.projection.state, 'blocked');
    assert.equal(blocked.projection.signatureRequest, undefined);
    assert.deepEqual(blocked.projection.blocker, {
      code: 'independent_signer_unavailable',
      ref: 'thread:thread_eval_friction:signature-request-before-blocker',
    });
  });

  it('rejects forged bundle membership before writing any member', async () => {
    const { eventLog, service } = createHarness({
      assertBundleSnapshot: async (bundleKey, members) => {
        throw new Error(`${members[0].signalId} does not belong to ${bundleKey}`);
      },
    });
    const source = candidate();
    await service.discover(source, { backfilled: false });

    await assert.rejects(
      service.executeBundle(
        { kind: 'cat', id: 'opus' },
        {
          bundleKey: 'turn:forged',
          membershipToken: 'forged-list-snapshot',
          members: [{ signalId: source.signalId, expectedSequence: 1 }],
          action: { type: 'no_action', reasonCode: 'not_actionable' },
          eventIdPrefix: 'bundle-forged',
        },
      ),
      /bundle membership mismatch/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });
});
