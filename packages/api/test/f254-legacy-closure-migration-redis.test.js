import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const { createRedisClient } = await import('@cat-cafe/shared/utils');
const { RedisFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/RedisFreshnessClosureStore.js'
);
const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
const { runLegacyClosureMigration } = await import('../dist/scripts/migrate-f254-legacy-closures.js');
const { buildLegacyClosureMigrationBundle } = await import(
  '../dist/scripts/f254-withheld-message-recovery/legacy-closure-bundle.js'
);
const { sha256Text, validateRecoveryManifest } = await import(
  '../dist/scripts/f254-withheld-message-recovery/manifest.js'
);

describe('F254 legacy closure migration against isolated Redis', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  const keyPrefix = `cat-cafe:test-f254-legacy-${process.pid}:`;
  let redis;
  let directory;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F254 legacy closure migration');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix });
    await redis.ping();
    await cleanupClientKeyspace(redis);
    directory = await mkdtemp(join(tmpdir(), 'f254-legacy-migration-'));
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('dry-runs without writes, then applies twice with one exact message and one terminal closure', async () => {
    const closureStore = new RedisFreshnessClosureStore(redis);
    const messageStore = new RedisMessageStore(redis);
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-legacy-redis-e2e',
      userId: 'user-legacy-redis',
      threadId: 'thread_legacy_redis',
      catId: 'codex-sol',
      invocationId: 'invocation-legacy-base',
      draftContent: 'withheld legacy final',
      requiredMessageIds: ['message-frontier'],
      requiredFrontierMessageId: 'message-frontier',
      observedRawFrontierMessageId: 'message-frontier',
      replayUnsafeToolNames: ['Edit'],
      now: 100,
    });
    const content = 'recovered exact final from sealed transcript';
    const invocationId = 'invocation-legacy-redis-final';
    const recoveryManifest = validateRecoveryManifest({
      version: 1,
      incident: 'F254',
      generatedAt: '2026-07-13T08:31:00.000Z',
      cvoDecisionRef: '0001783931356596-000046-b727785c',
      entries: [
        {
          invocationId,
          threadId: closure.threadId,
          userId: closure.userId,
          catId: closure.catId,
          timestamp: 150,
          content,
          contentSha256: sha256Text(content),
          sourceProof: {
            transcriptPath: 'data/transcripts/legacy/events.jsonl',
            sessionId: 'session-legacy-redis',
            firstEventNo: 1,
            lastEventNo: 3,
            terminalEventNo: 3,
            terminalKind: 'f254_withheld_decision',
            withheldDecision: {
              withheldAtUtc: '2026-07-13T03:11:43.743Z',
              closureId: closure.id,
              decisionKind: 'blocked_known_closure',
            },
          },
        },
      ],
      censusSha256: 'a'.repeat(64),
      censusTotal: 1,
    });
    const bundle = buildLegacyClosureMigrationBundle({
      generatedAt: recoveryManifest.generatedAt,
      legacyBeforeExclusive: '2026-07-13T04:47:19.000Z',
      cvoDecisionRef: recoveryManifest.cvoDecisionRef,
      closures: [closure],
      attachments: [
        {
          closureId: closure.id,
          invocationId,
          source: 'runtime_log',
          evidenceRefs: ['api-log:legacy#L1'],
          withheldDecision: recoveryManifest.entries[0].sourceProof.withheldDecision,
        },
      ],
      recoveryManifest,
    });
    const bundlePath = join(directory, 'bundle.json');
    const firstJournalPath = join(directory, 'first-journal.json');
    const secondJournalPath = join(directory, 'second-journal.json');
    const failedJournalPath = join(directory, 'failed-journal.json');
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);

    assert.equal(
      await runLegacyClosureMigration([
        '--bundle',
        bundlePath,
        '--dry-run',
        '--redis-url',
        REDIS_URL,
        '--key-prefix',
        keyPrefix,
      ]),
      0,
    );
    assert.equal((await messageStore.scanAll()).length, 0);
    assert.equal((await closureStore.get(closure.id)).status, 'blocked');

    assert.equal(
      await runLegacyClosureMigration([
        '--bundle',
        bundlePath,
        '--apply',
        '--journal',
        firstJournalPath,
        '--redis-url',
        REDIS_URL,
        '--key-prefix',
        keyPrefix,
      ]),
      0,
    );
    const messages = await messageStore.scanAll();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, content);
    assert.equal(messages[0].extra.recovery.invocationId, invocationId);
    const migrated = await closureStore.get(closure.id);
    assert.equal(migrated.status, 'disposed');
    assert.equal(migrated.disposition.kind, 'legacy_migrated');
    assert.deepEqual(await closureStore.listAllActive(), []);

    assert.equal(
      await runLegacyClosureMigration([
        '--bundle',
        bundlePath,
        '--apply',
        '--journal',
        secondJournalPath,
        '--redis-url',
        REDIS_URL,
        '--key-prefix',
        keyPrefix,
      ]),
      0,
    );
    assert.equal((await messageStore.scanAll()).length, 1);
    assert.equal((await closureStore.get(closure.id)).revision, migrated.revision);
    const firstJournal = JSON.parse(await readFile(firstJournalPath, 'utf8'));
    const secondJournal = JSON.parse(await readFile(secondJournalPath, 'utf8'));
    assert.equal(firstJournal.status, 'completed');
    assert.equal(secondJournal.status, 'completed');
    assert.deepEqual(firstJournal.recoveredMessageIds, [messages[0].id]);
    assert.deepEqual(secondJournal.recoveredMessageIds, []);
    assert.deepEqual(
      secondJournal.closures.map((item) => item.closureId),
      [closure.id],
    );
    await assert.rejects(
      runLegacyClosureMigration([
        '--bundle',
        bundlePath,
        '--apply',
        '--journal',
        firstJournalPath,
        '--redis-url',
        REDIS_URL,
        '--key-prefix',
        keyPrefix,
      ]),
      /journal.*already exists/i,
      'a rerun must not overwrite the first operator audit record',
    );

    await assert.rejects(
      runLegacyClosureMigration([
        '--bundle',
        bundlePath,
        '--apply',
        '--journal',
        failedJournalPath,
        '--actor-id',
        '   ',
        '--redis-url',
        REDIS_URL,
        '--key-prefix',
        keyPrefix,
      ]),
      /actorId/i,
    );
    const failedJournal = JSON.parse(await readFile(failedJournalPath, 'utf8'));
    assert.equal(failedJournal.status, 'started');
    assert.equal(failedJournal.bundleSha256, bundle.bundleSha256);
    assert.deepEqual(failedJournal.plannedClosureIds, [closure.id]);
    assert.equal((await messageStore.scanAll()).length, 1);
    assert.equal((await closureStore.get(closure.id)).revision, migrated.revision);
  });
});
