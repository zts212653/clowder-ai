import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CallerDispatchObservationRegistry, callerDispatchObservationKey } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function inputMessage({ refs, from = { kind: 'agent', catId: 'caller' }, id = 'source-1' }) {
  return {
    id,
    threadId: 'thread-1',
    userId: 'owner-1',
    from,
    content: 'please investigate',
    timestamp: 1,
    lifecycle: { kind: 'input', orderKey: `1:${id}`, dispatchRefs: refs },
  };
}

function responseMessage(id, targetId, status, content = `${targetId} result`, sourceMessageId = 'source-1') {
  return {
    id,
    threadId: 'thread-1',
    userId: 'owner-1',
    from: { kind: 'agent', catId: targetId },
    content,
    timestamp: 2,
    lifecycle: {
      kind: 'response',
      orderKey: `2:${id}`,
      invocationId: `inv-${targetId}`,
      targetId,
      inputEntryIds: ['entry-1'],
      inputMessageIds: [sourceMessageId],
      status,
      startedAt: 2,
      ...(status === 'processing' ? {} : { completedAt: 3 }),
    },
  };
}

const scope = { ownerId: 'owner-1', threadId: 'thread-1', callerCatId: 'caller' };

describe('CallerDispatchObservationRegistry', () => {
  it('projects exact terminal/open targets and clears only terminal keys included in the prompt', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({
      refs: [
        { targetId: 'b', phase: 'settled', statusMessageId: 'response-b', dispatchedAt: 2 },
        { targetId: 'c', phase: 'dispatched', statusMessageId: 'response-c', dispatchedAt: 2 },
      ],
    });
    registry.registerPersistedSource(source, ['b', 'c']);
    registry.registerPersistedSource(source, ['b']);

    const messages = new Map([
      [source.id, source],
      ['response-b', responseMessage('response-b', 'b', 'completed')],
      ['response-c', responseMessage('response-c', 'c', 'processing')],
    ]);
    const projection = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);

    assert.match(projection.prompt, /source-1 → b: completed/);
    assert.match(projection.prompt, /source-1 → c: executing/);
    assert.deepEqual(
      projection.included.filter((item) => item.terminal).map((item) => item.key),
      [callerDispatchObservationKey({ ...scope, sourceMessageId: 'source-1', targetId: 'b' })],
    );

    const currentTurnSource = inputMessage({
      id: 'source-current-turn',
      refs: [{ targetId: 'd', phase: 'dispatched', statusMessageId: 'response-d', dispatchedAt: 4 }],
    });
    registry.registerPersistedSource(currentTurnSource, ['d']);
    registry.acknowledge(projection.included);
    assert.deepEqual(
      registry.list(scope).map((pointer) => pointer.targetId),
      ['c', 'd'],
    );
  });

  it('follows the source ref when delivery failure replaces the original response identity', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({
      refs: [{ targetId: 'b', phase: 'settled', statusMessageId: 'failure-b', dispatchedAt: 2 }],
    });
    const failure = {
      id: 'failure-b',
      threadId: 'thread-1',
      userId: 'owner-1',
      from: { kind: 'system', service: 'message-delivery' },
      catId: null,
      content: 'b could not start',
      timestamp: 3,
      lifecycle: {
        kind: 'delivery_failure',
        orderKey: '3:failure-b',
        status: 'failed',
        sourceEntryId: 'entry-1',
        inputMessageId: 'source-1',
        requestedTargets: ['b'],
        reason: 'prestart_timeout',
        createdAt: 3,
      },
    };
    registry.registerPersistedSource(source, ['b']);
    const messages = new Map([
      [source.id, source],
      [failure.id, failure],
    ]);

    const projection = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
    assert.match(projection.prompt, /delivery_failure\(prestart_timeout\)/);
    assert.match(projection.prompt, /b could not start/);
    assert.equal(projection.included.filter((item) => item.terminal).length, 1);
  });

  it('keeps same-target dispatches from different sources independent and projects every response terminal', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const terminals = ['failed', 'canceled', 'interrupted'];
    const messages = new Map();
    for (const [index, status] of terminals.entries()) {
      const sourceId = `source-${status}`;
      const responseId = `response-${status}`;
      const source = inputMessage({
        id: sourceId,
        refs: [{ targetId: 'b', phase: 'settled', statusMessageId: responseId, dispatchedAt: index + 2 }],
      });
      const response = responseMessage(responseId, 'b', status, `${status} body`, sourceId);
      messages.set(sourceId, source);
      messages.set(responseId, response);
      registry.registerPersistedSource(source, ['b']);
    }

    const projection = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
    for (const status of terminals) {
      assert.match(projection.prompt, new RegExp(`source-${status} → b: ${status}`));
      assert.match(projection.prompt, new RegExp(`${status} body`));
    }
    assert.equal(projection.included.filter((item) => item.terminal).length, terminals.length);
    assert.equal(new Set(projection.included.map((item) => item.key)).size, terminals.length);
  });

  it('keeps two pending sources for the same target as independent caller view items', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const first = inputMessage({ id: 'source-m1', refs: [] });
    const second = inputMessage({ id: 'source-m2', refs: [] });
    registry.registerInitialSource(first, ['b']);
    registry.registerInitialSource(second, ['b']);
    const messages = new Map([
      [first.id, first],
      [second.id, second],
    ]);

    const projection = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);

    assert.match(projection.prompt, /source-m1 → b: pending/);
    assert.match(projection.prompt, /source-m2 → b: pending/);
    assert.equal(projection.included.length, 2);
    assert.equal(new Set(projection.included.map((item) => item.key)).size, 2);
  });

  it('retains unknown and budget-truncated terminal observations', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({
      refs: [{ targetId: 'b', phase: 'settled', statusMessageId: 'response-b', dispatchedAt: 2 }],
    });
    registry.registerPersistedSource(source, ['b']);

    const unknown = await registry.project({ getById: async () => null }, scope);
    assert.match(unknown.prompt, /unknown/);
    assert.equal(unknown.included.length, 1);
    assert.equal(unknown.included[0].terminal, false);

    const messages = new Map([
      [source.id, source],
      ['response-b', responseMessage('response-b', 'b', 'completed', 'x'.repeat(2_000))],
    ]);
    const truncated = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope, 80);
    assert.equal(truncated.truncated, true);
    assert.deepEqual(truncated.included, []);
    assert.equal(registry.list(scope).length, 1);
  });

  it('does not expose or consume a deleted terminal response fetched by exact id', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const store = new MessageStore();
    const source = store.append(
      inputMessage({
        refs: [{ targetId: 'b', phase: 'settled', statusMessageId: 'response-b', dispatchedAt: 2 }],
      }),
    );
    const response = store.append(responseMessage('ignored-id', 'b', 'completed', 'deleted secret', source.id));
    source.lifecycle.dispatchRefs[0] = {
      targetId: 'b',
      phase: 'settled',
      statusMessageId: response.id,
      dispatchedAt: 2,
    };
    registry.registerPersistedSource(source, ['b']);
    store.softDelete(response.id, 'owner-1');

    const projection = await registry.project(store, scope);
    assert.match(projection.prompt, /unknown/);
    assert.doesNotMatch(projection.prompt, /deleted secret/);
    assert.equal(projection.included.length, 1);
    assert.equal(projection.included[0].terminal, false);
    assert.equal(registry.list(scope).length, 1);
  });

  it('retains unknown when a settled ref points at another target or source lineage', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({
      refs: [{ targetId: 'b', phase: 'settled', statusMessageId: 'response-other', dispatchedAt: 2 }],
    });
    registry.registerPersistedSource(source, ['b']);
    const wrongTarget = responseMessage('response-other', 'c', 'completed', 'wrong target result');
    const messages = new Map([
      [source.id, source],
      [wrongTarget.id, wrongTarget],
    ]);

    const targetMismatch = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
    assert.match(targetMismatch.prompt, /unknown/);
    assert.doesNotMatch(targetMismatch.prompt, /wrong target result/);
    assert.equal(targetMismatch.included.length, 1);
    assert.equal(targetMismatch.included[0].terminal, false);

    messages.set(
      'response-other',
      responseMessage('response-other', 'b', 'completed', 'wrong source result', 'source-2'),
    );
    const sourceMismatch = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
    assert.match(sourceMismatch.prompt, /unknown/);
    assert.doesNotMatch(sourceMismatch.prompt, /wrong source result/);
    assert.equal(sourceMismatch.included.length, 1);
    assert.equal(sourceMismatch.included[0].terminal, false);
  });

  it('prioritizes changed terminal facts over still-open facts when the prompt budget is tight', async () => {
    const source = inputMessage({
      refs: [
        { targetId: 'open', phase: 'dispatched', statusMessageId: 'response-open', dispatchedAt: 2 },
        { targetId: 'done', phase: 'settled', statusMessageId: 'response-done', dispatchedAt: 2 },
      ],
    });
    const messages = new Map([
      [source.id, source],
      ['response-open', responseMessage('response-open', 'open', 'processing')],
      ['response-done', responseMessage('response-done', 'done', 'completed', 'done body')],
    ]);
    const store = { getById: async (id) => messages.get(id) ?? null };
    const terminalOnly = new CallerDispatchObservationRegistry();
    terminalOnly.registerPersistedSource(source, ['done']);
    const terminalBudget = (await terminalOnly.project(store, scope)).prompt.length;

    const registry = new CallerDispatchObservationRegistry();
    registry.registerPersistedSource(source, ['open', 'done']);
    const projection = await registry.project(store, scope, terminalBudget);
    assert.match(projection.prompt, /source-1 → done: completed/);
    assert.doesNotMatch(projection.prompt, /source-1 → open: executing/);
    assert.equal(projection.included.filter((item) => item.terminal).length, 1);
    assert.equal(projection.truncated, true);
    assert.ok(projection.prompt.length <= terminalBudget);
  });

  it('does not consume a target that becomes terminal after this turn projection was built', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({
      refs: [{ targetId: 'b', phase: 'dispatched', statusMessageId: 'response-b', dispatchedAt: 2 }],
    });
    const response = responseMessage('response-b', 'b', 'processing');
    const messages = new Map([
      [source.id, source],
      [response.id, response],
    ]);
    registry.registerPersistedSource(source, ['b']);

    const beforeTerminal = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
    assert.match(beforeTerminal.prompt, /source-1 → b: executing/);
    assert.equal(beforeTerminal.included.filter((item) => item.terminal).length, 0);

    source.lifecycle.dispatchRefs[0] = {
      targetId: 'b',
      phase: 'settled',
      statusMessageId: 'response-b',
      dispatchedAt: 2,
    };
    response.lifecycle.status = 'completed';
    response.lifecycle.completedAt = 3;
    registry.acknowledge(beforeTerminal.included);

    const nextTurn = await registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
    assert.match(nextTurn.prompt, /source-1 → b: completed/);
    assert.equal(nextTurn.included.filter((item) => item.terminal).length, 1);
  });

  it('acknowledges an unchanged pending version without deleting it or repeating it', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({ refs: [] });
    registry.registerInitialSource(source, ['b']);
    const store = { getById: async (id) => (id === source.id ? source : null) };

    const first = await registry.project(store, scope);
    assert.match(first.prompt, /source-1 → b: pending; selectedBy=initial/);
    assert.equal(first.included.length, 1);
    const pendingRevision = first.included[0].includedRevision;
    registry.acknowledge(first.included);

    const second = await registry.project(store, scope);
    assert.equal(second.prompt, '');
    assert.equal(second.included.length, 0);
    assert.equal(registry.list(scope).length, 1);

    source.lifecycle.dispatchRefs.push({
      targetId: 'b',
      phase: 'dispatched',
      statusMessageId: 'response-b',
      dispatchedAt: 2,
    });
    const changed = await registry.project(store, scope);
    assert.match(changed.prompt, /source-1 → b: executing/);
    assert.ok(changed.included[0].includedRevision > pendingRevision);
  });
});
