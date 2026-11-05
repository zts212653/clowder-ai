import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const moduleBudgets = [
  // TaskStore's generic list/page methods belong to its existing Map facade.
  // The five-line overrun does not add a responsibility; paging behavior and
  // receiver/cursor/cost bounds are checked by the Works/store suites.
  // RedisTaskStore is likewise an existing orchestration facade: method count
  // alone is not a responsibility boundary. Its collection query now delegates
  // to RedisTaskCollectionReader, whose focused budget remains below.
  {
    path: '../src/domains/cats/services/stores/ports/TaskEntrustedAdmission.ts',
    maxLines: 350,
    reason: 'keep entrusted Task admission and conflict policy separate from generic Task storage',
  },
  {
    path: '../src/domains/cats/services/stores/ports/TaskItemFactory.ts',
    maxLines: 350,
    reason: 'keep Task construction separate from storage mutation',
  },
  {
    path: '../src/domains/cats/services/stores/ports/TaskManagedWorkRegistrationStore.ts',
    maxLines: 350,
    reason: 'keep the in-memory managed-work aggregate focused',
  },
  {
    path: '../src/domains/cats/services/stores/ports/TaskWaitMutationStore.ts',
    maxLines: 350,
    reason: 'keep in-memory wait CAS and receipt mutation separate from generic Task storage',
  },
  {
    path: '../src/domains/cats/services/stores/ports/TaskEntrustedWorkMutationStore.ts',
    maxLines: 350,
    reason: 'keep entrusted-work owner mutations separate from generic Task storage',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskManagedWorkRegistrationStore.ts',
    maxLines: 350,
    reason: 'keep the Redis managed-work aggregate focused',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskEntrustedWorkMutationStore.ts',
    maxLines: 350,
    reason: 'keep Redis entrusted-work CAS transitions focused',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskCodec.ts',
    maxLines: 350,
    reason: 'keep task serialization focused',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskCollectionReader.ts',
    maxLines: 350,
    reason: 'keep Redis collection reads and stale-index cleanup focused',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisTaskSubjectTransactions.ts',
    maxLines: 350,
    reason: 'keep atomic Task subject ownership transitions focused',
  },
  {
    path: '../src/domains/cats/services/stores/redis/RedisWatchSession.ts',
    maxLines: 350,
    reason: 'keep WATCH lifecycle isolation focused',
  },
];

for (const { path, maxLines, reason } of moduleBudgets) {
  test(`${path} stays within its ratcheted module budget`, () => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const lineCount = source.split('\n').length - Number(source.endsWith('\n'));
    assert.ok(lineCount <= maxLines, `${path} has ${lineCount} lines, max ${maxLines}; ${reason}`);
  });
}
