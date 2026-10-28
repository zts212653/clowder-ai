import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createCollectiveMessageAttachmentOwner } from '../src/domains/collaborative-content/collective-artifact/message-attachment-owner.ts';
import { createCollectiveMessageAttachmentsProxy } from '../src/domains/plugin/host-surface/collective-message-attachments.ts';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.ts';

test('original public text, decoded audio and a real video frame reach the fresh native consumer without Work or another Human service', async (t) => {
  assert.ok(process.env.F290_PLUGIN_ROOT);
  const load = (path) =>
    import(pathToFileURL(join(resolve(process.env.F290_PLUGIN_ROOT), 'packages/collective-connector/src', path)).href);
  const { publicSourceFixture } = await load('business/connector/__tests__/public-source-caller.fixture.ts');
  const { openCollectiveContextReferences } = await load('collective-context-refs.ts');
  const { createCollectivePublicNativeActions } = await load('collective-public-native-context.ts');
  const { collectiveNativeToolResult } = await load('collective-native-tool-result.ts');
  const exec = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'f290-native-model-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir: join(directory, 'content') });
  let revokeDuringTranscription;
  let speechCalls = 0;
  let speechAvailable = true;
  const originalPort = createCollectiveMessageAttachmentOwner(owner, {
    async transcribeAudio({ audioPath, signal }) {
      signal.throwIfAborted();
      if (!speechAvailable) return undefined;
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', audioPath]);
      assert.ok(
        JSON.parse(stdout).streams.some(
          (stream) => stream.codec_name === 'pcm_s16le' && stream.sample_rate === '16000',
        ),
      );
      speechCalls++;
      await revokeDuringTranscription?.();
      return { text: '明确注入的测试转写 / explicit injected transcript', provider: 'declared-asr-fixture' };
    },
  });
  let hostActive = true;
  const port = createCollectiveMessageAttachmentsProxy(async () => ({
    owner: { attachments: originalPort },
    async current() {
      assert.equal(hostActive, true, 'The explicit Host-installation fixture is no longer active');
    },
  }));
  const f = await publicSourceFixture({
    messageAttachmentOwner: port,
    invocationId: 'fixture-running-turn',
    methods: ['collective.context.current', 'collective.context.read'],
  });
  t.after(() => f.close());
  await f.admit();
  const refs = await openCollectiveContextReferences(join(f.root, 'native-media-refs'), () => {});
  const actions = createCollectivePublicNativeActions({
    connector: f.connector,
    sourceCaller: f.sourceCaller,
    references: refs,
  });
  const current = await actions['collective.context.current']({}, f.action);
  const coordinates = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
  const audioPath = join(directory, 'original.wav'),
    videoPath = join(directory, 'original.webm');
  let unexpectedRequests = 0;
  const trap = createServer((_request, response) => {
    unexpectedRequests++;
    response.end('not approved media');
  });
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        trap.close(resolve);
        trap.closeAllConnections();
      }),
  );
  const trapAddress = trap.address();
  assert.ok(trapAddress && typeof trapAddress === 'object');
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', audioPath]);
  await exec('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x90:d=0.5',
    '-an',
    '-c:v',
    'libvpx',
    videoPath,
  ]);
  const files = [
    { name: 'original.txt', mediaType: 'text/plain', bytes: Buffer.from('公开原文 original public bytes') },
    { name: 'original.wav', mediaType: 'audio/wav', bytes: await readFile(audioPath) },
    { name: 'original.webm', mediaType: 'video/webm', bytes: await readFile(videoPath) },
    {
      name: 'playlist.wav',
      mediaType: 'audio/wav',
      bytes: Buffer.from(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nhttp://127.0.0.1:${trapAddress.port}/private\n`),
    },
    { name: 'archive.zip', mediaType: 'application/octet-stream', bytes: Buffer.from('PK\u0003\u0004binary fixture') },
    { name: 'long.md', mediaType: 'text/markdown', bytes: Buffer.from('a'.repeat(63_999) + '😀tail') },
  ];
  const attachments = [];
  for (const file of files)
    attachments.push(
      await f.store.uploadMessageAttachment(
        f.serviceOwner.sessionToken,
        {
          ...coordinates,
          channelId: 'general',
          clientUploadId: file.name,
          fileName: file.name,
          mediaType: file.mediaType,
          blobDigest: `sha256:${createHash('sha256').update(file.bytes).digest('hex')}`,
        },
        Readable.from([file.bytes]),
        new AbortController().signal,
      ),
    );
  await assert.rejects(
    actions['collective.context.read'](
      {
        contextRef: current.contextRef,
        attachment: { eventId: f.source.eventId, attachmentId: attachments[0].attachmentId },
      },
      f.action,
    ),
    { code: 'ATTACHMENT_ACCESS_DENIED' },
  );
  const event = await f.store.postHumanMessage(f.serviceOwner.sessionToken, {
    ...coordinates,
    body: '',
    attachments,
    clientEventId: 'original-model-media',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
  });
  const read = (attachment, extra = {}, contextRef = current.contextRef) =>
    actions['collective.context.read'](
      {
        contextRef,
        attachment: { eventId: event.eventId, attachmentId: attachment.attachmentId, ...extra },
      },
      f.action,
    );
  const text = await read(attachments[0]);
  assert.equal(text.content.type, 'text');
  assert.equal(text.content.text, files[0].bytes.toString());
  assert.equal(text.sourceDigest, attachments[0].blobDigest);
  const laterText = await read(attachments[0], { textOffset: 2 });
  assert.equal(laterText.content.offset, 2);
  assert.equal(laterText.content.text, files[0].bytes.toString().slice(2));
  const audio = await read(attachments[1]);
  assert.equal(audio.content.type, 'audio');
  assert.equal(audio.content.transcript, '明确注入的测试转写 / explicit injected transcript');
  assert.ok(audio.content.durationSeconds > 0 && audio.content.durationSeconds <= 0.6);
  const video = await read(attachments[2], { startSeconds: 0.1 });
  assert.equal(video.content.type, 'video');
  assert.equal(video.content.audio.status, 'none');
  assert.equal(video.content.atSeconds, 0.1);
  const native = collectiveNativeToolResult('collective.context.read', video);
  assert.equal(native.content[1].type, 'image');
  const pixel = await sharp(Buffer.from(native.content[1].data, 'base64')).resize(1, 1).raw().toBuffer();
  assert.ok(pixel[2] > 200 && pixel[0] < 40);
  assert.ok(!native.content[0].text.includes(video.content.frame.dataBase64));
  if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
    await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'native-video-result.json'), JSON.stringify(native));
  }
  assert.equal(speechCalls, 1, 'A video without audio must not invent a transcription request');
  await assert.rejects(read(attachments[3]));
  assert.equal(unexpectedRequests, 0, 'Uploaded playlist bytes cannot cause network requests in the decoder');
  assert.deepEqual((await read(attachments[4])).content, { type: 'unavailable', reason: 'unsupported_format' });
  const firstTextWindow = await read(attachments[5]);
  assert.equal(firstTextWindow.content.nextOffset, 63_999);
  const lastTextWindow = await read(attachments[5], { textOffset: firstTextWindow.content.nextOffset });
  assert.equal(firstTextWindow.content.text + lastTextWindow.content.text, files[5].bytes.toString());
  assert.equal(lastTextWindow.content.nextOffset, undefined);
  await assert.rejects(read(attachments[0], { startSeconds: 1 }), { code: 'ATTACHMENT_READ_RANGE_INVALID' });
  speechAvailable = false;
  assert.deepEqual((await read(attachments[1])).content, { type: 'unavailable', reason: 'transcription_unavailable' });
  speechAvailable = true;
  await assert.rejects(
    f.store.readParticipationMedia(
      f.serviceOwner.sessionToken,
      {
        ...coordinates,
        connectionId: f.source.connectionId,
        eventId: f.source.eventId,
        catId: f.source.catId,
        participationRevision: f.source.participationRevision,
        attachment: { eventId: event.eventId, attachmentId: attachments[0].attachmentId },
      },
      new AbortController().signal,
    ),
    { code: 'CONNECTION_NOT_FOUND' },
  );
  const foreign = await f.store.uploadMessageAttachment(
    f.serviceOwner.sessionToken,
    {
      ...coordinates,
      channelId: 'other',
      clientUploadId: 'other-model-file',
      fileName: 'other.txt',
      mediaType: 'text/plain',
      blobDigest: attachments[0].blobDigest,
    },
    Readable.from([files[0].bytes]),
    new AbortController().signal,
  );
  const otherEvent = await f.store.postHumanMessage(f.serviceOwner.sessionToken, {
    ...coordinates,
    body: '',
    attachments: [foreign],
    clientEventId: 'other-model-content',
    location: { channelId: 'other' },
    recipient: { kind: 'channel' },
  });
  await assert.rejects(
    actions['collective.context.read'](
      {
        contextRef: current.contextRef,
        attachment: { eventId: otherEvent.eventId, attachmentId: foreign.attachmentId },
      },
      f.action,
    ),
    { code: 'ATTACHMENT_ACCESS_DENIED' },
  );
  for (const [index, attachment] of attachments.entries())
    assert.equal((await owner.load(attachment.contentRef, 1)).bytes.equals(files[index].bytes), true);
  await assert.rejects(read(attachments[0], {}, 'foreign-context'));
  revokeDuringTranscription = () => {
    hostActive = false;
  };
  await assert.rejects(read(attachments[1]));
  hostActive = true;
  revokeDuringTranscription = () =>
    f.store.revokeConnection({
      sessionToken: f.serviceOwner.sessionToken,
      collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId,
    });
  await assert.rejects(read(attachments[1]));
  assert.ok(
    (await f.store.listEventsForHuman(f.serviceOwner.sessionToken, f.connection.collectiveId)).every(
      (row) => !row.workRequest,
    ),
  );
  process.stdout.write(
    'F290 model media: exact text, actually decoded PCM audio, real blue native video pixels, unchanged originals and late-revocation fence\n',
  );
});
