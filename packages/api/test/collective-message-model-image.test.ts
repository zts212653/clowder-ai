import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MESSAGE_STICKER_CATALOG, messageStickerReference } from '@cat-cafe/shared';
import sharp from 'sharp';
import { createCollectiveMessageAttachmentOwner } from '../src/domains/collaborative-content/collective-artifact/message-attachment-owner.js';
import { createCollectiveArtifactOwnerProxy } from '../src/domains/plugin/host-surface/collective-artifact-owner.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

async function fixture(stickerDirectories?: { memory: string; collaboration: string }) {
  const root = await mkdtemp(join(tmpdir(), 'collective-model-image-'));
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'content') });
  let active = true;
  const scope = {
    serviceInstanceId: 'svc_service01',
    collectiveId: 'col_collective01',
    humanId: 'human_remote01',
    channelId: 'general',
    attachmentId: 'att_screenshot01',
  };
  const authority = {
    async reauthorize() {
      assert.ok(active, 'membership revoked');
      return scope;
    },
  };
  const upstream = {
    attachments: createCollectiveMessageAttachmentOwner(owner, { stickerDirectories }),
    async execute() {
      return { status: 'error' as const, error: { code: 'unsupported_operation' as const } };
    },
  };
  const proxy = createCollectiveArtifactOwnerProxy({ owner: () => upstream, assertCurrent: async () => {} });
  const port = proxy.attachments;
  assert.ok(port);
  const signal = new AbortController().signal;
  const retain = (bytes: Buffer, mediaType = 'image/png') =>
    port.retain(
      {
        scope,
        bytes,
        mediaType,
        fileName: 'diagram.png',
        blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
      authority,
      signal,
    );
  return {
    root,
    owner,
    scope,
    authority,
    upstream,
    port,
    signal,
    retain,
    revoke() {
      active = false;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('a named participant receives actual image pixels through the original attachment custody seam', async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 40, height: 24, channels: 3, background: '#de651c' } })
      .png()
      .toBuffer();
    const attachment = await f.retain(bytes);
    assert.ok(f.port.modelImage, 'The Host must provide pixels, not an attachment URL or a JSON-only image claim');
    const image = await f.port.modelImage({ scope: f.scope, attachment }, f.authority, f.signal);
    assert.equal(image.sourceDigest, attachment.blobDigest);
    assert.equal(image.attachmentId, attachment.attachmentId);
    assert.deepEqual(Buffer.from(image.dataBase64, 'base64'), bytes);
    assert.deepEqual([image.width, image.height, image.transformed], [40, 24, false]);
    assert.equal((await sharp(Buffer.from(image.dataBase64, 'base64')).raw().toBuffer())[0], 222);
    const restarted = new ProjectContentOwnerService({ dataDir: join(f.root, 'content') });
    assert.deepEqual((await restarted.load(attachment.contentRef, 1)).bytes, bytes);
  } finally {
    await f.close();
  }
});

test('the original Host supplies member-authorized catalogue pixels and retains a selected sticker as an ordinary image', async () => {
  const f = await fixture({
    memory: fileURLToPath(new URL('../../web/public/f321/stickers/', import.meta.url)),
    collaboration: fileURLToPath(
      new URL('../../../docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/', import.meta.url),
    ),
  });
  try {
    const entry = MESSAGE_STICKER_CATALOG[0];
    const { attachmentId: _attachmentId, ...scope } = f.scope;
    const auth = {
      async reauthorize() {
        await f.authority.reauthorize();
        return scope;
      },
    };
    assert.ok(
      f.port.catalogImage,
      'The package carries shared catalogue metadata; the original Host retains its artwork',
    );
    const image = await f.port.catalogImage({ scope, stickerId: entry.id }, auth, f.signal);
    const chunks: Buffer[] = [];
    for await (const chunk of image.body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const sticker = messageStickerReference(entry.id);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, sticker.blobDigest);
    const attachment = await f.port.retain(
      {
        scope: f.scope,
        bytes,
        fileName: `${entry.id}.png`,
        mediaType: 'image/png',
        blobDigest: sticker.blobDigest,
        sticker,
      },
      f.authority,
      f.signal,
    );
    assert.deepEqual(attachment.sticker, sticker);
    assert.ok(f.port.modelImage);
    assert.deepEqual(
      Buffer.from(
        (await f.port.modelImage({ scope: f.scope, attachment }, f.authority, f.signal)).dataBase64,
        'base64',
      ),
      bytes,
    );
    f.revoke();
    await assert.rejects(f.port.catalogImage({ scope, stickerId: entry.id }, auth, f.signal), /revoked/);
  } finally {
    await f.close();
  }
});

test('a large original yields a bounded native model image without changing retained bytes', async () => {
  const f = await fixture();
  try {
    const bytes = await sharp(randomBytes(2000 * 1500 * 3), { raw: { width: 2000, height: 1500, channels: 3 } })
      .png()
      .toBuffer();
    const attachment = await f.retain(bytes);
    assert.ok(f.port.modelImage);
    const image = await f.port.modelImage({ scope: f.scope, attachment }, f.authority, f.signal);
    const view = Buffer.from(image.dataBase64, 'base64');
    assert.ok(
      view.byteLength <= 512 * 1024,
      'Base64 plus the native action envelope must fit the existing 1 MiB frame',
    );
    assert.ok(image.width <= 1536 && image.height <= 1536);
    assert.equal(image.transformed, true);
    assert.equal(image.sourceDigest, attachment.blobDigest);
    assert.equal(image.mediaType, 'image/jpeg');
    assert.deepEqual((await f.owner.load(attachment.contentRef, 1)).bytes, bytes);
    const decoded = await sharp(view).metadata();
    assert.deepEqual([decoded.width, decoded.height], [image.width, image.height]);
  } finally {
    await f.close();
  }
});

test('model images retain scope, declared type, abort and fresh membership checks', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('not pixels despite an image file name');
    const attachment = await f.retain(bytes);
    assert.ok(f.port.modelImage);
    await assert.rejects(f.port.modelImage({ scope: f.scope, attachment }, f.authority, f.signal));
    await assert.rejects(
      f.port.modelImage({ scope: { ...f.scope, humanId: 'human_foreign01' }, attachment }, f.authority, f.signal),
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(f.port.modelImage({ scope: f.scope, attachment }, f.authority, abort.signal));
    f.revoke();
    await assert.rejects(f.port.modelImage({ scope: f.scope, attachment }, f.authority, f.signal), /revoked/);
  } finally {
    await f.close();
  }
});

test('a real PNG cannot be exposed under a forged JPEG declaration', async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#de651c' } })
      .png()
      .toBuffer();
    const attachment = await f.retain(bytes, 'image/jpeg');
    assert.ok(f.port.modelImage);
    await assert.rejects(f.port.modelImage({ scope: f.scope, attachment }, f.authority, f.signal), /declared type/);
  } finally {
    await f.close();
  }
});

test('the module proxy withholds pixels when membership changes while the owner finishes rendering', async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#de651c' } })
      .png()
      .toBuffer();
    const attachment = await f.retain(bytes);
    assert.ok(f.upstream.attachments.modelImage);
    const render = f.upstream.attachments.modelImage;
    f.upstream.attachments.modelImage = async (...args) => {
      const result = await render(...args);
      f.revoke();
      return result;
    };
    assert.ok(f.port.modelImage);
    await assert.rejects(f.port.modelImage({ scope: f.scope, attachment }, f.authority, f.signal), /revoked/);
  } finally {
    await f.close();
  }
});
