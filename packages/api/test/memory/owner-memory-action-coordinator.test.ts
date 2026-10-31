import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import { SessionMutex } from '../../src/domains/cats/services/agents/invocation/SessionMutex.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../../src/domains/memory/owner/OwnerMemoryActionCoordinator.js';

const context = {
  ownerUserId: 'owner',
  lane: 'event' as const,
  memoryId: 'evt_1',
  requestId: 'owner-action:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
};

function receipt(revision: string): MemoryOwnerActionReceipt {
  return {
    action: 'correct',
    outcome: 'applied',
    memoryId: context.memoryId,
    revision,
    status: 'active',
  };
}

describe('F321 owner memory action coordinator', () => {
  it('replays one completed request without executing the mutation twice', async () => {
    const coordinator = new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
      now: () => 42,
    });
    let executions = 0;
    const input = { ...context, command: { action: 'correct', expectedRevision: 'r1', patch: { summary: 'new' } } };

    const first = await coordinator.execute(input, {
      run: async () => {
        executions += 1;
        return { status: 'applied', receipt: receipt('r2') };
      },
    });
    const replay = await coordinator.execute(input, {
      run: async () => {
        executions += 1;
        return { status: 'applied', receipt: receipt('r3') };
      },
    });

    assert.equal(executions, 1);
    assert.deepEqual(first, receipt('r2'));
    assert.deepEqual(replay, { ...receipt('r2'), outcome: 'replayed' });
  });

  it('rejects reuse of one requestId with a different command digest', async () => {
    const coordinator = new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
    });
    await coordinator.execute(
      { ...context, command: { action: 'correct', expectedRevision: 'r1', patch: { summary: 'first' } } },
      { run: async () => ({ status: 'applied', receipt: receipt('r2') }) },
    );

    const conflict = await coordinator.execute(
      { ...context, command: { action: 'correct', expectedRevision: 'r1', patch: { summary: 'second' } } },
      { run: async () => ({ status: 'applied', receipt: receipt('r3') }) },
    );
    assert.deepEqual(conflict, { error: 'idempotency_conflict' });
  });

  it('clears a non-mutating failure so the same request can succeed after a fresh read', async () => {
    const coordinator = new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
    });
    const input = { ...context, command: { action: 'correct', expectedRevision: 'r1', patch: { summary: 'new' } } };
    const stale = await coordinator.execute(input, {
      run: async () => ({ status: 'rejected', error: 'stale_revision' }),
    });
    const applied = await coordinator.execute(input, {
      run: async () => ({ status: 'applied', receipt: receipt('r2') }),
    });

    assert.deepEqual(stale, { error: 'stale_revision' });
    assert.deepEqual(applied, receipt('r2'));
  });

  it('recovers a crash-window mutation from a durable pending receipt', async () => {
    const store = new InMemoryOwnerMemoryActionReceiptStore();
    const coordinator = new OwnerMemoryActionCoordinator({ store, lock: new SessionMutex() });
    const input = { ...context, command: { action: 'hard_forget', expectedRevision: 'r1', confirmed: true } };

    await assert.rejects(
      coordinator.execute(input, {
        run: async () => {
          throw new Error('lost acknowledgement after commit');
        },
      }),
      /lost acknowledgement/,
    );

    let reran = false;
    const recovered = await coordinator.execute(input, {
      recover: async () => receipt('r2'),
      run: async () => {
        reran = true;
        return { status: 'applied', receipt: receipt('r3') };
      },
    });

    assert.equal(reran, false);
    assert.deepEqual(recovered, { ...receipt('r2'), outcome: 'replayed' });
  });
});
