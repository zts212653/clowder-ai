import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { F292ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F292ApprovalAdapter.js';
import { admissionHarness, publishInput } from './helpers.js';

async function replaceMetadata(intakes, intakeId, metadata) {
  const current = await intakes.get(intakeId);
  const result = await intakes.compareAndSet(intakeId, current.revision, {
    ...current,
    metadata,
    revision: current.revision + 1,
    updatedAt: current.updatedAt + 1,
  });
  assert.equal(result.outcome, 'written');
  return result.intake;
}

async function acceptNoteSibling(intakes, canonical, metadata, options = {}) {
  const result = await intakes.accept({
    settlementKey: `settlement:${canonical.intakeId}:note`,
    sourceIdentityKey: `source:${canonical.intakeId}:note`,
    intake: {
      ...canonical,
      intakeId: `${canonical.intakeId}-note`,
      source: { handle: 'feishu://meeting-artifacts/note/note-1?revision=rev-1' },
      metadata,
      ingress: {
        ...canonical.ingress,
        publicationId: `${canonical.ingress.publicationId}-note`,
        eventId: `${canonical.ingress.eventId}-note`,
        idempotencyKey: `${canonical.ingress.idempotencyKey}-note`,
        canonicalDigest: `${canonical.ingress.canonicalDigest}-note`,
      },
      occurredAt: options.occurredAt ?? canonical.occurredAt,
      createdAt: options.createdAt ?? canonical.createdAt + 1,
      updatedAt: options.updatedAt ?? canonical.updatedAt + 1,
    },
  });
  assert.equal(result.outcome, 'accepted');
  return result.intake;
}

describe('F292 Needs Me projection', () => {
  it('projects one event-origin card for unresolved truth and hides resolved truth', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const adapter = new F292ApprovalAdapter(admission.intakes);

    const pending = await adapter.listPending('owner-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sourceFeatureId, 'F292');
    assert.equal(pending[0].decisionMode, 'meeting-intake');
    assert.equal(pending[0].navigation.state, 'legacy_unanchored');
    assert.deepEqual(pending[0].detail.unresolved, ['speakers', 'context', 'destination', 'outputs']);

    const current = await admission.intakes.get('intake-1');
    await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'auto_resolved',
      executionState: 'succeeded',
      unresolved: [],
      revision: current.revision + 1,
      updatedAt: 11_000,
    });
    assert.deepEqual(await adapter.listPending('owner-1'), []);
    assert.equal((await adapter.listSettled('owner-1'))[0].status, 'approved');
  });

  it('does not mislabel hidden auto-resolved work as settled before execution succeeds', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const current = await admission.intakes.get('intake-1');
    await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'auto_resolved',
      executionState: 'queued',
      unresolved: [],
      revision: current.revision + 1,
      updatedAt: 11_000,
    });

    const adapter = new F292ApprovalAdapter(admission.intakes);
    assert.deepEqual(await adapter.listPending('owner-1'), []);
    assert.deepEqual(await adapter.listSettled('owner-1'), []);
  });

  it('keeps a single repair card visible even after judgment is resolved', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const current = await admission.intakes.get('intake-1');
    await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'confirmed',
      executionState: 'failed',
      healthState: 'degraded',
      unresolved: [],
      repair: { code: 'execution_failed', action: 'retry', observedAt: 11_000 },
      revision: current.revision + 1,
      updatedAt: 11_000,
    });

    const pending = await new F292ApprovalAdapter(admission.intakes).listPending('owner-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].detail.repair.action, 'retry');
  });

  it('projects one meeting card when delayed Minute and Note generations share meetingId', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const minute = await replaceMetadata(admission.intakes, 'intake-1', {
      artifactId: 'minute-1',
      artifactKind: 'minute',
      meetingId: 'meeting-1',
      revision: 'rev-1',
      title: 'Weekly sync',
    });
    await acceptNoteSibling(
      admission.intakes,
      minute,
      {
        artifactId: 'note-1',
        artifactKind: 'note',
        meetingId: 'meeting-1',
        revision: 'note-rev-before-minute-link',
        title: 'Weekly sync',
      },
      {
        occurredAt: minute.occurredAt + 5 * 60_000,
        createdAt: minute.createdAt + 5 * 60_000,
        updatedAt: minute.updatedAt + 5 * 60_000,
      },
    );

    const adapter = new F292ApprovalAdapter(admission.intakes);
    const pending = await adapter.listPending('owner-1');
    assert.deepEqual(
      pending.map((item) => item.proposalId),
      ['intake-1'],
    );

    const current = await admission.intakes.get('intake-1');
    await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'confirmed',
      executionState: 'succeeded',
      unresolved: [],
      revision: current.revision + 1,
      updatedAt: current.updatedAt + 10,
    });
    assert.deepEqual(await adapter.listPending('owner-1'), []);
    assert.deepEqual(
      (await adapter.listSettled('owner-1')).map((item) => item.proposalId),
      ['intake-1'],
    );
  });

  it('collapses legacy paired artifacts by their exact shared generation when meetingId is absent', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const minute = await replaceMetadata(admission.intakes, 'intake-1', {
      artifactId: 'minute-1',
      artifactKind: 'minute',
      revision: 'rev-1',
      title: 'Weekly sync',
    });
    await acceptNoteSibling(admission.intakes, minute, {
      artifactId: 'note-1',
      artifactKind: 'note',
      revision: 'rev-1',
      title: 'Weekly sync',
    });

    const pending = await new F292ApprovalAdapter(admission.intakes).listPending('owner-1');
    assert.deepEqual(
      pending.map((item) => item.proposalId),
      ['intake-1'],
    );
  });

  it('keeps ambiguous legacy generations separate instead of guessing meeting identity', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const minute = await replaceMetadata(admission.intakes, 'intake-1', {
      artifactId: 'minute-1',
      artifactKind: 'minute',
      revision: 'rev-1',
      title: 'Weekly sync',
    });
    const note = await acceptNoteSibling(admission.intakes, minute, {
      artifactId: 'note-1',
      artifactKind: 'note',
      revision: 'rev-1',
      title: 'Weekly sync',
    });
    await admission.intakes.accept({
      settlementKey: 'settlement:ambiguous-minute',
      sourceIdentityKey: 'source:ambiguous-minute',
      intake: {
        ...note,
        intakeId: 'intake-ambiguous-minute',
        source: { handle: 'feishu://meeting-artifacts/minute/minute-2?revision=rev-1' },
        metadata: { ...note.metadata, artifactId: 'minute-2', artifactKind: 'minute' },
        ingress: {
          ...note.ingress,
          publicationId: 'publication-ambiguous-minute',
          eventId: 'event-ambiguous-minute',
          idempotencyKey: 'idempotency-ambiguous-minute',
          canonicalDigest: 'digest-ambiguous-minute',
        },
      },
    });

    const pending = await new F292ApprovalAdapter(admission.intakes).listPending('owner-1');
    assert.deepEqual(pending.map((item) => item.proposalId).sort(), [
      'intake-1',
      'intake-1-note',
      'intake-ambiguous-minute',
    ]);
  });
});
