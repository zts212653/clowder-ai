import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { collect, deferred, liveFixture, options, turn } from './fake-session-provider.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const reply of ['accepted', 'failed', 'throws', 'unsupported']) {
  test(
    `bridge keeps a cancelled turn busy until provider terminal evidence, cancel ${reply}`,
    { timeout: 3000 },
    async (t) => {
      const controller = new AbortController();
      const f = await liveFixture({ signal: controller.signal });
      const inbox = f.provider.inbox;
      t.after(() => inbox.end());
      f.provider.cancelTurn = async (...args) => {
        f.provider.calls.cancel.push(args);
        if (reply === 'throws') throw new Error('cancel reply lost');
        return reply === 'accepted'
          ? { ok: true }
          : { ok: false, code: reply === 'unsupported' ? 'unsupported' : 'failed' };
      };
      let settled = false;
      const terminal = f.iterator.next().then((result) => {
        settled = true;
        return result;
      });
      controller.abort();
      await tick();
      assert.equal(settled, false, 'a cancel reply is not provider termination');
      assert.equal(f.provider.calls.cancel.length, 1);
      const blocked = await collect(f.bridge.invoke('overlapping task', options({ invocationId: 'next' })));
      assert.equal(blocked[0].errorCode, 'session_busy');
      assert.equal(f.provider.calls.start.length, 1, 'do not send another turn while stopping');
      f.provider.inbox.push(turn('output', { text: 'late', textMode: 'append' }));
      f.provider.inbox.push(turn('done', { outcome: 'cancelled' }));
      const result = await terminal;
      assert.equal(result.value.type, 'done');
      assert.equal(result.value.errorCode, 'cancelled');
      assert.equal((await f.iterator.next()).done, true);
      f.provider.inbox = undefined;
      f.provider.events = [
        turn('done', { outcome: 'completed', turn: { invocationId: 'next', nativeTurnId: 'native-turn' } }),
      ];
      assert.equal(
        (await collect(f.bridge.invoke('after stopped', options({ invocationId: 'next' })))).at(-1).errorCode,
        undefined,
      );
      assert.equal(f.provider.calls.start.length, 2);
    },
  );
}

for (const failureAt of ['return', 'next'])
  test(`cancelled ${failureAt} cleanup failure remains a failure and keeps the ACP execution busy`, async () => {
    const stop = deferred();
    let calls = 0;
    const provider = new AcpSessionProvider({
      catId: 'codex',
      service: {
        async *invoke() {
          calls++;
          try {
            yield { type: 'status', catId: 'codex', content: 'running', timestamp: 1 };
            await stop.promise;
            if (failureAt === 'return') yield { type: 'done', catId: 'codex', timestamp: 1 };
          } finally {
            throw new Error('owned cleanup failure');
          }
        },
      },
    });
    const bridge = new AgentSessionBridgeService({
      catId: 'codex',
      provider,
      resolveHostSession: () => ({ sessionId: 'host' }),
    });
    const controller = new AbortController();
    const stream = bridge.invoke('first', options({ signal: controller.signal }))[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value.content, 'running');
    const completion = collect(stream);
    controller.abort();
    stop.resolve();
    const events = await completion;
    assert.equal(events.at(-1).errorCode, 'session_contract_failed');
    const blocked = await collect(bridge.invoke('second', options({ invocationId: 'second' })));
    assert.equal(blocked[0].errorCode, 'busy');
    assert.equal(calls, 1, 'failed cleanup cannot allow another source execution');
  });

test('return-before-first-next uses its entry state when a closed next is queued concurrently', async () => {
  let executions = 0;
  const provider = new AcpSessionProvider({
    catId: 'codex',
    service: {
      async *invoke() {
        executions++;
        yield { type: 'done', catId: 'codex', timestamp: 1 };
      },
    },
  });
  await provider.openSession({ sessionId: 'host' });
  const input = {
    invocation: { invocationId: 'first', callbackEnv: {}, mcpServers: [] },
    prompt: { kind: 'frozen', text: 'task' },
  };
  const first = await provider.startTurn('host', input, new AbortController().signal);
  const iterator = first.events[Symbol.asyncIterator]();
  assert.deepEqual(
    (await Promise.all([iterator.return(), iterator.next()])).map((result) => result.done),
    [true, true],
  );
  assert.equal(executions, 0);
  const next = await provider.startTurn('host', input, new AbortController().signal);
  if (next.ok) await next.events[Symbol.asyncIterator]().return();
  assert.equal(next.ok, true, 'no source ran; the wrapper owns cleanup of this unstarted turn');
});

for (const cancelled of [false, true]) {
  test(
    `ACP provider withholds terminal and new start until source cleanup completes, cancelled=${cancelled}`,
    { timeout: 3000 },
    async (t) => {
      const stop = deferred(),
        cleanup = deferred();
      t.after(() => {
        stop.resolve();
        cleanup.resolve();
      });
      let sourceSignal,
        cleanupEntered = false;
      const provider = new AcpSessionProvider({
        catId: 'codex',
        service: {
          async *invoke(_text, opts) {
            sourceSignal = opts.signal;
            try {
              await stop.promise;
              yield { type: 'done', catId: 'codex', timestamp: 1 };
            } finally {
              cleanupEntered = true;
              await cleanup.promise;
            }
          },
        },
      });
      await provider.openSession({ sessionId: 'host' });
      const input = {
        invocation: { invocationId: 'inv', callbackEnv: {}, mcpServers: [] },
        prompt: { kind: 'frozen', text: 'task' },
      };
      const started = await provider.startTurn('host', input, new AbortController().signal);
      let settled = false;
      const run = collect(started.events).then((events) => {
        settled = true;
        return events;
      });
      await tick();
      if (cancelled) {
        assert.deepEqual(await provider.cancelTurn('host', { invocationId: 'inv' }), { ok: true });
        assert.equal(sourceSignal.aborted, true);
        await tick();
        assert.equal(settled, false, 'source still executing after cancellation was accepted');
        assert.equal((await provider.startTurn('host', input, new AbortController().signal)).code, 'busy');
      }
      stop.resolve();
      await tick();
      assert.equal(cleanupEntered, true);
      assert.equal(settled, false, 'source finally/lease cleanup is part of completion');
      assert.equal((await provider.startTurn('host', input, new AbortController().signal)).code, 'busy');
      cleanup.resolve();
      const events = await run;
      assert.equal(events.at(-1).outcome, cancelled ? 'cancelled' : 'completed');
      assert.equal((await provider.cancelTurn('host', { invocationId: 'inv' })).code, 'turn_ended');
    },
  );
}
