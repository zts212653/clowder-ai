import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { modificationMessageRequestId } from '../src/domains/collaborative-content/modification/journal.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerCallbackContentModificationRoutes } from '../src/routes/callback-content-modification-routes.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';
import { workspaceQuote as quote } from './helpers/content-modification-first-file-fixture.js';

test('a real human message has one authenticated cat takeover with version-bound multi-selection and recall fencing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-message-takeover-'));
  await writeFile(join(root, 'guide.md'), '# Guide\nFirst unique paragraph.\nSecond unique paragraph.\n');
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'worktree-a' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const files = new WorkspaceContentReviewService({ source, store: fileStore });
  const errors: unknown[] = [];
  const integration = createContentModificationIntegration({
    dataDir: root,
    source,
    files,
    artifacts: f,
    tasks: f.tasks,
    messages: f.messages,
    changed: () => {},
    onError: (error) => errors.push(error),
  });
  const unopened = await source.describe({
    principal: { userId: f.human.userId },
    locator: { worktreeId: 'worktree-a', path: 'guide.md' },
  });
  assert.equal(
    fileStore.getByContent('operator', unopened.contentRef),
    null,
    'takeover starts without annotation preparation',
  );
  const app = Fastify();
  const registry = new InvocationRegistry();
  const secondCatId = 'f309-second-cat';
  if (!catRegistry.has(secondCatId)) {
    const base = catRegistry.getOrThrow('codex-astra').config;
    catRegistry.register(secondCatId, {
      ...base,
      id: createCatId(secondCatId),
      displayName: 'F309 第二只测试猫',
    });
  }
  const firstCat = await registry.create('operator', 'codex-astra', f.thread.id);
  const secondCat = await registry.create('operator', secondCatId, f.thread.id);
  await registerCallbackContentModificationRoutes(app, {
    text: integration.text,
    receipts: integration.receipts,
    requests: integration.requests,
    sourceDiscussions: integration.sourceDiscussions,
    threads: f.threads,
    registry,
    changed: () => {},
  });
  t.after(async () => {
    await app.close();
    await f.dispatch.close();
    integration.writer.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });

  const version = unopened.revision;
  const sourceMessage = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: ['codex-astra', secondCatId],
    visibility: 'whisper',
    whisperTo: [createCatId('codex-astra'), createCatId(secondCatId)],
    timestamp: Date.now(),
    content: 'Please update both passages in one change.',
    contentBlocks: [
      quote('selection-1', 'Guide', 'Use a precise heading.', version),
      quote('selection-2', 'Second unique paragraph.', undefined, version),
    ],
  });
  const taskCount = f.tasks.listByThread(f.thread.id).length;
  const takeover = (auth: { invocationId: string; callbackToken: string }, operationId = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/take-over',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { sourceMessageId: sourceMessage.id, operationId },
    });
  const readText = source.readText.bind(source);
  let snapshotReads = 0;
  source.readText = async (input) => {
    snapshotReads++;
    return readText(input);
  };
  const [left, right] = await Promise.all([takeover(firstCat), takeover(secondCat)]);
  assert.equal(snapshotReads, 3, 'two takeover snapshots plus one canonical writer binding, never one read per place');
  source.readText = readText;
  assert.equal(left.statusCode, 200, left.body);
  assert.equal(right.statusCode, 200, right.body);
  assert.equal(left.json().record.requestId, right.json().record.requestId);
  const canonical = f.store.requests.get(left.json().record.requestId, 'operator');
  assert.ok(canonical?.progress.task);
  assert.equal(left.json().record.progress.sourceMessageId, sourceMessage.id);
  assert.equal(left.json().record.progress.sourceKind, 'human_message');
  const sourceVisibility = left.json().record.progress.sourceVisibility;
  assert.deepEqual(sourceVisibility, {
    visibility: 'whisper',
    whisperTo: ['codex-astra', secondCatId],
  });
  assert.equal(left.json().record.payload.intent.body, sourceMessage.content);
  assert.deepEqual(
    left.json().record.payload.intent.selections.map((item: { id: string }) => item.id),
    ['selection-1', 'selection-2'],
  );
  assert.deepEqual(
    left.json().record.payload.intent.selection,
    left.json().record.payload.intent.selections[0].selection,
  );
  assert.equal(left.json().record.payload.intent.selections[0].instruction, 'Use a precise heading.');
  assert.equal(left.json().record.payload.source.expectedSourceRevision, version);
  assert.ok(['codex-astra', secondCatId].includes(left.json().record.payload.targetCatId));
  assert.equal(f.tasks.listByThread(f.thread.id).length, taskCount + 1);
  assert.equal(sourceMessage.extra?.contentModificationRequestV1, undefined);
  assert.deepEqual(errors, []);
  const winner = left.json().record.payload.targetCatId as string;
  const catPrincipal = {
    userId: 'operator',
    threadId: f.thread.id,
    actor: { kind: 'cat' as const, actorId: winner },
  };
  const ownerRead = await integration.text.read(left.json().record.requestId, catPrincipal);
  const response = {
    requestId: left.json().record.requestId,
    operationId: randomUUID(),
    expectedTaskRevision: ownerRead.taskRevision,
    expectedProposalRevision: 0,
    baseRevision: ownerRead.source.source.revision,
    edits: [
      {
        selectionId: 'selection-1',
        start: 2,
        end: 7,
        expectedText: 'Guide',
        replacement: 'Precise Guide',
      },
    ],
    response: 'Updated the requested heading.',
  };
  await assert.rejects(
    integration.text.respond({ ...response, edits: [{ ...response.edits[0], selectionId: 'made-up' }] }, catPrincipal),
    /invalid_patch/,
  );
  assert.equal((await integration.text.respond(response, catPrincipal)).proposal.edits[0]?.selectionId, 'selection-1');
  const replay = await takeover(
    left.json().record.payload.targetCatId === 'codex-astra' ? firstCat : secondCat,
    randomUUID(),
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(
    replay.json().record.requestId,
    left.json().record.requestId,
    'source identity wins over retry operation id',
  );
  assert.equal(f.tasks.listByThread(f.thread.id).length, taskCount + 1);

  const followUpSource = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: [winner],
    timestamp: Date.now() + 1,
    content: 'Please refine the same file in the responsibility you already own.',
    contentBlocks: [quote('follow-up-selection', 'First unique paragraph.', undefined, version)],
  });
  const winnerAuth = winner === 'codex-astra' ? firstCat : secondCat;
  const continuation = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': winnerAuth.invocationId, 'x-callback-token': winnerAuth.callbackToken },
    payload: { sourceMessageId: followUpSource.id, operationId: randomUUID() },
  });
  assert.equal(continuation.statusCode, 200, continuation.body);
  assert.equal(
    continuation.json().record.payload.taskContext.taskId,
    canonical.progress.task.taskId,
    'a single matching open responsibility is continued from owner truth',
  );
  assert.equal(f.tasks.listByThread(f.thread.id).length, taskCount + 1, 'continuation does not create another Task');

  const lateRecall = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: [winner],
    timestamp: Date.now() + 2,
    content: 'Recall this while the server is still resolving the selection.',
    contentBlocks: [quote('late-recall-selection', 'Guide', undefined, version)],
  });
  const getById = f.messages.getById.bind(f.messages);
  let lateRecallReads = 0;
  f.messages.getById = (messageId) => {
    const message = getById(messageId);
    if (messageId === lateRecall.id && message && lateRecallReads++ === 1) {
      message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
    }
    return message;
  };
  const lateDenied = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': winnerAuth.invocationId, 'x-callback-token': winnerAuth.callbackToken },
    payload: { sourceMessageId: lateRecall.id, operationId: randomUUID() },
  });
  f.messages.getById = getById;
  assert.equal(lateDenied.statusCode, 404, lateDenied.body);
  assert.equal(
    f.store.requests.get(modificationMessageRequestId('operator', lateRecall.id), 'operator'),
    null,
    'recall before the final authority read leaves no request to resume later',
  );

  const recalled = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: ['codex-astra'],
    timestamp: Date.now() + 3,
    content: 'Please change the heading.',
    contentBlocks: [quote('recalled-selection', 'Guide', undefined, version)],
  });
  recalled.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
  const denied = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': firstCat.invocationId, 'x-callback-token': firstCat.callbackToken },
    payload: { sourceMessageId: recalled.id, operationId: randomUUID() },
  });
  assert.equal(denied.statusCode, 404, denied.body);

  const legacy = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: ['codex-astra'],
    timestamp: Date.now() + 4,
    content: 'Please change the heading.',
    contentBlocks: [quote('legacy-selection', 'Guide', undefined, undefined)],
  });
  const unversioned = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': firstCat.invocationId, 'x-callback-token': firstCat.callbackToken },
    payload: { sourceMessageId: legacy.id, operationId: randomUUID() },
  });
  assert.equal(unversioned.statusCode, 409, unversioned.body);
  assert.equal(unversioned.json().error, 'source_changed');

  const mixedRevision = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: [winner],
    timestamp: Date.now() + 5,
    content: 'Do not combine references from different source revisions.',
    contentBlocks: [
      quote('mixed-current', 'Guide', undefined, version),
      quote('mixed-stale', 'Second unique paragraph.', undefined, `sha256:${'d'.repeat(64)}`),
    ],
  });
  const mixed = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': winnerAuth.invocationId, 'x-callback-token': winnerAuth.callbackToken },
    payload: { sourceMessageId: mixedRevision.id, operationId: randomUUID() },
  });
  assert.equal(mixed.statusCode, 400, mixed.body);
  assert.equal(mixed.json().error, 'invalid_patch');

  const duplicateText = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: [winner],
    timestamp: Date.now() + 6,
    content: 'This rendered quote is ambiguous in the raw source.',
    contentBlocks: [quote('ambiguous-rendered-quote', 'unique', undefined, version)],
  });
  const ambiguousRendered = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': winnerAuth.invocationId, 'x-callback-token': winnerAuth.callbackToken },
    payload: { sourceMessageId: duplicateText.id, operationId: randomUUID() },
  });
  assert.equal(ambiguousRendered.statusCode, 409, ambiguousRendered.body);
  assert.equal(ambiguousRendered.json().error, 'source_changed');
  assert.equal(f.tasks.listByThread(f.thread.id).length, taskCount + 1);

  const independent = await integration.requests.submit(
    {
      operationId: randomUUID(),
      targetCatId: winner,
      threadId: f.thread.id,
      source: left.json().record.payload.source,
      intent: { body: 'Start a separate explicit responsibility for the same file.' },
    },
    f.human,
  );
  assert.ok(independent.record.progress.task);
  assert.notEqual(independent.record.progress.task.taskId, canonical.progress.task.taskId);
  const stableReplay = await takeover(winnerAuth, randomUUID());
  assert.equal(stableReplay.json().record.requestId, left.json().record.requestId);
  const ambiguousSource = f.messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    threadId: f.thread.id,
    mentions: [winner],
    timestamp: Date.now() + 7,
    content: 'Continue whichever responsibility applies.',
    contentBlocks: [quote('ambiguous-selection', 'Second unique paragraph.', undefined, version)],
  });
  const ambiguous = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    headers: { 'x-invocation-id': winnerAuth.invocationId, 'x-callback-token': winnerAuth.callbackToken },
    payload: { sourceMessageId: ambiguousSource.id, operationId: randomUUID() },
  });
  assert.equal(ambiguous.statusCode, 409, ambiguous.body);
  assert.equal(ambiguous.json().error, 'task_changed');
  assert.equal(f.tasks.listByThread(f.thread.id).length, taskCount + 2, 'ambiguity creates no third Task');
});
