import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeSchema } from '../dist/routes/capability-evolution-program-schemas.js';
import {
  awaitingApproval,
  base,
  changeOwner,
  measurementRefs,
  observingProgram,
  owner,
  proposed,
  refs,
  requestAuthority,
} from './capability-evolution-change.helper.mjs';

describe('F311 Phase 4 governed change proposal bridge', () => {
  it('fails closed before owner contact when proposal authority is absent', async () => {
    const ownerPort = changeOwner();
    const fixture = await awaitingApproval(ownerPort);
    await assert.rejects(
      fixture.service.proposeChange(base(fixture.programId, 7, 'propose-without-authority')),
      /authenticated invocation authority/,
    );
    assert.equal(ownerPort.state.requestCalls, 0);
  });

  it('does not contact the change owner from an observe/insufficient Program', async () => {
    const ownerPort = changeOwner();
    const { service, programId } = await observingProgram({
      changeOwner: ownerPort,
      bundle: { ownerDecisionStatus: 'insufficient' },
    });
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await assert.rejects(
      service.proposeChange({ ...base(programId, 5, 'propose-change'), requestAuthority }),
      /awaiting_approval/,
    );
    assert.equal(ownerPort.state.requestCalls, 0);
    assert.equal(ownerPort.state.resolveCalls, 0);
  });

  it('submits only refs and makes proposal retries exactly once', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    const duplicate = await fixture.service.proposeChange({
      ...base(fixture.programId, 7, 'propose-change'),
      requestAuthority,
    });
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(ownerPort.state.requestCalls, 1);
    const lineage = duplicate.projection.lineage;
    assert.equal(lineage.current.caseRef.ownerStateRef, refs.caseRef.ownerStateRef);
    assert.equal(lineage.current.proposalRef.ownerStateRef, refs.proposalRef.ownerStateRef);
    assert.equal(lineage.current.ownerAuthorizationRef.ownerStateRef, refs.ownerAuthorizationRef.ownerStateRef);
    assert.equal(lineage.current.targetVersionRef.version, 'v1');
    assert.equal(JSON.stringify(lineage).includes('approvalPayload'), false);
    assert.equal(JSON.stringify(lineage).includes('mutationPayload'), false);
  });

  it('reuses the owner idempotency key after a crash between Approval request and Program append', async () => {
    const ownerPort = changeOwner();
    const fixture = await awaitingApproval(ownerPort);
    const requests = new Map();
    const requestKeys = [];
    let approvalExecutions = 0;
    ownerPort.requestApproval = async (input) => {
      ownerPort.state.requestCalls += 1;
      requestKeys.push(input.clientMessageId);
      let response = requests.get(input.clientMessageId);
      if (!response) {
        approvalExecutions += 1;
        response = { status: 'pending', ...refs };
        requests.set(input.clientMessageId, response);
      }
      return response;
    };
    const append = fixture.eventLog.append.bind(fixture.eventLog);
    let crashBeforeProgramAppend = true;
    fixture.eventLog.append = async (envelope) => {
      if (crashBeforeProgramAppend && envelope.event.type === 'change_cycle_linked') {
        crashBeforeProgramAppend = false;
        throw new Error('simulated crash after Approval request');
      }
      return append(envelope);
    };
    const command = {
      ...base(fixture.programId, 7, 'propose-crash-window'),
      requestAuthority,
    };
    await assert.rejects(fixture.service.proposeChange(command), /simulated crash/);
    const retried = await fixture.service.proposeChange(command);

    assert.equal(retried.outcome, 'appended');
    assert.deepEqual(requestKeys, ['propose-crash-window', 'propose-crash-window']);
    assert.equal(approvalExecutions, 1);
    assert.equal(retried.projection.lineage.current.proposalRef.ownerStateRef, refs.proposalRef.ownerStateRef);
  });

  it('fails closed when the owner cannot prove permission for the exact mutation surface', async () => {
    const ownerPort = changeOwner();
    const fixture = await awaitingApproval(ownerPort);
    ownerPort.state.requestResult = {
      status: 'pending',
      caseRef: refs.caseRef,
      proposalRef: refs.proposalRef,
      targetVersionRef: refs.targetVersionRef,
    };
    await assert.rejects(
      fixture.service.proposeChange({
        ...base(fixture.programId, 7, 'propose-without-owner-permission'),
        requestAuthority,
      }),
      /owner authorization/i,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.sequence, 7);
  });

  it('returns an owner-backed typed blocker without appending local lifecycle state', async () => {
    const ownerPort = changeOwner();
    const fixture = await awaitingApproval(ownerPort);
    ownerPort.state.requestResult = {
      status: 'blocked',
      reason: 'owner_authorization_missing',
      blockerRef: owner('external-asset-owner', 'permission-blocker:surface-not-authorized'),
    };
    const result = await fixture.service.proposeChange({
      ...base(fixture.programId, 7, 'propose-blocked-by-owner'),
      requestAuthority,
    });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blockerRef.ownerFeatureId, 'external-asset-owner');
    assert.equal(result.blockerRef.ownerStateRef, 'permission-blocker:surface-not-authorized');
    assert.equal(result.projection.program.sequence, 7);
    assert.equal(result.projection.lineage.current, undefined);
  });

  it('rejects owner result statuses outside the ref-only approval algebra', async () => {
    const ownerPort = changeOwner();
    const fixture = await awaitingApproval(ownerPort);
    ownerPort.state.requestResult = {
      status: 'not_required',
      ...refs,
    };

    await assert.rejects(
      fixture.service.proposeChange({
        ...base(fixture.programId, 7, 'propose-owner-status-leak'),
        requestAuthority,
      }),
      /unsupported approval status/i,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.sequence, 7);
  });

  it('rejects a stale proposal sequence before contacting the owner', async () => {
    const ownerPort = changeOwner();
    const fixture = await awaitingApproval(ownerPort);
    const conflict = await fixture.service.proposeChange({
      ...base(fixture.programId, 6, 'stale-propose-change'),
      requestAuthority,
    });
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.actualSequence, 7);
    assert.equal(ownerPort.state.requestCalls, 0);
  });

  it('rejects a second active proposal instead of delegating duplicate custody', async () => {
    const ownerPort = changeOwner();
    const fixture = await proposed(ownerPort);
    await assert.rejects(
      fixture.service.proposeChange({
        ...base(fixture.programId, 8, 'another-proposal'),
        requestAuthority,
      }),
      /already has an active canonical change proposal/,
    );
    assert.equal(ownerPort.state.requestCalls, 1);
  });

  it('keeps Approval, owner and receipt truth out of the public change command', () => {
    const clean = {
      expectedSequence: 8,
      clientMessageId: 'change-command',
      action: { kind: 'sync' },
    };
    assert.equal(changeSchema.safeParse(clean).success, true);
    for (const smuggled of [
      { ...clean, approvalRef: owner('F246', 'approval:forged') },
      { ...clean, action: { ...clean.action, proposalRef: owner('F266', 'eval-repair-proposal:forged') } },
      { ...clean, interventionReceiptRef: owner('F202', 'mutation-receipt:forged') },
      { ...clean, outcomeReceiptRef: owner('F266', 'eval-repair-outcome:forged') },
    ]) {
      assert.equal(changeSchema.safeParse(smuggled).success, false);
    }
  });
});
