import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { FileMessagingMediaLedger } = await import('../dist/domains/messaging/media-ledger.js');
const { createHostMediaPostProcessor } = await import('../dist/domains/messaging/media-post-processing.js');
const { extractTrustedImagePaths, extractImageUrls } = await import(
  '../dist/domains/cats/services/agents/providers/image-paths.js'
);
const { MessageContentSchema } = await import('../../shared/dist/schemas/message.schema.js');

test('image remains one private HMR and resolves only inside Host cat runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f202-e2-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = new FileMessagingMediaLedger(join(root, 'media'));
  const bytes = Buffer.from('private image bytes');
  const hmrId = await media.register(bytes);
  const process = createHostMediaPostProcessor({ ledger: media, privateDir: join(root, 'private') });
  const result = await process(
    [{ elementId: 'photo', hmrId, type: 'image', fileName: 'photo.png' }],
    Date.now() + 5000,
  );
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.contentBlocks, [{ type: 'image', url: `hmr:${hmrId}` }]);
  const paths = await extractTrustedImagePaths(result.contentBlocks, join(root, 'uploads'), (id) =>
    media.resolveTrustedBlobPath(id),
  );
  assert.equal(paths.length, 1);
  assert.deepEqual(await readFile(paths[0]), bytes);
  assert.deepEqual(
    await extractTrustedImagePaths(
      [result.contentBlocks[0], { type: 'image', url: '/uploads/ordinary.png' }],
      join(root, 'uploads'),
      (id) => media.resolveTrustedBlobPath(id),
    ),
    [paths[0], join(root, 'uploads', 'ordinary.png')],
  );
  assert.deepEqual(extractImageUrls(result.contentBlocks), []);
  await assert.rejects(readdir(join(root, 'uploads')), { code: 'ENOENT' });
  assert.equal(MessageContentSchema.safeParse(result.contentBlocks[0]).success, true);
  assert.equal(MessageContentSchema.safeParse({ type: 'image', url: 'hmr:../private' }).success, false);
  assert.equal(MessageContentSchema.safeParse({ type: 'image', url: 'media:hmr_123' }).success, false);
  await writeFile(paths[0], Buffer.from('tampered image byte'));
  await assert.rejects(media.resolveTrustedBlobPath(hmrId), /changed after registration/);
  const failed = await process([{ elementId: 'photo', hmrId, type: 'image' }], Date.now() + 5000);
  assert.deepEqual(failed.warnings[0].payload, {
    mediaElementId: 'photo',
    stage: 'preview',
    reason: 'processing_failed',
  });
});

test('audio uses a private 0600 temporary file and leaves only the transcript', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f202-e2-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = new FileMessagingMediaLedger(join(root, 'media'));
  const bytes = Buffer.from('private audio bytes');
  const hmrId = await media.register(bytes);
  const process = createHostMediaPostProcessor({
    ledger: media,
    privateDir: join(root, 'private'),
    sttProvider: {
      transcribe: async ({ audioPath }) => {
        assert.deepEqual(await readFile(audioPath), bytes);
        assert.equal((await stat(audioPath)).mode & 0o777, 0o600);
        return { text: 'recognized speech' };
      },
    },
  });
  const result = await process(
    [{ elementId: 'voice', hmrId, type: 'audio', fileName: 'voice.wav' }],
    Date.now() + 5000,
  );
  assert.equal(result.transcript, 'recognized speech');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(await readdir(join(root, 'private')), []);
});

test('failed or timed-out processing keeps a typed warning attached to the original media element', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f202-e2-warning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = new FileMessagingMediaLedger(join(root, 'media'));
  const hmrId = await media.register(Buffer.from('audio bytes'));
  const failed = createHostMediaPostProcessor({
    ledger: media,
    privateDir: join(root, 'private'),
    sttProvider: {
      transcribe: async () => {
        throw new Error('provider failure');
      },
    },
  });
  const failure = await failed([{ elementId: 'voice', hmrId, type: 'audio' }], Date.now() + 5000);
  assert.deepEqual(failure.warnings[0].payload, {
    mediaElementId: 'voice',
    stage: 'transcription',
    reason: 'processing_failed',
  });
  assert.deepEqual(await readdir(join(root, 'private')), []);
  const timed = createHostMediaPostProcessor({
    ledger: media,
    privateDir: join(root, 'private'),
    stageTimeoutMs: 10,
    sttProvider: { transcribe: async () => new Promise(() => {}) },
  });
  const timeout = await timed([{ elementId: 'voice', hmrId, type: 'audio' }], Date.now() + 5000);
  assert.deepEqual(timeout.warnings[0].payload, {
    mediaElementId: 'voice',
    stage: 'transcription',
    reason: 'timeout',
  });
  assert.deepEqual(await readdir(join(root, 'private')), []);
});
