import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  cleanupSourceCaseFixtures,
  harness,
  harnessState,
  projection,
  sourceSignalRef,
  writeCase,
} from './helpers/paw-feel-source-case-fixture.js';

afterEach(cleanupSourceCaseFixtures);

describe('F313 exact source to existing F266 case action', () => {
  it('returns a bounded analysis continuation when no finding exists', async () => {
    const resolver = await harness();
    const result = await resolver.resolve({ projection });

    assert.equal(result.kind, 'analysis_required');
    assert.deepEqual(result.sourceSignalRef, sourceSignalRef);
    assert.deepEqual(result.resume, { kind: 'bounded_time', recheckAt: '2026-09-04T00:00:00.000Z' });
  });

  it('returns only the unique active caseActionRef already born in F266', async () => {
    const resolver = await harness([{ findingKey: 'one', verdictId: 'verdict-one' }]);
    const result = await resolver.resolve({ projection });

    assert.deepEqual(result, {
      kind: 'approval_required',
      caseActionRef: 'case-action:verdict-one',
      findingArtifactRef: 'docs/harness-feedback/bundles/verdict-one/finding.json',
    });
  });

  it('fails closed as ambiguous when two active findings bind the same source', async () => {
    const resolver = await harness([
      { findingKey: 'one', verdictId: 'verdict-one' },
      { findingKey: 'two', verdictId: 'verdict-two' },
    ]);
    const result = await resolver.resolve({ projection });

    assert.equal(result.kind, 'analysis_ambiguous');
    assert.equal(result.evidenceRefs.length, 2);
  });

  it('reports a matching artifact without a current F266 action as stale', async () => {
    const resolver = await harness([{ findingKey: 'old', verdictId: 'verdict-old', ready: false }]);
    const result = await resolver.resolve({ projection });

    assert.equal(result.kind, 'analysis_stale');
    assert.deepEqual(result.evidenceRefs, ['docs/harness-feedback/bundles/verdict-old/finding.json']);
  });

  it('does not retain a process-lifetime artifact snapshot after a new finding lands', async () => {
    const state = await harnessState();
    assert.equal((await state.resolver.resolve({ projection })).kind, 'analysis_required');
    const value = await writeCase(state.root, 'arrived-later', 'verdict-arrived-later');
    state.events.set(value.caseId, [
      {
        type: 'case_ready_for_proposal',
        caseId: value.caseId,
        verdictId: value.verdictId,
        caseActionRef: 'case-action:verdict-arrived-later',
        findingArtifactRef: value.artifactRef,
        occurredAt: '2026-09-01T00:00:01.000Z',
      },
    ]);

    const refreshed = await state.resolver.resolve({ projection });
    assert.equal(refreshed.kind, 'approval_required');
    assert.equal(refreshed.caseActionRef, 'case-action:verdict-arrived-later');
  });

  it('rejects a cross-domain or target-mismatched lifecycle root as stale', async () => {
    const crossDomain = await harness([
      { findingKey: 'cross-domain', verdictId: 'verdict-cross-domain', rootDomainId: 'eval:sop' },
    ]);
    const mismatchedTarget = await harness([
      {
        findingKey: 'target-mismatch',
        verdictId: 'verdict-target-mismatch',
        rootTarget: {
          featureId: 'F999',
          ownerCatId: 'opus',
          version: `repair-target-v1-${'f'.repeat(64)}`,
          resolutionRef: 'feature-thread-owner:v1:F999:mismatch',
          resolvedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    ]);

    assert.equal((await crossDomain.resolve({ projection })).kind, 'analysis_stale');
    assert.equal((await mismatchedTarget.resolve({ projection })).kind, 'analysis_stale');
  });

  it('shows accepted-but-not-materialized Approval as dispatch pending', async () => {
    const resolver = await harness([{ findingKey: 'accepted', verdictId: 'verdict-accepted', accepted: true }]);
    const followUp = await resolver.resolveFollowUp({ projection });

    assert.equal(followUp.resolution, 'open');
    assert.equal(followUp.continuation.kind, 'dispatch_pending');
    assert.equal(followUp.continuation.proposalId, 'proposal:verdict-accepted');
  });

  it('carries the complete Approval/task/main/loaded/verification ref journey to the source projection', async () => {
    const resolver = await harness([{ findingKey: 'journey', verdictId: 'verdict-journey', journey: true }]);
    const followUp = await resolver.resolveFollowUp({ projection });

    assert.equal(followUp.resolution, 'resolved');
    assert.equal(followUp.continuation.kind, 'verified_outcome');
    assert.equal(followUp.continuation.proposalId, 'proposal:verdict-journey');
    assert.equal(followUp.continuation.taskId, 'task:item:verdict-journey');
    assert.equal(followUp.continuation.leaseId, 'action-lease:verdict-journey');
    assert.ok(followUp.continuation.evidenceRefs.includes(`main-commit:${'a'.repeat(40)}`));
    assert.ok(followUp.continuation.evidenceRefs.includes('loaded:verdict-journey'));
    assert.ok(followUp.continuation.evidenceRefs.includes('freshness:verdict-journey'));
  });

  it('projects only an effective fresh F266 outcome as resolved', async () => {
    const effective = await harness([
      { findingKey: 'effective', verdictId: 'verdict-effective', outcome: 'effective_keep' },
    ]);
    const insufficient = await harness([
      { findingKey: 'insufficient', verdictId: 'verdict-insufficient', outcome: 'insufficient_observe' },
    ]);

    const resolved = await effective.resolveFollowUp({ projection });
    const open = await insufficient.resolveFollowUp({ projection });

    assert.equal(resolved.resolution, 'resolved');
    assert.equal(resolved.resolvedAt, '2026-09-07T00:00:00.000Z');
    assert.equal(open.resolution, 'open');
    assert.equal(open.continuation.kind, 'observe');
  });

  it('does not reuse a prior-cycle outcome after F266 opens a fresh action cycle', async () => {
    const state = await harnessState([{ findingKey: 'reopened', verdictId: 'verdict-reopened', journey: true }]);
    const [caseId] = state.events.keys();
    state.events.get(caseId).push({
      type: 'case_ready_for_proposal',
      caseId,
      verdictId: 'verdict-reopened',
      caseActionRef: 'case-action:fresh-cycle',
      findingArtifactRef: 'docs/harness-feedback/bundles/verdict-reopened/finding.json',
      supersedesProposalId: 'proposal:verdict-reopened',
      occurredAt: '2026-09-08T00:00:00.000Z',
    });

    const action = await state.resolver.resolve({ projection });
    const followUp = await state.resolver.resolveFollowUp({ projection });

    assert.equal(action.kind, 'approval_required');
    assert.equal(action.caseActionRef, 'case-action:fresh-cycle');
    assert.equal(followUp.resolution, 'open');
    assert.equal(followUp.continuation.kind, 'approval_required');
    assert.equal(followUp.continuation.caseActionRef, 'case-action:fresh-cycle');
  });
});
