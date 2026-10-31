import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { deriveGrowingSourceMessageRevision } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { projectMessageImportOperation } from '../src/domains/collaborative-content/workspace-review/project-message/import.js';
import { importStoredProjectMessage } from '../src/routes/messages-project-review.js';
import { projectReviewHttpFixture } from './helpers/video-project-review-http.js';

test('real stored Human message reaches the canonical ledger, stays frozen at its input and replays without duplicate notifications', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const message = f.append();
  await f.deliver(message);
  const first = await f.app.inject(f.url);
  assert.equal(first.statusCode, 200);
  const view = first.json();
  assert.equal(view.review.annotations.length, 1);
  assert.equal(view.review.annotations[0].body, message.content);
  assert.deepEqual(view.review.annotations[0].author, f.principal.actor);
  assert.equal(view.review.source.ownerRevision, 1, 'GET does not refresh the ledger to registration HEAD');
  assert.equal(view.currentSource.ownerRevision, 2);
  const revision = view.review.revision;
  await f.deliver(message);
  const replay = await f.app.inject(f.url);
  assert.equal(replay.json().review.annotations.length, 1);
  assert.equal(replay.json().review.revision, revision);
  assert.equal((await f.messages.getByThreadAfter(f.thread.id)).length, 1, 'no second chat send');
  assert.equal(f.notifications.length, 1, 'an already retained import emits no duplicate change notification');
  assert.equal(f.failures.length, 0);
});

test('failed ledger write preserves the sent Human source and exact synchronize recovers after SQLite restart', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const message = f.append();
  const mutate = f.store.ledgers.mutate.bind(f.store.ledgers);
  f.store.ledgers.mutate = (input, transition) => {
    if (input.kind === 'import:project-message')
      throw new Error('Injected SQLite outage after actual message persistence');
    return mutate(input, transition);
  };
  await f.deliver(message);
  assert.equal(f.failures.length, 1);
  assert.equal(f.messages.getById(message.id)?.content, message.content);
  assert.equal(f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations.length, 0);
  await f.restart();
  const recovered = await f.app.inject({
    method: 'POST',
    url: `${f.url}/synchronize`,
    payload: { threadId: f.thread.id },
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().imported, 1);
  const view = await f.app.inject(f.url);
  assert.equal(view.json().review.annotations[0].projectMessage.source.messageId, message.id);
  const operationId = projectMessageImportOperation({
    messageId: message.id,
    messageRevision: deriveGrowingSourceMessageRevision(message),
    attachmentId: 'selected-screening',
    selectionId: 'selected-range',
  });
  const receipt = await f.app.inject(`${f.url}/operations/${operationId}`);
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.json().receipt.operationId, operationId);
  const repeated = await f.app.inject({
    method: 'POST',
    url: `${f.url}/synchronize`,
    payload: { threadId: f.thread.id },
  });
  assert.equal(repeated.json().scanned, 0);
  assert.equal((await f.messages.getByThreadAfter(f.thread.id)).length, 1);
});

test('concurrent append and Chat writer delivery share one actual operation and one change notification', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const message = f.append();
  await Promise.all([f.deliver(message), f.deliver(message)]);
  assert.equal(f.failures.length, 0);
  const view = (await f.app.inject(f.url)).json();
  assert.equal(view.review.annotations.length, 1);
  assert.equal(view.review.revision, 2);
  assert.equal(f.notifications.length, 1);
});

test('concurrent browser synchronization acknowledges the same successfully imported page without duplicate opinions', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const message = f.append();
  await f.deliver(message);
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.app.inject({
        method: 'POST',
        url: `${f.url}/synchronize`,
        payload: { threadId: f.thread.id },
      }),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 200, 200],
  );
  assert.equal((await f.app.inject(f.url)).json().review.annotations.length, 1);
  assert.equal(f.notifications.length, 1);
  await f.restart();
  const recovered = await f.app.inject({
    method: 'POST',
    url: `${f.url}/synchronize`,
    payload: { threadId: f.thread.id },
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().scanned, 0);
});

test('HTTP synchronization enforces 100-row durable pages and does not skip a failed page', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  for (let i = 0; i < 99; i++)
    f.messages.append({
      userId: f.principal.userId,
      catId: null,
      threadId: f.thread.id,
      timestamp: Date.now(),
      content: `unrelated-${i}`,
      mentions: [],
    });
  const first = f.append(),
    second = f.append();
  const page1 = await f.app.inject({ method: 'POST', url: `${f.url}/synchronize`, payload: { threadId: f.thread.id } });
  assert.equal(page1.statusCode, 200);
  assert.equal(page1.json().scanned, 100);
  assert.equal(page1.json().imported, 1);
  assert.equal(page1.json().hasMore, true);
  const cursor = page1.json().cursor;
  const mutate = f.store.ledgers.mutate.bind(f.store.ledgers);
  f.store.ledgers.mutate = (input, transition) => {
    if (input.kind === 'import:project-message') throw new Error('Injected pending second page');
    return mutate(input, transition);
  };
  const failed = await f.app.inject({
    method: 'POST',
    url: `${f.url}/synchronize`,
    payload: { threadId: f.thread.id },
  });
  assert.equal(failed.statusCode, 500);
  assert.equal(
    f.store.ledgers.projectMessageImports.get(f.principal.userId, f.request.contentRef, f.thread.id),
    cursor,
  );
  await f.restart();
  const page2 = await f.app.inject({ method: 'POST', url: `${f.url}/synchronize`, payload: { threadId: f.thread.id } });
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.json().scanned, 1);
  assert.equal(page2.json().imported, 1);
  assert.equal(page2.json().hasMore, false);
  const sources = (await f.app.inject(f.url))
    .json()
    .review.annotations.map(
      (annotation: { projectMessage: { source: { messageId: string } } }) => annotation.projectMessage.source.messageId,
    );
  assert.deepEqual(sources, [first.id, second.id]);
  const injectedLimit = await f.app.inject({
    method: 'POST',
    url: `${f.url}/synchronize`,
    payload: { threadId: f.thread.id, limit: 999999 },
  });
  assert.equal(injectedLimit.statusCode, 400, 'client cannot replace the server paging bound');
});

test('direct Human review HTTP rejects header spoofing, agent/callback identity and nonlocal/proxied peers', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  f.setSession(null);
  const requests = [
    { method: 'GET' as const, url: f.url },
    { method: 'POST' as const, url: `${f.url}/synchronize`, payload: { threadId: f.thread.id } },
    { method: 'POST' as const, url: `${f.url}/actions`, payload: {} },
    { method: 'GET' as const, url: `${f.url}/operations/unknown` },
  ];
  for (const request of requests)
    assert.equal(
      (await f.app.inject({ ...request, headers: { 'x-cat-cafe-user': f.principal.userId } })).statusCode,
      401,
    );
  f.setSession(f.principal.userId);
  for (const headers of [
    { 'x-invocation-id': 'spoof' },
    { 'x-callback-token': 'spoof' },
    { 'x-agent-key-secret': 'spoof' },
    { 'x-forwarded-for': '127.0.0.1' },
  ])
    for (const request of requests) assert.equal((await f.app.inject({ ...request, headers })).statusCode, 401);
  assert.equal((await f.app.inject({ url: f.url, remoteAddress: '192.168.10.2' })).statusCode, 401);
  assert.equal(f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef), null);
});

test('a project-authorized whisper outsider cannot see opinion, location, source IDs or operation receipt', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const message = f.append({
    visibility: 'whisper',
    whisperTo: [createCatId('astra')],
    mentions: [createCatId('astra')],
  });
  await f.deliver(message);
  const human = (await f.app.inject(f.url)).json();
  assert.equal(human.review.annotations.length, 1);
  const annotation = human.review.annotations[0];
  const outsider = await f.importer.reviews.read({ principal: f.cat('sol'), reviewId: human.review.reviewId });
  assert.equal(outsider.review.annotations.length, 0);
  assert.equal(outsider.annotationResolutions.length, 0);
  assert.equal(JSON.stringify(outsider).includes(message.id), false);
  assert.equal(
    await f.importer.reviews.operationReceipt({
      principal: f.cat('sol'),
      reviewId: human.review.reviewId,
      operationId: annotation.operationId,
    }),
    null,
  );
  const recipient = await f.importer.reviews.read({ principal: f.cat('astra'), reviewId: human.review.reviewId });
  assert.equal(recipient.review.annotations.length, 1);
  await f.messages.revealWhispers(f.thread.id, f.principal.userId);
  assert.equal(
    (await f.importer.reviews.read({ principal: f.cat('sol'), reviewId: human.review.reviewId })).review.annotations
      .length,
    0,
  );
  await assert.rejects(
    f.importer.reviews.act({
      principal: f.cat('sol'),
      reviewId: human.review.reviewId,
      expectedRevision: human.review.revision,
      operationId: 'outside-reopen',
      action: { kind: 'reopened', annotationId: annotation.id, reason: 'Should not see this' },
    }),
    { code: 'access_denied' },
  );
  f.setSession('another-owner');
  const foreignHuman = await f.app.inject(f.url);
  assert.equal(foreignHuman.statusCode, 403);
  assert.equal(foreignHuman.body.includes(message.content), false);
});

test('reopen CAS receipt recovers an uncertain response, replays once and rejects operation reuse', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const message = f.append();
  await f.deliver(message);
  const view = (await f.app.inject(f.url)).json();
  const annotation = view.review.annotations[0];
  const addressed = await f.importer.reviews.act({
    principal: f.principal,
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    operationId: 'explain-original',
    action: {
      kind: 'addressed',
      annotationId: annotation.id,
      result: { kind: 'not-changed', reason: 'Original composition is intentional' },
    },
  });
  const payload = {
    expectedRevision: addressed.review.revision,
    operationId: 'human-reopen',
    action: { kind: 'reopened', annotationId: annotation.id, reason: 'I still disagree' },
  };
  const mutate = f.store.ledgers.mutate.bind(f.store.ledgers);
  f.store.ledgers.mutate = (input, transition) => {
    const result = mutate(input, transition);
    if (input.operationId === 'human-reopen') throw new Error('Injected response loss after actual SQLite commit');
    return result;
  };
  const uncertain = await f.app.inject({ method: 'POST', url: `${f.url}/actions`, payload });
  assert.equal(uncertain.statusCode, 500);
  await f.restart();
  const retained = await f.app.inject(`${f.url}/operations/human-reopen`);
  assert.equal(retained.statusCode, 200);
  assert.equal(retained.json().receipt.revision, addressed.review.revision + 1);
  assert.deepEqual(retained.json().receipt.actor, f.principal.actor);
  const replay = await f.app.inject({ method: 'POST', url: `${f.url}/actions`, payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().receipt.receiptRef, retained.json().receipt.receiptRef);
  assert.equal(
    replay.json().review.annotations[0].projectHistory.filter((event: { kind: string }) => event.kind === 'reopened')
      .length,
    1,
  );
  const conflict = await f.app.inject({
    method: 'POST',
    url: `${f.url}/actions`,
    payload: { ...payload, operationId: 'stale-other-command' },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'revision_conflict');
  const reused = await f.app.inject({
    method: 'POST',
    url: `${f.url}/actions`,
    payload: { ...payload, action: { ...payload.action, reason: 'Different meaning' } },
  });
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.json().error.code, 'operation_reused');
  for (const extra of [{ actor: { kind: 'cat', actorId: 'sol' } }, { expectedOwnerRevision: 2 }]) {
    const rejected = await f.app.inject({ method: 'POST', url: `${f.url}/actions`, payload: { ...payload, ...extra } });
    assert.equal(rejected.statusCode, 400);
  }
  const wrongKind = await f.app.inject({
    method: 'POST',
    url: `${f.url}/actions`,
    payload: { ...payload, action: { kind: 'resolved', annotationId: annotation.id } },
  });
  assert.equal(wrongKind.statusCode, 400);
  assert.deepEqual((await f.app.inject(`${f.url}/operations/not-committed`)).json(), { receipt: null });
});

test('message helper retains absent/failed secondary consumers without another source write', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const message = f.append();
  const errors: unknown[] = [];
  await importStoredProjectMessage(message, undefined, (error) => errors.push(error));
  await importStoredProjectMessage(
    message,
    async () => {
      throw new Error('Secondary consumer unavailable');
    },
    (error) => errors.push(error),
  );
  assert.equal(errors.length, 1);
  assert.equal(f.messages.getById(message.id)?.content, message.content);
  assert.equal(f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef), null);
});

test('revoked current source thread access prevents deferred import and hides retained source context without deleting history', async (t) => {
  const f = await projectReviewHttpFixture();
  t.after(f.cleanup);
  const original = f.append();
  await f.deliver(original);
  const retained = f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef);
  assert.ok(retained);
  const pending = f.append({ content: 'A later source awaiting import' });
  assert.equal(f.threads.softDelete(f.thread.id), true);
  await f.deliver(pending);
  assert.equal(f.failures.length, 1);
  assert.equal(f.messages.getById(pending.id)?.content, pending.content);
  const response = await f.app.inject({
    method: 'POST',
    url: `${f.url}/synchronize`,
    payload: { threadId: f.thread.id },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(
    f.store.ledgers.projectMessageImports.get(f.principal.userId, f.request.contentRef, f.thread.id),
    undefined,
  );
  const filtered = await f.app.inject(f.url);
  assert.equal(filtered.statusCode, 200);
  assert.equal(filtered.json().review.annotations.length, 0);
  assert.equal(filtered.body.includes(original.content), false);
  assert.equal(filtered.body.includes(original.id), false);
  assert.deepEqual(f.store.ledgers.get(retained.reviewId), retained);
});
