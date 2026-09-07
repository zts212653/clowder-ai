import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approved,
  base,
  changeOwner,
  deciding,
  exactTarget,
  owner,
  proposed,
  refs,
} from './capability-evolution-change.helper.mjs';

describe('F311 Phase 4 fresh outcome synchronization', () => {
  it('catches up one canonical edge at a time when owner completion outruns Program sync', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    ownerPort.state.snapshot = {
      status: 'outcome',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'mutation-receipt:m1'),
      assetVersionRef: exactTarget('v2'),
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:o1'),
      loadedRuntimeRef: owner('F302', 'loaded-runtime:alpha-v2'),
      freshnessProofRef: owner('F267', 'measurement-proof:post-load-o1'),
      changedAt: '2026-09-01T10:00:00.000Z',
      loadedAt: '2026-09-01T10:05:00.000Z',
      measuredAt: '2026-09-01T11:00:00.000Z',
    };

    const approved = await fixture.service.syncChange(base(fixture.programId, 8, 'catch-up-approval'));
    assert.equal(approved.projection.program.stage, 'writing_back');
    assert.equal(approved.projection.lineage.current.status, 'approved');
    const mutated = await fixture.service.syncChange(base(fixture.programId, 9, 'catch-up-mutation'));
    assert.equal(mutated.projection.program.stage, 'revalidating');
    assert.equal(mutated.projection.lineage.current.status, 'changed');
    const outcome = await fixture.service.syncChange(base(fixture.programId, 10, 'catch-up-outcome'));
    assert.equal(outcome.projection.program.stage, 'deciding');
    assert.equal(outcome.projection.lineage.current.status, 'outcome');
    assert.equal(ownerPort.state.resolveCalls, 3);
  });

  it('requires owner mutation receipt and a post-load fresh outcome, never merge-only evidence', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'outcome',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'mutation-receipt:m1'),
      assetVersionRef: exactTarget('v2'),
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:o1'),
      // A merge SHA is not a loaded runtime or a freshness proof.
      mergedRef: owner('F202', 'git-merge:deadbeef'),
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 9, 'sync-merge-only-outcome')),
      /loaded runtime|assetVersionRef|timestamp/i,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'writing_back');
  });

  it('links mutation and only then accepts a temporally fresh post-load outcome', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    const projection = await fixture.service.get(fixture.programId);
    assert.equal(projection.lineage.current.interventionReceiptRef.ownerStateRef, 'mutation-receipt:m1');
    assert.equal(projection.lineage.current.outcomeReceiptRef.ownerStateRef, 'eval-repair-outcome:o1');
    assert.equal(projection.lineage.current.assetVersionRef.version, 'v2');
  });

  it('rejects a fresh-looking outcome for any version except the linked mutation version', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'mutated',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'mutation-receipt:m1'),
      assetVersionRef: exactTarget('v2'),
      loadedRuntimeRef: owner('F302', 'loaded-runtime:alpha-v2'),
      changedAt: '2026-09-01T10:00:00.000Z',
      loadedAt: '2026-09-01T10:05:00.000Z',
    };
    await fixture.service.syncChange(base(fixture.programId, 9, 'sync-mutation'));
    ownerPort.state.snapshot = {
      status: 'outcome',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'mutation-receipt:m1'),
      assetVersionRef: exactTarget('v3'),
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:o-wrong-version'),
      loadedRuntimeRef: owner('F302', 'loaded-runtime:alpha-v3'),
      freshnessProofRef: owner('F267', 'measurement-proof:post-load-v3'),
      changedAt: '2026-09-01T10:00:00.000Z',
      loadedAt: '2026-09-01T10:05:00.000Z',
      measuredAt: '2026-09-01T11:00:00.000Z',
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 10, 'sync-wrong-version-outcome')),
      /linked intervention version/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'revalidating');
  });
});
