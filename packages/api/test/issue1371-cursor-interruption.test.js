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

  for (const failure of ['append', 'error-coded done', 'commit rejected']) {
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
      if (failure === 'append') {
        const append = deps.messageStore.append.bind(deps.messageStore);
        deps.messageStore.append = (input) => {
          if (input.catId === 'opus') throw new Error('injected output persistence failure');
          return append(input);
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

test('#1371: actual callback replacement commits the route boundary without adding a late proof', async () => {
  let fixture;
  let callbackId;
  fixture = await cursorHarness({
    opus: {
      supportsToolExecutionPolicy: () => true,
      async *invoke() {
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'cat_cafe_post_message',
          toolUseId: 'post',
          toolInput: { content: 'canonical callback answer', streamDisposition: 'replace_final' },
          timestamp: Date.now(),
        };
        const callback = await fixture.deps.messageStore.append({
          userId: 'user-1',
          threadId: 'thread-cursor',
          catId: 'opus',
          content: 'canonical callback answer',
          mentions: [],
          timestamp: Date.now(),
          origin: 'callback',
          extra: {
            stream: { invocationId: 'child-1', turnInvocationId: 'child-1' },
            causal: { kind: 'invocation_reply', triggerMessageId: fixture.source.id },
          },
        });
        callbackId = callback.id;
        yield {
          type: 'tool_result',
          catId: 'opus',
          toolUseId: 'post',
          content: JSON.stringify({ status: 'ok', threadId: 'thread-cursor', messageId: callbackId }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'provider final replaced', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    },
  });
  const { deps, source, boundaries, options } = fixture;
  for await (const event of routeSerial(deps, ['opus'], source.content, 'user-1', 'thread-cursor', options)) {
    if (event.type !== 'done') continue;
    assert.equal(event.messageId, callbackId);
    assert.equal(await deps.deliveryCursorStore.getCursor('user-1', 'opus', 'thread-cursor'), boundaries.get('opus'));
  }
  const outputs = (await deps.messageStore.getByThread('thread-cursor')).filter((m) => m.catId === 'opus');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].content, 'canonical callback answer');
  assert.equal(outputs[0].extra.deliveryBoundary, undefined);
});
