import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import pino from 'pino';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { executeMessageSearch } from '../../dist/routes/message-search-handler.js';

for (const phase of ['visibility', 'source-admission', 'retrieval', 'canonical-projection']) {
  test(`timeout preserves the original error and identifies ${phase} without private query/body/identity`, async () => {
    const reason = new DOMException('deadline exceeded', 'TimeoutError');
    const controller = new AbortController();
    const thread = { id: 'thread', createdBy: 'owner', title: 'private-title-canary' };
    const source = { threadId: thread.id, messageId: 'source' };
    const service = new MessageSearchService({
      threadStore: {
        list() {
          if (phase === 'visibility') throw reason;
          return [thread];
        },
        get: () => thread,
      },
      messageStore: {
        getById(id) {
          if (id === 'source' && phase === 'source-admission') controller.abort(reason);
          if (id !== 'source' && phase === 'canonical-projection') throw reason;
          return { id, threadId: thread.id, userId: 'owner', content: 'private-body-canary', timestamp: 1000 };
        },
      },
      evidenceStore: {
        readMessagePassageState: () => ({ current: true }),
        searchMessagePassages() {
          if (phase === 'retrieval') throw reason;
          return {
            passages: [
              {
                threadId: thread.id,
                messageId: 'target',
                docAnchor: 'thread-thread',
                passageId: 'msg-target',
                content: 'private-body-canary',
                match: 'lexical',
              },
            ],
            meta: { candidateLimit: 2000, effectiveMode: 'lexical' },
          };
        },
      },
    });
    await assert.rejects(
      service.search(
        { query: 'private-query-canary' },
        { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' }, source },
        { signal: controller.signal },
      ),
      (error) => {
        assert.equal(error, reason);
        assert.equal(error.messageSearchExecution?.phase, phase);
        assert.ok(error.messageSearchExecution.elapsedMs >= 0);
        assert.deepEqual(
          Object.keys(error.messageSearchExecution.completedPhases),
          ['visibility', 'source-admission', 'retrieval'].slice(
            0,
            ['visibility', 'source-admission', 'retrieval', 'canonical-projection'].indexOf(phase),
          ),
        );
        assert.doesNotMatch(JSON.stringify(error.messageSearchExecution), /private-|owner|codex61/);
        return true;
      },
    );
  });
}

test('scoped system-thread visibility owns a deadline crossed by its final async access lookup', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const thread = { id: 'scoped-system-thread', createdBy: 'system', title: 'private-title-canary' };
  let accessLookups = 0;
  let retrievals = 0;
  const service = new MessageSearchService({
    threadStore: {
      get: () => thread,
      async list(userId) {
        assert.equal(userId, 'private-principal-canary');
        accessLookups++;
        await new Promise((resolve) => setImmediate(resolve));
        now += 20; // Deterministically exhaust the 5ms budget inside the last visibility await.
        return [thread];
      },
    },
    messageStore: {}, // No source: admission must not inherit visibility's elapsed budget.
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages() {
        retrievals++;
        return { passages: [], meta: { candidateLimit: 2000, effectiveMode: 'lexical' } };
      },
    },
  });
  await assert.rejects(
    service.search(
      { query: 'private-query-canary', threadId: thread.id },
      { userId: 'private-principal-canary', viewer: { type: 'cat', catId: 'codex61-sol' } },
      { deadlineAt: now + 5 },
    ),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.messageSearchExecution?.phase, 'visibility');
      assert.deepEqual(error.messageSearchExecution.completedPhases, {});
      assert.doesNotMatch(JSON.stringify(error.messageSearchExecution), /private-|codex61/);
      return true;
    },
  );
  assert.equal(accessLookups, 1);
  assert.equal(retrievals, 0);
});

test('HTTP503 keeps the existing public contract while its normal error log retains phase evidence', async (t) => {
  let logged = '';
  const stream = new Writable({
    write(chunk, _encoding, next) {
      logged += chunk.toString();
      next();
    },
  });
  const app = Fastify({ logger: pino({ level: 'warn' }, stream) });
  t.after(() => app.close());
  const service = new MessageSearchService({
    threadStore: {
      list() {
        throw new DOMException('deadline exceeded', 'TimeoutError');
      },
    },
    messageStore: {},
    evidenceStore: {},
  });
  app.get('/search', (_request, reply) =>
    executeMessageSearch(
      service,
      { query: 'private-query-canary' },
      { userId: 'private-principal-canary', viewer: { type: 'cat', catId: 'codex61-sol' } },
      reply,
    ),
  );
  const response = await app.inject('/search');
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: 'Message search unavailable',
    degraded: true,
    degradeReason: 'message_search_timeout',
  });
  const diagnostic = logged
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.msg === 'Message search unavailable');
  assert.equal(diagnostic.err.messageSearchExecution.phase, 'visibility');
  assert.doesNotMatch(response.body + logged, /private-query|private-principal/);
});
