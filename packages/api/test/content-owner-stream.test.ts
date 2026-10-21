import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

const actor = { kind: 'human' as const, actorId: 'operator' };
const contentRef = 'prepared-media:streamed-film';
const scope = { ownerUserId: 'operator', threadId: 'film-thread', taskId: 'film-task' };
const publication = { artifactRef: 'movie.mp4', sourceRef: 'message:film-thread:first-cut', revision: 'original' };
const bytes = Buffer.alloc(64 * 1024, 7);
const digest = `sha256:${createHash('sha256').update(bytes).update(bytes).digest('hex')}` as const;

function payload() {
  return { stream: Readable.from([bytes, bytes]), byteLength: bytes.length * 2, blobDigest: digest };
}

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'f326-content-stream-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  const request = {
    contentRef,
    operationId: 'v1',
    actor,
    mediaType: 'video/mp4',
    publicationScope: scope,
    sourcePublication: publication,
    authorizeEffect: async () => undefined,
  };
  return { owner, request, dataDir };
}

test('stream publication shares owner versions, CAS and receipts, including exact history after restart', async (t) => {
  const { owner, request, dataDir } = await fixture(t);
  const first = await owner.importStream({ ...request, ...payload() });
  assert.equal(first.ownerRevision, 1);
  const replay = payload();
  assert.deepEqual(await owner.importStream({ ...request, ...replay }), first);
  assert.equal(replay.stream.destroyed, true, 'a replay must release the unused source stream');
  const nextBytes = Buffer.from('a different completed cut');
  const second = await owner.settleStream({
    contentRef,
    actor,
    operationId: 'v2',
    expectedOwnerRevision: 1,
    stream: Readable.from([nextBytes]),
    byteLength: nextBytes.length,
    blobDigest: `sha256:${createHash('sha256').update(nextBytes).digest('hex')}`,
    sourcePublication: { ...publication, revision: 'second-cut' },
    authorizeEffect: request.authorizeEffect,
  });
  assert.equal(second.ownerRevision, 2);
  const restarted = new ProjectContentOwnerService({ dataDir });
  assert.equal((await restarted.describe(contentRef)).currentOwnerRevision, 2);
  assert.deepEqual((await restarted.load(contentRef, 1)).bytes, Buffer.concat([bytes, bytes]));
  assert.deepEqual((await restarted.load(contentRef, 2)).bytes, nextBytes);
  assert.deepEqual(await restarted.listOutbox(contentRef), [first, second]);
  const stale = payload();
  await assert.rejects(
    owner.settleStream({
      contentRef,
      actor,
      ...stale,
      sourcePublication: publication,
      authorizeEffect: request.authorizeEffect,
      operationId: 'stale',
      expectedOwnerRevision: 1,
    }),
    /conflict/i,
  );
  assert.equal(stale.stream.destroyed, true);
  assert.equal((await restarted.describe(contentRef)).currentOwnerRevision, 2);
});

test('incorrect digest, interrupted and short streams create no readable content or receipt', async (t) => {
  const { owner, request } = await fixture(t);
  for (const broken of [
    { ...payload(), blobDigest: `sha256:${'f'.repeat(64)}` as const },
    { ...payload(), byteLength: bytes.length * 2 + 1 },
    {
      ...payload(),
      stream: Readable.from(
        (async function* () {
          yield bytes;
          throw new Error('source interrupted');
        })(),
      ),
    },
  ]) {
    await assert.rejects(owner.importStream({ ...request, ...broken }));
    assert.equal(broken.stream.destroyed, true);
    await assert.rejects(owner.describe(contentRef), /not found/i);
    assert.deepEqual(
      await owner.findSourcePublications({ ownerUserId: 'operator', ...publication, revisions: ['original'] }),
      [],
    );
  }
});

test('current authority is checked after all source awaits before first publication becomes visible', async (t) => {
  const { owner, request } = await fixture(t);
  let allowed = true;
  const stream = Readable.from(
    (async function* () {
      yield bytes;
      allowed = false;
      yield bytes;
    })(),
  );
  await assert.rejects(
    owner.importStream({
      ...request,
      ...payload(),
      stream,
      authorizeEffect: async () => {
        if (!allowed) throw new Error('authority revoked');
      },
    }),
    /authority revoked/,
  );
  await assert.rejects(owner.describe(contentRef), /not found/i);
  assert.equal(stream.destroyed, true);
});

test('cancelling a stream blocked awaiting input releases it without a visible first version', async (t) => {
  const { owner, request } = await fixture(t);
  const controller = new AbortController();
  const stream = new Readable({
    read() {
      controller.abort(new Error('cancelled by caller'));
    },
  });
  t.after(async () => {
    stream.destroy();
  });
  await assert.rejects(
    owner.importStream({ ...request, ...payload(), stream, signal: controller.signal }),
    /abort|cancel/i,
  );
  await assert.rejects(owner.describe(contentRef), /not found/i);
  assert.equal(stream.destroyed, true);
});
