import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { GlobalArtifactWorkLineageResolver } from '../dist/domains/video-studio/content-owner/global-artifact-work-lineage.js';
import { PublishedMediaSource } from '../dist/domains/video-studio/content-owner/published-media-source.js';

const principal = { userId: 'projection-owner', actor: { kind: 'human', actorId: 'projection-owner' } };
const source = {
  kind: 'message',
  threadId: 'projection-thread',
  messageId: 'projection-message',
  messageRevision: '1000',
  item: { kind: 'content-block', index: 0 },
  expectedUrl: '/uploads/projection.png',
};

function fixture(patch = {}, failure) {
  const row = {
    id: source.messageId,
    threadId: source.threadId,
    userId: principal.userId,
    catId: 'codex61-sol',
    from: JSON.stringify({ kind: 'agent', catId: 'codex61-sol' }),
    timestamp: '1000',
    deliveryStatus: 'delivered',
    mentions: '[]',
    content: 'unused body '.repeat(32_768),
    thinking: 'unused thinking '.repeat(8192),
    toolEvents: JSON.stringify([{ id: 'unused', type: 'tool_result', detail: 'x'.repeat(1024 * 1024) }]),
    metadata: JSON.stringify({ diagnostic: 'm'.repeat(128 * 1024) }),
    contentBlocks: JSON.stringify([{ type: 'image', url: source.expectedUrl }]),
    ...patch,
  };
  const reads = { full: 0, selected: [], codeUnits: 0 };
  const account = (value) => {
    reads.codeUnits += Object.values(value).reduce((n, item) => n + (typeof item === 'string' ? item.length : 0), 0);
    return value;
  };
  const redis = {
    options: {},
    async hgetall(key) {
      assert.equal(key, MessageKeys.detail(source.messageId));
      reads.full++;
      return account({ ...row });
    },
    multi() {
      const calls = [];
      return {
        hmget(key, ...fields) {
          assert.equal(key, MessageKeys.detail(source.messageId));
          reads.selected.push(fields);
          calls.push(fields);
          return this;
        },
        async exec() {
          if (failure) return failure();
          return calls.map((fields) => {
            const value = Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
            account(value);
            return [null, fields.map((field) => value[field])];
          });
        },
      };
    },
  };
  const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const makeSource = (messages) => new PublishedMediaSource({ messages, uploadDir: '/tmp', artifacts: {}, access: {} });
  return {
    row,
    reads,
    store,
    publication: makeSource(store),
    fullPublication: makeSource({ getById: (id) => store.getById(id) }),
  };
}

function artifact() {
  return {
    type: 'image',
    name: 'projection.png',
    catId: 'codex61-sol',
    createdAt: 1000,
    sourceMessageId: source.messageId,
    url: source.expectedUrl,
    publicationItem: source.item,
    threadId: source.threadId,
    threadTitle: 'Projection fixture',
  };
}

test('real lineage performs both fresh identity reads without transferring unused message payload', async (t) => {
  const f = fixture();
  const baseline = fixture();
  const resolverFor = (sources) =>
    new GlobalArtifactWorkLineageResolver({
      sources,
      access: { authorizeThread: async () => {} },
      owner: { findSourcePublicationsBatch: async (lookups) => new Map(lookups.map((x) => [x.lookupId, []])) },
      media: {},
    });
  const resolver = resolverFor(f.publication);
  assert.deepEqual(
    await resolverFor(baseline.fullPublication).resolve({ ownerUserId: principal.userId, artifacts: [artifact()] }),
    [undefined],
  );
  assert.deepEqual(await resolver.resolve({ ownerUserId: principal.userId, artifacts: [artifact()] }), [undefined]);
  assert.equal(f.reads.full, 0, 'media identity must not issue HGETALL for unrelated tool/thinking/body fields');
  assert.equal(f.reads.selected.length, 2, 'admission and final source validation must remain separate fresh reads');
  assert.ok(
    f.reads.selected.every(
      (fields) => !fields.some((x) => ['toolEvents', 'thinking', 'metadata', 'content'].includes(x)),
    ),
  );
  assert.ok(f.reads.codeUnits < 4096, 'the synthetic megabyte fields must not cross the selected Redis read');
  assert.equal(baseline.reads.full, 2);
  assert.ok(baseline.reads.codeUnits > 2 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      fullReadCodeUnits: baseline.reads.codeUnits,
      selectedReadCodeUnits: f.reads.codeUnits,
      freshReads: f.reads.selected.length,
    }),
  );
});

test('the selected identity read preserves the full reader visibility and exact publication checks', async (t) => {
  const cases = [
    ['healthy', {}, true],
    ['wrong owner', { userId: 'other' }],
    ['wrong thread', { threadId: 'other-thread' }],
    ['deleted', { deletedAt: '1001' }],
    ['recalled', { recall: JSON.stringify({ version: 1, exposure: 'none', recalledAt: 1001 }) }],
    ['tombstone', { _tombstone: '1' }],
    ['queued', { deliveryStatus: 'queued' }],
    ['briefing', { origin: 'briefing' }],
    ['revision changed', { timestamp: '2000' }],
    ['URL changed', { contentBlocks: JSON.stringify([{ type: 'image', url: '/uploads/other.png' }]) }],
  ];
  for (const [name, patch, healthy] of cases)
    await t.test(name, async () => {
      const baseline = fixture(patch),
        candidate = fixture(patch);
      if (healthy) {
        assert.deepEqual(
          await candidate.publication.messageIdentity(source, principal),
          await baseline.fullPublication.messageIdentity(source, principal),
        );
      } else {
        let error;
        try {
          await baseline.fullPublication.messageIdentity(source, principal);
        } catch (e) {
          error = e;
        }
        assert.ok(error, 'the full reader must reject this authority/publication boundary');
        await assert.rejects(
          candidate.publication.messageIdentity(source, principal),
          (e) => e.constructor === error.constructor && e.code === error.code,
        );
      }
    });
});

test('reusing the source reader does not cache an earlier visible message across reads', async () => {
  const f = fixture();
  const first = await f.publication.messageIdentity(source, principal);
  assert.equal(first.publication.artifactRef, source.expectedUrl);
  f.row.recall = JSON.stringify({ version: 1, exposure: 'none', recalledAt: 1001 });
  await assert.rejects(f.publication.messageIdentity(source, principal), (e) => e.code === 'access_denied');
});

test('unavailable or incomplete selected hydration cannot masquerade as a missing source', async (t) => {
  for (const [name, fail] of [
    ['unavailable', () => null],
    ['incomplete batch', () => []],
    ['incomplete fields', () => [[null, ['projection-message']]]],
  ]) {
    await t.test(name, async () => {
      const f = fixture({}, fail);
      await assert.rejects(f.publication.messageIdentity(source, principal), /hydration/);
      assert.equal(f.reads.full, 0, 'a failed selected read must not fall back to a full read');
    });
  }
});

test('selected rich items retain exact selectors and equal-URL ambiguity counts', async (t) => {
  const blocks = [
    { kind: 'media_gallery', v: 1, id: 'gallery', items: [{ url: source.expectedUrl }, { url: source.expectedUrl }] },
    {
      kind: 'file',
      v: 1,
      id: 'file',
      url: source.expectedUrl,
      fileName: 'projection.png',
      mimeType: 'image/png',
      fileSize: 10,
    },
  ];
  for (const item of [
    { kind: 'media-gallery', blockId: 'gallery', itemIndex: 1 },
    { kind: 'rich-file', blockId: 'file' },
  ]) {
    await t.test(item.kind, async () => {
      const f = fixture({ extra: JSON.stringify({ rich: { v: 1, blocks } }) });
      const selectedSource = { ...source, item };
      const expected = await f.fullPublication.messageIdentity(selectedSource, principal);
      const actual = await f.publication.messageIdentity(selectedSource, principal);
      assert.equal(actual.matchingItemCount, 4, 'one content block plus two gallery items plus one rich file');
      assert.deepEqual(actual, expected);
      blocks[0].items[1].url = '/uploads/changed.png';
      f.row.extra = JSON.stringify({ rich: { v: 1, blocks } });
      if (item.kind === 'media-gallery')
        await assert.rejects(
          f.publication.messageIdentity(selectedSource, principal),
          (e) => e.code === 'publication_changed',
        );
      blocks[0].items[1].url = source.expectedUrl;
    });
  }
});

test('selected whisper admission matches the same full-reader viewer boundary', async (t) => {
  const cat = { ...principal, actor: { kind: 'cat', actorId: 'codex61-sol' } };
  for (const [name, viewer, patch, admitted] of [
    ['human', principal, {}, true],
    ['unlisted cat', cat, {}, false],
    ['recipient cat', cat, { whisperTo: '["codex61-sol"]' }, true],
    ['revealed cat', cat, { revealedAt: '1001' }, true],
  ])
    await t.test(name, async () => {
      const f = fixture({ visibility: 'whisper', whisperTo: '[]', ...patch });
      if (admitted)
        assert.deepEqual(
          await f.publication.messageIdentity(source, viewer),
          await f.fullPublication.messageIdentity(source, viewer),
        );
      else {
        await assert.rejects(f.fullPublication.messageIdentity(source, viewer), (e) => e.code === 'access_denied');
        await assert.rejects(f.publication.messageIdentity(source, viewer), (e) => e.code === 'access_denied');
      }
    });
});

test('a genuinely missing selected row is distinct from an unavailable read', async () => {
  const f = fixture();
  for (const key of Object.keys(f.row)) delete f.row[key];
  assert.equal(await f.store.getArtifactById(source.messageId), null);
  await assert.rejects(f.publication.messageIdentity(source, principal), (e) => e.code === 'access_denied');
  assert.equal(f.reads.full, 0);
});

test('selected transport failure preserves the error and never retries through the full reader', async () => {
  const original = new Error('selected read unavailable');
  const f = fixture({}, () => {
    throw original;
  });
  await assert.rejects(f.publication.messageIdentity(source, principal), (e) => e === original);
  assert.equal(f.reads.full, 0);
});

test('the ordinary message reader still returns its full content and tool payload', async () => {
  const f = fixture();
  const message = await f.store.getById(source.messageId);
  assert.equal(message.content, f.row.content);
  assert.equal(message.toolEvents.length, 1);
  assert.equal(f.reads.full, 1);
  assert.equal(f.reads.selected.length, 0);
});
