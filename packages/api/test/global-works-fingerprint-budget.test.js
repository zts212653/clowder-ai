import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readGlobalWorksPage, WorksPageError } from '../dist/domains/cats/services/agents/routing/global-works-page.js';

const owner = 'fingerprint-budget-owner';

// JSON-equivalent input: count full-payload serialization without a wall-time assertion.
function countedJson(value, count) {
  Object.defineProperty(value, 'toJSON', {
    value() {
      count();
      return { ...value };
    },
  });
  return value;
}

function message(id, block, onSerialize) {
  return {
    id,
    threadId: 'T',
    userId: owner,
    catId: 'codex61-sol',
    timestamp: 1000,
    content: '',
    extra: countedJson({ rich: { v: 1, blocks: [block] } }, onSerialize),
  };
}

function fixture(messages, tasks = [], ownedWorks) {
  return {
    userId: owner,
    threads: [{ id: 'T', title: 'Budget', createdBy: owner, createdAt: 1 }],
    messages: {
      async getByThreadBeforeBounded() {
        return { messages, scannedCount: messages.length, storageRoundTrips: 1, exhausted: true };
      },
    },
    tasks: {
      async listByThreadPage(_threadId, _limit, after) {
        const offset = after ? tasks.findIndex((task) => task.id === after) + 1 : 0;
        return { tasks: tasks.slice(offset) };
      },
    },
    accepted: async () => [],
    ...(ownedWorks ? { ownedWorks } : {}),
  };
}

function gallery(count) {
  return {
    kind: 'media_gallery',
    id: 'gallery',
    v: 1,
    items: Array.from({ length: count }, (_, i) => ({ url: `/uploads/budget-${i}.png` })),
  };
}

function task(index, refs, onSerialize) {
  return countedJson(
    {
      id: `task-${index}`,
      kind: 'work',
      userId: owner,
      title: 'Delivery',
      ownerCatId: 'codex61-sol',
      updatedAt: index + 1,
      entrustedWork: {
        artifactRefs: Array.from({ length: refs }, (_, i) => `pr:org/repo#${index * 64 + i + 1}`),
      },
    },
    onSerialize,
  );
}

test('a 128-message empty Works page does not serialize unused cursor payloads', async () => {
  let serialized = 0;
  const rows = Array.from({ length: 128 }, (_, i) =>
    message(`m-${i}`, { kind: 'card', id: `c-${i}`, v: 1, title: 'x'.repeat(8192) }, () => serialized++),
  );
  const page = await readGlobalWorksPage(fixture(rows));
  assert.equal(page.cost.scannedMessages, 128);
  assert.deepEqual(page.artifacts, []);
  assert.equal(page.complete, true);
  assert.equal(serialized, 0, 'no within-message continuation exists to protect');
});

test('a complete gallery still projects every item without serializing a cursor payload', async () => {
  let serialized = 0;
  const page = await readGlobalWorksPage(fixture([message('gallery', gallery(3), () => serialized++)]));
  assert.deepEqual(
    page.artifacts.map((item) => item.url),
    gallery(3).items.map((item) => item.url),
  );
  assert.equal(page.complete, true);
  assert.equal(serialized, 0);
});

test('a split gallery retains an exact fingerprint and rejects a changed source before resuming', async () => {
  let serialized = 0;
  const block = gallery(600);
  const input = fixture([message('gallery', block, () => serialized++)]);
  const first = await readGlobalWorksPage(input);
  assert.equal(first.artifacts.length, 512);
  assert.ok(first.nextCursor);
  const originalUrl = block.items[0].url;
  block.items[0].url = '/uploads/changed.png';
  await assert.rejects(
    readGlobalWorksPage({ ...input, cursor: first.nextCursor }),
    (error) => error instanceof WorksPageError && error.statusCode === 409,
  );
  block.items[0].url = originalUrl;
  const second = await readGlobalWorksPage({ ...input, cursor: first.nextCursor });
  assert.equal(second.complete, true);
  assert.deepEqual(
    [...first.artifacts, ...second.artifacts].map((item) => item.url),
    block.items.map((item) => item.url),
  );
  assert.equal(serialized, 3, 'one new cursor, one rejected validation, one successful validation');
});

test('complete task attachments do not serialize unused task cursor payloads', async () => {
  let serialized = 0;
  const input = fixture([], [task(0, 1, () => serialized++), task(1, 1, () => serialized++)]);
  const page = await readGlobalWorksPage(input);
  assert.deepEqual(
    page.artifacts.map((item) => item.ref),
    ['org/repo#1', 'org/repo#65'],
  );
  assert.equal(page.complete, true);
  assert.equal(serialized, 0);
});

test('a split task fingerprints only the resumed task and rejects changed attachments', async () => {
  let serialized = 0;
  const tasks = Array.from({ length: 8 }, (_, i) => task(i, 64, () => serialized++));
  const input = fixture([], tasks, async () => ({
    artifacts: [{ type: 'file', name: 'Owned', catId: null, createdAt: 1, sourceMessageId: null }],
    snapshot: 'owned-snapshot',
  }));
  const first = await readGlobalWorksPage(input);
  assert.equal(first.artifacts.length, 512);
  assert.ok(first.nextCursor);
  const originalRef = tasks[7].entrustedWork.artifactRefs[0];
  tasks[7].entrustedWork.artifactRefs[0] = 'pr:org/repo#9999';
  await assert.rejects(
    readGlobalWorksPage({ ...input, cursor: first.nextCursor }),
    (error) => error instanceof WorksPageError && error.statusCode === 409,
  );
  tasks[7].entrustedWork.artifactRefs[0] = originalRef;
  const second = await readGlobalWorksPage({ ...input, cursor: first.nextCursor });
  assert.equal(second.complete, true);
  const refs = [...first.artifacts, ...second.artifacts].flatMap((item) => (item.ref ? [item.ref] : []));
  assert.deepEqual(
    refs,
    Array.from({ length: 512 }, (_, i) => `org/repo#${i + 1}`),
  );
  assert.equal(serialized, 3, 'unrelated complete tasks need no continuation fingerprint');
});
