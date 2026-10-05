import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import {
  type ContentModificationRecord,
  modificationRequestId,
} from '../src/domains/collaborative-content/modification/journal.js';
import { persistModificationSource } from '../src/domains/collaborative-content/modification/request-source.js';
import { admitModificationTask } from '../src/domains/collaborative-content/modification/task-admission.js';
import { EntrustedWorkLifecycleService } from '../src/domains/growing/EntrustedWorkLifecycleService.js';
import './helpers/setup-cat-registry.js';

test('admission uses the confirmed human source and explicit cat; replay returns the same Task and preserves its closure', async () => {
  const messages = new MessageStore(),
    tasks = new TaskStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks);
  const operationId = randomUUID();
  let record: ContentModificationRecord = {
    requestId: modificationRequestId('operator', operationId),
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    progress: {},
    payload: {
      operationId,
      threadId: 'thread-cover',
      targetCatId: 'codex',
      source: {
        kind: 'publication',
        contentRef: 'media-cover',
        ownerRevision: 1,
        ledgerRef: 'ledger-cover',
        expectedLedgerRevision: 1,
      },
      intent: { body: '保留主体，背景换成绿色。' },
    },
  };
  const labels = {
    title: '周五封面',
    targetName: '缅因猫',
    threadTitle: '一起完成封面',
    completionRule: 'published-result-ready' as const,
  };
  const source = await persistModificationSource(messages, record, labels);
  record = {
    ...record,
    progress: {
      sourceMessageId: source.id,
      prepared: { kind: 'media', contentRef: 'media-cover', ownerRevision: 1, ledgerRef: 'ledger-cover' },
    },
  };
  const admitted = await admitModificationTask({ messages, tasks, lifecycle }, record, labels);
  const task = tasks.get(admitted.taskId);
  assert.ok(task?.entrustedWork);
  assert.equal(task.ownerCatId, 'codex');
  assert.equal(task.createdBy, 'user');
  assert.deepEqual(task.entrustedWork.admission.sourceRefs, [`message:${source.id}`]);
  assert.equal(task.entrustedWork.intendedOutcome, record.payload.intent.body);
  assert.equal(task.entrustedWork.closure.expectedSignal, `${record.requestId}#result-ready`);
  assert.deepEqual(task.entrustedWork.time, {});
  assert.deepEqual(await admitModificationTask({ messages, tasks, lifecycle }, record, labels), admitted);
  const continuing = {
    ...record,
    payload: {
      ...record.payload,
      taskContext: {
        taskId: task.id,
        expectedTaskRevision: 1,
        reviewId: 'review-cover',
        expectedReviewRevision: 1,
        round: 1,
      },
    },
  };
  const before = structuredClone(task);
  assert.deepEqual(await admitModificationTask({ messages, tasks, lifecycle }, continuing, labels), admitted);
  assert.deepEqual(tasks.get(task.id), before, 'existing Task intent and closure are not rewritten');
  await assert.rejects(
    admitModificationTask(
      { messages, tasks, lifecycle },
      { ...continuing, payload: { ...continuing.payload, targetCatId: 'opus' } },
      labels,
    ),
    /task_changed/,
  );
  source.recall = { recalledAt: Date.now(), recalledBy: 'operator' };
  await assert.rejects(
    admitModificationTask({ messages, tasks, lifecycle }, record, labels),
    /current user-authored Message/,
  );
});
