import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateThreadArtifacts } from '../src/domains/cats/services/agents/routing/thread-artifacts-aggregator.js';

test('ledger projections retain the owner key across updates; a standalone message diff has its own origin', () => {
  const project = (updatedAt: number) =>
    aggregateThreadArtifacts({
      messages: [],
      prTasks: [],
      fileLedger: [{ ref: 'notes.txt', label: 'notes.txt', updatedAt, updatedBy: 'opus5' }],
    })[0];
  assert.equal(project(1)?.fileLedgerRef, 'notes.txt');
  assert.equal(project(2)?.fileLedgerRef, 'notes.txt');
  const [message] = aggregateThreadArtifacts({
    fileLedger: [],
    prTasks: [],
    messages: [
      {
        id: 'm1',
        catId: 'opus5',
        timestamp: 3,
        extra: { rich: { blocks: [{ kind: 'diff', v: 1, id: 'diff1', filePath: 'notes.txt', diff: '@@' }] } },
      },
    ],
  });
  assert.equal(message?.fileLedgerRef, undefined);
});
