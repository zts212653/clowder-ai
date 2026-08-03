import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCapabilityWakeupClosureImport } from '../../dist/infrastructure/harness-eval/capability-wakeup-closure-import.js';
import { ReevalClosureService } from '../../dist/infrastructure/harness-eval/reeval-closure-service.js';
import { createServiceHarness, ref } from './reeval-closure-service-fixtures.js';

async function createHistoricalServiceHarness() {
  const { eventLog, roots } = await createServiceHarness();
  const imported = buildCapabilityWakeupClosureImport();
  const verdictId = imported.root.verdictId;
  eventLog.events.clear();
  eventLog.seen.clear();
  roots.clear();
  roots.set(verdictId, {
    verdictId,
    domainId: imported.root.domainId,
    targetOwnerCatId: imported.root.ownerAsk.targetOwnerCatId,
    assignedEvalCatId: 'gpt52',
    reevalWithinHours: 168,
  });
  const service = new ReevalClosureService({
    eventLog,
    loadRoot: async (candidateVerdictId) => roots.get(candidateVerdictId),
    loadBootstrap: async (candidateVerdictId) =>
      candidateVerdictId === verdictId ? imported.bootstrapEvents : undefined,
    now: () => '2026-07-19T03:00:01.000Z',
  });
  return { eventLog, imported, service, verdictId };
}

describe('eval verdict lifecycle command service bootstrap', () => {
  it('accepts the first writeback after materializing a historical multi-event bootstrap', async () => {
    const { imported, service, verdictId } = await createHistoricalServiceHarness();

    const result = await service.execute(
      { kind: 'cat', id: 'gpt52' },
      {
        type: 'record_reeval_result',
        eventId: 'capability-wakeup-2026-07-19-pass',
        verdictId,
        expectedSequence: 0,
        result: 'passed',
        reason: 'the scheduled re-evaluation verified the repaired behavior',
        refs: [ref('reeval', 'docs/verdicts/2026-07-19-capability-wakeup.md')],
      },
    );

    assert.equal(result.outcome, 'appended');
    assert.equal(result.projection.status, 'resolved');
    assert.equal(result.projection.sequence, imported.bootstrapEvents.length + 1);
  });

  it('keeps stale sequence zero conflicting after a historical stream has a business suffix', async () => {
    const { eventLog, imported, service, verdictId } = await createHistoricalServiceHarness();
    for (const [sequence, event] of imported.bootstrapEvents.entries()) {
      assert.equal((await eventLog.append(event, sequence)).outcome, 'appended');
    }
    assert.equal(
      (
        await eventLog.append(
          {
            eventId: 'capability-wakeup-2026-07-19-fail',
            verdictId,
            domainId: imported.root.domainId,
            type: 'reeval_failed',
            actor: { kind: 'cat', id: 'gpt52' },
            assignedEvalCatId: 'gpt52',
            occurredAt: '2026-07-19T03:00:00.000Z',
            reason: 'the first re-evaluation still found a gap',
            refs: [ref('reeval', 'docs/verdicts/2026-07-19-capability-wakeup.md')],
          },
          imported.bootstrapEvents.length,
        )
      ).outcome,
      'appended',
    );

    const result = await service.execute(
      { kind: 'cat', id: imported.root.ownerAsk.targetOwnerCatId },
      {
        type: 'record_fix',
        eventId: 'capability-wakeup-second-fix',
        verdictId,
        expectedSequence: 0,
        reason: 'record a second fix after the failed cycle',
        refs: [ref('commit', 'second-fix')],
      },
    );

    assert.deepEqual(result, { outcome: 'conflict', actualSequence: imported.bootstrapEvents.length + 1 });
  });
});
