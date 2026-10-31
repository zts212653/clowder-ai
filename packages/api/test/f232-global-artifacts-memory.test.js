import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');

test('GET /api/artifacts bounds global thread reads while preserving all owner artifacts and equal-time order', async () => {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    id: `T${index}`,
    title: `Thread ${index}`,
    createdBy: 'alice',
  }));
  let activeReads = 0;
  let peakReads = 0;
  const app = Fastify();
  try {
    await app.register(threadsRoutes, {
      threadStore: { list: async () => threads, getThreadMemory: async () => null },
      messageStore: {
        getByThread: async (threadId, limit, userId, options) => {
          assert.equal(limit, 200);
          assert.equal(userId, 'alice');
          assert.equal(options.includeQueuedCatMessages, true);
          peakReads = Math.max(peakReads, ++activeReads);
          try {
            await delay(10);
            return [
              {
                id: `m-${threadId}`,
                catId: 'codex',
                timestamp: 100,
                extra: {
                  rich: {
                    blocks: [
                      {
                        kind: 'file',
                        v: 1,
                        id: `b-${threadId}`,
                        url: `/uploads/${threadId}.pdf`,
                        fileName: `${threadId}.pdf`,
                      },
                    ],
                  },
                },
              },
            ];
          } finally {
            activeReads -= 1;
          }
        },
        getByThreadBefore: async () => assert.fail('a partial first page needs no older-page read'),
      },
      taskStore: {
        listByThread: async () => [
          {
            kind: 'pr_tracking',
            userId: 'bob',
            subjectKey: 'pr:o/r#private',
            title: 'private',
            ownerCatId: 'codex',
            updatedAt: 100,
          },
        ],
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/artifacts',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.total, threads.length);
    assert.deepEqual(
      body.artifacts.map((artifact) => artifact.threadId),
      threads.map((thread) => thread.id),
    );
    assert.ok(
      body.artifacts.every((artifact) => artifact.type === 'file'),
      'foreign-owner PRs stay private',
    );
    assert.ok(peakReads <= 4, `global reads must be bounded; observed ${peakReads}`);
    assert.equal(activeReads, 0);
  } finally {
    await app.close();
  }
});

for (const catalogue of ['global', 'thread'])
  test(`${catalogue} artifacts scan all historical pages without retaining unrelated raw message content`, (t) => {
    const run = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=256',
        fileURLToPath(new URL('./fixtures/f232-global-artifacts-memory.fixture.mjs', import.meta.url)),
        new URL('../dist/routes/threads.js', import.meta.url).href,
        catalogue,
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' } },
    );
    assert.equal(run.status, 0, `bounded child failed (${run.signal ?? run.error?.message ?? 'exit'}): ${run.stderr}`);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.pages, 32);
    assert.equal(result.messages, 6400);
    assert.equal(result.artifacts, 2, 'both the oldest and newest artifact must survive the complete scan');
    t.diagnostic(`synthetic history scan: ${JSON.stringify(result)}`);
  });

test('paged artifact projection exactly preserves legacy equal-time ref ties, ledger precedence and publication indices', async () => {
  const {
    aggregateProjectedThreadArtifacts,
    aggregateThreadArtifacts,
    collectAllThreadMessages,
    collectThreadMessageArtifacts,
  } = await import('../dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const store = new MessageStore();
  const timestamp = Date.now();
  const records = [];
  for (let index = 0; index < 410; index += 1) {
    const blocks = [];
    if (index === 100 || index === 300) {
      for (const filePath of ['src/shared.ts', 'src/message-only.ts']) {
        blocks.push({ kind: 'diff', v: 1, id: `diff-${index}-${filePath}`, filePath, hunks: [] });
      }
    }
    if (index === 50 || index === 350) {
      blocks.push({
        kind: 'html_widget',
        v: 1,
        id: `widget-${index}`,
        title: `page-widget-${index}`,
        html: 'unused HTML',
      });
    }
    records.push(
      store.append({
        userId: 'alice',
        from: { kind: 'agent', catId: 'opus-48' },
        threadId: 'T',
        content: `unused-content-${index}`,
        mentions: [],
        timestamp,
        extra: { rich: { blocks } },
        ...(index === 0
          ? {
              contentBlocks: [
                { type: 'text', text: 'not an artifact' },
                { type: 'image', url: '/uploads/image.png' },
                { type: 'file', url: '/uploads/file.pdf', fileName: 'file.pdf', mimeType: 'application/pdf' },
              ],
            }
          : {}),
      }),
    );
  }
  const privateRecord = store.append({
    userId: 'bob',
    from: { kind: 'agent', catId: 'opus-48' },
    threadId: 'T',
    content: 'private',
    mentions: [],
    timestamp,
    extra: {
      rich: { blocks: [{ kind: 'file', v: 1, id: 'private', fileName: 'private.pdf', url: '/uploads/private.pdf' }] },
    },
  });
  const prTasks = [
    { subjectKey: 'pr:src/shared.ts', title: 'PR', ownerCatId: 'codex', updatedAt: timestamp, status: 'open' },
  ];
  const fileLedger = [{ ref: 'src/shared.ts', label: 'ledger-winner.ts', updatedBy: 'codex', updatedAt: timestamp }];
  const expected = aggregateThreadArtifacts({
    messages: await collectAllThreadMessages(store, 'T', 'alice'),
    prTasks,
    fileLedger,
  });
  const messageArtifacts = await collectThreadMessageArtifacts(store, 'T', 'alice');
  const actual = aggregateProjectedThreadArtifacts({ messageArtifacts, prTasks, fileLedger });
  assert.deepEqual(actual, expected);
  assert.equal(actual.find((artifact) => artifact.ref === 'src/shared.ts').name, 'ledger-winner.ts');
  assert.equal(actual.find((artifact) => artifact.ref === 'src/message-only.ts').sourceMessageId, records[100].id);
  assert.deepEqual(
    actual.filter((artifact) => artifact.type === 'widget').map((artifact) => artifact.name),
    ['page-widget-350', 'page-widget-50'],
  );
  assert.deepEqual(
    actual
      .filter((artifact) => artifact.publicationItem?.kind === 'content-block')
      .map((artifact) => artifact.publicationItem.index),
    [1, 2],
  );
  assert.ok(actual.every((artifact) => artifact.sourceMessageId !== privateRecord.id));
  assert.ok(
    messageArtifacts.every(
      (artifact) => !('content' in artifact) && !('contentBlocks' in artifact) && !('extra' in artifact),
    ),
  );
});

test('paged artifact projection preserves galleries larger than the JavaScript argument limit without a cap', async () => {
  const { aggregateThreadArtifacts, collectThreadMessageArtifacts } = await import(
    '../dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js'
  );
  const { isValidRichBlock } = await import('@cat-cafe/shared');
  for (const itemCounts of [Array.from({ length: 200 }, () => 1000), [200_000]]) {
    const messages = itemCounts.map((itemCount, messageIndex) => ({
      id: `gallery-${messageIndex}`,
      catId: 'codex',
      timestamp: messageIndex + 1,
      extra: {
        rich: {
          blocks: [
            {
              kind: 'media_gallery',
              v: 1,
              id: `gallery-block-${messageIndex}`,
              items: Array.from({ length: itemCount }, (_, itemIndex) => ({
                url: `/uploads/${messageIndex}/${itemIndex}.png`,
              })),
            },
          ],
        },
      },
    }));
    assert.ok(messages.every((message) => isValidRichBlock(message.extra.rich.blocks[0])));
    const legacy = aggregateThreadArtifacts({ messages, prTasks: [], fileLedger: [] });
    assert.equal(legacy.length, 200_000, 'full aggregation must accept the entire legal gallery');
    const projected = await collectThreadMessageArtifacts(
      { getByThread: async () => messages, getByThreadBefore: async () => [] },
      'T',
      'alice',
    );
    assert.equal(projected.length, legacy.length);
    assert.deepEqual(projected[0].publicationItem, { kind: 'media-gallery', blockId: 'gallery-block-0', itemIndex: 0 });
    assert.deepEqual(projected.at(-1).publicationItem, {
      kind: 'media-gallery',
      blockId: `gallery-block-${messages.length - 1}`,
      itemIndex: itemCounts.at(-1) - 1,
    });
  }
});
