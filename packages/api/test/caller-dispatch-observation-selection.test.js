import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CallerDispatchObservationRegistry } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);

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

const scope = { ownerId: 'owner-1', threadId: 'thread-1', callerCatId: 'caller' };

describe('CallerDispatchObservationRegistry selection and generation state', () => {
  it('retains initial and Steer selection facts after a target leaves Queue', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({ refs: [] });
    registry.registerInitialSource(source, ['c', 'd']);
    registry.registerSteerChanges(source, { addedTargetIds: ['e'], removedTargetIds: ['c'] });

    const entries = new Map(registry.list(scope).map((entry) => [entry.targetId, entry]));
    assert.equal(entries.get('c').firstAddedBy, 'initial');
    assert.equal(entries.get('c').selectionChange, 'removed');
    assert.equal(entries.get('c').selectionChangedBy, 'steer');
    assert.equal(entries.get('e').firstAddedBy, 'steer');
    assert.equal(entries.get('e').selectionChange, 'added');
    assert.equal(entries.get('e').selectionChangedBy, 'steer');

    const projection = await registry.project({ getById: async (id) => (id === source.id ? source : null) }, scope);
    assert.match(projection.prompt, /source-1 → c: not_delivered\(withdrawn by committed Steer\)/);
    assert.match(projection.prompt, /source-1 → d: pending; selectedBy=initial/);
    assert.match(projection.prompt, /source-1 → e: pending; selectedBy=steer/);
  });

  it('does not guess the original selection source when this runtime first sees a removal', () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({ refs: [] });
    registry.registerSteerChanges(source, { addedTargetIds: [], removedTargetIds: ['c'] });

    assert.equal(registry.list(scope)[0].firstAddedBy, 'unknown');
    assert.equal(registry.list(scope)[0].selectionChange, 'removed');
    assert.equal(registry.list(scope)[0].selectionChangedBy, 'steer');
  });

  it('distinguishes whole-Queue cancellation from a Steer target removal', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({ refs: [] });
    registry.registerInitialSource(source, ['b']);
    registry.registerQueueWithdrawalByIdentity({
      ownerId: source.userId,
      threadId: source.threadId,
      callerCatId: 'caller',
      sourceMessageId: source.id,
      targetIds: ['b'],
    });

    const pointer = registry.list(scope)[0];
    assert.equal(pointer.selectionChange, 'removed');
    assert.equal(pointer.selectionChangedBy, 'queue_withdrawal');
    const projection = await registry.project({ getById: async () => source }, scope);
    assert.match(projection.prompt, /not_delivered\(withdrawn by committed Queue cancellation\)/);
    assert.doesNotMatch(projection.prompt, /Steer/);
  });

  it('does not attach a newer Steer revision to a line read from an older snapshot', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({ refs: [] });
    registry.registerInitialSource(source, ['c']);
    let releaseRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const release = new Promise((resolve) => {
      releaseRead = resolve;
    });

    const projecting = registry.project(
      {
        getById: async () => {
          markReadStarted();
          await release;
          return source;
        },
      },
      scope,
    );
    await readStarted;
    registry.registerSteerChanges(source, { addedTargetIds: [], removedTargetIds: ['c'] });
    releaseRead();

    const stale = await projecting;
    assert.equal(stale.prompt, '');
    assert.equal(stale.included.length, 0);
    const next = await registry.project({ getById: async () => source }, scope);
    assert.match(next.prompt, /not_delivered/);
  });

  it('allocates a newer revision when an acknowledged key is recreated', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const source = inputMessage({ refs: [] });
    registry.registerInitialSource(source, ['c']);
    registry.registerSteerChanges(source, { addedTargetIds: [], removedTargetIds: ['c'] });
    const store = { getById: async () => source };

    const withdrawn = await registry.project(store, scope);
    const withdrawnRevision = withdrawn.included[0].includedRevision;
    registry.acknowledge(withdrawn.included);
    assert.equal(registry.list(scope).length, 0);

    registry.registerSteerChanges(source, { addedTargetIds: ['c'], removedTargetIds: [] });
    const recreated = registry.list(scope)[0];
    assert.ok(recreated.revision > withdrawnRevision);
    assert.equal(recreated.firstAddedBy, 'steer');
  });

  it('ignores user-authored sources because observations belong to the dispatching member', () => {
    const registry = new CallerDispatchObservationRegistry();
    registry.registerPersistedSource(
      inputMessage({
        from: { kind: 'user', userId: 'owner-1' },
        refs: [{ targetId: 'b', phase: 'settled', statusMessageId: 'response-b', dispatchedAt: 2 }],
      }),
      ['b'],
    );
    assert.equal(registry.list(scope).length, 0);
  });

  it('projects one neutral process-start notice per scope and exact process generation', () => {
    const registry = new CallerDispatchObservationRegistry();
    const first = registry.projectProcessStartNotice(scope, 'api:123:7');
    assert.match(first.prompt, /process_start processGeneration=api:123:7/);
    assert.match(first.prompt, /仅覆盖本 API 进程登记的 dispatch/);
    assert.match(first.prompt, /canonical History/);
    assert.doesNotMatch(first.prompt, /runtime_restart|recoveryRequired|丢失/);

    registry.acknowledgeProcessStartNotice(scope, 'api:wrong:8');
    assert.match(registry.projectProcessStartNotice(scope, 'api:123:7').prompt, /process_start/);
    registry.acknowledgeProcessStartNotice(scope, 'api:123:7');
    assert.equal(registry.projectProcessStartNotice(scope, 'api:123:7').prompt, '');
    assert.match(registry.projectProcessStartNotice(scope, 'api:124:9').prompt, /processGeneration=api:124:9/);
  });

  it('acknowledges process-start without clearing current-process observations', () => {
    const registry = new CallerDispatchObservationRegistry();
    registry.registerPersistedSource(
      inputMessage({ refs: [{ targetId: 'b', phase: 'dispatched', statusMessageId: 'response-b', dispatchedAt: 2 }] }),
      ['b'],
    );

    registry.projectProcessStartNotice(scope, 'api:123:7');
    registry.acknowledgeProcessStartNotice(scope, 'api:123:7');
    assert.equal(registry.projectProcessStartNotice(scope, 'api:123:7').prompt, '');
    assert.equal(registry.list(scope).length, 1);
  });

  it('bounds retained items and History reads for one caller slot', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const messages = new Map();
    for (let index = 0; index < 140; index += 1) {
      const source = inputMessage({ id: `source-${index}`, refs: [] });
      messages.set(source.id, source);
      registry.registerInitialSource(source, ['b']);
    }
    assert.equal(registry.list(scope).length, 128);

    let reads = 0;
    const projection = await registry.project(
      {
        getById: async (id) => {
          reads += 1;
          return messages.get(id) ?? null;
        },
      },
      scope,
      100_000,
    );
    assert.equal(reads, 64);
    assert.equal(projection.included.length, 64);
    assert.equal(projection.truncated, true);
  });
});
