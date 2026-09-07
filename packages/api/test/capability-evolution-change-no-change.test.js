import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approved,
  base,
  changeOwner,
  deciding,
  decisionAuthority,
  exactTarget,
  noChangeDeciding,
  owner,
  proposed,
  refs,
} from './capability-evolution-change.helper.mjs';

describe('F311 Phase 4 owner no-change intervention', () => {
  it('links the canonical owner no_change snapshot before a later fresh outcome', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'no_change',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:n1'),
      recordedAt: '2026-09-01T10:00:00.000Z',
    };

    const linked = await fixture.service.syncChange(base(fixture.programId, 9, 'sync-canonical-no-change'));
    assert.equal(linked.projection.program.stage, 'revalidating');
    assert.equal(linked.projection.lineage.current.status, 'no_change');

    const stable = await fixture.service.syncChange(base(fixture.programId, 10, 'sync-stable-no-change'));
    assert.equal(stable.outcome, 'waiting');
    assert.equal(stable.projection.program.sequence, 10);
  });

  it('revalidates an owner no-change receipt without inventing a mutation or loaded runtime', async () => {
    const ownerPort = changeOwner();
    const fixture = await noChangeDeciding(ownerPort);
    const projection = await fixture.service.get(fixture.programId);

    assert.equal(projection.lineage.current.interventionKind, 'no_change');
    assert.equal(projection.lineage.current.interventionReceiptRef.ownerStateRef, 'no-change-intervention-receipt:n1');
    assert.equal(projection.lineage.current.assetVersionRef.version, 'v1');
    assert.equal(projection.lineage.current.loadedRuntimeRef, undefined);
    assert.equal(projection.lineage.current.outcomeReceiptRef.ownerStateRef, 'eval-repair-outcome:no-change-1');
    assert.equal(projection.program.currentAssetVersionRefs[0].version, 'v1');
  });

  it('accepts and idempotently replays an explicit unchanged version on the no-change outcome', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'outcome',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:explicit-version'),
      assetVersionRef: exactTarget('v1'),
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:explicit-version'),
      freshnessProofRef: owner('F267', 'measurement-proof:post-no-change-explicit-version'),
      recordedAt: '2026-09-01T10:00:00.000Z',
      measuredAt: '2026-09-01T11:00:00.000Z',
    };

    await fixture.service.syncChange(base(fixture.programId, 9, 'sync-explicit-no-change-intervention'));
    const outcome = await fixture.service.syncChange(base(fixture.programId, 10, 'sync-explicit-no-change-outcome'));
    assert.equal(outcome.projection.program.stage, 'deciding');
    const replay = await fixture.service.syncChange(base(fixture.programId, 11, 'sync-explicit-no-change-replay'));
    assert.equal(replay.outcome, 'waiting');
    assert.equal(replay.projection.program.sequence, 11);
  });

  it('rejects an asset-version drift reported with a no-change outcome', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'no_change',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:before-outcome-drift'),
      recordedAt: '2026-09-01T10:00:00.000Z',
    };
    await fixture.service.syncChange(base(fixture.programId, 9, 'sync-no-change-before-outcome-drift'));
    ownerPort.state.snapshot = {
      status: 'outcome',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:before-outcome-drift'),
      assetVersionRef: exactTarget('v2'),
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:drifted-no-change'),
      freshnessProofRef: owner('F267', 'measurement-proof:post-drifted-no-change'),
      recordedAt: '2026-09-01T10:00:00.000Z',
      measuredAt: '2026-09-01T11:00:00.000Z',
    };

    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 10, 'sync-drifted-no-change-outcome')),
      /no-change outcome must preserve the exact asset version/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'revalidating');
  });

  it('rejects an exact-version rewrite after a no-change receipt was linked', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'no_change',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:n1'),
      recordedAt: '2026-09-01T10:00:00.000Z',
    };
    await fixture.service.syncChange(base(fixture.programId, 9, 'sync-no-change-before-rewrite'));
    ownerPort.state.snapshot.assetVersionRef = exactTarget('v2');

    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 10, 'sync-no-change-version-rewrite')),
      /changed refs/i,
    );
  });

  it('rejects an Approval ref rewrite before accepting an owner intervention receipt', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'no_change',
      ...refs,
      approvalRef: owner('F246', 'approval:rewritten'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:n1'),
      recordedAt: '2026-09-01T10:00:00.000Z',
    };

    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 9, 'sync-rewritten-approval')),
      /Approval ref changed/i,
    );
  });

  it('lets the value owner record no_change against the unchanged exact version', async () => {
    const ownerPort = changeOwner();
    const fixture = await noChangeDeciding(ownerPort);
    ownerPort.recordMetabolismDecision = async (input) => {
      ownerPort.state.decisionCalls.push(input);
      return {
        status: 'recorded',
        decisionRef: owner('F266', 'eval-repair-decision:no-change-after-no-change'),
        executionReceiptRef: owner('F202', 'no-change-decision-receipt:n1'),
        assetVersionRef: exactTarget('v1'),
      };
    };
    const result = await fixture.service.decideChange({
      ...base(fixture.programId, 11, 'decide-no-change-after-no-change'),
      decision: 'no_change',
      decisionAuthority,
    });

    assert.equal(result.projection.program.terminalDisposition, 'no_change');
    assert.equal(result.projection.program.currentAssetVersionRefs[0].version, 'v1');
    assert.equal(ownerPort.state.decisionCalls[0].outcomeReceiptRef.ownerStateRef, 'eval-repair-outcome:no-change-1');
    assert.equal('outcomeRef' in ownerPort.state.decisionCalls[0], false);
  });

  it('rejects stale evidence on the no-change branch', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'outcome',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:n1'),
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:no-change-1'),
      freshnessProofRef: owner('F267', 'measurement-proof:post-no-change-1'),
      recordedAt: '2026-09-01T10:00:00.000Z',
      measuredAt: '2026-09-01T10:00:00.000Z',
    };
    await fixture.service.syncChange(base(fixture.programId, 9, 'sync-stale-no-change-intervention'));
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 10, 'sync-stale-no-change-outcome')),
      /fresh post-receipt/i,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'revalidating');
  });

  it('rejects a no-change receipt that invents a deployment', async () => {
    const ownerPort = changeOwner();
    const fixture = await approved(ownerPort);
    ownerPort.state.snapshot = {
      status: 'outcome',
      ...refs,
      approvalRef: owner('F246', 'approval:proposal-1'),
      interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:n1'),
      outcomeReceiptRef: owner('F266', 'eval-repair-outcome:no-change-1'),
      loadedRuntimeRef: owner('F302', 'loaded-runtime:invented'),
      freshnessProofRef: owner('F267', 'measurement-proof:post-no-change-1'),
      recordedAt: '2026-09-01T10:00:00.000Z',
      measuredAt: '2026-09-01T11:00:00.000Z',
    };
    await assert.rejects(
      fixture.service.syncChange(base(fixture.programId, 9, 'sync-deployment-shaped-no-change')),
      /assetVersionRef|no-change|loaded runtime/i,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'writing_back');
  });

  it('keeps an owner-side resolution blocker typed and append-free', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    ownerPort.resolveChange = async () => ({ status: 'blocked', reason: 'proposal_not_found' });
    const result = await fixture.service.syncChange(base(fixture.programId, 8, 'sync-owner-blocked'));

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blockerReason, 'proposal_not_found');
    assert.equal(result.blockerRef, undefined);
    assert.equal(result.projection.program.sequence, 8);
  });

  it('does not append a value decision when the canonical owner blocks it', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    ownerPort.recordMetabolismDecision = async (input) => {
      ownerPort.state.decisionCalls.push(input);
      return { status: 'blocked', reason: 'value_authority_unverified' };
    };
    const result = await fixture.service.decideChange({
      ...base(fixture.programId, 11, 'decide-owner-blocked'),
      decision: 'keep',
      decisionAuthority,
    });

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blockerReason, 'value_authority_unverified');
    assert.equal(result.projection.program.stage, 'deciding');
    assert.equal(result.projection.program.sequence, 11);
    assert.equal(ownerPort.state.decisionCalls.length, 1);
  });
});
