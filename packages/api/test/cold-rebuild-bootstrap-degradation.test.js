/**
 * Session #1 cold-rebuild contract, adapted from clowder-ai#1375.
 *
 * A null bootstrap means there is no sealed prior; it is distinct from a
 * rejected storage/bootstrap read. The parallel case intentionally uses two
 * cats with separate provider sessions and per-cat evidence so one sibling
 * cannot satisfy the other's assertions.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertDegradedInvocations,
  captureWarns,
  countDegradationWarnings,
  createHandshakeService,
  createProjectionService,
  failingRebuildChain,
  PARALLEL_DEGRADED_MESSAGE,
  REMEDIAL_DEGRADED_MESSAGE,
  runRoute,
  SERIAL_DEGRADED_MESSAGE,
  SessionChainStore,
} from './helpers/cold-rebuild-bootstrap-degradation-fixture.js';

describe('cold-rebuild bootstrap degradation (Session #1, no sealed prior)', () => {
  test('serial retains the initial prompt and warns once', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const warns = captureWarns('route-serial');
    const service = createHandshakeService('codex', ['serial answer']);
    const { yielded, deps } = await runRoute(routeSerial, { codex: service }, 'thread-cold-rebuild-serial');
    assertDegradedInvocations({
      yielded,
      service,
      catId: 'codex',
      getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
    });
    assert.equal(service.calls.length, 1);
    assert.match(service.calls[0], /cold rebuild probe/);
    assert.equal(countDegradationWarnings(warns, { catId: 'codex', message: SERIAL_DEGRADED_MESSAGE }), 1);
  });

  test('serial propagates a thrown bootstrap storage error', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const warns = captureWarns('route-serial');
    const service = createHandshakeService('codex', ['must not invoke']);
    const sentinel = 'bootstrap storage exploded';
    const chain = failingRebuildChain(new SessionChainStore(), new Error(sentinel));
    const { yielded } = await runRoute(routeSerial, { codex: service }, 'thread-cold-rebuild-storage-error', {
      sessionChainStore: chain,
    });
    const errors = yielded
      .filter((message) => message.catId === 'codex' && (message.type === 'error' || message.error === true))
      .map((message) => message.content ?? message.error);
    assert.deepEqual(errors, [sentinel]);
    assert.equal(chain.getChainCalls(), 3, 'failure occurs on the rebuild read');
    assert.equal(service.calls.length, 0, 'provider does not receive an unverified prompt');
    assert.equal(
      countDegradationWarnings(warns, { catId: 'codex', message: SERIAL_DEGRADED_MESSAGE }),
      0,
      'thrown errors are not mislabeled as null degradation',
    );
  });

  test('parallel siblings independently retain their initial prompts', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const warns = captureWarns('route-parallel');
    const codex = createHandshakeService('codex', ['codex answer']);
    const claude = createHandshakeService('claude', ['claude answer']);
    const { yielded, deps } = await runRoute(routeParallel, { codex, claude }, 'thread-cold-rebuild-parallel', {
      targetCats: ['codex', 'claude'],
    });
    for (const [catId, service] of [
      ['codex', codex],
      ['claude', claude],
    ]) {
      assertDegradedInvocations({
        yielded,
        service,
        catId,
        getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
      });
      assert.equal(service.calls.length, 1, `${catId} routes exactly once`);
      assert.match(service.calls[0], /cold rebuild probe/);
      assert.equal(
        countDegradationWarnings(warns, { catId, message: PARALLEL_DEGRADED_MESSAGE }),
        1,
        `${catId} owns exactly one degradation warning`,
      );
    }
  });

  test('remedial retains the bare stop-gate prompt and warns once per rebuild', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const warns = captureWarns('route-serial');
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: true, transitionObserved: false }],
    });
    const service = createHandshakeService('codex', ['No structured transition.', 'remedial answer']);
    const { yielded, deps } = await runRoute(routeSerial, { codex: service }, 'thread-cold-rebuild-remedial', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'action_successor',
          leaseId: 'lease-cold-rebuild-remedial',
          generation: 1,
          holderCatId: 'codex',
        },
      },
    });
    assertDegradedInvocations({
      yielded,
      service,
      catId: 'codex',
      getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
    });
    assert.equal(service.calls.length, 2, 'main child plus one remedial child');
    assert.match(service.calls[1], /F167 球权停止门/);
    assert.equal(countDegradationWarnings(warns, { catId: 'codex', message: SERIAL_DEGRADED_MESSAGE }), 1);
    assert.equal(countDegradationWarnings(warns, { catId: 'codex', message: REMEDIAL_DEGRADED_MESSAGE }), 1);
  });
});
