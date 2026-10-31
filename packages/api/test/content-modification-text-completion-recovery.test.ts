import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { isCatConsumableHostMessage } from '../src/domains/cats/services/stores/host-message-policy.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { createArtifactReviewIntegration } from '../src/domains/growing/artifact-review-composition.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackTaskRoutes } from '../src/routes/callback-task-routes.js';
import { registerEntrustedWorkReadRoutes } from '../src/routes/entrusted-work-read-routes.js';
import {
  appliedText,
  completionMessages,
  prepareTextCompletion,
} from './helpers/content-modification-text-completion-fixture.js';

test('natural recovery repairs a crash after real applied effect, without another Human or file effect', async (t) => {
  const f = await prepareTextCompletion(t);
  const record = f.integration.textCompletions.recordApplied.bind(f.integration.textCompletions);
  const interrupted = new Error('simulated crash before completion registration');
  f.integration.textCompletions.recordApplied = async () => {
    throw interrupted;
  };
  const accepted = await f.accept();
  assert.deepEqual(f.errors, [interrupted]);
  assert.equal(completionMessages(f).length, 0);
  const humansBeforeRecovery = f.messages
    .getByThreadIncludingQueued(f.thread.id)
    .filter((m) => m.userId === 'operator' && m.catId === null && !isCatConsumableHostMessage(m))
    .map((m) => m.id);
  f.integration.textCompletions.recordApplied = record;
  await f.integration.receipts.recover();
  await f.dispatcher.drain();
  const completion = completionMessages(f);
  assert.equal(completion.length, 1);
  await f.dispatch.waitForAwakening(completion[0]!.id);
  await f.integration.receipts.recover();
  await f.dispatcher.drain();
  assert.equal(completionMessages(f).length, 1);
  assert.equal(f.starts.length, f.startsBeforeAcceptance + 1);
  assert.deepEqual(
    f.messages
      .getByThreadIncludingQueued(f.thread.id)
      .filter((m) => m.userId === 'operator' && m.catId === null && !isCatConsumableHostMessage(m))
      .map((m) => m.id),
    humansBeforeRecovery,
  );
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The new text.');
  const current = await f.integration.writer.find(accepted.receipt.receiptRef, { userId: 'operator' });
  assert.equal(current?.appliedSequence, accepted.receipt.appliedSequence);
  assert.equal(current?.writtenRevision, accepted.receipt.writtenRevision);
});

test('a crash between real Queue append and outbox queued mark reuses the same owner carrier and invocation', async (t) => {
  const f = await prepareTextCompletion(t);
  const queued = f.store.returns.queued.bind(f.store.returns);
  f.store.returns.queued = () => {
    throw new Error('simulated queued-mark crash');
  };
  const accepted = await f.accept();
  const completion = completionMessages(f);
  assert.equal(completion.length, 1);
  assert.equal(f.store.returns.pending().filter((i) => i.kind === 'text_writeback_completion').length, 1);
  await f.dispatch.waitForAwakening(completion[0]!.id);
  f.store.returns.queued = queued;
  await f.dispatcher.drain();
  assert.equal(completionMessages(f).length, 1);
  assert.equal(f.starts.length, f.startsBeforeAcceptance + 1);
  assert.equal(f.store.returns.get(String(completion[0]!.source!.meta!.returnRef))?.state, 'queued');
  assert.equal(
    (await f.integration.writer.find(accepted.receipt.receiptRef, { userId: 'operator' }))?.appliedSequence,
    accepted.receipt.appliedSequence,
  );
});

test('a fresh owner composition repairs an applied effect after its original SQLite owner has closed', async (t) => {
  const f = await prepareTextCompletion(t);
  f.integration.textCompletions.recordApplied = async () => {
    throw new Error('crash before registration');
  };
  const accepted = await f.accept();
  assert.equal(completionMessages(f).length, 0);
  f.store.close();
  const artifacts = createArtifactReviewIntegration({
    dataDir: f.root,
    uploadDir: f.root,
    owner: f.owner,
    publications: f.publications,
    workspace: f.workspaceSource,
    tasks: f.tasks,
    threads: f.threads,
    messages: f.messages,
    delivery: f.dispatch.delivery,
    emit: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const restored = createContentModificationIntegration({
    dataDir: f.root,
    source: f.workspaceSource,
    files: f.files,
    artifacts,
    tasks: f.tasks,
    messages: f.messages,
    turnExecutions: f.dispatch.turns,
    queue: f.queue,
    delivery: f.dispatch.delivery,
    changed: () => {},
    onError: (error) => {
      throw error;
    },
  });
  try {
    await restored.receipts.recover();
    await artifacts.dispatcher.drain();
    const completion = completionMessages(f);
    assert.equal(completion.length, 1);
    await f.dispatch.waitForAwakening(completion[0]!.id);
    await restored.receipts.recover();
    await artifacts.dispatcher.drain();
    assert.equal(completionMessages(f).length, 1);
    assert.equal(f.starts.length, f.startsBeforeAcceptance + 1);
    assert.equal(artifacts.store.returns.get(String(completion[0]!.source!.meta!.returnRef))?.state, 'queued');
    const actual = await restored.writer.findApplied(accepted.receipt.receiptRef, f.human);
    assert.equal(actual?.appliedSequence, accepted.receipt.appliedSequence);
    assert.equal(actual?.writtenRevision, accepted.receipt.writtenRevision);
    assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The new text.');
  } finally {
    restored.writer.close();
    artifacts.store.close();
  }
});

test('observed Task revision is provenance: the owner rereads, verifies actual receipts, then typed-closes the current revision', async (t) => {
  const f = await appliedText(t, { deferDelivery: true, authenticateDelivery: true });
  const taskId = f.request.record.progress.task!.taskId;
  await f.lifecycle.update({
    taskId,
    expectedRevision: 1,
    progress: {
      summary: 'Verify the adopted result.',
      sourceRef: f.accepted.receipt.receiptRef,
    },
  });
  await f.resumeDelivery();
  const completion = completionMessages(f);
  assert.equal(completion.length, 1);
  assert.equal(completion[0]!.source!.meta!.observedTaskRevision, 1);
  const invocation = await f.dispatch.waitForAwakening(completion[0]!.id);
  const credentials = f.dispatch.credentials.get(invocation);
  assert.ok(credentials, 'the actual completion child has registered callback credentials');
  const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
  const overview = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/read',
    headers,
    payload: { requestId: f.requestId },
  });
  assert.equal(overview.statusCode, 200, overview.body);
  const evidence = JSON.parse(overview.json().json);
  assert.equal(evidence.taskRevision, 2);
  const task = f.tasks.get(taskId)!;
  assert.equal(task.entrustedWork!.closure.state, 'open');
  const verified = evidence.acceptances[0];
  const app = Fastify();
  registerCallbackAuthHook(app, f.registry);
  registerCallbackTaskRoutes(app, {
    taskStore: f.tasks,
    messageStore: f.messages,
    threadStore: f.threads,
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  registerEntrustedWorkReadRoutes(app, { service: f.ownerReads, callbackRegistry: f.registry });
  t.after(() => app.close());
  const current = await app.inject({
    method: 'POST',
    url: '/api/callbacks/read-entrusted-work',
    headers,
    payload: { taskId },
  });
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.json().ownerRead.envelope.revision, 2);
  const command = {
    taskId,
    expectedRevision: evidence.taskRevision,
    closure: {
      state: 'satisfied',
      condition: task.entrustedWork!.closure.condition,
      expectedSignal: task.entrustedWork!.closure.expectedSignal,
      evidenceRefs: [verified.acceptance.humanReceiptRef, verified.receipt.receiptRef],
    },
  };
  const stale = await app.inject({
    method: 'POST',
    url: '/api/callbacks/close-entrusted-work',
    headers,
    payload: { ...command, expectedRevision: 1 },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/close-entrusted-work',
    headers,
    payload: command,
  });
  assert.equal(response.statusCode, 200, response.body);
  const closed = response.json().task;
  assert.equal(closed.status, 'done');
  assert.equal(closed.entrustedWork!.revision, 3);
  assert.equal(closed.entrustedWork!.closure.state, 'satisfied');
  await f.integration.receipts.recover();
  await f.dispatcher.drain();
  assert.equal(completionMessages(f).length, 1);
});
