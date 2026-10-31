import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { WorkspaceWritebackService } from '../src/domains/workspace/writeback/service.js';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

async function workspaceRequest(t: Parameters<typeof mediaMessageFixture>[0]) {
  const f = await mediaMessageFixture(t);
  const locator = { worktreeId: 'media-worktree', path: 'review-input.png' };
  const opened = await f.files.prepare({ principal: f.human, locator, operationId: 'open-file' });
  const source = {
    kind: 'workspace' as const,
    locator,
    expectedSourceRevision: opened.review.source.revision,
    reviewId: opened.review.reviewId,
    expectedReviewRevision: opened.review.revision,
  };
  const message = f.send({ ...f.attachment, source, taskContext: undefined });
  const request = await f.takeOver(message.id);
  assert.equal(request.stage, 'queued', JSON.stringify(request.record.issue));
  const returned = await f.candidate(request.record.requestId);
  const candidateRef = returned.view.review.rounds.at(-1)?.asset.ownerReceiptRef;
  assert.ok(candidateRef);
  const command = {
    requestId: request.record.requestId,
    candidateRef,
    acceptOperationId: randomUUID(),
    baseRevision: source.expectedSourceRevision,
    locator,
    editSessionToken: signEditToken(locator.worktreeId),
  };
  const states = () =>
    f.messages
      .getByThread(f.thread.id)
      .flatMap((item) =>
        item.extra?.contentModificationReceiptV1 ? [item.extra.contentModificationReceiptV1.state] : [],
      );
  return { ...f, request, message, command, states };
}

test('Human media candidate leaves workspace untouched until explicit F063 acceptance or rejection', async (t) => {
  const f = await workspaceRequest(t);
  const path = join(f.root, 'review-input.png');
  const original = await readFile(path);
  assert.notDeepEqual(original, await readFile(join(f.root, 'candidate.png')));
  const rejected = await f.integration.results.reject(f.command.requestId, f.command.candidateRef, f.human);
  assert.ok(rejected.receiptRef);
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(f.states(), ['candidate', 'rejected']);
  await assert.rejects(f.integration.results.accept(f.command, f.human), /candidate_rejected/);
  assert.deepEqual(await readFile(path), original);
});

test('explicit Human PNG acceptance needs a valid edit token and applies/replays the real F063 effect once', async (t) => {
  const f = await workspaceRequest(t);
  const path = join(f.root, 'review-input.png');
  const original = await readFile(path);
  await assert.rejects(f.integration.results.accept({ ...f.command, editSessionToken: 'invalid' }, f.human), /token/);
  assert.deepEqual(await readFile(path), original);
  const accepted = await f.integration.results.accept(f.command, f.human);
  assert.equal(accepted.receipt.state, 'applied');
  assert.deepEqual(await readFile(path), await readFile(join(f.root, 'candidate.png')));
  assert.deepEqual(f.states(), ['candidate', 'applied']);
  await f.integration.results.accept(f.command, f.human);
  await f.integration.receipts.recover();
  assert.deepEqual(f.states(), ['candidate', 'applied']);
});

test('real PNG CAS conflict retains newer workspace bytes and projects one honest Host result', async (t) => {
  const f = await workspaceRequest(t);
  const path = join(f.root, 'review-input.png');
  const external = await sharp({ create: { width: 160, height: 100, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  await writeFile(path, external);
  const conflict = await f.integration.results.accept(f.command, f.human);
  assert.equal(conflict.receipt.state, 'conflict');
  assert.deepEqual(await readFile(path), external);
  assert.deepEqual(f.states(), ['candidate', 'conflict']);
  await f.integration.receipts.recover();
  assert.deepEqual(f.states(), ['candidate', 'conflict']);
  const host = f.messages
    .getByThread(f.thread.id)
    .find((item) => item.extra?.contentModificationReceiptV1?.state === 'conflict');
  assert.equal(host?.replyTo, f.message.id);
  assert.equal(host?.visibility, 'whisper');
  assert.deepEqual(
    host?.extra?.contentModificationReceiptV1?.followUp,
    { kind: 'unverified' },
    'queued follow-up is never claimed as a real cat awakening',
  );
});

test('real media writeback crash with a replaced inode projects unknown and never repeats the file effect', async (t) => {
  const f = await workspaceRequest(t);
  const writer = new WorkspaceWritebackService({
    source: f.source,
    databasePath: join(f.root, 'unknown-writebacks.sqlite'),
    proofDirectory: join(f.root, 'unknown-proofs'),
    checkpoint: async (point) => {
      if (point === 'renamed') throw new Error('lost media writeback process');
    },
  });
  t.after(async () => writer.close());
  f.integration.writer.accept = writer.accept.bind(writer);
  f.integration.writer.find = writer.find.bind(writer);
  f.integration.writer.read = writer.read.bind(writer);
  await assert.rejects(f.integration.results.accept(f.command, f.human), /lost media writeback process/);
  const candidate = await readFile(join(f.root, 'candidate.png'));
  const replacement = join(f.root, 'external.png');
  await writeFile(replacement, candidate);
  await rename(replacement, join(f.root, 'review-input.png'));
  await f.integration.receipts.recover();
  assert.deepEqual(f.states(), ['candidate', 'unknown']);
  const unknown = await f.integration.results.accept(f.command, f.human);
  assert.equal(unknown.receipt.state, 'unknown');
  await f.integration.receipts.recover();
  assert.deepEqual(f.states(), ['candidate', 'unknown']);
  assert.deepEqual(await readFile(join(f.root, 'review-input.png')), candidate);
});
