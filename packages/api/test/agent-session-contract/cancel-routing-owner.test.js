import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { routeParallel } from '../../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';
import { deferred } from './fake-session-provider.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, service) {
  t.after(isolateAccountAuthEnvironment());
  const all = catRegistry.getAllConfigs();
  const catId = 'owned-route-drain';
  catRegistry.register(catId, {
    ...all.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  });
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => {
      catRegistry.register(id, config);
    });
  });
  const { deps } = routingJourneyDeps(undefined, undefined, service);
  deps.services = { [catId]: service };
  return { deps, catId };
}

for (const pendingRead of [false, true])
  for (const route of [routeSerial, routeParallel])
    test(`${route.name} consumer return waits for drain cleanup; pending read=${pendingRead}`, async (t) => {
      const cleanup = deferred(),
        entered = deferred(),
        finished = deferred();
      const service = {
        cancellationMode: 'drain',
        async *invoke(_prompt, options) {
          try {
            yield { type: 'text', catId: 'owned-route-drain', content: 'owned ready', timestamp: 1 };
            if (pendingRead)
              await new Promise((resolve) => {
                if (options.signal.aborted) resolve();
                else options.signal.addEventListener('abort', resolve, { once: true });
              });
          } finally {
            entered.resolve();
            await cleanup.promise;
            finished.resolve();
          }
        },
      };
      const { deps, catId } = fixture(t, service);
      const iterator = route(deps, [catId], 'owned', 'owner', 'thread', { thinkingMode: 'play' })[
        Symbol.asyncIterator
      ]();
      let returned;
      t.after(async () => {
        cleanup.resolve();
        await returned;
        await finished.promise;
      });
      while (true) {
        const next = await iterator.next();
        assert.equal(next.done, false, JSON.stringify(next));
        if (next.value.type === 'text') break;
        assert.notEqual(next.value.type, 'error', next.value.error);
      }
      let settled = false;
      returned = iterator.return().then((value) => {
        settled = true;
        return value;
      });
      await entered.promise;
      await tick();
      assert.equal(settled, false, 'drain ownership includes explicit consumer return, not just signal cancellation');
      cleanup.resolve();
      await returned;
    });

test('parallel batch abort reaches a drain child even when per-cat cancellation has its own independent signal', async (t) => {
  const batch = new AbortController(),
    perCat = new AbortController(),
    ready = deferred();
  let sourceSignal;
  const service = {
    cancellationMode: 'drain',
    async *invoke(_prompt, options) {
      sourceSignal = options.signal;
      yield { type: 'text', catId: 'owned-route-drain', content: 'owned ready', timestamp: 1 };
      await new Promise((resolve) => {
        if (sourceSignal.aborted) resolve();
        else sourceSignal.addEventListener('abort', resolve, { once: true });
      });
      yield { type: 'done', catId: 'owned-route-drain', timestamp: 2 };
    },
  };
  const { deps, catId } = fixture(t, service);
  const run = (async () => {
    for await (const message of routeParallel(deps, [catId], 'owned', 'owner', 'thread', {
      thinkingMode: 'play',
      signal: batch.signal,
      signalForCat: () => perCat.signal,
    }))
      if (message.type === 'text') ready.resolve();
  })();
  t.after(async () => {
    perCat.abort();
    await run;
  });
  await ready.promise;
  batch.abort('owned batch stop');
  await tick();
  assert.equal(perCat.signal.aborted, false);
  assert.equal(
    sourceSignal.aborted,
    true,
    'removing the merge batch shortcut requires delivering batch abort to the actual adapter',
  );
});
