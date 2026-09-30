/**
 * F202 Train C1 — the Host→plugin direction over the in-process module carrier.
 *
 * This is the TypeScript shape of the SPI the operator described: the carrier already holds
 * what the package's `create(manifest)` returned, so calling a method the package declared is
 * a function call on that instance. No new transport, and nothing here is message-specific —
 * outbound delivery is one caller, a schedule firing would be another.
 *
 * REJECTION IS LOAD-BEARING, WHICH IS WHY THE NEGATIVE CASES MATTER MORE THAN THE HAPPY ONE.
 * So a method the package never implemented must reject rather than quietly do nothing.
 * Protocol-specific callers validate their own input and result at the carrier boundary.
 *
 * DECLARED NAMES ARE NOT TRUSTED NAMES. The method name arrives from a package manifest, so it
 * is attacker-influenced input reaching a property lookup. `toString`, `constructor` and
 * `__proto__` all resolve to something callable on any object; invoking them would run
 * Host-side code the package never wrote and report success for it. Only a method the instance
 * actually owns may be called.
 *
 * STATUS when written: RED — `builtin-runtime/module-host-invocation.js` does not exist.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createModuleHostInvocation;
let invocation;
let loaded;
let calls;

const INSTANCE = 'inst-feishu';

beforeEach(async () => {
  ({ createModuleHostInvocation } = await import('../dist/domains/plugin/builtin-runtime/module-host-invocation.js'));
  calls = [];
  loaded = new Map();
  invocation = createModuleHostInvocation({
    runtime: {
      actions(pluginInstanceId) {
        return loaded.get(pluginInstanceId);
      },
    },
  });
});

function load(instanceId, methods) {
  loaded.set(instanceId, methods);
}

const INPUT = {
  deliveryId: 'delivery-1',
  threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
  envelope: {
    messageId: 'message-1',
    revision: 1,
    threadId: 'thread-1',
    actor: { kind: 'cat', id: 'opus' },
    audience: { kind: 'public' },
    occurredAt: '2026-09-21T00:00:00.000Z',
    payload: {
      provenance: { epistemicStatus: 'inference', origin: { kind: 'host' } },
      elements: [{ elementId: 'e1', kind: 'text', payload: { text: 'hello' } }],
    },
  },
};

describe('F202 C1 — generic Host invocation over the module carrier', () => {
  test('case 0: invokes any package-declared action by its exact name', async () => {
    load(INSTANCE, {
      async 'fixture.echo'(input) {
        calls.push(input);
        return { echoed: input };
      },
    });

    assert.deepEqual(await invocation.invoke(INSTANCE, 'fixture.echo', { value: 7 }), {
      echoed: { value: 7 },
    });
    assert.deepEqual(calls, [{ value: 7 }]);
  });

  test('case 1: calls host.messaging.deliver as an ordinary declared action', async () => {
    load(INSTANCE, {
      async 'host.messaging.deliver'(input) {
        calls.push(input);
        return { deliveryId: input.deliveryId };
      },
    });

    const result = await invocation.invoke(INSTANCE, 'host.messaging.deliver', INPUT);

    assert.deepEqual(calls, [INPUT]);
    assert.deepEqual(result, { deliveryId: INPUT.deliveryId });
  });

  test('case 2: a module without the requested action rejects', async () => {
    load(INSTANCE, { outbound: async () => {} });

    await assert.rejects(
      () => invocation.invoke(INSTANCE, 'host.messaging.deliver', INPUT),
      (err) => err.code === 'PROTOCOL_VIOLATION',
      'silently succeeding would mark a message delivered that nobody received',
    );
  });

  test('case 3: a rejection from the package reaches the caller unchanged', async () => {
    const boom = new Error('feishu API is down');
    load(INSTANCE, {
      async 'host.messaging.deliver'() {
        throw boom;
      },
    });

    await assert.rejects(
      () => invocation.invoke(INSTANCE, 'host.messaging.deliver', INPUT),
      (err) => err === boom,
    );
  });

  test('case 4: calling an instance the Host is not holding rejects', async () => {
    await assert.rejects(
      () => invocation.invoke('inst-never-started', 'host.messaging.deliver', INPUT),
      (err) => err.code === 'INSTANCE_NOT_RUNNABLE',
    );
  });

  test('case 5: inherited object methods are never treated as declared actions', async () => {
    load(INSTANCE, Object.create({ constructor: async () => 'not package code' }));

    await assert.rejects(
      () => invocation.invoke(INSTANCE, 'constructor', {}),
      (err) => err.code === 'PROTOCOL_VIOLATION',
    );
  });
});
