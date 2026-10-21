import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { withBallCustodyTaskEvents } from '../src/domains/ball-custody/BallCustodyTaskStore.js';
import { readGlobalWorksPage, WorksPageError } from '../src/domains/cats/services/agents/routing/global-works-page.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { threadsRoutes } from '../src/routes/threads.js';

const owner = 'works-page-owner';
const headers = { 'x-cat-cafe-user': owner };

test('owner works are paged even when no message or Task ever published them', async () => {
  const artifact = {
    type: 'video' as const,
    name: '独立保存的片子',
    catId: 'codex61-sol',
    createdAt: 1,
    sourceMessageId: null,
    work: { contentRef: `work:${'b'.repeat(64)}`, ownerRevision: 2, currentOwnerRevision: 2 },
  };
  const input = {
    userId: owner,
    threads: [{ id: 'T', createdBy: owner }],
    tasks: { listByThreadPage: async () => ({ tasks: [] }) },
    messages: {
      getByThreadBeforeBounded: async () => ({ messages: [], scannedCount: 0, storageRoundTrips: 1, exhausted: true }),
    },
    accepted: async () => [],
    ownedWorks: async (_threadId: string, after?: string, snapshot?: string) => {
      if (after) {
        assert.equal(after, 'next-work');
        assert.equal(snapshot, 'owner-snapshot');
        return { artifacts: [{ ...artifact, name: '第二件', ref: 'second' }], snapshot: 'owner-snapshot' };
      }
      return { artifacts: [artifact], nextCursor: 'next-work', snapshot: 'owner-snapshot' };
    },
  };
  const first = await readGlobalWorksPage(input);
  assert.equal(first.artifacts[0]?.name, artifact.name);
  assert.equal(first.complete, false);
  const second = await readGlobalWorksPage({ ...input, cursor: first.nextCursor });
  assert.equal(second.artifacts[0]?.name, '第二件');
  assert.equal(second.complete, true);
});

test('cursor positions cannot retain revoked thread access, and failed source reads never become an empty success', async () => {
  const input = {
    userId: owner,
    threads: [{ id: 'T', createdBy: owner }],
    tasks: { listByThreadPage: async () => ({ tasks: [] }) },
    messages: {
      getByThreadBeforeBounded: async () => ({
        messages: [],
        scannedCount: 128,
        storageRoundTrips: 1,
        exhausted: false,
        nextCursor: { timestamp: 1, id: 'older' },
      }),
    },
    accepted: async () => [],
  };
  const first = await readGlobalWorksPage(input);
  assert.equal(first.complete, false);
  assert.ok(first.nextCursor);
  await assert.rejects(
    readGlobalWorksPage({ ...input, cursor: first.nextCursor, threads: [] }),
    (error) => error instanceof WorksPageError && error.statusCode === 409,
  );
  await assert.rejects(
    readGlobalWorksPage({ ...input, cursor: first.nextCursor, userId: 'another-owner' }),
    (error) => error instanceof WorksPageError && error.statusCode === 400,
  );
  await assert.rejects(
    readGlobalWorksPage({
      ...input,
      messages: {
        getByThreadBeforeBounded: async () => {
          throw new Error('storage unavailable');
        },
      },
    }),
    /storage unavailable/,
  );
});

test('many PR attachments in one task page resume within the 512-candidate budget without dropping formal attachments', async () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({
    id: `task-${i}`,
    kind: 'work',
    userId: owner,
    title: 'Accepted delivery',
    ownerCatId: 'codex61-sol',
    updatedAt: i,
    entrustedWork: { artifactRefs: Array.from({ length: 64 }, (_, j) => `pr:org/repo#${i * 64 + j + 1}`) },
  }));
  const input = {
    userId: owner,
    threads: [{ id: 'T', createdBy: owner }],
    tasks: {
      listByThreadPage: async (_thread, _limit, afterId) => ({
        tasks: tasks.slice(afterId ? tasks.findIndex((t) => t.id === afterId) + 1 : 0),
      }),
    },
    messages: {
      getByThreadBeforeBounded: async () => ({ messages: [], scannedCount: 0, storageRoundTrips: 0, exhausted: true }),
    },
    accepted: async () => [],
  };
  const refs = new Set<string>();
  let cursor: string | undefined;
  for (let request = 0; request < 4; request++) {
    const page = await readGlobalWorksPage({ ...input, cursor });
    assert.ok(page.artifacts.length <= 512);
    page.artifacts.forEach((row) => {
      assert.ok(!refs.has(row.ref));
      refs.add(row.ref);
    });
    cursor = page.nextCursor;
    if (!cursor) {
      assert.equal(page.complete, true);
      break;
    }
  }
  assert.equal(refs.size, 1280);
});

test('global Works yields a bounded page before scanning long history, then resumes without losing older works', async () => {
  const app = Fastify();
  const messageStore = new MessageStore();
  for (let i = 0; i < 700; i++) {
    messageStore.append({
      userId: owner,
      from: { kind: 'agent', catId: createCatId('codex61-sol') },
      threadId: 'T',
      timestamp: i + 1,
      content: '',
      mentions: [],
      extra: {
        rich: { v: 1, blocks: [{ kind: 'file', v: 1, id: `f-${i}`, url: `/uploads/${i}.pdf`, fileName: `${i}.pdf` }] },
      },
    });
  }
  const readPage = messageStore.getByThreadBeforeBounded.bind(messageStore);
  let rawReads = 0;
  let custodyEvents = 0;
  const tasks = new TaskStore();
  tasks.listByThreadPage = () => ({ tasks: [], scannedCount: 0 });
  tasks.listByThread = () => assert.fail('unbounded task read');
  await app.register(threadsRoutes, {
    threadStore: { list: async () => [{ id: 'T', title: 'Long history', createdBy: owner }] },
    messageStore: Object.assign(messageStore, {
      getByThread: () => assert.fail('paged Works must not start an unbounded visible-message refill'),
      getByThreadBeforeBounded: (...args: Parameters<MessageStore['getByThreadBeforeBounded']>) => {
        assert.equal(args[4], owner);
        assert.ok(args[2] <= 128 && args[5] <= 128);
        const page = readPage(...args);
        rawReads += page.scannedCount;
        return page;
      },
    }),
    taskStore: withBallCustodyTaskEvents(tasks, {
      record: async () => {
        custodyEvents += 1;
      },
    }),
    artifactWorkLineage: { current: { resolve: async ({ artifacts }) => artifacts.map(() => undefined) } },
  });
  try {
    let cursor: string | undefined;
    const seen = new Set<string>();
    let complete = false;
    let requests = 0;
    do {
      const before = rawReads;
      const response = await app.inject({
        method: 'GET',
        url: `/api/artifacts?view=works&read=pages${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.ok(rawReads - before <= 128, 'one HTTP request must not scan the whole 700-message history');
      for (const artifact of body.artifacts) {
        assert.ok(!seen.has(artifact.sourceMessageId), 'continuation must not duplicate publication coordinates');
        seen.add(artifact.sourceMessageId);
      }
      cursor = body.nextCursor;
      complete = body.complete;
      if (requests++ === 0) assert.equal(complete, false, 'the first batch cannot claim the global total is complete');
      assert.ok(requests < 15, 'cursor must make progress');
    } while (cursor);
    assert.equal(complete, true);
    assert.equal(seen.size, 700);
    assert.equal(custodyEvents, 0, 'catalogue reads must not emit custody events');
  } finally {
    await app.close();
  }
});
