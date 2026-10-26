import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeImageBytes } from './f309-artwork-lightbox-image-formats.mjs';
import { startRealDocumentOwner } from './f309-ordinary-document-owner.mjs';
import { ordinaryVideoFixture } from './f309-ordinary-workspace-journey-actions.mjs';
import { IMAGE_FIXTURE } from './f309-ordinary-workspace-journey-fixture.mjs';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function createNativeArtworkFixture(kind, evidence, sourceKind = 'workspace') {
  await mkdir(evidence, { recursive: true });
  const dataDir = path.join(evidence, 'private-data');
  const owner = await startRealDocumentOwner(dataDir, { executionSource: 'original-human', media: true });
  // The original document helper reads the text callback. Media uses the shipped Human request read.
  async function inspect(requestId) {
    const response = await fetch(`${owner.api}/api/content-modifications/${requestId}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const directory = await mkdtemp(path.join(owner.root, 'f309-native-artwork-'));
  const filename =
    kind === 'mp4' && process.env.F309_ORIGINAL_FILM_PATH
      ? path.basename(process.env.F309_ORIGINAL_FILM_PATH)
      : `native-original.${kind}`;
  const absolute =
    sourceKind === 'publication'
      ? path.join(dataDir, `native-original-${Date.now()}.${kind}`)
      : path.join(directory, filename);
  const relative = `${path.basename(directory)}/${filename}`;
  if (kind === 'mp4' && process.env.F309_ORIGINAL_FILM_PATH)
    await copyFile(process.env.F309_ORIGINAL_FILM_PATH, absolute);
  else
    await writeFile(
      absolute,
      kind === 'png'
        ? IMAGE_FIXTURE.bytes
        : kind === 'mp4'
          ? (await ordinaryVideoFixture()).bytes
          : await nativeImageBytes(kind),
    );
  const original = await readFile(absolute);
  const list = await fetch(`${owner.api}/api/workspace/worktrees`).then((response) => response.json());
  const root = list.worktrees.find((work) => work.root === owner.root);
  assert.ok(root);
  const locator = { worktreeId: root.id, path: relative };
  const workspace =
    sourceKind === 'workspace' ? await owner.workspaceSource.describeMedia({ principal: owner.human, locator }) : null;
  const mime = workspace?.mime ?? (kind === 'jpg' ? 'image/jpeg' : 'image/webp');
  const url = workspace
    ? `/api/workspace/file/raw?${new URLSearchParams(locator)}`
    : `/uploads/${path.basename(absolute)}`;
  const publication = owner.messages.append({
    userId: 'operator',
    threadId: owner.thread.id,
    from: { kind: 'agent', catId: owner.catId },
    mentions: [],
    timestamp: Date.now(),
    content: '原作品，等你一起改。',
    extra: {
      rich: {
        v: 1,
        blocks: [{ kind: 'file', v: 1, id: 'original-media', fileName: filename, mimeType: mime, url }],
      },
    },
  });
  const asset = workspace
    ? null
    : await owner.artifacts.media.prepare({
        source: {
          kind: 'message',
          threadId: owner.thread.id,
          messageId: publication.id,
          messageRevision: String(publication.timestamp),
          expectedUrl: url,
          item: { kind: 'rich-file', blockId: 'original-media' },
        },
        operationId: randomUUID(),
        principal: owner.human,
      });
  const source = workspace ?? { mime, revision: asset.ownerRevision, media: asset.media, asset };
  const sent = [];
  async function captureSend(context) {
    await context.route('**/api/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const { sendMessageSchema, buildMessageContentBlocks } = await import(
        '../../../api/dist/routes/messages.schema.js'
      );
      const input = sendMessageSchema.parse(route.request().postDataJSON());
      assert.equal(input.threadId, owner.thread.id);
      assert.ok(input.content.startsWith(`@${owner.catId} `));
      assert.equal(input.contextAttachments.length, 1);
      assert.equal(input.contextAttachments[0].kind, 'media');
      const message = owner.messages.append({
        userId: 'operator',
        threadId: owner.thread.id,
        from: { kind: 'user', userId: 'operator' },
        mentions: [owner.catId],
        timestamp: Date.now(),
        content: input.content,
        contentBlocks: buildMessageContentBlocks(input.content, input.contextAttachments),
      });
      sent.push({ input, message });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { status: 'queued', userMessageId: message.id, threadId: owner.thread.id },
      });
    });
  }
  async function returnCandidate(record) {
    const view = await owner.artifacts.reviews.readCurrent(record.progress.review.reviewId, owner.human);
    const round = view.review.rounds.at(-1);
    assert.ok(round?.ledgerRevision);
    const name = `native-candidate-${Date.now()}.${kind}`;
    const output = path.join(dataDir, name);
    if (kind === 'png') await copyFile(path.join(owner.root, 'assets/avatars/codex.png'), output);
    else if (kind === 'mp4')
      execFileSync('ffmpeg', ['-v', 'error', '-i', absolute, '-t', '1', '-an', '-c:v', 'copy', output], {
        timeout: 15_000,
      });
    else await writeFile(output, await nativeImageBytes(kind, true));
    const bytes = await readFile(output);
    assert.notEqual(digest(bytes), digest(original));
    const published = owner.messages.append({
      userId: 'operator',
      threadId: owner.thread.id,
      from: { kind: 'agent', catId: owner.catId },
      mentions: [],
      timestamp: Date.now(),
      content: '隔离 provider 返回的候选，尚未写回。',
      extra: {
        rich: {
          v: 1,
          blocks: [{ kind: 'file', v: 1, id: name, fileName: name, mimeType: source.mime, url: `/uploads/${name}` }],
        },
      },
    });
    await owner.callback('artifact-review/respond', {
      requestId: record.requestId,
      reviewId: view.review.reviewId,
      expectedRevision: view.review.revision,
      expectedLedgerRevision: round.ledgerRevision,
      expectedTaskRevision: view.authority.taskRevision,
      expectedOwnerRevision: round.asset.ownerRevision,
      operationId: randomUUID(),
      artifactRef: `/uploads/${name}`,
      expectedArtifactRevision: String(published.timestamp),
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '候选供比较，原版等待你的决定。',
      })),
    });
    const request = await inspect(record.requestId);
    if (sourceKind === 'publication') {
      const current = await owner.artifacts.reviews.readCurrent(view.review.reviewId, owner.human);
      const currentRound = current.review.rounds.at(-1);
      assert.ok(currentRound?.ledgerRevision);
      await owner.callback('artifact-review/act', {
        reviewId: current.review.reviewId,
        expectedRevision: current.review.revision,
        expectedLedgerRevision: currentRound.ledgerRevision,
        expectedTaskRevision: current.authority.taskRevision,
        round: currentRound.number,
        operationId: randomUUID(),
        action: {
          kind: 'request_judgment',
          summary: '候选已准备好，原作品未改。',
          judgmentNeeded: '请确认是否通过此版本。',
        },
      });
    }
    const candidate = request.candidates.at(-1);
    assert.ok(candidate);
    const receipt = owner.messages
      .getByThread(owner.thread.id, 200)
      .find((message) => message.extra?.contentModificationReceiptV1?.candidateRef === candidate.candidateRef);
    assert.ok(receipt);
    assert.deepEqual(await readFile(absolute), original);
    return { candidate, receipt, bytes, published, name };
  }
  return {
    owner: { ...owner, inspect },
    filename,
    absolute,
    relative,
    source,
    sourceKind,
    original,
    publication,
    sent,
    captureSend,
    returnCandidate,
    async close() {
      await owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
