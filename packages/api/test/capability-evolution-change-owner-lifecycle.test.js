import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approved,
  base,
  candidate,
  changeOwner,
  exactTarget,
  measurementRefs,
  observingProgram,
  owner,
  proposed,
  refs,
  requestAuthority,
} from './capability-evolution-change.helper.mjs';

describe('F311 Phase 4 owner lifecycle synchronization', () => {
  it('can activate a canonical owner binding after the Program service was composed dormant', async () => {
    let activeOwner;
    const fixture = await awaitingApprovalWithOptions({ resolveChangeOwner: () => activeOwner });

    await assert.rejects(
      fixture.service.proposeChange({
        ...base(fixture.programId, 7, 'propose-before-owner-binding'),
        requestAuthority,
      }),
      /owner contract is unavailable/,
    );

    activeOwner = changeOwner();
    const proposedAfterBinding = await fixture.service.proposeChange({
      ...base(fixture.programId, 7, 'propose-after-owner-binding'),
      requestAuthority,
    });
    assert.equal(proposedAfterBinding.outcome, 'appended');
    assert.equal(activeOwner.state.requestCalls, 1);
  });

  it('never contacts the change owner after the Program was withdrawn', async () => {
    const ownerPort = changeOwner();
    const fixture = await awaitingApprovalWithOptions({ changeOwner: ownerPort });
    const withdrawn = await fixture.service.command({
      ...base(fixture.programId, 7, 'withdraw-before-owner-contact'),
      action: {
        type: 'withdraw',
        decisionRef: owner('F281', 'decision:withdraw-before-owner-contact'),
      },
    });
    assert.equal(withdrawn.projection.program.lifecycle, 'terminal');

    await assert.rejects(
      fixture.service.proposeChange({
        ...base(fixture.programId, 8, 'propose-after-program-withdrawal'),
        requestAuthority,
      }),
      /active\/awaiting_approval/,
    );
    assert.equal(ownerPort.state.requestCalls, 0);

    const proposedFixture = await proposed(ownerPort);
    const proposedWithdrawal = await proposedFixture.service.command({
      ...base(proposedFixture.programId, 8, 'withdraw-before-owner-sync'),
      action: {
        type: 'withdraw',
        decisionRef: owner('F281', 'decision:withdraw-before-owner-sync'),
      },
    });
    assert.equal(proposedWithdrawal.projection.program.lifecycle, 'terminal');

    await assert.rejects(
      proposedFixture.service.syncChange(base(proposedFixture.programId, 9, 'sync-after-program-withdrawal')),
      /active Program/,
    );
    assert.equal(ownerPort.state.resolveCalls, 0);
  });

  it('keeps every non-approved or stale target state out of writeback', async () => {
    for (const status of ['pending', 'rejected', 'withdrawn', 'superseded', 'target_drift']) {
      const ownerPort = changeOwner();
      const fixture = await proposed(ownerPort);
      ownerPort.state.snapshot =
        status === 'pending'
          ? { status, ...refs }
          : { status, ...refs, decisionRef: owner('F266', `eval-repair-decision:${status}`) };
      const result = await fixture.service.syncChange(base(fixture.programId, 8, `sync-${status}`));
      if (status === 'pending') {
        assert.equal(result.outcome, 'waiting');
        assert.equal(result.projection.program.sequence, 8);
      } else {
        assert.equal(result.projection.program.stage, 'awaiting_approval');
      }
      assert.notEqual(result.projection.program.stage, 'writing_back', status);
      assert.notEqual(result.projection.program.stage, 'deciding', status);
    }
  });

  it('rejects owner snapshot statuses outside the canonical lifecycle algebra', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    ownerPort.state.snapshot = { status: 'published', ...refs };

    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 8, 'sync-owner-status-leak')),
      /unsupported snapshot status/i,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.sequence, 8);
  });

  it('records target drift even when the owner reports the new target and then permits only a fresh proposal', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    ownerPort.state.snapshot = {
      status: 'target_drift',
      ...refs,
      targetVersionRef: exactTarget('v2'),
      decisionRef: owner('F266', 'eval-repair-decision:target-drift'),
    };
    const drifted = await fixture.service.syncChange(base(fixture.programId, 8, 'sync-target-drift'));
    assert.equal(drifted.projection.program.stage, 'awaiting_approval');
    assert.equal(drifted.projection.lineage.current.status, 'target_drift');

    ownerPort.state.requestResult = {
      status: 'pending',
      caseRef: owner('F266', 'eval-repair-case:case-2'),
      proposalRef: owner('F266', 'eval-repair-proposal:proposal-2'),
      ownerAuthorizationRef: owner('F202', 'execution-permission:investor-roadshow-expression-v2'),
      targetVersionRef: exactTarget('v2'),
    };
    const refreshed = await fixture.service.proposeChange({
      ...base(fixture.programId, 9, 'propose-fresh-target'),
      requestAuthority,
    });
    assert.equal(refreshed.projection.lineage.current.proposalRef.ownerStateRef, 'eval-repair-proposal:proposal-2');
    assert.equal(
      refreshed.projection.lineage.current.ownerAuthorizationRef.ownerStateRef,
      'execution-permission:investor-roadshow-expression-v2',
    );
    assert.equal(refreshed.projection.lineage.current.targetVersionRef.version, 'v2');
    assert.equal(ownerPort.state.requestCalls, 2);
  });

  it('rejects an approval whose exact target/version differs from the active proposal', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    ownerPort.state.snapshot = {
      status: 'approved',
      ...refs,
      targetVersionRef: exactTarget('v2'),
      approvalRef: owner('F246', 'approval:proposal-1'),
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 8, 'sync-drifted-approval')),
      /exact target\/version/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'awaiting_approval');
  });

  it('rejects an approval whose owner authorization differs from the active proposal', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    ownerPort.state.snapshot = {
      status: 'approved',
      ...refs,
      ownerAuthorizationRef: owner('F202', 'execution-permission:unrelated-surface'),
      approvalRef: owner('F246', 'approval:proposal-1'),
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 8, 'sync-drifted-owner-authorization')),
      /owner authorization does not match/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'awaiting_approval');
  });

  it('rejects a terminal owner snapshot that rewrites an already-linked Approval ref', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'superseded',
      ...refs,
      approvalRef: owner('F246', 'approval:unrelated-proposal'),
      decisionRef: owner('F266', 'eval-repair-decision:superseded'),
    };

    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 9, 'sync-rewritten-terminal-approval')),
      /Approval ref changed after it was linked/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'writing_back');
  });

  it('closes an approved attempt that drifts before mutation and permits only a fresh proposal', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'target_drift',
      ...refs,
      targetVersionRef: exactTarget('v2'),
      ownerAuthorizationRef: owner('F202', 'execution-permission:investor-roadshow-expression-v2'),
      decisionRef: owner('F266', 'eval-repair-decision:post-approval-target-drift'),
    };
    const drifted = await fixture.service.syncChange(base(fixture.programId, 9, 'sync-post-approval-drift'));
    assert.equal(drifted.projection.program.stage, 'awaiting_approval');
    assert.equal(drifted.projection.lineage.current.status, 'target_drift');

    ownerPort.state.requestResult = {
      status: 'pending',
      caseRef: owner('F266', 'eval-repair-case:case-2'),
      proposalRef: owner('F266', 'eval-repair-proposal:proposal-2'),
      ownerAuthorizationRef: owner('F202', 'execution-permission:investor-roadshow-expression-v2'),
      targetVersionRef: exactTarget('v2'),
    };
    const refreshed = await fixture.service.proposeChange({
      ...base(fixture.programId, 10, 'propose-after-post-approval-drift'),
      requestAuthority,
    });
    assert.equal(refreshed.projection.lineage.current.proposalRef.ownerStateRef, 'eval-repair-proposal:proposal-2');
    assert.equal(refreshed.projection.lineage.current.targetVersionRef.version, 'v2');
  });

  it('treats stable approved and mutated owner snapshots as waiting instead of duplicate transitions', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    const stillApproved = await fixture.service.syncChange(base(fixture.programId, 9, 'sync-still-approved'));
    assert.equal(stillApproved.outcome, 'waiting');
    assert.equal(stillApproved.projection.program.stage, 'writing_back');
    assert.equal(stillApproved.projection.program.sequence, 9);

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
    const mutated = await fixture.service.syncChange(base(fixture.programId, 9, 'sync-mutation-once'));
    assert.equal(mutated.projection.program.stage, 'revalidating');
    const stillMutated = await fixture.service.syncChange(base(fixture.programId, 10, 'sync-still-mutated'));
    assert.equal(stillMutated.outcome, 'waiting');
    assert.equal(stillMutated.projection.program.stage, 'revalidating');
    assert.equal(stillMutated.projection.program.sequence, 10);
  });

  it('rejects a changed receipt that preserves the approved target version', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'mutated',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'mutation-receipt:not-a-change'),
      assetVersionRef: exactTarget('v1'),
      loadedRuntimeRef: owner('F302', 'loaded-runtime:alpha-v1'),
      changedAt: '2026-09-01T10:00:00.000Z',
      loadedAt: '2026-09-01T10:05:00.000Z',
    };

    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 9, 'sync-unchanged-version-as-mutation')),
      /changed intervention receipt must name a new exact asset version/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'writing_back');
  });

  it('rejects owner refs that change underneath an already-linked lifecycle status', async () => {
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
    await fixture.service.syncChange(base(fixture.programId, 9, 'sync-canonical-mutation'));
    ownerPort.state.snapshot = {
      ...ownerPort.state.snapshot,
      interventionReceiptRef: owner('F202', 'mutation-receipt:rewritten'),
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 10, 'sync-rewritten-mutation')),
      /changed refs for an already-linked change status/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.sequence, 10);
  });

  it('rejects an owner snapshot that regresses from approved back to pending', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = { status: 'pending', ...refs };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 9, 'sync-regressed-pending')),
      /regressed to pending/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'writing_back');
  });

  it('never revives a canonically closed change attempt', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    ownerPort.state.snapshot = {
      status: 'rejected',
      ...refs,
      decisionRef: owner('F266', 'eval-repair-decision:rejected'),
    };
    await fixture.service.syncChange(base(fixture.programId, 8, 'sync-rejected'));
    ownerPort.state.snapshot = {
      status: 'approved',
      ...refs,
      approvalRef: owner('F246', 'approval:late-revival'),
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 9, 'sync-late-revival')),
      /revived a closed change attempt/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).lineage.current.status, 'rejected');
  });

  it('never rewinds an already mutated change to an Approval closure', async () => {
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
    await fixture.service.syncChange(base(fixture.programId, 9, 'sync-mutation-before-late-drift'));
    ownerPort.state.snapshot = {
      status: 'target_drift',
      ...refs,
      targetVersionRef: exactTarget('v3'),
      decisionRef: owner('F266', 'eval-repair-decision:late-target-drift'),
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 10, 'sync-late-target-drift')),
      /regressed after intervention receipt/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'revalidating');
  });
});

async function awaitingApprovalWithOptions(options) {
  const fixture = await observingProgram(options);
  const { service, programId } = fixture;
  await service.linkMeasurement({ ...base(programId, 4, 'measure-late-owner'), ...measurementRefs() });
  await service.linkAttribution({
    ...base(programId, 5, 'attribute-late-owner'),
    ...measurementRefs(),
    candidates: [candidate('execution')],
  });
  const gated = await service.linkIntervention({
    ...base(programId, 6, 'gate-late-owner'),
    ownerUserId: 'operator',
    autoRecheckRef: owner('F192', 'eval-trigger:program'),
  });
  assert.equal(gated.projection.program.stage, 'awaiting_approval');
  return fixture;
}
