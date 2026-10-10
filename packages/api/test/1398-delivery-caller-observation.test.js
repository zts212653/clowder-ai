// Delivery transfers responsibility to the exact member response; its result settles the source.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CallerDispatchObservationRegistry } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);

const scope = { ownerId: 'owner-1', threadId: 'thread-1', callerCatId: 'caller' };

function source(ref) {
  return {
    id: 'source-append',
    threadId: scope.threadId,
    userId: scope.ownerId,
    from: { kind: 'agent', catId: scope.callerCatId },
    content: 'also check the flaky test',
    timestamp: 1,
    lifecycle: { kind: 'input', orderKey: '1:source-append', dispatchRefs: [ref] },
  };
}

function response(status, lists) {
  return {
    id: 'response-worker',
    threadId: scope.threadId,
    userId: scope.ownerId,
    from: { kind: 'agent', catId: 'worker' },
    content: status === 'processing' ? '' : 'done without it',
    timestamp: 2,
    lifecycle: {
      kind: 'response',
      orderKey: '2:response-worker',
      invocationId: 'inv-worker',
      targetId: 'worker',
      inputEntryIds: ['entry-first'],
      inputMessageIds: ['message-first'],
      ...lists,
      status,
      startedAt: 1,
      ...(status === 'processing' ? {} : { completedAt: 3 }),
    },
  };
}

const ref = (extra) => ({ targetId: 'worker', statusMessageId: 'response-worker', dispatchedAt: 2, ...extra });

async function project(registry, messages) {
  return registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
}

describe('caller observes delivery and member outcomes', () => {
  it('reports accepted Append as executing once, without waiting for a model-read transition', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const accepted = source(ref({ phase: 'dispatched' }));
    const running = response('processing', {
      inputEntryIds: ['entry-first', 'entry-append'],
      inputMessageIds: ['message-first', accepted.id],
    });
    registry.registerPersistedSource(accepted, ['worker']);
    const messages = new Map([
      [accepted.id, accepted],
      [running.id, running],
    ]);
    let projection = await project(registry, messages);
    assert.match(projection.prompt, /source-append → worker: executing/);
    assert.equal(projection.included[0]?.terminal, false);
    registry.acknowledge(projection.included);
    registry.registerPersistedSource(accepted, ['worker']);
    projection = await project(registry, messages);
    assert.equal(projection.included.length, 0, 'unchanged delivery is not a second observation');
  });

  for (const status of ['failed', 'canceled']) {
    it(`reports the exact member ${status} outcome for an appended input`, async () => {
      const registry = new CallerDispatchObservationRegistry();
      const accepted = source(ref({ phase: 'settled' }));
      const ended = response(status, {
        inputEntryIds: ['entry-first', 'entry-append'],
        inputMessageIds: ['message-first', accepted.id],
      });
      registry.registerPersistedSource(accepted, ['worker']);
      const projection = await project(
        registry,
        new Map([
          [accepted.id, accepted],
          [ended.id, ended],
        ]),
      );
      assert.match(projection.prompt, new RegExp(`source-append → worker: ${status}; response=response-worker`));
      assert.equal(projection.included[0]?.terminal, true);
    });
  }

  it('does not attribute a response which does not index the source', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const accepted = source(ref({ phase: 'settled' }));
    const ended = response('completed', {});
    registry.registerPersistedSource(accepted, ['worker']);
    const projection = await project(
      registry,
      new Map([
        [accepted.id, accepted],
        [ended.id, ended],
      ]),
    );
    assert.match(projection.prompt, /unknown/);
    assert.equal(projection.included[0]?.terminal, false);
  });
});
