import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const moduleBudgets = [
  {
    path: '../src/domains/cats/services/stores/ports/TaskStore.ts',
    maxLines: 350,
    reason: 'extract focused task-store responsibilities',
  },
  {
    path: '../src/domains/cats/services/stores/ports/TaskManagedWorkRegistrationStore.ts',
    maxLines: 350,
    reason: 'keep the in-memory managed-work aggregate focused',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskStore.ts',
    maxLines: 659,
    reason: 'do not grow the pre-existing oversized Redis task store; extract new responsibilities',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskManagedWorkRegistrationStore.ts',
    maxLines: 350,
    reason: 'keep the Redis managed-work aggregate focused',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskCodec.ts',
    maxLines: 350,
    reason: 'keep task serialization focused',
  },
];

for (const { path, maxLines, reason } of moduleBudgets) {
  test(`${path} stays within its ratcheted module budget`, () => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const lineCount = source.split('\n').length - Number(source.endsWith('\n'));
    assert.ok(lineCount <= maxLines, `${path} has ${lineCount} lines, max ${maxLines}; ${reason}`);
  });
}
