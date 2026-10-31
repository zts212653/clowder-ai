import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { parseCursor } from '../../src/domains/cats/services/stores/cursor.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { readCurationBatch } from '../../src/domains/memory/CurationMessageReader.js';
import { processThread, type SummaryCompactionDeps } from '../../src/domains/memory/SummaryCompactionTask.js';
import { createSummaryCompactionTaskSpec } from '../../src/domains/memory/SummaryCompactionTaskSpec.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { SUMMARY_CONFIG } from '../../src/domains/memory/summary-config.js';
import { reconcileSummaryPendingInput } from '../../src/domains/memory/summary-pending-input.js';

for (const scenario of ['read_failure', 'write_failure', 'filtered_prefix', 'exact_full_page'] as const) {
  test(`bounded canonical input keeps durable continuation after ${scenario}`, async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new MessageStore();
    const count = scenario === 'exact_full_page' ? 200 : 201;
    const rows = Array.from({ length: count }, (_, i) =>
      store.append({
        threadId: 'source',
        userId: scenario === 'filtered_prefix' && i < 200 ? 'scheduler' : 'owner',
        catId: null,
        content: `idea ${i}`,
        timestamp: i,
      }),
    );
    db.prepare(`INSERT INTO evidence_docs(anchor,kind,status,title,summary,updated_at)
      VALUES ('thread-source','thread','active','Source',NULL,'now')`).run();
    db.prepare(`INSERT INTO summary_state(thread_id,pending_message_count,pending_token_count,pending_signal_flags)
      VALUES ('source',?,1000,1)`).run(count);
    let failRefresh = true;
    let failNextWrite = false;
    const seen: string[] = [];
    const deps: SummaryCompactionDeps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => null,
      runExclusive: async (fn) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('temporary writer failure');
        }
        return fn();
      },
      getMessagesAfterWatermark: async (thread, after, limit) => {
        const batch = await readCurationBatch(store, 'owner', thread, after, limit, 0);
        if (after && failRefresh) {
          failRefresh = false;
          if (scenario === 'write_failure') failNextWrite = true;
          else throw new Error('temporary post-commit read failure');
        }
        return batch;
      },
      generateAbstractive: async (input) => {
        seen.push(...input.messages.map((m) => m.id));
        return {
          segments: [
            {
              summary: 'Current overview',
              topicKey: 'overview',
              topicLabel: 'Source',
              boundaryReason: 'batch',
              boundaryConfidence: 'high',
              fromMessageId: input.messages[0].id,
              toMessageId: input.messages.at(-1)!.id,
              messageCount: input.messages.length,
            },
          ],
        };
      },
      logger: { info() {}, error() {} },
    };
    deps.curation = {
      timezone: 'UTC',
      reconcilePendingInput: (thread, watermark, signal) =>
        reconcileSummaryPendingInput(deps, thread, watermark, signal),
    };
    const state = () =>
      db.prepare("SELECT * FROM summary_state WHERE thread_id='source'").get() as Parameters<typeof processThread>[0];
    try {
      assert.equal(await processThread(state(), deps, SUMMARY_CONFIG), true);
      assert.equal(parseCursor(state().last_summarized_message_id)?.id, rows[199].id);
      assert.ok(state().pending_message_count > 0, 'unproven exhaustion must survive refresh failure');
      assert.equal(state().carry_over, 1);
      assert.equal(
        (await readCurationBatch(store, 'owner', 'source', state().last_summarized_message_id, 200, 0)).scannedMessages
          .length,
        count - 200,
      );
      // A fresh scheduler consumes only persisted state; no append or startup dirty repair.
      const resumed = createSummaryCompactionTaskSpec({ ...deps, curation: { ...deps.curation } });
      const admitted = await resumed.admission.gate({ taskId: resumed.id, lastRunAt: null, tickCount: 2 });
      if (scenario === 'exact_full_page')
        assert.equal(admitted.run, false, 'a successful empty read proves exhaustion');
      else {
        assert.equal(admitted.run, true, 'row 201 must keep its scheduling entry');
        assert.equal(await processThread(state(), deps, SUMMARY_CONFIG), true);
        assert.equal(parseCursor(state().last_summarized_message_id)?.id, rows[200].id);
      }
      assert.equal(state().pending_message_count, 0);
      assert.equal(state().pending_token_count, 0);
      assert.equal(state().pending_signal_flags, 0);
      assert.equal(state().carry_over, 0);
      assert.deepEqual(
        seen,
        rows.filter((m) => m.userId === 'owner').map((m) => m.id),
      );
      assert.equal((await resumed.admission.gate({ taskId: resumed.id, lastRunAt: null, tickCount: 3 })).run, false);
    } finally {
      db.close();
    }
  });
}
