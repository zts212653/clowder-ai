import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, it, mock } from 'node:test';
import { PawFeelSourceCaseActionResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/continuation/source-case-action-resolver.js';
import {
  cleanupSourceCaseFixtures,
  harnessState,
  projection,
  sourceSignalRef,
} from './helpers/paw-feel-source-case-fixture.js';

afterEach(cleanupSourceCaseFixtures);

function countedResolver(state, read = (caseId) => structuredClone(state.events.get(caseId) ?? [])) {
  const reads = [];
  const resolver = new PawFeelSourceCaseActionResolver({
    harnessFeedbackRoot: state.root,
    eventLog: {
      async read(caseId) {
        reads.push(caseId);
        return read(caseId);
      },
    },
    sourceVerifier: {
      async verifyIdentity() {
        return {
          sourceSignalRef,
          markerDigest: projection.markerDigest,
          sameDigestOrdinal: 0,
          markerIndex: 0,
        };
      },
    },
  });
  return { resolver, reads };
}

describe('global inbox request-scoped source-case read budget', () => {
  it('does no synchronous artifact IO when creating or consuming a read snapshot', async () => {
    const state = await harnessState([{ findingKey: 'one', verdictId: 'verdict-one' }]);
    const originalRead = fs.readFileSync;
    let syncReads = 0;
    const spy = mock.method(fs, 'readFileSync', (...args) => {
      if (String(args[0]).startsWith(state.root)) syncReads++;
      return originalRead(...args);
    });
    syncBuiltinESMExports();
    try {
      const snapshot = state.resolver.snapshot();
      assert.equal(syncReads, 0, 'a request with no eligible source must not scan artifacts');
      assert.equal((await snapshot.resolve({ projection })).kind, 'approval_required');
      assert.equal(syncReads, 0, 'artifact IO must yield instead of blocking the API event loop');
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('coalesces concurrent canonical and duplicate-follower joins into one case read', async () => {
    const state = await harnessState([{ findingKey: 'shared', verdictId: 'verdict-shared', journey: true }]);
    const { resolver, reads } = countedResolver(state);
    const snapshot = resolver.snapshot();
    const values = await Promise.all(Array.from({ length: 32 }, () => snapshot.resolveFollowUp({ projection })));

    assert.equal(values[0].resolution, 'resolved');
    assert.equal(values[0].continuation.kind, 'verified_outcome');
    for (const value of values) assert.deepEqual(value, values[0]);
    assert.equal(reads.length, 1, 'one case must be read once within one inbox request');
    await snapshot.resolve({ projection });
    assert.equal(reads.length, 1, 'action and follow-up consume the same request snapshot');
  });

  it('shares a case across different findings without sharing its action identity', async () => {
    const state = await harnessState([
      { findingKey: 'same-case', verdictId: 'verdict-first' },
      { findingKey: 'same-case', verdictId: 'verdict-second' },
    ]);
    const [caseId] = state.events.keys();
    state.events.get(caseId).unshift({
      type: 'case_ready_for_proposal',
      caseId,
      verdictId: 'verdict-first',
      caseActionRef: 'case-action:verdict-first',
      findingArtifactRef: 'docs/harness-feedback/bundles/verdict-first/finding.json',
      occurredAt: '2026-09-01T00:00:01.000Z',
    });
    const { resolver, reads } = countedResolver(state);
    const result = await resolver.snapshot().resolve({ projection });

    assert.equal(result.kind, 'analysis_ambiguous');
    assert.deepEqual(result.evidenceRefs, [
      'docs/harness-feedback/bundles/verdict-first/finding.json',
      'docs/harness-feedback/bundles/verdict-second/finding.json',
    ]);
    assert.equal(reads.length, 1, 'different verdicts in one case share only the event read');
  });

  it('starts fresh on the next request and on standalone command resolution', async () => {
    const state = await harnessState([{ findingKey: 'fresh', verdictId: 'verdict-fresh', journey: true }]);
    const { resolver, reads } = countedResolver(state);
    const first = resolver.snapshot();
    assert.equal((await first.resolveFollowUp({ projection })).resolution, 'resolved');
    const [caseId] = state.events.keys();
    state.events.get(caseId).push({
      type: 'case_ready_for_proposal',
      caseId,
      verdictId: 'verdict-fresh',
      caseActionRef: 'case-action:new-cycle',
      findingArtifactRef: 'docs/harness-feedback/bundles/verdict-fresh/finding.json',
      supersedesProposalId: 'proposal:verdict-fresh',
      occurredAt: '2026-09-08T00:00:00.000Z',
    });

    const next = await resolver.snapshot().resolveFollowUp({ projection });
    assert.equal(next.resolution, 'open');
    assert.equal(next.continuation.caseActionRef, 'case-action:new-cycle');
    const direct = await resolver.resolve({ projection });
    assert.equal(direct.caseActionRef, 'case-action:new-cycle');
    assert.equal(reads.length, 3, 'request reuse must not become a process-lifetime authority cache');
  });

  it('shares a failed case read without converting failure to empty state or poisoning the next request', async () => {
    const state = await harnessState([{ findingKey: 'retry', verdictId: 'verdict-retry' }]);
    let unavailable = true;
    const { resolver, reads } = countedResolver(state, (caseId) => {
      if (unavailable) throw new Error('event ledger unavailable');
      return structuredClone(state.events.get(caseId));
    });
    const first = resolver.snapshot();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => first.resolve({ projection })));
    assert.equal(reads.length, 1);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /event ledger unavailable/);
    }
    unavailable = false;
    await assert.rejects(first.resolve({ projection }), /event ledger unavailable/);
    assert.equal((await resolver.snapshot().resolve({ projection })).kind, 'approval_required');
    assert.equal(reads.length, 2);
  });
});
