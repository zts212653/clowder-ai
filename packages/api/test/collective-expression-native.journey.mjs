import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createCollectiveMessageAttachmentOwner } from '../src/domains/collaborative-content/collective-artifact/message-attachment-owner.ts';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.ts';

test('real original custody reaches native model pixels and the same named cat can publish an immutable catalogue sticker', async (t) => {
  assert.ok(process.env.F290_PLUGIN_ROOT, 'Use the exact Plugin worktree under test');
  const plugin = resolve(process.env.F290_PLUGIN_ROOT, 'packages/collective-connector');
  const load = (path) => import(pathToFileURL(join(plugin, 'src', path)).href);
  const { publicSourceFixture } = await load('business/connector/__tests__/public-source-caller.fixture.ts');
  const { openCollectiveContextReferences } = await load('collective-context-refs.ts');
  const { createCollectivePublicNativeActions } = await load('collective-public-native-context.ts');
  const { collectiveNativeToolResult } = await load('collective-native-tool-result.ts');
  const directory = await mkdtemp(join(tmpdir(), 'f290-real-owner-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir: join(directory, 'content') });
  const originalPort = createCollectiveMessageAttachmentOwner(owner, {
    stickerDirectories: {
      memory: fileURLToPath(new URL('../../web/public/f321/stickers/', import.meta.url)),
      collaboration: fileURLToPath(
        new URL('../../../docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/', import.meta.url),
      ),
    },
  });
  let beforeCatalogReturn;
  const messageAttachmentOwner = {
    ...originalPort,
    async catalogImage(...args) {
      const result = await originalPort.catalogImage(...args);
      await beforeCatalogReturn?.();
      return result;
    },
  };
  // The original owner, Service, Connector and native content adapter are real. OAuth/running-Cat attestations are fixtures.
  const f = await publicSourceFixture({
    messageAttachmentOwner,
    invocationId: 'fixture-running-turn',
    methods: [
      'collective.context.current',
      'collective.context.read',
      'collective.sticker.prepare',
      'collective.reply.submit',
    ],
  });
  t.after(() => f.close());
  const coordinates = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
  const bytes = await sharp({ create: { width: 320, height: 180, channels: 4, background: '#154fc4' } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="320" height="180"><circle cx="60" cy="90" r="32" fill="#ffcf40"/><text x="110" y="100" font-size="27" fill="white">CHANNEL 42</text></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  const attachment = await f.store.uploadMessageAttachment(
    f.serviceOwner.sessionToken,
    {
      ...coordinates,
      channelId: 'general',
      clientUploadId: 'actual-native-picture',
      fileName: 'channel-42.png',
      mediaType: 'image/png',
      blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
    Readable.from([bytes]),
    new AbortController().signal,
  );
  const source = await f.store.postHumanMessage(f.serviceOwner.sessionToken, {
    ...coordinates,
    clientEventId: 'actual-native-image-source',
    location: { channelId: 'general' },
    recipient: {
      kind: 'agent',
      humanId: f.serviceOwner.human.humanId,
      connectionId: f.source.connectionId,
      agentId: f.source.catId,
      participationRevision: f.source.participationRevision,
    },
    body: '请读同一份公开图片，再用贴纸回应。',
    attachments: [attachment],
  });
  await f.connector.sync(f.connection.connectionId);
  await f.sourceCaller.admitAgentEvent(f.connection.connectionId, source.eventId, f.owner);
  const references = await openCollectiveContextReferences(join(f.root, 'actual-native-refs'), () => {});
  const actions = createCollectivePublicNativeActions({
    connector: f.connector,
    sourceCaller: f.sourceCaller,
    references,
  });
  const current = await actions['collective.context.current']({}, f.action);
  const result = await actions['collective.context.read'](
    { contextRef: current.contextRef, image: { eventId: source.eventId, attachmentId: attachment.attachmentId } },
    f.action,
  );
  const native = collectiveNativeToolResult('collective.context.read', result);
  assert.equal(native.content[1].type, 'image');
  assert.equal(result.sourceDigest, attachment.blobDigest);
  assert.deepEqual(Buffer.from(native.content[1].data, 'base64'), bytes);
  assert.equal((await owner.load(attachment.contentRef, 1)).bytes.equals(bytes), true);
  if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
    await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
    await writeFile(
      join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'native-image.json'),
      JSON.stringify(native.content[1]),
    );
  }
  process.stdout.write(
    'F290 native: actual original bytes → fresh public source → real owner decoder → native MCP image block\n',
  );
  assert.ok(
    actions['collective.sticker.prepare'],
    'The named participant needs an authorized catalogue-sticker preparation path',
  );
  assert.equal(current.stickerCatalog.length, 16);
  assert.ok(current.stickerCatalog.every((entry) => !entry.id.includes('invalidated')));
  const prepare = () =>
    actions['collective.sticker.prepare']({ contextRef: current.contextRef, stickerId: 'momo-cheer' }, f.action);
  await assert.rejects(
    actions['collective.sticker.prepare']({ contextRef: 'foreign-context', stickerId: 'momo-cheer' }, f.action),
  );
  await assert.rejects(
    f.store.prepareParticipationSticker(
      f.serviceOwner.sessionToken,
      {
        ...coordinates,
        connectionId: f.source.connectionId,
        eventId: source.eventId,
        catId: f.source.catId,
        participationRevision: f.source.participationRevision,
        clientUploadId: 'not-an-endpoint',
        stickerId: 'momo-cheer',
      },
      new AbortController().signal,
    ),
  );
  const sticker = await prepare();
  assert.deepEqual(await prepare(), sticker);
  assert.equal(sticker.sticker.stickerId, 'momo-cheer');
  const richBlocks = [
    {
      v: 1,
      id: 'native-content',
      kind: 'checklist',
      title: '同一份公开内容',
      items: [{ id: 'seen', text: '已读取原图', checked: true }],
    },
  ];
  const input = {
    returnRef: current.returnRef,
    replyOperationRef: current.replyOperationRef,
    body: '',
    attachments: [sticker],
    richBlocks,
  };
  const accepted = await actions['collective.reply.submit'](input, f.action);
  assert.equal(accepted.reply.status, 'accepted');
  assert.equal((await actions['collective.reply.submit'](input, f.action)).reply.eventId, accepted.reply.eventId);
  const events = await f.store.listEventsForHuman(f.serviceOwner.sessionToken, f.connection.collectiveId);
  const replies = events.filter((event) => event.replyToEventId === source.eventId);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].attachments, [sticker]);
  assert.deepEqual(replies[0].richBlocks, richBlocks);
  assert.ok(events.every((event) => !event.workRequest));
  const opened = await f.store.openMessageAttachment(
    f.serviceOwner.sessionToken,
    { ...coordinates, attachmentId: sticker.attachmentId, sourceEventId: replies[0].eventId },
    new AbortController().signal,
  );
  const chunks = [];
  for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
  assert.equal(`sha256:${createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}`, sticker.blobDigest);
  // Revoke while the actual original Host is reading: no late owner result may escape the fresh source check.
  beforeCatalogReturn = () =>
    f.store.revokeConnection({
      sessionToken: f.serviceOwner.sessionToken,
      collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId,
    });
  await assert.rejects(prepare());
  await assert.rejects(
    actions['collective.context.read'](
      { contextRef: current.contextRef, image: { eventId: source.eventId, attachmentId: attachment.attachmentId } },
      f.action,
    ),
  );
  process.stdout.write(
    'F290 native: original catalogue sticker + rich-only named reply survive retry once; revocation during owner reading withholds its late result\n',
  );
});
