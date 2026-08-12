import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID } from '../../dist/infrastructure/harness-eval/capability-wakeup-closure-import.js';
import { enrichEvalHubLifecycle } from '../../dist/infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';
import { loadReevalClosureSubjects } from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';

const harnessFeedbackRoot = join(process.cwd(), '..', '..', 'docs', 'harness-feedback');

class MemoryEventLog {
  streams = new Map();
  async read(subjectId) {
    return structuredClone(this.streams.get(subjectId) ?? []);
  }
  async append(event, expectedSequence) {
    const subjectId = event.caseId ?? event.verdictId;
    const events = this.streams.get(subjectId) ?? [];
    if (events.some((candidate) => candidate.eventId === event.eventId)) return { outcome: 'duplicate' };
    if (events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: events.length };
    events.push(structuredClone(event));
    this.streams.set(subjectId, events);
    return { outcome: 'appended', sequence: expectedSequence };
  }
}

describe('F266 production legacy case Hub projection', () => {
  it('replaces duplicate v1 cards with stable repair and cadence responsibilities', async () => {
    const now = '2026-08-09T04:20:00.000Z';
    const eventLog = new MemoryEventLog();
    const subjects = await loadReevalClosureSubjects({ harnessFeedbackRoot, eventLog });
    const workspaceCase = subjects.find(
      (candidate) =>
        'caseRoot' in candidate &&
        candidate.roots.some((root) => root.harnessUnderEval.componentId === 'workspace-navigator'),
    );
    assert.ok(workspaceCase && 'caseRoot' in workspaceCase);
    assert.equal(workspaceCase.caseRoot.reevalWithinHours, 168);
    assert.ok(
      workspaceCase.roots.some((root) => root.verdictId === CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID),
      'the historical root must remain part of the stable case lineage',
    );
    assert.equal(
      subjects.filter(
        (candidate) =>
          !('caseRoot' in candidate) && candidate.root.verdictId === CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
      ).length,
      0,
      'the stable migration must not leave a second per-verdict responsibility subject',
    );
    const qcCase = subjects.find((candidate) => 'caseRoot' in candidate && candidate.caseRoot.domainId === 'eval:qc');
    assert.ok(qcCase && 'caseRoot' in qcCase);
    assert.deepEqual(planReevalClosureEvents(qcCase, now)[0].event.legacyVerdictIds, [
      '2026-07-26-eval-qc-c3-zero-baseline',
      '2026-08-02-eval-qc-c2-zero-baseline',
      '2026-08-02-eval-qc-c4-zero-baseline',
    ]);
    for (const subject of subjects.filter((candidate) => 'caseRoot' in candidate)) {
      for (const planned of planReevalClosureEvents(subject, now)) {
        assert.notEqual((await eventLog.append(planned.event, planned.expectedSequence)).outcome, 'conflict');
      }
    }
    const raw = loadEvalHubSummary({ harnessFeedbackRoot, now: new Date(now) });
    raw.generatedAt = now;
    const enriched = await enrichEvalHubLifecycle(raw, { harnessFeedbackRoot, eventLog });

    const workspaceNavigator = enriched.items.find(
      (item) => item.harnessUnderEval.componentId === 'workspace-navigator',
    );
    assert.ok(workspaceNavigator);
    assert.equal(
      enriched.items.filter((item) => item.harnessUnderEval.componentId === 'workspace-navigator').length,
      1,
    );
    assert.equal(workspaceNavigator.lifecycle.targetOwnerCatId, 'opus-47');
    assert.equal(workspaceNavigator.lifecycle.ownerResponseStatus, 'acknowledged');
    assert.ok(
      workspaceNavigator.lifecycle.ownerResponseRefs.some(
        (ref) => ref.availability === 'available' && ref.value.includes('0001784195114335-000025-13f15128'),
      ),
    );
    assert.ok(
      workspaceNavigator.lifecycle.actionRefs.some(
        (ref) => ref.availability === 'available' && ref.value === '50ec90163',
      ),
    );
    assert.ok(
      workspaceNavigator.lifecycle.unavailableRefs.some(
        (ref) => ref.availability === 'unavailable' && ref.unavailableReason.includes('07-19 re-evaluation result'),
      ),
    );
    assert.equal(workspaceNavigator.lifecycle.repairDebtStatus, 'active');
    assert.equal(workspaceNavigator.lifecycle.reevalDebtStatus, 'not_scheduled');

    const f192Cadence = enriched.items.find(
      (item) => item.domainId === 'eval:task-outcome' && item.harnessUnderEval.componentId === 'Phase-G-v0',
    );
    assert.ok(f192Cadence);
    assert.equal(f192Cadence.lifecycle.closureStatus, 'monitoring');
    assert.equal(f192Cadence.lifecycle.repairDebtStatus, 'not_required');
    assert.equal(f192Cadence.lifecycle.reevalDebtStatus, 'due');
    assert.equal(f192Cadence.lifecycle.stale, true);
  });
});
