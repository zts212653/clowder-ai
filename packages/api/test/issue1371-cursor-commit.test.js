import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { cursorHarness, deferred } from './helpers/issue1371-cursor-harness.js';

for (const [name, route] of [
  ['parallel', routeParallel],
  ['serial', routeSerial],
]) {
  for (const output of ['text', 'tool']) {
    test(`#1371: ${name} ${output} commits immutable boundary before exposing target done`, async () => {
      const fixture = await cursorHarness({
        opus: {
          supportsToolExecutionPolicy: () => true,
          async *invoke() {
            if (output === 'text') yield { type: 'text', catId: 'opus', content: 'answer', timestamp: Date.now() };
            else
              yield {
                type: 'tool_use',
                catId: 'opus',
                toolName: 'Read',
                toolInput: { file_path: '/tmp/test' },
                timestamp: Date.now(),
              };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
      });
      const { deps, source, boundaries, options } = fixture;
      let doneCount = 0;
      for await (const event of route(deps, ['opus'], source.content, 'user-1', 'thread-cursor', options)) {
        if (event.type !== 'done' || event.catId !== 'opus') continue;
        doneCount++;
        const reply = await deps.messageStore.getById(event.messageId);
        assert.ok(reply, 'actual formal output exists at the target completion boundary');
        assert.equal(reply.extra.deliveryBoundary?.cursor, boundaries.get('opus'));
        assert.equal(reply.extra.deliveryBoundary?.turnInvocationId, reply.extra.stream.turnInvocationId);
        assert.equal(reply.extra.deliveryBoundary?.sourceMessageId, source.id);
        assert.equal(
          await deps.deliveryCursorStore.getCursor('user-1', 'opus', 'thread-cursor'),
          boundaries.get('opus'),
        );
      }
      assert.equal(doneCount, 1);
    });
  }

  test(`#1371: ${name} append-to-ack crash retains durable proof without marking sibling delivered`, async () => {
    const { deps, source, boundaries, options } = await cursorHarness({
      opus: {
        supportsToolExecutionPolicy: () => true,
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: 'durable before ack failure', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    deps.deliveryCursorStore.ackCursor = async () => {
      throw new Error('injected cursor I/O failure');
    };
    for await (const _ of route(deps, ['opus'], source.content, 'user-1', 'thread-cursor', options)) {
    }
    const reply = (await deps.messageStore.getByThread('thread-cursor')).find((m) => m.catId === 'opus');
    assert.equal(reply.extra.deliveryBoundary?.cursor, boundaries.get('opus'));
    assert.equal(await deps.deliveryCursorStore.getCursor('user-1', 'opus', 'thread-cursor'), undefined);
    assert.equal(await deps.deliveryCursorStore.getCursor('user-1', 'codex', 'thread-cursor'), undefined);
  });
}

test('#1371: tool-only target interrupted before done keeps old cursor while replied sibling commits', async () => {
  const blocked = deferred();
  const firstDone = deferred();
  const { deps, source, boundaries, options } = await cursorHarness({
    opus: {
      supportsToolExecutionPolicy: () => true,
      async *invoke() {
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'Read',
          toolInput: { file_path: '/tmp/test' },
          timestamp: Date.now(),
        };
        await blocked.promise;
        yield { type: 'error', catId: 'opus', error: 'provider interrupted', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    },
    codex: {
      supportsToolExecutionPolicy: () => true,
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'sibling complete', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    },
  });
  const execution = (async () => {
    for await (const event of routeParallel(
      deps,
      ['opus', 'codex'],
      source.content,
      'user-1',
      'thread-cursor',
      options,
    )) {
      if (event.type === 'done' && event.catId === 'codex') firstDone.resolve();
    }
  })();
  try {
    await Promise.race([
      firstDone.promise,
      execution.then(() => {
        throw new Error('missing sibling done');
      }),
    ]);
    assert.equal(await deps.deliveryCursorStore.getCursor('user-1', 'opus', 'thread-cursor'), undefined);
    assert.equal(await deps.deliveryCursorStore.getCursor('user-1', 'codex', 'thread-cursor'), boundaries.get('codex'));
  } finally {
    blocked.resolve();
    await execution;
  }
  const outputs = await deps.messageStore.getByThread('thread-cursor');
  assert.ok(outputs.filter((m) => m.catId === 'opus').every((m) => !m.extra?.deliveryBoundary));
});
