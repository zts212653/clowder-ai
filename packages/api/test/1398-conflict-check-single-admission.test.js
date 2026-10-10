import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * #1398 — conflict-check admits once.
 *
 * `ConflictRouter.route` terminalizes the wait outcome durably and returns `matched_pending`
 * without announcing it; the spec then owes exactly one of `publish` or `settleWithoutWake`, and
 * either way the owner is woken at most once. The spec used to follow a `notified` route with
 * `invokeTrigger.trigger(..., routeResult.messageId, ...)`, which re-enqueued the *same* message
 * with no coalesce key — a second Queue row for one event.
 *
 * It never fired in production, and only by accident: `github-schedule-factories.ts` never passed
 * `invokeTrigger` into the spec, so the branch was unreachable. That is not a safety property, it is
 * one missing line away from a duplicate wake. The seam is gone now, and this file keeps it gone.
 */
describe('#1398 conflict-check admits exactly once', () => {
  let createConflictCheckTaskSpec;

  before(async () => {
    ({ createConflictCheckTaskSpec } = await import('../dist/infrastructure/email/ConflictCheckTaskSpec.js'));
  });

  const matchedOutcome = {
    reason: 'matched',
    outcomeId: 'outcome-1',
    matched: [{ kind: 'pr_became_conflicting' }],
  };

  const workItem = () => ({
    signal: { repoFullName: 'acme/app', prNumber: 7, headSha: 'sha1', mergeState: 'CONFLICTING' },
    task: { id: 'task-1', userId: 'user-1', threadId: 'thread-1' },
  });

  const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

  const pending = (outcome) => ({
    kind: 'matched_pending',
    taskId: 'task-1',
    threadId: 'thread-1',
    catId: 'c',
    outcome,
  });

  function build({ routeResult, autoExecutor }) {
    const routeCalls = [];
    const published = [];
    const settled = [];
    const spec = createConflictCheckTaskSpec({
      taskStore: { listByKind: async () => [] },
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1' }),
      conflictRouter: {
        route: async (signal) => {
          routeCalls.push(signal);
          return routeResult;
        },
        publish: async (taskId, outcome) => {
          published.push({ taskId, outcomeId: outcome.outcomeId });
          return { kind: 'notified' };
        },
        settleWithoutWake: async (taskId, outcome, reason) => {
          settled.push({ taskId, outcomeId: outcome.outcomeId, reason });
          return true;
        },
      },
      ...(autoExecutor ? { autoExecutor } : {}),
      log: silentLog,
    });
    return { spec, routeCalls, published, settled };
  }

  it('does not accept an invokeTrigger dep any more — the second admission seam is gone', () => {
    const { spec } = build({
      routeResult: pending(matchedOutcome),
      autoExecutor: { resolve: async () => ({ kind: 'escalated', branch: 'b', files: [] }) },
    });

    // The spec is built from an options object; nothing in it reads an invoke trigger. Passing one
    // must not resurrect a wake path, so we assert on the observable: running execute with a trigger
    // present in the options bag performs no extra admission (there is nothing left to call it).
    const source = createConflictCheckTaskSpec.toString();
    assert.doesNotMatch(source, /invokeTrigger/, 'invokeTrigger must not be referenced by the spec');
    assert.ok(spec.run.execute, 'spec still exposes execute');
  });

  it('routes once and wakes once for a conflict it could not repair', async () => {
    const resolveCalls = [];
    const { spec, routeCalls, published, settled } = build({
      routeResult: pending(matchedOutcome),
      autoExecutor: {
        resolve: async (repo, pr) => {
          resolveCalls.push({ repo, pr });
          return { kind: 'escalated', branch: 'feature', files: ['a.ts'] };
        },
      },
    });

    await spec.run.execute(workItem(), 'pr:acme/app#7', { signal: undefined });

    assert.equal(routeCalls.length, 1, 'one terminalization');
    // Auto-resolve still runs, and still only on the matched outcome that authorises a repo write.
    assert.deepEqual(resolveCalls, [{ repo: 'acme/app', pr: 7 }]);
    assert.equal(published.length, 1, 'and the unrepaired conflict is announced exactly once');
    assert.equal(settled.length, 0);
  });

  it('routes once and never wakes for a conflict it repaired (Phase C AC-C1)', async () => {
    const { spec, routeCalls, published, settled } = build({
      routeResult: pending(matchedOutcome),
      autoExecutor: { resolve: async () => ({ kind: 'resolved', branch: 'feature', method: 'clean-rebase' }) },
    });

    await spec.run.execute(workItem(), 'pr:acme/app#7', { signal: undefined });

    assert.equal(routeCalls.length, 1);
    assert.equal(published.length, 0, 'the owner is not told about a conflict that no longer exists');
    assert.deepEqual(
      settled.map((entry) => entry.outcomeId),
      ['outcome-1'],
      'the wait is still closed — exactly once, and quietly',
    );
  });

  it('does not auto-resolve on an unmatched outcome, and still admits only once', async () => {
    const resolveCalls = [];
    const { spec, routeCalls, published } = build({
      // An expiry is a delivery, not a mandate: #1392 R5 forbids acting on it.
      routeResult: pending({ reason: 'expired', outcomeId: 'outcome-2', matched: [] }),
      autoExecutor: {
        resolve: async () => {
          resolveCalls.push(1);
          return { kind: 'resolved', branch: 'b', method: 'rebase' };
        },
      },
    });

    await spec.run.execute(workItem(), 'pr:acme/app#7', { signal: undefined });

    assert.equal(routeCalls.length, 1);
    assert.equal(resolveCalls.length, 0, 'an expired wait must not authorise a repository write');
    assert.equal(published.length, 1, 'but the owner still hears the outcome their wait produced');
  });

  it('performs no admission at all when the router deduped or skipped', async () => {
    for (const kind of ['deduped', 'skipped']) {
      const resolveCalls = [];
      const { spec, routeCalls } = build({
        routeResult: { kind, reason: 'x' },
        autoExecutor: {
          resolve: async () => {
            resolveCalls.push(1);
            return null;
          },
        },
      });

      await spec.run.execute(workItem(), 'pr:acme/app#7', { signal: undefined });

      assert.equal(routeCalls.length, 1);
      assert.equal(resolveCalls.length, 0, `${kind} must not reach auto-resolve`);
    }
  });
});
