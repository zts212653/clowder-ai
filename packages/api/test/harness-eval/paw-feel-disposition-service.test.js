import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  pawFeelCandidate as candidate,
  pawFeelCommand as command,
  createPawFeelServiceHarness as createHarness,
} from './helpers/paw-feel-disposition-service-fixture.js';

describe('PawFeelDispositionService', () => {
  it('discovers idempotently while ignoring parser-only markerIndex drift', async () => {
    const { service } = createHarness();
    const source = candidate();
    const first = await service.discover(source, { backfilled: false });
    const replay = await service.discover(candidate({ markerIndex: 4 }), { backfilled: true });

    assert.equal(first.outcome, 'appended');
    assert.equal(replay.outcome, 'duplicate');
    assert.equal(replay.projection.markerIndex, 0, 'first durable navigation hint remains canonical');
    assert.equal(replay.projection.sequence, 1);
    assert.equal(replay.projection.captureMethod, 'legacy_parser');
    assert.equal(replay.projection.captureAssessment, 'ambiguous');
  });

  it('persists typed capture provenance without marker prose', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate();
    const captured = await service.discover(source, {
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
    });
    const [event] = await eventLog.read(source.signalId);

    assert.equal(captured.projection.captureMethod, 'typed');
    assert.equal(captured.projection.captureAssessment, 'confirmed');
    assert.equal(event.captureMethod, 'typed');
    assert.equal(event.captureAssessment, 'confirmed');
    assert.equal('marker' in event, false);
    assert.equal('symptom' in event, false);
  });

  it('derives actor from the trusted principal and rejects actor spoofing', async () => {
    const { service } = createHarness();
    const source = candidate();
    await service.discover(source, { backfilled: false });

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        { ...command('mark_seen', source.signalId, 1), actor: { kind: 'cat', id: 'codex-sol' } },
      ),
      /invalid command/i,
    );
    const result = await service.execute({ kind: 'cat', id: 'opus' }, command('mark_seen', source.signalId, 1));
    assert.equal(result.projection.lastActorCatId, 'opus');
  });

  it('allows the source cat to mark seen but forbids self-signed terminal disposition', async () => {
    const { service } = createHarness();
    const source = candidate();
    await service.discover(source, { backfilled: false });
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('mark_seen', source.signalId, 1));

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('mark_no_action', source.signalId, 2, { reasonCode: 'not_actionable' }),
      ),
      /source cat/i,
    );
  });

  it('does not let a operator signer attribute duplicate or no-action ownership to a cat', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate({ sourceCatId: 'fable-5' });
    const target = candidate({ messageId: 'message-target', digest: 'b'.repeat(64), sourceCatId: 'codex-sol' });
    await service.discover(source, { backfilled: false });
    await service.discover(target, { backfilled: false });

    for (const disposition of [
      command('mark_duplicate', source.signalId, 1, { duplicateOf: target.signalId }),
      command('mark_no_action', source.signalId, 1, {
        eventId: 'event-cvo-no-action',
        reasonCode: 'not_actionable',
      }),
    ]) {
      await assert.rejects(
        service.execute({ kind: 'cvo', id: 'you' }, disposition, { ownerCatId: 'opus' }),
        (error) => error?.code === 'named_owner_required',
      );
    }
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });

  it('makes duplicate, reasoned no-action, and verified fix the only new terminal actions', async () => {
    const { service } = createHarness();
    const duplicateTarget = candidate({ messageId: 'message-target', digest: 'b'.repeat(64), sourceCatId: 'fable-5' });
    const duplicate = candidate();
    const noAction = candidate({ messageId: 'message-no-action', digest: 'c'.repeat(64) });
    const fix = candidate({ messageId: 'message-fix', digest: 'd'.repeat(64) });
    for (const source of [duplicateTarget, duplicate, noAction, fix]) {
      await service.discover(source, { backfilled: false });
    }

    const duplicateResult = await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_duplicate', duplicate.signalId, 1, { duplicateOf: duplicateTarget.signalId }),
    );
    const noActionResult = await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_no_action', noAction.signalId, 1, { reasonCode: 'not_actionable' }),
    );
    const fixResult = await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_fix', fix.signalId, 1, { leaseId: 'lease-active' }),
    );

    assert.equal(duplicateResult.projection.state, 'duplicate');
    assert.equal(duplicateResult.projection.ownerCatId, 'opus');
    assert.equal(noActionResult.projection.state, 'no_action');
    assert.equal(noActionResult.projection.ownerCatId, 'opus');
    assert.equal(fixResult.projection.state, 'fix');
    assert.equal(fixResult.projection.ownerCatId, 'opus');
    assert.equal(fixResult.projection.taskId, 'task-1');
    assert.deepEqual(fixResult.projection.actionLeaseRef, { leaseId: 'lease-active', generation: 3 });
  });

  it('keeps fix undispositioned when task or active lease resolution fails', async () => {
    const { eventLog, service } = createHarness({
      resolveFix: async () => {
        throw new Error('task/owner/active lease mismatch');
      },
    });
    const source = candidate();
    await service.discover(source, { backfilled: false });

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        command('mark_fix', source.signalId, 1, { leaseId: 'transport-receipt-only' }),
      ),
      /active lease/i,
    );

    const events = await eventLog.read(source.signalId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'discovered');
  });

  it('rejects legacy transport-only routed and closed transitions without changing the row', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate();
    await service.discover(source, { backfilled: false });
    await service.execute({ kind: 'cat', id: 'opus' }, command('mark_seen', source.signalId, 1));
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        command('route_pending', source.signalId, 2, {
          targetThreadId: 'thread-owner',
          ownerEvidenceRef: 'message:owner-proof',
        }),
      ),
      /legacy disposition action disabled/i,
    );
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        command('close', source.signalId, 2, { reasonCode: 'fixed', outcomeRef: 'message:receipt' }),
      ),
      /legacy disposition action disabled/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 2);
  });

  it('requires an existing duplicate target and rejects duplicate cycles', async () => {
    const { service } = createHarness();
    const first = candidate();
    const second = candidate({ messageId: 'message-2', digest: 'b'.repeat(64), sourceCatId: 'fable-5' });
    await service.discover(first, { backfilled: false });
    await service.discover(second, { backfilled: false });
    await service.execute({ kind: 'cat', id: 'opus' }, command('mark_seen', first.signalId, 1));
    await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_seen', second.signalId, 1, { eventId: 'event-seen-second' }),
    );

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        command('mark_duplicate', first.signalId, 2, { duplicateOf: 'missing-signal' }),
      ),
      /not found/i,
    );
    await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command('mark_duplicate', second.signalId, 2, { duplicateOf: first.signalId }),
    );
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        command('mark_duplicate', first.signalId, 2, { duplicateOf: second.signalId }),
      ),
      /cycle/i,
    );
  });

  it('detects same-event-id intent collisions and keeps exact retries idempotent', async () => {
    const { service } = createHarness();
    const source = candidate();
    await service.discover(source, { backfilled: false });
    const seen = command('mark_seen', source.signalId, 1, { eventId: 'stable-event' });
    assert.equal((await service.execute({ kind: 'cat', id: 'opus' }, seen)).outcome, 'appended');
    assert.equal((await service.execute({ kind: 'cat', id: 'opus' }, seen)).outcome, 'duplicate');
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'fable-5' },
        command('mark_seen', source.signalId, 1, { eventId: 'stable-event' }),
      ),
      /collision/i,
    );
  });

  it('bulk execution writes an independent cat-signed event per signal', async () => {
    const { service } = createHarness();
    const signals = Array.from({ length: 50 }, (_, index) =>
      candidate({ messageId: `message-${index}`, digest: index.toString(16).padStart(64, '0') }),
    );
    for (const source of signals) await service.discover(source, { backfilled: false });

    const results = await service.executeMany(
      { kind: 'cat', id: 'opus' },
      signals.map((source, index) => command('mark_seen', source.signalId, 1, { eventId: `bulk-seen-${index}` })),
    );

    assert.equal(results.length, 50);
    assert.equal(
      results.every((result) => result.outcome === 'appended'),
      true,
    );
    assert.equal(
      results.every((result) => result.projection.lastActorCatId === 'opus'),
      true,
    );
  });

  it('fans one bundle action to the submitted snapshot, applies exceptions, and leaves late members untouched', async () => {
    const { eventLog, service } = createHarness();
    const duplicateTarget = candidate({
      messageId: 'message-target',
      digest: '1'.repeat(64),
      sourceCatId: 'fable-5',
    });
    const first = candidate({ messageId: 'message-a', digest: '2'.repeat(64) });
    const duplicate = candidate({ messageId: 'message-b', digest: '3'.repeat(64) });
    const stale = candidate({ messageId: 'message-c', digest: '4'.repeat(64) });
    const late = candidate({ messageId: 'message-late', digest: '5'.repeat(64) });
    for (const source of [duplicateTarget, first, duplicate, stale, late]) {
      await service.discover(source, { backfilled: false });
    }
    await service.execute(
      { kind: 'cat', id: 'opus' },
      command('mark_seen', stale.signalId, 1, { eventId: 'stale-sequence-advance' }),
    );

    const result = await service.executeBundle(
      { kind: 'cat', id: 'opus' },
      {
        bundleKey: 'turn:turn-1',
        membershipToken: 'signed-list-snapshot',
        members: [
          { signalId: first.signalId, expectedSequence: 1 },
          { signalId: duplicate.signalId, expectedSequence: 1 },
          { signalId: stale.signalId, expectedSequence: 1 },
        ],
        action: { type: 'no_action', reasonCode: 'not_actionable' },
        exceptions: [
          {
            signalId: duplicate.signalId,
            action: { type: 'duplicate', duplicateOf: duplicateTarget.signalId },
          },
        ],
        eventIdPrefix: 'bundle-confirm-1',
      },
    );

    assert.deepEqual(
      result.results.map(({ outcome }) => outcome),
      ['appended', 'appended', 'conflict'],
    );
    assert.deepEqual(result.counts, { appended: 2, duplicate: 0, conflict: 1, rejected: 0 });
    assert.equal((await eventLog.read(first.signalId)).at(-1).type, 'no_action');
    assert.equal((await eventLog.read(duplicate.signalId)).at(-1).type, 'duplicate');
    assert.equal((await eventLog.read(stale.signalId)).at(-1).type, 'seen');
    assert.equal((await eventLog.read(late.signalId)).at(-1).type, 'discovered');
  });

  it('rejects duplicate or oversized bundle snapshots before writing any member', async () => {
    const { eventLog, service } = createHarness();
    const source = candidate();
    await service.discover(source, { backfilled: false });
    const input = {
      bundleKey: 'message:message-1',
      membershipToken: 'signed-list-snapshot',
      action: { type: 'no_action', reasonCode: 'not_actionable' },
      eventIdPrefix: 'bundle-invalid',
    };

    await assert.rejects(
      service.executeBundle(
        { kind: 'cat', id: 'opus' },
        {
          ...input,
          members: [
            { signalId: source.signalId, expectedSequence: 1 },
            { signalId: source.signalId, expectedSequence: 1 },
          ],
        },
      ),
      /duplicate signal/i,
    );
    await assert.rejects(
      service.executeBundle(
        { kind: 'cat', id: 'opus' },
        {
          ...input,
          members: Array.from({ length: 51 }, (_, index) => ({
            signalId: `signal-${index}`,
            expectedSequence: 1,
          })),
        },
      ),
      /at most 50/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });
});
