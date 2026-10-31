import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { Redis } from 'ioredis';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { readCurationBatch } from '../../src/domains/memory/CurationMessageReader.js';
import { processThread, type SummaryCompactionDeps } from '../../src/domains/memory/SummaryCompactionTask.js';
import { createSummaryCompactionTaskSpec } from '../../src/domains/memory/SummaryCompactionTaskSpec.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { SUMMARY_CONFIG } from '../../src/domains/memory/summary-config.js';
import { reconcileSummaryPendingInput } from '../../src/domains/memory/summary-pending-input.js';
import { ownedRedisFixture } from '../helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-source-accounting');

for (const transition of ['cancel', 'zero_exposure_recall', 'delivery'] as const) {
  test(
    `Redis canonical accounting: real ${transition} invalidates hints and exits scheduler correctly`,
    {},
    async () => {
      const redis = owned.client(`f321-accounting-${randomUUID()}:`);
      const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
      const db = new Database(':memory:');
      applyMigrations(db);
      db.prepare("INSERT INTO summary_state(thread_id) VALUES ('home')").run();
      db.prepare(
        "INSERT INTO evidence_docs(anchor,kind,status,title,summary,updated_at) VALUES ('thread-home','thread','active','home',NULL,'now')",
      ).run();
      const changes: string[] = [];
      const invalidate = (message: { id: string }) => {
        changes.push(message.id);
        db.prepare(
          "UPDATE summary_state SET pending_input_revision=pending_input_revision+1,pending_message_count=pending_message_count+1,pending_signal_flags=1 WHERE thread_id='home'",
        ).run();
      };
      messages.onAppend = invalidate;
      messages.onTimelineChanged = invalidate;
      const deps: SummaryCompactionDeps = {
        db,
        enabled: () => true,
        getThreadLastActivity: async () => null,
        getMessagesAfterWatermark: (thread, after, limit) =>
          readCurationBatch(messages, 'owner', thread, after, limit, 0),
        generateAbstractive: async (input) => ({
          segments: [
            {
              summary: 'idea',
              topicKey: 'idea',
              topicLabel: 'idea',
              boundaryReason: 'batch',
              boundaryConfidence: 'high',
              fromMessageId: input.messages[0].id,
              toMessageId: input.messages.at(-1)!.id,
              messageCount: input.messages.length,
            },
          ],
        }),
        logger: { info() {}, error() {} },
      };
      deps.curation = {
        timezone: 'UTC',
        reconcilePendingInput: (thread, water, signal) => reconcileSummaryPendingInput(deps, thread, water, signal),
      };
      const spec = createSummaryCompactionTaskSpec(deps);
      const gate = () => spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
      const state = () =>
        db.prepare("SELECT * FROM summary_state WHERE thread_id='home'").get() as Parameters<typeof processThread>[0];
      try {
        const queued = await messages.append({
          threadId: 'home',
          userId: 'owner',
          from: { kind: 'user', userId: 'owner' },
          content: 'queued',
          mentions: [],
          timestamp: 200,
          deliveryStatus: 'queued',
        });
        assert.equal((await gate()).run, false);
        assert.equal(state().pending_message_count, 0);
        if (transition === 'cancel') {
          assert.equal((await messages.markCanceled(queued.id))?.deliveryTransitioned, true);
          assert.equal((await messages.markCanceled(queued.id))?.deliveryTransitioned, false);
        } else if (transition === 'zero_exposure_recall') {
          const result = await messages.recallMessageToComposerDraft(queued.id, {
            ownerUserId: 'owner',
            threadId: 'home',
            recalledAt: 3000,
            expectedDraftRevision: 0,
            merge: 'replace',
          });
          assert.equal(result.kind, 'recalled');
          if (result.kind === 'recalled') assert.equal(result.verdict, 'zero_exposure');
        } else if (transition === 'delivery') {
          assert.equal((await messages.markDelivered(queued.id, 300))?.deliveryTransitioned, true);
          assert.equal((await messages.markDelivered(queued.id, 300))?.deliveryTransitioned, false);
        }
        assert.equal(
          changes.length,
          transition === 'zero_exposure_recall' ? 1 : 2,
          'invisible recall creates no visible timeline event; delivery and cancellation emit their canonical transition once',
        );
        const admitted = await gate();
        if (transition === 'cancel' || transition === 'zero_exposure_recall') {
          assert.equal(admitted.run, false);
          assert.equal(state().pending_message_count, 0);
          assert.equal(state().carry_over, 0);
          await messages.append({
            threadId: 'home',
            userId: 'owner',
            from: { kind: 'user', userId: 'owner' },
            content: 'later owner',
            mentions: [],
            timestamp: 100,
          });
        } else
          assert.equal(admitted.run, true, 'publication after zero hints still schedules the newly visible source');
        assert.equal(await processThread(state(), deps, SUMMARY_CONFIG), true);
        assert.equal(state().pending_message_count, 0);
        assert.equal((await gate()).run, false);
      } finally {
        redis.disconnect();
        db.close();
      }
    },
  );
}
