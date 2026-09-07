import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F276 Memory Operations system thread', () => {
  it('creates one reusable memory_ops thread and indexes it for the owner', async () => {
    const { ensureMemoryOperationsThread, memoryOperationsThreadId } = await import(
      '../dist/domains/memory/MemoryOperationsThread.js'
    );
    const expectedThreadId = memoryOperationsThreadId('owner-1');
    const calls = [];
    const threadStore = {
      async get() {
        return null;
      },
      async ensureThread(...args) {
        calls.push(['ensure', ...args]);
      },
      async updateSystemKind(...args) {
        calls.push(['kind', ...args]);
      },
      async indexForUser(...args) {
        calls.push(['index', ...args]);
      },
    };

    assert.equal(await ensureMemoryOperationsThread(threadStore, 'owner-1'), expectedThreadId);
    assert.deepEqual(calls, [
      ['ensure', expectedThreadId, '记忆整理'],
      ['kind', expectedThreadId, 'memory_ops'],
      ['index', expectedThreadId, 'owner-1'],
    ]);
    assert.notEqual(memoryOperationsThreadId('owner-2'), expectedThreadId);
  });
});
