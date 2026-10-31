import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

for (const [mode, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  for (const executionScope of ['collective-work', 'collective-participation']) {
    test(`${mode} refuses persisted ${executionScope} before invoking an ordinary provider`, async () => {
      let calls = 0;
      const { deps } = routingJourneyDeps(undefined, undefined, {
        async *invoke() {
          calls++;
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      });
      const events = [];
      for await (const event of route(deps, ['opus'], 'retained input', 'user-1', 'thread-1', {
        executionScope,
        ownerAuthProvenance: 'unknown',
      }))
        events.push(event);
      assert.equal(calls, 0);
      assert.ok(events.some((event) => event.type === 'error' && event.errorCode === 'legacy_execution_scope_retired'));
    });
  }
}
