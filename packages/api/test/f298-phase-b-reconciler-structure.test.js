import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const ledgerDir = path.resolve(testDir, '../src/domains/cats/services/agents/invocation/queue-ledger');

async function lineCount(file) {
  return (await readFile(file, 'utf8')).split('\n').length;
}

describe('ADR-043 durable Queue ledger structure', () => {
  it('keeps every persistence implementation module within the 350-line hard limit', async () => {
    const files = [
      'QueueLedger.ts',
      'InMemoryQueueLedgerStore.ts',
      'RedisQueueLedgerStore.ts',
      'queue-ledger-redis-scripts.ts',
    ];
    for (const file of files) {
      const lines = await lineCount(path.join(ledgerDir, file));
      assert.ok(lines <= 350, `${file} has ${lines} lines; expected <= 350`);
    }
  });
});
