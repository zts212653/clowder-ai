import assert from 'node:assert/strict';
import { test } from 'node:test';
import { developmentReturnActionV1Schema } from '@cat-cafe/shared';
import { deriveGrowingSourceMessageRevision } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';
import { legacyDevelopmentReturnV1Schema } from '../helpers/development-return-v1-contract.js';
import { reviewedExecution } from '../helpers/reviewed-development-return-fixture.js';

test('a peer typed fact without a bound and recorded owner request cannot supply return lineage', async (t) => {
  const f = await fixture(t);
  const execution = await reviewedExecution(f, true);
  await assert.rejects(f.service.register(f.actor, execution.input, 'strict'), /Original human source/);
});

test('a reviewed return keeps the previous strict v1 persisted shape readable', async (t) => {
  const f = await fixture(t);
  const execution = await reviewedExecution(f);
  const state = await f.service.register(f.actor, execution.input, 'strict');
  const row = f.db
    .prepare('SELECT reviewed_development_return_json AS development_return_json FROM dynamic_task_defs WHERE id = ?')
    .get(state.registrationId) as { development_return_json: string };
  assert.doesNotThrow(() => legacyDevelopmentReturnV1Schema.parse(JSON.parse(row.development_return_json)));
});

test('human-approved execution triggered by an exact Task review can return to its original authorized Task', async (t) => {
  const f = await fixture(t);
  const execution = await reviewedExecution(f);
  const state = await f.service.register(f.actor, execution.input, 'strict');
  assert.equal(state.taskRef, `task:work:${f.input.taskId}`);
  assert.equal(state.sourceActionRef, `message:${execution.review.id}`, 'original proposal trigger stays intact');
  assert.notEqual(state.sourceMessageRevision, deriveGrowingSourceMessageRevision(execution.review));
  assert.equal(state.proposalId, execution.proposal.proposalId);
  assert.equal(state.executionThreadId, execution.child.id);
  assert.equal(f.wakes.length, 0, 'registration alone neither runs nor completes the Task');
  assert.equal(f.tasks.get(f.input.taskId)?.entrustedWork?.closure.state, 'open');
  const report = f.messages.append({
    userId: f.actor.userId,
    threadId: execution.child.id,
    catId: f.actor.catId,
    content: 'Implementation returned for parent judgment',
    mentions: [],
    timestamp: f.service.now() + 1,
  });
  const outcome = { sourceMessageId: report.id, outcome: 'completed' as const, evidenceRefs: ['artifact:result'] };
  await f.service.report({ ...f.actor, threadId: execution.child.id }, state.registrationId, outcome);
  await f.service.report({ ...f.actor, threadId: execution.child.id }, state.registrationId, outcome);
  assert.equal(f.wakes.length, 1, 'repeated report causes only one original-owner wake');
  assert.equal(f.tasks.get(f.input.taskId)?.entrustedWork?.closure.state, 'open', 'report is not product acceptance');
});

test('an approved review of another Task cannot link an execution to this Task', async (t) => {
  const f = await fixture(t);
  const execution = await reviewedExecution(f);
  const fact = execution.review.extra?.localReviewVerdict;
  assert.ok(fact);
  fact.reviewSubjectRef = 'task:work:another-task';
  await assert.rejects(f.service.register(f.actor, execution.input, 'strict'));
  assert.equal(f.wakes.length, 0);
});

test('review linkage rejects unsupported authority, actors, subjects and ordering', async (t) => {
  const cases = [
    'wrong-human',
    'pr-subject',
    'self-review',
    'not-approved',
    'foreign-user',
    'foreign-thread',
    'forwarded-review',
    'late-review',
    'nonhuman-approval',
    'missing-approval',
    'human-not-admitted',
  ];
  for (const scenario of cases)
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const x = await reviewedExecution(f);
      const fact = x.review.extra?.localReviewVerdict;
      assert.ok(fact);
      const proposal = f.proposals.get(x.proposal.proposalId);
      assert.ok(proposal);
      switch (scenario) {
        case 'wrong-human':
          fact.acceptedSourceRef = `${f.actor.threadId}#another-source`;
          break;
        case 'pr-subject':
          fact.reviewSubjectRef = 'pr:owner/repo#123';
          break;
        case 'self-review':
          x.review.catId = f.actor.catId;
          break;
        case 'not-approved':
          fact.verdict = 'changes_requested';
          break;
        case 'foreign-user':
          x.review.userId = 'other-user';
          break;
        case 'foreign-thread':
          x.review.threadId = 'other-thread';
          break;
        case 'forwarded-review':
          x.review.source = { connector: 'test', label: 'forwarded' };
          break;
        case 'late-review':
          x.review.timestamp = (proposal.approvedAt ?? 0) + 1;
          break;
        case 'nonhuman-approval':
        case 'missing-approval': {
          const get = f.proposals.get.bind(f.proposals);
          f.proposals.get = (id) => {
            const current = get(id);
            return current && { ...current, approvedBy: scenario === 'missing-approval' ? undefined : 'opus' };
          };
          break;
        }
        case 'human-not-admitted': {
          const other = f.messages.append({
            userId: f.actor.userId,
            threadId: f.actor.threadId,
            catId: null,
            content: 'Unrelated work',
            mentions: [],
            timestamp: x.review.timestamp,
          });
          fact.acceptedSourceRef = `${f.actor.threadId}#${other.id}`;
          fact.acceptedRevision = other.id;
          break;
        }
      }
      await assert.rejects(f.service.register(f.actor, x.input, 'strict'), /human source/);
      assert.equal(f.wakes.length, 0);
    });
});

test('delivery rechecks both sources, typed review metadata and human approval', async (t) => {
  for (const scenario of [
    'human-deleted',
    'human-edited',
    'review-deleted',
    'review-retargeted',
    'review-head-changed',
    'admission-removed',
    'approval-changed',
    'child-deleted',
    'task-closed',
    'legacy-cat-registration',
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const x = await reviewedExecution(f);
      const state = await f.service.register(f.actor, x.input, 'strict');
      const human = f.messages.getById(f.input.sourceActionRef.slice('message:'.length));
      const task = f.tasks.get(f.input.taskId);
      const fact = x.review.extra?.localReviewVerdict;
      assert.ok(human && task?.entrustedWork && fact);
      switch (scenario) {
        case 'human-deleted':
          f.messages.softDelete(human.id, f.actor.userId);
          break;
        case 'human-edited':
          human.content = 'Changed original terms';
          break;
        case 'review-deleted':
          f.messages.softDelete(x.review.id, f.actor.userId);
          break;
        case 'review-retargeted':
          fact.reviewSubjectRef = 'task:work:other';
          break;
        case 'review-head-changed':
          fact.reviewedHeadSha = 'c'.repeat(40);
          break;
        case 'admission-removed':
          task.entrustedWork.admission.sourceRefs = [];
          break;
        case 'approval-changed': {
          const get = f.proposals.get.bind(f.proposals);
          f.proposals.get = (id) => {
            const value = get(id);
            return value && { ...value, approvedAt: 1 };
          };
          break;
        }
        case 'child-deleted':
          f.threads.get(x.child.id).deletedAt = Date.now();
          break;
        case 'task-closed':
          f.tasks.closeEntrustedWork(task.id, {
            expectedRevision: 1,
            closure: {
              state: 'satisfied',
              condition: 'Done',
              expectedSignal: 'verified',
              evidenceRefs: ['artifact:accepted'],
            },
          });
          break;
        case 'legacy-cat-registration': {
          const legacy = { ...state, sourceMessageRevision: deriveGrowingSourceMessageRevision(x.review) };
          // Seed a legacy disk row: the public CAS correctly forbids changing identity.
          f.db
            .prepare('UPDATE dynamic_task_defs SET reviewed_development_return_json = ? WHERE id = ?')
            .run(JSON.stringify(legacy), state.registrationId);
          break;
        }
      }
      f.tick(20000);
      await f.runner.triggerNow(state.registrationId);
      assert.equal(f.service.read(state.registrationId)?.status, 'retired');
      assert.equal(f.wakes.length, 0);
    });
  }
});

test('review linkage cannot create a second active child return for the same Task', async (t) => {
  const f = await fixture(t);
  const reviewed = await reviewedExecution(f);
  const results = await Promise.allSettled([
    f.service.register(f.actor, f.input, 'strict'),
    f.service.register(f.actor, reviewed.input, 'strict'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.service.readForActor(f.actor).length, 1);
});

test('a prose approval without the typed Task/source relation cannot link an execution', async (t) => {
  const f = await fixture(t);
  const execution = await reviewedExecution(f);
  assert.ok(execution.review.extra?.localReviewVerdict);
  delete execution.review.extra.localReviewVerdict;
  await assert.rejects(f.service.register(f.actor, execution.input, 'strict'));
  assert.equal(f.wakes.length, 0);
});

test('a caller cannot provide its own lineage, and replay cannot silently refresh review evidence', async (t) => {
  const f = await fixture(t);
  const x = await reviewedExecution(f);
  const registered = await f.service.register(f.actor, x.input, 'strict');
  assert.equal(
    developmentReturnActionV1Schema.safeParse({
      ...x.input,
      reviewedTaskLineage: { humanSourceRef: f.input.sourceActionRef },
    }).success,
    false,
  );
  const fact = x.review.extra?.localReviewVerdict;
  assert.ok(fact);
  fact.reviewedHeadSha = 'd'.repeat(40);
  await assert.rejects(f.service.register(f.actor, x.input, 'strict'), /human source/);
  assert.deepEqual(f.service.read(registered.registrationId)?.reviewedTaskLineage, registered.reviewedTaskLineage);
});
