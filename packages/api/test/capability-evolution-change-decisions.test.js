import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  base,
  changeOwner,
  deciding,
  decisionAuthority,
  exactTarget,
  owner,
} from './capability-evolution-change.helper.mjs';

describe('F311 Phase 4 metabolism decisions', () => {
  it('executes all metabolism decisions through the owner before recording lineage', async () => {
    for (const decision of ['keep', 'tune', 'rollback', 'sunset', 'no_change']) {
      const ownerPort = changeOwner();
      const fixture = await deciding(ownerPort);
      const result = await fixture.service.decideChange({
        ...base(fixture.programId, 11, `decide-${decision}`),
        decision,
        decisionAuthority,
      });
      assert.equal(ownerPort.state.decisionCalls.length, 1, decision);
      assert.equal(ownerPort.state.decisionCalls[0].clientMessageId, `decide-${decision}`);
      assert.deepEqual(ownerPort.state.decisionCalls[0].decisionAuthority, decisionAuthority);
      const previous = result.projection.cycles[0];
      assert.equal(previous.decision, decision);
      assert.ok(previous.closedAt);
      if (decision === 'tune' || decision === 'rollback') {
        assert.equal(result.projection.program.cycle, 2);
        assert.equal(result.projection.program.stage, 'instrumenting');
        assert.equal(result.projection.cycles.length, 2);
      } else {
        assert.equal(result.projection.program.lifecycle, 'terminal');
      }
      if (decision === 'rollback') {
        assert.equal(result.projection.program.currentAssetVersionRefs[0].version, 'v0');
        assert.equal(result.projection.lineage.cycles[0].executionReceiptRef.ownerStateRef, 'rollback-receipt:r1');
        assert.equal(result.projection.lineage.cycles[0].decisionAssetVersionRef.version, 'v0');
      }
      if (decision === 'sunset') {
        assert.equal(result.projection.lineage.cycles[0].executionReceiptRef.ownerStateRef, 'sunset-receipt:s1');
      }
      if (decision === 'no_change') {
        assert.equal(result.projection.program.currentAssetVersionRefs[0].version, 'v2');
        assert.equal(result.projection.lineage.cycles[0].executionReceiptRef.ownerStateRef, 'no-change-receipt:n1');
        assert.equal(result.projection.lineage.cycles[0].decisionAssetVersionRef.version, 'v2');
      }
    }
  });

  it('fails closed before owner contact when the value decision has no owner-backed authority', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    await assert.rejects(
      fixture.service.decideChange({
        ...base(fixture.programId, 11, 'decide-without-value-authority'),
        decision: 'no_change',
      }),
      /value-owner authority/,
    );
    assert.equal(ownerPort.state.decisionCalls.length, 0);
  });

  it('rejects owner result statuses outside the metabolism receipt algebra', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    ownerPort.recordMetabolismDecision = async () => ({
      status: 'accepted',
      decisionRef: owner('F266', 'eval-repair-decision:status-leak'),
    });

    await assert.rejects(
      fixture.service.decideChange({
        ...base(fixture.programId, 11, 'decide-owner-status-leak'),
        decision: 'keep',
        decisionAuthority,
      }),
      /unsupported metabolism status/i,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.sequence, 11);
  });

  it('requires a no-change owner receipt bound to the unchanged exact asset version', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    ownerPort.recordMetabolismDecision = async () => ({
      status: 'recorded',
      decisionRef: owner('F266', 'eval-repair-decision:no-change-without-receipt'),
    });
    await assert.rejects(
      fixture.service.decideChange({
        ...base(fixture.programId, 11, 'decide-unreceipted-no-change'),
        decision: 'no_change',
        decisionAuthority,
      }),
      /no_change requires owner receipt and unchanged exact asset version/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'deciding');

    ownerPort.recordMetabolismDecision = async () => ({
      status: 'recorded',
      decisionRef: owner('F266', 'eval-repair-decision:no-change-drift'),
      executionReceiptRef: owner('F202', 'no-change-receipt:drift'),
      assetVersionRef: exactTarget('v3'),
    });
    await assert.rejects(
      fixture.service.decideChange({
        ...base(fixture.programId, 11, 'decide-drifted-no-change'),
        decision: 'no_change',
        decisionAuthority,
      }),
      /no_change requires owner receipt and unchanged exact asset version/,
    );
    assert.equal((await fixture.service.get(fixture.programId)).program.stage, 'deciding');
  });

  it('requires rollback and sunset to return real owner execution receipts', async () => {
    const rollbackOwner = changeOwner();
    const rollbackFixture = await deciding(rollbackOwner);
    rollbackOwner.recordMetabolismDecision = async () => ({
      status: 'recorded',
      decisionRef: owner('F266', 'eval-repair-decision:rollback-without-receipt'),
    });
    await assert.rejects(
      rollbackFixture.service.decideChange({
        ...base(rollbackFixture.programId, 11, 'decide-unreceipted-rollback'),
        decision: 'rollback',
        decisionAuthority,
      }),
      /rollback requires owner receipt and reverted exact asset version/,
    );

    rollbackOwner.recordMetabolismDecision = async () => ({
      status: 'recorded',
      decisionRef: owner('F266', 'eval-repair-decision:rollback-no-op'),
      executionReceiptRef: owner('F202', 'rollback-receipt:no-op'),
      assetVersionRef: exactTarget('v2'),
    });
    await assert.rejects(
      rollbackFixture.service.decideChange({
        ...base(rollbackFixture.programId, 11, 'decide-no-op-rollback'),
        decision: 'rollback',
        decisionAuthority,
      }),
      /rollback requires owner receipt and reverted exact asset version/,
    );
    assert.equal((await rollbackFixture.service.get(rollbackFixture.programId)).program.stage, 'deciding');

    const sunsetOwner = changeOwner();
    const sunsetFixture = await deciding(sunsetOwner);
    sunsetOwner.recordMetabolismDecision = async () => ({
      status: 'recorded',
      decisionRef: owner('F266', 'eval-repair-decision:sunset-without-receipt'),
    });
    await assert.rejects(
      sunsetFixture.service.decideChange({
        ...base(sunsetFixture.programId, 11, 'decide-unreceipted-sunset'),
        decision: 'sunset',
        decisionAuthority,
      }),
      /sunset requires owner execution receipt/,
    );
    assert.equal((await sunsetFixture.service.get(sunsetFixture.programId)).program.stage, 'deciding');
  });

  it('reuses the owner idempotency key after a crash between decision execution and Program append', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    const receipts = new Map();
    let ownerExecutions = 0;
    ownerPort.recordMetabolismDecision = async (input) => {
      ownerPort.state.decisionCalls.push(input);
      let receipt = receipts.get(input.clientMessageId);
      if (!receipt) {
        ownerExecutions += 1;
        receipt = {
          status: 'recorded',
          decisionRef: owner('F266', 'eval-repair-decision:crash-window-rollback'),
          executionReceiptRef: owner('F202', 'rollback-receipt:crash-window'),
          assetVersionRef: exactTarget('v0'),
        };
        receipts.set(input.clientMessageId, receipt);
      }
      return receipt;
    };
    const append = fixture.eventLog.append.bind(fixture.eventLog);
    let crashBeforeProgramAppend = true;
    fixture.eventLog.append = async (envelope) => {
      if (crashBeforeProgramAppend && envelope.event.type === 'decision_recorded') {
        crashBeforeProgramAppend = false;
        throw new Error('simulated crash after owner execution');
      }
      return append(envelope);
    };
    const command = {
      ...base(fixture.programId, 11, 'decide-crash-window-rollback'),
      decision: 'rollback',
      decisionAuthority,
    };
    await assert.rejects(fixture.service.decideChange(command), /simulated crash/);
    const retried = await fixture.service.decideChange(command);

    assert.equal(retried.outcome, 'appended');
    assert.equal(ownerPort.state.decisionCalls.length, 2);
    assert.equal(ownerPort.state.decisionCalls[0].clientMessageId, 'decide-crash-window-rollback');
    assert.equal(ownerPort.state.decisionCalls[1].clientMessageId, 'decide-crash-window-rollback');
    assert.equal(ownerExecutions, 1);
    assert.equal(
      retried.projection.lineage.cycles[0].executionReceiptRef.ownerStateRef,
      'rollback-receipt:crash-window',
    );
  });

  it('rejects a stale metabolism decision before the owner can execute it', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    const conflict = await fixture.service.decideChange({
      ...base(fixture.programId, 10, 'stale-decision'),
      decision: 'rollback',
      decisionAuthority,
    });
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.actualSequence, 11);
    assert.equal(ownerPort.state.decisionCalls.length, 0);
  });

  it('rejects a fresh metabolism command after the Program became terminal before owner contact', async () => {
    const ownerPort = changeOwner();
    const fixture = await deciding(ownerPort);
    const terminal = await fixture.service.decideChange({
      ...base(fixture.programId, 11, 'decide-terminal-keep'),
      decision: 'keep',
      decisionAuthority,
    });
    assert.equal(terminal.projection.program.lifecycle, 'terminal');
    assert.equal(ownerPort.state.decisionCalls.length, 1);

    await assert.rejects(
      fixture.service.decideChange({
        ...base(fixture.programId, 12, 'decide-after-terminal'),
        decision: 'sunset',
        decisionAuthority,
      }),
      /active\/deciding/,
    );
    assert.equal(ownerPort.state.decisionCalls.length, 1);
  });
});
