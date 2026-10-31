import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCapabilityWakeupClosureImport } from '../../dist/infrastructure/harness-eval/capability-wakeup-closure-import.js';
import { projectReevalClosure } from '../../dist/infrastructure/harness-eval/reeval-closure.js';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';

describe('capability-wakeup historical closure import', () => {
  it('preserves the 07-12 → 07-16 → fix → pending re-eval chain without inventing a pass', () => {
    const imported = buildCapabilityWakeupClosureImport();

    assert.equal(imported.root.verdictId, '2026-07-12-capability-wakeup-workspace-navigator-cognitive-fix');
    assert.equal(imported.root.ownerAsk.targetOwnerCatId, 'opus-47');
    assert.equal(imported.assignedEvalCatId, undefined, 'historical eval principal is not durably proven');
    assert.deepEqual(
      imported.bootstrapEvents.map((event) => event.type),
      ['verdict_opened', 'owner_acknowledged', 'action_planned', 'fix_recorded', 'reeval_requested'],
    );

    const projection = projectReevalClosure(
      {
        verdictId: imported.root.verdictId,
        domainId: imported.root.domainId,
        targetOwnerCatId: imported.root.ownerAsk.targetOwnerCatId,
      },
      imported.bootstrapEvents,
    );
    assert.equal(projection.status, 'reeval_pending');
    assert.equal(
      projection.ownerResponseRefs[0].value,
      'thread:thread_eval_capability_wakeup:message:0001784195114335-000025-13f15128',
    );
    assert.equal(projection.actionRefs[0].value, '50ec90163');
    assert.equal(projection.reevalDueAt, '2026-07-19T03:00:00.000Z');
    assert.equal(
      projection.history.some((event) => event.type === 'reeval_passed'),
      false,
    );
    assert.ok(
      projection.refs.some(
        (evidence) =>
          evidence.availability === 'unavailable' &&
          evidence.unavailableReason.includes('predates lifecycle-root.json'),
      ),
    );
    assert.ok(
      projection.reevalRefs.some(
        (evidence) => evidence.availability === 'unavailable' && evidence.unavailableReason.includes('result'),
      ),
    );
  });

  it('resumes a partial import from the exact missing suffix', () => {
    const imported = buildCapabilityWakeupClosureImport();
    const planned = planReevalClosureEvents(
      { ...imported, events: imported.bootstrapEvents.slice(0, 2) },
      '2026-07-18T12:00:00.000Z',
    );

    assert.deepEqual(
      planned.map((item) => item.event.type),
      ['action_planned', 'fix_recorded', 'reeval_requested'],
    );
    assert.deepEqual(
      planned.map((item) => item.expectedSequence),
      [2, 3, 4],
    );
  });
});
