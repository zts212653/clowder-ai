import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import sharp from 'sharp';
import { scanAndPublishCodexImages } from '../src/domains/cats/services/agents/providers/codex-image-scanner.js';
import {
  codexImageOriginEnvelope,
  codexNativeImageOutputs,
} from '../src/domains/cats/services/agents/providers/codex-native-image-origin.js';
import { publishGeneratedImage } from '../src/domains/cats/services/agents/providers/generated-image-publication.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'f309-native-image-'));
  directories.push(root);
  const sessionId = 'native-session';
  const codexHome = join(root, 'codex');
  const session = join(codexHome, 'generated_images', sessionId);
  await mkdir(session, { recursive: true });
  const generated = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#48705b' } })
    .png()
    .toBuffer();
  const sourcePath = join(session, 'exec-generated.png');
  await writeFile(sourcePath, generated);
  await writeFile(join(session, 'old-unpublished.png'), 'old native turn');
  const origin = {
    invocationId: 'producing-child',
    envelopes: [
      { direction: 'outbound', envelope: { id: 11, method: 'turn/start', params: { threadId: sessionId } } },
      { direction: 'inbound', envelope: { id: 11, result: { turn: { id: 'native-turn' } } } },
      {
        direction: 'inbound',
        envelope: {
          method: 'item/completed',
          params: {
            threadId: sessionId,
            turnId: 'native-turn',
            item: {
              type: 'imageGeneration',
              id: 'exec-generated',
              status: 'completed',
              savedPath: sourcePath,
              result: generated.toString('base64'),
              failure: null,
            },
          },
        },
      },
    ],
  };
  const options = Object.assign(
    { codexSessionId: sessionId, codexHome, uploadDir: join(root, 'uploads') },
    {
      nativeSource: origin,
    },
  );
  return { options, origin, sourcePath };
}

test('the accepted native image output binds its producing child and excludes old session files', async () => {
  const f = await fixture();
  const images = await scanAndPublishCodexImages({
    ...f.options,
    nativeSource: {
      ...f.origin,
      envelopes: f.origin.envelopes
        .map((entry) => codexImageOriginEnvelope(entry.direction, entry.envelope))
        .filter(Boolean),
    },
  });
  assert.equal(images.length, 1, 'session discovery cannot attribute an old image to this child');
  assert.deepEqual(Object.getOwnPropertyDescriptor(images[0]?.provenance, 'nativeOrigin')?.value, {
    provider: 'codex',
    invocationId: 'producing-child',
    sessionId: 'native-session',
    turnId: 'native-turn',
    itemId: 'exec-generated',
    blobDigest: `sha256:${(await import('node:crypto'))
      .createHash('sha256')
      .update(await readFile(f.sourcePath))
      .digest('hex')}`,
  });
});

test('copied upload without a persisted message replays the same proven publication', async () => {
  const f = await fixture();
  const first = await scanAndPublishCodexImages(f.options);
  const recovered = await scanAndPublishCodexImages(f.options);
  assert.equal(first.length, 1);
  assert.equal(recovered.length, 1, 'file existence is not a message publication receipt');
  assert.equal(recovered[0]?.isNew, false);
  assert.equal(recovered[0]?.publicationKey, first[0]?.publicationKey);
  assert.deepEqual(recovered[0]?.richBlock, first[0]?.richBlock);
});

for (const variant of [
  'missing-acceptance',
  'other-turn',
  'other-session',
  'outbound-result',
  'failed-output',
] as const) {
  test(`native ${variant} does not establish image ownership`, async () => {
    const f = await fixture();
    const completion = f.origin.envelopes[2];
    assert.ok(completion?.envelope.params?.item);
    if (variant === 'missing-acceptance') f.origin.envelopes.splice(1, 1);
    if (variant === 'other-turn') completion.envelope.params.turnId = 'old-turn';
    if (variant === 'other-session') completion.envelope.params.threadId = 'other-session';
    if (variant === 'outbound-result') completion.direction = 'outbound';
    if (variant === 'failed-output') completion.envelope.params.item.status = 'failed';
    assert.deepEqual(await scanAndPublishCodexImages(f.options), []);
  });
}

test('native output identity cannot authorize changed file bytes', async () => {
  const f = await fixture();
  await writeFile(f.sourcePath, 'different image');
  assert.deepEqual(await scanAndPublishCodexImages(f.options), []);
});

test('a changed source between native verification and publication leaves no unproven upload', async () => {
  const f = await fixture();
  const [output] = codexNativeImageOutputs(f.origin, 'native-session');
  assert.ok(output);
  const changed = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#be6d47' } })
    .png()
    .toBuffer();
  await writeFile(f.sourcePath, changed);
  await mkdir(f.options.uploadDir);
  await assert.rejects(
    publishGeneratedImage({
      sourcePath: f.sourcePath,
      mimeType: 'image/png',
      publicationKey: 'native-verified-before-source-change',
      provider: 'codex',
      toolName: 'image_gen',
      uploadDir: f.options.uploadDir,
      nativeOrigin: output.origin,
    }),
    /do not match their native generation/,
  );
  assert.deepEqual(await readdir(f.options.uploadDir), []);
});

test('duplicate native completion is one publication, while conflicting path and digest cannot publish', async () => {
  const f = await fixture();
  const completion = f.origin.envelopes[2];
  assert.ok(completion);
  f.origin.envelopes.push(structuredClone(completion));
  assert.equal((await scanAndPublishCodexImages(f.options)).length, 1);
  const conflict = structuredClone(completion);
  assert.ok(conflict.envelope.params?.item);
  conflict.envelope.params.item.savedPath = join(
    f.options.codexHome,
    'generated_images/native-session/old-unpublished.png',
  );
  f.origin.envelopes.push(conflict);
  assert.deepEqual(
    await scanAndPublishCodexImages(f.options),
    [],
    'conflicting native identity cannot silently pick a file',
  );
});
