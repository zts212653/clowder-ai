import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { WorkCatalogue } from '../dist/domains/collaborative-content/works/catalogue.js';
import { MediaOwnerError } from '../dist/domains/video-studio/content-owner/media-errors.js';
import { threadsRoutes } from '../dist/routes/threads.js';
import { workCatalogueFixture } from './helpers/work-catalogue-fixture.js';

const actor = { kind: 'cat', actorId: 'codex61-sol' };
const caller = (threadId = 'owned', userId = 'owner') => ({ userId, threadId, actor });

async function realApp(
  t,
  f,
  messages = new MessageStore(),
  resolver = async ({ artifacts }) => artifacts.map((item) => item.work),
) {
  const app = Fastify();
  t.after(() => app.close());
  const threads = [
    { id: 'owned', createdBy: 'owner', title: 'Original conversation' },
    { id: 'other', createdBy: 'owner', title: 'Other' },
  ];
  await app.register(threadsRoutes, {
    threadStore: {
      list: async () => threads,
      get: async (id) => threads.find((item) => item.id === id),
      getThreadMemory: async () => null,
    },
    messageStore: messages,
    taskStore: { listByThread: async () => [] },
    artifactWorkLineage: {
      independent: new WorkCatalogue(f.service),
      current: { resolve: resolver },
    },
  });
  return app;
}

test('real silent saves and a new version survive the 512 raw-message window within physical read budgets', async (t) => {
  const f = await workCatalogueFixture(t);
  const first = await f.service.commit(f.command('old-video'), caller());
  for (let i = 0; i < 20; i++) await f.service.commit(f.command(`film-${i}`), caller(i % 2 ? 'owned' : 'other'));
  await f.service.commit(f.command('hidden-thread'), caller('not-in-owner-thread-map'));
  await f.service.commit(f.command('foreign'), caller('owned', 'foreign'));
  const messages = new MessageStore();
  messages.append({
    userId: 'owner',
    threadId: 'owned',
    from: { kind: 'agent', catId: 'codex61-sol' },
    mentions: [],
    content: 'old publication',
    timestamp: 1,
    extra: {
      rich: { v: 1, blocks: [{ kind: 'file', v: 1, id: 'old', fileName: 'old.pdf', url: '/uploads/old.pdf' }] },
    },
  });
  for (let i = 0; i < 700; i++)
    messages.append({
      userId: 'owner',
      threadId: 'owned',
      from: { kind: 'agent', catId: 'codex61-sol' },
      mentions: [],
      content: 'ordinary text',
      timestamp: 100 + i,
    });
  const app = await realApp(t, f, messages);
  const headers = { 'x-cat-cafe-user': 'owner' };
  const counter = f.countReads();
  let response = await app.inject({ url: '/api/artifacts?view=recent-works&limit=12', headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().artifacts.length, 12);
  assert.ok(
    response
      .json()
      .artifacts.every((item) => item.sourceMessageId === null && ['owned', 'other'].includes(item.threadId)),
  );
  assert.equal(response.json().complete, false, 'the raw-message ceiling is still an honest partial source');
  assert.ok(counter.stats().stateReads <= 2 * 23 + 3 * 12, JSON.stringify(counter.stats()));
  t.diagnostic(JSON.stringify({ recentLimit: 12, ...counter.stats() }));
  const revised = await f.service.commit(
    { ...f.command('new-version'), action: 'submit', contentRef: first.reference.contentRef, expectedOwnerRevision: 1 },
    caller(),
  );
  counter.reset();
  response = await app.inject({ url: '/api/artifacts?view=recent-works&limit=3', headers });
  assert.equal(response.statusCode, 200, response.body);
  const updated = response.json().artifacts.find((item) => item.ref === revised.reference.contentRef);
  assert.equal(updated?.name, 'Film new-version');
  assert.equal(updated?.work.ownerRevision, 2);
  assert.equal(updated?.sourceMessageId, null);
  assert.ok(counter.stats().stateReads <= 2 * 23 + 3 * 3, JSON.stringify(counter.stats()));
  t.diagnostic(JSON.stringify({ recentLimit: 3, ...counter.stats() }));
});

test('recent owner discovery skips denied scopes and does not reinterpret unavailable manifests as complete', async (t) => {
  const f = await workCatalogueFixture(t);
  await f.service.commit(f.command('visible'), caller());
  await f.service.commit(f.command('denied'), caller('other'));
  f.setAuthorize(async ({ principal, scope }) => {
    if (principal.userId !== 'owner' || scope?.threadId === 'other') throw new MediaOwnerError('access_denied');
  });
  const messages = new MessageStore();
  messages.append({
    userId: 'owner',
    threadId: 'owned',
    from: { kind: 'agent', catId: 'codex61-sol' },
    mentions: [],
    content: 'guide',
    timestamp: Date.now(),
    extra: {
      rich: { v: 1, blocks: [{ kind: 'file', v: 1, id: 'guide', fileName: 'guide.pdf', url: '/uploads/guide.pdf' }] },
    },
  });
  const app = await realApp(t, f, messages);
  const headers = { 'x-cat-cafe-user': 'owner' };
  let response = await app.inject({ url: '/api/artifacts?view=recent-works&limit=12', headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response
      .json()
      .artifacts.map((item) => item.name)
      .sort(),
    ['Film visible', 'guide.pdf'],
  );
  f.owner.retainedMediaHeads = async function* () {
    throw new Error('unavailable canonical directory');
  };
  response = await app.inject({ url: '/api/artifacts?view=recent-works&limit=12', headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().artifacts.map((item) => item.name),
    ['guide.pdf'],
  );
  assert.equal(response.json().complete, false);
});

test('recent HTTP includes an independent saved Work without a rich message', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(threadsRoutes, {
    threadStore: {
      list: async () => [{ id: 'owned', createdBy: 'owner', title: 'Original conversation' }],
      get: async () => ({ id: 'owned', createdBy: 'owner' }),
      getThreadMemory: async () => null,
    },
    messageStore: new MessageStore(),
    taskStore: { listByThread: async () => [] },
    artifactWorkLineage: {
      current: { resolve: async ({ artifacts }) => artifacts.map((item) => item.work) },
      independent: {
        readRecent: async () => ({
          artifacts: [
            {
              type: 'video',
              name: 'Saved without a message',
              catId: 'codex61-sol',
              createdAt: 1792652262392,
              sourceMessageId: null,
              threadId: 'owned',
              threadTitle: 'Original conversation',
              ref: 'work:silent',
              work: { contentRef: 'work:silent', ownerRevision: 2, currentOwnerRevision: 2 },
              url: '/api/content-publications/work%3Asilent/media/2',
            },
          ],
          complete: true,
        }),
        readThread: async () => {
          throw new Error('recent read must not scan every thread');
        },
      },
    },
  });
  const response = await app.inject({
    url: '/api/artifacts?view=recent-works&limit=3',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().artifacts.map((item) => item.name),
    ['Saved without a message'],
  );
});

test('canonical Work saves invalidate the owner projection after create and revision, never after denied admission', async (t) => {
  const events = [];
  const f = await workCatalogueFixture(t, { changed: (owner) => events.push(owner) });
  const first = await f.service.commit(f.command('notify-create'), caller());
  await f.service.commit(
    {
      ...f.command('notify-revision'),
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
    },
    caller(),
  );
  assert.deepEqual(events, ['owner', 'owner']);
  f.setAuthorize(async () => {
    throw new MediaOwnerError('access_denied');
  });
  await assert.rejects(f.service.commit(f.command('denied-create'), caller()), /access_denied/);
  assert.deepEqual(events, ['owner', 'owner']);
});

test('recent selection participates in the original final manifest validation, including canonical commit time', async (t) => {
  const f = await workCatalogueFixture(t);
  await f.service.commit(f.command('fixed-version'), caller());
  const original = f.owner.retainedMediaHeads.bind(f.owner);
  let walks = 0;
  f.owner.retainedMediaHeads = async function* (owner) {
    const final = ++walks === 2;
    for await (const head of original(owner)) yield final ? { ...head, committedAt: '2026-10-23T00:00:00.000Z' } : head;
  };
  const catalogue = new WorkCatalogue(f.service);
  await assert.rejects(
    catalogue.withRead('owner', (reader) =>
      reader.readRecent({ ownerUserId: 'owner', threadTitles: new Map([['owned', 'Original']]), limit: 3 }),
    ),
    /publication_changed/,
  );
});

test('a failed selected recent version joins other admitted reads before closing its request scope', async (t) => {
  const f = await workCatalogueFixture(t);
  await f.service.commit(f.command('one'), caller());
  await f.service.commit(f.command('two'), caller());
  const originalRead = f.service.read.bind(f.service);
  const originalScope = f.service.withCatalogueRead.bind(f.service);
  let inFlight = 0,
    closeInFlight = null,
    started = 0,
    signalStarted,
    release;
  const bothStarted = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  f.service.read = async (...args) => {
    inFlight++;
    const index = ++started;
    if (started === 2) signalStarted();
    try {
      if (index === 1) throw new Error('selected source unavailable');
      await delayed;
      return await originalRead(...args);
    } finally {
      inFlight--;
    }
  };
  f.service.withCatalogueRead = (owner, consume) =>
    originalScope(owner, async (reader) => {
      try {
        return await consume(reader);
      } finally {
        closeInFlight = inFlight;
      }
    });
  const catalogue = new WorkCatalogue(f.service);
  const pending = catalogue
    .withRead('owner', (reader) =>
      reader.readRecent({ ownerUserId: 'owner', threadTitles: new Map([['owned', 'Original']]), limit: 3 }),
    )
    .then(
      () => null,
      (error) => error,
    );
  await bothStarted;
  // One event-loop turn drains failure microtasks before the delayed source is allowed to finish.
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.match(String(await pending), /selected source unavailable/);
  assert.equal(closeInFlight, 0, 'the request scope must not close around still-running selected reads');
});

test('an older message alias cannot displace a higher independent owner revision even with a later message timestamp', async (t) => {
  const f = await workCatalogueFixture(t);
  const first = await f.service.commit(f.command('original'), caller());
  const revised = await f.service.commit(
    {
      ...f.command('current-revision'),
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
    },
    caller(),
  );
  const messages = new MessageStore();
  const alias = messages.append({
    userId: 'owner',
    threadId: 'owned',
    from: { kind: 'agent', catId: 'codex61-sol' },
    mentions: [],
    content: 'late old version reference',
    timestamp: Date.now() + 10000,
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            kind: 'file',
            v: 1,
            id: 'old-version',
            fileName: 'stale.mp4',
            url: '/uploads/stale.mp4',
            mimeType: 'video/mp4',
          },
        ],
      },
    },
  });
  const app = await realApp(t, f, messages, async ({ artifacts }) =>
    artifacts.map((item) =>
      item.sourceMessageId === alias.id ? { ...first.reference, currentOwnerRevision: 2 } : item.work,
    ),
  );
  const response = await app.inject({
    url: '/api/artifacts?view=recent-works&limit=1',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().artifacts.length, 1);
  assert.equal(response.json().artifacts[0].work.ownerRevision, revised.reference.ownerRevision);
  assert.equal(response.json().artifacts[0].name, 'Film current-revision');
});
