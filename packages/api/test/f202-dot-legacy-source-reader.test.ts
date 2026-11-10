import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { DotLegacySourceReader } from '../src/domains/plugin/migration/dot-legacy-source-reader.js';

const eventId = `dot_evt_${'a'.repeat(64)}`;
const imageId = `dot_img_${'b'.repeat(64)}`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dot-legacy-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    connection: join(root, 'dot-connection.json'),
    dispatches: join(root, 'dot-dispatches'),
    images: join(root, 'dot-images'),
    imageFiles: join(root, 'dot-images', 'files'),
  };
  await Promise.all([mkdir(paths.dispatches), mkdir(paths.imageFiles, { recursive: true })]);
  return { root, paths, reader: new DotLegacySourceReader(paths) };
}

test('reads strict legacy records and original image bytes without modifying sources', async (t) => {
  const f = await fixture(t);
  const connection = {
    v: 1,
    revision: 1,
    ownerUserId: 'owner-1',
    pluginInstanceId: 'legacy-instance',
    agentKeyId: 'ak_legacy',
    credentialSecret: 'c'.repeat(64),
    attemptId: 'attempt-1',
    pairingCode: 'd'.repeat(32),
    pairingExpiresAt: 1,
    pairedAt: null,
    pairedCallbackUrl: null,
    subscription: null,
    lastSourceReadAt: null,
    lastReplyAt: null,
    lastImageAt: null,
    revokedAt: null,
    testEventIds: [],
  };
  const dispatch = {
    eventId,
    ownerUserId: 'owner-1',
    threadId: 'thread-1',
    sourceMessageId: 'message-1',
    dispatchInvocationId: 'invocation-1',
    attemptId: 'attempt-1',
    agentKeyId: 'ak_legacy',
    occurredAt: 1,
    webhookAcknowledgedAt: null,
    sourceReadAt: null,
    replyMessageId: null,
    imagePublicationIds: [imageId],
    connectionTest: false,
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = {
    id: imageId,
    ownerUserId: 'owner-1',
    threadId: 'thread-1',
    eventId,
    publicationKey: 'publication-1',
    sha256: createHash('sha256').update(png).digest('hex'),
    byteSize: png.length,
    width: 1,
    height: 1,
    messageId: null,
    alt: 'legacy',
  };
  await Promise.all([
    writeFile(f.paths.connection, JSON.stringify(connection)),
    writeFile(join(f.paths.dispatches, `${eventId}.json`), JSON.stringify(dispatch)),
    writeFile(join(f.paths.dispatches, 'ignored.tmp'), 'not-json'),
    writeFile(join(f.paths.images, `${imageId}.json`), JSON.stringify(image)),
    writeFile(join(f.paths.imageFiles, `${imageId}.png`), png),
  ]);

  assert.deepEqual(await f.reader.connection(), connection);
  assert.deepEqual(await f.reader.dispatches(), [dispatch]);
  assert.deepEqual(await f.reader.imageMetadata(), [image]);
  assert.deepEqual(await f.reader.imageBytes(imageId), png);
});

test('refuses symlinked legacy bytes instead of following arbitrary paths', async (t) => {
  const f = await fixture(t);
  const target = join(f.root, 'outside.png');
  await writeFile(target, 'outside');
  await symlink(target, join(f.paths.imageFiles, `${imageId}.png`));
  await assert.rejects(f.reader.imageBytes(imageId), /ELOOP|symbolic link/i);
});
