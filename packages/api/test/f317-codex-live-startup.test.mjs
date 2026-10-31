import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function requestFor(text) {
  return {
    v: 1,
    message: { body: text, sourceRefs: [{ owner: 'message', ref: 'host-start' }] },
    nativeInstructions: [],
    runtime: {},
    tools: {},
    providerNativeVisibility: 'unknown',
  };
}

for (const phase of ['preflight', 'commit']) {
  for (const disposition of ['closed', 'failed', 'aborted']) {
    test(`Live ${disposition} during ${phase} cannot submit a late initial turn`, { timeout: 3000 }, async () => {
      const f = wireFixture();
      const entered = deferred();
      const pending = deferred();
      const finished = deferred();
      const controller = new AbortController();
      const failure = new Error(`call ${disposition}`);
      let readyCalls = 0;
      let prepareCalls = 0;
      let commits = 0;
      const events = [];
      const drain = (async () => {
        try {
          for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
            thread: { kind: 'start' },
            signal: controller.signal,
            prompt: {
              kind: 'preflight',
              settle: async () => {
                if (phase === 'preflight') {
                  entered.resolve();
                  await pending.promise;
                }
                return { prompt: 'full Host startup context' };
              },
            },
            prepareRequest: (text) => {
              prepareCalls++;
              return requestFor(text);
            },
            beforeProviderLaunch: async () => {
              commits++;
              if (phase === 'commit') {
                entered.resolve();
                await pending.promise;
              }
              return { requestGenerationId: 'startup', generationOrdinal: 1, sessionId: 'session' };
            },
            live: {
              finished: finished.promise,
              // Preparing calls do not accept owner input yet; this is not a Stop signal.
              acceptsInput: () => false,
              ready: async () => {
                readyCalls++;
              },
              observe: async () => {},
            },
          }))
            events.push(event);
          return null;
        } catch (error) {
          return error;
        }
      })();
      await entered.promise;
      if (disposition === 'closed') finished.resolve();
      if (disposition === 'failed') finished.reject(failure);
      if (disposition === 'aborted') controller.abort(failure);
      pending.resolve();
      const error = await drain;
      assert.equal(f.writes.filter((row) => row.method === 'turn/start').length, 0);
      assert.equal(readyCalls, 0);
      assert.equal(prepareCalls, phase === 'preflight' ? 0 : 1);
      assert.equal(commits, phase === 'preflight' ? 0 : 1);
      if (disposition === 'closed') assert.equal(error?.code, 'INVOCATION_CANCELLED');
      else assert.equal(error, failure);
      assert.ok(events.some((row) => row.type === 'app_server.lifecycle' && row.lifecycle.stage === 'closed'));
    });
  }
}

test('Live preflight still settles and commits full Host context before ready', { timeout: 3000 }, async () => {
  const f = wireFixture();
  const finished = deferred();
  const order = [];
  for await (const _ of new CodexAppServerClient({ wire: f.wire }).run({
    thread: { kind: 'start' },
    prompt: {
      kind: 'preflight',
      settle: async ({ evidence }) => {
        assert.equal(evidence.runtimeSessionId, 'native');
        order.push('settle');
        return { prompt: 'full Host startup context' };
      },
    },
    prepareRequest: requestFor,
    beforeProviderLaunch: async (request) => {
      assert.equal(request.message.body, 'full Host startup context');
      order.push('commit');
      return { requestGenerationId: 'startup', generationOrdinal: 1, sessionId: 'session' };
    },
    live: {
      finished: finished.promise,
      acceptsInput: () => false,
      ready: async () => {
        order.push('ready');
        assert.equal(
          f.writes.find((row) => row.method === 'turn/start').params.input[0].text,
          'full Host startup context',
        );
        finished.resolve();
      },
      observe: async () => {},
    },
  })) {
  }
  assert.deepEqual(order, ['settle', 'commit', 'ready']);
});
