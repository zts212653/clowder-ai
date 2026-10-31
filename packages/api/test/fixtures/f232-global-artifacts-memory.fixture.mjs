import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Fastify from 'fastify';

const { threadsRoutes } = await import(process.argv[2]);
const threadCatalogue = process.argv[3] === 'thread';
const pageSize = 200;
const totalPages = 32;
const totalMessages = pageSize * totalPages;
let pages = 0;
let peakHeap = 0;

async function readPage(limit, userId, options) {
  assert.equal(limit, pageSize);
  assert.equal(userId, 'alice');
  assert.equal(options.includeQueuedCatMessages, true);
  if (pages === totalPages) return [];
  await nextTurn();
  const start = totalMessages - ++pages * pageSize;
  const messages = Array.from({ length: pageSize }, (_, index) => {
    const eventNo = start + index;
    const payload = Buffer.alloc(64 * 1024, 120);
    payload.write(String(eventNo));
    return {
      id: `m-${eventNo}`,
      catId: 'codex',
      timestamp: eventNo + 1,
      content: payload.toString('utf8'),
      ...(eventNo === 0 || eventNo === totalMessages - 1
        ? {
            extra: {
              rich: {
                blocks: [
                  {
                    kind: 'file',
                    v: 1,
                    id: `b-${eventNo}`,
                    url: `/uploads/${eventNo}.pdf`,
                    fileName: `${eventNo}.pdf`,
                  },
                ],
              },
            },
          }
        : {}),
    };
  });
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  return messages;
}

const app = Fastify();
try {
  await app.register(threadsRoutes, {
    threadStore: {
      get: async () => ({ id: 'T', title: 'Synthetic', createdBy: 'alice' }),
      list: async () => [{ id: 'T', title: 'Synthetic', createdBy: 'alice' }],
      getThreadMemory: async () => null,
    },
    messageStore: {
      getByThread: async (_threadId, limit, userId, options) => readPage(limit, userId, options),
      getByThreadBefore: async (_threadId, timestamp, limit, id, userId, options) => {
        assert.equal(timestamp, totalMessages - pages * pageSize + 1);
        assert.equal(id, `m-${timestamp - 1}`);
        return readPage(limit, userId, options);
      },
    },
    taskStore: { listByThread: async () => [] },
  });
  const response = await app.inject({
    method: 'GET',
    url: threadCatalogue ? '/api/threads/T/artifacts' : '/api/artifacts',
    headers: { 'x-cat-cafe-user': 'alice' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.artifacts.length, 2);
  assert.deepEqual(
    body.artifacts.map((artifact) => artifact.sourceMessageId),
    [`m-${totalMessages - 1}`, 'm-0'],
  );
  assert.equal(pages, totalPages);
  process.stdout.write(
    `${JSON.stringify({ pages, messages: totalMessages, artifacts: body.artifacts.length, peakHeapMiB: peakHeap / 2 ** 20 })}\n`,
  );
} finally {
  await app.close();
}
