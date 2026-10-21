import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const { createActionCompletionCandidateSnapshot } = await import(
  '../dist/domains/ball-custody/action-successor-completion-state-machine.js'
);

const candidate = (evidenceRefs) =>
  createActionCompletionCandidateSnapshot({ evidenceRefs, candidateRevision: 1, recordedAt: 100 });

function harness({ marker = null, task = null } = {}) {
  const marks = [];
  const leaseStore = {
    async getSubjectTerminal() {
      return marker;
    },
    async markSubjectTerminal(input) {
      const truth = {
        subjectRef: input.subjectRef,
        state: input.state,
        evidenceRef: input.evidenceRef,
        observedAt: input.now,
      };
      marks.push(truth);
      return truth;
    },
    async clearSubjectTerminal(subjectRef, input) {
      marks.push({ subjectRef, state: 'active', ...input });
    },
  };
  return {
    resolver: new ActionSubjectTruthResolver(leaseStore, {
      async get(id) {
        return task?.id === id ? task : null;
      },
    }),
    marks,
  };
}

describe('ActionSubjectTruthResolver', () => {
  it('does not manufacture terminal or freshness truth for a plugin-owned subject', async () => {
    const { resolver } = harness();
    assert.deepEqual(await resolver.resolve('pr:owner/repo#1', 100), {
      terminal: false,
      source: 'unsupported',
      state: 'unknown',
    });
    assert.throws(
      () =>
        canonicalizeActionTerminalPredicate({
          actionFamily: 'review',
          subjectRef: 'pr:owner/repo#1',
          predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
        }),
      /not allowed/,
    );
    assert.equal(resolver.authorizeCompletion, undefined);
  });

  it('binds task admission and completion truth to the same persisted task', async () => {
    const task = {
      id: 'task-1',
      status: 'todo',
      ownerCatId: 'opus',
      threadId: 'thread-task',
      userId: 'user-1',
      updatedAt: 210,
    };
    const { resolver } = harness({ task });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:task-1',
      predicate: { kind: 'task_done' },
    });

    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'verified',
      evidenceRef: 'task:task-1:active:210',
      freshnessKey: 'task:task-1',
      ownerCatId: 'opus',
      holderThreadId: 'thread-task',
      tenantScope: 'user-1',
    });

    const doneTask = { ...task, status: 'done', updatedAt: 240 };
    const done = harness({ task: doneTask }).resolver;
    const snapshot = candidate(['task:task-1:done:240']);
    assert.deepEqual(await done.resolveFreshness(predicate), {
      status: 'mismatch',
      reason: 'task is already done',
      evidenceRef: 'task:task-1:done:240',
    });
    assert.deepEqual(await done.resolveCompletion(predicate, snapshot), {
      status: 'verified',
      evidenceRef: 'task:task-1:done:240',
      predicateDigest: predicate.digest,
      freshnessKey: predicate.freshnessKey,
      candidateRevision: snapshot.candidateRevision,
      evidenceDigest: snapshot.evidenceDigest,
    });
    assert.equal((await resolver.resolveCompletion(predicate, snapshot)).status, 'mismatch');
  });

  it('treats an already-done task as terminal before a new lease can be admitted', async () => {
    const task = {
      id: 'task-1',
      status: 'done',
      ownerCatId: 'opus',
      threadId: 'thread-task',
      userId: 'user-1',
      updatedAt: 240,
    };
    const { resolver, marks } = harness({ task });

    const result = await resolver.resolve('subject:task:task-1', 250);
    assert.equal(result.terminal, true);
    assert.equal(result.truth.state, 'closed');
    assert.equal(result.truth.evidenceRef, 'task:task-1:done:240');
    assert.equal(marks.length, 1);
  });
});
