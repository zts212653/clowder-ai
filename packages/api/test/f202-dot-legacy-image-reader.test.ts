import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { DotLegacyImageReader } from '../src/domains/plugin/migration/dot-legacy-image-reader.js';

const id = `dot_img_${'a'.repeat(64)}`;
const url = `/api/plugins/chatgpt-dot/images/${id}.png`;
const metadata = {
  id,
  ownerUserId: 'owner-1',
  threadId: 'thread-1',
  eventId: `dot_evt_${'b'.repeat(64)}`,
  publicationKey: 'publication-1',
  sha256: createHash('sha256').update('image').digest('hex'),
  byteSize: 5,
  width: 1,
  height: 1,
  messageId: 'message-1',
  alt: 'legacy image',
};

function reader(
  overrides: {
    owner?: string;
    galleryUrl?: string;
    media?: boolean;
    migrated?: boolean;
    threadDeletedAt?: number | null;
    messageDeletedAt?: number | null;
    messageOwner?: string;
    messageThreadId?: string;
    messageCatId?: string;
    recall?: unknown;
    deliveryStatus?: string;
    visibility?: string;
    revealedAt?: number | null;
  } = {},
) {
  let mediaReads = 0;
  let sourceReads = 0;
  const value = new DotLegacyImageReader({
    audit: {
      findImage: async () => (overrides.migrated === false ? undefined : { metadata, hmrId: `hmr_${'d'.repeat(32)}` }),
    },
    ledger: {
      openVerifiedStream: async () => {
        mediaReads += 1;
        return overrides.media === false
          ? undefined
          : { stream: Readable.from(Buffer.from('image')), byteLength: 5, mimeType: 'image/png' };
      },
    },
    threads: {
      get: async () =>
        ({
          id: 'thread-1',
          createdBy: overrides.owner ?? 'owner-1',
          deletedAt: overrides.threadDeletedAt ?? null,
        }) as never,
    },
    messages: {
      getById: async () =>
        ({
          id: 'message-1',
          userId: overrides.messageOwner ?? 'owner-1',
          threadId: overrides.messageThreadId ?? 'thread-1',
          catId: overrides.messageCatId ?? 'gpt-dot',
          deletedAt: overrides.messageDeletedAt ?? null,
          recall: overrides.recall,
          deliveryStatus: overrides.deliveryStatus,
          visibility: overrides.visibility,
          revealedAt: overrides.revealedAt,
          extra: {
            rich: {
              v: 1,
              blocks: [
                {
                  id,
                  kind: 'media_gallery',
                  v: 1,
                  items: [{ url: overrides.galleryUrl ?? url, alt: 'legacy image' }],
                },
              ],
            },
          },
        }) as never,
    },
    source: {
      imageMetadata: async () => [metadata],
      imageBytes: async () => {
        sourceReads += 1;
        return Buffer.from('image');
      },
    },
  });
  return { value, mediaReads: () => mediaReads, sourceReads: () => sourceReads };
}

test('serves a migrated legacy image from the Host ledger with original visibility checks', async () => {
  const fixture = reader();
  const result = await fixture.value.readIfMigrated(id, 'owner-1');
  assert.ok(result);
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'image');
  assert.equal(result.asset.id, id);
  assert.equal(fixture.mediaReads(), 1);
});

test('serves an unmigrated legacy image read-only without the obsolete Dot runtime', async () => {
  const fixture = reader({ migrated: false });
  const result = await fixture.value.read(id, 'owner-1');
  assert.equal('bytes' in result && result.bytes.toString(), 'image');
  assert.equal(fixture.sourceReads(), 1);
  assert.equal(fixture.mediaReads(), 0);
});

test('denies another owner or a removed gallery reference before opening retained bytes', async () => {
  for (const [fixture, owner] of [
    [reader(), 'owner-2'],
    [reader({ galleryUrl: '/different.png' }), 'owner-1'],
  ] as const) {
    await assert.rejects(fixture.value.readIfMigrated(id, owner), /access_denied/);
    assert.equal(fixture.mediaReads(), 0);
  }
});

test('denies every legacy message/thread visibility failure before opening retained bytes', async () => {
  const denied = [
    reader({ threadDeletedAt: 1 }),
    reader({ owner: 'owner-2' }),
    reader({ messageDeletedAt: 1 }),
    reader({ recall: { recalledAt: 1 } }),
    reader({ messageOwner: 'owner-2' }),
    reader({ messageThreadId: 'thread-2' }),
    reader({ messageCatId: 'codex' }),
    reader({ deliveryStatus: 'canceled' }),
    reader({ visibility: 'whisper', revealedAt: null }),
  ];
  for (const fixture of denied) {
    await assert.rejects(fixture.value.readIfMigrated(id, 'owner-1'), /access_denied/);
    assert.equal(fixture.mediaReads(), 0);
  }
});
