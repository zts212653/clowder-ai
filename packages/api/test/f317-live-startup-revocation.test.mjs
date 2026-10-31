import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

for (const [phase, failed] of ['preflight', 'commit', 'initial_rpc', 'native_binding'].flatMap((phase) => [
  [phase, false],
  [phase, true],
])) {
  test(
    `actual Host ${failed ? 'failure' : 'Stop'} during ${phase} fences startup before cleanup finishes`,
    { timeout: 5000 },
    async () => {
      const pending = deferred();
      const entered = deferred();
      const cleanup = deferred();
      const call = await LiveCompanionCall.create({
        binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex'), callId: `revocation-${phase}` },
        messageStore: new MessageStore(),
        mcpDistDir: resolve('../mcp-server/dist'),
        allowedDirectories: [resolve('../../docs')],
        publish() {},
        verifyNativeBinding: async () => {
          if (phase === 'native_binding') {
            entered.resolve();
            await pending.promise;
          }
          return true;
        },
      });
      const close = call.credentials.close.bind(call.credentials);
      call.credentials.close = async () => {
        await cleanup.promise;
        await close();
      };
      let finished = false;
      void call.finished.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      const failure = new Error('actual Host failure');
      const fixture = wireFixture();
      const write = fixture.wire.write;
      fixture.wire.write = async (message) => {
        if (message.method === 'turn/start' && phase === 'initial_rpc') {
          fixture.writes.push(message);
          entered.resolve();
          await pending.promise;
          fixture.push({ id: message.id, result: { turn: { id: 'first' } } });
          return;
        }
        if (message.method === 'turn/interrupt') {
          fixture.writes.push(message);
          fixture.push({ id: message.id, result: {} });
          fixture.push(fixture.completed('first'));
          return;
        }
        await write(message);
      };
      let readyCompleted = 0;
      const drain = (async () => {
        try {
          for await (const _event of new CodexAppServerClient({ wire: fixture.wire }).run({
            thread: { kind: 'start' },
            interruptGraceMs: 20,
            prompt: {
              kind: 'preflight',
              settle: async () => {
                if (phase === 'preflight') {
                  entered.resolve();
                  await pending.promise;
                }
                return { prompt: 'full Host prompt' };
              },
            },
            prepareRequest: (text) => ({
              v: 1,
              message: { body: text, sourceRefs: [] },
              nativeInstructions: [],
              runtime: {},
              tools: {},
              providerNativeVisibility: 'unknown',
            }),
            beforeProviderLaunch: async () => {
              if (phase === 'commit') {
                entered.resolve();
                await pending.promise;
              }
              return { requestGenerationId: 'startup', generationOrdinal: 1, sessionId: 'session' };
            },
            live: {
              finished: call.finished,
              startupSignal: call.startupSignal,
              acceptsInput: () => call.acceptsInput(),
              ready: async (id, client) => {
                await call.ready(id, client);
                readyCompleted++;
              },
              observe: (event) => call.observe(event),
            },
          })) {
            /* drain actual client events */
          }
          return null;
        } catch (error) {
          return error;
        }
      })();
      let stopping;
      try {
        await entered.promise;
        stopping = failed ? call.fail(failure) : call.stop();
        assert.equal(finished, false, 'actual cleanup is still pending');
        pending.resolve();
        const error = await drain;
        assert.equal(finished, false, 'startup must reject independently of cleanup completion');
        assert.equal(
          fixture.writes.filter((event) => event.method === 'turn/start').length,
          phase === 'initial_rpc' || phase === 'native_binding' ? 1 : 0,
        );
        if (failed) assert.equal(error, failure);
        else assert.equal(error?.code, 'INVOCATION_CANCELLED');
        assert.equal(readyCompleted, 0);
      } finally {
        pending.resolve();
        cleanup.resolve();
        await drain;
        await (stopping ?? call.stop());
      }
    },
  );
}
