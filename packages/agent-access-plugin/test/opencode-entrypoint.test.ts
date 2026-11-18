import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import plugin from '../src/entrypoint.ts';

/**
 * The package's public surface must route by client. The Host calls the same two
 * operations for every native runtime, so an OpenCode branch that only works when
 * called directly — but not through the declared operation — would fail in
 * production while passing every unit test below it.
 */
function actions() {
  const host = {
    agentAccess: {
      readDetectionContext: async () => ({ candidates: [] }),
    },
    agentRoleStore: {},
  } as never;
  const started = (plugin as { create(): { start(host: unknown): { actions: Record<string, unknown> } } })
    .create()
    .start(host);
  return started.actions as Record<string, (input: unknown) => unknown>;
}

describe('package entrypoint routing', () => {
  test('configure still serves the client directory with no operation', () => {
    const result = actions().configure(undefined) as { clients: Array<{ id: string }> };

    assert.ok(Array.isArray(result.clients));
    assert.ok(result.clients.some((client) => client.id === 'opencode'));
  });

  test('configure plans Kimi launch arguments through the public operation', () => {
    const result = actions().configure({
      operation: 'plan_native_launch',
      client: 'kimi',
      launch: { prompt: 'hi', imageAccessDirs: [] },
    }) as { args: string[] };

    assert.ok(result.args.includes('-p'));
    assert.equal(result.args[result.args.length - 1], 'hi');
  });

  test('configure plans OpenCode launch arguments through the same operation', () => {
    const result = actions().configure({
      operation: 'plan_native_launch',
      client: 'opencode',
      launch: { prompt: 'hi', readOnlyAgent: 'cat-cafe-read-only', model: 'm' },
    }) as { args: string[] };

    assert.equal(result.args[0], 'run');
    assert.deepEqual(result.args.slice(-2), ['--', 'hi']);
  });

  test('planFinalizer serves the OpenCode recovery run as its own operation', () => {
    const result = actions().planFinalizer({
      operation: 'plan_native_finalizer',
      client: 'opencode',
      launch: { prompt: 'summarise', model: 'm', finalizerAgent: 'cat-cafe-no-tool-finalizer' },
    }) as { args: string[] };

    assert.equal(result.args[0], 'run');
    assert.equal(result.args[result.args.indexOf('--agent') + 1], 'cat-cafe-no-tool-finalizer');
    assert.deepEqual(result.args.slice(-2), ['--', 'summarise']);
  });

  test('a finalizer request is not accepted as a launch plan', () => {
    assert.throws(
      () =>
        actions().configure({
          operation: 'plan_native_finalizer',
          client: 'opencode',
          launch: { prompt: 'p', model: 'm', finalizerAgent: 'a' },
        }),
      'the two operations must not be interchangeable',
    );
  });

  test('parseNativeEvent routes a Kimi event', () => {
    const result = actions().parseNativeEvent({
      client: 'kimi',
      event: { role: 'assistant', content: 'hello' },
    }) as { kind: string };

    assert.equal(result.kind, 'assistant');
  });

  test('parseNativeEvent routes an OpenCode event', () => {
    const result = actions().parseNativeEvent({
      client: 'opencode',
      event: { type: 'text', part: { type: 'text', text: 'hello' }, timestamp: 1 },
    }) as { kind: string; text?: string };

    assert.equal(result.kind, 'text');
    assert.equal(result.text, 'hello');
  });
});
