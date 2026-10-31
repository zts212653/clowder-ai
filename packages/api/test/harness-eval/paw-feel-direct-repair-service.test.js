import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PawFeelDispositionService } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/service.js';
import {
  MemoryPawFeelEventLog,
  pawFeelCandidate,
  pawFeelCommand,
} from './helpers/paw-feel-disposition-service-fixture.js';

const ref = (ownerFeatureId, ownerStateRef, version) => ({
  ownerFeatureId,
  ownerStateRef,
  ...(version ? { version } : {}),
});
const binding = {
  schemaVersion: 1,
  bindingRef: ref('F278', `paw-feel-direct-repair-binding:sha256:${'b'.repeat(64)}`),
  sourceSignalRef: ref('F278', 'paw-feel-signal:source', `${'a'.repeat(64)}:0`),
  sourceToolRef: ref('F167', 'mcp-tool:cat_cafe_hold_ball'),
  providerId: 'f167-owner',
  providerVersion: 'v1',
  providerRouteRef: ref('F278', `paw-feel-direct-repair-route:sha256:${'c'.repeat(64)}`),
  resolvedActionRef: ref('F167', 'action:repair-1'),
  actionScopeRef: ref('F167', 'action-scope:hold-ball'),
  ownerAuthorizationRef: ref('F167', 'authorization:existing'),
  targetVersionRef: {
    ...ref('F167', 'action-target:hold-ball', 'v1'),
    assetKind: 'mcp_tool',
    assetId: 'cat_cafe_hold_ball',
  },
  ownerCatId: 'opus',
  outcomeVerifierRef: ref('F167', 'outcome-verifier:hold-ball:v1'),
};
const fix = {
  ownerCatId: 'opus',
  taskId: 'task-1',
  leaseId: 'lease-active',
  leaseGeneration: 2,
  custodyEvidenceRef: 'action-lease:lease-active:generation:2',
};

async function harness({ directResolution, outcome } = {}) {
  const eventLog = new MemoryPawFeelEventLog();
  const service = new PawFeelDispositionService({
    eventLog,
    directRepairResolver: {
      async resolve() {
        return directResolution ?? { status: 'authorized', fix, binding };
      },
    },
    repairOutcomeResolver: {
      async resolve(input) {
        assert.deepEqual(input.bindingRef, binding.bindingRef);
        return outcome;
      },
    },
    now: () => '2026-09-07T00:00:00.000Z',
  });
  const source = pawFeelCandidate();
  await service.discover(source, { backfilled: false });
  return { eventLog, service, source };
}

describe('F313 direct repair command admission and outcome link', () => {
  it('requires opaque actionRef and persists only the owner-derived binding', async () => {
    const { eventLog, service, source } = await harness();
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'opus' },
        pawFeelCommand('mark_fix', source.signalId, 1, { leaseId: 'lease-active' }),
      ),
      (error) => error?.code === 'invalid_command',
    );

    const result = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: 'lease-active',
        actionRef: 'opaque-action-ref',
      }),
    );
    const stored = (await eventLog.read(source.signalId))[1];

    assert.equal(result.outcome, 'appended');
    assert.deepEqual(stored.directRepairBinding, binding);
    assert.equal(JSON.stringify(stored).includes('opaque-action-ref'), false);
  });

  it('rejects caller-authored authority, target, and outcome fields before provider resolution', async () => {
    const { eventLog, service, source } = await harness();
    for (const command of [
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: 'lease-active',
        actionRef: 'opaque-action-ref',
        ownerAuthorizationRef: ref('F167', 'authorization:forged'),
      }),
      pawFeelCommand('link_repair_outcome', source.signalId, 1, {
        bindingRef: binding.bindingRef,
        ownerOutcomeRef: ref('F167', 'owner-outcome:forged'),
        outcome: { disposition: 'verified_changed', payload: 'forged' },
      }),
    ]) {
      await assert.rejects(
        service.execute({ kind: 'cat', id: 'opus' }, command),
        (error) => error?.code === 'invalid_command',
      );
    }
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });

  it('returns an authority continuation with zero fix events', async () => {
    const continuation = {
      kind: 'approval_required',
      caseActionRef: 'case-action:f266:existing',
      findingArtifactRef: 'docs/harness-feedback/bundles/finding/finding.json',
    };
    const { eventLog, service, source } = await harness({
      directResolution: { status: 'continuation', continuation },
    });
    const result = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: 'lease-active',
        actionRef: 'requires-new-authority',
      }),
    );

    assert.deepEqual(result, {
      outcome: 'continuation',
      projection: result.projection,
      continuation,
    });
    assert.equal((await eventLog.read(source.signalId)).length, 1);
  });

  it('links only a server-verified refs-only owner outcome', async () => {
    const verifiedOutcome = {
      schemaVersion: 1,
      bindingRef: binding.bindingRef,
      taskTerminalRef: ref('F310', 'task-terminal:task-1', '7'),
      leaseTerminalRef: ref('F167', 'action-successor-terminal:lease-active', '2'),
      ownerOutcomeRef: ref('F167', 'owner-outcome:repair-1', '1'),
      verificationRefs: [ref('F167', 'verification:loaded-main', 'abc')],
      disposition: 'verified_changed',
    };
    const { eventLog, service, source } = await harness({ outcome: verifiedOutcome });
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: 'lease-active',
        actionRef: 'opaque-action-ref',
      }),
    );
    const result = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('link_repair_outcome', source.signalId, 2, {
        bindingRef: binding.bindingRef,
        ownerOutcomeRef: verifiedOutcome.ownerOutcomeRef,
      }),
    );

    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.repairOutcome.disposition, 'verified_changed');
    assert.deepEqual((await eventLog.read(source.signalId))[2].outcome, verifiedOutcome);
  });

  it('replays an exact fix and outcome without consulting drifted live resolvers', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    let rejectLiveResolution = false;
    const verifiedOutcome = {
      schemaVersion: 1,
      bindingRef: binding.bindingRef,
      taskTerminalRef: ref('F310', 'task-terminal:task-1', '7'),
      leaseTerminalRef: ref('F167', 'action-successor-terminal:lease-active', '2'),
      ownerOutcomeRef: ref('F167', 'owner-outcome:repair-1', '1'),
      verificationRefs: [ref('F167', 'verification:loaded-main', 'abc')],
      disposition: 'verified_changed',
    };
    const service = new PawFeelDispositionService({
      eventLog,
      directRepairResolver: {
        async resolve() {
          if (rejectLiveResolution) throw new Error('provider route drifted after append');
          return { status: 'authorized', fix, binding };
        },
      },
      repairOutcomeResolver: {
        async resolve() {
          if (rejectLiveResolution) throw new Error('owner outcome provider is unavailable after append');
          return verifiedOutcome;
        },
      },
      now: () => '2026-09-07T00:00:00.000Z',
    });
    const source = pawFeelCandidate();
    await service.discover(source, { backfilled: false });
    const fixCommand = pawFeelCommand('mark_fix', source.signalId, 1, {
      leaseId: 'lease-active',
      actionRef: 'opaque-action-ref',
    });
    const outcomeCommand = pawFeelCommand('link_repair_outcome', source.signalId, 2, {
      bindingRef: binding.bindingRef,
      ownerOutcomeRef: verifiedOutcome.ownerOutcomeRef,
    });
    await service.execute({ kind: 'cat', id: 'opus' }, fixCommand);
    await service.execute({ kind: 'cat', id: 'opus' }, outcomeCommand);
    rejectLiveResolution = true;

    assert.equal((await service.execute({ kind: 'cat', id: 'opus' }, fixCommand)).outcome, 'duplicate');
    assert.equal((await service.execute({ kind: 'cat', id: 'opus' }, outcomeCommand)).outcome, 'duplicate');
    assert.equal((await eventLog.read(source.signalId)).length, 3);
  });

  it('does not allow a verified repair outcome to be overwritten by a later disposition', async () => {
    const verifiedOutcome = {
      schemaVersion: 1,
      bindingRef: binding.bindingRef,
      taskTerminalRef: ref('F310', 'task-terminal:task-1', '7'),
      leaseTerminalRef: ref('F167', 'action-successor-terminal:lease-active', '2'),
      ownerOutcomeRef: ref('F167', 'owner-outcome:repair-1', '1'),
      verificationRefs: [ref('F167', 'verification:loaded-main', 'abc')],
      disposition: 'verified_changed',
    };
    const { eventLog, service, source } = await harness({ outcome: verifiedOutcome });
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: 'lease-active',
        actionRef: 'opaque-action-ref',
      }),
    );
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('link_repair_outcome', source.signalId, 2, {
        bindingRef: binding.bindingRef,
        ownerOutcomeRef: verifiedOutcome.ownerOutcomeRef,
      }),
    );

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'sonnet' },
        pawFeelCommand('mark_no_action', source.signalId, 3, { reasonCode: 'not_actionable' }),
      ),
      /verified repair outcome is terminal/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 3);
  });

  it('lets the bound source owner link an outcome after an independent cat signs the fix', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    const sourceOwnerBinding = { ...binding, ownerCatId: 'codex-sol' };
    const sourceOwnerFix = { ...fix, ownerCatId: 'codex-sol' };
    const verifiedOutcome = {
      schemaVersion: 1,
      bindingRef: sourceOwnerBinding.bindingRef,
      taskTerminalRef: ref('F310', 'task-terminal:task-1', '7'),
      leaseTerminalRef: ref('F167', 'action-successor-terminal:lease-active', '2'),
      ownerOutcomeRef: ref('F167', 'owner-outcome:source-owner', '1'),
      verificationRefs: [ref('F167', 'verification:loaded-main', 'abc')],
      disposition: 'verified_changed',
    };
    const service = new PawFeelDispositionService({
      eventLog,
      directRepairResolver: {
        async resolve() {
          return { status: 'authorized', fix: sourceOwnerFix, binding: sourceOwnerBinding };
        },
      },
      repairOutcomeResolver: {
        async resolve() {
          return verifiedOutcome;
        },
      },
      now: () => '2026-09-07T00:00:00.000Z',
    });
    const source = pawFeelCandidate({ sourceCatId: 'codex-sol' });
    await service.discover(source, { backfilled: false });
    await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_fix', source.signalId, 1, {
        leaseId: sourceOwnerFix.leaseId,
        actionRef: 'source-owner-action',
      }),
    );

    const result = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      pawFeelCommand('link_repair_outcome', source.signalId, 2, {
        bindingRef: sourceOwnerBinding.bindingRef,
        ownerOutcomeRef: verifiedOutcome.ownerOutcomeRef,
      }),
    );

    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.repairOutcome.disposition, 'verified_changed');
    assert.equal(result.projection.lastActorCatId, 'codex-sol');
  });
});
