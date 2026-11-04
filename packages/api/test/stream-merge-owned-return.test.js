import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeStreams } from '../dist/domains/cats/services/agents/invocation/stream-merge.js';
import { deferred } from './agent-session-contract/fake-session-provider.js';

for (const failed of [false, true])
  test(`controlled merge return drains every child, including after a peer fails: ${failed}`, async (t) => {
    const controllers = [new AbortController(), new AbortController()];
    const entered = deferred();
    const cleanup = deferred();
    const failure = new Error('owned cleanup failed');
    let settled = false;
    let finished = 0;
    const streams = controllers.map((controller, index) =>
      (async function* () {
        try {
          yield index;
          await new Promise((resolve) => {
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener('abort', resolve, { once: true });
          });
        } finally {
          // biome-ignore lint/correctness/noUnsafeFinally: deliberately inject a cleanup failure, not a task failure.
          if (index === 0 && failed) throw failure;
          entered.resolve();
          await cleanup.promise;
          finished++;
        }
      })(),
    );
    const iterator = mergeStreams(streams, undefined, { ownedControllerForIndex: (index) => controllers[index] });
    assert.equal((await iterator.next()).done, false);
    const returned = iterator.return().then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    t.after(async () => {
      cleanup.resolve();
      await returned;
    });
    await entered.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      controllers.every((controller) => controller.signal.aborted),
      true,
    );
    assert.equal(settled, false, 'a peer failure must not bypass another owned cleanup');
    cleanup.resolve();
    assert.equal(await returned, failed ? failure : undefined);
    assert.equal(finished, failed ? 1 : 2);
  });
