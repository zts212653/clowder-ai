import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { cursorHarness } from './helpers/issue1371-cursor-harness.js';

for (const [name, route] of [
  ['parallel', routeParallel],
  ['serial', routeSerial],
]) {
  test(`#1371: ${name} silent success commits at done without inventing a durable message`, async () => {
    const { deps, source, boundaries, options } = await cursorHarness({
      opus: {
        supportsToolExecutionPolicy: () => true,
        async *invoke() {
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    for await (const event of route(deps, ['opus'], source.content, 'user-1', 'thread-cursor', options)) {
      if (event.type === 'done') {
        assert.equal(
          await deps.deliveryCursorStore.getCursor('user-1', 'opus', 'thread-cursor'),
          boundaries.get('opus'),
        );
      }
    }
    assert.ok(boundaries.get('opus'));
    assert.equal((await deps.messageStore.getByThread('thread-cursor')).filter((m) => m.catId === 'opus').length, 0);
  });

  for (const failure of ['output commit', 'error-coded done', 'commit rejected']) {
    test(`#1371: ${name} ${failure} cannot advance a success cursor or leave a proof`, async () => {
      const { deps, source, options } = await cursorHarness({
        opus: {
          supportsToolExecutionPolicy: () => true,
          async *invoke() {
            yield { type: 'text', catId: 'opus', content: 'partial output', timestamp: Date.now() };
            yield {
              type: 'done',
              catId: 'opus',
              timestamp: Date.now(),
              ...(failure === 'error-coded done' ? { errorCode: 'CANCELED' } : {}),
            };
          },
        },
      });
      if (failure === 'output commit') {
        deps.freshnessOutputCommitCoordinator.commit = () => {
          throw new Error('injected output persistence failure');
        };
      }
      if (failure === 'commit rejected') options.beforeOutputCommit = async () => false;
      for await (const _ of route(deps, ['opus'], source.content, 'user-1', 'thread-cursor', options)) {
      }
      assert.equal(await deps.deliveryCursorStore.getCursor('user-1', 'opus', 'thread-cursor'), undefined);
      assert.ok((await deps.messageStore.getByThread('thread-cursor')).every((m) => !m.extra?.deliveryBoundary));
    });
  }
}
