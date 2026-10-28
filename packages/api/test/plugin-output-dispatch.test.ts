import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type OutputDispatchPorts,
  type OutputDispatchRequest,
  type OutputOperation,
  type OutputOperationStore,
  OutputProducerRefused,
  PluginOutputDispatch,
} from '../src/domains/plugin/outputs/output-dispatch.js';

const request: OutputDispatchRequest = {
  operationId: 'host-instance/thread/call-1',
  targetKeys: ['canonical-directory/song.mp3', 'canonical-directory/song.mp3.provenance.json'],
  parameters: { prompt: 'Gentle piano', model: 'test-producer' },
};

/** Fixture persistence port: tests coordinator decisions, not filesystem crash durability. */
function store(): OutputOperationStore {
  const rows = new Map<string, OutputOperation>();
  return {
    async get(id) {
      return structuredClone(rows.get(id));
    },
    async create(row) {
      if (rows.has(row.id)) return false;
      rows.set(row.id, structuredClone(row));
      return true;
    },
    async replace(revision, row) {
      if (rows.get(row.id)?.revision !== revision) return false;
      rows.set(row.id, structuredClone(row));
      return true;
    },
  };
}

function harness(overrides: Partial<OutputDispatchPorts> = {}) {
  let produced = 0;
  let deliveries = 0;
  let durableResult: string | undefined;
  const ports: OutputDispatchPorts = {
    store: store(),
    async authorize() {},
    async reserve() {
      return 'host-reservation';
    },
    async produce(input) {
      produced += 1;
      assert.equal((await ports.store.get(input.operationId))?.phase, 'dispatched');
      durableResult = 'owned-media-source';
      return durableResult;
    },
    async lookupProduced() {
      return durableResult;
    },
    async accept() {},
    async deliver() {
      deliveries += 1;
    },
    ...overrides,
  };
  return { ports, dispatch: new PluginOutputDispatch(ports), produced: () => produced, deliveries: () => deliveries };
}

test('reserves every output before dispatch; refuses existing sidecar with zero producer calls', async () => {
  const h = harness({
    reserve: async () => {
      throw new Error('sidecar exists');
    },
  });
  assert.deepEqual(await h.dispatch.run(request), { state: 'rejected', code: 'reservation_failed' });
  assert.equal(h.produced(), 0);
  assert.equal((await h.ports.store.get(request.operationId))?.phase, 'rejected');
});

test('same operation replays completion and rejects changed parameters', async () => {
  const h = harness();
  assert.deepEqual(await h.dispatch.run(request), { state: 'delivered' });
  assert.deepEqual(await h.dispatch.run(request), { state: 'delivered' });
  await assert.rejects(h.dispatch.run({ ...request, parameters: { prompt: 'Different' } }), /operation_conflict/);
  assert.equal(h.produced(), 1);
  assert.equal(h.deliveries(), 1);
});

test('same-operation races acquire at most one producer dispatch', async () => {
  const h = harness();
  await Promise.all([h.dispatch.run(request), h.dispatch.run(request), h.dispatch.run(request)]);
  assert.equal(h.produced(), 1);
  assert.deepEqual(await h.dispatch.run(request), { state: 'delivered' });
});

test('an uncertain producer result is not dispatched again after coordinator recreation', async () => {
  let attempts = 0;
  const h = harness({
    produce: async () => {
      attempts += 1;
      throw new Error('response lost');
    },
  });
  assert.deepEqual(await h.dispatch.run(request), { state: 'generation_unknown' });
  const restarted = new PluginOutputDispatch(h.ports);
  assert.deepEqual(await restarted.run(request), { state: 'generation_unknown' });
  assert.equal(attempts, 1);
});

test('a lost response can recover only the existing producer-owned result', async () => {
  let attempts = 0;
  let available = false;
  const h = harness({
    produce: async () => {
      attempts += 1;
      available = true;
      throw new Error('response lost');
    },
    lookupProduced: async () => (available ? 'already-durable-media' : undefined),
  });
  assert.deepEqual(await h.dispatch.run(request), { state: 'generation_unknown' });
  assert.deepEqual(await new PluginOutputDispatch(h.ports).run(request), { state: 'delivered' });
  assert.equal(attempts, 1);
});

test('partial delivery recovers using the same source and reservation without generation', async () => {
  let attempts = 0;
  const h = harness({
    deliver: async (reservation, source) => {
      assert.equal(reservation, 'host-reservation');
      assert.equal(source, 'owned-media-source');
      attempts += 1;
      if (attempts === 1) throw new Error('MP3 complete, sidecar pending');
    },
  });
  assert.deepEqual(await h.dispatch.run(request), { state: 'delivery_required' });
  assert.equal((await h.ports.store.get(request.operationId))?.phase, 'produced');
  assert.deepEqual(await new PluginOutputDispatch(h.ports).run(request), { state: 'delivered' });
  assert.equal(h.produced(), 1);
  assert.equal(attempts, 2);
});

test('authority lost after production preserves the result for delivery-only recovery', async () => {
  let authorized = true;
  const h = harness({
    accept: async () => {
      authorized = false;
    },
  });
  h.ports.authorize = async () => {
    if (!authorized) throw new Error('authority revoked');
  };
  assert.deepEqual(await h.dispatch.run(request), { state: 'delivery_required' });
  assert.equal(h.produced(), 1);
  assert.equal(h.deliveries(), 0);
  assert.equal((await h.ports.store.get(request.operationId))?.sourceRef, 'owned-media-source');
});

test('canonical target alias collisions and empty sets fail before producer work', async () => {
  const h = harness();
  await assert.rejects(h.dispatch.run({ ...request, targetKeys: ['same-target', 'same-target'] }), /invalid_targets/);
  await assert.rejects(h.dispatch.run({ ...request, targetKeys: [] }), /invalid_targets/);
  assert.equal(h.produced(), 0);
});

test('missing admission authority never invokes producer or reserves files', async () => {
  let reservations = 0;
  const h = harness({
    authorize: async () => {
      throw new Error('contract or permission unavailable');
    },
    reserve: async () => {
      reservations += 1;
      return 'forbidden';
    },
  });
  await assert.rejects(h.dispatch.run(request), /permission unavailable/);
  assert.equal(reservations, 0);
  assert.equal(h.produced(), 0);
});

test('captures the admitted parameters before asynchronous authority checks', async () => {
  const input = structuredClone(request) as {
    operationId: string;
    targetKeys: string[];
    parameters: Record<string, unknown>;
  };
  let actual: Pick<OutputDispatchRequest, 'operationId' | 'parameters'> | undefined;
  const h = harness({
    produce: async (value) => {
      actual = value;
      return 'owned';
    },
  });
  const running = h.dispatch.run(input);
  input.parameters.prompt = 'Changed after admission';
  input.targetKeys[0] = 'another-target';
  await running;
  assert.deepEqual(actual, { operationId: request.operationId, parameters: request.parameters });
});

test('different instances still share target admission and only the winning operation produces', async () => {
  const reserved = new Set<string>();
  let producers = 0;
  const shared: Partial<OutputDispatchPorts> = {
    reserve: async (value) => {
      if (value.targetKeys.some((key) => reserved.has(key))) throw new Error('target already reserved');
      for (const key of value.targetKeys) reserved.add(key);
      return 'shared-target-reservation';
    },
    produce: async () => {
      producers += 1;
      return 'owned';
    },
  };
  const first = harness(shared);
  const second = harness(shared);
  const results = await Promise.all([
    first.dispatch.run(request),
    second.dispatch.run({ ...request, operationId: 'different-instance/thread/call-2' }),
  ]);
  assert.equal(producers, 1);
  assert.equal(results.filter((row) => row.state === 'rejected').length, 1);
});

test('a structured producer refusal is terminal and does not become an uncertain retry', async () => {
  let attempts = 0;
  const h = harness({
    produce: async () => {
      attempts += 1;
      throw new OutputProducerRefused();
    },
  });
  const refused = { state: 'rejected', reason: 'producer_refused' };
  assert.deepEqual(await h.dispatch.run(request), refused);
  assert.deepEqual(await new PluginOutputDispatch(h.ports).run(request), refused);
  assert.equal(attempts, 1);
});
