import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEventsPublishBrokerHandler,
  digestBrokerValue,
  HostBrokerControlPlane,
  MemoryHostBrokerStore,
} from '../../dist/domains/plugin/host-broker/index.js';
import { signalSettlementKey } from '../../dist/domains/signal-intake/index.js';
import { admissionHarness, publishInput, SIGNAL_TYPE } from './helpers.js';

async function openBrokerSession(admission, store, options = {}) {
  const productionHandler = createEventsPublishBrokerHandler({
    inventory: admission.inventory,
    brokerStore: store,
    routes: admission.routes,
    intakes: admission.intakes,
    now: () => 10_000,
    createPublicationId: () => 'pub-broker',
    createIntakeId: () => 'intake-broker',
  });
  const handler = options.wrapHandler?.(productionHandler) ?? productionHandler;
  const sessionId = options.sessionId ?? 'broker';
  const broker = new HostBrokerControlPlane({
    inventory: admission.inventory,
    store,
    methods: [handler],
    now: () => 10_000,
    createConnectionId: () => `conn-${sessionId}`,
    createSessionId: () => `session-${sessionId}`,
    createRuntimeLeaseId: () => `lease-${sessionId}`,
    createBindingNonce: () => `nonce-${sessionId}`,
  });
  const connection = await broker.openBuiltinConnection('pi_example');
  const inventory = await admission.inventory.snapshot();
  const instance = inventory.instances.find((candidate) => candidate.pluginInstanceId === 'pi_example');
  const packageRecord = inventory.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
  const binding = await connection.hello({
    pluginId: instance.pluginId,
    packageDigest: instance.packageDigest,
    contractVersion: packageRecord.contractVersion,
    wireVersion: '0.1.0',
  });
  await connection.ready({ bindingNonce: binding.bindingNonce });
  return { broker, connection };
}

async function brokerHarness(options = {}) {
  const admission = await admissionHarness();
  await admission.inventory.transaction((transaction) => {
    const instance = transaction.instances.get('pi_example');
    transaction.instances.put({ ...instance, runtimeState: 'stopped' });
  });
  const store = new MemoryHostBrokerStore();
  const session = await openBrokerSession(admission, store, options);
  return { ...admission, ...session, store };
}

describe('K-2B events.publish production adapter', () => {
  it('settles through F292 intake and replays the exact Broker receipt', async () => {
    const { connection, intakes, store } = await brokerHarness();

    const accepted = await connection.call('events.publish', publishInput());
    const replay = await connection.call('events.publish', publishInput());

    assert.deepEqual(accepted, { publicationId: 'pub-broker', disposition: 'accepted' });
    assert.deepEqual(replay, accepted);
    assert.equal((await intakes.list()).length, 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'settled_success');
  });

  it('rejects invalid public input before a Broker ledger or intake write', async () => {
    const { connection, intakes, store } = await brokerHarness();

    await assert.rejects(
      connection.call('events.publish', { ...publishInput(), destination: { threadId: 'plugin-selected' } }),
      (error) => error?.code === 'INVALID_CALL_INPUT',
    );
    assert.equal((await intakes.list()).length, 0);
    assert.equal((await store.snapshot()).calls.length, 0);
  });

  it('resolves the current Host route generation per call, not from the runtime lease', async () => {
    const { connection, intakes, routes } = await brokerHarness();
    await routes.put({
      routeId: 'route-meetings-v4',
      ownerId: 'owner-2',
      pluginId: 'official.example-meeting',
      signalType: SIGNAL_TYPE,
      generation: 4,
      state: 'active',
      workflowKind: 'meeting-intake',
      initialUnresolved: [],
      updatedAt: 10_001,
    });

    await connection.call(
      'events.publish',
      publishInput({
        eventId: 'evt-v4',
        idempotencyKey: 'meeting:artifact-v4',
        payload: { artifactId: 'artifact-v4' },
        source: { handle: 'example://meeting/artifact-v4' },
      }),
    );

    const [intake] = await intakes.list();
    assert.equal(intake.routeId, 'route-meetings-v4');
    assert.equal(intake.routeGeneration, 4);
    assert.equal(intake.ownerId, 'owner-2');
  });

  it('recovers a post-admission transport loss from F292 canonical settlement without republishing', async () => {
    let failOnce = true;
    const { connection, intakes, store } = await brokerHarness({
      wrapHandler: (production) => ({
        method: production.method,
        validateInput: (value) => production.validateInput(value),
        validateResult: (value) => production.validateResult(value),
        settlementKey: (context, input) => production.settlementKey(context, input),
        lookupSettlement: (context, input) => production.lookupSettlement(context, input),
        serializePreEffectError: (error) => production.serializePreEffectError(error),
        restoreSettledError: (error) => production.restoreSettledError(error),
        dispatch: async (context, input) => {
          const result = await production.dispatch(context, input);
          if (failOnce) {
            failOnce = false;
            throw new Error('simulated loss after F292 settlement');
          }
          return result;
        },
      }),
    });

    await assert.rejects(connection.call('events.publish', publishInput()), /simulated loss/);
    assert.equal((await intakes.list()).length, 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'dispatched');

    assert.deepEqual(await connection.call('events.publish', publishInput()), {
      publicationId: 'pub-broker',
      disposition: 'duplicate',
    });
    assert.equal((await intakes.list()).length, 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'settled_success');
  });

  it('settles a pre-effect route rejection so exact retry remains recoverable with zero intake', async () => {
    const { connection, intakes, routes, store } = await brokerHarness();
    const route = await routes.get('official.example-meeting', SIGNAL_TYPE);
    await routes.put({ ...route, state: 'inactive', updatedAt: 10_001 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        connection.call('events.publish', publishInput()),
        (error) => error?.code === 'ROUTE_UNAVAILABLE',
      );
    }

    assert.equal((await intakes.list()).length, 0);
    const [call] = (await store.snapshot()).calls;
    assert.equal(call.phase, 'settled_error');
    assert.equal(call.revision, 3);
    assert.equal(call.error?.code, 'ROUTE_UNAVAILABLE');
  });

  it('retries a settled route rejection after a successor Broker session repairs the route', async () => {
    const harness = await brokerHarness({ sessionId: 'route-missing' });
    const route = await harness.routes.get('official.example-meeting', SIGNAL_TYPE);
    await harness.routes.put({ ...route, state: 'inactive', updatedAt: 10_001 });

    await assert.rejects(
      harness.connection.call('events.publish', publishInput()),
      (error) => error?.code === 'ROUTE_UNAVAILABLE',
    );
    await harness.connection.close('route-repair');
    await harness.routes.put({ ...route, state: 'active', updatedAt: 10_002 });

    const successor = await openBrokerSession(harness, harness.store, { sessionId: 'route-repaired' });
    const accepted = await successor.connection.call('events.publish', publishInput());
    const replay = await successor.connection.call('events.publish', publishInput());

    assert.deepEqual(accepted, { publicationId: 'pub-broker', disposition: 'accepted' });
    assert.deepEqual(replay, accepted);
    assert.equal((await harness.intakes.list()).length, 1);
    const [call] = (await harness.store.snapshot()).calls;
    assert.equal(call.phase, 'settled_success');
    assert.equal(call.brokerSessionId, 'session-route-repaired');
    assert.equal(call.revision, 6);
  });

  it('keeps a successful settlement terminal across successor Broker sessions', async () => {
    const harness = await brokerHarness({ sessionId: 'accepted' });
    const accepted = await harness.connection.call('events.publish', publishInput());
    await harness.connection.close('successor-replay');

    const successor = await openBrokerSession(harness, harness.store, { sessionId: 'successor' });
    assert.deepEqual(await successor.connection.call('events.publish', publishInput()), accepted);
    assert.equal((await harness.intakes.list()).length, 1);
    const [call] = (await harness.store.snapshot()).calls;
    assert.equal(call.phase, 'settled_success');
    assert.equal(call.brokerSessionId, 'session-accepted');
    assert.equal(call.revision, 3);
  });

  it('keeps non-recoverable admission errors terminal across successor Broker sessions', async () => {
    const harness = await brokerHarness({ sessionId: 'stale-route' });
    const route = await harness.routes.get('official.example-meeting', SIGNAL_TYPE);
    await harness.routes.put({ ...route, state: 'inactive', updatedAt: 10_001 });
    await assert.rejects(
      harness.connection.call('events.publish', publishInput()),
      (error) => error?.code === 'ROUTE_UNAVAILABLE',
    );
    await harness.store.transaction((transaction) => {
      const [call] = transaction.calls.list();
      transaction.calls.put({
        ...call,
        error: { code: 'STALE_ROUTE', message: 'route generation changed before admission' },
      });
    });
    await harness.connection.close('non-recoverable-replay');
    await harness.routes.put({ ...route, state: 'active', updatedAt: 10_002 });

    const successor = await openBrokerSession(harness, harness.store, { sessionId: 'stale-route-successor' });
    await assert.rejects(
      successor.connection.call('events.publish', publishInput()),
      (error) => error?.code === 'STALE_ROUTE',
    );
    assert.equal((await harness.intakes.list()).length, 0);
    const [call] = (await harness.store.snapshot()).calls;
    assert.equal(call.brokerSessionId, 'session-stale-route');
    assert.equal(call.revision, 3);
  });

  it('rejects a recovered F292 settlement whose canonical digest does not match the current input', async () => {
    const { binding, connection, intakes, service, store } = await brokerHarness();
    const input = publishInput();
    const foreignInput = publishInput({
      payload: { artifactId: 'foreign-artifact', title: 'Foreign settlement' },
      source: { handle: 'example://meeting/foreign-artifact' },
    });
    await service.publish(binding, foreignInput);

    const brokerState = await store.snapshot();
    const [session] = brokerState.sessions;
    const settlementKey = signalSettlementKey('pi_example', input);
    const ledgerKey = digestBrokerValue(['pi_example', 'events.publish', settlementKey]);
    await store.transaction((transaction) => {
      transaction.calls.put({
        ledgerKey,
        brokerSessionId: session.brokerSessionId,
        runtimeLeaseId: session.runtimeLeaseId,
        pluginInstanceId: 'pi_example',
        packageDigest: session.packageDigest,
        grantRevision: session.grantRevision,
        method: 'events.publish',
        settlementKey,
        inputDigest: digestBrokerValue(input),
        phase: 'dispatched',
        revision: 2,
        createdAt: 10_000,
        updatedAt: 10_000,
      });
    });

    await assert.rejects(connection.call('events.publish', input), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal((await intakes.list()).length, 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'dispatched');
  });
});
