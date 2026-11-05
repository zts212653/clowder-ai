import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startRealDocumentOwner } from './f309-ordinary-document-owner.mjs';
import { WEB_ROOT } from './f309-ordinary-workspace-journey-fixture.mjs';

export const DOCUMENT_TEXT =
  '# Harbour guide\n\nFirst unique paragraph.\n\nSecond unique paragraph.\n\nUnquoted closing line.\n';

/** Owned temporary document only. Journal/Task/candidate/Host coordinates are produced by the shipped owner. */
export async function createDocumentRequest({ executionSource = 'carrier' } = {}) {
  const evidence = await mkdtemp('/tmp/f309-document-owner-');
  const owner = await startRealDocumentOwner(path.join(evidence, 'data'), { executionSource });
  const filename = `f309-document-${randomUUID()}.md`;
  const filePath = `packages/web/test/browser/fixtures/${filename}`;
  const absolute = path.resolve(WEB_ROOT, '../..', filePath);
  await writeFile(absolute, DOCUMENT_TEXT, { flag: 'wx' });
  try {
    const listed = await (await fetch(`${owner.api}/api/workspace/worktrees`)).json();
    const worktree = listed.worktrees.find((work) => work.root === owner.root);
    assert.ok(worktree);
    const opened = await owner.app.inject({
      method: 'POST',
      url: '/api/workspace/content-reviews/prepare',
      payload: { locator: { worktreeId: worktree.id, path: filePath }, operationId: 'open-document' },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const revision = opened.json().review.source.revision;
    const locator = opened.json().review.source.locator;
    const quote = (id, text, comment, version = revision) => ({
      v: 1,
      id,
      kind: 'quote',
      text,
      ...(comment ? { comment } : {}),
      source: { kind: 'workspace_file', ...locator, ...(version ? { revision: version } : {}) },
    });
    const earlier = quote('selection-earlier', 'First unique paragraph.', '第一个段落改得具体些'),
      later = quote('selection-later', 'Second unique paragraph.', '第二个段落保留语气');
    const body = '请修改两处引用，另外可提出结尾修改；先给候选，等我决定。';
    const { buildMessageContentBlocks } = await import('../../../api/dist/routes/messages.schema.js');
    const message = owner.messages.append({
      userId: 'operator',
      threadId: owner.thread.id,
      from: { kind: 'user', userId: 'operator' },
      mentions: [owner.catId],
      timestamp: Date.now(),
      content: body,
      contentBlocks: buildMessageContentBlocks(body, [later, earlier]),
    });
    const snapshot = JSON.stringify(message);
    const tasksBefore = owner.tasks.listByThread(owner.thread.id).length;
    const before = await owner.app.inject({ url: `/api/content-modifications/by-message/${message.id}` });
    assert.equal(before.statusCode, 404);
    assert.equal(
      owner.tasks.listByThread(owner.thread.id).length,
      tasksBefore,
      'reading history creates no request or Task',
    );
    const record = await owner.takeOver(message.id);
    assert.equal(owner.tasks.listByThread(owner.thread.id).length, tasksBefore + 1);
    assert.equal(JSON.stringify(owner.messages.getById(message.id)), snapshot, 'takeover preserves the human message');
    const taskId = record.progress.task.taskId;
    const seen = await owner.app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full&limit=200',
      headers: owner.headers,
    });
    assert.equal(seen.statusCode, 200, seen.body);
    await owner.callback('post-message', {
      content: '我引用的是原文件这一段，正文和引用都应保留。',
      contextAttachments: [quote('cat-source', 'First unique paragraph.')],
    });
    const catMessage = owner.messages
      .getByThread(owner.thread.id, 200)
      .find(
        (item) =>
          item.catId === owner.catId && item.contentBlocks?.some((block) => block.attachment?.id === 'cat-source'),
      );
    assert.ok(catMessage);
    // Seed the published/custody boundary; the production GET routes decide visibility, not the browser.
    const queuedCatMessage = owner.messages.append({
      userId: 'operator',
      threadId: owner.thread.id,
      from: { kind: 'agent', catId: owner.catId },
      mentions: [],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      content: '已发布的猫引用仍在等接手。',
      contentBlocks: buildMessageContentBlocks('已发布的猫引用仍在等接手。', [
        quote('queued-cat-source', 'Second unique paragraph.'),
      ]),
    });
    assert.equal(
      owner.tasks.listByThread(owner.thread.id).length,
      tasksBefore + 1,
      'a cat quote creates no second Task',
    );
    async function returnCandidate() {
      const view = await owner.inspect(record.requestId);
      const edits = [
        ['selection-earlier', 'First unique paragraph.', 'First revised paragraph.'],
        ['selection-later', 'Second unique paragraph.', 'Second revised paragraph.'],
        [undefined, 'Unquoted closing line.', 'Proposed closing line.'],
      ].map(([selectionId, expectedText, replacement]) => ({
        ...(selectionId ? { selectionId } : {}),
        start: DOCUMENT_TEXT.indexOf(expectedText),
        end: DOCUMENT_TEXT.indexOf(expectedText) + expectedText.length,
        expectedText,
        replacement,
      }));
      const returned = await owner.callback('content-modification/respond', {
        requestId: record.requestId,
        operationId: randomUUID(),
        expectedTaskRevision: view.taskRevision,
        expectedProposalRevision: view.proposalRevision,
        baseRevision: revision,
        edits,
        response: '两个段落和收尾作为候选返回。',
      });
      assert.equal(await readFile(absolute, 'utf8'), DOCUMENT_TEXT, 'returning a candidate never writes the original');
      const receipt = owner.messages
        .getByThread(owner.thread.id, 200)
        .find((item) => item.extra?.contentModificationReceiptV1?.candidateRef === returned.proposalRef);
      assert.ok(receipt);
      assert.equal(receipt.userId, owner.thread.createdBy);
      assert.deepEqual(receipt.from, { kind: 'system', service: 'content-modification' });
      assert.equal(receipt.extra.contentModificationReceiptV1.taskId, taskId);
      assert.equal(receipt.extra.contentModificationReceiptV1.sourceMessageId, message.id);
      return { returned, receipt };
    }
    async function shareResponsibility() {
      const body = '在同一份原委托中继续这一处。';
      const followUp = owner.messages.append({
        userId: 'operator',
        threadId: owner.thread.id,
        from: { kind: 'user', userId: 'operator' },
        mentions: [owner.catId],
        timestamp: Date.now(),
        content: body,
        contentBlocks: buildMessageContentBlocks(body, [quote('follow-up', 'First unique paragraph.')]),
      });
      const next = await owner.callback('content-modification/take-over', {
        sourceMessageId: followUp.id,
        operationId: randomUUID(),
      });
      assert.equal(next.record.progress.task.taskId, taskId);
      assert.equal(next.record.payload.taskContext.taskId, taskId, 'the owner binds the continuation, not the browser');
      assert.equal(owner.tasks.listByThread(owner.thread.id).length, tasksBefore + 1);
      return { message: followUp, record: next.record };
    }
    return {
      owner,
      filePath,
      filename,
      absolute,
      locator,
      revision,
      message,
      catMessage,
      queuedCatMessage,
      record,
      taskId,
      taskStatus: owner.tasks.get(taskId).status,
      returnCandidate,
      shareResponsibility,
      async close() {
        await owner.close();
        await rm(absolute);
        await rm(evidence, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await owner.close();
    await rm(absolute, { force: true });
    await rm(evidence, { recursive: true, force: true });
    throw error;
  }
}
