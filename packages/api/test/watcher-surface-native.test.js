import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { watcherRetirementPort } from '../dist/domains/concierge/watcher/retirement/watcher-retirement-port.js';
import { saveWatcherState } from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { runWatcherInvocation } from '../dist/domains/concierge/watcher/watcher-invocation.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

test('the control-only provider boundary refuses an accidental model POST before forwarding or tool admission', async () => {
  const { default: Fastify } = await import('fastify');
  const app = Fastify();
  let requests = 0;
  app.post('/v1/responses', () => {
    requests++;
    return {};
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const control = watcherRetirementPort(new AbortController().signal, async () => false);
  try {
    const configured = await control.port.configureProvider({
      config: {
        model_provider: 'custom',
        model_providers: { custom: { name: 'fixture', base_url: `${app.listeningOrigin}/v1`, wire_api: 'responses' } },
      },
      account: null,
      transportEnv: {},
    });
    const response = await fetch(`${configured.model_providers.custom.base_url}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'watcher_retirement_model_forbidden');
    assert.equal(requests, 0);
    assert.deepEqual(control.port.tools, []);
    await assert.rejects(control.port.callTool({}), /forbidden/);
    await assert.rejects(control.port.accepted({}), /forbidden/);
  } finally {
    await control.close();
    await app.close();
  }
});

test(
  'real CLI retires the pinned physical native without a model request, then a new native handles existing unread work',
  { timeout: 60000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w, {
      configure: ({ app, state }) => {
        state.name = 'Original fixture owner';
        app.get('/api/config', async () => ({
          config: { coCreator: { name: state.name, mentionPatterns: ['@fixture-owner'] } },
        }));
      },
    });
    f.state.quiet = true;
    try {
      const [first] = await w.work('RAW_INCREMENT_51');
      const original = await f.run(first, AbortSignal.timeout(20000));
      const originalPin = original.watcherState.toolSchemaHash;
      const [blocked] = await w.work('RAW_INCREMENT_52 unread original survives retirement');
      f.state.name = 'Current fixture owner';
      await assert.rejects(f.run(blocked, AbortSignal.timeout(20000)), /watcher_native_tool_surface_changed/);
      const before = await w.sessions.get(original.id);
      await saveWatcherState(w.sessions, original.id, before.watcherState, {
        attempt: { ...before.watcherState.attempt, recoveryAttempts: 3, recoveryRetryAt: 1, recoveryControlKey: '0:1' },
      });
      const [next] = await w.work('RAW_INCREMENT_53 already settled before the control-only retirement');
      const requests = f.requests.length;
      const launches = f.state.nativeLaunchPids.length;
      await runWatcherInvocation(f.owners, {
        session: await w.sessions.get(original.id),
        source: blocked,
        service: f.service,
        recoveryOnly: true,
        quiet: true,
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(f.requests.length, requests, 'native-only retirement must send zero Responses requests');
      assert.equal(f.state.nativeLaunchPids.length, launches + 1);
      const old = await w.sessions.get(original.id);
      assert.equal(old.status, 'sealed');
      assert.equal(old.cliSessionId, original.cliSessionId);
      assert.equal(old.watcherState.toolSchemaHash, originalPin);
      assert.equal(old.watcherState.consumedThrough, first.responseSettlement.messageId);
      assert.equal(old.watcherState.attempt, undefined);
      const execution = await w.executions.get(before.watcherRetirement.wakeInvocationId);
      assert.equal(execution.status, 'failed');
      assert.equal(execution.terminalReason, 'watcher_native_tool_surface_changed');
      assert.equal(execution.responseSettlement.kind, 'no_response');
      const successor = await w.sessions.getByChainKey(watcherSessionChainKey(next.userId, 'codex', next.threadId));
      assert.notEqual(successor.id, original.id);
      assert.equal(successor.cliSessionId, undefined);
      assert.equal(successor.watcherState.consumedThrough, first.responseSettlement.messageId);
      const completed = await f.run(next, AbortSignal.timeout(20000));
      assert.equal(completed.id, successor.id);
      assert.notEqual(completed.cliSessionId, original.cliSessionId);
      assert.notEqual(completed.watcherState.toolSchemaHash, originalPin);
      assert.equal(completed.watcherState.consumedThrough, next.responseSettlement.messageId);
      const wire = f.requests
        .slice(requests)
        .map((r) => r.wire)
        .join('\n');
      assert.ok(wire.includes(blocked.responseSettlement.messageId));
      assert.ok(wire.includes(next.responseSettlement.messageId));
      assert.equal(f.enqueues.length, 0);
    } finally {
      await f.close();
    }
  },
);
