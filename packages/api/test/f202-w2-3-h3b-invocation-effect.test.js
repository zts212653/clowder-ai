/**
 * F202 W2-3 h3b — a failed Host→plugin call says whether the package could have acted on it
 * (ledger「h3b 实现设计」, codex design review …000912).
 *
 * `not_started` only where the Host refused before any package code ran for this call; once the
 * module's action is entered, any failure is `unknown`, even an error carrying the same code as a
 * Host refusal. A carrier that cannot report the boundary is `unknown` throughout. `invoke` keeps
 * its contract: the value, or the very error the call failed with.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';
import { cleanup, conversationHostHarness, hostManifest, METHODS } from './f202-w2-3-h3b.fixture.js';

after(cleanup);

const failedWith = (outcome, effect, code) =>
  outcome.status === 'failed' && outcome.effect === effect && (code === undefined || outcome.error?.code === code);

test('what the Host refuses before the module action runs is not_started', async () => {
  const h = await conversationHostHarness();
  assert.ok(
    failedWith(await h.router.attemptInvoke('pi_nobody', METHODS.append, {}), 'not_started', 'INSTANCE_NOT_RUNNABLE'),
  );

  await h.enable();
  const id = h.instances[0];
  assert.ok(failedWith(await h.router.attemptInvoke(id, 'no.such.action', {}), 'not_started', 'PROTOCOL_VIOLATION'));

  // The instance is no longer enabled in the inventory: the carrier refuses it.
  await h.store.transaction((transaction) => {
    const instance = transaction.instances.get(id);
    transaction.instances.put({ ...instance, activationState: 'disabled' });
  });
  assert.ok(failedWith(await h.router.attemptInvoke(id, METHODS.append, {}), 'not_started', 'INSTANCE_NOT_RUNNABLE'));
  assert.equal(h.calls(METHODS.append).length, 0);
});

test('a carrier whose module is no longer loaded refuses before the action: not_started', async () => {
  const h = await conversationHostHarness();
  await h.enable();
  await h.moduleRuntime.stop(h.instances[0], 'test');

  const outcome = await h.router.attemptInvoke(h.instances[0], METHODS.append, {});

  assert.ok(failedWith(outcome, 'not_started', 'INSTANCE_NOT_RUNNABLE'));
  assert.match(outcome.error.message, /no module loaded/);
});

test('once the action is entered every failure is unknown, even a Host error with a refusal code', async () => {
  const h = await conversationHostHarness();
  await h.enable();
  const id = h.instances[0];
  const thrown = {
    'a synchronous throw': new Error('sync'),
    'a rejected promise': new Error('async'),
    'a Host refusal error thrown inside the action': new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'inner'),
  };
  for (const [name, error] of Object.entries(thrown)) {
    h.script[METHODS.append] =
      name === 'a rejected promise'
        ? async () => Promise.reject(error)
        : () => {
            throw error;
          };
    const outcome = await h.router.attemptInvoke(id, METHODS.append, { n: name });
    assert.equal(outcome.status, 'failed', name);
    assert.equal(outcome.effect, 'unknown', name);
    assert.equal(outcome.error, error, `${name}: the very error the action threw`);
  }
  assert.equal(h.calls(METHODS.append).length, 3, 'each call reached the action');
});

test('invoke keeps its contract: the value, or the very error the call failed with', async () => {
  const h = await conversationHostHarness();
  await h.enable();
  const id = h.instances[0];
  h.script[METHODS.list] = (input) => ({ echoed: input });
  assert.deepEqual(await h.router.invoke(id, METHODS.list, { a: 1 }), { echoed: { a: 1 } });

  const error = new Error('package failure');
  h.script[METHODS.list] = () => {
    throw error;
  };
  await assert.rejects(h.router.invoke(id, METHODS.list, {}), (rejected) => rejected === error);
  await assert.rejects(h.router.invoke(id, 'no.such.action', {}), { code: 'PROTOCOL_VIOLATION' });
});

test('exposesAction answers from the loaded action table only', async () => {
  const h = await conversationHostHarness({ packages: [{ manifest: hostManifest(), exposes: [METHODS.append] }] });
  const id = h.instances[0];
  await h.moduleRuntime.start(id, (await h.store.snapshot()).packages[0], []);

  assert.equal(h.moduleRuntime.exposesAction(id, METHODS.append), true);
  assert.equal(h.moduleRuntime.exposesAction(id, METHODS.ack), false);
  assert.equal(h.moduleRuntime.exposesAction(id, 'toString'), false, 'an inherited property is not an action');
  assert.equal(h.moduleRuntime.exposesAction('pi_nobody', METHODS.append), false);
});

function routerWith(carrier) {
  const snapshot = {
    instances: [{ pluginInstanceId: 'pi_fake', packageDigest: 'digest' }],
    packages: [{ packageDigest: 'digest', pluginId: 'dev.clowder.fake', manifest: {} }],
    grants: [],
  };
  const router = new PluginRuntimeCarrierRouter({ snapshot: async () => snapshot });
  router.register({
    claims: () => true,
    start: async () => undefined,
    stop: async () => undefined,
    stopAll: async () => undefined,
    ...carrier,
  });
  return router;
}

test('a carrier that cannot report the boundary is unknown throughout; one with no surface refuses', async () => {
  const error = new Error('carrier failed somewhere');
  const reportsNothing = routerWith({
    invoke: async () => {
      throw error;
    },
  });
  const outcome = await reportsNothing.attemptInvoke('pi_fake', 'm', {});
  assert.ok(failedWith(outcome, 'unknown') && outcome.error === error);
  assert.equal(await reportsNothing.exposesAction('pi_fake', 'm'), false);

  const noSurface = routerWith({});
  assert.ok(failedWith(await noSurface.attemptInvoke('pi_fake', 'm', {}), 'not_started', 'DELIVERY_REJECTED'));

  const brokenReport = routerWith({
    attemptInvoke: () => {
      throw error;
    },
  });
  const broken = await brokenReport.attemptInvoke('pi_fake', 'm', {});
  assert.ok(failedWith(broken, 'unknown') && broken.error === error, 'an attempt that breaks proves nothing');
});
