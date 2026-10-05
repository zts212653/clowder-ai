import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContentModificationService } from '../src/domains/collaborative-content/modification/service.js';
import { ModificationTextBinding } from '../src/domains/collaborative-content/modification/text/text-binding.js';
import { ContentTextModificationService } from '../src/domains/collaborative-content/modification/text/text-service.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { ArtifactReviewReturnDispatcher } from '../src/domains/growing/ArtifactReviewReturnDispatcher.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { WorkspaceWritebackService } from '../src/domains/workspace/writeback/service.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('ordinary text queues one typed request, returns a named isolated patch, and changes the original only on explicit byte-CAS acceptance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-text-'));
  const original = join(root, 'guide.md'),
    base = '# Guide\nThe old instruction.\n';
  await writeFile(original, base);
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const files = new WorkspaceContentReviewService({ store: fileStore, source });
  const text = new ContentTextModificationService({
    store: f.store,
    access: f.media.access,
    source,
    messages: f.messages,
    executionDirectory: join(root, 'isolated'),
  });
  const writer = new WorkspaceWritebackService({
    source,
    databasePath: join(root, 'writes.sqlite'),
    proofDirectory: join(root, 'proofs'),
  });
  t.after(async () => {
    writer.close();
    await f.dispatch.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const view = await files.prepare({
    principal: f.human,
    locator: { worktreeId: 'work', path: 'guide.md' },
    operationId: 'open-file',
  });
  const dispatcher = new ArtifactReviewReturnDispatcher({
    reviews: f.reviews,
    store: f.store,
    delivery: f.dispatch.delivery,
    text,
    invalidate: () => {},
    emit: () => {},
  });
  const errors: unknown[] = [];
  const requests = new ContentModificationService({
    store: f.store,
    messages: f.messages,
    tasks: f.tasks,
    lifecycle: f.lifecycle,
    content: new ModificationTextBinding({ source, files, store: f.store, access: f.media.access }),
    authorizeTarget: async () => ({ targetName: '小星星', threadTitle: '修改说明' }),
    dispatch: () => dispatcher.drain(),
    onError: (e) => errors.push(e),
  });
  const payload = {
    operationId: randomUUID(),
    threadId: f.thread.id,
    targetCatId: 'codex-astra',
    intent: { body: '把old替换成new，保留标题。' },
    source: {
      kind: 'workspace',
      locator: view.review.source.locator,
      expectedSourceRevision: view.review.source.revision,
      reviewId: view.review.reviewId,
      expectedReviewRevision: view.review.revision,
    },
  };
  const request = await requests.submit(payload, f.human);
  assert.deepEqual(errors, []);
  assert.equal(request.stage, 'queued');
  assert.ok(request.record.progress.review);
  assert.ok(request.record.progress.task);
  const receipt = f.store.returns.get(request.record.progress.review.receiptRef);
  assert.ok(receipt);
  assert.equal(receipt.kind, 'request_text_edit');
  assert.equal('round' in receipt, false);
  assert.equal('contentRef' in receipt, false);
  const again = await requests.submit(payload, f.human);
  assert.equal(again.delivery?.messageId, request.delivery?.messageId);
  const read = await text.read(request.record.requestId, f.cat);
  assert.equal(read.source.text, base);
  assert.ok(read.execution);
  assert.ok(read.execution.sourcePath.startsWith(await realpath(join(root, 'isolated'))));
  assert.equal(await readFile(read.execution.sourcePath, 'utf8'), base);
  const start = base.indexOf('old');
  const command = {
    requestId: request.record.requestId,
    operationId: randomUUID(),
    expectedTaskRevision: read.taskRevision,
    expectedProposalRevision: 0,
    baseRevision: read.source.source.revision,
    edits: [{ start, end: start + 3, expectedText: 'old', replacement: 'new' }],
    response: '已更新措辞，保留标题。',
  };
  await assert.rejects(text.respond(command, { ...f.cat, actor: { kind: 'cat', actorId: 'opus5' } }));
  await assert.rejects(
    text.respond({ ...command, edits: [{ start, end: start + 3, expectedText: 'bad', replacement: 'new' }] }, f.cat),
    /invalid_patch/,
  );
  const returned = await text.respond(command, f.cat);
  assert.equal(returned.proposal.authorCatId, 'codex-astra');
  assert.equal(await readFile(original, 'utf8'), base);
  assert.equal(await readFile(returned.candidatePath, 'utf8'), base.replace('old', 'new'));
  assert.equal((await text.respond(command, f.cat)).proposal.proposalRef, returned.proposal.proposalRef);
  const candidate = await text.candidate(request.record.requestId, returned.proposal.proposalRef, f.human);
  const continuation = await requests.submit(
    {
      ...payload,
      operationId: randomUUID(),
      intent: { body: '请返回另一个措辞候选。' },
      taskContext: {
        kind: 'text',
        taskId: request.record.progress.task.taskId,
        expectedTaskRevision: read.taskRevision,
      },
    },
    f.human,
  );
  assert.equal(continuation.stage, 'queued', JSON.stringify(continuation.record.issue));
  assert.equal(continuation.record.progress.task?.taskId, request.record.progress.task.taskId);
  assert.equal((await text.read(continuation.record.requestId, f.cat)).source.text, base);
  const sourceMessage = f.messages.getById(continuation.record.progress.sourceMessageId ?? '');
  assert.ok(sourceMessage);
  sourceMessage._tombstone = true;
  await assert.rejects(text.read(continuation.record.requestId, f.cat), /access_denied|CUSTODY_MISMATCH/);
  const accepted = await writer.accept(
    {
      acceptOperationId: randomUUID(),
      requestId: request.record.requestId,
      candidateRef: returned.proposal.proposalRef,
      locator: candidate.source.locator,
      baseRevision: candidate.source.revision,
      bytes: candidate.bytes,
    },
    { userId: 'operator', editSessionToken: signEditToken('work') },
  );
  assert.equal(accepted.state, 'applied');
  assert.equal(await readFile(original, 'utf8'), base.replace('old', 'new'));
  assert.equal(
    f.tasks.get(request.record.progress.task.taskId)?.status === 'done',
    false,
    'candidate or accept is evidence, not a forged Task closure',
  );
});
