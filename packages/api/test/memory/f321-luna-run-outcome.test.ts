import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { saveCurationPreference } from '../../src/config/user-preferences-curation.js';
import { AgentRegistry } from '../../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { parseCursor } from '../../src/domains/cats/services/stores/cursor.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentService } from '../../src/domains/cats/services/types.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';
import type { createSummaryCompactionTaskSpec } from '../../src/domains/memory/SummaryCompactionTaskSpec.js';
import { registerLunaCuration } from '../../src/luna-curation-setup.js';

for (const outcome of [
  'recall during generation',
  'abort after generation',
  'commit throws',
  'model fails',
  'saved',
  'record fails',
  'embedding fails',
]) {
  test(`run record reflects final persistence and actual usage: ${outcome}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'f321-luna-run-outcome-'));
    const evidence = new SqliteEvidenceStore(':memory:');
    await evidence.initialize();
    const db = evidence.getDb();
    const threads = new ThreadStore();
    const thread = threads.create('owner', 'Current work');
    const messages = new MessageStore();
    const started = Date.now() - 30 * 60_000;
    saveCurationPreference(root, db, { enabled: true }, started);
    const fresh = messages.append({
      threadId: thread.id,
      userId: 'owner',
      catId: null,
      mentions: [],
      content: 'New decision',
      timestamp: started + 1000,
    });
    db.prepare(
      'INSERT INTO summary_state (thread_id,pending_message_count,pending_token_count,pending_signal_flags) VALUES (?,1,100,1)',
    ).run(thread.id);
    const controller = new AbortController();
    const service: AgentService = {
      async *invoke() {
        if (outcome === 'recall during generation')
          db.prepare(
            "INSERT INTO message_recall_index_suppressions (doc_anchor,passage_id,lease_id,state,prepared_at,committed_at) VALUES (?,?,'recall','committed','now','now')",
          ).run(`thread-${thread.id}`, fresh.id);
        if (outcome === 'abort after generation') controller.abort();
        if (outcome === 'commit throws')
          db.exec(
            "CREATE TRIGGER reject_summary BEFORE INSERT ON summary_segments BEGIN SELECT RAISE(ABORT, 'commit unavailable'); END",
          );
        yield {
          type: 'text',
          catId: 'codex6-luna',
          timestamp: 0,
          content: outcome === 'model fails' ? 'Unparseable' : `判断变化：保留新判断。 [sources: ${fresh.id}]`,
        };
        yield {
          type: 'done',
          catId: 'codex6-luna',
          timestamp: 1,
          metadata: { provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 10, outputTokens: 5 } },
        };
      },
    };
    const registry = new AgentRegistry();
    registry.register('codex6-luna', service);
    const app = Fastify();
    const attemptedRecords: Array<{ content: string; watermark: string | null; segmentCount: number }> = [];
    let spec: ReturnType<typeof createSummaryCompactionTaskSpec> | undefined;
    try {
      await registerLunaCuration({
        app,
        db,
        projectRoot: root,
        ownerUserId: 'owner',
        householdTimeZone: 'UTC',
        agentRegistry: registry,
        resolveProvider: (catId) => ({ catId, model: 'gpt-6-luna', service }),
        taskRunner: {
          register: (registered) => {
            if (registered.id === 'summary-compact') spec = registered as NonNullable<typeof spec>;
          },
        },
        threadStore: threads,
        messageStore: messages,
        reEmbed: async () => {
          if (outcome === 'embedding fails') throw new Error('embedding unavailable');
        },
        deliver: async (input) => {
          const state = db
            .prepare('SELECT last_summarized_message_id AS watermark FROM summary_state WHERE thread_id=?')
            .get(thread.id) as { watermark: string | null };
          const { segmentCount } = db.prepare('SELECT count(*) AS segmentCount FROM summary_segments').get() as {
            segmentCount: number;
          };
          attemptedRecords.push({ content: input.content, watermark: state.watermark, segmentCount });
          if (outcome === 'record fails') throw new Error('record unavailable');
          return messages.append({ ...input, catId: null, timestamp: Date.now(), mentions: [] }).id;
        },
      });
      assert.ok(spec);
      const admitted = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
      assert.equal(admitted.run, true);
      if (!admitted.run) throw new Error('Not admitted');
      const workItem = admitted.workItems?.[0];
      assert.ok(workItem);
      const execution = spec.run.execute(workItem.signal, `thread-${thread.id}`, {
        signal: controller.signal,
      } as Parameters<NonNullable<typeof spec>['run']['execute']>[2]);
      if (outcome === 'abort after generation' || outcome === 'commit throws') await assert.rejects(execution);
      else await execution;
      const saved = ['saved', 'record fails', 'embedding fails'].includes(outcome);
      assert.equal(attemptedRecords.length, 1);
      assert.match(attemptedRecords[0].content, /1 个对话，1 条消息。输入 10，输出 5/);
      assert.equal(attemptedRecords[0].content.includes('本次未提交'), !saved);
      assert.equal(parseCursor(attemptedRecords[0].watermark)?.id ?? null, saved ? fresh.id : null);
      assert.equal(attemptedRecords[0].segmentCount, saved ? 1 : 0);
      const system = threads.list('owner').find((row) => row.systemKind === 'memory_ops');
      assert.ok(system);
      assert.equal(messages.getByThread(system.id).length, outcome === 'record fails' ? 0 : 1);
    } finally {
      await app.close();
      await evidence.close();
      rmSync(root, { recursive: true });
    }
  });
}
